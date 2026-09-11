use anchor_lang::prelude::*;

/// Errors the program returns. One variant per rule that can be broken, so a
/// rejected transaction names the rule rather than a position in a list.
#[error_code]
pub enum PumpkingError {
    #[msg("Cell exposure share must be between 1 and 10000 basis points")]
    ExposureShareOutOfRange,

    #[msg("Premium rewards share must not exceed 10000 basis points")]
    RewardsShareOutOfRange,

    #[msg("Minimum sensors per cell must be between 1 and 32")]
    MinSensorsOutOfRange,

    #[msg("A day must be longer than zero seconds")]
    DayLengthNotSet,

    #[msg("Waiting period must be at least one day")]
    WaitingPeriodNotSet,

    #[msg("Unstake delay must be at least one day")]
    UnstakeDelayNotSet,

    #[msg("Authority and aggregator must be different keys")]
    RolesNotSeparated,

    #[msg("The mint authority of the asset must hold no power over the pool")]
    MintAuthorityHasPoolPower,

    #[msg("Deposit is too small to be worth a share of the pool")]
    DepositTooSmall,

    #[msg("The pool holds shares against no capital; a deposit cannot be priced")]
    PoolValueUnknown,

    #[msg("Arithmetic overflow")]
    MathOverflow,

    #[msg("A policy must pay out something")]
    PayoutNotSet,

    #[msg("The coverage window ends before it starts")]
    WindowNotOrdered,

    #[msg("The coverage window is longer than the day log can answer for")]
    WindowTooLong,

    #[msg("The spell threshold cannot be reached inside the coverage window")]
    ThresholdOutOfWindow,

    #[msg("Coverage may not start before the waiting period has elapsed")]
    WaitingPeriodNotElapsed,

    #[msg("The cell has fewer sensors than a value needs")]
    CellNotCovered,

    #[msg("Free liquidity does not cover this payout")]
    InsufficientLiquidity,

    #[msg("The cell would owe more than its share of the capital")]
    CellExposureExceeded,

    #[msg("The pool has no day index for this moment")]
    DayIndexUnavailable,

    #[msg("The cell has too few recorded days to price cover on")]
    CellHistoryTooShort,

    #[msg("The premium is above the limit the buyer set")]
    PremiumAboveLimit,

    #[msg("Risk loading must not exceed 10000 basis points")]
    RiskLoadingOutOfRange,

    #[msg("The floor rate must be between 1 and 10000 basis points")]
    MinRateOutOfRange,

    #[msg("Only the aggregator may write a day record")]
    NotTheAggregator,

    #[msg("The day classification is not one the log knows")]
    UnknownDayState,

    #[msg("A day can only be recorded once it is over")]
    DayNotOver,

    #[msg("The day log only grows forwards")]
    DayNotNewer,

    #[msg("A day must have had intervals to be measured from")]
    DayHasNoIntervals,

    #[msg("More intervals were covered than the day had")]
    CoverageCountsDisagree,

    #[msg("A day with a value must have had a covered interval")]
    DayHasNoCoverage,

    #[msg("A day without coverage cannot carry rainfall")]
    UncoveredDayHasRainfall,

    #[msg("A measured day must carry the rainfall it was measured as")]
    MeasuredDayHasNoRainfall,

    #[msg("A day without coverage earns nobody a contribution")]
    UncoveredDayHasContributors,

    #[msg("The contributor mask addresses a sensor slot the cell has not")]
    ContributorsOutOfRange,

    #[msg("A day with a value needs the minimum number of independent votes")]
    TooFewContributors,

    #[msg("Rainfall cannot be negative")]
    RainfallNegative,

    #[msg("The day classification disagrees with the rainfall it came from")]
    DayStateContradictsRainfall,

    #[msg("The policy is not active")]
    PolicyNotActive,

    #[msg("The policy was written on a different cell")]
    PolicyCellMismatch,

    #[msg("The index has not reached the policy's threshold")]
    EventHasNotHappened,

    #[msg("The coverage window still has a day the log has not answered for")]
    WindowNotOver,

    #[msg("The event happened; this policy is settled, not closed")]
    EventHasHappened,

    #[msg("The policy has no undelivered payout waiting")]
    PolicyNotUnclaimed,
}
