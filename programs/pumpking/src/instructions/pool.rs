use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::errors::PumpkingError;
use crate::state::{
    CapitalPosition, Pool, BPS_DENOMINATOR, CAPITAL_SEED, MAX_SENSORS_PER_CELL, POOL_SEED,
    STAKE_VAULT_SEED, VAULT_SEED,
};

/// Bringing the pool into existence: its parameters, its two vaults, and the
/// asset all three of premium, stake and payout are denominated in.
///
/// The asset is an argument, never a constant — `FR-031`, `FR-055`. Swapping
/// the mock token for a real stablecoin is a deployment choice, and no line of
/// policy, consensus or payout logic knows the difference.

/// Everything the authority sets at deployment. Gathered into one type so the
/// rules that make a set of parameters valid live in one place and can be
/// checked without a runtime.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PoolParams {
    /// The only role allowed to write a day record — `FR-015`. It cannot
    /// issue, settle or move anything.
    pub aggregator: Pubkey,
    /// `FR-020`: share of capital one cell may be exposed to.
    pub cell_exposure_bps: u16,
    /// `FR-034`: share of a premium that becomes the cell's reward reserve.
    pub premium_rewards_bps: u16,
    /// `FR-021`: what the pool charges on top of the expected loss.
    pub risk_loading_bps: u16,
    /// `FR-021`: the rate below which cover is not sold at any history.
    pub min_rate_bps: u16,
    /// `FR-010`: independent votes an interval needs to get a value.
    pub min_sensors_per_cell: u8,
    /// `FR-050`: stake below which a sensor publishes but does not vote.
    pub min_stake: u64,
    /// `FR-053`: thaw before stake can leave.
    pub unstake_delay_days: u16,
    /// `FR-023`: gap between buying cover and the start of the window.
    pub waiting_period_days: u16,
    /// `FR-047`: a day is dry when its total does not exceed this.
    pub dry_day_threshold_mm_x100: u32,
    /// `FR-049`: 86_400 in production, seconds in a scenario run.
    pub seconds_per_day: u32,
}

impl PoolParams {
    /// Rules a set of parameters has to satisfy to describe a pool that can
    /// actually sell anything.
    ///
    /// The bounds are not decoration. A zero exposure share sells no policy at
    /// all; a share above 100% quietly lets one cell owe more than the pool
    /// holds, which is `FR-019` broken at deployment rather than at settlement.
    /// A day of zero seconds divides by zero in every day index there will
    /// ever be.
    pub fn validate(&self, authority: Pubkey) -> Result<()> {
        require!(
            self.cell_exposure_bps > 0 && u64::from(self.cell_exposure_bps) <= BPS_DENOMINATOR,
            PumpkingError::ExposureShareOutOfRange
        );
        require!(
            u64::from(self.premium_rewards_bps) <= BPS_DENOMINATOR,
            PumpkingError::RewardsShareOutOfRange
        );
        require!(
            self.min_sensors_per_cell > 0 && self.min_sensors_per_cell <= MAX_SENSORS_PER_CELL,
            PumpkingError::MinSensorsOutOfRange
        );
        // FR-021. A loading above the expected loss itself is a price nobody
        // buys, not a danger; the bound is there to catch a misplaced digit.
        require!(
            u64::from(self.risk_loading_bps) <= BPS_DENOMINATOR,
            PumpkingError::RiskLoadingOutOfRange
        );
        // The floor is what a pool with no history to price on falls back to,
        // so a floor of zero means cover can be sold for nothing the first
        // fortnight of every new cell.
        require!(
            self.min_rate_bps > 0 && u64::from(self.min_rate_bps) <= BPS_DENOMINATOR,
            PumpkingError::MinRateOutOfRange
        );
        require!(self.seconds_per_day > 0, PumpkingError::DayLengthNotSet);
        // FR-023 and FR-053 are periods, not options. Zero would leave the
        // requirement formally present and materially absent.
        require!(
            self.waiting_period_days > 0,
            PumpkingError::WaitingPeriodNotSet
        );
        require!(
            self.unstake_delay_days > 0,
            PumpkingError::UnstakeDelayNotSet
        );
        // Three independent powers, none overlapping — the aggregator writes
        // the day log and the authority sets parameters, and one key holding
        // both could write the days that pay out the policies it priced.
        require!(
            self.aggregator != authority,
            PumpkingError::RolesNotSeparated
        );
        Ok(())
    }
}

/// `FR-057`: the key that can print the asset must hold no power in the pool.
///
/// A pool that can mint itself the asset is solvent by definition, and every
/// solvency check (`SC-006`) then measures nothing. The rule is cheap to state
/// and easy to violate by accident on a devnet where one key does everything,
/// which is exactly why the program refuses the combination instead of the
/// deployment checklist promising to avoid it.
///
/// A mint with the authority revoked — a fixed supply — passes: nobody can
/// print, so nobody with pool power can print either.
pub fn ensure_mint_is_not_pool_controlled(
    mint_authority: Option<Pubkey>,
    pool_authority: Pubkey,
    pool: Pubkey,
) -> Result<()> {
    if let Some(minter) = mint_authority {
        require!(
            minter != pool_authority && minter != pool,
            PumpkingError::MintAuthorityHasPoolPower
        );
    }
    Ok(())
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    /// Sets parameters and registries, and pays the rent. Never a signer over
    /// the vaults: they are owned by the pool PDA, so `FR-030` holds by
    /// construction — there is no key that can move a policy's money.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED],
        bump,
    )]
    pub pool: Account<'info, Pool>,

    /// `FR-031`, `FR-055`. An interface account, not a plain SPL mint, so the
    /// day this points at a real stablecoin the token program it lives under
    /// is its own business.
    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// Capital. Everything a policy is paid from.
    #[account(
        init,
        payer = authority,
        seeds = [VAULT_SEED, pool.key().as_ref()],
        bump,
        token::mint = asset_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// `FR-051`: sensor stake, held apart. It backs no policy and takes no
    /// part in the solvency check; one account for both would make a sensor's
    /// collateral into silent capital of the insurer.
    #[account(
        init,
        payer = authority,
        seeds = [STAKE_VAULT_SEED, pool.key().as_ref()],
        bump,
        token::mint = asset_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub stake_vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_pool(ctx: Context<InitializePool>, params: PoolParams) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    params.validate(authority)?;

    let pool_key = ctx.accounts.pool.key();
    let mint_authority = if ctx.accounts.asset_mint.mint_authority.is_some() {
        Some(ctx.accounts.asset_mint.mint_authority.unwrap())
    } else {
        None
    };
    ensure_mint_is_not_pool_controlled(mint_authority, authority, pool_key)?;

    // Genesis is read from the clock rather than taken as an argument. Day
    // indices are the units policies are written in, and an argument here
    // would let whoever deploys choose what "day 0" means.
    let genesis_ts = Clock::get()?.unix_timestamp;

    ctx.accounts.pool.set_inner(Pool {
        authority,
        aggregator: params.aggregator,
        asset_mint: ctx.accounts.asset_mint.key(),
        vault: ctx.accounts.vault.key(),
        stake_vault: ctx.accounts.stake_vault.key(),
        capital_total: 0,
        reserved_total: 0,
        shares_total: 0,
        cell_exposure_bps: params.cell_exposure_bps,
        premium_rewards_bps: params.premium_rewards_bps,
        risk_loading_bps: params.risk_loading_bps,
        min_rate_bps: params.min_rate_bps,
        min_sensors_per_cell: params.min_sensors_per_cell,
        min_stake: params.min_stake,
        unstake_delay_days: params.unstake_delay_days,
        waiting_period_days: params.waiting_period_days,
        dry_day_threshold_mm_x100: params.dry_day_threshold_mm_x100,
        seconds_per_day: params.seconds_per_day,
        genesis_ts,
        bump: ctx.bumps.pool,
    });

    Ok(())
}

/* -------------------------------------------------------------------------- */
/* deposit_capital                                                            */
/* -------------------------------------------------------------------------- */

/// Shares a deposit buys — `FR-032`.
///
/// The first deposit sets the scale: one unit of the asset, one share. After
/// that a deposit buys the fraction of the pool it adds, which is what makes
/// the share proportional rather than merely numerous.
///
/// Rounding is down, always towards the pool. A depositor who loses a
/// fractional share loses at most one unit of dust; existing holders diluted
/// by a rounding gain would lose real money, and the choice is between the two.
///
/// A pool holding shares against no capital cannot price a deposit at all:
/// every existing share is worth nothing, and any number minted here would be
/// an arbitrary split of the newcomer's money with people who have none left.
/// Refusing is the honest answer; picking a ratio is a quiet transfer.
pub fn shares_for_deposit(amount: u64, capital_total: u64, shares_total: u64) -> Result<u64> {
    require!(amount > 0, PumpkingError::DepositTooSmall);

    if shares_total == 0 {
        return Ok(amount);
    }
    require!(capital_total > 0, PumpkingError::PoolValueUnknown);

    let shares = u128::from(amount) * u128::from(shares_total) / u128::from(capital_total);
    let shares = u64::try_from(shares).map_err(|_| error!(PumpkingError::MathOverflow))?;
    require!(shares > 0, PumpkingError::DepositTooSmall);
    Ok(shares)
}

#[derive(Accounts)]
pub struct DepositCapital<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(address = pool.asset_mint)]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, address = pool.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = asset_mint,
        token::authority = depositor,
    )]
    pub depositor_tokens: InterfaceAccount<'info, TokenAccount>,

    /// `FR-032`. One position per wallet, opened on the first deposit and
    /// added to afterwards.
    #[account(
        init_if_needed,
        payer = depositor,
        space = 8 + CapitalPosition::INIT_SPACE,
        seeds = [CAPITAL_SEED, depositor.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, CapitalPosition>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Puts capital in and takes a proportional share out — `FR-032`.
///
/// This is the only way capital enters, and it is deliberately the same public
/// instruction for the deployer seeding the pool and for a stranger funding
/// it later. A separate `seed_pool` for the authority would be a second path
/// to the money that nobody uses in production — therefore untested — and it
/// would hand the authority a power over funds that `FR-030` exists to deny.
///
/// Transferring tokens straight into the vault is not a deposit and buys
/// nothing: `capital_total` is what the program accounts against, and a
/// balance that drifts from it would be a discrepancy nobody could see.
pub fn deposit_capital(ctx: Context<DepositCapital>, amount: u64) -> Result<()> {
    let pool = &ctx.accounts.pool;
    let shares = shares_for_deposit(amount, pool.capital_total, pool.shares_total)?;

    // Money first, accounting second: a failed transfer must not leave shares
    // minted against capital that never arrived.
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.depositor_tokens.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.asset_mint.decimals,
    )?;

    let pool = &mut ctx.accounts.pool;
    pool.capital_total = pool
        .capital_total
        .checked_add(amount)
        .ok_or(PumpkingError::MathOverflow)?;
    pool.shares_total = pool
        .shares_total
        .checked_add(shares)
        .ok_or(PumpkingError::MathOverflow)?;

    let position = &mut ctx.accounts.position;
    position.owner = ctx.accounts.depositor.key();
    position.bump = ctx.bumps.position;
    position.shares = position
        .shares
        .checked_add(shares)
        .ok_or(PumpkingError::MathOverflow)?;

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

    fn params() -> PoolParams {
        PoolParams {
            aggregator: Pubkey::new_unique(),
            cell_exposure_bps: 1_000,
            premium_rewards_bps: 1_000,
            risk_loading_bps: 2_500,
            min_rate_bps: 100,
            min_sensors_per_cell: 3,
            min_stake: 1_000_000,
            unstake_delay_days: 30,
            waiting_period_days: 3,
            dry_day_threshold_mm_x100: 100,
            seconds_per_day: 86_400,
        }
    }

    #[test]
    fn a_sane_set_of_parameters_passes() {
        assert!(params().validate(Pubkey::new_unique()).is_ok());
    }

    #[test]
    fn a_scenario_clock_is_a_valid_pool() {
        // FR-049: compressed time is a parameter of a real pool, not a mode.
        let mut p = params();
        p.seconds_per_day = 2;
        assert!(p.validate(Pubkey::new_unique()).is_ok());
    }

    #[test]
    fn a_cell_cannot_be_exposed_to_more_than_the_whole_pool() {
        let mut p = params();
        p.cell_exposure_bps = 10_001;
        assert_eq!(
            code_of(p.validate(Pubkey::new_unique()).unwrap_err()),
            u32::from(PumpkingError::ExposureShareOutOfRange)
        );

        // Nor to nothing at all: a pool that can sell no policy is not a pool.
        p.cell_exposure_bps = 0;
        assert_eq!(
            code_of(p.validate(Pubkey::new_unique()).unwrap_err()),
            u32::from(PumpkingError::ExposureShareOutOfRange)
        );

        p.cell_exposure_bps = 10_000;
        assert!(p.validate(Pubkey::new_unique()).is_ok());
    }

    #[test]
    fn the_rewards_share_is_a_share() {
        let mut p = params();
        p.premium_rewards_bps = 10_001;
        assert_eq!(
            code_of(p.validate(Pubkey::new_unique()).unwrap_err()),
            u32::from(PumpkingError::RewardsShareOutOfRange)
        );

        // Zero is allowed: a pool may run without paying sensors from premiums.
        p.premium_rewards_bps = 0;
        assert!(p.validate(Pubkey::new_unique()).is_ok());
    }

    #[test]
    fn coverage_needs_at_least_one_vote_and_at_most_the_mask() {
        let mut p = params();
        p.min_sensors_per_cell = 0;
        assert_eq!(
            code_of(p.validate(Pubkey::new_unique()).unwrap_err()),
            u32::from(PumpkingError::MinSensorsOutOfRange)
        );

        p.min_sensors_per_cell = MAX_SENSORS_PER_CELL + 1;
        assert_eq!(
            code_of(p.validate(Pubkey::new_unique()).unwrap_err()),
            u32::from(PumpkingError::MinSensorsOutOfRange)
        );

        p.min_sensors_per_cell = MAX_SENSORS_PER_CELL;
        assert!(p.validate(Pubkey::new_unique()).is_ok());
    }

    #[test]
    fn a_day_of_zero_seconds_has_no_index() {
        let mut p = params();
        p.seconds_per_day = 0;
        assert_eq!(
            code_of(p.validate(Pubkey::new_unique()).unwrap_err()),
            u32::from(PumpkingError::DayLengthNotSet)
        );
    }

    #[test]
    fn the_waiting_period_and_the_thaw_are_periods_not_options() {
        let mut p = params();
        p.waiting_period_days = 0;
        assert_eq!(
            code_of(p.validate(Pubkey::new_unique()).unwrap_err()),
            u32::from(PumpkingError::WaitingPeriodNotSet)
        );

        let mut p = params();
        p.unstake_delay_days = 0;
        assert_eq!(
            code_of(p.validate(Pubkey::new_unique()).unwrap_err()),
            u32::from(PumpkingError::UnstakeDelayNotSet)
        );
    }

    #[test]
    fn one_key_cannot_be_both_authority_and_aggregator() {
        let authority = Pubkey::new_unique();
        let mut p = params();
        p.aggregator = authority;
        assert_eq!(
            code_of(p.validate(authority).unwrap_err()),
            u32::from(PumpkingError::RolesNotSeparated)
        );
    }

    /* ------------------------------------------------------------ FR-057 */

    #[test]
    fn the_pool_may_not_be_able_to_print_its_own_asset() {
        let authority = Pubkey::new_unique();
        let pool = Pubkey::new_unique();

        assert_eq!(
            code_of(
                ensure_mint_is_not_pool_controlled(Some(authority), authority, pool).unwrap_err()
            ),
            u32::from(PumpkingError::MintAuthorityHasPoolPower)
        );
        assert_eq!(
            code_of(ensure_mint_is_not_pool_controlled(Some(pool), authority, pool).unwrap_err()),
            u32::from(PumpkingError::MintAuthorityHasPoolPower)
        );
    }

    #[test]
    fn a_separate_minting_key_is_the_point() {
        let authority = Pubkey::new_unique();
        let pool = Pubkey::new_unique();
        let minter = Pubkey::new_unique();
        assert!(ensure_mint_is_not_pool_controlled(Some(minter), authority, pool).is_ok());
    }

    /* ------------------------------------------------------------ Shares */

    #[test]
    fn the_first_deposit_sets_the_scale() {
        assert_eq!(shares_for_deposit(1_000, 0, 0).unwrap(), 1_000);
    }

    #[test]
    fn a_deposit_buys_the_fraction_of_the_pool_it_adds() {
        // Pool of 1000 against 1000 shares: 500 in buys 500 shares.
        assert_eq!(shares_for_deposit(500, 1_000, 1_000).unwrap(), 500);
        // Same pool after it grew to 2000 on the same 1000 shares: a share
        // now costs twice as much, so 500 buys half as many.
        assert_eq!(shares_for_deposit(500, 2_000, 1_000).unwrap(), 250);
        // And after losses to 500: a share is cheap, 500 buys 1000.
        assert_eq!(shares_for_deposit(500, 500, 1_000).unwrap(), 1_000);
    }

    #[test]
    fn rounding_goes_to_the_pool_not_the_depositor() {
        // 100 * 3 / 7 = 42.85…; the depositor gets 42 and the fraction stays
        // with the holders. The other way round is dilution of real money.
        assert_eq!(shares_for_deposit(100, 7, 3).unwrap(), 42);
    }

    #[test]
    fn a_deposit_that_would_buy_no_share_is_refused() {
        // 1 unit into a pool where a share costs 1000 rounds to nothing. It
        // would be a donation dressed as a deposit.
        assert_eq!(
            code_of(shares_for_deposit(1, 1_000_000, 1_000).unwrap_err()),
            u32::from(PumpkingError::DepositTooSmall)
        );
        assert_eq!(
            code_of(shares_for_deposit(0, 0, 0).unwrap_err()),
            u32::from(PumpkingError::DepositTooSmall)
        );
    }

    #[test]
    fn shares_against_no_capital_cannot_price_a_deposit() {
        // Every existing share is worth nothing, and any ratio picked here
        // would quietly hand part of the newcomer's money to holders who have
        // none left.
        assert_eq!(
            code_of(shares_for_deposit(1_000, 0, 5_000).unwrap_err()),
            u32::from(PumpkingError::PoolValueUnknown)
        );
    }

    #[test]
    fn the_share_arithmetic_does_not_overflow_on_the_way() {
        // amount * shares_total exceeds u64 long before either does; the
        // multiplication goes through u128 and the result still fits.
        let huge = u64::MAX / 2;
        assert_eq!(shares_for_deposit(huge, huge, huge).unwrap(), huge);
    }

    #[test]
    fn a_fixed_supply_asset_is_accepted() {
        // No mint authority at all: nobody can print, so nobody with power
        // over the pool can print either.
        let authority = Pubkey::new_unique();
        let pool = Pubkey::new_unique();
        assert!(ensure_mint_is_not_pool_controlled(None, authority, pool).is_ok());
    }
}
