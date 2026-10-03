//! The reward schedule over the built `.so` — `T036`, `T037`: `FR-036`,
//! `FR-062`, `FR-063`, `FR-064`.
//!
//! A policy's reward share is laid out over the days of its window; each day,
//! in the transaction that writes it, pays its budget to the slots by the
//! aggregator's weights, or returns it to capital when nobody earned it — the
//! days nobody wrote included. What a slot earned waits until anyone claims it
//! to the operator's account, and is forfeited to capital if the sensor is
//! excluded first. A payout part-way through the window changes none of it.
//!
//! The network is three sensors of one operator, registered and staked on the
//! demo cell (a second network of three in its neighbour, where a test asks
//! for one); the policy pays 800 000 over days 23..=30 at 2500 bps, so its
//! premium is 200 000, the reward share 20 000 and each day's budget 2 500.

mod harness;

use anchor_lang::prelude::Pubkey as AnchorPubkey;
use anchor_lang::AccountSerialize;
use harness::*;
use pumpking::errors::PumpkingError;
use pumpking::instructions::{DayRecordParams, DayReputationParams, PolicyParams, PoolParams};
use pumpking::state::{
    CellState, Pool, Sensor, MAX_SENSORS_PER_CELL, REWARD_SCHEDULE_DAYS, REWARD_WEIGHT_UNIT,
};

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

const CAPITAL: u64 = 10_000_000;
const NETWORK: u8 = 3;
const FARMER_BALANCE: u64 = 10_000_000;

const HISTORY_DAYS: u32 = 20;
const WINDOW_START: u32 = 23;
const WINDOW_END: u32 = 30;
const SPELL_THRESHOLD: u8 = 5;
const NONCE: u64 = 1;

/// Four dry days in twenty price cover at 2500 bps.
const PAYOUT: u64 = 800_000;
const PREMIUM: u64 = 200_000;
/// `premium_rewards_bps` = 1000.
const REWARD_SHARE: u64 = PREMIUM / 10;
const DAY_BUDGET: u64 = REWARD_SHARE / (WINDOW_END - WINDOW_START + 1) as u64;

const SLOTS: usize = MAX_SENSORS_PER_CELL as usize;
/// The slot that lies in the exclusion test.
const LIAR: u8 = 2;

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
fn stranger_tokens() -> AnchorPubkey {
    key(8)
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

fn submit_day(day_index: u32, dry: bool) -> solana_instruction::Instruction {
    submit_cell_day(CELL_ID, day_index, dry)
}

fn submit_cell_day(cell_id: u64, day_index: u32, dry: bool) -> solana_instruction::Instruction {
    submit_record(DayRecordParams {
        cell_id,
        day_index,
        state: if dry { 1 } else { 2 },
        contributors: 0b111,
        readings_root: [0x5a; 32],
        rainfall_x100: Some(if dry { 0 } else { 500 }),
        covered_intervals: 24,
        total_intervals: 24,
    })
}

/// A day the network did not measure.
fn submit_silent_day(day_index: u32) -> solana_instruction::Instruction {
    submit_record(DayRecordParams {
        cell_id: CELL_ID,
        day_index,
        state: 0,
        contributors: 0,
        readings_root: [0; 32],
        rainfall_x100: None,
        covered_intervals: 0,
        total_intervals: 24,
    })
}

fn submit_record(params: DayRecordParams) -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::SubmitDayRecord {
            aggregator: aggregator(),
            pool: pool_pda(),
            cell: cell_pda(params.cell_id),
            system_program: system_program_id(),
        },
        pumpking::instruction::SubmitDayRecord { params },
    )
}

fn submit_rewards(
    day_index: u32,
    judged: [u16; SLOTS],
    outliers: [u16; SLOTS],
    weights: [u32; SLOTS],
) -> solana_instruction::Instruction {
    submit_cell_rewards(CELL_ID, day_index, judged, outliers, weights)
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

fn issue(nonce: u64, start: u32, end: u32) -> solana_instruction::Instruction {
    let params = PolicyParams {
        nonce,
        cell_id: CELL_ID,
        spell_days_threshold: SPELL_THRESHOLD,
        payout: PAYOUT,
        max_premium: PREMIUM,
        window_start_day: start,
        window_end_day: end,
    };
    instruction(
        pumpking::accounts::IssuePolicy {
            owner: farmer(),
            pool: pool_pda(),
            cell: cell_pda(CELL_ID),
            policy: policy_pda(farmer(), nonce),
            rewards: rewards_pda(CELL_ID),
            asset_mint: asset_mint(),
            vault: vault_pda(),
            owner_tokens: farmer_tokens(),
            token_program: token_program_id(),
            system_program: system_program_id(),
        },
        pumpking::instruction::IssuePolicy { params },
    )
}

fn settle() -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::SettlePolicy {
            caller: stranger(),
            pool: pool_pda(),
            cell: cell_pda(CELL_ID),
            policy: policy_pda(farmer(), NONCE),
            asset_mint: asset_mint(),
            vault: vault_pda(),
            owner_tokens: farmer_tokens(),
            token_program: token_program_id(),
        },
        pumpking::instruction::SettlePolicy {},
    )
}

fn claim_reward(sensor: AnchorPubkey, to: AnchorPubkey) -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::ClaimReward {
            caller: stranger(),
            pool: pool_pda(),
            sensor: sensor_pda(sensor),
            rewards: rewards_pda(CELL_ID),
            asset_mint: asset_mint(),
            vault: vault_pda(),
            operator_tokens: to,
            token_program: token_program_id(),
        },
        pumpking::instruction::ClaimReward {},
    )
}

fn exclude(sensor: AnchorPubkey) -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::ExcludeSensor {
            caller: stranger(),
            pool: pool_pda(),
            sensor: sensor_pda(sensor),
            reputation: reputation_pda(CELL_ID),
            rewards: rewards_pda(CELL_ID),
            asset_mint: asset_mint(),
            stake_vault: stake_vault_pda(),
            vault: vault_pda(),
            token_program: token_program_id(),
        },
        pumpking::instruction::ExcludeSensor {},
    )
}

/* -------------------------------------------------------------------------- */
/* World                                                                      */
/* -------------------------------------------------------------------------- */

/// The network's verdicts for a day: every slot judged in all 24 intervals,
/// the liar an outlier in `lies` of them.
fn verdicts(lies: u16) -> ([u16; SLOTS], [u16; SLOTS]) {
    let mut judged = [0u16; SLOTS];
    let mut outliers = [0u16; SLOTS];
    judged[..usize::from(NETWORK)].fill(24);
    outliers[usize::from(LIAR)] = lies;
    (judged, outliers)
}

/// Weights for slots 0, 1, 2, in units of a whole interval.
fn weights(units: [u32; 3]) -> [u32; SLOTS] {
    let mut out = [0u32; SLOTS];
    for (slot, n) in units.into_iter().enumerate() {
        out[slot] = n * REWARD_WEIGHT_UNIT;
    }
    out
}

/// Writes a whole day as the aggregator does: the day, then its verdicts and
/// weights in the same breath. The clock moves to the day after.
fn write_day(world: &mut World, day: u32, dry: bool, lies: u16, units: [u32; 3]) {
    write_cell_day(world, CELL_ID, day, dry, lies, units);
}

fn write_cell_day(
    world: &mut World,
    cell_id: u64,
    day: u32,
    dry: bool,
    lies: u16,
    units: [u32; 3],
) {
    world.set_day(day + 1);
    world.exec_ok(&submit_cell_day(cell_id, day, dry));
    let (judged, outliers) = verdicts(lies);
    world.exec_ok(&submit_cell_rewards(
        cell_id,
        day,
        judged,
        outliers,
        weights(units),
    ));
}

/// A pool with capital and the three-sensor network registered and staked —
/// no day written yet.
fn bare_network() -> World {
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
    world.create_token_account(stranger_tokens(), asset_mint(), stranger(), 0);
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

    register_network(&mut world, CELL_ID, 0);
    world
}

/// Three sensors of the operator in `cell_id`, keys from `first` on,
/// registered and staked.
fn register_network(world: &mut World, cell_id: u64, first: u8) {
    for n in first..first + NETWORK {
        world.exec_ok(&instruction(
            pumpking::accounts::RegisterSensor {
                operator: operator(),
                sensor_key: sensor_key(n),
                pool: pool_pda(),
                cell: cell_pda(cell_id),
                sensor: sensor_pda(sensor_key(n)),
                system_program: system_program_id(),
            },
            pumpking::instruction::RegisterSensor { cell_id },
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
}

/// The network with twenty days of history written whole — the liar off in
/// `lies` intervals a day. The clock stays on day `HISTORY_DAYS`.
fn network_world(lies: u16) -> World {
    let mut world = bare_network();
    for day in 0..HISTORY_DAYS {
        write_day(
            &mut world,
            day,
            matches!(day, 3 | 8 | 14 | 19),
            lies,
            [1, 1, 1],
        );
    }
    world.set_day(HISTORY_DAYS);
    world
}

/// The network plus the policy, issued on day `HISTORY_DAYS`, and the three
/// days before its window written. The clock stays on day `WINDOW_START`.
fn insured_world(lies: u16) -> World {
    let mut world = network_world(lies);
    world.exec_ok(&issue(NONCE, WINDOW_START, WINDOW_END));
    for day in HISTORY_DAYS..WINDOW_START {
        write_day(&mut world, day, false, lies, [1, 1, 1]);
    }
    world
}

/// The vault holds capital and the cell's reward money, and nothing else.
fn assert_vault_matches_books(world: &World) {
    let pool: Pool = world.read(pool_pda());
    assert_eq!(
        token_amount(world.account(vault_pda())),
        pool.capital_total + world.read_rewards(CELL_ID).reserve,
        "the vault and the books disagree"
    );
}

/// The reward schedule balances: reserve = scheduled + earned.
fn assert_schedule_balances(world: &World) {
    let rewards = world.read_rewards(CELL_ID);
    let scheduled: u64 = rewards.schedule.iter().sum();
    let accrued: u64 = rewards.accrued.iter().sum();
    assert_eq!(rewards.reserve, scheduled + accrued);
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

#[test]
fn a_cell_without_a_policy_earns_nothing() {
    // FR-063: twenty covered days with weights on every slot, and no policy —
    // an empty schedule pays nobody, and returns nothing because there was
    // nothing to return.
    let world = network_world(0);
    let rewards = world.read_rewards(CELL_ID);
    assert_eq!(rewards.cell_id, CELL_ID);
    assert_eq!(rewards.next_day, HISTORY_DAYS);
    assert_eq!(rewards.reserve, 0);
    assert_eq!(rewards.accrued, [0; SLOTS]);
    let pool: Pool = world.read(pool_pda());
    assert_eq!(pool.capital_total, CAPITAL);
}

#[test]
fn a_cell_beside_an_insured_one_earns_nothing() {
    // FR-063 within one pool: the reserve belongs to the cell (FR-062), so a
    // neighbour measuring the same days with the same weights earns nothing
    // from the policy next door, and the insured cell pays as it would alone.
    let mut world = network_world(0);
    register_network(&mut world, NEIGHBOUR, NETWORK);
    world.exec_ok(&issue(NONCE, WINDOW_START, WINDOW_END));
    for day in HISTORY_DAYS..=WINDOW_END {
        write_day(&mut world, day, false, 0, [1, 1, 1]);
        write_cell_day(&mut world, NEIGHBOUR, day, false, 0, [1, 1, 1]);
    }

    let neighbour = world.read_rewards(NEIGHBOUR);
    assert_eq!(neighbour.cell_id, NEIGHBOUR);
    assert_eq!(neighbour.next_day, WINDOW_END + 1, "every day was paid");
    assert_eq!(neighbour.reserve, 0);
    assert_eq!(neighbour.accrued, [0; SLOTS]);

    // The control: the same days earned the insured cell its whole share.
    let insured = world.read_rewards(CELL_ID);
    assert_eq!(
        insured.accrued.iter().sum::<u64>(),
        REWARD_SHARE - 8 * (DAY_BUDGET % 3)
    );
    assert_vault_matches_books(&world);
}

#[test]
fn a_cell_whose_policy_has_closed_earns_nothing_after_it() {
    // FR-063 once the last policy is over: the window passed without the
    // event, the policy closed, and ten more covered days with weights on
    // every slot pay nobody and return nothing — nothing is scheduled.
    let mut world = insured_world(0);
    for day in WINDOW_START..=WINDOW_END {
        write_day(&mut world, day, false, 0, [1, 1, 1]);
    }
    world.exec_ok(&instruction(
        pumpking::accounts::ClosePolicy {
            caller: stranger(),
            pool: pool_pda(),
            cell: cell_pda(CELL_ID),
            policy: policy_pda(farmer(), NONCE),
        },
        pumpking::instruction::ClosePolicy {},
    ));
    let closed = world.read_rewards(CELL_ID);
    // The control: the window did pay, so the silence after it is the rule.
    assert_eq!(
        closed.accrued.iter().sum::<u64>(),
        REWARD_SHARE - 8 * (DAY_BUDGET % 3)
    );
    let before: Pool = world.read(pool_pda());

    let after_window = WINDOW_END + 1;
    for day in after_window..after_window + 10 {
        write_day(&mut world, day, false, 0, [1, 1, 1]);
    }

    let rewards = world.read_rewards(CELL_ID);
    assert_eq!(rewards.next_day, after_window + 10, "every day was paid");
    assert_eq!(rewards.accrued, closed.accrued);
    assert_eq!(rewards.reserve, closed.reserve);
    let pool: Pool = world.read(pool_pda());
    assert_eq!(pool.capital_total, before.capital_total);
    assert_schedule_balances(&world);
    assert_vault_matches_books(&world);
}

#[test]
fn a_policy_lays_its_reward_share_over_the_days_of_its_window() {
    let mut world = network_world(0);
    world.exec_ok(&issue(NONCE, WINDOW_START, WINDOW_END));

    let rewards = world.read_rewards(CELL_ID);
    assert_eq!(rewards.reserve, REWARD_SHARE);
    for day in WINDOW_START..=WINDOW_END {
        assert_eq!(rewards.budget_of(day), DAY_BUDGET, "day {day}");
    }
    assert_eq!(rewards.budget_of(WINDOW_START - 1), 0);
    assert_eq!(rewards.budget_of(WINDOW_END + 1), 0);

    let cell: CellState = world.read(cell_pda(CELL_ID));
    assert_eq!(
        cell.rewards_reserve, 0,
        "the reserve lives in the schedule now"
    );
    let pool: Pool = world.read(pool_pda());
    assert_eq!(pool.capital_total, CAPITAL + PREMIUM - REWARD_SHARE);
    assert_vault_matches_books(&world);
}

#[test]
fn a_covered_day_pays_the_slots_by_weight() {
    let mut world = insured_world(0);
    write_day(&mut world, WINDOW_START, false, 0, [2, 1, 1]);

    let rewards = world.read_rewards(CELL_ID);
    assert_eq!(
        rewards.accrued[..3],
        [DAY_BUDGET / 2, DAY_BUDGET / 4, DAY_BUDGET / 4]
    );
    assert_eq!(rewards.next_day, WINDOW_START + 1);
    assert_eq!(rewards.reserve, REWARD_SHARE);
    assert_schedule_balances(&world);
    assert_vault_matches_books(&world);
}

#[test]
fn a_day_without_coverage_returns_its_budget_to_capital() {
    // FR-064, without waiting for the policy to close.
    let mut world = insured_world(0);
    let before: Pool = world.read(pool_pda());

    world.set_day(WINDOW_START + 1);
    world.exec_ok(&submit_silent_day(WINDOW_START));
    world.exec_ok(&submit_rewards(
        WINDOW_START,
        [0; SLOTS],
        [0; SLOTS],
        [0; SLOTS],
    ));

    let pool: Pool = world.read(pool_pda());
    assert_eq!(pool.capital_total, before.capital_total + DAY_BUDGET);
    assert_eq!(pool.shares_total, before.shares_total);
    let rewards = world.read_rewards(CELL_ID);
    assert_eq!(rewards.accrued, [0; SLOTS]);
    assert_eq!(rewards.reserve, REWARD_SHARE - DAY_BUDGET);
    assert_schedule_balances(&world);
    assert_vault_matches_books(&world);
}

#[test]
fn days_nobody_wrote_go_back_to_capital_with_the_next_day_paid() {
    // The aggregator was down through days 23 and 24 and its backlog did not
    // reach them: on chain they are days without coverage, and their budget
    // goes back the moment day 25 is paid.
    let mut world = insured_world(0);
    let before: Pool = world.read(pool_pda());

    write_day(&mut world, WINDOW_START + 2, false, 0, [1, 1, 1]);

    let pool: Pool = world.read(pool_pda());
    // Two skipped days, and the unit of dust the three-way split leaves.
    assert_eq!(
        pool.capital_total,
        before.capital_total + 2 * DAY_BUDGET + DAY_BUDGET % 3
    );
    let rewards = world.read_rewards(CELL_ID);
    assert_eq!(rewards.accrued[..3], [DAY_BUDGET / 3; 3]);
    assert_eq!(rewards.next_day, WINDOW_START + 3);
    assert_schedule_balances(&world);
    assert_vault_matches_books(&world);
}

#[test]
fn the_schedule_keeps_paying_after_the_payout_and_the_operator_collects_it() {
    // The spell pays the farmer on day 28; days 28..=30 still pay the network.
    // A network whose income stopped at the event would have a reason not to
    // report one.
    let mut world = insured_world(0);
    for day in WINDOW_START..WINDOW_START + u32::from(SPELL_THRESHOLD) {
        write_day(&mut world, day, true, 0, [1, 1, 1]);
    }
    world.exec_ok(&settle());
    for day in WINDOW_START + u32::from(SPELL_THRESHOLD)..=WINDOW_END {
        write_day(&mut world, day, false, 0, [2, 1, 1]);
    }

    let rewards = world.read_rewards(CELL_ID);
    assert_eq!(
        rewards.schedule.iter().sum::<u64>(),
        0,
        "every day was paid"
    );
    let earned: u64 = rewards.accrued.iter().sum();
    let pool: Pool = world.read(pool_pda());
    // Five days split three ways leave a unit each; the rest is earned.
    assert_eq!(earned, REWARD_SHARE - 5 * (DAY_BUDGET % 3));
    assert_vault_matches_books(&world);
    assert_eq!(pool.reserved_total, 0, "the policy was paid");

    let before = token_amount(world.account(operator_tokens()));
    for n in 0..NETWORK {
        world.exec_ok(&claim_reward(sensor_key(n), operator_tokens()));
    }
    assert_eq!(
        token_amount(world.account(operator_tokens())),
        before + earned
    );
    let rewards = world.read_rewards(CELL_ID);
    assert_eq!(rewards.reserve, 0);
    assert_eq!(rewards.accrued, [0; SLOTS]);
    assert_vault_matches_books(&world);

    world.exec_err(
        &claim_reward(sensor_key(0), operator_tokens()),
        PumpkingError::NothingToClaim,
    );
}

#[test]
fn a_reward_goes_to_the_operator_and_nobody_else() {
    let mut world = insured_world(0);
    write_day(&mut world, WINDOW_START, false, 0, [1, 1, 1]);
    world.exec_anchor_err(
        &claim_reward(sensor_key(0), stranger_tokens()),
        anchor_lang::error::ErrorCode::ConstraintTokenOwner,
    );
    assert_eq!(token_amount(world.account(stranger_tokens())), 0);
}

#[test]
fn a_weight_on_a_slot_that_earned_nothing_is_refused() {
    let mut world = insured_world(0);
    world.set_day(WINDOW_START + 1);
    world.exec_ok(&submit_day(WINDOW_START, false));
    // The liar was an outlier in every interval it was judged in.
    let (judged, outliers) = verdicts(24);
    world.exec_err(
        &submit_rewards(WINDOW_START, judged, outliers, weights([1, 1, 1])),
        PumpkingError::WeightWithoutAcceptedInterval,
    );
    // More than its accepted intervals can carry.
    let (judged, outliers) = verdicts(0);
    world.exec_err(
        &submit_rewards(WINDOW_START, judged, outliers, weights([25, 1, 1])),
        PumpkingError::WeightTooLarge,
    );
}

#[test]
fn a_window_has_to_end_inside_the_schedule_horizon() {
    // The schedule's first unpaid day is 20, so the last day it can hold is
    // 20 + 512 − 1. A 90-day window ending there is a season ahead, and fine;
    // one day later is refused instead of landing on day 20's slot.
    let mut world = network_world(0);
    let last = HISTORY_DAYS + u32::from(REWARD_SCHEDULE_DAYS) - 1;
    world.exec_err(
        &issue(NONCE, last + 1 - 89, last + 1),
        PumpkingError::WindowTooFarAhead,
    );
    world.exec_ok(&issue(NONCE + 1, last - 89, last));
    let rewards = world.read_rewards(CELL_ID);
    assert_eq!(rewards.budget_of(last), REWARD_SHARE / 90);
    assert_eq!(rewards.budget_of(HISTORY_DAYS), 0);
}

#[test]
fn an_excluded_sensor_forfeits_what_it_had_not_claimed() {
    // 5 lies in 24 a day: over a fifth, and still 19 accepted intervals a day
    // that earn.
    let mut world = insured_world(5);
    write_day(&mut world, WINDOW_START, false, 5, [1, 1, 1]);
    let earned = world.read_rewards(CELL_ID).accrued[usize::from(LIAR)];
    assert!(earned > 0);
    let before: Pool = world.read(pool_pda());

    world.exec_ok(&exclude(sensor_key(LIAR)));

    let pool: Pool = world.read(pool_pda());
    assert_eq!(
        pool.capital_total,
        before.capital_total + MIN_STAKE + earned
    );
    let rewards = world.read_rewards(CELL_ID);
    assert_eq!(rewards.accrued[usize::from(LIAR)], 0);
    let sensor: Sensor = world.read(sensor_pda(sensor_key(LIAR)));
    assert!(!sensor.active);
    assert_schedule_balances(&world);
    assert_vault_matches_books(&world);

    world.exec_err(
        &claim_reward(sensor_key(LIAR), operator_tokens()),
        PumpkingError::SensorExcluded,
    );
}

#[test]
fn opening_the_schedule_returns_the_reserve_from_before_it_to_capital() {
    // A cell of the demo pool carries reward money from policies sold before
    // `T036`. No day was ever scheduled for it, so no day could pay it: the
    // first rewards half takes it into capital. The reserve is laid into the
    // cell by hand — the one state no instruction writes any more.
    const LEGACY: u64 = 777;
    let mut world = bare_network();
    world.set_day(1);
    world.exec_ok(&submit_day(0, false));

    let mut cell: CellState = world.read(cell_pda(CELL_ID));
    cell.rewards_reserve = LEGACY;
    let mut data = Vec::new();
    cell.try_serialize(&mut data).unwrap();
    let mut account = world.account(cell_pda(CELL_ID)).clone();
    account.data[..data.len()].copy_from_slice(&data);
    world.set_account(cell_pda(CELL_ID), account);
    let before: Pool = world.read(pool_pda());

    world.exec_ok(&submit_rewards(0, [0; SLOTS], [0; SLOTS], [0; SLOTS]));

    let pool: Pool = world.read(pool_pda());
    assert_eq!(pool.capital_total, before.capital_total + LEGACY);
    let cell: CellState = world.read(cell_pda(CELL_ID));
    assert_eq!(cell.rewards_reserve, 0);
    let rewards = world.read_rewards(CELL_ID);
    assert_eq!(rewards.next_day, 1);
    assert_eq!(rewards.reserve, 0);
}
