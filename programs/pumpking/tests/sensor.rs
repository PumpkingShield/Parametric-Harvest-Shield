//! `register_sensor` and `stake_sensor` over the built `.so` — `T031`.
//!
//! Open registration is the one door in this program that anyone may walk
//! through, so the tests are about what it refuses: a key the registrant does
//! not hold, a number that is not a cell, a cell one level off the grid, a
//! thirty-third sensor in a full mask, a stake from somebody who is not the
//! operator, and a stake that would land in the capital vault.

mod harness;

use anchor_lang::prelude::Pubkey as AnchorPubkey;
use harness::*;
use pumpking::errors::PumpkingError;
use pumpking::instructions::{DayRecordParams, PoolParams};
use pumpking::state::{CellState, Pool, Sensor, MAX_SENSORS_PER_CELL};

const GENESIS_TS: i64 = 1_800_000_000;
const SECONDS_PER_DAY: u32 = 86_400;
const DECIMALS: u8 = 6;
const SOL: u64 = 1_000_000_000;
const MIN_STAKE: u64 = 1_000_000;
const OPERATOR_BALANCE: u64 = 50_000_000;

/// `871e701b3ffffff`, the demo cell — a real res 7 H3 cell.
const CELL_ID: u64 = 0x0871_e701_b3ff_ffff;
/// One of its res 8 children: a real cell, on the wrong level.
const RES8_CELL: u64 = 0x0881_e701_b33f_ffff;

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
        unstake_delay_days: 30,
        waiting_period_days: 3,
        dry_day_threshold_mm_x100: 100,
        seconds_per_day: SECONDS_PER_DAY,
    }
}

fn world() -> World {
    let mut world = World::new(GENESIS_TS, SECONDS_PER_DAY);
    world.fund(authority(), 10 * SOL);
    world.fund(aggregator(), 10 * SOL);
    world.fund(operator(), 10 * SOL);
    world.fund(stranger(), 10 * SOL);
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

    let ix = instruction(
        pumpking::accounts::InitializePool {
            authority: authority(),
            pool: pool_pda(),
            asset_mint: asset_mint(),
            vault: vault_pda(),
            stake_vault: stake_vault_pda(),
            token_program: token_program_id(),
            system_program: system_program_id(),
        },
        pumpking::instruction::InitializePool {
            params: pool_params(),
        },
    );
    world.exec_ok(&ix);
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
