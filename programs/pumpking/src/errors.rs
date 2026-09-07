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
}
