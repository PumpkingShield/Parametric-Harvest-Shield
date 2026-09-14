use anchor_lang::prelude::*;

use crate::index::DayState;

/// The accounts the program owns. Everything here is state the chain is the
/// source of truth for: capital, policies, sensor stake, the day log of a cell.
/// Postgres mirrors it for reading; a divergence is repaired by re-reading the
/// chain, never the other way round.

/// Seeds. Written once here so an instruction and a client cannot disagree
/// about what a PDA is called.
pub const POOL_SEED: &[u8] = b"pool";
/// Token account holding capital, owned by the pool PDA.
pub const VAULT_SEED: &[u8] = b"vault";
/// Token account holding sensor stake — `FR-051` keeps it out of capital.
pub const STAKE_VAULT_SEED: &[u8] = b"stake_vault";
pub const CELL_SEED: &[u8] = b"cell";
pub const SENSOR_SEED: &[u8] = b"sensor";
pub const POLICY_SEED: &[u8] = b"policy";
pub const CAPITAL_SEED: &[u8] = b"lp";

/// Basis points, the unit every published share is expressed in.
pub const BPS_DENOMINATOR: u64 = 10_000;

/// One sensor per bit of the day's `contributors` mask — `FR-062` divides the
/// cell's reward between the day's voters without iterating over an unknown
/// set, and a mask is what makes that a fixed cost. A cell that reaches the
/// limit is a signal to split the grid (`FR-069`), not to raise the constant.
pub const MAX_SENSORS_PER_CELL: u8 = 32;

/// Days of history a cell carries. The longest coverage window a policy can
/// buy is 90 days, so 128 covers it with room to spare, and the log is a ring
/// buffer rather than an account per day: one array read instead of a walk
/// over thirty accounts, and no rent per day per cell.
pub const DAY_LOG_LEN: usize = 128;

/// The longest coverage window a policy may span, in days.
pub const MAX_COVERAGE_DAYS: u32 = 90;

/* -------------------------------------------------------------------------- */
/* Pool                                                                       */
/* -------------------------------------------------------------------------- */

/// PDA `["pool"]`. Parameters, totals, and the two vaults.
///
/// `authority` is deliberately not a treasury key. It sets parameters and
/// registries and nothing else; the vaults are owned by this PDA, so no human
/// key can move a policy's money and `FR-030` holds by construction rather
/// than by promise. `aggregator` is the only role that may write a day log,
/// and it cannot spend either.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    /// Parameters and registries only — never a signer over the vaults.
    pub authority: Pubkey,
    /// The single role allowed to write day records — `FR-015`.
    pub aggregator: Pubkey,
    /// `FR-031`, `FR-055`: the settlement asset is a parameter of the pool, so
    /// replacing the mock token with a real stablecoin is a deployment choice
    /// rather than an edit to policy, consensus or payout logic.
    pub asset_mint: Pubkey,
    /// Token account holding capital. Authority is this PDA.
    pub vault: Pubkey,
    /// `FR-051`: sensor stake sits apart from capital. It backs no policy, is
    /// reserved against nothing and takes no part in the solvency check.
    pub stake_vault: Pubkey,
    pub capital_total: u64,
    /// Committed to active policies — `FR-019` sells against what is left.
    pub reserved_total: u64,
    pub shares_total: u64,
    /// `FR-020`: share of capital any one cell may be exposed to. Drought is
    /// correlated — one event triggers every policy in the cell at once.
    pub cell_exposure_bps: u16,
    /// `FR-034`: share of a premium that goes to the cell's reward reserve at
    /// issue time. The rest becomes capital there and then.
    pub premium_rewards_bps: u16,
    /// `FR-021`: what the pool charges on top of the expected loss. A pool
    /// charging exactly its expected loss breaks even on average and goes
    /// insolvent on variance; this is the difference between a pool and a
    /// coin flip, and it is published rather than negotiated.
    pub risk_loading_bps: u16,
    /// `FR-021`: the rate below which cover is not sold at any history. A
    /// fortnight without a dry day is not proof that a cell never dries out,
    /// and the formula has no other way to say "we do not know yet".
    pub min_rate_bps: u16,
    /// `FR-010`: independent votes an interval needs to get a value at all.
    pub min_sensors_per_cell: u8,
    /// `FR-050`: below this a sensor still publishes, but does not vote.
    pub min_stake: u64,
    /// `FR-053`: thaw longer than the outlier observation window, so spoiling
    /// data and withdrawing before detection is not free.
    pub unstake_delay_days: u16,
    /// `FR-023`: gap between buying a policy and the start of its cover.
    pub waiting_period_days: u16,
    /// `FR-047`: a day is dry when its hourly total does not exceed this.
    pub dry_day_threshold_mm_x100: u32,
    /// 86_400 in production, seconds in a scenario run — `FR-049`. A day is an
    /// index, not a date, so compressing time changes the clock and nothing
    /// else: index, consensus and money move identically in both modes.
    pub seconds_per_day: u32,
    /// `day_index = (now - genesis_ts) / seconds_per_day`.
    pub genesis_ts: i64,
    pub bump: u8,
}

impl Pool {
    /// The day an instant falls in, or `None` before genesis — the same
    /// arithmetic the aggregator and the interface use.
    pub fn day_index(&self, unix_ts: i64) -> Option<u32> {
        if self.seconds_per_day == 0 || unix_ts < self.genesis_ts {
            return None;
        }
        let elapsed = unix_ts.checked_sub(self.genesis_ts)?;
        u32::try_from(elapsed / i64::from(self.seconds_per_day)).ok()
    }

    /// Capital not already committed to an active policy — `FR-019`.
    pub fn free_liquidity(&self) -> u64 {
        self.capital_total.saturating_sub(self.reserved_total)
    }

    /// The most one cell may owe at once — `FR-020`.
    pub fn cell_exposure_limit(&self) -> u64 {
        let limit = u128::from(self.capital_total) * u128::from(self.cell_exposure_bps)
            / u128::from(BPS_DENOMINATOR);
        u64::try_from(limit).unwrap_or(u64::MAX)
    }
}

/* -------------------------------------------------------------------------- */
/* CellState                                                                  */
/* -------------------------------------------------------------------------- */

/// Why a day cannot be written.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DayLogError {
    /// The day is not newer than the last one recorded. The log is append-only
    /// on purpose: a day that has already settled a policy must not be
    /// rewritten, and a correction arriving later is exactly that rewrite.
    NotNewer,
}

/// PDA `["cell", cell_id]`. Everything the settlement of a policy reads.
#[account]
#[derive(InitSpace)]
pub struct CellState {
    /// H3 index — `FR-006`. The grid level is read back out of it (`FR-069`),
    /// so a policy is settled at the level it was sold on.
    pub cell_id: u64,
    /// Registered sensors, at most `MAX_SENSORS_PER_CELL`.
    pub sensor_count: u8,
    /// `FR-045`: systematic divergence from the reference stops new policies
    /// on this cell. Policies already sold keep being served by the median —
    /// the reference moves future underwriting, never a live obligation.
    pub under_investigation: bool,
    /// Payout committed to policies on this cell — checked against
    /// `Pool::cell_exposure_limit`.
    pub reserved: u64,
    /// `FR-062`: the reward reserve belongs to the cell, fed by the premiums
    /// of its own policies and split between the sensors that voted.
    pub rewards_reserve: u64,
    /// Oldest day the ring buffer still holds.
    pub first_day_index: u32,
    /// Newest day recorded; `None` until the cell has its first day.
    pub last_day_index: Option<u32>,
    /// `0` no coverage, `1` dry, `2` wet, indexed by `day_index % DAY_LOG_LEN`.
    /// A day inside the window that was never written reads as no coverage,
    /// which is the honest answer and breaks a run — `FR-047`.
    pub day_log: [u8; DAY_LOG_LEN],
    /// Bitmask of the sensors that voted in that day, same slot.
    pub contributors: [u32; DAY_LOG_LEN],
    pub bump: u8,
}

impl CellState {
    fn slot(day_index: u32) -> usize {
        (day_index % DAY_LOG_LEN as u32) as usize
    }

    /// True when the day is inside the window the log can answer for.
    pub fn holds_day(&self, day_index: u32) -> bool {
        match self.last_day_index {
            Some(last) => day_index >= self.first_day_index && day_index <= last,
            None => false,
        }
    }

    /// The classification of a day, or `None` when the log cannot answer:
    /// before the window, after the last record, or nothing recorded yet.
    ///
    /// `None` is not "no coverage". A day that has not happened yet is not a
    /// day the network stayed silent through, and `dry_spell` must not read
    /// one as the other.
    pub fn day_state(&self, day_index: u32) -> Option<DayState> {
        if !self.holds_day(day_index) {
            return None;
        }
        DayState::from_u8(self.day_log[Self::slot(day_index)])
    }

    /// The sensors that voted in a day, as a bitmask over `slot_in_cell`.
    pub fn contributors_of(&self, day_index: u32) -> Option<u32> {
        if !self.holds_day(day_index) {
            return None;
        }
        Some(self.contributors[Self::slot(day_index)])
    }

    /// Independent votes the cell's most recent recorded day carried —
    /// `FR-022` as a fact about what the network published.
    ///
    /// `sensor_count` next door is the **registry**, and it is filled by
    /// `register_sensor`, which does not exist yet. Underwriting used to read
    /// it and therefore refused every policy: the field is zero on a cell that
    /// `submit_day_record` opened, and that is every cell there is. The day
    /// log answers the same question with evidence — `check_contributors`
    /// already refuses a measured day below the pool's minimum, so a day that
    /// carries votes carries enough of them.
    ///
    /// Zero when the cell has no record yet, and zero when its last day had no
    /// coverage: a network that has gone quiet is not coverage either, and
    /// erring towards refusing to sell is the safe direction.
    pub fn latest_votes(&self) -> u32 {
        match self.last_day_index {
            Some(last) => self.contributors_of(last).map_or(0, u32::count_ones),
            None => 0,
        }
    }

    /// Whether one sensor slot voted in a day.
    pub fn slot_voted(&self, day_index: u32, slot_in_cell: u8) -> bool {
        match self.contributors_of(day_index) {
            Some(mask) => mask & Self::slot_mask(slot_in_cell) != 0,
            None => false,
        }
    }

    /// Bit of one sensor slot. An out-of-range slot addresses nothing rather
    /// than wrapping onto somebody else's bit.
    pub fn slot_mask(slot_in_cell: u8) -> u32 {
        if slot_in_cell >= MAX_SENSORS_PER_CELL {
            return 0;
        }
        1u32 << slot_in_cell
    }

    /// Appends one day — `FR-015`, `FR-016`.
    ///
    /// Strictly newer than the last: the log only grows forwards. Days skipped
    /// in between stay at no coverage, so a gap in the network reads as a gap
    /// and breaks the run instead of being stitched over.
    pub fn record_day(
        &mut self,
        day_index: u32,
        state: DayState,
        contributors: u32,
    ) -> core::result::Result<(), DayLogError> {
        if let Some(last) = self.last_day_index {
            if day_index <= last {
                return Err(DayLogError::NotNewer);
            }
        }

        self.advance_window(day_index);

        let slot = Self::slot(day_index);
        self.day_log[slot] = state as u8;
        self.contributors[slot] = contributors;
        self.last_day_index = Some(day_index);
        Ok(())
    }

    /// Moves the window forward so `day_index` fits, clearing the slots the
    /// days leaving the window used to occupy. Without the clear, a slot would
    /// answer for a day 128 days older than the one being asked about.
    fn advance_window(&mut self, day_index: u32) {
        let len = DAY_LOG_LEN as u32;
        if day_index < self.first_day_index.saturating_add(len) {
            return;
        }

        let new_first = day_index - len + 1;
        if new_first - self.first_day_index >= len {
            self.day_log = [0u8; DAY_LOG_LEN];
            self.contributors = [0u32; DAY_LOG_LEN];
        } else {
            for day in self.first_day_index..new_first {
                let slot = Self::slot(day);
                self.day_log[slot] = 0;
                self.contributors[slot] = 0;
            }
        }
        self.first_day_index = new_first;
    }
}

/* -------------------------------------------------------------------------- */
/* Sensor                                                                     */
/* -------------------------------------------------------------------------- */

/// PDA `["sensor", sensor_key]`, where the seed is the ed25519 key the sensor
/// signs its readings with — `FR-001`, `FR-002`.
#[account]
#[derive(InitSpace)]
pub struct Sensor {
    /// The signing key, kept in the account so the PDA can be rebuilt from the
    /// data alone, the way `cell_id` is kept in `CellState`.
    pub sensor_key: Pubkey,
    /// Wallet rewards and burnt stake settle against — `FR-009` counts votes
    /// per operator, not per sensor.
    pub operator: Pubkey,
    /// Fixed at registration from the sensor's coordinates — `FR-058`. A
    /// reading names its cell and never its position.
    pub cell_id: u64,
    /// Bit this sensor occupies in the cell's `contributors` mask. Assigned
    /// once and never reused: `FR-012` deactivates a sensor, it does not free
    /// the slot, and a reused bit would rewrite who voted on a past day.
    pub slot_in_cell: u8,
    pub stake: u64,
    /// Day the thaw ends — `FR-053`. `None` while no withdrawal is pending.
    pub unlock_at_day: Option<u32>,
    pub accepted: u32,
    pub outliers: u32,
    /// `FR-012`: false once excluded for systematic outliers. Readings keep
    /// arriving and keep being stored; they simply stop counting.
    pub active: bool,
    pub bump: u8,
}

impl Sensor {
    /// Whether this sensor's reading counts towards the median — `FR-050`.
    /// Below the minimum stake a reading is stored and shown, but has no vote
    /// and earns nothing: that is the price of collusion.
    pub fn votes(&self, min_stake: u64) -> bool {
        self.active && self.stake >= min_stake
    }
}

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum PolicyState {
    Active,
    /// Paid — `FR-027` allows this exactly once.
    PaidOut,
    /// The window ended without the event.
    ClosedNoEvent,
    /// `FR-029`: the event happened and the transfer could not be delivered.
    /// The payout is not lost; it stays reserved for the owner to claim.
    Unclaimed,
}

/// PDA `["policy", owner, nonce]`.
#[account]
#[derive(InitSpace)]
pub struct Policy {
    /// `FR-066`: fixed at issue and never changed. There is no path to
    /// redirect someone else's payout, because there is no field to change.
    pub owner: Pubkey,
    /// Distinguishes several policies of one owner; part of the seeds, so it
    /// is stored to let the address be rebuilt from the account.
    pub nonce: u64,
    pub cell_id: u64,
    /// `FR-046`: consecutive dry days that trigger the event.
    pub spell_days_threshold: u8,
    pub payout: u64,
    /// `FR-025`: paid by the owner from their own wallet, so there is no
    /// separate payer field to hold.
    pub premium: u64,
    /// Day indices, inclusive. `FR-069`: the window is counted at the grid
    /// level this cell was sold on.
    pub window_start_day: u32,
    pub window_end_day: u32,
    pub state: PolicyState,
    pub bump: u8,
}

impl Policy {
    /// Length of the coverage window in days, both ends inclusive.
    pub fn window_days(&self) -> u32 {
        self.window_end_day.saturating_sub(self.window_start_day) + 1
    }
}

/* -------------------------------------------------------------------------- */
/* CapitalPosition                                                            */
/* -------------------------------------------------------------------------- */

/// PDA `["lp", owner]`. A share of the pool — `FR-032`.
#[account]
#[derive(InitSpace)]
pub struct CapitalPosition {
    pub owner: Pubkey,
    pub shares: u64,
    pub bump: u8,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A cell as `initialize` leaves it: nothing recorded, log all zeroes.
    fn empty_cell() -> CellState {
        CellState {
            cell_id: 0x871e701b3ffffff,
            sensor_count: 0,
            under_investigation: false,
            reserved: 0,
            rewards_reserve: 0,
            first_day_index: 0,
            last_day_index: None,
            day_log: [0u8; DAY_LOG_LEN],
            contributors: [0u32; DAY_LOG_LEN],
            bump: 254,
        }
    }

    fn pool(seconds_per_day: u32, genesis_ts: i64) -> Pool {
        Pool {
            authority: Pubkey::default(),
            aggregator: Pubkey::default(),
            asset_mint: Pubkey::default(),
            vault: Pubkey::default(),
            stake_vault: Pubkey::default(),
            capital_total: 0,
            reserved_total: 0,
            shares_total: 0,
            cell_exposure_bps: 1_000,
            premium_rewards_bps: 1_000,
            risk_loading_bps: 2_500,
            min_rate_bps: 100,
            min_sensors_per_cell: 3,
            min_stake: 0,
            unstake_delay_days: 30,
            waiting_period_days: 3,
            dry_day_threshold_mm_x100: 100,
            seconds_per_day,
            genesis_ts,
            bump: 255,
        }
    }

    /* ---------------------------------------------------------------- Pool */

    #[test]
    fn a_day_is_an_index_counted_from_genesis() {
        let pool = pool(86_400, 1_000_000);
        assert_eq!(pool.day_index(1_000_000), Some(0));
        assert_eq!(pool.day_index(1_000_000 + 86_399), Some(0));
        assert_eq!(pool.day_index(1_000_000 + 86_400), Some(1));
    }

    #[test]
    fn compressed_time_changes_the_clock_and_nothing_else() {
        // FR-049: the same instant is day 5 of a scenario run and day 0 of a
        // production pool. The arithmetic is one expression either way.
        let scenario = pool(2, 1_000_000);
        assert_eq!(scenario.day_index(1_000_010), Some(5));
        assert_eq!(pool(86_400, 1_000_000).day_index(1_000_010), Some(0));
    }

    #[test]
    fn before_genesis_is_not_day_zero() {
        assert_eq!(pool(86_400, 1_000_000).day_index(999_999), None);
    }

    #[test]
    fn a_pool_with_no_clock_has_no_days() {
        assert_eq!(pool(0, 0).day_index(1_000_000), None);
    }

    #[test]
    fn free_liquidity_is_what_is_left_after_active_policies() {
        let mut pool = pool(86_400, 0);
        pool.capital_total = 1_000;
        pool.reserved_total = 400;
        assert_eq!(pool.free_liquidity(), 600);

        // Reserved above capital would be a bug elsewhere; it must not wrap
        // into a pool that suddenly looks solvent — FR-019.
        pool.reserved_total = 1_500;
        assert_eq!(pool.free_liquidity(), 0);
    }

    #[test]
    fn cell_exposure_is_a_published_share_of_capital() {
        let mut pool = pool(86_400, 0);
        pool.capital_total = 1_000_000;
        pool.cell_exposure_bps = 1_000; // 10%
        assert_eq!(pool.cell_exposure_limit(), 100_000);

        // The multiplication goes through u128: u64::MAX * 10_000 overflows.
        pool.capital_total = u64::MAX;
        pool.cell_exposure_bps = 10_000;
        assert_eq!(pool.cell_exposure_limit(), u64::MAX);
    }

    /* ----------------------------------------------------------- Day log */

    #[test]
    fn a_recorded_day_reads_back() {
        let mut cell = empty_cell();
        cell.record_day(7, DayState::Dry, 0b101).unwrap();

        assert_eq!(cell.day_state(7), Some(DayState::Dry));
        assert_eq!(cell.contributors_of(7), Some(0b101));
        assert_eq!(cell.last_day_index, Some(7));
    }

    #[test]
    fn a_day_that_has_not_happened_is_not_a_day_without_coverage() {
        let mut cell = empty_cell();
        assert_eq!(cell.day_state(3), None);

        cell.record_day(3, DayState::Wet, 0b111).unwrap();
        // Day 4 is in the future, not a day the network stayed silent through.
        assert_eq!(cell.day_state(4), None);
        assert_eq!(cell.contributors_of(4), None);
    }

    #[test]
    fn a_skipped_day_reads_as_no_coverage_and_breaks_the_run() {
        let mut cell = empty_cell();
        cell.record_day(1, DayState::Dry, 0b11).unwrap();
        cell.record_day(2, DayState::Dry, 0b11).unwrap();
        // Day 3 never submitted — the network went quiet.
        cell.record_day(4, DayState::Dry, 0b11).unwrap();

        assert_eq!(cell.day_state(3), Some(DayState::NoCoverage));
        assert_eq!(cell.contributors_of(3), Some(0));

        let days: Vec<u8> = (1..=4)
            .map(|d| cell.day_state(d).unwrap() as u8)
            .collect();
        assert_eq!(crate::index::dry_spell(&days), 2);
    }

    #[test]
    fn the_log_only_grows_forwards() {
        let mut cell = empty_cell();
        cell.record_day(10, DayState::Dry, 1).unwrap();

        // FR-027 settles a policy from this log; rewriting a day it already
        // paid out on has to be impossible, not merely discouraged.
        assert_eq!(cell.record_day(10, DayState::Wet, 1), Err(DayLogError::NotNewer));
        assert_eq!(cell.record_day(9, DayState::Wet, 1), Err(DayLogError::NotNewer));
        assert_eq!(cell.day_state(10), Some(DayState::Dry));
    }

    #[test]
    fn the_window_holds_the_last_128_days() {
        let mut cell = empty_cell();
        for day in 0..DAY_LOG_LEN as u32 {
            cell.record_day(day, DayState::Dry, 1).unwrap();
        }
        assert_eq!(cell.first_day_index, 0);
        assert_eq!(cell.day_state(0), Some(DayState::Dry));

        // One more day pushes day 0 out; its slot must not answer for day 128.
        cell.record_day(DAY_LOG_LEN as u32, DayState::Wet, 1).unwrap();
        assert_eq!(cell.first_day_index, 1);
        assert_eq!(cell.day_state(0), None);
        assert_eq!(cell.day_state(DAY_LOG_LEN as u32), Some(DayState::Wet));
    }

    #[test]
    fn a_slot_never_answers_for_the_day_it_used_to_hold() {
        let mut cell = empty_cell();
        cell.record_day(5, DayState::Dry, 0b1111).unwrap();
        // Same slot 128 days later, written as wet.
        cell.record_day(5 + DAY_LOG_LEN as u32, DayState::Wet, 0b1).unwrap();

        assert_eq!(cell.day_state(5), None);
        assert_eq!(cell.day_state(5 + DAY_LOG_LEN as u32), Some(DayState::Wet));
        assert_eq!(cell.contributors_of(5 + DAY_LOG_LEN as u32), Some(0b1));
    }

    #[test]
    fn a_gap_longer_than_the_log_clears_it_whole() {
        let mut cell = empty_cell();
        for day in 0..10 {
            cell.record_day(day, DayState::Dry, 0b111).unwrap();
        }
        // The aggregator was down for a year.
        cell.record_day(1_000, DayState::Dry, 0b1).unwrap();

        assert_eq!(cell.first_day_index, 1_000 - DAY_LOG_LEN as u32 + 1);
        for day in 0..10 {
            assert_eq!(cell.day_state(day), None, "day {day} should be gone");
        }
        // Days inside the new window that were never written are gaps, and a
        // gap breaks a run — it is not evidence of drought.
        assert_eq!(cell.day_state(900), Some(DayState::NoCoverage));
        assert_eq!(cell.day_state(1_000), Some(DayState::Dry));
    }

    #[test]
    fn a_full_window_of_dry_days_is_a_spell_of_the_same_length() {
        let mut cell = empty_cell();
        for day in 0..MAX_COVERAGE_DAYS {
            cell.record_day(day, DayState::Dry, 0b111).unwrap();
        }
        let days: Vec<u8> = (0..MAX_COVERAGE_DAYS)
            .map(|d| cell.day_state(d).unwrap() as u8)
            .collect();
        assert_eq!(crate::index::dry_spell(&days), MAX_COVERAGE_DAYS);
    }

    /* -------------------------------------------------------- Contributors */

    #[test]
    fn one_bit_per_sensor_slot() {
        let mut cell = empty_cell();
        cell.record_day(1, DayState::Dry, 0b1010).unwrap();

        assert!(cell.slot_voted(1, 1));
        assert!(cell.slot_voted(1, 3));
        assert!(!cell.slot_voted(1, 0));
        assert!(!cell.slot_voted(1, 2));
    }

    #[test]
    fn a_slot_outside_the_mask_addresses_nothing() {
        // MAX_SENSORS_PER_CELL is the width of the mask; `1 << 32` would panic
        // in debug and wrap onto slot 0 in release.
        assert_eq!(CellState::slot_mask(MAX_SENSORS_PER_CELL), 0);
        assert_eq!(CellState::slot_mask(u8::MAX), 0);
        assert_eq!(CellState::slot_mask(31), 0x8000_0000);

        let mut cell = empty_cell();
        cell.record_day(1, DayState::Dry, u32::MAX).unwrap();
        assert!(!cell.slot_voted(1, MAX_SENSORS_PER_CELL));
    }

    #[test]
    fn a_day_nobody_voted_in_has_an_empty_mask() {
        let mut cell = empty_cell();
        cell.record_day(1, DayState::NoCoverage, 0).unwrap();
        assert_eq!(cell.contributors_of(1), Some(0));
        assert!(!cell.slot_voted(1, 0));
    }

    /* --------------------------------------------------------------- Rest */

    #[test]
    fn a_sensor_votes_only_with_stake_and_only_while_active() {
        let sensor = |stake, active| Sensor {
            sensor_key: Pubkey::default(),
            operator: Pubkey::default(),
            cell_id: 0,
            slot_in_cell: 0,
            stake,
            unlock_at_day: None,
            accepted: 0,
            outliers: 0,
            active,
            bump: 255,
        };

        assert!(sensor(1_000, true).votes(1_000));
        assert!(!sensor(999, true).votes(1_000));
        // FR-012: excluded for outliers. The readings keep arriving and keep
        // being stored; they stop counting.
        assert!(!sensor(1_000_000, false).votes(1_000));
    }

    #[test]
    fn coverage_is_what_the_last_recorded_day_carried() {
        // FR-022. Zero on a cell nothing has been written to — which is every
        // cell the moment `submit_day_record` opens it.
        let mut cell = empty_cell();
        assert_eq!(cell.latest_votes(), 0);

        cell.record_day(0, DayState::Dry, 0b111).unwrap();
        assert_eq!(cell.latest_votes(), 3);

        // The **last** day, not the best one: a cell that has gone quiet stops
        // being coverage the day it does, not at the end of the season.
        cell.record_day(1, DayState::Wet, 0b1).unwrap();
        assert_eq!(cell.latest_votes(), 1);

        // A day without coverage carries no contributors at all, so the answer
        // is zero rather than the last number that happened to be there.
        cell.record_day(2, DayState::NoCoverage, 0).unwrap();
        assert_eq!(cell.latest_votes(), 0);
    }

    #[test]
    fn a_coverage_window_counts_both_ends() {
        let policy = |start, end| Policy {
            owner: Pubkey::default(),
            nonce: 0,
            cell_id: 0,
            spell_days_threshold: 14,
            payout: 0,
            premium: 0,
            window_start_day: start,
            window_end_day: end,
            state: PolicyState::Active,
            bump: 255,
        };

        assert_eq!(policy(10, 10).window_days(), 1);
        assert_eq!(policy(10, 99).window_days(), MAX_COVERAGE_DAYS);
    }

    #[test]
    fn every_account_fits_the_size_a_pda_can_be_created_at() {
        // A PDA is initialised in one instruction only up to 10 KiB; past that
        // the account needs a realloc dance nothing here should need.
        const MAX_INIT: usize = 10_240;
        for space in [
            8 + Pool::INIT_SPACE,
            8 + CellState::INIT_SPACE,
            8 + Sensor::INIT_SPACE,
            8 + Policy::INIT_SPACE,
            8 + CapitalPosition::INIT_SPACE,
        ] {
            assert!(space <= MAX_INIT, "account of {space} bytes is too large");
        }
        // The day log and the contributor masks are the whole weight of a cell.
        assert!(CellState::INIT_SPACE > DAY_LOG_LEN * 5);
    }
}
