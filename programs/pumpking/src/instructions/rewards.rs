//! Rewards for the intervals a sensor's readings carried — `FR-036`,
//! `FR-062`, `FR-063`, `FR-064`.
//!
//! **Where the money comes from.** `issue_policy` splits the premium once
//! (`FR-034`) and lays the reward share out evenly over the days of the
//! policy's window in the cell's `CellRewards` schedule. Nothing later moves
//! it: a payout part-way through the window leaves the rest of the schedule to
//! be paid, because a network whose income stopped at the event would have a
//! reason not to report one.
//!
//! **When it is paid.** Each day, in the transaction that writes it, the
//! aggregator's reputation instruction hands that day's budget to the slots in
//! proportion to the weights it sends. A day without coverage — written as
//! such, or never written at all — earns nobody anything, and its budget goes
//! back to capital there and then (`FR-064`). A cell with no policy has an
//! empty schedule and pays nothing (`FR-063`).
//!
//! **How it divides.** In each judged interval the interval's worth
//! (`REWARD_WEIGHT_UNIT`) is split equally between its votes — operators,
//! `FR-009` — and a vote's part equally between that operator's accepted
//! sensors. The aggregator sums that over the day per slot. The program checks
//! the shape (weight only where the slot had an accepted interval and voted,
//! and no more than those intervals can carry); the numbers are reproducible
//! from `sensor_verdicts` by anyone, as the verdicts themselves are.
//!
//! **Where it goes.** Earned rewards wait per slot until `claim_reward` sends
//! them to the operator. An excluded sensor forfeits what it has not claimed:
//! `exclude_sensor` returns it to capital with the stake (`FR-052`). A sensor
//! that moved (`FR-059`) claims what its old slot earned from the old cell's
//! schedule: the reserve is the cell's, and it does not travel.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::errors::PumpkingError;
use crate::state::{
    CellRewards, CellState, Pool, RewardsError, Sensor, MAX_SENSORS_PER_CELL, POOL_SEED,
    REWARDS_SEED, REWARD_WEIGHT_UNIT, SENSOR_SEED,
};

/// The schedule's refusal, as the error a client can read.
pub fn rewards_error(err: RewardsError) -> Error {
    match err {
        RewardsError::NotNewer => error!(PumpkingError::RewardDayNotNewer),
        RewardsError::BeforeSchedule => error!(PumpkingError::WindowBeforeSchedule),
        RewardsError::TooFarAhead => error!(PumpkingError::WindowTooFarAhead),
        RewardsError::Overflow => error!(PumpkingError::MathOverflow),
    }
}

/// A cell's schedule opened — and the reserve it had before there was one,
/// returned to capital.
#[event]
pub struct RewardsOpened {
    pub cell_id: u64,
    pub first_day: u32,
    /// `CellState::rewards_reserve` from before `T036`, now capital.
    pub legacy_to_capital: u64,
}

/// One day of a cell's rewards, settled.
#[event]
pub struct DayRewarded {
    pub cell_id: u64,
    pub day_index: u32,
    /// Per slot, what this day added to the slot's unclaimed balance.
    pub earned: [u64; MAX_SENSORS_PER_CELL as usize],
    /// Back to capital: this day's budget if nobody earned it, the budget of
    /// any day never written before it, and the dust of the division.
    pub returned: u64,
}

#[event]
pub struct RewardClaimed {
    pub sensor_key: Pubkey,
    pub operator: Pubkey,
    pub cell_id: u64,
    pub amount: u64,
}

/// The weights of one day, checked against the verdicts and the voters they
/// travel with, widened for the division.
pub fn check_day_weights(
    weights: &[u32; MAX_SENSORS_PER_CELL as usize],
    judged: &[u16; MAX_SENSORS_PER_CELL as usize],
    outliers: &[u16; MAX_SENSORS_PER_CELL as usize],
    contributors: u32,
) -> Result<[u64; MAX_SENSORS_PER_CELL as usize]> {
    let mut wide = [0u64; MAX_SENSORS_PER_CELL as usize];
    for slot in 0..MAX_SENSORS_PER_CELL {
        let i = usize::from(slot);
        let weight = weights[i];
        if weight == 0 {
            continue;
        }
        // `submit_day_reputation` has already refused outliers above judged.
        let accepted = judged[i].saturating_sub(outliers[i]);
        require!(
            accepted > 0 && contributors & CellState::slot_mask(slot) != 0,
            PumpkingError::WeightWithoutAcceptedInterval
        );
        require!(
            u64::from(weight) <= u64::from(accepted) * u64::from(REWARD_WEIGHT_UNIT),
            PumpkingError::WeightTooLarge
        );
        wide[i] = u64::from(weight);
    }
    Ok(wide)
}

/// Pays day `day_index` of a cell, opening its schedule first if this is the
/// day it is opened on — the rewards half of `submit_day_reputation`.
///
/// `fresh` is the loader having just been created. Opening returns the cell's
/// pre-schedule reserve to capital: it was never laid out over any day, so no
/// day could ever pay it.
pub fn pay_cell_day(
    pool: &mut Pool,
    cell: &mut CellState,
    rewards: &mut CellRewards,
    fresh: bool,
    bump: u8,
    day_index: u32,
    weights: &[u64; MAX_SENSORS_PER_CELL as usize],
) -> Result<()> {
    if fresh {
        rewards.cell_id = cell.cell_id;
        rewards.bump = bump;
        rewards.next_day = day_index;
        let legacy = std::mem::take(&mut cell.rewards_reserve);
        pool.capital_total = pool
            .capital_total
            .checked_add(legacy)
            .ok_or(PumpkingError::MathOverflow)?;
        emit!(RewardsOpened {
            cell_id: cell.cell_id,
            first_day: day_index,
            legacy_to_capital: legacy,
        });
    }

    let before = rewards.accrued;
    let paid = rewards.pay_day(day_index, weights).map_err(rewards_error)?;
    pool.capital_total = pool
        .capital_total
        .checked_add(paid.returned)
        .ok_or(PumpkingError::MathOverflow)?;

    let mut earned = [0u64; MAX_SENSORS_PER_CELL as usize];
    for (out, (now, was)) in earned.iter_mut().zip(rewards.accrued.iter().zip(before)) {
        *out = now - was;
    }
    emit!(DayRewarded {
        cell_id: cell.cell_id,
        day_index,
        earned,
        returned: paid.returned,
    });
    Ok(())
}

/* -------------------------------------------------------------------------- */
/* claim_reward                                                               */
/* -------------------------------------------------------------------------- */

#[derive(Accounts)]
#[instruction(cell_id: u64)]
pub struct ClaimReward<'info> {
    /// Anybody: the destination is bound to the operator either way, as a
    /// payout's is bound to its owner.
    pub caller: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        seeds = [SENSOR_SEED, sensor.sensor_key.as_ref()],
        bump = sensor.bump,
    )]
    pub sensor: Account<'info, Sensor>,

    /// The schedule of `cell_id` — the sensor's cell, or the one it left on
    /// its last move.
    #[account(
        mut,
        seeds = [REWARDS_SEED, cell_id.to_le_bytes().as_ref()],
        bump = rewards.load()?.bump,
    )]
    pub rewards: AccountLoader<'info, CellRewards>,

    #[account(address = pool.asset_mint)]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// Rewards sit in the capital vault beside capital, told apart by the
    /// books (`FR-061`).
    #[account(mut, address = pool.vault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// A token account the sensor's operator holds the authority over.
    #[account(
        mut,
        token::mint = asset_mint,
        token::authority = sensor.operator,
    )]
    pub operator_tokens: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Sends what a sensor earned in `cell_id` to its operator — `FR-036`: in
/// its own cell, or in the one it left on its last move (`FR-059`).
///
/// An excluded sensor claims nothing: what it had not claimed went to capital
/// with its stake, and until it is reinstated nothing new can be earned.
pub fn claim_reward(ctx: Context<ClaimReward>, cell_id: u64) -> Result<()> {
    let sensor = &ctx.accounts.sensor;
    require!(sensor.active, PumpkingError::SensorExcluded);
    let slot = sensor
        .slot_in(cell_id)
        .ok_or(PumpkingError::NotTheSensorsCell)?;
    let amount = ctx
        .accounts
        .rewards
        .load()?
        .accrued
        .get(usize::from(slot))
        .copied()
        .unwrap_or(0);
    require!(amount > 0, PumpkingError::NothingToClaim);

    let pool_bump = ctx.accounts.pool.bump;
    let seeds: &[&[u8]] = &[POOL_SEED, &[pool_bump]];
    // Money first, accounting second.
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                to: ctx.accounts.operator_tokens.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.asset_mint.decimals,
    )?;

    ctx.accounts
        .rewards
        .load_mut()?
        .take_accrued(slot)
        .map_err(rewards_error)?;

    emit!(RewardClaimed {
        sensor_key: sensor.sensor_key,
        operator: sensor.operator,
        cell_id,
        amount,
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

    const SLOTS: usize = MAX_SENSORS_PER_CELL as usize;

    /// Three slots judged in 24 intervals; slot 2 an outlier in all of them.
    fn verdicts() -> ([u16; SLOTS], [u16; SLOTS]) {
        let mut judged = [0u16; SLOTS];
        let mut outliers = [0u16; SLOTS];
        judged[..3].copy_from_slice(&[24, 24, 24]);
        outliers[2] = 24;
        (judged, outliers)
    }

    fn weights(pairs: &[(usize, u32)]) -> [u32; SLOTS] {
        let mut out = [0u32; SLOTS];
        for &(slot, w) in pairs {
            out[slot] = w;
        }
        out
    }

    #[test]
    fn accepts_weights_on_slots_that_voted_and_were_accepted() {
        let (judged, outliers) = verdicts();
        let unit = REWARD_WEIGHT_UNIT;
        let w = weights(&[(0, 12 * unit), (1, 12 * unit)]);
        let wide = check_day_weights(&w, &judged, &outliers, 0b111).unwrap();
        assert_eq!(wide[0], u64::from(12 * unit));
        assert_eq!(wide[2], 0);
    }

    #[test]
    fn refuses_a_weight_for_a_slot_that_was_only_ever_an_outlier() {
        let (judged, outliers) = verdicts();
        let w = weights(&[(2, 1)]);
        assert_eq!(
            code_of(check_day_weights(&w, &judged, &outliers, 0b111).unwrap_err()),
            code(PumpkingError::WeightWithoutAcceptedInterval)
        );
    }

    #[test]
    fn refuses_a_weight_for_a_slot_that_did_not_vote() {
        let (judged, outliers) = verdicts();
        let w = weights(&[(1, 1)]);
        assert_eq!(
            code_of(check_day_weights(&w, &judged, &outliers, 0b101).unwrap_err()),
            code(PumpkingError::WeightWithoutAcceptedInterval)
        );
    }

    #[test]
    fn refuses_a_weight_its_accepted_intervals_cannot_carry() {
        let (judged, outliers) = verdicts();
        let w = weights(&[(0, 24 * REWARD_WEIGHT_UNIT + 1)]);
        assert_eq!(
            code_of(check_day_weights(&w, &judged, &outliers, 0b111).unwrap_err()),
            code(PumpkingError::WeightTooLarge)
        );
    }
}
