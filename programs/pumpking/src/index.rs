use crate::state::CellState;

/// Classification of one day of a cell, as written into the on-chain day log.
///
/// A day without coverage is not "not dry" — it is unknown, and unknown breaks
/// a run. Treating silence as drought would let anyone manufacture an event by
/// switching their sensors off.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DayState {
    NoCoverage = 0,
    Dry = 1,
    Wet = 2,
}

impl DayState {
    pub fn from_u8(raw: u8) -> Option<Self> {
        match raw {
            0 => Some(DayState::NoCoverage),
            1 => Some(DayState::Dry),
            2 => Some(DayState::Wet),
            _ => None,
        }
    }
}

/// One day of the run, as both readers of the log see it: the current run and
/// the longest one so far, after being shown a day.
///
/// A single place where "what breaks a run" is decided. Anything that is not a
/// dry day breaks it — a wet day, a day the network did not cover, a day the
/// log cannot answer for, and a classification the log does not know. That
/// last one is not defensive noise: a byte the enum has no name for is a log
/// this program did not write, and counting it as dry would pay against it.
#[inline]
fn step(run: u32, best: u32, day: Option<DayState>) -> (u32, u32) {
    if day == Some(DayState::Dry) {
        let run = run.saturating_add(1);
        (run, if run > best { run } else { best })
    } else {
        (0, best)
    }
}

/// Longest unbroken run of dry days in `days`.
///
/// The same function exists in TypeScript for display. Both are driven by
/// `fixtures/index-cases.json`; a divergence of one day is a payout the
/// interface never promised.
pub fn dry_spell(days: &[u8]) -> u32 {
    let mut best: u32 = 0;
    let mut run: u32 = 0;

    for raw in days {
        (run, best) = step(run, best, DayState::from_u8(*raw));
    }

    best
}

/// What a cell's log says about one policy's coverage window — `FR-014`.
pub struct WindowSpell {
    /// Longest run of consecutive dry days inside the window. This is the
    /// index `FR-046` compares against the policy's threshold.
    pub longest: u32,
    /// Whether the log answered for **every** day of the window.
    ///
    /// The two readers need different halves of this. Settlement does not:
    /// once the run reaches the threshold the event has happened and the rest
    /// of the window cannot unhappen it, which is what lets `SC-001` pay
    /// within a minute of the day closing rather than at the end of the
    /// season. Closing a policy without an event needs exactly this: a window
    /// with a day still unanswered has not finished disappointing anyone.
    pub complete: bool,
}

/// Reads one policy's window out of the cell's day log — `FR-014`, `FR-046`.
///
/// The window is a range of day indices and the log is a ring, so this is the
/// only place that has to know the log is a ring at all. `dry_spell` above
/// stays the twin of the TypeScript one, which reads days out of Postgres and
/// never sees a ring; the two share `step`, so the rule about what breaks a
/// run is written once.
///
/// A day the log cannot answer for breaks the run and leaves the window
/// incomplete. There are two such days and they are not the same thing —
/// `CellState::day_state` keeps them apart deliberately. A day past the last
/// record has **not happened yet**; a day older than the ring **has fallen out
/// of it**. Neither is evidence of drought, and neither is evidence against
/// it, so both break the run and both say the window is not finished.
///
/// An empty window — one that ends before it starts, which underwriting
/// refuses — is complete and holds no spell: there is nothing left to learn
/// about it.
pub fn spell_in_window(cell: &CellState, start_day: u32, end_day: u32) -> WindowSpell {
    let mut best: u32 = 0;
    let mut run: u32 = 0;
    let mut complete = true;

    let mut day = start_day;
    while day <= end_day {
        let state = cell.day_state(day);
        complete &= state.is_some();
        (run, best) = step(run, best, state);

        // `end_day` can be `u32::MAX` in a test; incrementing past it would
        // wrap and walk the whole range again.
        let Some(next) = day.checked_add(1) else { break };
        day = next;
    }

    WindowSpell {
        longest: best,
        complete,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_the_longest_run_not_the_last() {
        assert_eq!(dry_spell(&[1, 1, 1, 2, 1, 1]), 3);
    }

    #[test]
    fn a_day_without_coverage_breaks_the_run() {
        assert_eq!(dry_spell(&[1, 1, 1, 0, 1, 1]), 3);
    }

    #[test]
    fn an_unknown_classification_breaks_the_run_rather_than_counting() {
        assert_eq!(dry_spell(&[1, 1, 9, 1]), 2);
    }

    #[test]
    fn no_days_is_no_spell() {
        assert_eq!(dry_spell(&[]), 0);
    }

    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        days: Vec<u8>,
        #[serde(rename = "drySpell")]
        dry_spell: u32,
    }

    #[derive(serde::Deserialize)]
    struct Fixtures {
        cases: Vec<Case>,
    }

    /// The TypeScript twin in `packages/shared` runs this exact file. A case
    /// that passes on one side and fails on the other is the divergence this
    /// fixture exists to catch.
    #[test]
    fn agrees_with_the_typescript_twin_on_every_shared_case() {
        let raw = include_str!("../../../fixtures/index-cases.json");
        let fixtures: Fixtures = serde_json::from_str(raw).expect("fixtures parse");
        assert!(!fixtures.cases.is_empty());

        for case in fixtures.cases {
            assert_eq!(dry_spell(&case.days), case.dry_spell, "case: {}", case.name);
        }
    }
    /* --------------------------------------------------------------------- */
    /* FR-014: the window read out of the cell's own log                      */
    /* --------------------------------------------------------------------- */

    use crate::state::DAY_LOG_LEN;

    /// A cell whose log holds `days` starting at `first`, written in order.
    fn cell_with(first: u32, days: &[DayState]) -> CellState {
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
        for (offset, state) in days.iter().enumerate() {
            cell.record_day(first + offset as u32, *state, 0b111)
                .expect("the log grows forwards");
        }
        cell
    }

    #[test]
    fn the_window_holds_the_longest_run_inside_it_and_not_around_it() {
        use DayState::{Dry, Wet};
        // Days 0..9: three dry, a wet, then four dry. The policy covers 0..4,
        // so it gets the three and not the four.
        let cell = cell_with(0, &[Dry, Dry, Dry, Wet, Dry, Dry, Dry, Dry]);
        let inside = spell_in_window(&cell, 0, 4);
        assert_eq!(inside.longest, 3);
        assert!(inside.complete);

        let whole = spell_in_window(&cell, 0, 7);
        assert_eq!(whole.longest, 4);
    }

    #[test]
    fn a_day_the_network_missed_breaks_the_run_inside_a_window() {
        use DayState::{Dry, NoCoverage};
        // FR-047 as the index sees it: silence is not drought, and stitching
        // the run across it would let anyone manufacture the event by
        // switching sensors off.
        let cell = cell_with(0, &[Dry, Dry, NoCoverage, Dry, Dry, Dry]);
        assert_eq!(spell_in_window(&cell, 0, 5).longest, 3);
    }

    #[test]
    fn a_day_that_has_not_happened_leaves_the_window_unfinished() {
        use DayState::Dry;
        // The log stops at day 2 and the policy runs to day 5. The run so far
        // is real — that is what lets settlement pay the moment the threshold
        // is crossed — but the window has not finished, so nothing may be
        // closed as "no event" on the strength of it.
        let cell = cell_with(0, &[Dry, Dry, Dry]);
        let reading = spell_in_window(&cell, 0, 5);
        assert_eq!(reading.longest, 3);
        assert!(!reading.complete);
    }

    #[test]
    fn a_day_older_than_the_ring_leaves_the_window_unfinished_too() {
        use DayState::Dry;
        // 200 days of record in a 128-slot ring: the early days are gone. A
        // policy that covered them cannot be settled off this log, and saying
        // so beats reading the days that replaced them.
        let cell = cell_with(0, &vec![Dry; 200]);
        let reading = spell_in_window(&cell, 0, 10);
        assert_eq!(reading.longest, 0);
        assert!(!reading.complete);

        // The days the ring still holds read normally.
        let recent = spell_in_window(&cell, 190, 199);
        assert_eq!(recent.longest, 10);
        assert!(recent.complete);
    }

    #[test]
    fn a_cell_that_has_recorded_nothing_answers_for_no_day() {
        let cell = cell_with(0, &[]);
        let reading = spell_in_window(&cell, 0, 30);
        assert_eq!(reading.longest, 0);
        assert!(!reading.complete);
    }

    #[test]
    fn a_single_day_window_is_read_as_one_day() {
        use DayState::{Dry, Wet};
        let cell = cell_with(0, &[Wet, Dry, Wet]);
        assert_eq!(spell_in_window(&cell, 1, 1).longest, 1);
        assert_eq!(spell_in_window(&cell, 0, 0).longest, 0);
    }

    #[test]
    fn a_window_that_ends_before_it_starts_holds_nothing_and_is_finished() {
        // Underwriting refuses to sell one, so this is about what the reader
        // does with impossible input: nothing left to learn, no spell found.
        let cell = cell_with(0, &[DayState::Dry, DayState::Dry]);
        let reading = spell_in_window(&cell, 5, 4);
        assert_eq!(reading.longest, 0);
        assert!(reading.complete);
    }

    #[test]
    fn a_window_reaching_the_end_of_the_counter_terminates() {
        // `end_day` at the top of a u32 would wrap the walk back to zero and
        // read the whole range a second time.
        let cell = cell_with(0, &[DayState::Dry]);
        let reading = spell_in_window(&cell, u32::MAX - 1, u32::MAX);
        assert_eq!(reading.longest, 0);
        assert!(!reading.complete);
    }

    #[test]
    fn the_window_reader_and_the_slice_reader_find_the_same_run() {
        use DayState::{Dry, NoCoverage, Wet};
        // The two share `step`, and this is the assertion that they keep
        // sharing it: the same days, read out of a ring and out of a slice.
        let days = [Dry, Wet, Dry, Dry, NoCoverage, Dry, Dry, Dry, Wet];
        let cell = cell_with(0, &days);
        let raw: Vec<u8> = days.iter().map(|state| *state as u8).collect();
        assert_eq!(
            spell_in_window(&cell, 0, days.len() as u32 - 1).longest,
            dry_spell(&raw)
        );
    }
}

