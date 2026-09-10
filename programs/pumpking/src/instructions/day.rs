use anchor_lang::prelude::*;

use crate::errors::PumpkingError;
use crate::index::DayState;
use crate::state::{CellState, DayLogError, Pool, CELL_SEED, MAX_SENSORS_PER_CELL, POOL_SEED};

/// One day of one cell, written by the aggregator — `FR-015`.
///
/// This is the only door the day log has. Everything downstream reads it and
/// nothing else: `price_of` counts dry days in it, `dry_spell` finds the run
/// in it, and `settle_policy` owes money because of what it says. So the
/// questions worth asking are asked here, once, on the way in.
///
/// **What the chain checks and what it takes on trust.** The classification
/// arrives already made — the aggregator collected the intervals, took the
/// median of each (`FR-008`, `FR-010`) and summed the day — because the
/// intervals themselves never reach the chain. But the pool publishes the dry
/// threshold, so the chain re-derives dry from wet itself rather than
/// believing the label: mislabelling a wet day as dry is the cheapest way to
/// fabricate a payout, and it is the one thing here the chain already knows
/// enough to refuse.
///
/// The share of intervals a day needs to count as measured (`FR-048`) stays
/// the aggregator's call, because that parameter lives in the registry rather
/// than in the pool. The asymmetry is deliberate and it leans one way: a day
/// wrongly called uncovered denies cover, which `FR-047` is already
/// conservative about, while a day wrongly called dry pays money out.
///
/// What makes the rest auditable is `readings_root`: the Merkle root of the
/// cell values the day was summed from, emitted with the record. `FR-037` and
/// `SC-010` are that root plus the API that serves the leaves — a stranger
/// redoes the arithmetic and proves any one value belongs to the day.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DayRecordParams {
    pub cell_id: u64,
    /// Day index, on the pool's clock — `FR-049`.
    pub day_index: u32,
    /// `DayState` as the log stores it: 0 none, 1 dry, 2 wet.
    pub state: u8,
    /// Bit per sensor slot whose readings entered the day's medians.
    pub contributors: u32,
    /// Merkle root of the cell values this day was summed from — `FR-037`.
    pub readings_root: [u8; 32],
    /// Sum of the covered intervals, `None` when the day has no value. Not
    /// zero: zero is a real, dry reading of the sky, and silence is not.
    pub rainfall_x100: Option<i32>,
    /// Intervals that carried a value, and intervals the day had at all.
    /// Shown in the trace, because a day measured from half its hours is a
    /// different claim than one measured from all of them — `FR-048`.
    pub covered_intervals: u16,
    pub total_intervals: u16,
}

/// What a recorded day says, for anyone reconstructing the trace — `FR-016`,
/// `FR-037`.
///
/// An event rather than an account: 32 bytes of root per day per cell would be
/// four kilobytes of rent on every cell to hold what the transaction log
/// already keeps, and the trace is read off-chain by definition.
#[event]
pub struct DayRecorded {
    pub cell_id: u64,
    pub day_index: u32,
    pub state: u8,
    pub contributors: u32,
    pub readings_root: [u8; 32],
    pub rainfall_x100: Option<i32>,
    pub covered_intervals: u16,
    pub total_intervals: u16,
}

/// Whether the counts describe a day that was measured at all.
fn check_coverage(params: &DayRecordParams, state: DayState) -> Result<()> {
    require!(params.total_intervals > 0, PumpkingError::DayHasNoIntervals);
    require!(
        params.covered_intervals <= params.total_intervals,
        PumpkingError::CoverageCountsDisagree
    );

    match state {
        // FR-010: a day with no covered interval cannot have a value, and a
        // day with a value cannot have come from nothing.
        DayState::NoCoverage => require!(
            params.rainfall_x100.is_none(),
            PumpkingError::UncoveredDayHasRainfall
        ),
        _ => {
            require!(params.covered_intervals > 0, PumpkingError::DayHasNoCoverage);
            require!(
                params.rainfall_x100.is_some(),
                PumpkingError::MeasuredDayHasNoRainfall
            );
        }
    }
    Ok(())
}

/// Whether the mask of contributing sensors is one the cell could have
/// produced, and whether it is large enough for the day to have a value.
fn check_contributors(params: &DayRecordParams, pool: &Pool, state: DayState) -> Result<()> {
    // Bits above the cell's capacity address no sensor. A mask carrying one is
    // a mask from somewhere else, and `claim_reward` would pay against it.
    let addressable = if MAX_SENSORS_PER_CELL >= 32 {
        u32::MAX
    } else {
        (1u32 << MAX_SENSORS_PER_CELL) - 1
    };
    require!(
        params.contributors & !addressable == 0,
        PumpkingError::ContributorsOutOfRange
    );

    let voters = params.contributors.count_ones();
    match state {
        // A day the network failed to measure earns nobody anything. The mask
        // is what `claim_reward` pays against, so it records who was paid for
        // and not who was switched on; `FR-064` returns the reserve those days
        // did not spend to capital.
        DayState::NoCoverage => require!(
            params.contributors == 0,
            PumpkingError::UncoveredDayHasContributors
        ),
        // FR-010: below the minimum the interval has no value, so neither has
        // the day built out of it.
        _ => require!(
            voters >= u32::from(pool.min_sensors_per_cell),
            PumpkingError::TooFewContributors
        ),
    }
    Ok(())
}

/// Whether the label agrees with the number it claims to come from — `FR-047`.
///
/// The comparison is inclusive, and deliberately so: under a strict one a
/// threshold of zero — "a dry day is one with no rain at all" — would call a
/// day that measured nothing wet, and every published threshold would quietly
/// mean one hundredth less than the page says. The twin in
/// `packages/shared/src/day.ts` reads the same way.
fn check_classification(params: &DayRecordParams, pool: &Pool, state: DayState) -> Result<()> {
    let Some(rainfall) = params.rainfall_x100 else {
        return Ok(());
    };
    // Rainfall is signed only because the column is; a negative sum is not a
    // measurement of anything.
    require!(rainfall >= 0, PumpkingError::RainfallNegative);

    let dry = i64::from(rainfall) <= i64::from(pool.dry_day_threshold_mm_x100);
    let expected = if dry { DayState::Dry } else { DayState::Wet };
    require!(state == expected, PumpkingError::DayStateContradictsRainfall);
    Ok(())
}

/// Every question the day record has to answer, as one pure function.
pub fn check_day_record(params: &DayRecordParams, pool: &Pool, today: u32) -> Result<DayState> {
    let state = DayState::from_u8(params.state).ok_or(PumpkingError::UnknownDayState)?;

    // A day that has not finished cannot be summed, and the log is
    // append-only, so a day written early is a day nobody can correct.
    require!(params.day_index < today, PumpkingError::DayNotOver);

    check_coverage(params, state)?;
    check_contributors(params, pool, state)?;
    check_classification(params, pool, state)?;
    Ok(state)
}

#[derive(Accounts)]
#[instruction(params: DayRecordParams)]
pub struct SubmitDayRecord<'info> {
    /// `FR-015`: the aggregator is the only role that may write a day, and it
    /// cannot spend. The constraint is on the key rather than on a list, so
    /// there is exactly one of it and rotating it is a pool parameter change.
    #[account(mut, address = pool.aggregator @ PumpkingError::NotTheAggregator)]
    pub aggregator: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    /// Opened by the first day the network publishes for this cell. A cell is
    /// exactly "somewhere readings come from", so there is nothing to register
    /// before the readings arrive — and only the aggregator reaches this
    /// instruction, so `init_if_needed` opens nothing a stranger could.
    #[account(
        init_if_needed,
        payer = aggregator,
        space = 8 + CellState::INIT_SPACE,
        seeds = [CELL_SEED, params.cell_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub cell: Account<'info, CellState>,

    pub system_program: Program<'info, System>,
}

/// Writes one day of a cell — `FR-015`, and `FR-016` through the event.
pub fn submit_day_record(ctx: Context<SubmitDayRecord>, params: DayRecordParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let today = ctx
        .accounts
        .pool
        .day_index(now)
        .ok_or(PumpkingError::DayIndexUnavailable)?;

    let state = check_day_record(&params, &ctx.accounts.pool, today)?;

    let cell = &mut ctx.accounts.cell;
    // Written every time, not only on the first: a freshly opened account is
    // all zeroes, and a cell whose id stayed zero is a cell `price_of` reads
    // and nobody can name.
    cell.cell_id = params.cell_id;
    cell.bump = ctx.bumps.cell;

    cell.record_day(params.day_index, state, params.contributors)
        .map_err(|err| match err {
            DayLogError::NotNewer => error!(PumpkingError::DayNotNewer),
        })?;

    emit!(DayRecorded {
        cell_id: params.cell_id,
        day_index: params.day_index,
        state: state as u8,
        contributors: params.contributors,
        readings_root: params.readings_root,
        rainfall_x100: params.rainfall_x100,
        covered_intervals: params.covered_intervals,
        total_intervals: params.total_intervals,
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

    /// A pool as `initialize_pool` leaves it: three votes for a value, a dry
    /// day being one that measured a millimetre or less.
    fn pool() -> Pool {
        Pool {
            authority: Pubkey::new_unique(),
            aggregator: Pubkey::new_unique(),
            asset_mint: Pubkey::new_unique(),
            vault: Pubkey::new_unique(),
            stake_vault: Pubkey::new_unique(),
            capital_total: 1_000_000,
            reserved_total: 0,
            shares_total: 1_000_000,
            cell_exposure_bps: 1_000,
            premium_rewards_bps: 1_000,
            risk_loading_bps: 2_500,
            min_rate_bps: 100,
            min_sensors_per_cell: 3,
            min_stake: 1_000,
            unstake_delay_days: 30,
            waiting_period_days: 3,
            dry_day_threshold_mm_x100: 100,
            seconds_per_day: 86_400,
            genesis_ts: 0,
            bump: 254,
        }
    }

    /// Yesterday, dry: twenty-four intervals all covered, three sensors, half
    /// a millimetre of rain.
    fn params() -> DayRecordParams {
        DayRecordParams {
            cell_id: 0x871e701b3ffffff,
            day_index: 9,
            state: DayState::Dry as u8,
            contributors: 0b111,
            readings_root: [7u8; 32],
            rainfall_x100: Some(50),
            covered_intervals: 24,
            total_intervals: 24,
        }
    }

    /// Today is day 10, so `params()` describes a day that is over.
    fn check(p: &DayRecordParams) -> Result<DayState> {
        check_day_record(p, &pool(), 10)
    }

    #[test]
    fn a_well_formed_dry_day_is_recorded() {
        assert_eq!(check(&params()).unwrap(), DayState::Dry);
    }

    #[test]
    fn a_classification_the_log_cannot_hold_is_refused() {
        let mut p = params();
        p.state = 3;
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::UnknownDayState)
        );
    }

    /* ------------------------------------------------------------------- */
    /* FR-047: the chain re-derives dry from the number, not from the label */
    /* ------------------------------------------------------------------- */

    #[test]
    fn a_wet_day_cannot_be_written_down_as_dry() {
        // The cheapest way to fabricate a payout, and the one the chain knows
        // enough to refuse: the threshold is a published pool parameter.
        let mut p = params();
        p.rainfall_x100 = Some(5_000);
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::DayStateContradictsRainfall)
        );

        p.state = DayState::Wet as u8;
        assert_eq!(check(&p).unwrap(), DayState::Wet);
    }

    #[test]
    fn a_dry_day_cannot_be_written_down_as_wet_either() {
        // The same rule the other way. A cell hidden from the index is a
        // policy that never pays, which is the mirror of a fabricated event.
        let mut p = params();
        p.state = DayState::Wet as u8;
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::DayStateContradictsRainfall)
        );
    }

    #[test]
    fn a_day_exactly_at_the_threshold_is_dry() {
        // Inclusive on purpose — `FR-047` and the twin in `day.ts` agree, and
        // a strict comparison would make every published threshold mean one
        // hundredth less than the methodology page says.
        let mut p = params();
        p.rainfall_x100 = Some(100);
        assert_eq!(check(&p).unwrap(), DayState::Dry);

        p.rainfall_x100 = Some(101);
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::DayStateContradictsRainfall)
        );
    }

    #[test]
    fn rain_that_fell_upwards_is_not_a_measurement() {
        let mut p = params();
        p.rainfall_x100 = Some(-1);
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::RainfallNegative)
        );
    }

    /* ------------------------------------------------------------------- */
    /* FR-010: a value needs votes, and no value means no value             */
    /* ------------------------------------------------------------------- */

    #[test]
    fn a_day_with_too_few_votes_cannot_have_a_value() {
        let mut p = params();
        p.contributors = 0b11;
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::TooFewContributors)
        );
    }

    #[test]
    fn a_day_without_coverage_carries_no_number_and_no_contributors() {
        let mut p = params();
        p.state = DayState::NoCoverage as u8;
        p.rainfall_x100 = None;
        p.covered_intervals = 0;
        p.contributors = 0;
        assert_eq!(check(&p).unwrap(), DayState::NoCoverage);

        // Silence is not a dry sky, and it is not a zero either.
        let mut with_rain = p.clone();
        with_rain.rainfall_x100 = Some(0);
        assert_eq!(
            code_of(check(&with_rain).unwrap_err()),
            u32::from(PumpkingError::UncoveredDayHasRainfall)
        );

        // And it earns nobody anything: the mask records who was paid for,
        // not who was switched on. `FR-064` returns what such days did not
        // spend to capital.
        let mut with_voters = p.clone();
        with_voters.contributors = 0b111;
        assert_eq!(
            code_of(check(&with_voters).unwrap_err()),
            u32::from(PumpkingError::UncoveredDayHasContributors)
        );
    }

    #[test]
    fn a_measured_day_must_say_what_it_measured() {
        let mut p = params();
        p.rainfall_x100 = None;
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::MeasuredDayHasNoRainfall)
        );
    }

    #[test]
    fn a_measured_day_must_have_had_a_covered_interval() {
        let mut p = params();
        p.covered_intervals = 0;
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::DayHasNoCoverage)
        );
    }

    #[test]
    fn the_coverage_counts_have_to_be_a_pair_of_counts() {
        let mut p = params();
        p.total_intervals = 0;
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::DayHasNoIntervals)
        );

        let mut more_than_all = params();
        more_than_all.covered_intervals = 25;
        assert_eq!(
            code_of(check(&more_than_all).unwrap_err()),
            u32::from(PumpkingError::CoverageCountsDisagree)
        );
    }

    #[test]
    fn every_bit_of_the_mask_addresses_a_slot_the_cell_has() {
        // `MAX_SENSORS_PER_CELL` is 32 and a mask is a u32, so today every bit
        // is addressable and a full mask is legal. The check is what keeps the
        // rule true if the cell ever holds fewer slots than the mask has bits.
        assert_eq!(MAX_SENSORS_PER_CELL, 32);
        let mut p = params();
        p.contributors = u32::MAX;
        assert_eq!(check(&p).unwrap(), DayState::Dry);
    }

    /* ------------------------------------------------------------------- */
    /* The log only grows forwards                                         */
    /* ------------------------------------------------------------------- */

    #[test]
    fn a_day_that_is_not_over_cannot_be_summed() {
        let mut p = params();
        p.day_index = 10;
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::DayNotOver)
        );

        // Nor one that has not begun. The log is append-only, so a day
        // written early is a day nobody can correct.
        p.day_index = 11;
        assert_eq!(
            code_of(check(&p).unwrap_err()),
            u32::from(PumpkingError::DayNotOver)
        );
    }

    #[test]
    fn a_day_already_recorded_cannot_be_rewritten() {
        // The refusal belongs to the log itself; this is the mapping of it
        // onto an error a caller can read, and the proof that the first
        // record stands.
        let mut cell = CellState {
            cell_id: 0x871e701b3ffffff,
            sensor_count: 3,
            under_investigation: false,
            reserved: 0,
            rewards_reserve: 0,
            first_day_index: 0,
            last_day_index: None,
            day_log: [0u8; DAY_LOG_LEN],
            contributors: [0u32; DAY_LOG_LEN],
            bump: 254,
        };
        cell.record_day(9, DayState::Dry, 0b111).unwrap();
        assert_eq!(
            cell.record_day(9, DayState::Wet, 0b111),
            Err(DayLogError::NotNewer)
        );
        assert_eq!(cell.day_state(9), Some(DayState::Dry));
    }
}
