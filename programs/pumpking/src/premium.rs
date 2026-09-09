use crate::index::DayState;

/// What cover costs — `FR-021`. Deterministic, public, and the same for
/// everybody: the price of a policy is a function of the cell's own recorded
/// history and of the payout, and of nothing about the buyer.
///
/// This file exists **twice**. `packages/shared/src/premium.ts` is the other
/// half, and both are driven by `fixtures/premium-cases.json` — the third pair
/// of twins in the project, after `dry_spell`. A divergence here is not a
/// display bug: the interface would quote one price and the chain charge
/// another, and the buyer would learn about it from their balance.
///
/// `FR-038` requires an outsider to redo the arithmetic by hand from the
/// methodology page. That is why every step below is integer and why there are
/// exactly two roundings, in stated directions.

/// Basis points, the unit every published share is expressed in.
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Covered days a cell needs before it can be priced at all.
///
/// Below this the share of dry days is noise rather than a rate — three days
/// of record can read as 0% or 100% and mean neither. Refusing to quote is the
/// honest answer; quoting off three days is a number with a decimal point and
/// nothing behind it.
pub const MIN_HISTORY_DAYS: u32 = 14;

/// The share of a cell's **recorded** days that were dry, in basis points, or
/// `None` when the record is too short to be a rate.
///
/// Days without coverage are excluded from both sides rather than counted as
/// wet. Silence is not evidence that it rained — the same rule `FR-047`
/// applies to settlement, applied to pricing.
///
/// Takes the day log as it is stored, ring buffer and all: a slot the log does
/// not answer for reads as no coverage, so position never matters and the
/// caller does not have to unwrap the ring.
///
/// Rounds **down**. This is a measurement, and the price rounds up later;
/// doing both in the same direction would charge for the same caution twice.
pub fn dry_day_frequency_bps(days: &[u8]) -> Option<u16> {
    let mut dry: u32 = 0;
    let mut covered: u32 = 0;

    for raw in days {
        match DayState::from_u8(*raw) {
            Some(DayState::Dry) => {
                dry += 1;
                covered += 1;
            }
            Some(DayState::Wet) => covered += 1,
            _ => {}
        }
    }

    if covered < MIN_HISTORY_DAYS {
        return None;
    }

    let bps = u64::from(dry) * BPS_DENOMINATOR / u64::from(covered);
    u16::try_from(bps).ok()
}

/// The rate the pool charges, in basis points of the payout.
///
/// Two published parameters shape it. The **risk loading** is the difference
/// between a pool and a coin flip: a pool charging exactly its expected loss
/// breaks even on average and goes insolvent on variance. The **floor rate**
/// is what stops a thin or lucky record from pricing cover at nothing —
/// fourteen dry-free days are not proof that a cell never dries out, and
/// `FR-021` gives the formula no other way to say "we do not know yet".
///
/// Rounds down: the rate is a published number, and the pool takes its dust in
/// the premium instead.
pub fn premium_rate_bps(frequency_bps: u16, risk_loading_bps: u16, min_rate_bps: u16) -> u64 {
    let loaded = u64::from(frequency_bps) * (BPS_DENOMINATOR + u64::from(risk_loading_bps))
        / BPS_DENOMINATOR;
    loaded.max(u64::from(min_rate_bps))
}

/// The premium for a payout at a rate — rounded **up**, always towards the
/// pool.
///
/// The buyer loses at most one unit of dust; a premium rounded the other way
/// takes that unit out of the capital standing behind every other policy. The
/// same choice, for the same reason, as the share rounding in
/// `deposit_capital`.
///
/// `None` only when the result does not fit a `u64`, which needs both a payout
/// near the ceiling and a rate above 100%.
pub fn premium_for(payout: u64, rate_bps: u64) -> Option<u64> {
    let denominator = u128::from(BPS_DENOMINATOR);
    let numerator = u128::from(payout) * u128::from(rate_bps);
    let premium = (numerator + denominator - 1) / denominator;
    u64::try_from(premium).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct FrequencyCase {
        name: String,
        days: Vec<u8>,
        #[serde(rename = "frequencyBps")]
        frequency_bps: Option<u16>,
    }

    #[derive(serde::Deserialize)]
    struct PremiumCase {
        name: String,
        payout: String,
        #[serde(rename = "frequencyBps")]
        frequency_bps: u16,
        #[serde(rename = "riskLoadingBps")]
        risk_loading_bps: u16,
        #[serde(rename = "minRateBps")]
        min_rate_bps: u16,
        #[serde(rename = "rateBps")]
        rate_bps: u64,
        premium: String,
    }

    #[derive(serde::Deserialize)]
    struct Fixtures {
        frequency: Vec<FrequencyCase>,
        premium: Vec<PremiumCase>,
    }

    fn fixtures() -> Fixtures {
        let raw = include_str!("../../../fixtures/premium-cases.json");
        serde_json::from_str(raw).expect("fixtures parse")
    }

    /// The TypeScript twin in `packages/shared` runs this exact file. A case
    /// that passes on one side and fails on the other is the divergence this
    /// fixture exists to catch.
    #[test]
    fn agrees_with_the_typescript_twin_on_every_frequency_case() {
        let cases = fixtures().frequency;
        assert!(!cases.is_empty());

        for case in cases {
            assert_eq!(
                dry_day_frequency_bps(&case.days),
                case.frequency_bps,
                "case: {}",
                case.name
            );
        }
    }

    #[test]
    fn agrees_with_the_typescript_twin_on_every_premium_case() {
        let cases = fixtures().premium;
        assert!(!cases.is_empty());

        for case in cases {
            let payout: u64 = case.payout.parse().expect("payout");
            let expected: u64 = case.premium.parse().expect("premium");
            let rate = premium_rate_bps(case.frequency_bps, case.risk_loading_bps, case.min_rate_bps);
            assert_eq!(rate, case.rate_bps, "rate of case: {}", case.name);
            assert_eq!(premium_for(payout, rate), Some(expected), "case: {}", case.name);
        }
    }

    #[test]
    fn a_record_one_day_short_is_not_a_rate() {
        let short = vec![DayState::Dry as u8; (MIN_HISTORY_DAYS - 1) as usize];
        assert_eq!(dry_day_frequency_bps(&short), None);

        let enough = vec![DayState::Dry as u8; MIN_HISTORY_DAYS as usize];
        assert_eq!(dry_day_frequency_bps(&enough), Some(10_000));
    }

    #[test]
    fn silence_is_not_a_wet_day() {
        // The whole ring, of which only fourteen slots were ever written.
        let mut log = [DayState::NoCoverage as u8; 128];
        for slot in log.iter_mut().take(14) {
            *slot = DayState::Dry as u8;
        }
        assert_eq!(dry_day_frequency_bps(&log), Some(10_000));
    }

    #[test]
    fn the_rate_never_falls_below_the_published_floor() {
        assert_eq!(premium_rate_bps(0, 0, 250), 250);
        assert_eq!(premium_rate_bps(1, 0, 250), 250);
        assert_eq!(premium_rate_bps(300, 0, 250), 300);
    }

    #[test]
    fn the_rate_rises_with_the_frequency() {
        let rates: Vec<u64> = [0u16, 1_000, 2_000, 5_000]
            .iter()
            .map(|bps| premium_rate_bps(*bps, 2_500, 100))
            .collect();
        assert!(rates.windows(2).all(|pair| pair[0] <= pair[1]));
    }

    #[test]
    fn the_money_rounds_up_towards_the_pool() {
        // Half a unit is still a unit: the buyer loses dust, the capital
        // standing behind every other policy does not.
        assert_eq!(premium_for(1, 5_000), Some(1));
        assert_eq!(premium_for(10_000, 250), Some(250));
    }

    #[test]
    fn only_a_rate_of_nothing_costs_nothing() {
        assert_eq!(premium_for(1_000_000, 0), Some(0));
    }

    #[test]
    fn the_largest_payout_does_not_wrap() {
        assert_eq!(premium_for(u64::MAX, 100), Some(184_467_440_737_095_517));
        // Above 100% of a payout that large the result leaves the u64 it has
        // to be paid in, and saying so beats wrapping to a small number.
        assert_eq!(premium_for(u64::MAX, 20_000), None);
    }
}
