use anchor_lang::prelude::*;

declare_id!("F2cw4FWjzUL29G4WEWHANUE2jXAyF9QJLCdvmsjy7YbY");

pub mod errors;
pub mod h3;
pub mod index;
pub mod instructions;
pub mod outlier;
pub mod premium;
pub mod state;

use instructions::*;

#[program]
pub mod pumpking {
    use super::*;

    /// Creates the pool, its capital vault and its stake vault, and fixes the
    /// asset all three of premium, stake and payout are denominated in.
    pub fn initialize_pool(ctx: Context<InitializePool>, params: PoolParams) -> Result<()> {
        instructions::pool::initialize_pool(ctx, params)
    }

    /// Changes what a vote costs and what a cell may owe — `FR-054`. The
    /// authority's alone; policies already sold keep their reservation.
    pub fn set_pool_params(ctx: Context<SetPoolParams>, params: RiskParams) -> Result<()> {
        instructions::pool::set_pool_params(ctx, params)
    }

    /// Puts capital in and takes a proportional share out — `FR-032`. The same
    /// instruction seeds the pool and funds it later; there is no second path.
    pub fn deposit_capital(ctx: Context<DepositCapital>, amount: u64) -> Result<()> {
        instructions::pool::deposit_capital(ctx, amount)
    }

    /// Sells cover — `FR-018`. Once this returns, the payout is owed the
    /// moment the index says so: `settle_policy` has no discretion, so every
    /// question the pool gets to ask is asked here.
    pub fn issue_policy(ctx: Context<IssuePolicy>, params: PolicyParams) -> Result<()> {
        instructions::policy::issue_policy(ctx, params)
    }

    /// Writes one day of a cell — `FR-015`. The only door the day log has, and
    /// the aggregator is the only key that opens it. The Merkle root of the
    /// values the day was summed from goes out as an event, which is what
    /// makes the day auditable rather than merely asserted (`FR-037`).
    pub fn submit_day_record(
        ctx: Context<SubmitDayRecord>,
        params: DayRecordParams,
    ) -> Result<()> {
        instructions::day::submit_day_record(ctx, params)
    }

    /// Pays a policy the index has triggered — `FR-026`, `FR-027`, `FR-030`.
    /// Permissionless by construction: there is no authority account in the
    /// context, so there is no key that could withhold a payout that is owed
    /// and none that could produce one the day log does not support.
    pub fn settle_policy(ctx: Context<SettlePolicy>) -> Result<()> {
        instructions::policy::settle_policy(ctx)
    }

    /// Closes a policy whose window ended without the event — `FR-028`. No
    /// money moves: the premium became capital at issue. What is released is
    /// the reservation, which is the pool's capacity to sell more cover.
    pub fn close_policy(ctx: Context<ClosePolicy>) -> Result<()> {
        instructions::policy::close_policy(ctx)
    }

    /// Delivers a payout settlement could not — `FR-029`. Reachable only for
    /// a policy whose owner's account was frozen when the event landed; the
    /// money waited in the vault, reserved, the whole time.
    pub fn claim_unclaimed_payout(ctx: Context<ClaimUnclaimedPayout>) -> Result<()> {
        instructions::policy::claim_unclaimed_payout(ctx)
    }

    /// Puts a sensor on the network. Open to anyone (`FR-007`); the sensor's
    /// own key co-signs, and its cell is an H3 cell on the network's grid level.
    pub fn register_sensor(ctx: Context<RegisterSensor>, cell_id: u64) -> Result<()> {
        instructions::sensor::register_sensor(ctx, cell_id)
    }

    /// Adds to a sensor's stake, into the stake vault and never the capital
    /// vault (`FR-050`, `FR-051`).
    pub fn stake_sensor(ctx: Context<StakeSensor>, amount: u64) -> Result<()> {
        instructions::sensor::stake_sensor(ctx, amount)
    }

    /// Starts the thaw for part or all of a sensor's stake — `FR-053`. The
    /// amount stops voting at once and stays in the stake vault until it is
    /// withdrawn; asking again adds to it and restarts the count.
    pub fn request_unstake(ctx: Context<RequestUnstake>, amount: u64) -> Result<()> {
        instructions::sensor::request_unstake(ctx, amount)
    }

    /// Returns thawed stake to its operator once the delay, longer than the
    /// outlier observation window, has passed — `FR-053`.
    pub fn withdraw_stake(ctx: Context<WithdrawStake>) -> Result<()> {
        instructions::sensor::withdraw_stake(ctx)
    }

    /// Writes a day of the cell's outlier verdicts, per sensor slot —
    /// `FR-011` — and pays the day's reward budget by the weights sent with
    /// them, or returns it to capital — `FR-062`, `FR-064`. Sent with
    /// `submit_day_record`, for the day it just wrote, every day.
    pub fn submit_day_reputation(
        ctx: Context<SubmitDayReputation>,
        params: DayReputationParams,
    ) -> Result<()> {
        instructions::reputation::submit_day_reputation(ctx, params)
    }

    /// Excludes a sensor whose outlier share over the window breaches the
    /// published threshold and burns its stake into capital — `FR-012`,
    /// `FR-052`. Permissionless: the record and the rule are both on chain.
    pub fn exclude_sensor(ctx: Context<ExcludeSensor>) -> Result<()> {
        instructions::sensor::exclude_sensor(ctx)
    }

    /// Brings an excluded sensor back with a clean slate and no stake; it
    /// votes again once staked to the minimum anew — `FR-012`.
    pub fn reinstate_sensor(ctx: Context<ReinstateSensor>) -> Result<()> {
        instructions::sensor::reinstate_sensor(ctx)
    }

    /// Sends a sensor's earned rewards to its operator's token account —
    /// `FR-036`. Anyone may call it; the destination is bound to the operator.
    /// `cell_id` is the sensor's cell, or the one it left on its last move.
    pub fn claim_reward(ctx: Context<ClaimReward>, cell_id: u64) -> Result<()> {
        instructions::rewards::claim_reward(ctx, cell_id)
    }

    /// Moves a sensor to another cell (`FR-059`): a fresh slot there, the old
    /// one kept for the record and the earnings it carries. Operator and
    /// sensor key both sign, as at registration.
    pub fn move_sensor(ctx: Context<MoveSensor>, cell_id: u64) -> Result<()> {
        instructions::sensor::move_sensor(ctx, cell_id)
    }
}
