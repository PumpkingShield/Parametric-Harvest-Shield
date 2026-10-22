//! A cell under investigation — `FR-045`.
//!
//! **The one lever the reference has, and it only reaches forwards.** A cell
//! that keeps calling days dry while the public reference measured rain stops
//! selling cover; every policy already sold on it is still settled from the
//! sensors' median to the end of its window (`FR-043`, `FR-030`). Nothing here
//! touches `day_log`, a policy or the vault.
//!
//! **One-sided on purpose.** Only "the cell said dry, the reference measured
//! rain" counts, because that is the only direction a faked day pays in. The
//! other direction is three times as common among honest cells (model drizzle,
//! a storm the grid moved) and costs the pool nothing.
//!
//! **What the chain checks and what it takes on trust.** The reference never
//! reaches the chain, so whether it measured rain is the aggregator's word —
//! auditable off chain against the hours the worker keeps. The chain checks
//! the half it can: that enough days are named, inside one coverage window,
//! and that the cell's own log holds each of them as dry. An aggregator cannot
//! open an investigation on a cell that never claimed a drought.
//!
//! **Who.** The aggregator opens it, as soon as the rule fires — it already
//! writes the log every payout is read from, and stopping sales is less power
//! than that. Only the pool authority closes it: closing is a judgement, and a
//! rule that closed itself after the window would let a cell wait ninety days
//! and do it again.

use anchor_lang::prelude::*;

use crate::errors::PumpkingError;
use crate::index::DayState;
use crate::state::{
    CellState, Pool, CELL_SEED, INVESTIGATION_DISPUTED_DAYS, INVESTIGATION_WINDOW_DAYS, POOL_SEED,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OpenInvestigationParams {
    pub cell_id: u64,
    /// The days the cell recorded dry and the reference disputed, oldest
    /// first, at least `INVESTIGATION_DISPUTED_DAYS` of them.
    pub disputed_days: Vec<u32>,
}

/// Emitted with the evidence: the trace and the methodology page name the
/// days, and anyone can hold them up against the reference.
#[event]
pub struct InvestigationOpened {
    pub cell_id: u64,
    pub day_index: u32,
    pub disputed_days: Vec<u32>,
}

#[event]
pub struct InvestigationClosed {
    pub cell_id: u64,
    pub day_index: u32,
}

/// The chain's half of the rule — see the module notes.
pub fn check_disputed_days(days: &[u32], cell: &CellState, today: u32) -> Result<()> {
    require!(
        days.len() as u64 >= u64::from(INVESTIGATION_DISPUTED_DAYS),
        PumpkingError::NotEnoughDisputedDays
    );
    require!(
        days.windows(2).all(|pair| pair[0] < pair[1]),
        PumpkingError::DisputedDaysNotOrdered
    );
    for &day in days {
        require!(
            day < today && today - day <= INVESTIGATION_WINDOW_DAYS,
            PumpkingError::DisputedDayOutsideWindow
        );
        require!(
            cell.day_state(day) == Some(DayState::Dry),
            PumpkingError::DisputedDayNotDry
        );
    }
    Ok(())
}

#[derive(Accounts)]
#[instruction(params: OpenInvestigationParams)]
pub struct OpenInvestigation<'info> {
    #[account(address = pool.aggregator @ PumpkingError::NotTheAggregator)]
    pub aggregator: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    // Boxed: `CellState` does not fit the `try_accounts` frame.
    #[account(
        mut,
        seeds = [CELL_SEED, params.cell_id.to_le_bytes().as_ref()],
        bump = cell.bump,
    )]
    pub cell: Box<Account<'info, CellState>>,
}

pub fn open_investigation(
    ctx: Context<OpenInvestigation>,
    params: OpenInvestigationParams,
) -> Result<()> {
    let today = ctx
        .accounts
        .pool
        .day_index(Clock::get()?.unix_timestamp)
        .ok_or(PumpkingError::DayIndexUnavailable)?;
    let cell = &mut ctx.accounts.cell;
    require!(
        !cell.under_investigation,
        PumpkingError::CellAlreadyUnderInvestigation
    );
    check_disputed_days(&params.disputed_days, cell, today)?;

    cell.under_investigation = true;
    emit!(InvestigationOpened {
        cell_id: params.cell_id,
        day_index: today,
        disputed_days: params.disputed_days,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(cell_id: u64)]
pub struct CloseInvestigation<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = authority)]
    pub pool: Account<'info, Pool>,

    // Boxed: `CellState` does not fit the `try_accounts` frame.
    #[account(
        mut,
        seeds = [CELL_SEED, cell_id.to_le_bytes().as_ref()],
        bump = cell.bump,
    )]
    pub cell: Box<Account<'info, CellState>>,
}

pub fn close_investigation(ctx: Context<CloseInvestigation>, cell_id: u64) -> Result<()> {
    let today = ctx
        .accounts
        .pool
        .day_index(Clock::get()?.unix_timestamp)
        .ok_or(PumpkingError::DayIndexUnavailable)?;
    let cell = &mut ctx.accounts.cell;
    require!(
        cell.under_investigation,
        PumpkingError::CellNotUnderInvestigation
    );

    cell.under_investigation = false;
    emit!(InvestigationClosed {
        cell_id,
        day_index: today,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::DAY_LOG_LEN;
    use anchor_lang::error::Error;

    fn code_of(err: Error) -> u32 {
        match err {
            Error::AnchorError(inner) => inner.error_code_number,
            other => panic!("expected an anchor error, got {other:?}"),
        }
    }

    /// A cell whose log holds `states` from day 0 on.
    fn cell_of(states: &[DayState]) -> CellState {
        let mut cell = CellState {
            cell_id: 0x871e701b3ffffff,
            sensor_count: 0,
            under_investigation: false,
            reserved: 0,
            rewards_reserve: 0,
            first_day_index: 0,
            last_day_index: None,
            day_log: [0; DAY_LOG_LEN],
            contributors: [0; DAY_LOG_LEN],
            bump: 255,
        };
        for (day, state) in states.iter().enumerate() {
            cell.record_day(day as u32, *state, 0b111).unwrap();
        }
        cell
    }

    fn refused(days: &[u32], cell: &CellState, today: u32) -> u32 {
        code_of(check_disputed_days(days, cell, today).unwrap_err())
    }

    use DayState::{Dry, NoCoverage, Wet};

    #[test]
    fn three_dry_days_inside_the_window_open_an_investigation() {
        let cell = cell_of(&[Dry, Wet, Dry, Wet, Dry]);
        check_disputed_days(&[0, 2, 4], &cell, 5).unwrap();
    }

    #[test]
    fn the_investigation_window_is_one_coverage_window() {
        assert_eq!(INVESTIGATION_WINDOW_DAYS, crate::state::MAX_COVERAGE_DAYS);
    }

    #[test]
    fn fewer_days_than_published_are_refused() {
        let cell = cell_of(&[Dry, Dry, Dry]);
        assert_eq!(
            refused(&[0, 1], &cell, 3),
            u32::from(PumpkingError::NotEnoughDisputedDays)
        );
    }

    #[test]
    fn a_day_named_twice_counts_once_and_is_refused() {
        let cell = cell_of(&[Dry, Dry, Dry]);
        for days in [[0, 0, 1], [2, 1, 0]] {
            assert_eq!(
                refused(&days, &cell, 3),
                u32::from(PumpkingError::DisputedDaysNotOrdered)
            );
        }
    }

    #[test]
    fn only_a_day_the_cell_called_dry_can_be_disputed() {
        // The one-sided rule: wet, silent and unrecorded days are no claim of
        // drought, so naming them is naming nothing.
        let cell = cell_of(&[Dry, Wet, Dry, NoCoverage, Dry]);
        for wrong in [1, 3] {
            let mut days = vec![0, 2, 4];
            days.push(wrong);
            days.sort_unstable();
            assert_eq!(
                refused(&days, &cell, 5),
                u32::from(PumpkingError::DisputedDayNotDry)
            );
        }
    }

    #[test]
    fn the_window_is_one_coverage_window_back_from_today() {
        let mut states = vec![Wet; 100];
        for day in [5, 9, 50] {
            states[day] = Dry;
        }
        let cell = cell_of(&states);
        // Today 95: day 5 is exactly ninety days back, still inside.
        check_disputed_days(&[5, 9, 50], &cell, 95).unwrap();
        // Today 96: day 5 has fallen out.
        assert_eq!(
            refused(&[5, 9, 50], &cell, 96),
            u32::from(PumpkingError::DisputedDayOutsideWindow)
        );
        // And a day that is not over yet is not evidence of anything.
        assert_eq!(
            refused(&[5, 9, 95], &cell, 95),
            u32::from(PumpkingError::DisputedDayOutsideWindow)
        );
    }
}
