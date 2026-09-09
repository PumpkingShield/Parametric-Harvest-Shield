use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::errors::PumpkingError;
use crate::state::{
    CellState, Policy, PolicyState, Pool, CELL_SEED, MAX_COVERAGE_DAYS, POLICY_SEED, POOL_SEED,
};

/// Selling cover — the point where the pool takes on risk it cannot refuse
/// later. Everything the underwriting depends on is checked here, because
/// `settle_policy` (`FR-030`) has no discretion at all: once this instruction
/// returns `Ok`, the payout is owed the moment the index says so.

/// The terms of one policy, as the buyer states them.
///
/// Gathered into one type for the same reason as `PoolParams`: the rules that
/// make a set of terms sellable live in one place and can be checked without a
/// runtime. `owner` is not among them — it is the signer, and `FR-066` gives
/// the policy no field to point the money somewhere else.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PolicyParams {
    /// Distinguishes several policies of one buyer; part of the seeds.
    pub nonce: u64,
    /// `FR-006`: cover is sold on a cell, never on a field.
    pub cell_id: u64,
    /// `FR-046`: consecutive dry days that trigger the event.
    pub spell_days_threshold: u8,
    pub payout: u64,
    /// `FR-021` is not enforced here yet — see `issue_policy`.
    pub premium: u64,
    /// Day indices, both ends inclusive — `FR-024`.
    pub window_start_day: u32,
    pub window_end_day: u32,
}

impl PolicyParams {
    /// Length of the window in days, both ends inclusive. Saturating rather
    /// than wrapping: an unordered window is refused a line later, and this
    /// must not panic on the way there.
    pub fn window_days(&self) -> u32 {
        self.window_end_day.saturating_sub(self.window_start_day) + 1
    }
}

/// Whether the pool may take this risk — `FR-019`, `FR-020`, `FR-022`,
/// `FR-023`, `FR-024`.
///
/// A pure function of the terms and of the two accounts they are measured
/// against, so every rule below is a test rather than a deployment.
///
/// The order matters in one place: liquidity and exposure are measured
/// against the capital the pool held **before** this premium arrives. The
/// premium does become capital moments later, but a buyer whose own payment
/// unlocks the headroom for their own policy is a loop, and the loop pays out
/// against money that was never anybody's cushion.
pub fn check_underwriting(
    params: &PolicyParams,
    pool: &Pool,
    cell_sensor_count: u8,
    cell_reserved: u64,
    today: u32,
) -> Result<()> {
    require!(params.payout > 0, PumpkingError::PayoutNotSet);
    // A policy costing nothing is not cover, it is a free option on the pool.
    require!(params.premium > 0, PumpkingError::PremiumNotSet);

    // FR-024: the window is ordered and bounded. `MAX_COVERAGE_DAYS` sits
    // inside the cell's day log with room to spare, so settlement can still
    // read every day the policy covers rather than the ones left in the ring.
    require!(
        params.window_end_day >= params.window_start_day,
        PumpkingError::WindowNotOrdered
    );
    let window_days = params.window_days();
    require!(
        window_days <= MAX_COVERAGE_DAYS,
        PumpkingError::WindowTooLong
    );

    // A threshold longer than the window can never be reached, so the policy
    // would collect a premium against an event it is arithmetically unable to
    // pay. Refusing is cheaper than explaining.
    require!(
        params.spell_days_threshold > 0
            && u32::from(params.spell_days_threshold) <= window_days,
        PumpkingError::ThresholdOutOfWindow
    );

    // FR-023 and FR-024 together: cover starts no earlier than the waiting
    // period, which also puts the whole window in the future. A drought that
    // has already begun is not insurable — by then the buyer knows and the
    // pool does not.
    let earliest = today
        .checked_add(u32::from(pool.waiting_period_days))
        .ok_or(PumpkingError::MathOverflow)?;
    require!(
        params.window_start_day >= earliest,
        PumpkingError::WaitingPeriodNotElapsed
    );

    // FR-022: a cell the network cannot reach a value on would never settle,
    // and selling there is selling a policy guaranteed not to work.
    require!(
        cell_sensor_count >= pool.min_sensors_per_cell,
        PumpkingError::CellNotCovered
    );

    // FR-019: sold against what is left, not against what is held.
    require!(
        pool.free_liquidity() >= params.payout,
        PumpkingError::InsufficientLiquidity
    );

    // FR-020: drought is correlated. One event triggers every policy in the
    // cell at once, so the cell — not the pool — is the unit of concentration.
    let cell_after = cell_reserved
        .checked_add(params.payout)
        .ok_or(PumpkingError::MathOverflow)?;
    require!(
        cell_after <= pool.cell_exposure_limit(),
        PumpkingError::CellExposureExceeded
    );

    Ok(())
}

#[derive(Accounts)]
#[instruction(params: PolicyParams)]
pub struct IssuePolicy<'info> {
    /// `FR-025` and `FR-067`: buyer, owner and payer are one account. The
    /// policy holds no payer field, so a cooperative or a donor paying for
    /// somebody else changes this instruction later and nothing downstream —
    /// not settlement, not consensus, not the index.
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    /// Must already exist: cover is sold on a cell the network is publishing
    /// for, and `FR-022` is that sentence enforced.
    #[account(
        mut,
        seeds = [CELL_SEED, params.cell_id.to_le_bytes().as_ref()],
        bump = cell.bump,
    )]
    pub cell: Account<'info, CellState>,

    #[account(
        init,
        payer = owner,
        space = 8 + Policy::INIT_SPACE,
        seeds = [POLICY_SEED, owner.key().as_ref(), params.nonce.to_le_bytes().as_ref()],
        bump,
    )]
    pub policy: Account<'info, Policy>,

    #[account(address = pool.asset_mint)]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, address = pool.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// The buyer's own token account — `FR-025`.
    #[account(
        mut,
        token::mint = asset_mint,
        token::authority = owner,
    )]
    pub owner_tokens: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Issues a policy — `FR-018`.
///
/// **The premium is still the buyer's own number.** `FR-021` makes it a
/// deterministic function of the cell's history and the payout, and that
/// function is `T017`; until it lands this instruction charges what it is
/// told. The exposure is bounded rather than open — the payout is reserved
/// out of capital that already existed, and `FR-019` and `FR-020` are
/// enforced above — so an underpriced policy costs the pool margin, not
/// solvency. `T017` replaces the field with a computed value; it must not
/// survive as an argument.
pub fn issue_policy(ctx: Context<IssuePolicy>, params: PolicyParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let today = ctx
        .accounts
        .pool
        .day_index(now)
        .ok_or(PumpkingError::DayIndexUnavailable)?;

    check_underwriting(
        &params,
        &ctx.accounts.pool,
        ctx.accounts.cell.sensor_count,
        ctx.accounts.cell.reserved,
        today,
    )?;

    // Money first, accounting second: a failed transfer must not leave a
    // policy standing against a premium that never arrived.
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.owner_tokens.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        params.premium,
        ctx.accounts.asset_mint.decimals,
    )?;

    let pool = &mut ctx.accounts.pool;
    pool.reserved_total = pool
        .reserved_total
        .checked_add(params.payout)
        .ok_or(PumpkingError::MathOverflow)?;
    // `FR-034` splits the premium between capital and the cell's reward
    // reserve; until `T018` carves out the reward share, all of it is capital.
    // No shares are minted against it — the gain belongs to the holders who
    // were already carrying the risk.
    pool.capital_total = pool
        .capital_total
        .checked_add(params.premium)
        .ok_or(PumpkingError::MathOverflow)?;

    let cell = &mut ctx.accounts.cell;
    cell.reserved = cell
        .reserved
        .checked_add(params.payout)
        .ok_or(PumpkingError::MathOverflow)?;

    ctx.accounts.policy.set_inner(Policy {
        owner: ctx.accounts.owner.key(),
        nonce: params.nonce,
        cell_id: params.cell_id,
        spell_days_threshold: params.spell_days_threshold,
        payout: params.payout,
        premium: params.premium,
        window_start_day: params.window_start_day,
        window_end_day: params.window_end_day,
        state: PolicyState::Active,
        bump: ctx.bumps.policy,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::error::Error;

    fn code_of(err: Error) -> u32 {
        match err {
            Error::AnchorError(inner) => inner.error_code_number,
            other => panic!("expected an anchor error, got {other:?}"),
        }
    }

    /// A pool with room: a million of capital, nothing reserved, a tenth of it
    /// available to any one cell, three sensors needed, three days of waiting.
    fn pool() -> Pool {
        Pool {
            authority: Pubkey::new_unique(),
            aggregator: Pubkey::new_unique(),
            asset_mint: Pubkey::new_unique(),
            vault: Pubkey::new_unique(),
            stake_vault: Pubkey::new_unique(),
            capital_total: 1_000_000,
            reserved_total: 0,
            shares_total: 1_000_000,
            cell_exposure_bps: 1_000,
            premium_rewards_bps: 1_000,
            min_sensors_per_cell: 3,
            min_stake: 1_000,
            unstake_delay_days: 30,
            waiting_period_days: 3,
            dry_day_threshold_mm_x100: 100,
            seconds_per_day: 86_400,
            genesis_ts: 0,
            bump: 254,
        }
    }

    /// Terms that pass, bought on day 10: cover opens on day 13, the first day
    /// the waiting period allows.
    fn params() -> PolicyParams {
        PolicyParams {
            nonce: 0,
            cell_id: 0x871e701b3ffffff,
            spell_days_threshold: 14,
            payout: 50_000,
            premium: 2_500,
            window_start_day: 13,
            window_end_day: 42,
        }
    }

    const TODAY: u32 = 10;

    fn check(params: &PolicyParams) -> Result<()> {
        check_underwriting(params, &pool(), 3, 0, TODAY)
    }

    #[test]
    fn sellable_terms_pass() {
        assert!(check(&params()).is_ok());
    }

    #[test]
    fn cover_worth_nothing_is_not_cover() {
        let mut p = params();
        p.payout = 0;
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::PayoutNotSet)
        );
    }

    #[test]
    fn cover_costing_nothing_is_a_free_option() {
        let mut p = params();
        p.premium = 0;
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::PremiumNotSet)
        );
    }

    #[test]
    fn a_window_that_ends_before_it_starts_is_refused() {
        let mut p = params();
        p.window_start_day = 20;
        p.window_end_day = 19;
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::WindowNotOrdered)
        );
    }

    #[test]
    fn a_single_day_window_is_a_window() {
        let mut p = params();
        p.window_start_day = 13;
        p.window_end_day = 13;
        p.spell_days_threshold = 1;
        assert!(check(&p).is_ok());
    }

    #[test]
    fn a_window_longer_than_the_day_log_is_refused() {
        let mut p = params();
        p.window_start_day = 13;
        p.window_end_day = 13 + MAX_COVERAGE_DAYS - 1;
        assert!(check(&p).is_ok());

        p.window_end_day += 1;
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::WindowTooLong)
        );
    }

    #[test]
    fn a_threshold_the_window_cannot_reach_is_refused() {
        // Thirty days of cover cannot contain a thirty-one day spell, so the
        // premium would buy an event that is arithmetically impossible.
        let mut p = params();
        p.spell_days_threshold = 30;
        assert!(check(&p).is_ok());

        p.spell_days_threshold = 31;
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::ThresholdOutOfWindow)
        );

        p.spell_days_threshold = 0;
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::ThresholdOutOfWindow)
        );
    }

    #[test]
    fn cover_cannot_start_before_the_waiting_period_ends() {
        // FR-023. Day 13 is the first allowed; day 12 is one day too eager.
        let mut p = params();
        p.window_start_day = 12;
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::WaitingPeriodNotElapsed)
        );

        p.window_start_day = 13;
        assert!(check(&p).is_ok());
    }

    #[test]
    fn a_window_that_already_began_is_refused() {
        // FR-024, and the reason the waiting period exists: by the time a
        // drought is visible the buyer knows something the pool does not.
        let mut p = params();
        p.window_start_day = TODAY;
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::WaitingPeriodNotElapsed)
        );

        // A window that has already closed fails the same rule rather than a
        // second one: any window starting before `today + waiting` is refused,
        // and one that ended last week starts a long way before it.
        p.window_start_day = 0;
        p.window_end_day = 29;
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::WaitingPeriodNotElapsed)
        );
    }

    #[test]
    fn a_cell_the_network_cannot_read_sells_nothing() {
        // FR-022: three sensors are the minimum, two are not coverage.
        let p = params();
        assert_eq!(
            code_of(check_underwriting(&p, &pool(), 2, 0, TODAY).unwrap_err()),
            u32::from(PumpkingError::CellNotCovered)
        );
        assert!(check_underwriting(&p, &pool(), 3, 0, TODAY).is_ok());
    }

    #[test]
    fn a_payout_the_pool_cannot_cover_is_refused() {
        // FR-019 measures free liquidity, not capital: a pool holding a
        // million with 990_000 already committed can sell 10_000 and no more.
        let mut pool = pool();
        pool.reserved_total = 990_000;
        pool.cell_exposure_bps = 10_000;

        let mut p = params();
        p.payout = 10_000;
        assert!(check_underwriting(&p, &pool, 3, 0, TODAY).is_ok());

        p.payout = 10_001;
        assert_eq!(
            code_of(check_underwriting(&p, &pool, 3, 0, TODAY).unwrap_err()),
            u32::from(PumpkingError::InsufficientLiquidity)
        );
    }

    #[test]
    fn one_cell_cannot_hold_more_than_its_share_of_the_pool() {
        // FR-020: a tenth of a million is 100_000, and the cell already owes
        // 60_000, so 40_000 fits and 40_001 does not — even though the pool
        // as a whole has plenty left.
        let p = params();
        let pool = pool();
        let mut fits = p.clone();
        fits.payout = 40_000;
        assert!(check_underwriting(&fits, &pool, 3, 60_000, TODAY).is_ok());

        let mut over = p;
        over.payout = 40_001;
        assert_eq!(
            code_of(check_underwriting(&over, &pool, 3, 60_000, TODAY).unwrap_err()),
            u32::from(PumpkingError::CellExposureExceeded)
        );
    }

    #[test]
    fn the_exposure_limit_binds_before_liquidity_does() {
        // The two limits are independent, and the cell one is the tighter of
        // the two by design: an empty pool of a million can pay 500_000 and
        // still must not owe it all to one drought.
        let mut p = params();
        p.payout = 500_000;
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::CellExposureExceeded)
        );
    }

    #[test]
    fn a_cell_already_at_its_limit_sells_nothing_more() {
        let mut p = params();
        p.payout = 1;
        assert_eq!(
            code_of(check_underwriting(&p, &pool(), 3, 100_000, TODAY).unwrap_err()),
            u32::from(PumpkingError::CellExposureExceeded)
        );
    }

    #[test]
    fn reserved_capital_near_the_ceiling_does_not_wrap() {
        let mut p = params();
        p.payout = u64::MAX;
        assert_eq!(
            code_of(check_underwriting(&p, &pool(), 3, 1, TODAY).unwrap_err()),
            u32::from(PumpkingError::InsufficientLiquidity)
        );
    }

    #[test]
    fn a_scenario_clock_changes_the_length_of_a_day_and_nothing_else() {
        // FR-049: compressed time moves the same day indices through the same
        // rules. Underwriting never sees a timestamp, only a day.
        let mut pool = pool();
        pool.seconds_per_day = 2;
        assert_eq!(pool.day_index(20), Some(10));
        assert!(check_underwriting(&params(), &pool, 3, 0, 10).is_ok());
    }
}
