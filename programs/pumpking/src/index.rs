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

/// Longest unbroken run of dry days in `days`.
///
/// The same function exists in TypeScript for display. Both are driven by
/// `fixtures/index-cases.json`; a divergence of one day is a payout the
/// interface never promised.
pub fn dry_spell(days: &[u8]) -> u32 {
    let mut best: u32 = 0;
    let mut run: u32 = 0;

    for raw in days {
        if DayState::from_u8(*raw) == Some(DayState::Dry) {
            run += 1;
            if run > best {
                best = run;
            }
        } else {
            run = 0;
        }
    }

    best
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
}
