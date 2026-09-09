use anchor_lang::prelude::*;

declare_id!("F2cw4FWjzUL29G4WEWHANUE2jXAyF9QJLCdvmsjy7YbY");

pub mod errors;
pub mod index;
pub mod instructions;
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
}
