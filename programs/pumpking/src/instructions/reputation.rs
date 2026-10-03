use anchor_lang::prelude::*;

use crate::errors::PumpkingError;
use crate::instructions::rewards::{check_day_weights, pay_cell_day};
use crate::state::{
    CellReputation, CellRewards, CellState, Pool, ReputationError, CELL_SEED, MAX_SENSORS_PER_CELL,
    POOL_SEED, REPUTATION_SEED, REWARDS_SEED,
};

/// One day of a cell's verdicts, written by the aggregator — `FR-011`.
///
/// It travels in the same transaction as `submit_day_record`, after it, and is
/// accepted only for the day the cell recorded last: the two halves of a day
/// land together or not at all, and reputation can never be written for a day
/// the log does not have. Like the day log it only grows forwards, so what a
/// sensor's record says on a given day is fixed that day — an exclusion later
/// is judged on numbers that were public before anybody's stake was at stake.
///
/// What the program checks is shape, not truth: a slot the cell has, and no
/// more outliers than judgements. Which intervals were outliers is the
/// aggregator's arithmetic over readings the chain never sees, made public as
/// `sensor_verdicts` and reproducible from the readings by anyone.
///
/// The same instruction pays the day's reward budget (`FR-062`) by `weights`,
/// or returns it to capital when nobody earned it (`FR-064`). It is sent for
/// every day the cell writes, a day without coverage included, so that every
/// day's budget is settled the day it ends.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DayReputationParams {
    pub cell_id: u64,
    pub day_index: u32,
    /// Intervals each sensor slot was judged in.
    pub judged: [u16; MAX_SENSORS_PER_CELL as usize],
    /// Of those, the ones the slot was an outlier in.
    pub outliers: [u16; MAX_SENSORS_PER_CELL as usize],
    /// Each slot's share of the day's rewards, in `REWARD_WEIGHT_UNIT` per
    /// interval — see `instructions::rewards`. All zero on a day nobody
    /// earned.
    pub weights: [u32; MAX_SENSORS_PER_CELL as usize],
}

#[event]
pub struct DayReputationRecorded {
    pub cell_id: u64,
    pub day_index: u32,
    pub judged: [u16; MAX_SENSORS_PER_CELL as usize],
    pub outliers: [u16; MAX_SENSORS_PER_CELL as usize],
}

/// Whether a day's verdicts describe sensors the cell could have.
pub fn check_day_reputation(params: &DayReputationParams, cell: &CellState) -> Result<()> {
    require!(
        cell.last_day_index == Some(params.day_index),
        PumpkingError::ReputationDayMismatch
    );
    for slot in 0..MAX_SENSORS_PER_CELL as usize {
        let judged = params.judged[slot];
        let outliers = params.outliers[slot];
        require!(outliers <= judged, PumpkingError::OutliersExceedJudged);
        if slot >= usize::from(cell.sensor_count) {
            require!(judged == 0, PumpkingError::ReputationOutOfRange);
        }
    }
    Ok(())
}

#[derive(Accounts)]
#[instruction(params: DayReputationParams)]
pub struct SubmitDayReputation<'info> {
    /// The same single role that writes the day log — `FR-015`.
    #[account(mut, address = pool.aggregator @ PumpkingError::NotTheAggregator)]
    pub aggregator: Signer<'info>,

    /// Mutable for the budget a day returns to capital — `FR-064`.
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    // Boxed: the day log and the ring together overrun the 4 KiB frame
    // `try_accounts` is given, as the cell alone does beside a policy.
    // Mutable only for the day the schedule opens and takes the legacy reserve.
    #[account(
        mut,
        seeds = [CELL_SEED, params.cell_id.to_le_bytes().as_ref()],
        bump = cell.bump,
    )]
    pub cell: Box<Account<'info, CellState>>,

    #[account(
        init_if_needed,
        payer = aggregator,
        space = 8 + CellReputation::SPACE,
        seeds = [REPUTATION_SEED, params.cell_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub reputation: AccountLoader<'info, CellReputation>,

    /// Opened here, by the aggregator, the first day it writes for the cell
    /// after `T036`; `issue_policy` only requires it.
    #[account(
        init_if_needed,
        payer = aggregator,
        space = 8 + CellRewards::SPACE,
        seeds = [REWARDS_SEED, params.cell_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub rewards: AccountLoader<'info, CellRewards>,

    pub system_program: Program<'info, System>,
}

/// Writes one day of a cell's reputation — `FR-011`.
pub fn submit_day_reputation(
    ctx: Context<SubmitDayReputation>,
    params: DayReputationParams,
) -> Result<()> {
    check_day_reputation(&params, &ctx.accounts.cell)?;
    // `check_day_reputation` has pinned the day to the cell's last one.
    let contributors = ctx
        .accounts
        .cell
        .contributors_of(params.day_index)
        .unwrap_or(0);
    let weights = check_day_weights(
        &params.weights,
        &params.judged,
        &params.outliers,
        contributors,
    )?;

    // A loader opened by `init_if_needed` this instruction has no
    // discriminator yet and only `load_init` takes it; one that existed only
    // `load_mut` does.
    let loader = &ctx.accounts.reputation;
    let mut reputation = match loader.load_mut() {
        Ok(existing) => existing,
        Err(_) => loader.load_init()?,
    };
    // Written every time, as `submit_day_record` writes the cell's: a freshly
    // opened account is all zeroes.
    reputation.cell_id = params.cell_id;
    reputation.bump = ctx.bumps.reputation;
    reputation
        .record_day(params.day_index, params.judged, params.outliers)
        .map_err(|err| match err {
            ReputationError::NotNewer => error!(PumpkingError::ReputationDayNotNewer),
        })?;

    emit!(DayReputationRecorded {
        cell_id: params.cell_id,
        day_index: params.day_index,
        judged: params.judged,
        outliers: params.outliers,
    });
    drop(reputation);

    let loader = &ctx.accounts.rewards;
    let (mut rewards, fresh) = match loader.load_mut() {
        Ok(existing) => (existing, false),
        Err(_) => (loader.load_init()?, true),
    };
    pay_cell_day(
        &mut ctx.accounts.pool,
        &mut ctx.accounts.cell,
        &mut rewards,
        fresh,
        ctx.bumps.rewards,
        params.day_index,
        &weights,
    )
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

    fn code(err: PumpkingError) -> u32 {
        code_of(error!(err))
    }

    fn cell(sensor_count: u8, last_day: Option<u32>) -> CellState {
        let mut cell = CellState {
            cell_id: 1,
            sensor_count,
            reserved: 0,
            rewards_reserve: 0,
            under_investigation: false,
            first_day_index: 0,
            last_day_index: None,
            day_log: [0; DAY_LOG_LEN],
            contributors: [0; DAY_LOG_LEN],
            bump: 255,
        };
        if let Some(day) = last_day {
            cell.record_day(day, DayState::Wet, 0b111).unwrap();
        }
        cell
    }

    fn params(day_index: u32) -> DayReputationParams {
        let mut judged = [0u16; MAX_SENSORS_PER_CELL as usize];
        let mut outliers = [0u16; MAX_SENSORS_PER_CELL as usize];
        judged[..3].copy_from_slice(&[24, 24, 24]);
        outliers[2] = 9;
        DayReputationParams {
            cell_id: 1,
            day_index,
            judged,
            outliers,
            weights: [0; MAX_SENSORS_PER_CELL as usize],
        }
    }

    #[test]
    fn accepts_the_day_the_cell_recorded_last() {
        assert!(check_day_reputation(&params(5), &cell(3, Some(5))).is_ok());
    }

    #[test]
    fn refuses_a_day_the_log_does_not_have_or_has_moved_past() {
        for (last, day) in [(None, 5), (Some(4), 5), (Some(6), 5)] {
            assert_eq!(
                code_of(check_day_reputation(&params(day), &cell(3, last)).unwrap_err()),
                code(PumpkingError::ReputationDayMismatch)
            );
        }
    }

    #[test]
    fn refuses_more_outliers_than_judgements() {
        let mut p = params(5);
        p.outliers[0] = 25;
        assert_eq!(
            code_of(check_day_reputation(&p, &cell(3, Some(5))).unwrap_err()),
            code(PumpkingError::OutliersExceedJudged)
        );
    }

    #[test]
    fn refuses_a_judgement_for_a_slot_the_cell_has_not() {
        let mut p = params(5);
        p.judged[3] = 1;
        assert_eq!(
            code_of(check_day_reputation(&p, &cell(3, Some(5))).unwrap_err()),
            code(PumpkingError::ReputationOutOfRange)
        );
    }
}
