use anchor_lang::prelude::*;

declare_id!("F2cw4FWjzUL29G4WEWHANUE2jXAyF9QJLCdvmsjy7YbY");

pub mod errors;
pub mod index;
pub mod instructions;
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
}
