//! Оснастка для mollusk-тестів: справжній рантайм над `target/deploy/pumpking.so`.
//!
//! `cargo test --lib` перевіряє чисті функції — андеррайтинг, класифікацію
//! доби, індекс. Плетіння акаунтів воно не бачить взагалі: `init`, сіди,
//! `token::authority`, підпис PDA у CPI. Ці рядки або виконуються, або ні, і
//! юніт-тест не має де це дізнатися.
//!
//! **Дві гілки типів.** `mollusk-svm 0.15` живе на agave 4.x, `anchor-lang
//! 0.32.1` — на `solana-program 2.3`. Це два різні `Pubkey`, два різні
//! `Account`, і компілятор їх не плутає. Міст один — `to_bytes()`, і він
//! проходить через [`svm`] та [`anchor`]. Усе, що описує програму (сіди,
//! параметри, стан), береться з крейта `pumpking`; усе, що описує машину
//! (акаунти, інструкція, результат), — з гілки mollusk.
//!
//! **Токен-акаунти пакуються тут руками**, а не готовими типами
//! `spl-token-interface`: у нього своя, третя гілка `solana-pubkey`, і заради
//! двох структур довелося б тягти ще один міст. Розкладка SPL Token фіксована
//! і публічна, а виписана явно вона ще й каже, що саме бачить рантайм.

#![allow(dead_code)]

use std::collections::HashMap;

use anchor_lang::prelude::Pubkey as AnchorPubkey;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use mollusk_svm::result::InstructionResult;
use mollusk_svm::{program, Mollusk};
use mollusk_svm_programs_token::token;
use solana_account::Account;
use solana_instruction::error::InstructionError;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

use pumpking::state::{
    CAPITAL_SEED, CELL_SEED, POLICY_SEED, POOL_SEED, STAKE_VAULT_SEED, VAULT_SEED,
};

/* -------------------------------------------------------------------------- */
/* Міст між двома гілками типів                                               */
/* -------------------------------------------------------------------------- */

/// Ключ програми у типах машини.
pub fn svm(key: AnchorPubkey) -> Pubkey {
    Pubkey::new_from_array(key.to_bytes())
}

/// Ключ машини у типах програми.
pub fn anchor(key: Pubkey) -> AnchorPubkey {
    AnchorPubkey::new_from_array(key.to_bytes())
}

/// Детермінований ключ із одного байта.
///
/// Випадкові ключі роблять невідтворюваним і падіння: адреса у повідомленні
/// про помилку різна щопрогону, а PDA, виведений з неї, — тим паче. Нуль не
/// береться: ключ із самих нулів — це системна програма.
pub fn key(tag: u8) -> AnchorPubkey {
    assert!(tag > 0, "нульовий тег — це адреса системної програми");
    AnchorPubkey::new_from_array([tag; 32])
}

/// Токен-програма, у типах програми — те, що йде в акаунти інструкції.
pub fn token_program_id() -> AnchorPubkey {
    anchor(token::ID)
}

/// Вона ж у типах машини — те, з чим звіряється `Account::owner`.
pub fn token_program_id_svm() -> Pubkey {
    token::ID
}

pub fn system_program_id() -> AnchorPubkey {
    anchor_lang::system_program::ID
}

/* -------------------------------------------------------------------------- */
/* Розкладка SPL Token                                                        */
/* -------------------------------------------------------------------------- */

pub const MINT_LEN: usize = 82;
pub const TOKEN_ACCOUNT_LEN: usize = 165;

/// Зсуви полів токен-акаунта, які тести читають назад.
const TOKEN_MINT_OFFSET: usize = 0;
const TOKEN_OWNER_OFFSET: usize = 32;
const TOKEN_AMOUNT_OFFSET: usize = 64;
const TOKEN_STATE_OFFSET: usize = 108;

/// Стан токен-акаунта, як його зберігає SPL Token.
pub const STATE_INITIALIZED: u8 = 1;
pub const STATE_FROZEN: u8 = 2;

/// Скільки токенів лежить на акаунті.
pub fn token_amount(account: &Account) -> u64 {
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&account.data[TOKEN_AMOUNT_OFFSET..TOKEN_AMOUNT_OFFSET + 8]);
    u64::from_le_bytes(bytes)
}

/// Чий це токен-акаунт — саме та влада, яку `token::authority` кладе на PDA.
pub fn token_owner(account: &Account) -> AnchorPubkey {
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&account.data[TOKEN_OWNER_OFFSET..TOKEN_OWNER_OFFSET + 32]);
    AnchorPubkey::new_from_array(bytes)
}

/// Актив, у якому акаунт номінований.
pub fn token_mint(account: &Account) -> AnchorPubkey {
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&account.data[TOKEN_MINT_OFFSET..TOKEN_MINT_OFFSET + 32]);
    AnchorPubkey::new_from_array(bytes)
}

/// Ініціалізований чи заморожений — `FR-029` розрізняє саме це.
pub fn token_state(account: &Account) -> u8 {
    account.data[TOKEN_STATE_OFFSET]
}

fn pack_mint(decimals: u8, mint_authority: Option<AnchorPubkey>) -> Vec<u8> {
    let mut data = vec![0u8; MINT_LEN];
    if let Some(authority) = mint_authority {
        data[0..4].copy_from_slice(&1u32.to_le_bytes());
        data[4..36].copy_from_slice(&authority.to_bytes());
    }
    // supply лишається нулем: тести не друкують актив, вони роздають готові
    // залишки. `FR-057` саме про те, що друкар не має влади над пулом.
    data[44] = decimals;
    data[45] = 1; // is_initialized
    data
}

fn pack_token_account(mint: AnchorPubkey, owner: AnchorPubkey, amount: u64, state: u8) -> Vec<u8> {
    let mut data = vec![0u8; TOKEN_ACCOUNT_LEN];
    data[TOKEN_MINT_OFFSET..TOKEN_MINT_OFFSET + 32].copy_from_slice(&mint.to_bytes());
    data[TOKEN_OWNER_OFFSET..TOKEN_OWNER_OFFSET + 32].copy_from_slice(&owner.to_bytes());
    data[TOKEN_AMOUNT_OFFSET..TOKEN_AMOUNT_OFFSET + 8].copy_from_slice(&amount.to_le_bytes());
    data[TOKEN_STATE_OFFSET] = state;
    data
}

/* -------------------------------------------------------------------------- */
/* PDA                                                                        */
/* -------------------------------------------------------------------------- */

/// Сіди виводяться тими самими константами, що й у програмі
/// (`pumpking::state`). Другий рядковий літерал тут був би другим джерелом
/// правди про адресу, і розбіжність у ньому виглядала б як помилка програми.
pub fn pool_pda() -> AnchorPubkey {
    AnchorPubkey::find_program_address(&[POOL_SEED], &pumpking::ID).0
}

/// Бамп пулу. Ним `settle_policy` підписує переказ зі сховища, тож збережений
/// у полі бамп і виведений тут мають бути одним числом.
pub fn pool_bump() -> u8 {
    AnchorPubkey::find_program_address(&[POOL_SEED], &pumpking::ID).1
}

pub fn vault_pda() -> AnchorPubkey {
    AnchorPubkey::find_program_address(&[VAULT_SEED, pool_pda().as_ref()], &pumpking::ID).0
}

pub fn stake_vault_pda() -> AnchorPubkey {
    AnchorPubkey::find_program_address(&[STAKE_VAULT_SEED, pool_pda().as_ref()], &pumpking::ID).0
}

pub fn cell_pda(cell_id: u64) -> AnchorPubkey {
    AnchorPubkey::find_program_address(&[CELL_SEED, cell_id.to_le_bytes().as_ref()], &pumpking::ID).0
}

pub fn policy_pda(owner: AnchorPubkey, nonce: u64) -> AnchorPubkey {
    AnchorPubkey::find_program_address(
        &[POLICY_SEED, owner.as_ref(), nonce.to_le_bytes().as_ref()],
        &pumpking::ID,
    )
    .0
}

pub fn position_pda(owner: AnchorPubkey) -> AnchorPubkey {
    AnchorPubkey::find_program_address(&[CAPITAL_SEED, owner.as_ref()], &pumpking::ID).0
}

/* -------------------------------------------------------------------------- */
/* Світ                                                                       */
/* -------------------------------------------------------------------------- */

/// Ланцюг у пам'яті: машина, годинник і всі акаунти, які інструкції встигли
/// створити.
pub struct World {
    pub mollusk: Mollusk,
    accounts: HashMap<Pubkey, Account>,
    /// Мить, з якої стартував годинник. `initialize_pool` кладе її у
    /// `Pool::genesis_ts`, і всі індекси діб рахуються від неї.
    pub genesis_ts: i64,
    /// Довжина доби пулу, щоб [`World::set_day`] не вимагала пам'ятати її.
    pub seconds_per_day: i64,
}

impl World {
    /// Машина з програмою і SPL Token у кеші.
    ///
    /// `pumpking.so` шукається у `SBF_OUT_DIR` — `scripts/mollusk-test.sh`
    /// його експортує. Без змінної mollusk дивиться у `tests/fixtures` і в
    /// поточний каталог, а cargo ставить робочим каталогом тесту корінь
    /// пакета, тобто `programs/pumpking`, де `.so` немає.
    pub fn new(genesis_ts: i64, seconds_per_day: u32) -> Self {
        let mut mollusk = Mollusk::new(&svm(pumpking::ID), "pumpking");
        token::add_program(&mut mollusk);
        mollusk.sysvars.clock.unix_timestamp = genesis_ts;

        let mut accounts = HashMap::new();
        let (system_id, system_account) = program::keyed_account_for_system_program();
        accounts.insert(system_id, system_account);
        let (token_id, token_account) = token::keyed_account();
        accounts.insert(token_id, token_account);

        Self {
            mollusk,
            accounts,
            genesis_ts,
            seconds_per_day: i64::from(seconds_per_day),
        }
    }

    /* -------------------------------------------------------------- час */

    /// Ставить годинник у середину доби `day` на шкалі пулу.
    ///
    /// Середина, а не початок: `submit_day_record` вимагає `day_index <
    /// today`, і рівно на межі доби зайва секунда в один бік міняє відповідь.
    pub fn set_day(&mut self, day: u32) {
        self.mollusk.sysvars.clock.unix_timestamp =
            self.genesis_ts + i64::from(day) * self.seconds_per_day + self.seconds_per_day / 2;
    }

    /* ------------------------------------------------------------ акаунти */

    pub fn set_account(&mut self, address: AnchorPubkey, account: Account) {
        self.accounts.insert(svm(address), account);
    }

    pub fn account(&self, address: AnchorPubkey) -> &Account {
        self.accounts
            .get(&svm(address))
            .unwrap_or_else(|| panic!("акаунта {address} у світі немає"))
    }

    /// Чи існує акаунт — саме те, що `init` має змінити з «ні» на «так».
    pub fn exists(&self, address: AnchorPubkey) -> bool {
        self.accounts
            .get(&svm(address))
            .is_some_and(|account| account.lamports > 0)
    }

    /// Гаманець, який платить ренту.
    pub fn fund(&mut self, address: AnchorPubkey, lamports: u64) {
        self.set_account(
            address,
            Account {
                lamports,
                ..Account::default()
            },
        );
    }

    /// Актив пулу — `FR-031`, `FR-055`. Ключ емісії окремий від будь-якої
    /// влади в пулі, інакше `FR-057` відхилить ініціалізацію.
    pub fn create_mint(&mut self, address: AnchorPubkey, decimals: u8, minter: Option<AnchorPubkey>) {
        let lamports = self.mollusk.sysvars.rent.minimum_balance(MINT_LEN);
        self.set_account(
            address,
            Account {
                lamports,
                data: pack_mint(decimals, minter),
                owner: token::ID,
                executable: false,
                rent_epoch: 0,
            },
        );
    }

    pub fn create_token_account(
        &mut self,
        address: AnchorPubkey,
        mint: AnchorPubkey,
        owner: AnchorPubkey,
        amount: u64,
    ) {
        self.create_token_account_in_state(address, mint, owner, amount, STATE_INITIALIZED);
    }

    pub fn create_token_account_in_state(
        &mut self,
        address: AnchorPubkey,
        mint: AnchorPubkey,
        owner: AnchorPubkey,
        amount: u64,
        state: u8,
    ) {
        let lamports = self.mollusk.sysvars.rent.minimum_balance(TOKEN_ACCOUNT_LEN);
        self.set_account(
            address,
            Account {
                lamports,
                data: pack_token_account(mint, owner, amount, state),
                owner: token::ID,
                executable: false,
                rent_epoch: 0,
            },
        );
    }

    /// Заморожує або розморожує токен-акаунт, лишаючи все інше на місці.
    ///
    /// На ланцюгу це робить `freeze_authority` мінта, і інструкції для цього в
    /// `pumpking` немає й не буде: `FR-029` каже, що робити з такою відмовою,
    /// а не як її влаштувати. Байт стану переписується напряму саме тому, що
    /// це подія з чужого світу, а не крок сценарію.
    pub fn set_token_state(&mut self, address: AnchorPubkey, state: u8) {
        let mut account = self.account(address).clone();
        account.data[TOKEN_STATE_OFFSET] = state;
        self.set_account(address, account);
    }

    /// Стан акаунта програми, розібраний її ж декодером.
    pub fn read<T: AccountDeserialize>(&self, address: AnchorPubkey) -> T {
        let account = self.account(address);
        assert_eq!(
            account.owner,
            svm(pumpking::ID),
            "акаунт {address} належить не програмі"
        );
        T::try_deserialize(&mut account.data.as_slice())
            .unwrap_or_else(|err| panic!("акаунт {address} не розбирається: {err:?}"))
    }

    /* --------------------------------------------------------- виконання */

    /// Виконує інструкцію і, **лише якщо вона пройшла**, вбирає її акаунти.
    ///
    /// Відхилена інструкція не міняє світу — так само, як відхилена
    /// транзакція не міняє ланцюга. Інакше тест на відмову лишав би по собі
    /// напівзроблений стан, і наступний тест бачив би ланцюг, якого не буває.
    pub fn exec(&mut self, instruction: &Instruction) -> InstructionResult {
        let accounts: Vec<(Pubkey, Account)> = instruction
            .accounts
            .iter()
            .map(|meta| {
                let account = self.accounts.get(&meta.pubkey).cloned().unwrap_or_default();
                (meta.pubkey, account)
            })
            .collect();

        let result = self.mollusk.process_instruction(instruction, &accounts);
        if result.program_result.is_ok() {
            for (address, account) in &result.resulting_accounts {
                self.accounts.insert(*address, account.clone());
            }
        }
        result
    }

    /// Виконує інструкцію, яка мала пройти.
    pub fn exec_ok(&mut self, instruction: &Instruction) -> InstructionResult {
        let result = self.exec(instruction);
        assert!(
            result.program_result.is_ok(),
            "інструкція мала пройти, а повернула {:?}",
            result.raw_result
        );
        result
    }

    /// Виконує інструкцію, яка мала впертися в конкретне правило програми.
    pub fn exec_err(&mut self, instruction: &Instruction, expected: pumpking::errors::PumpkingError) {
        let result = self.exec(instruction);
        assert_custom(&result, u32::from(expected), &format!("{expected:?}"));
    }

    /// Виконує інструкцію, яка мала впертися в обмеження самого Anchor —
    /// сіди, власника токен-акаунта, адресу.
    pub fn exec_anchor_err(
        &mut self,
        instruction: &Instruction,
        expected: anchor_lang::error::ErrorCode,
    ) {
        let result = self.exec(instruction);
        assert_custom(&result, u32::from(expected), &format!("{expected:?}"));
    }
}

/// Перевіряє, що інструкція повернула саме цей код помилки.
///
/// Anchor віддає всі свої помилки як `Custom(code)`, і код — єдине, що
/// відрізняє «поліс уже виплачений» від «сіди не ті».
pub fn assert_custom(result: &InstructionResult, code: u32, name: &str) {
    match &result.raw_result {
        Err(InstructionError::Custom(actual)) if *actual == code => {}
        other => panic!("очікувалась помилка {name} ({code}), а прийшло {other:?}"),
    }
}

/* -------------------------------------------------------------------------- */
/* Інструкції                                                                 */
/* -------------------------------------------------------------------------- */

/// Збирає інструкцію зі згенерованих Anchor структур.
///
/// Порядок акаунтів і дискримінатор беруться з `pumpking::accounts` і
/// `pumpking::instruction` — тих самих, які макрос вивів із `#[derive(
/// Accounts)]`. Це свідомо: TS-клієнт кодує їх самостійно і звіряється з IDL
/// у `T028`, а цим тестам треба питати не «чи так закодовано», а «чи виконає
/// це ланцюг».
pub fn instruction<A: ToAccountMetas, D: InstructionData>(accounts: A, data: D) -> Instruction {
    Instruction {
        program_id: svm(pumpking::ID),
        accounts: accounts
            .to_account_metas(None)
            .into_iter()
            .map(|meta| AccountMeta {
                pubkey: svm(meta.pubkey),
                is_signer: meta.is_signer,
                is_writable: meta.is_writable,
            })
            .collect(),
        data: data.data(),
    }
}
