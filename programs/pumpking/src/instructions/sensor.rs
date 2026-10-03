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
//!
//! **Leaving takes a thaw** (`FR-053`). `request_unstake` moves part of the
//! stake into `Sensor::unstaking`, where it stops voting but stays in the
//! vault, still answerable for what the sensor's readings did; `withdraw_stake`
//! pays it out once `unstake_delay_days` have passed — a delay the pool cannot
//! set shorter than the window outliers are counted over.
//!
//! **Exclusion is anyone's to call and the program's to decide** (`FR-012`,
//! `FR-052`). `exclude_sensor` takes no word from anybody: it sums the
//! sensor's slot over the window in the cell's `CellReputation` — written a
//! day at a time, forwards only, beside the day log — applies the published
//! rule, and burns the whole stake, thawing part included, into capital.
//! Coming back is the operator's own act (`reinstate_sensor`) and costs a new
//! stake: the slate is clean, the old stake is gone.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::errors::PumpkingError;
use crate::h3;
use crate::instructions::rewards::rewards_error;
use crate::outlier::breaches_outlier_share;
use crate::state::{
    outlier_window, CellReputation, CellRewards, CellState, Pool, Sensor, CELL_SEED,
    GRID_RESOLUTION, MAX_SENSORS_PER_CELL, POOL_SEED, REPUTATION_SEED, REWARDS_SEED, SENSOR_SEED,
};

#[event]
pub struct UnstakeRequested {
    pub sensor_key: Pubkey,
    pub operator: Pubkey,
    pub amount: u64,
    pub stake: u64,
    pub unstaking: u64,
    pub unlock_at_day: u32,
}

#[event]
pub struct StakeWithdrawn {
    pub sensor_key: Pubkey,
    pub operator: Pubkey,
    pub amount: u64,
}

#[event]
pub struct SensorExcludedForOutliers {
    pub sensor_key: Pubkey,
    pub operator: Pubkey,
    pub cell_id: u64,
    /// The window the record was summed over, both ends inclusive.
    pub window_from_day: u32,
    pub window_to_day: u32,
    pub judged: u32,
    pub outliers: u32,
    /// Voting and thawing stake together, now capital.
    pub burnt: u64,
    /// Rewards earned and not claimed, now capital as well.
    pub forfeited_rewards: u64,
}

#[event]
pub struct SensorReinstated {
    pub sensor_key: Pubkey,
    pub operator: Pubkey,
}

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
    sensor.unstaking = 0;
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

/// Moves `amount` of a sensor's voting stake into the thaw and returns the day
/// it unlocks — `FR-053`.
///
/// A second request adds to what is already thawing and starts the count again
/// from today: otherwise the second part of a stake would ride out a thaw that
/// began before it stopped voting, which is exactly the shortcut the delay is
/// there to close.
pub fn begin_thaw(sensor: &mut Sensor, amount: u64, today: u32, delay_days: u16) -> Result<u32> {
    // FR-052: an excluded sensor's stake is forfeit, thawing or not.
    require!(sensor.active, PumpkingError::SensorExcluded);
    require!(amount > 0, PumpkingError::StakeTooSmall);
    require!(amount <= sensor.stake, PumpkingError::UnstakeExceedsStake);
    let unlock_at = today
        .checked_add(u32::from(delay_days))
        .ok_or(PumpkingError::MathOverflow)?;

    sensor.stake -= amount;
    sensor.unstaking = sensor
        .unstaking
        .checked_add(amount)
        .ok_or(PumpkingError::MathOverflow)?;
    sensor.unlock_at_day = Some(unlock_at);
    Ok(unlock_at)
}

/// What a sensor may withdraw today, or why nothing. Reads only: the transfer
/// goes first, and the account is cleared after it.
pub fn thawed_amount(sensor: &Sensor, today: u32) -> Result<u64> {
    require!(sensor.active, PumpkingError::SensorExcluded);
    let unlock_at = match sensor.unlock_at_day {
        Some(day) if sensor.unstaking > 0 => day,
        _ => return err!(PumpkingError::NothingThawing),
    };
    if today < unlock_at {
        // The account already says when; the log says how long, so a refused
        // withdrawal explains itself to whoever reads the transaction.
        msg!(
            "Stake thaws on day {}: {} day(s) left",
            unlock_at,
            unlock_at - today
        );
        return err!(PumpkingError::StakeStillThawing);
    }
    Ok(sensor.unstaking)
}

#[derive(Accounts)]
pub struct RequestUnstake<'info> {
    /// Only the operator: it is their stake, and a thaw someone else started
    /// would silence a sensor that never asked to stop voting.
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
}

/// Starts the thaw for part or all of a sensor's stake — `FR-053`.
pub fn request_unstake(ctx: Context<RequestUnstake>, amount: u64) -> Result<()> {
    let pool = &ctx.accounts.pool;
    let today = pool
        .day_index(Clock::get()?.unix_timestamp)
        .ok_or(PumpkingError::DayIndexUnavailable)?;

    let sensor = &mut ctx.accounts.sensor;
    let unlock_at_day = begin_thaw(sensor, amount, today, pool.unstake_delay_days)?;

    emit!(UnstakeRequested {
        sensor_key: sensor.sensor_key,
        operator: sensor.operator,
        amount,
        stake: sensor.stake,
        unstaking: sensor.unstaking,
        unlock_at_day,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawStake<'info> {
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

    /// `FR-051`: stake leaves from the stake vault and never from capital.
    #[account(mut, address = pool.stake_vault)]
    pub stake_vault: InterfaceAccount<'info, TokenAccount>,

    /// The operator's own account: stake goes back to whoever put it up.
    #[account(
        mut,
        token::mint = asset_mint,
        token::authority = operator,
    )]
    pub operator_tokens: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Pays out the stake whose thaw has ended — `FR-053`.
pub fn withdraw_stake(ctx: Context<WithdrawStake>) -> Result<()> {
    let today = ctx
        .accounts
        .pool
        .day_index(Clock::get()?.unix_timestamp)
        .ok_or(PumpkingError::DayIndexUnavailable)?;
    let amount = thawed_amount(&ctx.accounts.sensor, today)?;

    let pool_bump = ctx.accounts.pool.bump;
    let seeds: &[&[u8]] = &[POOL_SEED, &[pool_bump]];

    // Money first, accounting second, as in `settle_policy`.
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.stake_vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                to: ctx.accounts.operator_tokens.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.asset_mint.decimals,
    )?;

    let sensor = &mut ctx.accounts.sensor;
    sensor.unstaking = 0;
    sensor.unlock_at_day = None;

    emit!(StakeWithdrawn {
        sensor_key: sensor.sensor_key,
        operator: sensor.operator,
        amount,
    });
    Ok(())
}

/// The record an exclusion on `today` stands on, or why there is none —
/// `FR-012`. Returns the window and the slot's judged and outlier counts.
pub fn exclusion_record(
    sensor: &Sensor,
    reputation: &CellReputation,
    today: u32,
) -> Result<(u32, u32, u32, u32)> {
    require!(sensor.active, PumpkingError::SensorExcluded);
    let (from, to) = outlier_window(today).ok_or(PumpkingError::OutlierShareNotBreached)?;
    let (judged, outliers) = reputation.window(sensor.slot_in_cell, from, to);
    require!(
        breaches_outlier_share(judged, outliers),
        PumpkingError::OutlierShareNotBreached
    );
    Ok((from, to, judged, outliers))
}

#[derive(Accounts)]
pub struct ExcludeSensor<'info> {
    /// Anyone. No key decides an exclusion, as none decides a payout: the
    /// record is on chain and the rule is the program's.
    pub caller: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [SENSOR_SEED, sensor.sensor_key.as_ref()],
        bump = sensor.bump,
    )]
    pub sensor: Account<'info, Sensor>,

    // Zero-copy: the ring is read in place, never copied onto the stack.
    #[account(
        seeds = [REPUTATION_SEED, sensor.cell_id.to_le_bytes().as_ref()],
        bump = reputation.load()?.bump,
    )]
    pub reputation: AccountLoader<'info, CellReputation>,

    /// What the sensor earned and had not claimed is forfeited with the
    /// stake. It already sits in the capital vault, so only the books move.
    #[account(
        mut,
        seeds = [REWARDS_SEED, sensor.cell_id.to_le_bytes().as_ref()],
        bump = rewards.load()?.bump,
    )]
    pub rewards: AccountLoader<'info, CellRewards>,

    #[account(address = pool.asset_mint)]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, address = pool.stake_vault)]
    pub stake_vault: InterfaceAccount<'info, TokenAccount>,

    /// `FR-052`: the burnt stake becomes capital.
    #[account(mut, address = pool.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Excludes a sensor whose record over the window breaches the outlier share,
/// and burns its stake into capital — `FR-012`, `FR-052`.
pub fn exclude_sensor(ctx: Context<ExcludeSensor>) -> Result<()> {
    let today = ctx
        .accounts
        .pool
        .day_index(Clock::get()?.unix_timestamp)
        .ok_or(PumpkingError::DayIndexUnavailable)?;
    let (from, to, judged, outliers) = exclusion_record(
        &ctx.accounts.sensor,
        &*ctx.accounts.reputation.load()?,
        today,
    )?;

    let burnt = ctx
        .accounts
        .sensor
        .stake
        .checked_add(ctx.accounts.sensor.unstaking)
        .ok_or(PumpkingError::MathOverflow)?;

    if burnt > 0 {
        let pool_bump = ctx.accounts.pool.bump;
        let seeds: &[&[u8]] = &[POOL_SEED, &[pool_bump]];
        // Money first, accounting second.
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.stake_vault.to_account_info(),
                    mint: ctx.accounts.asset_mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            burnt,
            ctx.accounts.asset_mint.decimals,
        )?;
    }

    // Unclaimed rewards go the same way. They are in the capital vault
    // already, set apart only by `CellRewards::reserve`.
    let forfeited = ctx
        .accounts
        .rewards
        .load_mut()?
        .take_accrued(ctx.accounts.sensor.slot_in_cell)
        .map_err(rewards_error)?;

    // Capital grows and the shares do not: the burn is the depositors' to
    // keep, which is what makes collusion cost the colluders.
    let pool = &mut ctx.accounts.pool;
    pool.capital_total = pool
        .capital_total
        .checked_add(burnt)
        .and_then(|total| total.checked_add(forfeited))
        .ok_or(PumpkingError::MathOverflow)?;

    let sensor = &mut ctx.accounts.sensor;
    sensor.stake = 0;
    sensor.unstaking = 0;
    sensor.unlock_at_day = None;
    sensor.active = false;
    // The record it was excluded on, readable from the account itself.
    sensor.accepted = judged - outliers;
    sensor.outliers = outliers;

    emit!(SensorExcludedForOutliers {
        sensor_key: sensor.sensor_key,
        operator: sensor.operator,
        cell_id: sensor.cell_id,
        window_from_day: from,
        window_to_day: to,
        judged,
        outliers,
        burnt,
        forfeited_rewards: forfeited,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ReinstateSensor<'info> {
    pub operator: Signer<'info>,

    #[account(
        mut,
        seeds = [SENSOR_SEED, sensor.sensor_key.as_ref()],
        bump = sensor.bump,
        has_one = operator @ PumpkingError::NotTheOperator,
    )]
    pub sensor: Account<'info, Sensor>,

    #[account(
        mut,
        seeds = [REPUTATION_SEED, sensor.cell_id.to_le_bytes().as_ref()],
        bump = reputation.load()?.bump,
    )]
    pub reputation: AccountLoader<'info, CellReputation>,
}

/// Brings an excluded sensor back with a clean slate — `FR-012`.
///
/// The operator's own act and nobody else's, as registration is (`FR-007`).
/// What it restores is the right to vote, not a vote: the stake burnt with
/// the exclusion is gone, and the sensor counts again only once it is staked
/// to the minimum anew. Its slot's history is cleared — otherwise the very
/// record that excluded it would let anyone exclude it again the moment it
/// came back, for nothing it did since.
pub fn reinstate_sensor(ctx: Context<ReinstateSensor>) -> Result<()> {
    let sensor = &mut ctx.accounts.sensor;
    require!(!sensor.active, PumpkingError::SensorNotExcluded);
    sensor.active = true;
    sensor.accepted = 0;
    sensor.outliers = 0;
    ctx.accounts
        .reputation
        .load_mut()?
        .clear_slot(sensor.slot_in_cell);

    emit!(SensorReinstated {
        sensor_key: sensor.sensor_key,
        operator: sensor.operator,
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

    fn staked(stake: u64) -> Sensor {
        Sensor {
            sensor_key: Pubkey::default(),
            operator: Pubkey::default(),
            cell_id: DEMO_CELL,
            slot_in_cell: 0,
            stake,
            unstaking: 0,
            unlock_at_day: None,
            accepted: 0,
            outliers: 0,
            active: true,
            bump: 255,
        }
    }

    #[test]
    fn a_thaw_moves_stake_out_of_the_vote_and_dates_its_end() {
        let mut sensor = staked(1_000);
        assert_eq!(begin_thaw(&mut sensor, 400, 100, 30).unwrap(), 130);
        assert_eq!(sensor.stake, 600);
        assert_eq!(sensor.unstaking, 400);
        assert_eq!(sensor.unlock_at_day, Some(130));
        // FR-050: what is left votes on its own merits.
        assert!(sensor.votes(600));
        assert!(!sensor.votes(601));
    }

    #[test]
    fn a_second_request_adds_and_starts_the_count_again() {
        let mut sensor = staked(1_000);
        begin_thaw(&mut sensor, 400, 100, 30).unwrap();
        assert_eq!(begin_thaw(&mut sensor, 600, 125, 30).unwrap(), 155);
        assert_eq!(sensor.stake, 0);
        assert_eq!(sensor.unstaking, 1_000);
        assert_eq!(sensor.unlock_at_day, Some(155));
        // The first 400 do not leave on day 130: they wait behind the same
        // date as the 600 that stopped voting later.
        assert_eq!(
            code_of(thawed_amount(&sensor, 130).unwrap_err()),
            code(PumpkingError::StakeStillThawing)
        );
    }

    #[test]
    fn a_thaw_takes_at_least_one_unit_and_no_more_than_votes() {
        let mut sensor = staked(1_000);
        assert_eq!(
            code_of(begin_thaw(&mut sensor, 0, 100, 30).unwrap_err()),
            code(PumpkingError::StakeTooSmall)
        );
        assert_eq!(
            code_of(begin_thaw(&mut sensor, 1_001, 100, 30).unwrap_err()),
            code(PumpkingError::UnstakeExceedsStake)
        );
        // What is already thawing is not stake to thaw a second time.
        begin_thaw(&mut sensor, 1_000, 100, 30).unwrap();
        assert_eq!(
            code_of(begin_thaw(&mut sensor, 1, 101, 30).unwrap_err()),
            code(PumpkingError::UnstakeExceedsStake)
        );
        assert_eq!(sensor.unstaking, 1_000);
        assert_eq!(sensor.unlock_at_day, Some(130));
    }

    #[test]
    fn the_stake_leaves_on_the_unlock_day_and_not_the_day_before() {
        let mut sensor = staked(1_000);
        begin_thaw(&mut sensor, 400, 100, 30).unwrap();
        assert_eq!(
            code_of(thawed_amount(&sensor, 129).unwrap_err()),
            code(PumpkingError::StakeStillThawing)
        );
        assert_eq!(thawed_amount(&sensor, 130).unwrap(), 400);
        assert_eq!(thawed_amount(&sensor, 1_000).unwrap(), 400);
    }

    #[test]
    fn nothing_thawing_is_nothing_to_withdraw() {
        assert_eq!(
            code_of(thawed_amount(&staked(1_000), u32::MAX).unwrap_err()),
            code(PumpkingError::NothingThawing)
        );
    }

    #[test]
    fn an_excluded_sensor_neither_thaws_nor_withdraws() {
        // FR-052: exclusion burns the whole stake, the thawing part included.
        let mut sensor = staked(1_000);
        begin_thaw(&mut sensor, 400, 100, 30).unwrap();
        sensor.active = false;
        assert_eq!(
            code_of(begin_thaw(&mut sensor, 100, 200, 30).unwrap_err()),
            code(PumpkingError::SensorExcluded)
        );
        assert_eq!(
            code_of(thawed_amount(&sensor, 200).unwrap_err()),
            code(PumpkingError::SensorExcluded)
        );
    }

    #[test]
    fn an_unlock_day_past_the_calendar_is_an_error_not_a_wrap() {
        let mut sensor = staked(1_000);
        assert_eq!(
            code_of(begin_thaw(&mut sensor, 1, u32::MAX - 29, 30).unwrap_err()),
            code(PumpkingError::MathOverflow)
        );
        assert_eq!(sensor.stake, 1_000);
    }

    fn record(
        slot: usize,
        days: std::ops::Range<u32>,
        judged: u16,
        outliers: u16,
    ) -> CellReputation {
        let mut rep = CellReputation::empty(DEMO_CELL, 255);
        for day in days {
            let mut j = [0u16; MAX_SENSORS_PER_CELL as usize];
            let mut o = [0u16; MAX_SENSORS_PER_CELL as usize];
            j[slot] = judged;
            o[slot] = outliers;
            rep.record_day(day, j, o).unwrap();
        }
        rep
    }

    #[test]
    fn a_breaching_record_over_the_window_excludes() {
        // Days 6..=19, 24 judged a day, 5 outliers a day: 70 of 336 > 20 %.
        let rep = record(0, 6..20, 24, 5);
        assert_eq!(
            exclusion_record(&staked(1_000), &rep, 20).unwrap(),
            (6, 19, 336, 70)
        );
    }

    #[test]
    fn a_record_at_the_threshold_does_not() {
        // 4 of 24 a day is 16.7 %: a sensor that is often off, not one that lies.
        let rep = record(0, 6..20, 24, 4);
        assert_eq!(
            code_of(exclusion_record(&staked(1_000), &rep, 20).unwrap_err()),
            code(PumpkingError::OutlierShareNotBreached)
        );
    }

    #[test]
    fn days_that_left_the_window_count_for_nothing() {
        // A sensor that lied a fortnight ago and has been clean since.
        let mut rep = record(0, 0..10, 24, 24);
        for day in 10..30 {
            let mut j = [0u16; MAX_SENSORS_PER_CELL as usize];
            j[0] = 24;
            rep.record_day(day, j, [0; MAX_SENSORS_PER_CELL as usize])
                .unwrap();
        }
        assert_eq!(
            code_of(exclusion_record(&staked(1_000), &rep, 30).unwrap_err()),
            code(PumpkingError::OutlierShareNotBreached)
        );
    }

    #[test]
    fn another_slot_s_record_is_not_this_sensor_s() {
        let rep = record(5, 6..20, 24, 24);
        assert_eq!(
            code_of(exclusion_record(&staked(1_000), &rep, 20).unwrap_err()),
            code(PumpkingError::OutlierShareNotBreached)
        );
    }

    #[test]
    fn an_excluded_sensor_is_not_excluded_twice_and_day_zero_has_no_window() {
        let rep = record(0, 6..20, 24, 24);
        let mut sensor = staked(1_000);
        sensor.active = false;
        assert_eq!(
            code_of(exclusion_record(&sensor, &rep, 20).unwrap_err()),
            code(PumpkingError::SensorExcluded)
        );
        assert_eq!(
            code_of(exclusion_record(&staked(1_000), &rep, 0).unwrap_err()),
            code(PumpkingError::OutlierShareNotBreached)
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
