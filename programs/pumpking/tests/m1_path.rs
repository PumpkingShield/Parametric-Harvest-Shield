//! Шлях M1 у справжньому рантаймі: пул → капітал → журнал діб → поліс →
//! виплата.
//!
//! `T028` довів, що ланцюг **отримав би** правильні інструкції. Тут перевіряється
//! те, чого той тест не міг: що ланцюг їх **виконує**. Різниця не теоретична —
//! `init`, сіди, `token::authority` і підпис PDA у CPI не мають жодного
//! представлення у чистих функціях, і жоден із дотеперішніх 120 юніт-тестів
//! не впав би, якби кожен із них був виведений неправильно.
//!
//! Сценарій один на весь файл і будується вперед: кожен тест бере світ рівно
//! настільки готовий, наскільки йому треба, і всі попередні кроки в ньому —
//! справжні виконані інструкції, а не викладений руками стан. Там, де стан
//! таки викладається руками, це сказано в коментарі й названо причину.

mod harness;

use anchor_lang::prelude::Pubkey as AnchorPubkey;
use harness::*;
use pumpking::errors::PumpkingError;
use pumpking::instructions::{DayRecordParams, PolicyParams, PoolParams};
use pumpking::state::{CapitalPosition, CellState, Policy, PolicyState, Pool};

/* -------------------------------------------------------------------------- */
/* Сценарій                                                                   */
/* -------------------------------------------------------------------------- */

/// Мить генезису. Число довільне, але фіксоване: індекс доби — це різниця, і
/// невідтворюваний старт зробив би невідтворюваним кожне вікно поліса.
const GENESIS_TS: i64 = 1_800_000_000;
/// Продакшн-доба. Стиснений час (`FR-049`) — параметр того самого пулу, і
/// перевіряти його тут нема чого: годинник тесту й так наш.
const SECONDS_PER_DAY: u32 = 86_400;
const DECIMALS: u8 = 6;

/// H3 res 7 — комірка, на якій продається поліс.
const CELL_ID: u64 = 0x8712_3456_789a_bcdf;
const NONCE: u64 = 7;

/// Скільки капіталу вносить вкладник і що коштує поліс. Числа зведені так,
/// щоб виплата стояла **рівно** на межі ліміту експозиції: 10% від
/// 10 000 000 — це 1 000 000, тобто `FR-020` перевіряється на своєму краю, а
/// не десь усередині запасу.
const CAPITAL: u64 = 10_000_000;
const PAYOUT: u64 = 1_000_000;
/// Частота 4 сухі доби з 20 покритих = 2000 bps; ставка
/// 2000 × (10000 + 2500) / 10000 = 2500 bps; премія ceil(1 000 000 × 0,25).
const PREMIUM: u64 = 250_000;
const FARMER_BALANCE: u64 = 1_000_000;

const HISTORY_DAYS: u32 = 20;
const WINDOW_START: u32 = 23;
const WINDOW_END: u32 = 30;
const SPELL_THRESHOLD: u8 = 5;

const SOL: u64 = 1_000_000_000;

fn authority() -> AnchorPubkey {
    key(1)
}
fn aggregator() -> AnchorPubkey {
    key(2)
}
/// `FR-057`: ключ емісії активу не має жодної влади в пулі.
fn minter() -> AnchorPubkey {
    key(3)
}
fn depositor() -> AnchorPubkey {
    key(4)
}
fn farmer() -> AnchorPubkey {
    key(5)
}
fn stranger() -> AnchorPubkey {
    key(6)
}
fn asset_mint() -> AnchorPubkey {
    key(7)
}
fn depositor_tokens() -> AnchorPubkey {
    key(8)
}
fn farmer_tokens() -> AnchorPubkey {
    key(9)
}
fn stranger_tokens() -> AnchorPubkey {
    key(10)
}

/// Доби історії, які цінує `price_of`. Чотири сухі з двадцяти — це та сама
/// двадцятка, з якої виходить `PREMIUM`.
fn history_is_dry(day: u32) -> bool {
    matches!(day, 3 | 8 | 14 | 19)
}

fn pool_params() -> PoolParams {
    PoolParams {
        aggregator: aggregator(),
        cell_exposure_bps: 1_000,
        premium_rewards_bps: 1_000,
        risk_loading_bps: 2_500,
        min_rate_bps: 100,
        min_sensors_per_cell: 3,
        min_stake: 1_000_000,
        unstake_delay_days: 30,
        waiting_period_days: 3,
        dry_day_threshold_mm_x100: 100,
        seconds_per_day: SECONDS_PER_DAY,
    }
}

fn day_params(day_index: u32, dry: bool) -> DayRecordParams {
    DayRecordParams {
        cell_id: CELL_ID,
        day_index,
        state: if dry { 1 } else { 2 },
        // Три сенсори, слоти 0..2 — рівно `min_sensors_per_cell`.
        contributors: 0b111,
        readings_root: [0x5a; 32],
        rainfall_x100: Some(if dry { 0 } else { 500 }),
        covered_intervals: 24,
        total_intervals: 24,
    }
}

fn policy_params() -> PolicyParams {
    PolicyParams {
        nonce: NONCE,
        cell_id: CELL_ID,
        spell_days_threshold: SPELL_THRESHOLD,
        payout: PAYOUT,
        max_premium: PREMIUM,
        window_start_day: WINDOW_START,
        window_end_day: WINDOW_END,
    }
}

/* -------------------------------------------------------------------------- */
/* Кроки                                                                      */
/* -------------------------------------------------------------------------- */

/// Порожній ланцюг із роздані ключами, активом і гаманцями. Жодної інструкції
/// ще не виконано.
fn empty_world() -> World {
    let mut world = World::new(GENESIS_TS, SECONDS_PER_DAY);

    world.fund(authority(), 10 * SOL);
    world.fund(aggregator(), 10 * SOL);
    world.fund(depositor(), 10 * SOL);
    world.fund(farmer(), 10 * SOL);
    world.fund(stranger(), 10 * SOL);

    world.create_mint(asset_mint(), DECIMALS, Some(minter()));
    world.create_token_account(depositor_tokens(), asset_mint(), depositor(), CAPITAL);
    world.create_token_account(farmer_tokens(), asset_mint(), farmer(), FARMER_BALANCE);
    world.create_token_account(stranger_tokens(), asset_mint(), stranger(), 0);

    world
}

fn initialize_pool(world: &mut World, params: PoolParams) {
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
        pumpking::instruction::InitializePool { params },
    );
    world.exec_ok(&ix);
}

fn deposit_capital(world: &mut World, amount: u64) {
    let ix = instruction(
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
        pumpking::instruction::DepositCapital { amount },
    );
    world.exec_ok(&ix);
}

fn submit_day(params: DayRecordParams) -> solana_instruction::Instruction {
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

fn issue_policy(params: PolicyParams) -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::IssuePolicy {
            owner: farmer(),
            pool: pool_pda(),
            cell: cell_pda(params.cell_id),
            policy: policy_pda(farmer(), params.nonce),
            asset_mint: asset_mint(),
            vault: vault_pda(),
            owner_tokens: farmer_tokens(),
            token_program: token_program_id(),
            system_program: system_program_id(),
        },
        pumpking::instruction::IssuePolicy { params },
    )
}

fn settle_policy(caller: AnchorPubkey, owner_tokens: AnchorPubkey) -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::SettlePolicy {
            caller,
            pool: pool_pda(),
            cell: cell_pda(CELL_ID),
            policy: policy_pda(farmer(), NONCE),
            asset_mint: asset_mint(),
            vault: vault_pda(),
            owner_tokens,
            token_program: token_program_id(),
        },
        pumpking::instruction::SettlePolicy {},
    )
}

fn claim_payout(caller: AnchorPubkey, owner_tokens: AnchorPubkey) -> solana_instruction::Instruction {
    instruction(
        pumpking::accounts::ClaimUnclaimedPayout {
            caller,
            pool: pool_pda(),
            cell: cell_pda(CELL_ID),
            policy: policy_pda(farmer(), NONCE),
            asset_mint: asset_mint(),
            vault: vault_pda(),
            owner_tokens,
            token_program: token_program_id(),
        },
        pumpking::instruction::ClaimUnclaimedPayout {},
    )
}

/// Скільки лежить у сховищі, має завжди дорівнювати обліку: капіталу плюс
/// резервам винагород усіх комірок. Це один акаунт із двома половинами, які
/// розрізняє тільки книга (`FR-061`), і розбіжність тут — рівно та помилка,
/// якої ніхто не побачив би на балансі.
fn assert_vault_matches_books(world: &World) {
    let pool: Pool = world.read(pool_pda());
    let cell: CellState = world.read(cell_pda(CELL_ID));
    assert_eq!(
        token_amount(world.account(vault_pda())),
        pool.capital_total + cell.rewards_reserve,
        "баланс сховища розійшовся з обліком"
    );
}

/// Пул із капіталом. Далі все, що вимагає грошей.
fn funded_world() -> World {
    let mut world = empty_world();
    initialize_pool(&mut world, pool_params());
    deposit_capital(&mut world, CAPITAL);
    world
}

/// Пул із капіталом і коміркою, у якої є двадцять діб історії — рівно те, що
/// потрібно `price_of`, щоб узагалі назвати ціну. Годинник лишається у добі
/// `HISTORY_DAYS`.
fn world_with_history() -> World {
    let mut world = funded_world();
    for day in 0..HISTORY_DAYS {
        world.set_day(day + 1);
        let ix = submit_day(day_params(day, history_is_dry(day)));
        world.exec_ok(&ix);
    }
    world.set_day(HISTORY_DAYS);
    world
}

/// Історія плюс проданий поліс. Годинник лишається у добі `HISTORY_DAYS`.
fn world_with_policy() -> World {
    let mut world = world_with_history();
    let ix = issue_policy(policy_params());
    world.exec_ok(&ix);
    world
}

/// Поліс і `dry` сухих діб поспіль від початку вікна. Годинник лишається у
/// добі, наступній за останньою записаною.
fn world_with_spell(dry: u32) -> World {
    let mut world = world_with_policy();
    for offset in 0..dry {
        let day = WINDOW_START + offset;
        world.set_day(day + 1);
        let ix = submit_day(day_params(day, true));
        world.exec_ok(&ix);
    }
    world
}

/* -------------------------------------------------------------------------- */
/* initialize_pool                                                            */
/* -------------------------------------------------------------------------- */

#[test]
fn the_pool_comes_out_of_initialize_with_both_vaults_under_its_own_authority() {
    let mut world = empty_world();
    assert!(!world.exists(pool_pda()), "пул існує ще до ініціалізації");

    initialize_pool(&mut world, pool_params());

    let pool: Pool = world.read(pool_pda());
    assert_eq!(pool.authority, authority());
    assert_eq!(pool.aggregator, aggregator());
    assert_eq!(pool.asset_mint, asset_mint());
    assert_eq!(pool.vault, vault_pda());
    assert_eq!(pool.stake_vault, stake_vault_pda());
    assert_eq!(pool.capital_total, 0);
    assert_eq!(pool.shares_total, 0);
    // Генезис читається з годинника, а не приходить аргументом: інакше той,
    // хто розгортає, обирав би, що означає «доба 0».
    assert_eq!(pool.genesis_ts, GENESIS_TS);
    assert_eq!(pool.bump, pool_bump());

    // Обидва сховища — справжні токен-акаунти, створені CPI до токен-програми,
    // а не порожні PDA, і влада над ними в пулу, не в людини. Це і є `FR-030`
    // як факт про акаунти: ключа, який міг би забрати гроші поліса, немає.
    for vault in [vault_pda(), stake_vault_pda()] {
        let account = world.account(vault);
        assert_eq!(account.owner, token_program_id_svm(), "{vault} не токен-акаунт");
        assert_eq!(token_mint(account), asset_mint());
        assert_eq!(token_owner(account), pool_pda(), "владу над {vault} має не пул");
        assert_eq!(token_amount(account), 0);
        assert_eq!(token_state(account), STATE_INITIALIZED);
    }

    // `FR-051`: стейк і капітал — два різні акаунти, а не один із двома
    // назвами.
    assert_ne!(vault_pda(), stake_vault_pda());
}

#[test]
fn a_pool_that_could_print_its_own_asset_is_not_initialized() {
    // `FR-057`. Юніт-тест уже перевіряє саму функцію; тут перевіряється, що
    // вона стоїть на шляху інструкції й що дані міняються з акаунта мінта, а
    // не з аргументу.
    for minting_key in [authority(), pool_pda()] {
        let mut world = empty_world();
        world.create_mint(asset_mint(), DECIMALS, Some(minting_key));

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
        world.exec_err(&ix, PumpkingError::MintAuthorityHasPoolPower);
        assert!(!world.exists(pool_pda()), "відхилена інструкція лишила пул");
    }
}

#[test]
fn the_pool_address_is_the_only_one_the_program_accepts() {
    // Сід — не прикраса: пул за іншою адресою це другий пул, і поліси одного
    // не бачили б капіталу другого. Anchor ловить це до першого рядка коду
    // інструкції.
    let mut world = empty_world();
    let impostor = AnchorPubkey::find_program_address(&[b"pool", b"2"], &pumpking::ID).0;

    let ix = instruction(
        pumpking::accounts::InitializePool {
            authority: authority(),
            pool: impostor,
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
    world.exec_anchor_err(&ix, anchor_lang::error::ErrorCode::ConstraintSeeds);
}

/* -------------------------------------------------------------------------- */
/* deposit_capital                                                            */
/* -------------------------------------------------------------------------- */

#[test]
fn a_deposit_moves_the_money_into_the_vault_and_opens_a_position() {
    let mut world = empty_world();
    initialize_pool(&mut world, pool_params());
    assert!(!world.exists(position_pda(depositor())));

    deposit_capital(&mut world, CAPITAL);

    // Гроші справді в сховищі, а не лише в обліку.
    assert_eq!(token_amount(world.account(vault_pda())), CAPITAL);
    assert_eq!(token_amount(world.account(depositor_tokens())), 0);

    let pool: Pool = world.read(pool_pda());
    assert_eq!(pool.capital_total, CAPITAL);
    assert_eq!(pool.shares_total, CAPITAL, "перший внесок задає масштаб 1:1");
    assert_eq!(pool.reserved_total, 0);

    let position: CapitalPosition = world.read(position_pda(depositor()));
    assert_eq!(position.owner, depositor());
    assert_eq!(position.shares, CAPITAL);
}

#[test]
fn a_second_deposit_adds_to_the_position_instead_of_resetting_it() {
    // `init_if_needed` має класичну небезпеку — повторна ініціалізація, що
    // скидає стан. Тут вона перевіряється, а не обіцяється: частки після
    // другого внеску мають бути сумою, а не останнім внеском.
    let mut world = empty_world();
    initialize_pool(&mut world, pool_params());

    deposit_capital(&mut world, CAPITAL / 2);
    let after_first: CapitalPosition = world.read(position_pda(depositor()));
    assert_eq!(after_first.shares, CAPITAL / 2);

    deposit_capital(&mut world, CAPITAL / 2);
    let after_second: CapitalPosition = world.read(position_pda(depositor()));
    assert_eq!(after_second.shares, CAPITAL);
    assert_eq!(after_second.owner, depositor());

    let pool: Pool = world.read(pool_pda());
    assert_eq!(pool.capital_total, CAPITAL);
    assert_eq!(token_amount(world.account(vault_pda())), CAPITAL);
}

/* -------------------------------------------------------------------------- */
/* submit_day_record                                                          */
/* -------------------------------------------------------------------------- */

#[test]
fn the_first_day_of_a_cell_opens_the_cell() {
    // Окремої інструкції на створення комірки немає: комірка — це рівно «те,
    // звідки приходять показники». Перевіряється, що `init_if_needed` справді
    // її відкриває і що `cell_id` у ній не лишається нулем.
    let mut world = funded_world();
    assert!(!world.exists(cell_pda(CELL_ID)));

    world.set_day(1);
    let ix = submit_day(day_params(0, true));
    world.exec_ok(&ix);

    let cell: CellState = world.read(cell_pda(CELL_ID));
    assert_eq!(cell.cell_id, CELL_ID, "комірка, яку ніхто не може назвати");
    assert_eq!(cell.last_day_index, Some(0));
    assert_eq!(cell.first_day_index, 0);
    assert_eq!(cell.day_log[0], 1, "доба 0 записана сухою");
    assert_eq!(cell.contributors[0], 0b111);
    assert_eq!(cell.reserved, 0);
    assert_eq!(cell.rewards_reserve, 0);
}

#[test]
fn nobody_but_the_aggregator_writes_a_day() {
    // `FR-015`. Двері в журнал діб одні, і ключ до них один: доба — це те,
    // через що потім виплачуються гроші.
    let mut world = funded_world();
    world.set_day(1);

    let ix = instruction(
        pumpking::accounts::SubmitDayRecord {
            aggregator: stranger(),
            pool: pool_pda(),
            cell: cell_pda(CELL_ID),
            system_program: system_program_id(),
        },
        pumpking::instruction::SubmitDayRecord {
            params: day_params(0, true),
        },
    );
    world.exec_err(&ix, PumpkingError::NotTheAggregator);
    assert!(!world.exists(cell_pda(CELL_ID)), "чужак відкрив комірку");
}

#[test]
fn the_day_log_only_grows_forwards() {
    // Доба, яка вже виплатила поліс, не переписується. Виправлення, що
    // прийшло пізніше, — це і є той перепис.
    let mut world = funded_world();

    world.set_day(3);
    let ix = submit_day(day_params(2, true));
    world.exec_ok(&ix);

    for repeat in [2u32, 1, 0] {
        let ix = submit_day(day_params(repeat, false));
        world.exec_err(&ix, PumpkingError::DayNotNewer);
    }

    let cell: CellState = world.read(cell_pda(CELL_ID));
    assert_eq!(cell.last_day_index, Some(2));
    assert_eq!(cell.day_log[2], 1, "доба 2 лишилась сухою");
}

#[test]
fn a_day_that_is_not_over_cannot_be_summed() {
    let mut world = funded_world();
    world.set_day(2);

    let ix = submit_day(day_params(2, true));
    world.exec_err(&ix, PumpkingError::DayNotOver);

    let ix = submit_day(day_params(5, true));
    world.exec_err(&ix, PumpkingError::DayNotOver);
}

#[test]
fn the_chain_re_derives_dry_from_the_rainfall_it_was_given() {
    // Найдешевший спосіб сфабрикувати виплату — назвати мокру добу сухою.
    // Поріг публікує пул, тож ланцюг перевіряє мітку сам, а не вірить їй.
    let mut world = funded_world();
    world.set_day(1);

    let mut params = day_params(0, true);
    params.rainfall_x100 = Some(500); // вище порога 100, тобто мокра
    let ix = submit_day(params);
    world.exec_err(&ix, PumpkingError::DayStateContradictsRainfall);
}

#[test]
fn twenty_days_of_history_land_in_the_cell_in_the_order_they_were_written() {
    let world = world_with_history();
    let cell: CellState = world.read(cell_pda(CELL_ID));

    assert_eq!(cell.last_day_index, Some(HISTORY_DAYS - 1));
    assert_eq!(cell.first_day_index, 0);
    for day in 0..HISTORY_DAYS {
        let expected = if history_is_dry(day) { 1 } else { 2 };
        assert_eq!(
            cell.day_log[day as usize], expected,
            "доба {day} записана не тим станом"
        );
    }
    // Решта кільця мовчить, і саме тому `price_of` рахує двадцять діб, а не
    // сто двадцять вісім.
    for slot in HISTORY_DAYS as usize..cell.day_log.len() {
        assert_eq!(cell.day_log[slot], 0);
    }
}

/* -------------------------------------------------------------------------- */
/* issue_policy                                                               */
/* -------------------------------------------------------------------------- */

#[test]
fn a_policy_is_sold_at_the_price_the_cell_s_own_history_names() {
    // Шлях M1 у повний зріст: пул, капітал, двадцять записаних діб — і поліс,
    // ціну якого назвала комірка, а не покупець. `max_premium` тут дорівнює
    // очікуваній премії рівно, тож якби ланцюг порахував інакше хоч на
    // одиницю, інструкція б не пройшла.
    let mut world = world_with_history();
    assert!(!world.exists(policy_pda(farmer(), NONCE)));

    let ix = issue_policy(policy_params());
    world.exec_ok(&ix);

    let policy: Policy = world.read(policy_pda(farmer(), NONCE));
    assert_eq!(policy.owner, farmer());
    assert_eq!(policy.nonce, NONCE);
    assert_eq!(policy.cell_id, CELL_ID);
    assert_eq!(policy.payout, PAYOUT);
    assert_eq!(policy.premium, PREMIUM, "ціна не та, яку називає формула");
    assert_eq!(policy.spell_days_threshold, SPELL_THRESHOLD);
    assert_eq!(policy.window_start_day, WINDOW_START);
    assert_eq!(policy.window_end_day, WINDOW_END);
    assert_eq!(policy.state, PolicyState::Active);

    // Гроші пішли з гаманця покупця у сховище, і рівно стільки.
    assert_eq!(
        token_amount(world.account(farmer_tokens())),
        FARMER_BALANCE - PREMIUM
    );
    assert_eq!(token_amount(world.account(vault_pda())), CAPITAL + PREMIUM);

    // `FR-034`, `FR-061`: премія ділиться тут і лише тут. Десята частина —
    // резерв винагород комірки, решта — капітал, і жодна частка не карбується.
    let pool: Pool = world.read(pool_pda());
    let cell: CellState = world.read(cell_pda(CELL_ID));
    assert_eq!(cell.rewards_reserve, PREMIUM / 10);
    assert_eq!(pool.capital_total, CAPITAL + PREMIUM - PREMIUM / 10);
    assert_eq!(pool.shares_total, CAPITAL);
    assert_eq!(pool.reserved_total, PAYOUT);
    assert_eq!(cell.reserved, PAYOUT);
    assert_vault_matches_books(&world);
}

#[test]
fn a_cell_that_has_gone_quiet_sells_nothing() {
    // `FR-022` як факт про мережу, а не про реєстр. Комірка з двадцятьма
    // добами історії перестає бути покриттям тієї доби, коли остання її доба
    // приходить без жодного голосу.
    let mut world = world_with_history();

    world.set_day(HISTORY_DAYS + 1);
    let silent = DayRecordParams {
        cell_id: CELL_ID,
        day_index: HISTORY_DAYS,
        state: 0,
        contributors: 0,
        readings_root: [0; 32],
        rainfall_x100: None,
        covered_intervals: 0,
        total_intervals: 24,
    };
    let ix = submit_day(silent);
    world.exec_ok(&ix);

    let cell: CellState = world.read(cell_pda(CELL_ID));
    assert_eq!(cell.sensor_count, 0, "покриття більше не читається з реєстру");

    let mut params = policy_params();
    // Вікно посувається на добу вперед разом із годинником, інакше впаде
    // період очікування, а не покриття.
    params.window_start_day = WINDOW_START + 1;
    let ix = issue_policy(params);
    world.exec_err(&ix, PumpkingError::CellNotCovered);
    assert!(!world.exists(policy_pda(farmer(), NONCE)));
}

#[test]
fn a_cell_below_the_minimum_number_of_votes_sells_nothing() {
    // Два голоси з трьох потрібних — це не покриття, і це видно з журналу
    // діб, а не зі списку зареєстрованих.
    let mut world = funded_world();
    for day in 0..HISTORY_DAYS {
        world.set_day(day + 1);
        let mut params = day_params(day, history_is_dry(day));
        if day == HISTORY_DAYS - 1 {
            params.contributors = 0b11;
        }
        let ix = submit_day(params);
        // Остання доба з двома голосами взагалі не приймається: `FR-010`
        // тримає той самий поріг на вході.
        if day == HISTORY_DAYS - 1 {
            world.exec_err(&ix, PumpkingError::TooFewContributors);
        } else {
            world.exec_ok(&ix);
        }
    }
}

#[test]
fn the_premium_the_buyer_capped_is_the_premium_they_get() {
    // Котирування і транзакція, що йде за ним, — це дві різні миті, а між
    // ними могла записатися доба. Межа покупця в тому і є: ціну називає
    // формула, вище межі поліс не продається.
    let mut world = world_with_history();

    let mut params = policy_params();
    params.max_premium = PREMIUM - 1;
    let ix = issue_policy(params);
    world.exec_err(&ix, PumpkingError::PremiumAboveLimit);

    assert_eq!(token_amount(world.account(farmer_tokens())), FARMER_BALANCE);
    assert!(!world.exists(policy_pda(farmer(), NONCE)));
}

#[test]
fn a_policy_lives_at_the_address_its_own_terms_derive() {
    // Сіди поліса — власник і nonce з аргументів. Адреса, виведена з іншого
    // nonce, це чужий акаунт, і жоден рядок інструкції до нього не дійде.
    let mut world = world_with_history();

    let ix = instruction(
        pumpking::accounts::IssuePolicy {
            owner: farmer(),
            pool: pool_pda(),
            cell: cell_pda(CELL_ID),
            policy: policy_pda(farmer(), NONCE + 1),
            asset_mint: asset_mint(),
            vault: vault_pda(),
            owner_tokens: farmer_tokens(),
            token_program: token_program_id(),
            system_program: system_program_id(),
        },
        pumpking::instruction::IssuePolicy {
            params: policy_params(),
        },
    );
    world.exec_anchor_err(&ix, anchor_lang::error::ErrorCode::ConstraintSeeds);
}

#[test]
fn the_premium_a_buyer_pays_comes_out_of_the_buyer_s_own_account() {
    // `FR-025`. Токен-акаунт чужака має той самий актив і ту саму розкладку,
    // і єдине, що його відхиляє, — `token::authority = owner`.
    let mut world = world_with_history();

    let ix = instruction(
        pumpking::accounts::IssuePolicy {
            owner: farmer(),
            pool: pool_pda(),
            cell: cell_pda(CELL_ID),
            policy: policy_pda(farmer(), NONCE),
            asset_mint: asset_mint(),
            vault: vault_pda(),
            owner_tokens: stranger_tokens(),
            token_program: token_program_id(),
            system_program: system_program_id(),
        },
        pumpking::instruction::IssuePolicy {
            params: policy_params(),
        },
    );
    world.exec_anchor_err(&ix, anchor_lang::error::ErrorCode::ConstraintTokenOwner);
}

/* -------------------------------------------------------------------------- */
/* settle_policy                                                              */
/* -------------------------------------------------------------------------- */

#[test]
fn the_spell_pays_the_farmer_and_nobody_had_to_ask() {
    // `SC-001`, `SC-002`, `FR-030` — усе, заради чого проєкт існує, одним
    // прогоном справжнього рантайму.
    //
    // Викликає **чужак**: у контексті `settle_policy` немає акаунта влади, і
    // ключа, який міг би виплату затримати, теж немає. Власник за весь шлях не
    // підписує нічого, крім власної купівлі.
    //
    // Переказ іде зі сховища, яким володіє PDA пулу, і підписує його програма
    // сідами `["pool", bump]`. Хибний бамп чи хибний сід — і токен-програма
    // відхилила б переказ; жоден юніт-тест цього не бачить.
    let mut world = world_with_spell(u32::from(SPELL_THRESHOLD));
    let before = token_amount(world.account(farmer_tokens()));

    let ix = settle_policy(stranger(), farmer_tokens());
    world.exec_ok(&ix);

    assert_eq!(token_amount(world.account(farmer_tokens())), before + PAYOUT);
    assert_eq!(
        token_amount(world.account(vault_pda())),
        CAPITAL + PREMIUM - PAYOUT
    );

    let policy: Policy = world.read(policy_pda(farmer(), NONCE));
    assert_eq!(policy.state, PolicyState::PaidOut);

    // Обидва підсумки падають на однакову величину: ці гроші були зарезервовані
    // з дня продажу й вільною ліквідністю не були ніколи.
    let pool: Pool = world.read(pool_pda());
    let cell: CellState = world.read(cell_pda(CELL_ID));
    assert_eq!(pool.capital_total, CAPITAL + PREMIUM - PREMIUM / 10 - PAYOUT);
    assert_eq!(pool.reserved_total, 0);
    assert_eq!(cell.reserved, 0);
    // `FR-061`: резерв винагород комірки виплата не чіпає — він ніколи не був
    // у `capital_total`, щоб вона могла до нього дотягтися.
    assert_eq!(cell.rewards_reserve, PREMIUM / 10);
    assert_vault_matches_books(&world);
}

#[test]
fn the_payout_happens_once() {
    // `FR-027`. Другий виклик приходить на поліс, який уже не активний, і
    // впирається в це до першого переказу.
    let mut world = world_with_spell(u32::from(SPELL_THRESHOLD));
    let ix = settle_policy(stranger(), farmer_tokens());
    world.exec_ok(&ix);
    let after_first = token_amount(world.account(farmer_tokens()));

    let ix = settle_policy(stranger(), farmer_tokens());
    world.exec_err(&ix, PumpkingError::PolicyNotActive);
    assert_eq!(token_amount(world.account(farmer_tokens())), after_first);
}

#[test]
fn the_payout_cannot_be_pointed_at_anybody_else() {
    // `FR-066`. Викликати може будь-хто, але отримувача обирає не він:
    // `token::authority = policy.owner` не лишає поля, яке можна підмінити.
    let mut world = world_with_spell(u32::from(SPELL_THRESHOLD));

    let ix = settle_policy(stranger(), stranger_tokens());
    world.exec_anchor_err(&ix, anchor_lang::error::ErrorCode::ConstraintTokenOwner);

    assert_eq!(token_amount(world.account(stranger_tokens())), 0);
    let policy: Policy = world.read(policy_pda(farmer(), NONCE));
    assert_eq!(policy.state, PolicyState::Active);
}

#[test]
fn an_index_short_of_the_threshold_pays_nothing() {
    // Чотири сухі доби з потрібних п'яти. Серія, яка не дійшла порогу, — це не
    // подія, і виплати немає, хоч би хто дзвонив.
    let mut world = world_with_spell(u32::from(SPELL_THRESHOLD) - 1);

    let ix = settle_policy(stranger(), farmer_tokens());
    world.exec_err(&ix, PumpkingError::EventHasNotHappened);
    assert_eq!(
        token_amount(world.account(vault_pda())),
        CAPITAL + PREMIUM,
        "зі сховища пішли гроші"
    );
}

#[test]
fn a_wet_day_in_the_middle_breaks_the_run() {
    // Серія — це доби **поспіль**. Три сухі, мокра, три сухі — це найдовша
    // серія у три, а не подія у шість.
    let mut world = world_with_policy();
    for offset in 0..7u32 {
        let day = WINDOW_START + offset;
        world.set_day(day + 1);
        let ix = submit_day(day_params(day, offset != 3));
        world.exec_ok(&ix);
    }

    let ix = settle_policy(stranger(), farmer_tokens());
    world.exec_err(&ix, PumpkingError::EventHasNotHappened);
}

#[test]
fn a_frozen_account_defers_the_payout_instead_of_losing_it() {
    // `FR-029`. Заморожений акаунт — це факт про акаунт, а не чиясь оцінка:
    // жоден викликач не може відкласти виплату, яка пройшла б.
    let mut world = world_with_spell(u32::from(SPELL_THRESHOLD));
    let before = token_amount(world.account(farmer_tokens()));
    world.set_token_state(farmer_tokens(), STATE_FROZEN);

    let ix = settle_policy(stranger(), farmer_tokens());
    world.exec_ok(&ix);

    // Гроші не пішли й не пропали: вони в сховищі й досі зарезервовані.
    let policy: Policy = world.read(policy_pda(farmer(), NONCE));
    assert_eq!(policy.state, PolicyState::Unclaimed);
    assert_eq!(token_amount(world.account(farmer_tokens())), before);
    assert_eq!(token_amount(world.account(vault_pda())), CAPITAL + PREMIUM);
    let pool: Pool = world.read(pool_pda());
    assert_eq!(pool.reserved_total, PAYOUT);

    // Розморозили — і доставку завершує знову будь-хто.
    world.set_token_state(farmer_tokens(), STATE_INITIALIZED);
    let ix = claim_payout(stranger(), farmer_tokens());
    world.exec_ok(&ix);

    let policy: Policy = world.read(policy_pda(farmer(), NONCE));
    assert_eq!(policy.state, PolicyState::PaidOut);
    assert_eq!(token_amount(world.account(farmer_tokens())), before + PAYOUT);
    let pool: Pool = world.read(pool_pda());
    assert_eq!(pool.reserved_total, 0);
    assert_vault_matches_books(&world);
}

#[test]
fn a_policy_that_was_paid_has_no_deferred_payout_to_claim() {
    // Другі двері до тих самих грошей мали б бути тими, які відчиняються лише
    // після `Unclaimed`. Перевіряється, що вони не відчиняються після виплати.
    let mut world = world_with_spell(u32::from(SPELL_THRESHOLD));
    let ix = settle_policy(stranger(), farmer_tokens());
    world.exec_ok(&ix);
    let after_payout = token_amount(world.account(farmer_tokens()));

    let ix = claim_payout(stranger(), farmer_tokens());
    world.exec_err(&ix, PumpkingError::PolicyNotUnclaimed);
    assert_eq!(token_amount(world.account(farmer_tokens())), after_payout);
}
