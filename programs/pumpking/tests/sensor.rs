//! `register_sensor` and `stake_sensor` over the built `.so` — `T031`;
//! `request_unstake` and `withdraw_stake` — `T033`.
//!
//! Open registration is the one door in this program that anyone may walk
//! through, so the tests are about what it refuses: a key the registrant does
//! not hold, a number that is not a cell, a cell one level off the grid, a
//! thirty-third sensor in a full mask, a stake from somebody who is not the
//! operator, and a stake that would land in the capital vault.
//!
//! **The stake is not capital** (`FR-051`, `T032`) is tested from the other
//! side: not what `stake_sensor` writes, but what the rest of the pool does
//! while the stake vault holds several times its capital. The pool sells no
//! cover past its capital, lets no cell owe more than capital allows, pays a
//! payout that empties the capital to its last unit without reaching the
//! stake, and has no instruction that moves money which will take the stake
//! vault in place of the capital vault. Both vaults answer to the same pool
//! PDA, so for the two transfers the pool signs — `settle_policy` and
//! `claim_unclaimed_payout` — that address check is the only thing between a
//! payout and the stake.
//!
//! **Leaving takes a thaw** (`FR-053`, `T033`). Stake asked out stops voting
//! the moment it is asked for and stays in the stake vault until the unlock
//! day — not one day sooner, and not to anybody but the operator. Asking again
//! restarts the count, and no pool can be created whose thaw is not longer
//! than the outlier observation window.

mod harness;

use anchor_lang::prelude::Pubkey as AnchorPubkey;
use harness::*;
use pumpking::errors::PumpkingError;
use pumpking::instructions::{DayRecordParams, PolicyParams, PoolParams};
use pumpking::state::{CellState, Pool, Sensor, MAX_SENSORS_PER_CELL, OUTLIER_WINDOW_DAYS};

const GENESIS_TS: i64 = 1_800_000_000;
const SECONDS_PER_DAY: u32 = 86_400;
const DECIMALS: u8 = 6;
const SOL: u64 = 1_000_000_000;
const MIN_STAKE: u64 = 1_000_000;
const OPERATOR_BALANCE: u64 = 100_000_000;

/// `871e701b3ffffff`, the demo cell — a real res 7 H3 cell.
const CELL_ID: u64 = 0x0871_e701_b3ff_ffff;
/// One of its res 8 children: a real cell, on the wrong level.
const RES8_CELL: u64 = 0x0881_e701_b33f_ffff;

/// What the depositor puts into the pool — all the capital it has.
const CAPITAL: u64 = 10_000_000;
/// The network the `FR-051` tests run on: three sensors, each staked this
/// much. Together they hold six times the pool's capital, so a check that
/// reached into the stake vault would sell, reserve or pay visibly more than
/// capital allows.
const NETWORK: u8 = 3;
const NETWORK_STAKE: u64 = 20_000_000;
/// Enough for the dearest policy these tests buy: cover for all the capital,
/// priced at 2500 bps (four dry days in twenty, plus the risk loading).
const FARMER_BALANCE: u64 = 10_000_000;

const HISTORY_DAYS: u32 = 20;
const WINDOW_START: u32 = 23;
const WINDOW_END: u32 = 30;
const SPELL_THRESHOLD: u8 = 5;

/// `pool_params().unstake_delay_days`, named for the thaw tests' arithmetic.
const THAW_DAYS: u32 = 30;
/// The day the thaw tests ask for their stake back on.
const ASKED_ON: u32 = 10;

fn authority() -> AnchorPubkey {
    key(1)
}
fn aggregator() -> AnchorPubkey {
    key(2)
}
fn minter() -> AnchorPubkey {
    key(3)
}
fn operator() -> AnchorPubkey {
    key(4)
}
fn stranger() -> AnchorPubkey {
    key(5)
}
fn asset_mint() -> AnchorPubkey {
    key(7)
}
fn operator_tokens() -> AnchorPubkey {
    key(8)
}
fn stranger_tokens() -> AnchorPubkey {
    key(9)
}
fn depositor() -> AnchorPubkey {
    key(10)
}
fn depositor_tokens() -> AnchorPubkey {
    key(11)
}
fn farmer() -> AnchorPubkey {
    key(12)
}
fn farmer_tokens() -> AnchorPubkey {
    key(13)
}
/// Sensor keys start at tag 100 so they never meet a role's.
fn sensor_key(n: u8) -> AnchorPubkey {
    key(100 + n)
}

fn pool_params() -> PoolParams {
    PoolParams {
        aggregator: aggregator(),
        cell_exposure_bps: 1_000,
        premium_rewards_bps: 1_000,
        risk_loading_bps: 2_500,
        min_rate_bps: 100,
        min_sensors_per_cell: 3,
        min_stake: MIN_STAKE,
        unstake_delay_days: THAW_DAYS as u16,
        waiting_period_days: 3,
        dry_day_threshold_mm_x100: 100,
        seconds_per_day: SECONDS_PER_DAY,
    }
}

fn world() -> World {
    world_with(pool_params())
}

fn world_with(params: PoolParams) -> World {
    let mut world = unpooled_world();
    world.exec_ok(&initialize_pool(params));
    world
}

fn initialize_pool(params: PoolParams) -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::InitializePool {
            authority: authority(),
            pool: pool_pda(),
            asset_mint: asset_mint(),
            vault: vault_pda(),
            stake_vault: stake_vault_pda(),
            token_program: token_program_id(),
            system_program: system_program_id(),
        },
        pumpking::instruction::InitializePool { params },
    )
}

/// Every wallet and token account the tests use, and no pool yet.
fn unpooled_world() -> World {
    let mut world = World::new(GENESIS_TS, SECONDS_PER_DAY);
    world.fund(authority(), 10 * SOL);
    world.fund(aggregator(), 10 * SOL);
    world.fund(operator(), 10 * SOL);
    world.fund(stranger(), 10 * SOL);
    world.fund(depositor(), 10 * SOL);
    world.fund(farmer(), 10 * SOL);
    world.create_mint(asset_mint(), DECIMALS, Some(minter()));
    world.create_token_account(
        operator_tokens(),
        asset_mint(),
        operator(),
        OPERATOR_BALANCE,
    );
    world.create_token_account(
        stranger_tokens(),
        asset_mint(),
        stranger(),
        OPERATOR_BALANCE,
    );
    world.create_token_account(depositor_tokens(), asset_mint(), depositor(), CAPITAL);
    world.create_token_account(farmer_tokens(), asset_mint(), farmer(), FARMER_BALANCE);
    world
}

fn register(
    operator: AnchorPubkey,
    sensor: AnchorPubkey,
    cell_id: u64,
) -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::RegisterSensor {
            operator,
            sensor_key: sensor,
            pool: pool_pda(),
            cell: cell_pda(cell_id),
            sensor: sensor_pda(sensor),
            system_program: system_program_id(),
        },
        pumpking::instruction::RegisterSensor { cell_id },
    )
}

fn stake(
    operator: AnchorPubkey,
    tokens: AnchorPubkey,
    sensor: AnchorPubkey,
    amount: u64,
) -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::StakeSensor {
            operator,
            pool: pool_pda(),
            sensor: sensor_pda(sensor),
            asset_mint: asset_mint(),
            stake_vault: stake_vault_pda(),
            operator_tokens: tokens,
            token_program: token_program_id(),
        },
        pumpking::instruction::StakeSensor { amount },
    )
}

fn request_unstake(
    operator: AnchorPubkey,
    sensor: AnchorPubkey,
    amount: u64,
) -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::RequestUnstake {
            operator,
            pool: pool_pda(),
            sensor: sensor_pda(sensor),
        },
        pumpking::instruction::RequestUnstake { amount },
    )
}

fn withdraw(
    operator: AnchorPubkey,
    tokens: AnchorPubkey,
    sensor: AnchorPubkey,
    stake_vault: AnchorPubkey,
) -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::WithdrawStake {
            operator,
            pool: pool_pda(),
            sensor: sensor_pda(sensor),
            asset_mint: asset_mint(),
            stake_vault,
            operator_tokens: tokens,
            token_program: token_program_id(),
        },
        pumpking::instruction::WithdrawStake {},
    )
}

/// One sensor registered and staked three times the minimum, the clock on
/// `ASKED_ON`.
fn thaw_world() -> World {
    let mut world = world();
    world.exec_ok(&register(operator(), sensor_key(1), CELL_ID));
    world.exec_ok(&stake(
        operator(),
        operator_tokens(),
        sensor_key(1),
        3 * MIN_STAKE,
    ));
    world.set_day(ASKED_ON);
    world
}

/// The same pool, except one cell may owe all of its capital. With the cell
/// limit out of the way, the only thing standing between a buyer and cover is
/// the liquidity check `FR-019` — the one `FR-051` names.
fn whole_pool_params() -> PoolParams {
    PoolParams {
        cell_exposure_bps: 10_000,
        ..pool_params()
    }
}

/* Every instruction that moves the pool's money takes the vault as an argument,
 * so the tests below can hand each of them the stake vault instead. */

fn deposit(vault: AnchorPubkey, amount: u64) -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::DepositCapital {
            depositor: depositor(),
            pool: pool_pda(),
            asset_mint: asset_mint(),
            vault,
            depositor_tokens: depositor_tokens(),
            position: position_pda(depositor()),
            token_program: token_program_id(),
            system_program: system_program_id(),
        },
        pumpking::instruction::DepositCapital { amount },
    )
}

fn issue(nonce: u64, payout: u64, vault: AnchorPubkey) -> solana_instruction::Instruction {
    let params = PolicyParams {
        nonce,
        cell_id: CELL_ID,
        spell_days_threshold: SPELL_THRESHOLD,
        payout,
        max_premium: payout,
        window_start_day: WINDOW_START,
        window_end_day: WINDOW_END,
    };
    instruction(
        pumpking::accounts::IssuePolicy {
            owner: farmer(),
            pool: pool_pda(),
            cell: cell_pda(CELL_ID),
            policy: policy_pda(farmer(), nonce),
            asset_mint: asset_mint(),
            vault,
            owner_tokens: farmer_tokens(),
            token_program: token_program_id(),
            system_program: system_program_id(),
        },
        pumpking::instruction::IssuePolicy { params },
    )
}

fn settle(nonce: u64, vault: AnchorPubkey) -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::SettlePolicy {
            caller: stranger(),
            pool: pool_pda(),
            cell: cell_pda(CELL_ID),
            policy: policy_pda(farmer(), nonce),
            asset_mint: asset_mint(),
            vault,
            owner_tokens: farmer_tokens(),
            token_program: token_program_id(),
        },
        pumpking::instruction::SettlePolicy {},
    )
}

fn claim(nonce: u64, vault: AnchorPubkey) -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::ClaimUnclaimedPayout {
            caller: stranger(),
            pool: pool_pda(),
            cell: cell_pda(CELL_ID),
            policy: policy_pda(farmer(), nonce),
            asset_mint: asset_mint(),
            vault,
            owner_tokens: farmer_tokens(),
            token_program: token_program_id(),
        },
        pumpking::instruction::ClaimUnclaimedPayout {},
    )
}

/// A day of the cell as the staked network measured it: slots 0..2 voting,
/// the full day covered.
fn submit_day(day_index: u32, dry: bool) -> solana_instruction::Instruction {
    let params = DayRecordParams {
        cell_id: CELL_ID,
        day_index,
        state: if dry { 1 } else { 2 },
        contributors: 0b111,
        readings_root: [0x5a; 32],
        rainfall_x100: Some(if dry { 0 } else { 500 }),
        covered_intervals: 24,
        total_intervals: 24,
    };
    instruction(
        pumpking::accounts::SubmitDayRecord {
            aggregator: aggregator(),
            pool: pool_pda(),
            cell: cell_pda(CELL_ID),
            system_program: system_program_id(),
        },
        pumpking::instruction::SubmitDayRecord { params },
    )
}

/// A pool with capital, and a cell its own staked network has measured for
/// twenty days: three sensors registered in slots 0..2, each staked
/// `NETWORK_STAKE`, and every day written with those three as its votes. Four
/// of the twenty are dry, which prices cover at 2500 bps. The clock stays on
/// day `HISTORY_DAYS`.
fn staked_world(params: PoolParams) -> World {
    let mut world = world_with(params);
    world.exec_ok(&deposit(vault_pda(), CAPITAL));
    for n in 0..NETWORK {
        world.exec_ok(&register(operator(), sensor_key(n), CELL_ID));
        world.exec_ok(&stake(
            operator(),
            operator_tokens(),
            sensor_key(n),
            NETWORK_STAKE,
        ));
    }
    for day in 0..HISTORY_DAYS {
        world.set_day(day + 1);
        world.exec_ok(&submit_day(day, matches!(day, 3 | 8 | 14 | 19)));
    }
    world.set_day(HISTORY_DAYS);
    world
}

/// The stake vault holds exactly what the network put up, and every sensor
/// still holds its own share of it.
fn assert_stake_untouched(world: &World) {
    assert_eq!(
        token_amount(world.account(stake_vault_pda())),
        u64::from(NETWORK) * NETWORK_STAKE
    );
    for n in 0..NETWORK {
        let sensor: Sensor = world.read(sensor_pda(sensor_key(n)));
        assert_eq!(sensor.stake, NETWORK_STAKE);
    }
}

/* -------------------------------------------------------------------------- */
/* register_sensor                                                            */
/* -------------------------------------------------------------------------- */

#[test]
fn the_first_sensor_of_a_cell_opens_it_and_takes_slot_zero() {
    let mut world = world();
    assert!(!world.exists(cell_pda(CELL_ID)));

    world.exec_ok(&register(operator(), sensor_key(1), CELL_ID));

    let cell: CellState = world.read(cell_pda(CELL_ID));
    assert_eq!(cell.cell_id, CELL_ID);
    assert_eq!(cell.sensor_count, 1);
    assert_eq!(cell.last_day_index, None, "registering writes no day");

    let sensor: Sensor = world.read(sensor_pda(sensor_key(1)));
    assert_eq!(sensor.sensor_key, sensor_key(1));
    assert_eq!(sensor.operator, operator());
    assert_eq!(sensor.cell_id, CELL_ID);
    assert_eq!(sensor.slot_in_cell, 0);
    assert_eq!(sensor.stake, 0);
    assert!(sensor.active);
    // Registered is not voting: `FR-050`.
    assert!(!sensor.votes(MIN_STAKE));
}

#[test]
fn slots_are_handed_out_in_order() {
    let mut world = world();
    for n in 0..3 {
        world.exec_ok(&register(operator(), sensor_key(n), CELL_ID));
        let sensor: Sensor = world.read(sensor_pda(sensor_key(n)));
        assert_eq!(sensor.slot_in_cell, n);
    }
    let cell: CellState = world.read(cell_pda(CELL_ID));
    assert_eq!(cell.sensor_count, 3);
}

#[test]
fn registering_in_a_cell_the_aggregator_opened_keeps_its_day_log() {
    let mut world = world();
    world.set_day(2);
    let day = DayRecordParams {
        cell_id: CELL_ID,
        day_index: 1,
        state: 2,
        contributors: 0b111,
        readings_root: [0x5a; 32],
        rainfall_x100: Some(500),
        covered_intervals: 24,
        total_intervals: 24,
    };
    world.exec_ok(&instruction(
        pumpking::accounts::SubmitDayRecord {
            aggregator: aggregator(),
            pool: pool_pda(),
            cell: cell_pda(CELL_ID),
            system_program: system_program_id(),
        },
        pumpking::instruction::SubmitDayRecord { params: day },
    ));

    world.exec_ok(&register(operator(), sensor_key(1), CELL_ID));

    let cell: CellState = world.read(cell_pda(CELL_ID));
    assert_eq!(cell.last_day_index, Some(1));
    assert_eq!(cell.contributors_of(1), Some(0b111));
    assert_eq!(cell.sensor_count, 1);
}

#[test]
fn the_cell_takes_thirty_two_sensors_and_refuses_the_thirty_third() {
    let mut world = world();
    for n in 0..MAX_SENSORS_PER_CELL {
        world.exec_ok(&register(operator(), sensor_key(n), CELL_ID));
    }
    world.exec_err(
        &register(operator(), sensor_key(MAX_SENSORS_PER_CELL), CELL_ID),
        PumpkingError::CellIsFull,
    );
    assert!(!world.exists(sensor_pda(sensor_key(MAX_SENSORS_PER_CELL))));
}

#[test]
fn a_key_is_registered_once() {
    let mut world = world();
    world.exec_ok(&register(operator(), sensor_key(1), CELL_ID));

    // Again, even by somebody else and in another cell: `init` refuses an
    // account that exists, and moving a sensor is its own action (`FR-059`).
    let result = world.exec(&register(stranger(), sensor_key(1), 0x0871_e701_86ff_ffff));
    assert!(result.program_result.is_err());
    let sensor: Sensor = world.read(sensor_pda(sensor_key(1)));
    assert_eq!(sensor.operator, operator());
}

#[test]
fn the_sensor_key_must_sign_its_own_registration() {
    let mut world = world();
    let mut ix = register(stranger(), sensor_key(1), CELL_ID);
    let meta = ix
        .accounts
        .iter_mut()
        .find(|meta| meta.pubkey == svm(sensor_key(1)))
        .expect("the sensor key is an account of the instruction");
    meta.is_signer = false;

    world.exec_anchor_err(&ix, anchor_lang::error::ErrorCode::AccountNotSigner);
    assert!(!world.exists(sensor_pda(sensor_key(1))));
}

#[test]
fn a_number_that_is_not_a_cell_is_refused() {
    let mut world = world();
    world.exec_err(
        &register(operator(), sensor_key(1), 0x8712_3456_789a_bcdf),
        PumpkingError::NotAnH3Cell,
    );
}

#[test]
fn a_cell_on_another_grid_level_is_refused() {
    let mut world = world();
    world.exec_err(
        &register(operator(), sensor_key(1), RES8_CELL),
        PumpkingError::WrongGridResolution,
    );
}

/* -------------------------------------------------------------------------- */
/* stake_sensor                                                               */
/* -------------------------------------------------------------------------- */

#[test]
fn stake_goes_to_the_stake_vault_and_the_sensor_starts_to_vote() {
    let mut world = world();
    world.exec_ok(&register(operator(), sensor_key(1), CELL_ID));
    let pool_before: Pool = world.read(pool_pda());

    world.exec_ok(&stake(
        operator(),
        operator_tokens(),
        sensor_key(1),
        MIN_STAKE - 1,
    ));
    let sensor: Sensor = world.read(sensor_pda(sensor_key(1)));
    assert!(
        !sensor.votes(MIN_STAKE),
        "one unit short of the minimum is no vote"
    );

    world.exec_ok(&stake(operator(), operator_tokens(), sensor_key(1), 1));
    let sensor: Sensor = world.read(sensor_pda(sensor_key(1)));
    assert_eq!(sensor.stake, MIN_STAKE);
    assert!(sensor.votes(MIN_STAKE));

    assert_eq!(token_amount(world.account(stake_vault_pda())), MIN_STAKE);
    assert_eq!(
        token_amount(world.account(operator_tokens())),
        OPERATOR_BALANCE - MIN_STAKE
    );
    assert_eq!(token_amount(world.account(vault_pda())), 0);

    // `FR-051`: stake is not capital and not reserved.
    let pool_after: Pool = world.read(pool_pda());
    assert_eq!(pool_after.capital_total, pool_before.capital_total);
    assert_eq!(pool_after.reserved_total, pool_before.reserved_total);
    assert_eq!(pool_after.shares_total, pool_before.shares_total);
}

#[test]
fn only_the_operator_stakes_their_sensor() {
    let mut world = world();
    world.exec_ok(&register(operator(), sensor_key(1), CELL_ID));
    world.exec_err(
        &stake(stranger(), stranger_tokens(), sensor_key(1), MIN_STAKE),
        PumpkingError::NotTheOperator,
    );
    assert_eq!(token_amount(world.account(stake_vault_pda())), 0);
}

#[test]
fn a_stake_of_nothing_is_refused() {
    let mut world = world();
    world.exec_ok(&register(operator(), sensor_key(1), CELL_ID));
    world.exec_err(
        &stake(operator(), operator_tokens(), sensor_key(1), 0),
        PumpkingError::StakeTooSmall,
    );
}

#[test]
fn a_stake_aimed_at_the_capital_vault_is_refused() {
    let mut world = world();
    world.exec_ok(&register(operator(), sensor_key(1), CELL_ID));
    let ix = instruction(
        pumpking::accounts::StakeSensor {
            operator: operator(),
            pool: pool_pda(),
            sensor: sensor_pda(sensor_key(1)),
            asset_mint: asset_mint(),
            stake_vault: vault_pda(),
            operator_tokens: operator_tokens(),
            token_program: token_program_id(),
        },
        pumpking::instruction::StakeSensor { amount: MIN_STAKE },
    );
    world.exec_anchor_err(&ix, anchor_lang::error::ErrorCode::ConstraintAddress);
    assert_eq!(token_amount(world.account(vault_pda())), 0);
}

/* -------------------------------------------------------------------------- */
/* FR-051 — the stake is not capital                                          */
/* -------------------------------------------------------------------------- */

#[test]
fn the_stake_sells_no_cover_beyond_capital() {
    // `FR-019` at its edge, with six times the capital sitting in the stake
    // vault: one unit of cover past the capital is refused, the capital
    // itself is not.
    let mut world = staked_world(whole_pool_params());
    world.exec_err(
        &issue(1, CAPITAL + 1, vault_pda()),
        PumpkingError::InsufficientLiquidity,
    );
    world.exec_ok(&issue(1, CAPITAL, vault_pda()));

    // Sold out. What is free now is the capital share of that one premium —
    // 2500 bps of the payout, less the tenth that goes to the cell's rewards
    // (`FR-034`) — and one unit past it is refused just the same.
    let premium = CAPITAL / 4;
    let free = premium - premium / 10;
    let pool: Pool = world.read(pool_pda());
    assert_eq!(pool.reserved_total, CAPITAL);
    assert_eq!(pool.free_liquidity(), free);
    world.exec_err(
        &issue(2, free + 1, vault_pda()),
        PumpkingError::InsufficientLiquidity,
    );

    // Selling cover moved nothing out of the stake vault.
    assert_stake_untouched(&world);
}

#[test]
fn the_stake_raises_no_cell_s_exposure_limit() {
    // `FR-020`, the other limit capital sets: a tenth of it per cell,
    // whatever the cell's own sensors have staked.
    let mut world = staked_world(pool_params());
    world.exec_err(
        &issue(1, CAPITAL / 10 + 1, vault_pda()),
        PumpkingError::CellExposureExceeded,
    );
    world.exec_ok(&issue(1, CAPITAL / 10, vault_pda()));

    let cell: CellState = world.read(cell_pda(CELL_ID));
    assert_eq!(cell.reserved, CAPITAL / 10);
    assert_stake_untouched(&world);
}

#[test]
fn a_payout_that_takes_all_the_capital_leaves_the_stake_where_it_was() {
    // Cover for every unit of capital, and the drought it was bought
    // against. The payout empties the capital to its last unit; the stake
    // vault, held by the same pool PDA, is not one unit lighter.
    let mut world = staked_world(whole_pool_params());
    world.exec_ok(&issue(1, CAPITAL, vault_pda()));
    let premium = CAPITAL / 4;

    for day in WINDOW_START..WINDOW_START + u32::from(SPELL_THRESHOLD) {
        world.set_day(day + 1);
        world.exec_ok(&submit_day(day, true));
    }
    let before = token_amount(world.account(farmer_tokens()));
    world.exec_ok(&settle(1, vault_pda()));

    assert_eq!(
        token_amount(world.account(farmer_tokens())),
        before + CAPITAL
    );
    // What is left in the capital vault is that one premium: its capital
    // share and the cell's reward reserve, nothing of the depositor's.
    assert_eq!(token_amount(world.account(vault_pda())), premium);
    let pool: Pool = world.read(pool_pda());
    assert_eq!(pool.capital_total, premium - premium / 10);
    assert_eq!(pool.reserved_total, 0);

    assert_stake_untouched(&world);
}

#[test]
fn no_instruction_that_moves_money_takes_the_stake_vault_for_capital() {
    // One vault swapped for the other, in each of the four instructions that
    // move the pool's money. Deposit and premium would land in the stake
    // vault and be counted as capital; settlement and a deferred payout
    // would be signed by the pool PDA, which holds the stake vault too.
    let mut world = staked_world(pool_params());
    world.exec_ok(&issue(1, CAPITAL / 10, vault_pda()));
    let vault_before = token_amount(world.account(vault_pda()));
    let pool_before: Pool = world.read(pool_pda());

    for ix in [
        deposit(stake_vault_pda(), 1),
        issue(2, CAPITAL / 10, stake_vault_pda()),
        settle(1, stake_vault_pda()),
        claim(1, stake_vault_pda()),
    ] {
        world.exec_anchor_err(&ix, anchor_lang::error::ErrorCode::ConstraintAddress);
    }

    assert_eq!(token_amount(world.account(vault_pda())), vault_before);
    let pool: Pool = world.read(pool_pda());
    assert_eq!(pool.capital_total, pool_before.capital_total);
    assert_eq!(pool.reserved_total, pool_before.reserved_total);
    assert_stake_untouched(&world);
}

/* -------------------------------------------------------------------------- */
/* FR-053 — request_unstake and withdraw_stake                                */
/* -------------------------------------------------------------------------- */

#[test]
fn no_pool_is_created_whose_thaw_does_not_outlast_the_outlier_window() {
    let mut world = unpooled_world();
    let params = PoolParams {
        unstake_delay_days: OUTLIER_WINDOW_DAYS,
        ..pool_params()
    };
    world.exec_err(
        &initialize_pool(params),
        PumpkingError::UnstakeDelayTooShort,
    );
    assert!(!world.exists(pool_pda()));

    let params = PoolParams {
        unstake_delay_days: OUTLIER_WINDOW_DAYS + 1,
        ..pool_params()
    };
    world.exec_ok(&initialize_pool(params));
}

#[test]
fn asking_stake_out_silences_it_at_once_and_moves_no_money() {
    let mut world = thaw_world();
    let pool_before: Pool = world.read(pool_pda());

    world.exec_ok(&request_unstake(operator(), sensor_key(1), 2 * MIN_STAKE));

    let sensor: Sensor = world.read(sensor_pda(sensor_key(1)));
    assert_eq!(sensor.stake, MIN_STAKE);
    assert_eq!(sensor.unstaking, 2 * MIN_STAKE);
    assert_eq!(sensor.unlock_at_day, Some(ASKED_ON + THAW_DAYS));
    // What is left still votes; what is thawing does not count towards it.
    assert!(sensor.votes(MIN_STAKE));
    assert!(!sensor.votes(MIN_STAKE + 1));

    // The thaw is bookkeeping: the stake vault holds all of it until the end.
    assert_eq!(
        token_amount(world.account(stake_vault_pda())),
        3 * MIN_STAKE
    );
    assert_eq!(
        token_amount(world.account(operator_tokens())),
        OPERATOR_BALANCE - 3 * MIN_STAKE
    );
    let pool: Pool = world.read(pool_pda());
    assert_eq!(pool.capital_total, pool_before.capital_total);
}

#[test]
fn the_stake_leaves_on_the_unlock_day_and_not_the_day_before() {
    let mut world = thaw_world();
    world.exec_ok(&request_unstake(operator(), sensor_key(1), 2 * MIN_STAKE));

    world.set_day(ASKED_ON + THAW_DAYS - 1);
    world.exec_err(
        &withdraw(
            operator(),
            operator_tokens(),
            sensor_key(1),
            stake_vault_pda(),
        ),
        PumpkingError::StakeStillThawing,
    );
    assert_eq!(
        token_amount(world.account(stake_vault_pda())),
        3 * MIN_STAKE
    );

    world.set_day(ASKED_ON + THAW_DAYS);
    world.exec_ok(&withdraw(
        operator(),
        operator_tokens(),
        sensor_key(1),
        stake_vault_pda(),
    ));

    assert_eq!(token_amount(world.account(stake_vault_pda())), MIN_STAKE);
    assert_eq!(
        token_amount(world.account(operator_tokens())),
        OPERATOR_BALANCE - MIN_STAKE
    );
    let sensor: Sensor = world.read(sensor_pda(sensor_key(1)));
    assert_eq!(sensor.stake, MIN_STAKE);
    assert_eq!(sensor.unstaking, 0);
    assert_eq!(sensor.unlock_at_day, None);

    // Paid once: the same withdrawal again finds nothing thawing.
    world.exec_err(
        &withdraw(
            operator(),
            operator_tokens(),
            sensor_key(1),
            stake_vault_pda(),
        ),
        PumpkingError::NothingThawing,
    );
}

#[test]
fn asking_again_adds_to_the_thaw_and_restarts_the_count() {
    let mut world = thaw_world();
    world.exec_ok(&request_unstake(operator(), sensor_key(1), MIN_STAKE));
    let again = ASKED_ON + 15;
    world.set_day(again);
    world.exec_ok(&request_unstake(operator(), sensor_key(1), MIN_STAKE));

    let sensor: Sensor = world.read(sensor_pda(sensor_key(1)));
    assert_eq!(sensor.unstaking, 2 * MIN_STAKE);
    assert_eq!(sensor.unlock_at_day, Some(again + THAW_DAYS));

    // The first request's unlock day is no longer a door.
    world.set_day(ASKED_ON + THAW_DAYS);
    world.exec_err(
        &withdraw(
            operator(),
            operator_tokens(),
            sensor_key(1),
            stake_vault_pda(),
        ),
        PumpkingError::StakeStillThawing,
    );

    world.set_day(again + THAW_DAYS);
    world.exec_ok(&withdraw(
        operator(),
        operator_tokens(),
        sensor_key(1),
        stake_vault_pda(),
    ));
    assert_eq!(token_amount(world.account(stake_vault_pda())), MIN_STAKE);
}

#[test]
fn staking_during_a_thaw_votes_and_does_not_touch_the_thaw() {
    let mut world = thaw_world();
    world.exec_ok(&request_unstake(operator(), sensor_key(1), 3 * MIN_STAKE));
    let sensor: Sensor = world.read(sensor_pda(sensor_key(1)));
    assert!(!sensor.votes(MIN_STAKE));

    world.set_day(ASKED_ON + 5);
    world.exec_ok(&stake(
        operator(),
        operator_tokens(),
        sensor_key(1),
        MIN_STAKE,
    ));

    let sensor: Sensor = world.read(sensor_pda(sensor_key(1)));
    assert_eq!(sensor.stake, MIN_STAKE);
    assert!(sensor.votes(MIN_STAKE));
    assert_eq!(sensor.unstaking, 3 * MIN_STAKE);
    assert_eq!(sensor.unlock_at_day, Some(ASKED_ON + THAW_DAYS));
}

#[test]
fn no_more_can_be_asked_out_than_votes() {
    let mut world = thaw_world();
    world.exec_err(
        &request_unstake(operator(), sensor_key(1), 3 * MIN_STAKE + 1),
        PumpkingError::UnstakeExceedsStake,
    );
    world.exec_err(
        &request_unstake(operator(), sensor_key(1), 0),
        PumpkingError::StakeTooSmall,
    );
    let sensor: Sensor = world.read(sensor_pda(sensor_key(1)));
    assert_eq!(sensor.stake, 3 * MIN_STAKE);
    assert_eq!(sensor.unlock_at_day, None);
}

#[test]
fn only_the_operator_thaws_and_withdraws_and_only_to_their_own_account() {
    let mut world = thaw_world();
    world.exec_err(
        &request_unstake(stranger(), sensor_key(1), MIN_STAKE),
        PumpkingError::NotTheOperator,
    );

    world.exec_ok(&request_unstake(operator(), sensor_key(1), MIN_STAKE));
    world.set_day(ASKED_ON + THAW_DAYS);

    world.exec_err(
        &withdraw(
            stranger(),
            stranger_tokens(),
            sensor_key(1),
            stake_vault_pda(),
        ),
        PumpkingError::NotTheOperator,
    );
    // The operator signing, the money aimed at somebody else's account.
    world.exec_anchor_err(
        &withdraw(
            operator(),
            stranger_tokens(),
            sensor_key(1),
            stake_vault_pda(),
        ),
        anchor_lang::error::ErrorCode::ConstraintTokenOwner,
    );
    assert_eq!(
        token_amount(world.account(stake_vault_pda())),
        3 * MIN_STAKE
    );
    assert_eq!(
        token_amount(world.account(stranger_tokens())),
        OPERATOR_BALANCE
    );
}

#[test]
fn a_withdrawal_aimed_at_the_capital_vault_is_refused() {
    // `FR-051` from the way out: both vaults answer to the pool PDA, so the
    // address is all that keeps a thawed stake from being paid out of capital.
    let mut world = staked_world(pool_params());
    world.exec_ok(&request_unstake(operator(), sensor_key(0), NETWORK_STAKE));
    world.set_day(HISTORY_DAYS + THAW_DAYS);

    world.exec_anchor_err(
        &withdraw(operator(), operator_tokens(), sensor_key(0), vault_pda()),
        anchor_lang::error::ErrorCode::ConstraintAddress,
    );
    assert_eq!(token_amount(world.account(vault_pda())), CAPITAL);
    let sensor: Sensor = world.read(sensor_pda(sensor_key(0)));
    assert_eq!(sensor.unstaking, NETWORK_STAKE);
}
