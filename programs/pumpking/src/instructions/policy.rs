use anchor_lang::prelude::*;
use anchor_spl::token_interface::spl_token_2022::state::AccountState;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::errors::PumpkingError;
use crate::index::spell_in_window;
use crate::premium::{dry_day_frequency_bps, premium_for, premium_rate_bps};
use crate::state::{
    CellState, Policy, PolicyState, Pool, BPS_DENOMINATOR, CELL_SEED, MAX_COVERAGE_DAYS,
    POLICY_SEED, POOL_SEED,
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
    /// The most the buyer will pay. `FR-021` sets the price, not this: the
    /// program charges what the formula says and refuses above this bound.
    /// Without it a quote and the transaction that follows it are two
    /// different prices whenever a day is recorded in between.
    pub max_premium: u64,
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
    cell_votes: u32,
    cell_reserved: u64,
    today: u32,
) -> Result<()> {
    require!(params.payout > 0, PumpkingError::PayoutNotSet);

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
    //
    // Coverage is counted from what the cell **published**, not from what is
    // registered on it. `CellState::sensor_count` is the registry, and the
    // instruction that fills it (`register_sensor`) does not exist yet — so
    // reading it here made `issue_policy` unreachable for the whole of M1 and
    // nothing said so: every test that touched underwriting built its own
    // `CellState` with the field already set. The day log cannot be faked that
    // way. It is also the stronger question of the two: a sensor that is
    // registered and silent is not coverage, and `FR-010` is about votes on an
    // interval rather than names on a list.
    require!(
        cell_votes >= u32::from(pool.min_sensors_per_cell),
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
    // Boxed, and that is a build requirement rather than a preference:
    // `CellState` carries `contributors: [u32; 128]` and `day_log: [u8; 128]`,
    // which is some 690 bytes sitting in `try_accounts`' stack frame. SBPF v0
    // — the only bytecode version the cluster executes — caps that frame at
    // 4 096 bytes, and without the box this context overruns it by 368. The
    // account layout, the discriminator and the IDL are unchanged; `Box`
    // dereferences on its own wherever the handler touches the cell.
    //
    // `//` and not `///`: a doc comment on a context field is copied into the
    // published IDL, and a note about this repository's build would become
    // documentation for everyone using the SDK.
    pub cell: Box<Account<'info, CellState>>,

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

/// The price of a policy, read out of the cell's own recorded history —
/// `FR-021`.
///
/// The buyer names a payout and a bound, never a price. Everything that
/// decides the number is public and on chain: the day log the frequency comes
/// from, and the two published pool parameters. Two buyers asking for the same
/// cover on the same cell in the same block are quoted the same figure, which
/// is the whole of "формула публічна й однакова для всіх".
pub fn price_of(pool: &Pool, day_log: &[u8], payout: u64, max_premium: u64) -> Result<u64> {
    let frequency = dry_day_frequency_bps(day_log).ok_or(PumpkingError::CellHistoryTooShort)?;
    let rate = premium_rate_bps(frequency, pool.risk_loading_bps, pool.min_rate_bps);
    let premium = premium_for(payout, rate).ok_or(error!(PumpkingError::MathOverflow))?;

    // The bound is the buyer's, and it is checked here rather than at the
    // caller so that the price and the promise about it are one decision with
    // one set of tests.
    require!(premium <= max_premium, PumpkingError::PremiumAboveLimit);
    Ok(premium)
}

/// How one premium divides between the cell's reward reserve and capital —
/// `FR-034`, `FR-061`. Returns `(to_rewards, to_capital)`.
///
/// The split happens **at issue**, once, and nothing later moves the line:
/// `FR-034` says closing a policy without an event redistributes nothing,
/// because capital was paid its part the day the risk was taken on, not the
/// day it turned out to be a good bet.
///
/// The reward share is computed and the remainder handed to capital, rather
/// than both sides computed and hoped to add up. Two divisions of the same
/// number can lose a unit between them; a subtraction cannot. The premium is
/// conserved exactly, and the dust of the division falls to capital — the same
/// direction every other rounding in this program takes.
///
/// Nothing here can overflow: the product is taken in `u128` and both parts
/// are bounded by the premium.
pub fn split_premium(premium: u64, rewards_bps: u16) -> (u64, u64) {
    // A share larger than the whole is not a split. `initialize_pool` refuses
    // one, and clamping here means the arithmetic below holds on its own terms
    // rather than on a check living in another file.
    let share = u64::from(rewards_bps).min(BPS_DENOMINATOR);
    let to_rewards = u128::from(premium) * u128::from(share) / u128::from(BPS_DENOMINATOR);
    // With `share <= BPS_DENOMINATOR` the quotient is at most `premium`, so
    // the conversion cannot narrow and the subtraction cannot go below zero.
    let to_rewards = u64::try_from(to_rewards).unwrap_or(premium);
    (to_rewards, premium - to_rewards)
}

/// Issues a policy — `FR-018`.
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
        ctx.accounts.cell.latest_votes(),
        ctx.accounts.cell.reserved,
        today,
    )?;

    // FR-021. The whole ring is read, not the live window: a slot the log does
    // not answer for holds no coverage, and no coverage counts on neither side
    // of the ratio.
    let premium = price_of(
        &ctx.accounts.pool,
        &ctx.accounts.cell.day_log,
        params.payout,
        params.max_premium,
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
        premium,
        ctx.accounts.asset_mint.decimals,
    )?;

    // FR-034: the premium divides here and only here.
    let (to_rewards, to_capital) = split_premium(premium, ctx.accounts.pool.premium_rewards_bps);

    let pool = &mut ctx.accounts.pool;
    pool.reserved_total = pool
        .reserved_total
        .checked_add(params.payout)
        .ok_or(PumpkingError::MathOverflow)?;
    // No shares are minted against the capital share — the gain belongs to the
    // holders who were already carrying the risk.
    //
    // `FR-061`: the reward share is deliberately **not** added here. Both
    // parts sit in the same vault, but only this number backs policies, so
    // what the sensors earned is neither sold as cover nor withdrawn as
    // capital. The vault holds `capital_total` plus every cell's reserve; the
    // two are told apart by the books, which is why the split is a
    // subtraction and not a second division.
    pool.capital_total = pool
        .capital_total
        .checked_add(to_capital)
        .ok_or(PumpkingError::MathOverflow)?;

    let cell = &mut ctx.accounts.cell;
    cell.reserved = cell
        .reserved
        .checked_add(params.payout)
        .ok_or(PumpkingError::MathOverflow)?;
    // FR-062: the reserve belongs to the cell whose policy paid for it, and
    // waits there for the interval that earns it.
    cell.rewards_reserve = cell
        .rewards_reserve
        .checked_add(to_rewards)
        .ok_or(PumpkingError::MathOverflow)?;

    ctx.accounts.policy.set_inner(Policy {
        owner: ctx.accounts.owner.key(),
        nonce: params.nonce,
        cell_id: params.cell_id,
        spell_days_threshold: params.spell_days_threshold,
        payout: params.payout,
        premium,
        window_start_day: params.window_start_day,
        window_end_day: params.window_end_day,
        state: PolicyState::Active,
        bump: ctx.bumps.policy,
    });

    Ok(())
}

/* -------------------------------------------------------------------------- */
/* settle_policy                                                              */
/* -------------------------------------------------------------------------- */

/// The event, recorded where anyone can read it — `FR-016`, `FR-037`.
///
/// `spell_days` is the index that crossed the threshold, and the window says
/// which days it was found in. Together with the `DayRecorded` events of those
/// days and the Merkle roots they carry, this is the whole trace: readings →
/// cell values → days → index → this transaction.
#[event]
pub struct PolicySettled {
    pub policy: Pubkey,
    pub owner: Pubkey,
    pub cell_id: u64,
    pub payout: u64,
    /// The run that triggered it, and the threshold it had to reach.
    pub spell_days: u32,
    pub spell_days_threshold: u8,
    pub window_start_day: u32,
    pub window_end_day: u32,
}

/// Whether the policy is owed its payout, and the run that says so —
/// `FR-026`, `FR-046`.
///
/// **This function asks no permission and reads no clock.** It is a function
/// of two accounts and nothing else: the policy's terms, fixed at issue, and
/// the cell's day log, written by the aggregator. There is no parameter a
/// caller could supply to change the answer, which is `FR-030` stated as a
/// signature rather than as a promise.
///
/// The window does not have to be over. A run that has reached the threshold
/// cannot be un-reached by the days after it, so waiting for the window to
/// close would delay a payout that is already owed — and `SC-001` measures
/// exactly that delay.
pub fn check_settlement(policy: &Policy, cell: &CellState) -> Result<u32> {
    // `FR-027`: once. A policy that has already paid, closed or been left
    // unclaimed is not a policy the index can trigger again.
    require!(
        policy.state == PolicyState::Active,
        PumpkingError::PolicyNotActive
    );
    require!(
        policy.cell_id == cell.cell_id,
        PumpkingError::PolicyCellMismatch
    );

    let reading = spell_in_window(cell, policy.window_start_day, policy.window_end_day);
    require!(
        reading.longest >= u32::from(policy.spell_days_threshold),
        PumpkingError::EventHasNotHappened
    );
    Ok(reading.longest)
}

/// The books after a payout has left the vault, shared by the two ways one
/// can — settlement and a deferred claim.
///
/// Both totals fall by the same amount, so free liquidity does not move: this
/// money was committed the day the policy was sold and was never available to
/// underwrite anything else. The reward reserves sitting in the same vault are
/// untouched, because they were never in `capital_total` for a payout to
/// reach.
fn release_payout(
    pool: &mut Pool,
    cell: &mut CellState,
    policy: &mut Policy,
    payout: u64,
) -> Result<()> {
    pool.capital_total = pool
        .capital_total
        .checked_sub(payout)
        .ok_or(PumpkingError::MathOverflow)?;
    pool.reserved_total = pool
        .reserved_total
        .checked_sub(payout)
        .ok_or(PumpkingError::MathOverflow)?;
    cell.reserved = cell
        .reserved
        .checked_sub(payout)
        .ok_or(PumpkingError::MathOverflow)?;
    policy.state = PolicyState::PaidOut;
    Ok(())
}

#[derive(Accounts)]
pub struct SettlePolicy<'info> {
    /// `FR-030`: anybody. The caller pays the transaction fee and gets
    /// nothing, and is checked against nothing — a payout that needed a
    /// particular key to arrive would be a payout that key could withhold.
    /// In practice the worker calls it; the owner, a neighbour or a bot
    /// calling it instead changes nothing about the outcome.
    pub caller: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [CELL_SEED, policy.cell_id.to_le_bytes().as_ref()],
        bump = cell.bump,
    )]
    // Boxed for the same reason as in `IssuePolicy`: without it this frame is
    // 248 bytes past what SBPF v0 allows.
    pub cell: Box<Account<'info, CellState>>,

    #[account(
        mut,
        seeds = [POLICY_SEED, policy.owner.as_ref(), policy.nonce.to_le_bytes().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, Policy>,

    #[account(address = pool.asset_mint)]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, address = pool.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// `FR-066`: an account the policy's owner holds the authority over, and
    /// the constraint is the whole of "the recipient cannot be changed". The
    /// caller chooses which of the owner's accounts, never whose.
    #[account(
        mut,
        token::mint = asset_mint,
        token::authority = policy.owner,
    )]
    pub owner_tokens: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Pays a policy whose index crossed its threshold — `FR-026`, `FR-027`,
/// `FR-030`.
///
/// Nothing here is discretionary, and that is the point: every question the
/// pool was entitled to ask was asked at `issue_policy`, where it could still
/// say no. By the time the log says the spell happened, the obligation exists
/// and this instruction only carries it out.
///
/// A failed delivery costs nothing. The whole transaction reverts, the policy
/// stays active and the payout stays reserved, so the call can simply be made
/// again — `FR-029` turns that into a claimable balance for the case where
/// delivery cannot succeed at all.
pub fn settle_policy(ctx: Context<SettlePolicy>) -> Result<()> {
    let spell_days = check_settlement(&ctx.accounts.policy, &ctx.accounts.cell)?;
    let payout = ctx.accounts.policy.payout;

    // `FR-029`: a destination the token program will not accept. The money
    // stays in the vault and stays reserved — nothing is released and nothing
    // is lost — and the obligation is recorded as owed so the index never has
    // to be re-derived from a window the ring may have dropped by then.
    //
    // This is the only route to `Unclaimed`, and it is a fact about an
    // account rather than anybody's judgement: no caller can choose to defer
    // a payout that would have gone through, which is what keeps `FR-030`
    // true of this branch as well.
    if ctx.accounts.owner_tokens.state == AccountState::Frozen {
        let policy = &mut ctx.accounts.policy;
        policy.state = PolicyState::Unclaimed;
        emit!(PayoutUnclaimed {
            policy: policy.key(),
            owner: policy.owner,
            payout,
            spell_days,
        });
        return Ok(());
    }

    let pool_bump = ctx.accounts.pool.bump;
    let seeds: &[&[u8]] = &[POOL_SEED, &[pool_bump]];

    // Money first, accounting second — the same order as every other transfer
    // here. A policy marked paid against a transfer that did not happen is the
    // one bookkeeping error nobody can undo.
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                to: ctx.accounts.owner_tokens.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            &[seeds],
        ),
        payout,
        ctx.accounts.asset_mint.decimals,
    )?;

    release_payout(
        &mut ctx.accounts.pool,
        &mut ctx.accounts.cell,
        &mut ctx.accounts.policy,
        payout,
    )?;

    let policy = &ctx.accounts.policy;
    emit!(PolicySettled {
        policy: policy.key(),
        owner: policy.owner,
        cell_id: policy.cell_id,
        payout,
        spell_days,
        spell_days_threshold: policy.spell_days_threshold,
        window_start_day: policy.window_start_day,
        window_end_day: policy.window_end_day,
    });

    Ok(())
}

/* -------------------------------------------------------------------------- */
/* close_policy                                                               */
/* -------------------------------------------------------------------------- */

/// A window that ended without the event — `FR-028`.
#[event]
pub struct PolicyClosed {
    pub policy: Pubkey,
    pub owner: Pubkey,
    pub cell_id: u64,
    /// The longest run the window did hold, and the one it needed.
    pub spell_days: u32,
    pub spell_days_threshold: u8,
}

/// Whether the policy can be closed without paying — `FR-028`.
///
/// Two conditions, and the second is the one that matters: the window has to
/// be **finished**, not merely past. A day the log has not answered for could
/// still turn out to be dry, and closing on the strength of an incomplete
/// window would be settling a bet before the last card is turned over. This is
/// what `WindowSpell::complete` was carried out of `spell_in_window` for.
pub fn check_closure(policy: &Policy, cell: &CellState) -> Result<u32> {
    require!(
        policy.state == PolicyState::Active,
        PumpkingError::PolicyNotActive
    );
    require!(
        policy.cell_id == cell.cell_id,
        PumpkingError::PolicyCellMismatch
    );

    let reading = spell_in_window(cell, policy.window_start_day, policy.window_end_day);
    require!(reading.complete, PumpkingError::WindowNotOver);
    // The event happened; this policy owes money and `settle_policy` is the
    // instruction that says so. Closing it here would be the payout-denying
    // role `FR-030` exists to make impossible.
    require!(
        reading.longest < u32::from(policy.spell_days_threshold),
        PumpkingError::EventHasHappened
    );
    Ok(reading.longest)
}

#[derive(Accounts)]
pub struct ClosePolicy<'info> {
    /// Anybody, for the same reason settlement is: a policy that needed a
    /// particular key to be closed would tie up the pool's capacity at that
    /// key's convenience.
    pub caller: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [CELL_SEED, policy.cell_id.to_le_bytes().as_ref()],
        bump = cell.bump,
    )]
    pub cell: Account<'info, CellState>,

    #[account(
        mut,
        seeds = [POLICY_SEED, policy.owner.as_ref(), policy.nonce.to_le_bytes().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, Policy>,
}

/// Closes a policy whose window ended without the event — `FR-028`.
///
/// No money moves. The premium became capital the day the policy was issued
/// (`FR-034`), so there is nothing here to distribute: what this instruction
/// releases is the **reservation**, which is capacity rather than money. Until
/// it runs, the payout that will never happen still counts against
/// `free_liquidity` and against the cell's exposure limit, and the pool sells
/// less cover than it could.
pub fn close_policy(ctx: Context<ClosePolicy>) -> Result<()> {
    let spell_days = check_closure(&ctx.accounts.policy, &ctx.accounts.cell)?;
    let payout = ctx.accounts.policy.payout;

    let pool = &mut ctx.accounts.pool;
    pool.reserved_total = pool
        .reserved_total
        .checked_sub(payout)
        .ok_or(PumpkingError::MathOverflow)?;

    let cell = &mut ctx.accounts.cell;
    cell.reserved = cell
        .reserved
        .checked_sub(payout)
        .ok_or(PumpkingError::MathOverflow)?;
    // `FR-064` returns a cell's unspent reward reserve to capital when its
    // last policy ends; `cell.reserved == 0` is that moment. The sweep lands
    // with the reward lifecycle in `T036`, which is what knows how much of
    // the reserve the intervals actually spent.

    let policy = &mut ctx.accounts.policy;
    policy.state = PolicyState::ClosedNoEvent;

    emit!(PolicyClosed {
        policy: policy.key(),
        owner: policy.owner,
        cell_id: policy.cell_id,
        spell_days,
        spell_days_threshold: policy.spell_days_threshold,
    });

    Ok(())
}

/* -------------------------------------------------------------------------- */
/* claim_unclaimed_payout                                                     */
/* -------------------------------------------------------------------------- */

/// A payout that was owed and could not be delivered — `FR-029`. The money is
/// still in the vault and still reserved against this policy; what the event
/// records is that the obligation was recognised and delivery deferred.
#[event]
pub struct PayoutUnclaimed {
    pub policy: Pubkey,
    pub owner: Pubkey,
    pub payout: u64,
    /// The run that triggered it, kept here so the trace does not have to
    /// re-derive an index from a window the ring may no longer hold.
    pub spell_days: u32,
}

/// A deferred payout, finally delivered — `FR-029`.
#[event]
pub struct PayoutClaimed {
    pub policy: Pubkey,
    pub owner: Pubkey,
    pub payout: u64,
}

#[derive(Accounts)]
pub struct ClaimUnclaimedPayout<'info> {
    /// Anybody again. The destination is bound to the owner either way, so a
    /// stranger completing the delivery for a farmer is help, not a risk.
    pub caller: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [CELL_SEED, policy.cell_id.to_le_bytes().as_ref()],
        bump = cell.bump,
    )]
    // Boxed for the same reason as in `SettlePolicy`: 248 bytes past the SBPF
    // v0 frame without it.
    pub cell: Box<Account<'info, CellState>>,

    #[account(
        mut,
        seeds = [POLICY_SEED, policy.owner.as_ref(), policy.nonce.to_le_bytes().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, Policy>,

    #[account(address = pool.asset_mint)]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, address = pool.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// `FR-066` once more: the owner's account, and the money has nowhere
    /// else it could go.
    #[account(
        mut,
        token::mint = asset_mint,
        token::authority = policy.owner,
    )]
    pub owner_tokens: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Delivers a payout that settlement could not — `FR-029`.
///
/// The money never left the vault and never stopped being reserved, so this
/// instruction is the delivery attempt repeated with an account that works.
/// The accounting it does is the accounting `settle_policy` skipped.
pub fn claim_unclaimed_payout(ctx: Context<ClaimUnclaimedPayout>) -> Result<()> {
    require!(
        ctx.accounts.policy.state == PolicyState::Unclaimed,
        PumpkingError::PolicyNotUnclaimed
    );
    let payout = ctx.accounts.policy.payout;
    let pool_bump = ctx.accounts.pool.bump;
    let seeds: &[&[u8]] = &[POOL_SEED, &[pool_bump]];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                to: ctx.accounts.owner_tokens.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            &[seeds],
        ),
        payout,
        ctx.accounts.asset_mint.decimals,
    )?;

    release_payout(
        &mut ctx.accounts.pool,
        &mut ctx.accounts.cell,
        &mut ctx.accounts.policy,
        payout,
    )?;

    emit!(PayoutClaimed {
        policy: ctx.accounts.policy.key(),
        owner: ctx.accounts.policy.owner,
        payout,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::DayState;
    use crate::state::DAY_LOG_LEN;
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
            risk_loading_bps: 2_500,
            min_rate_bps: 100,
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
            max_premium: 2_500,
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
        // FR-022: three independent votes are the minimum, two are not
        // coverage. The number comes from the cell's last recorded day, so
        // this is what the network did rather than who signed up.
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

    /// A day log holding `dry` dry days and `wet` wet ones, the rest of the
    /// ring untouched — which is what an on-chain cell actually looks like.
    fn day_log(dry: usize, wet: usize) -> [u8; DAY_LOG_LEN] {
        let mut log = [DayState::NoCoverage as u8; DAY_LOG_LEN];
        for slot in log.iter_mut().take(dry) {
            *slot = DayState::Dry as u8;
        }
        for slot in log.iter_mut().skip(dry).take(wet) {
            *slot = DayState::Wet as u8;
        }
        log
    }

    #[test]
    fn the_price_comes_from_the_cell_own_record() {
        // Seven dry days in fourteen is 5000 bps; a quarter of loading makes
        // the rate 6250, and a quarter of the payout plus a bit is 31_250.
        let log = day_log(7, 7);
        assert_eq!(price_of(&pool(), &log, 50_000, u64::MAX).unwrap(), 31_250);
    }

    #[test]
    fn a_cell_with_no_dry_day_still_pays_the_floor() {
        // FR-021 has no way to say "we do not know yet" other than the floor:
        // a fortnight without a dry day is not proof that a cell never dries.
        let log = day_log(0, 14);
        assert_eq!(price_of(&pool(), &log, 50_000, u64::MAX).unwrap(), 500);
    }

    #[test]
    fn a_cell_too_new_to_have_a_record_cannot_be_priced() {
        let log = day_log(6, 7);
        assert_eq!(
            code_of(price_of(&pool(), &log, 50_000, u64::MAX).unwrap_err()),
            u32::from(PumpkingError::CellHistoryTooShort)
        );
    }

    #[test]
    fn the_buyer_bound_is_the_buyer_s_and_the_price_is_not() {
        // The bound never lowers the price — it refuses the sale. A quote and
        // the transaction that follows it are two different prices whenever a
        // day lands in between, and this is what the buyer is protected by.
        let log = day_log(7, 7);
        assert_eq!(price_of(&pool(), &log, 50_000, 31_250).unwrap(), 31_250);
        assert_eq!(
            code_of(price_of(&pool(), &log, 50_000, 31_249).unwrap_err()),
            u32::from(PumpkingError::PremiumAboveLimit)
        );
    }

    #[test]
    fn two_buyers_of_the_same_cover_are_quoted_the_same_number() {
        // FR-021: the formula is public and the same for everybody. Nothing
        // about the buyer is an input, so there is nothing to differ on.
        let log = day_log(3, 11);
        let first = price_of(&pool(), &log, 12_345, u64::MAX).unwrap();
        let second = price_of(&pool(), &log, 12_345, u64::MAX).unwrap();
        assert_eq!(first, second);
    }

    /* ---------------------------------------------------------------- */
    /* FR-034, FR-061: the premium divides at issue                      */
    /* ---------------------------------------------------------------- */

    #[test]
    fn the_premium_divides_by_the_published_share() {
        // A tenth to the sensors, the rest to the people carrying the risk.
        assert_eq!(split_premium(10_000, 1_000), (1_000, 9_000));
        assert_eq!(split_premium(2_500, 2_000), (500, 2_000));
    }

    #[test]
    fn neither_side_of_the_split_can_be_the_whole_premium_by_accident() {
        // The two ends of the published range, both of them legal parameters.
        assert_eq!(split_premium(7_777, 0), (0, 7_777));
        assert_eq!(split_premium(7_777, 10_000), (7_777, 0));
        // A share past the whole is refused at `initialize_pool` and cannot
        // reach here; if it ever did, it would give the sensors everything
        // rather than wrap capital past the premium.
        assert_eq!(split_premium(7_777, 30_000), (7_777, 0));
    }

    #[test]
    fn the_premium_is_conserved_exactly_at_every_share() {
        // Not a rounding preference: a unit lost between the two halves is a
        // unit sitting in the vault that no account claims and no instruction
        // can ever move. The subtraction is what makes that impossible.
        for premium in [1u64, 2, 3, 7, 999, 1_000_001, u64::MAX] {
            for bps in [0u16, 1, 333, 5_000, 9_999, 10_000] {
                let (rewards, capital) = split_premium(premium, bps);
                assert_eq!(
                    rewards.checked_add(capital),
                    Some(premium),
                    "premium {premium} at {bps} bps"
                );
            }
        }
    }

    #[test]
    fn the_dust_of_the_division_falls_to_capital() {
        // A third of one unit is nobody's unit; capital keeps it, as it keeps
        // the dust of a deposit and of a premium.
        assert_eq!(split_premium(1, 3_333), (0, 1));
        assert_eq!(split_premium(9, 5_000), (4, 5));
    }

    #[test]
    fn the_largest_premium_at_the_largest_share_does_not_wrap() {
        // The intermediate product leaves u64 long before the result does.
        assert_eq!(split_premium(u64::MAX, 10_000), (u64::MAX, 0));
        assert_eq!(split_premium(u64::MAX, 5_000), (u64::MAX / 2, u64::MAX / 2 + 1));
    }

    #[test]
    fn what_the_sensors_earned_is_not_liquidity_to_sell_against() {
        // FR-061 as underwriting sees it: the reward share never reaches
        // `capital_total`, so it is not free liquidity, it does not raise the
        // cell exposure limit, and no policy is written against it.
        let mut pool = pool();
        pool.capital_total = 0;
        pool.reserved_total = 0;

        let (to_rewards, to_capital) = split_premium(10_000, pool.premium_rewards_bps);
        pool.capital_total += to_capital;

        assert_eq!(to_rewards, 1_000);
        assert_eq!(pool.free_liquidity(), 9_000);
        assert_eq!(pool.cell_exposure_limit(), 900);
    }

    /* ---------------------------------------------------------------- */
    /* FR-026, FR-027, FR-030: settlement asks nobody                    */
    /* ---------------------------------------------------------------- */

    /// A cell whose log holds `days` from day zero.
    fn cell_of(days: &[DayState]) -> CellState {
        let mut cell = CellState {
            cell_id: 0x871e701b3ffffff,
            sensor_count: 3,
            under_investigation: false,
            reserved: 50_000,
            rewards_reserve: 250,
            first_day_index: 0,
            last_day_index: None,
            day_log: [0u8; DAY_LOG_LEN],
            contributors: [0u32; DAY_LOG_LEN],
            bump: 253,
        };
        for (day, state) in days.iter().enumerate() {
            cell.record_day(day as u32, *state, 0b111)
                .expect("the log grows forwards");
        }
        cell
    }

    /// An active policy over days 0..9, triggered by three dry days.
    fn active_policy() -> Policy {
        Policy {
            owner: Pubkey::new_unique(),
            nonce: 0,
            cell_id: 0x871e701b3ffffff,
            spell_days_threshold: 3,
            payout: 50_000,
            premium: 2_500,
            window_start_day: 0,
            window_end_day: 9,
            state: PolicyState::Active,
            bump: 252,
        }
    }

    #[test]
    fn a_spell_that_reaches_the_threshold_is_owed() {
        use DayState::{Dry, Wet};
        let cell = cell_of(&[Wet, Dry, Dry, Dry, Wet]);
        assert_eq!(check_settlement(&active_policy(), &cell).unwrap(), 3);
    }

    #[test]
    fn a_spell_one_day_short_is_not_an_event() {
        use DayState::{Dry, Wet};
        let cell = cell_of(&[Wet, Dry, Dry, Wet, Dry, Dry]);
        assert_eq!(
            code_of(check_settlement(&active_policy(), &cell).unwrap_err()),
            u32::from(PumpkingError::EventHasNotHappened)
        );
    }

    #[test]
    fn the_window_does_not_have_to_be_over() {
        use DayState::Dry;
        // SC-001 measures the delay between the day closing and the money
        // arriving. A run that reached the threshold cannot be un-reached by
        // the days after it, so waiting for the window to end would be
        // delaying a payout that is already owed.
        let cell = cell_of(&[Dry, Dry, Dry]);
        assert_eq!(check_settlement(&active_policy(), &cell).unwrap(), 3);
    }

    #[test]
    fn a_gap_in_the_middle_of_the_run_is_not_a_spell() {
        use DayState::{Dry, NoCoverage};
        // FR-047 where it costs the insured: the network went quiet on day 2,
        // so the run is two and two, not five.
        let cell = cell_of(&[Dry, Dry, NoCoverage, Dry, Dry]);
        assert_eq!(
            code_of(check_settlement(&active_policy(), &cell).unwrap_err()),
            u32::from(PumpkingError::EventHasNotHappened)
        );
    }

    #[test]
    fn a_policy_pays_once_and_not_twice() {
        use DayState::Dry;
        // FR-027. The same log, the same spell, and the second call is
        // refused by the policy's own state rather than by a ledger of who
        // has been paid.
        let cell = cell_of(&[Dry, Dry, Dry, Dry]);
        for state in [
            PolicyState::PaidOut,
            PolicyState::ClosedNoEvent,
            PolicyState::Unclaimed,
        ] {
            let mut policy = active_policy();
            policy.state = state;
            assert_eq!(
                code_of(check_settlement(&policy, &cell).unwrap_err()),
                u32::from(PumpkingError::PolicyNotActive),
                "state {state:?}"
            );
        }
    }

    #[test]
    fn a_policy_is_settled_off_its_own_cell_and_no_other() {
        use DayState::Dry;
        // The account constraint seeds the cell from `policy.cell_id`, so a
        // substituted cell cannot be passed in; this is the same rule stated
        // where the arithmetic can see it.
        let mut cell = cell_of(&[Dry, Dry, Dry, Dry]);
        cell.cell_id = 0x871e701b3fffffe;
        assert_eq!(
            code_of(check_settlement(&active_policy(), &cell).unwrap_err()),
            u32::from(PumpkingError::PolicyCellMismatch)
        );
    }

    #[test]
    fn a_cell_under_investigation_still_pays_what_it_owes() {
        use DayState::Dry;
        // FR-045: the reference moves future underwriting, never a live
        // obligation. A lever that could stop a payout would be exactly the
        // role FR-030 says must not exist.
        let mut cell = cell_of(&[Dry, Dry, Dry]);
        cell.under_investigation = true;
        assert_eq!(check_settlement(&active_policy(), &cell).unwrap(), 3);
    }

    #[test]
    fn a_spell_outside_the_window_does_not_trigger_the_policy() {
        use DayState::{Dry, Wet};
        // Ten wet days of cover, then a drought the week after it ended.
        let mut days = vec![Wet; 10];
        days.extend([Dry, Dry, Dry, Dry, Dry]);
        let cell = cell_of(&days);
        assert_eq!(
            code_of(check_settlement(&active_policy(), &cell).unwrap_err()),
            u32::from(PumpkingError::EventHasNotHappened)
        );
    }

    #[test]
    fn a_policy_whose_days_have_left_the_ring_cannot_be_settled_off_it() {
        use DayState::Dry;
        // Two hundred days of record in a 128-slot ring. The policy's window
        // is gone, and reading the days that replaced it would settle one
        // policy off another fortnight's weather.
        let cell = cell_of(&vec![Dry; 200]);
        assert_eq!(
            code_of(check_settlement(&active_policy(), &cell).unwrap_err()),
            u32::from(PumpkingError::EventHasNotHappened)
        );
    }

    #[test]
    fn settlement_reads_the_terms_and_the_log_and_nothing_else() {
        use DayState::Dry;
        // FR-030 as a signature: there is no key, no clock and no parameter
        // in this call, so there is nothing for a role to hold. Two callers
        // on the same state get the same answer because there is no third
        // input for them to differ on.
        let cell = cell_of(&[Dry, Dry, Dry]);
        let policy = active_policy();
        assert_eq!(
            check_settlement(&policy, &cell).unwrap(),
            check_settlement(&policy, &cell).unwrap()
        );
    }

    /* ---------------------------------------------------------------- */
    /* FR-028: a window that ended without the event                     */
    /* ---------------------------------------------------------------- */

    #[test]
    fn a_finished_window_without_the_event_closes() {
        use DayState::{Dry, Wet};
        // Ten days, the longest run two, the threshold three.
        let mut days = vec![Wet; 10];
        days[3] = Dry;
        days[4] = Dry;
        let cell = cell_of(&days);
        assert_eq!(check_closure(&active_policy(), &cell).unwrap(), 2);
    }

    #[test]
    fn a_window_with_a_day_still_unanswered_does_not_close() {
        use DayState::Wet;
        // The log stops at day 4 and the policy runs to day 9. Day 7 could
        // still be dry; closing now would be settling a bet before the last
        // card is turned over.
        let cell = cell_of(&vec![Wet; 5]);
        assert_eq!(
            code_of(check_closure(&active_policy(), &cell).unwrap_err()),
            u32::from(PumpkingError::WindowNotOver)
        );
    }

    #[test]
    fn a_window_that_paid_cannot_be_closed_instead() {
        use DayState::{Dry, Wet};
        // FR-030 from the other side: closing a triggered policy would be
        // exactly the payout-denying lever that must not exist.
        let mut days = vec![Wet; 10];
        days[2] = Dry;
        days[3] = Dry;
        days[4] = Dry;
        let cell = cell_of(&days);
        assert_eq!(
            code_of(check_closure(&active_policy(), &cell).unwrap_err()),
            u32::from(PumpkingError::EventHasHappened)
        );
    }

    #[test]
    fn a_policy_closes_once_and_not_twice() {
        use DayState::Wet;
        let cell = cell_of(&vec![Wet; 10]);
        for state in [
            PolicyState::PaidOut,
            PolicyState::ClosedNoEvent,
            PolicyState::Unclaimed,
        ] {
            let mut policy = active_policy();
            policy.state = state;
            assert_eq!(
                code_of(check_closure(&policy, &cell).unwrap_err()),
                u32::from(PumpkingError::PolicyNotActive),
                "state {state:?}"
            );
        }
    }

    #[test]
    fn closing_releases_capacity_and_not_money() {
        use DayState::Wet;
        // FR-028: the premium stayed in the pool at issue, so there is
        // nothing here to hand back. What moves is the reservation — until it
        // does, a payout that will never happen still counts against every
        // solvency check the pool runs.
        let mut pool = pool();
        pool.capital_total = 1_000_000;
        pool.reserved_total = 50_000;
        let mut cell = cell_of(&vec![Wet; 10]);
        let mut policy = active_policy();

        let before = pool.capital_total;
        pool.reserved_total -= policy.payout;
        cell.reserved -= policy.payout;
        policy.state = PolicyState::ClosedNoEvent;

        assert_eq!(pool.capital_total, before);
        assert_eq!(pool.free_liquidity(), 1_000_000);
        assert_eq!(cell.reserved, 0);
    }

    /* ---------------------------------------------------------------- */
    /* FR-029: a payout that could not be delivered                      */
    /* ---------------------------------------------------------------- */

    #[test]
    fn an_undelivered_payout_stays_owed_and_stays_reserved() {
        // The frozen branch of `settle_policy` writes `Unclaimed` and returns
        // before touching the books: the money is still in the vault, still
        // reserved against this policy, and still the owner's.
        let mut pool = pool();
        pool.reserved_total = 50_000;
        let cell = cell_of(&[DayState::Dry, DayState::Dry, DayState::Dry]);
        let mut policy = active_policy();

        assert_eq!(check_settlement(&policy, &cell).unwrap(), 3);
        policy.state = PolicyState::Unclaimed;

        assert_eq!(pool.reserved_total, 50_000);
        assert_eq!(cell.reserved, 50_000);
        assert_eq!(policy.payout, 50_000);
    }

    #[test]
    fn a_deferred_payout_is_released_exactly_like_a_delivered_one() {
        // `release_payout` is shared, so the two routes to the money cannot
        // book it differently.
        let mut pool = pool();
        pool.capital_total = 1_000_000;
        pool.reserved_total = 50_000;
        let mut cell = cell_of(&[DayState::Dry]);
        let mut policy = active_policy();
        policy.state = PolicyState::Unclaimed;

        let payout = policy.payout;
        release_payout(&mut pool, &mut cell, &mut policy, payout).unwrap();

        assert_eq!(pool.capital_total, 950_000);
        assert_eq!(pool.reserved_total, 0);
        assert_eq!(cell.reserved, 0);
        assert_eq!(policy.state, PolicyState::PaidOut);
        // Free liquidity is unchanged: this money was never available to sell
        // against, whether it left today or a month late.
        assert_eq!(pool.free_liquidity(), 950_000);
    }

    #[test]
    fn a_payout_cannot_be_released_past_what_was_reserved() {
        let mut pool = pool();
        pool.capital_total = 1_000_000;
        pool.reserved_total = 10;
        let mut cell = cell_of(&[DayState::Dry]);
        let mut policy = active_policy();
        assert_eq!(
            code_of(release_payout(&mut pool, &mut cell, &mut policy, 50_000).unwrap_err()),
            u32::from(PumpkingError::MathOverflow)
        );
    }

    /* ---------------------------------------------------------------- */
    /* FR-066: the recipient is fixed at issue                           */
    /* ---------------------------------------------------------------- */

    #[test]
    fn a_policy_has_no_field_that_could_redirect_its_payout() {
        // FR-066 in the only form that cannot be forgotten: there is no field
        // to change. `owner` is written once, by `issue_policy`; every
        // instruction that moves money binds its destination to
        // `token::authority = policy.owner`; and the address of the policy is
        // derived from that key, so a payout sent somewhere else would have to
        // belong to a different account.
        //
        // The size is the guard. A later `payee`, `beneficiary` or `recipient`
        // would turn FR-066 into a rule somebody has to remember instead of
        // one the layout enforces — and it would fail here first.
        const OWNER: usize = 32;
        const NONCE: usize = 8;
        const CELL_ID: usize = 8;
        const THRESHOLD: usize = 1;
        const PAYOUT: usize = 8;
        const PREMIUM: usize = 8;
        const WINDOW: usize = 4 + 4;
        const STATE: usize = 1;
        const BUMP: usize = 1;
        assert_eq!(
            Policy::INIT_SPACE,
            OWNER + NONCE + CELL_ID + THRESHOLD + PAYOUT + PREMIUM + WINDOW + STATE + BUMP
        );

        // Two owners, two addresses: a policy cannot be handed over, only
        // reissued to somebody else from the start.
        let nonce = 7u64.to_le_bytes();
        let address_of = |owner: &Pubkey| {
            Pubkey::find_program_address(&[POLICY_SEED, owner.as_ref(), &nonce], &crate::ID).0
        };
        assert_ne!(address_of(&Pubkey::new_unique()), address_of(&Pubkey::new_unique()));
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
