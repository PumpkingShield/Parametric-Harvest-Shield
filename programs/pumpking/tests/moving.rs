//! Moving a sensor to another cell over the built `.so` — `T039`: `FR-059`.
//!
//! A move is registration again for the same key: a fresh slot in the new
//! cell, the old slot left where it is, stake and operator untouched. The old
//! slot stays the sensor's through a pointer — its record still counts
//! towards an exclusion and its earnings are still claimed from the old cell —
//! until a window has passed and it can matter to nothing.
//!
//! The network is three sensors of one operator on the demo cell, with the
//! policy of `tests/rewards.rs` (800 000 over days 23..=30, 2 500 a day to
//! the network); slot 2 is the one that moves, to the neighbour next door,
//! which has no sensor, no ring and no schedule until a test writes one.

mod harness;

use anchor_lang::prelude::Pubkey as AnchorPubkey;
use harness::*;
use pumpking::errors::PumpkingError;
use pumpking::instructions::{DayRecordParams, DayReputationParams, PolicyParams, PoolParams};
use pumpking::state::{CellState, Pool, Sensor, MAX_SENSORS_PER_CELL, REWARD_WEIGHT_UNIT};

const GENESIS_TS: i64 = 1_800_000_000;
const SECONDS_PER_DAY: u32 = 86_400;
const DECIMALS: u8 = 6;
const SOL: u64 = 1_000_000_000;
const MIN_STAKE: u64 = 1_000_000;
const OPERATOR_BALANCE: u64 = 100_000_000;

/// `871e701b3ffffff`, the demo cell — a real res 7 H3 cell.
const CELL_ID: u64 = 0x0871_e701_b3ff_ffff;
/// A res-7 neighbour of the demo cell, in the same pool.
const NEIGHBOUR: u64 = 0x0871_e701_b2ff_ffff;
/// The demo cell one level down: a real cell, off the network's grid.
const RES8_CELL: u64 = 0x0881_e701_b33f_ffff;

const CAPITAL: u64 = 10_000_000;
const NETWORK: u8 = 3;
const FARMER_BALANCE: u64 = 10_000_000;

const HISTORY_DAYS: u32 = 20;
const WINDOW_START: u32 = 23;
const WINDOW_END: u32 = 30;
const NONCE: u64 = 1;
const PAYOUT: u64 = 800_000;
const PREMIUM: u64 = 200_000;

const SLOTS: usize = MAX_SENSORS_PER_CELL as usize;
/// The sensor that moves, and its slot in the demo cell.
const MOVER: u8 = 2;
/// The day it moves on.
const MOVE_DAY: u32 = 24;

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
    key(6)
}
fn operator_tokens() -> AnchorPubkey {
    key(7)
}
fn depositor() -> AnchorPubkey {
    key(9)
}
fn depositor_tokens() -> AnchorPubkey {
    key(10)
}
fn farmer() -> AnchorPubkey {
    key(11)
}
fn farmer_tokens() -> AnchorPubkey {
    key(12)
}
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

/* -------------------------------------------------------------------------- */
/* Instructions                                                               */
/* -------------------------------------------------------------------------- */

fn reputation_pda(cell_id: u64) -> AnchorPubkey {
    AnchorPubkey::find_program_address(
        &[b"reputation", cell_id.to_le_bytes().as_ref()],
        &pumpking::ID,
    )
    .0
}

fn submit_cell_day(cell_id: u64, day_index: u32) -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::SubmitDayRecord {
            aggregator: aggregator(),
            pool: pool_pda(),
            cell: cell_pda(cell_id),
            system_program: system_program_id(),
        },
        pumpking::instruction::SubmitDayRecord {
            params: DayRecordParams {
                cell_id,
                day_index,
                state: 2,
                contributors: 0b111,
                readings_root: [0x5a; 32],
                rainfall_x100: Some(500),
                covered_intervals: 24,
                total_intervals: 24,
            },
        },
    )
}

fn submit_cell_rewards(
    cell_id: u64,
    day_index: u32,
    judged: [u16; SLOTS],
    outliers: [u16; SLOTS],
    weights: [u32; SLOTS],
) -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::SubmitDayReputation {
            aggregator: aggregator(),
            pool: pool_pda(),
            cell: cell_pda(cell_id),
            reputation: reputation_pda(cell_id),
            rewards: rewards_pda(cell_id),
            system_program: system_program_id(),
        },
        pumpking::instruction::SubmitDayReputation {
            params: DayReputationParams {
                cell_id,
                day_index,
                judged,
                outliers,
                weights,
            },
        },
    )
}

fn issue() -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::IssuePolicy {
            owner: farmer(),
            pool: pool_pda(),
            cell: cell_pda(CELL_ID),
            policy: policy_pda(farmer(), NONCE),
            rewards: rewards_pda(CELL_ID),
            asset_mint: asset_mint(),
            vault: vault_pda(),
            owner_tokens: farmer_tokens(),
            token_program: token_program_id(),
            system_program: system_program_id(),
        },
        pumpking::instruction::IssuePolicy {
            params: PolicyParams {
                nonce: NONCE,
                cell_id: CELL_ID,
                spell_days_threshold: 5,
                payout: PAYOUT,
                max_premium: PREMIUM,
                window_start_day: WINDOW_START,
                window_end_day: WINDOW_END,
            },
        },
    )
}

/// `move_sensor`; `left` is the cell the sensor left on its previous move,
/// or its own cell if it never moved.
fn move_to(n: u8, cell_id: u64, left: u64) -> solana_instruction::Instruction {
    move_by(operator(), n, cell_id, left)
}

fn move_by(
    operator: AnchorPubkey,
    n: u8,
    cell_id: u64,
    left: u64,
) -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::MoveSensor {
            operator,
            sensor_key: sensor_key(n),
            pool: pool_pda(),
            sensor: sensor_pda(sensor_key(n)),
            cell: cell_pda(cell_id),
            previous_rewards: rewards_pda(left),
            system_program: system_program_id(),
        },
        pumpking::instruction::MoveSensor { cell_id },
    )
}

fn claim(n: u8, cell_id: u64) -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::ClaimReward {
            caller: stranger(),
            pool: pool_pda(),
            sensor: sensor_pda(sensor_key(n)),
            rewards: rewards_pda(cell_id),
            asset_mint: asset_mint(),
            vault: vault_pda(),
            operator_tokens: operator_tokens(),
            token_program: token_program_id(),
        },
        pumpking::instruction::ClaimReward { cell_id },
    )
}

/// `exclude_sensor`, with the rings and schedules of `cell` and `left`.
fn exclude(n: u8, cell: u64, left: u64) -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::ExcludeSensor {
            caller: stranger(),
            pool: pool_pda(),
            sensor: sensor_pda(sensor_key(n)),
            reputation: reputation_pda(cell),
            previous_reputation: reputation_pda(left),
            rewards: rewards_pda(cell),
            previous_rewards: rewards_pda(left),
            asset_mint: asset_mint(),
            stake_vault: stake_vault_pda(),
            vault: vault_pda(),
            token_program: token_program_id(),
        },
        pumpking::instruction::ExcludeSensor {},
    )
}

fn reinstate(n: u8, cell: u64) -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::ReinstateSensor {
            operator: operator(),
            sensor: sensor_pda(sensor_key(n)),
            reputation: reputation_pda(cell),
        },
        pumpking::instruction::ReinstateSensor {},
    )
}

/* -------------------------------------------------------------------------- */
/* World                                                                      */
/* -------------------------------------------------------------------------- */

/// Writes a day of the demo cell as the aggregator does — the day, then its
/// verdicts and weights — with the mover off in `lies` of its 24 intervals.
/// Every slot that has an accepted interval earns one interval's worth.
/// The clock moves to the day after.
fn write_day(world: &mut World, day: u32, lies: u16) {
    world.set_day(day + 1);
    world.exec_ok(&submit_cell_day(CELL_ID, day));
    let mut judged = [0u16; SLOTS];
    let mut outliers = [0u16; SLOTS];
    let mut weights = [0u32; SLOTS];
    judged[..usize::from(NETWORK)].fill(24);
    weights[..usize::from(NETWORK)].fill(REWARD_WEIGHT_UNIT);
    outliers[usize::from(MOVER)] = lies;
    world.exec_ok(&submit_cell_rewards(
        CELL_ID, day, judged, outliers, weights,
    ));
}

/// The pool, its capital and the three staked sensors of the demo cell;
/// twenty days of history with the mover off in `lies` intervals a day, the
/// policy issued on day 20 and days up to `MOVE_DAY` written. The clock stays
/// on `MOVE_DAY`.
fn insured_world(lies: u16) -> World {
    let mut world = World::new(GENESIS_TS, SECONDS_PER_DAY);
    for wallet in [
        authority(),
        aggregator(),
        operator(),
        stranger(),
        depositor(),
        farmer(),
    ] {
        world.fund(wallet, 10 * SOL);
    }
    world.create_mint(asset_mint(), DECIMALS, Some(minter()));
    world.create_token_account(
        operator_tokens(),
        asset_mint(),
        operator(),
        OPERATOR_BALANCE,
    );
    world.create_token_account(depositor_tokens(), asset_mint(), depositor(), CAPITAL);
    world.create_token_account(farmer_tokens(), asset_mint(), farmer(), FARMER_BALANCE);

    world.exec_ok(&instruction(
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
    ));
    world.exec_ok(&instruction(
        pumpking::accounts::DepositCapital {
            depositor: depositor(),
            pool: pool_pda(),
            asset_mint: asset_mint(),
            vault: vault_pda(),
            depositor_tokens: depositor_tokens(),
            position: position_pda(depositor()),
            token_program: token_program_id(),
            system_program: system_program_id(),
        },
        pumpking::instruction::DepositCapital { amount: CAPITAL },
    ));

    for n in 0..NETWORK {
        world.exec_ok(&instruction(
            pumpking::accounts::RegisterSensor {
                operator: operator(),
                sensor_key: sensor_key(n),
                pool: pool_pda(),
                cell: cell_pda(CELL_ID),
                sensor: sensor_pda(sensor_key(n)),
                system_program: system_program_id(),
            },
            pumpking::instruction::RegisterSensor { cell_id: CELL_ID },
        ));
        world.exec_ok(&instruction(
            pumpking::accounts::StakeSensor {
                operator: operator(),
                pool: pool_pda(),
                sensor: sensor_pda(sensor_key(n)),
                asset_mint: asset_mint(),
                stake_vault: stake_vault_pda(),
                operator_tokens: operator_tokens(),
                token_program: token_program_id(),
            },
            pumpking::instruction::StakeSensor { amount: MIN_STAKE },
        ));
    }

    for day in 0..HISTORY_DAYS {
        write_day(&mut world, day, lies);
    }
    world.set_day(HISTORY_DAYS);
    world.exec_ok(&issue());
    for day in HISTORY_DAYS..MOVE_DAY {
        write_day(&mut world, day, lies);
    }
    world
}

fn sensor(world: &World, n: u8) -> Sensor {
    world.read(sensor_pda(sensor_key(n)))
}

/// The vault holds capital and the demo cell's reward money, and nothing else.
fn assert_vault_matches_books(world: &World) {
    let pool: Pool = world.read(pool_pda());
    assert_eq!(
        token_amount(world.account(vault_pda())),
        pool.capital_total + world.read_rewards(CELL_ID).reserve,
        "the vault and the books disagree"
    );
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

#[test]
fn a_move_takes_a_fresh_slot_and_leaves_the_old_cell_as_it_was() {
    let mut world = insured_world(0);
    let old_cell = world.account(cell_pda(CELL_ID)).data.clone();
    let staked = token_amount(world.account(stake_vault_pda()));

    world.exec_ok(&move_to(MOVER, NEIGHBOUR, CELL_ID));

    let moved = sensor(&world, MOVER);
    assert_eq!(moved.cell_id, NEIGHBOUR);
    assert_eq!(
        moved.slot_in_cell, 0,
        "the first slot of a cell nobody was in"
    );
    assert_eq!(moved.previous(), Some((CELL_ID, MOVER)));
    assert_eq!(
        moved.moved_at,
        Some(world.mollusk.sysvars.clock.unix_timestamp)
    );
    // FR-059: stake and operator stay with the sensor.
    assert_eq!(moved.operator, operator());
    assert_eq!(moved.stake, MIN_STAKE);
    assert!(moved.active);
    assert_eq!(token_amount(world.account(stake_vault_pda())), staked);

    let cell: CellState = world.read(cell_pda(NEIGHBOUR));
    assert_eq!(cell.cell_id, NEIGHBOUR);
    assert_eq!(cell.sensor_count, 1);
    // The old slot is not handed back: its bit in the days already written
    // says who voted, and the cell's count of slots does not shrink.
    assert_eq!(world.account(cell_pda(CELL_ID)).data, old_cell);
    let left: CellState = world.read(cell_pda(CELL_ID));
    assert_eq!(left.sensor_count, NETWORK);
    assert!(left.slot_voted(MOVE_DAY - 1, MOVER));
}

#[test]
fn the_operator_and_the_sensor_key_both_sign_the_move() {
    let mut world = insured_world(0);
    world.exec_err(
        &move_by(stranger(), MOVER, NEIGHBOUR, CELL_ID),
        PumpkingError::NotTheOperator,
    );

    let mut ix = move_to(MOVER, NEIGHBOUR, CELL_ID);
    let meta = ix
        .accounts
        .iter_mut()
        .find(|meta| meta.pubkey == svm(sensor_key(MOVER)))
        .expect("the sensor key is an account of the instruction");
    meta.is_signer = false;
    world.exec_anchor_err(&ix, anchor_lang::error::ErrorCode::AccountNotSigner);

    assert_eq!(sensor(&world, MOVER).cell_id, CELL_ID);
    assert!(!world.exists(cell_pda(NEIGHBOUR)));
}

#[test]
fn a_move_goes_to_another_cell_on_the_grid_and_nowhere_else() {
    let mut world = insured_world(0);
    world.exec_err(
        &move_to(MOVER, CELL_ID, CELL_ID),
        PumpkingError::SensorAlreadyInCell,
    );
    world.exec_err(
        &move_to(MOVER, RES8_CELL, CELL_ID),
        PumpkingError::WrongGridResolution,
    );
    world.exec_err(
        &move_to(MOVER, 0x8712_3456_789a_bcdf, CELL_ID),
        PumpkingError::NotAnH3Cell,
    );
}

#[test]
fn what_the_old_slot_earned_is_claimed_from_the_old_cell() {
    let mut world = insured_world(0);
    world.exec_ok(&move_to(MOVER, NEIGHBOUR, CELL_ID));
    // The old cell writes the day of the move after it: the intervals the
    // sensor carried there before it left still earn in the old slot.
    write_day(&mut world, MOVE_DAY, 0);
    let earned = world.read_rewards(CELL_ID).accrued[usize::from(MOVER)];
    assert!(earned > 0);

    // The neighbour opens its schedule with the mover's first day there.
    let mut judged = [0u16; SLOTS];
    judged[0] = 24;
    world.exec_ok(&submit_cell_day(NEIGHBOUR, MOVE_DAY));
    world.exec_ok(&submit_cell_rewards(
        NEIGHBOUR, MOVE_DAY, judged, [0; SLOTS], [0; SLOTS],
    ));
    world.exec_err(&claim(MOVER, NEIGHBOUR), PumpkingError::NothingToClaim);
    // A sensor that never held a slot in a cell claims nothing from it.
    world.exec_err(&claim(0, NEIGHBOUR), PumpkingError::NotTheSensorsCell);

    let before = token_amount(world.account(operator_tokens()));
    world.exec_ok(&claim(MOVER, CELL_ID));
    assert_eq!(
        token_amount(world.account(operator_tokens())),
        before + earned
    );
    assert_eq!(world.read_rewards(CELL_ID).accrued[usize::from(MOVER)], 0);
    assert_vault_matches_books(&world);
}

#[test]
fn the_next_move_waits_a_window_and_for_the_old_slot_to_be_claimed() {
    let mut world = insured_world(0);
    world.exec_ok(&move_to(MOVER, NEIGHBOUR, CELL_ID));

    // The old slot voted on the day of the move, and the window on day
    // MOVE_DAY + 14 still reads back to it.
    world.set_day(MOVE_DAY + 14);
    world.exec_err(
        &move_to(MOVER, CELL_ID, CELL_ID),
        PumpkingError::MovedTooRecently,
    );
    world.set_day(MOVE_DAY + 15);
    world.exec_err(
        &move_to(MOVER, CELL_ID, CELL_ID),
        PumpkingError::PreviousSlotUnclaimed,
    );

    world.exec_ok(&claim(MOVER, CELL_ID));
    world.exec_ok(&move_to(MOVER, CELL_ID, CELL_ID));

    // Back in the demo cell, on a slot of its own: the one it left stays
    // history, and the pointer now names the neighbour.
    let back = sensor(&world, MOVER);
    assert_eq!(back.cell_id, CELL_ID);
    assert_eq!(back.slot_in_cell, NETWORK);
    assert_eq!(back.previous(), Some((NEIGHBOUR, 0)));
    let cell: CellState = world.read(cell_pda(CELL_ID));
    assert_eq!(cell.sensor_count, NETWORK + 1);
}

#[test]
fn the_record_it_brought_along_excludes_it_where_it_has_none_yet() {
    // 5 of 24 a day is over a fifth; the mover leaves for a cell with no ring
    // and no schedule, carrying fourteen days of it.
    let mut world = insured_world(5);
    let earned = world.read_rewards(CELL_ID).accrued[usize::from(MOVER)];
    assert!(earned > 0);
    world.exec_ok(&move_to(MOVER, NEIGHBOUR, CELL_ID));
    assert!(!world.exists(reputation_pda(NEIGHBOUR)));
    assert!(!world.exists(rewards_pda(NEIGHBOUR)));

    // The ring left behind is the seeds', not the caller's choice: passing
    // the new cell's in its place is refused rather than read as no record.
    world.exec_anchor_err(
        &exclude(MOVER, NEIGHBOUR, NEIGHBOUR),
        anchor_lang::error::ErrorCode::ConstraintSeeds,
    );

    let before: Pool = world.read(pool_pda());
    world.exec_ok(&exclude(MOVER, NEIGHBOUR, CELL_ID));

    let pool: Pool = world.read(pool_pda());
    // The stake burns, and what the old slot had not claimed goes with it.
    assert_eq!(
        pool.capital_total,
        before.capital_total + MIN_STAKE + earned
    );
    assert_eq!(world.read_rewards(CELL_ID).accrued[usize::from(MOVER)], 0);
    let excluded = sensor(&world, MOVER);
    assert!(!excluded.active);
    // Days 10..=23, the window on the day of the move: 14 × 5 of 14 × 24.
    assert_eq!(excluded.outliers, 70);
    assert_eq!(excluded.accepted, 336 - 70);
    assert_vault_matches_books(&world);
}

#[test]
fn the_clean_slate_is_the_reinstatement_and_not_the_move() {
    let mut world = insured_world(5);
    world.exec_ok(&move_to(MOVER, NEIGHBOUR, CELL_ID));
    world.exec_ok(&exclude(MOVER, NEIGHBOUR, CELL_ID));

    // The new cell has no ring to clear yet, and that is no obstacle.
    world.exec_ok(&reinstate(MOVER, NEIGHBOUR));
    let back = sensor(&world, MOVER);
    assert!(back.active);
    assert_eq!(back.previous(), None);
    // The date stays, and keeps spacing the next move.
    assert!(back.moved_at.is_some());

    world.exec_err(
        &exclude(MOVER, NEIGHBOUR, NEIGHBOUR),
        PumpkingError::OutlierShareNotBreached,
    );
    world.exec_err(
        &move_to(MOVER, CELL_ID, NEIGHBOUR),
        PumpkingError::MovedTooRecently,
    );
}
