use anchor_lang::prelude::*;

declare_id!("F2cw4FWjzUL29G4WEWHANUE2jXAyF9QJLCdvmsjy7YbY");

pub mod index;
pub mod state;

#[program]
pub mod pumpking {
    use super::*;

    /// Placeholder entrypoint: the instruction set lands in M1.
    /// Keeping the crate compiling from day one is what makes the toolchain
    /// pins in Cargo.lock meaningful.
    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping<'info> {
    pub payer: Signer<'info>,
}
