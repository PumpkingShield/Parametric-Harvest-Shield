//! Open registration and stake — `FR-007`, `FR-050`, `FR-051`.
//!
//! Anyone can put a sensor on the network: no list, no approval, no role. What
//! keeps an open registry from being a free vote is the stake. A sensor votes
//! in its cell's median only while it holds at least the pool's minimum
//! (`Sensor::votes`), so moving a cell's value means staking a majority of its
//! independent votes — the price of collusion `FR-054` publishes.
//!
//! **Where the stake is checked.** The aggregator builds the day's median from
//! sensors this registry says are staked, and publishes the resulting
//! `contributors` mask with the day. The program does not re-derive the mask:
//! passing every voter's account into `submit_day_record` would cost a
//! kilobyte a transaction for a check anyone can already make — the mask is on
//! chain, the registry is on chain, and a bit set for an unstaked sensor is
//! visible to whoever compares them. The program enforces stake where money
//! moves instead: rewards (`FR-062`) and burns (`FR-052`) read the `Sensor`
//! account itself.
//!
//! **The stake vault is not capital** (`FR-051`). Stake goes into the pool's
//! separate stake vault and touches none of `capital_total`, `reserved_total`
//! or `shares_total`: it covers no policy and is reserved against no payout.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::errors::PumpkingError;
use crate::h3;
use crate::state::{
    CellState, Pool, Sensor, CELL_SEED, GRID_RESOLUTION, MAX_SENSORS_PER_CELL, POOL_SEED,
    SENSOR_SEED,
};

#[event]
pub struct SensorRegistered {
    pub sensor_key: Pubkey,
    pub operator: Pubkey,
    pub cell_id: u64,
    pub slot_in_cell: u8,
}

#[event]
pub struct SensorStaked {
    pub sensor_key: Pubkey,
    pub operator: Pubkey,
    pub amount: u64,
    pub stake: u64,
}

/// The cell a sensor may register in: an H3 cell on the network's grid level.
pub fn check_cell_id(cell_id: u64) -> Result<()> {
    require!(h3::is_cell(cell_id), PumpkingError::NotAnH3Cell);
    require!(
        h3::resolution(cell_id) == GRID_RESOLUTION,
        PumpkingError::WrongGridResolution
    );
    Ok(())
}

/// The next slot of a cell's `contributors` mask, or an error when there is
/// none. Slots are handed out in order and never returned: a deactivated
/// sensor keeps its bit, because a reused bit would change who voted on a day
/// already written.
pub fn next_slot(sensor_count: u8) -> Result<u8> {
    require!(
        sensor_count < MAX_SENSORS_PER_CELL,
        PumpkingError::CellIsFull
    );
    Ok(sensor_count)
}

#[derive(Accounts)]
#[instruction(cell_id: u64)]
pub struct RegisterSensor<'info> {
    /// Pays for the sensor account (and the cell's, if this is the cell's first
    /// sensor), and is who the sensor's vote, rewards and stake belong to.
    #[account(mut)]
    pub operator: Signer<'info>,

    /// The key the sensor signs its readings with. It signs here too: without
    /// it, anyone could register somebody else's device under their own wallet
    /// and collect its rewards.
    pub sensor_key: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    // Boxed for the same reason as in `IssuePolicy`: `CellState` carries the
    // day log and the contributor masks, and on the stack beside the other
    // accounts it overruns the 4 KiB frame `try_accounts` is given.
    #[account(
        init_if_needed,
        payer = operator,
        space = 8 + CellState::INIT_SPACE,
        seeds = [CELL_SEED, cell_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub cell: Box<Account<'info, CellState>>,

    /// `init`, not `init_if_needed`: a key is registered once. Moving a sensor
    /// to another cell is its own explicit action (`FR-059`), not a second
    /// registration quietly overwriting the first.
    #[account(
        init,
        payer = operator,
        space = 8 + Sensor::INIT_SPACE,
        seeds = [SENSOR_SEED, sensor_key.key().as_ref()],
        bump,
    )]
    pub sensor: Account<'info, Sensor>,

    pub system_program: Program<'info, System>,
}

/// Puts a sensor in a cell — `FR-001`, `FR-007`, `FR-058`.
pub fn register_sensor(ctx: Context<RegisterSensor>, cell_id: u64) -> Result<()> {
    check_cell_id(cell_id)?;

    let cell = &mut ctx.accounts.cell;
    let slot = next_slot(cell.sensor_count)?;
    // Written every time, as in `submit_day_record`: a cell opened here is all
    // zeroes, and one opened by the aggregator already holds the same values.
    cell.cell_id = cell_id;
    cell.bump = ctx.bumps.cell;
    cell.sensor_count = slot + 1;

    let sensor = &mut ctx.accounts.sensor;
    sensor.sensor_key = ctx.accounts.sensor_key.key();
    sensor.operator = ctx.accounts.operator.key();
    sensor.cell_id = cell_id;
    sensor.slot_in_cell = slot;
    sensor.stake = 0;
    sensor.unlock_at_day = None;
    sensor.accepted = 0;
    sensor.outliers = 0;
    sensor.active = true;
    sensor.bump = ctx.bumps.sensor;

    emit!(SensorRegistered {
        sensor_key: sensor.sensor_key,
        operator: sensor.operator,
        cell_id,
        slot_in_cell: slot,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct StakeSensor<'info> {
    /// Only the sensor's operator: the stake is the operator's, it is what
    /// burns into capital if the sensor is excluded (`FR-052`), and a stake
    /// someone else put up would be theirs to lose for a device they do not run.
    pub operator: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [SENSOR_SEED, sensor.sensor_key.as_ref()],
        bump = sensor.bump,
        has_one = operator @ PumpkingError::NotTheOperator,
    )]
    pub sensor: Account<'info, Sensor>,

    #[account(address = pool.asset_mint)]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// `FR-051`: the stake vault, never the capital vault.
    #[account(mut, address = pool.stake_vault)]
    pub stake_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = asset_mint,
        token::authority = operator,
    )]
    pub operator_tokens: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Adds to a sensor's stake — `FR-050`, `FR-051`.
pub fn stake_sensor(ctx: Context<StakeSensor>, amount: u64) -> Result<()> {
    require!(amount > 0, PumpkingError::StakeTooSmall);

    // Money first, accounting second, as in `deposit_capital`.
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.operator_tokens.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                to: ctx.accounts.stake_vault.to_account_info(),
                authority: ctx.accounts.operator.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.asset_mint.decimals,
    )?;

    let sensor = &mut ctx.accounts.sensor;
    sensor.stake = sensor
        .stake
        .checked_add(amount)
        .ok_or(PumpkingError::MathOverflow)?;

    emit!(SensorStaked {
        sensor_key: sensor.sensor_key,
        operator: sensor.operator,
        amount,
        stake: sensor.stake,
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

    fn code(err: PumpkingError) -> u32 {
        code_of(error!(err))
    }

    /// `871e701b3ffffff`, the demo cell, as the program stores it.
    const DEMO_CELL: u64 = 0x0871_e701_b3ff_ffff;

    #[test]
    fn accepts_a_cell_on_the_network_grid() {
        assert!(check_cell_id(DEMO_CELL).is_ok());
    }

    #[test]
    fn refuses_a_number_that_is_not_a_cell() {
        assert_eq!(
            code_of(check_cell_id(0).unwrap_err()),
            code(PumpkingError::NotAnH3Cell)
        );
        assert_eq!(
            code_of(check_cell_id(DEMO_CELL | (1 << 63)).unwrap_err()),
            code(PumpkingError::NotAnH3Cell)
        );
    }

    #[test]
    fn refuses_a_cell_on_another_grid_level() {
        // The same place one level down: a real cell, and one no res 7 policy
        // could ever be written on.
        let res8 = 0x0881_e701_b33f_ffff;
        assert!(h3::is_cell(res8));
        assert_eq!(
            code_of(check_cell_id(res8).unwrap_err()),
            code(PumpkingError::WrongGridResolution)
        );
    }

    #[test]
    fn hands_out_thirty_two_slots_in_order_and_no_thirty_third() {
        for count in 0..MAX_SENSORS_PER_CELL {
            assert_eq!(next_slot(count).unwrap(), count);
        }
        assert_eq!(
            code_of(next_slot(MAX_SENSORS_PER_CELL).unwrap_err()),
            code(PumpkingError::CellIsFull)
        );
    }
}
