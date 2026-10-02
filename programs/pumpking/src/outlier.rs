//! When a sensor's record excludes it — `FR-012`.
//!
//! Whether one value is an outlier (`FR-011`) is decided off chain, by the
//! aggregator against the cell's median: the program never sees a reading.
//! What it does see, from `T035` on, is a sensor's judged and outlier counts
//! over the observation window, and this is the rule it applies to them — the
//! same rule `packages/shared/src/outlier.ts` applies, both driven by
//! `fixtures/outlier-cases.json`. The aggregator reports; the program decides,
//! the way it re-derives dry from wet rather than taking a day's state on trust.

use crate::state::{BPS_DENOMINATOR, OUTLIER_MIN_JUDGED, OUTLIER_SHARE_BPS};

/// Whether `outliers` of `judged` intervals put a sensor over the line.
///
/// Strictly above `OUTLIER_SHARE_BPS`, and only once `OUTLIER_MIN_JUDGED`
/// intervals were judged: below that one bad hour is a hundred per cent.
/// Cross-multiplied, so the threshold is exact rather than rounded.
pub fn breaches_outlier_share(judged: u32, outliers: u32) -> bool {
    if judged < u32::from(OUTLIER_MIN_JUDGED) || outliers > judged {
        return false;
    }
    u64::from(outliers) * BPS_DENOMINATOR > u64::from(judged) * u64::from(OUTLIER_SHARE_BPS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct ShareCase {
        name: String,
        judged: u32,
        outliers: u32,
        breaches: bool,
    }

    #[derive(serde::Deserialize)]
    struct Fixtures {
        share: Vec<ShareCase>,
    }

    /// The TypeScript twin runs this exact file.
    #[test]
    fn agrees_with_the_typescript_twin_on_every_share_case() {
        let raw = include_str!("../../../fixtures/outlier-cases.json");
        let cases = serde_json::from_str::<Fixtures>(raw)
            .expect("fixtures parse")
            .share;
        assert!(!cases.is_empty());

        for case in cases {
            assert_eq!(
                breaches_outlier_share(case.judged, case.outliers),
                case.breaches,
                "case: {}",
                case.name
            );
        }
    }

    #[test]
    fn a_record_with_more_outliers_than_judgements_excludes_nobody() {
        // Not a record that can exist; the program refuses to act on it
        // rather than burn a stake over arithmetic that cannot be true.
        assert!(!breaches_outlier_share(100, 101));
    }

    #[test]
    fn the_largest_record_does_not_overflow() {
        assert!(breaches_outlier_share(u32::MAX, u32::MAX));
        assert!(!breaches_outlier_share(u32::MAX, 0));
    }
}
