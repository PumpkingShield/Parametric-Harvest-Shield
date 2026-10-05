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
/// A cell's outlier record — `FR-011`, `FR-012`.
pub const REPUTATION_SEED: &[u8] = b"reputation";

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

/// The grid level sensors register on — `FR-060`: H3 res 7, ≈ 5.2 km².
///
/// Checked at registration and nowhere else. A policy carries its own cell id
/// and is settled at the level it was sold on (`FR-069`), so moving the network
/// to res 8 is a change here and an expansion of the grid, not a migration of
/// anything already written.
pub const GRID_RESOLUTION: u8 = 7;

/// Days over which a sensor's outliers are counted before it is excluded —
/// `FR-012`. A constant of the program rather than a field of the pool: the
/// thaw has to outlast it (`FR-053`), and a window the authority could shorten
/// in the middle of somebody's thaw would let that stake leave before the
/// count that should have burnt it was ever finished.
///
/// Twinned in `@pumpking/shared` (`outlier.ts`); the client checks the twin
/// against the value this constant puts in the IDL.
#[constant]
pub const OUTLIER_WINDOW_DAYS: u16 = 14;

/// The smallest distance from the cell median that is ever an outlier —
/// `FR-011`, in hundredths of a millimetre: 0.20 mm, the step of a typical
/// tipping-bucket gauge. Applied off chain; published here so the rule the
/// aggregator judges by is the program's, not the aggregator's.
#[constant]
pub const OUTLIER_FLOOR_X100: u32 = 20;

/// The share of the cell median a value may be off by before it is an
/// outlier — `FR-011`. The distance is `max(floor, median · this)`.
#[constant]
pub const OUTLIER_REL_BPS: u16 = 5000;

/// Above this share of outlier intervals in the window a sensor is excluded —
/// `FR-012`.
#[constant]
pub const OUTLIER_SHARE_BPS: u16 = 2000;

/// Judged intervals the window needs before the share counts — three days of
/// hourly intervals. Below it one bad hour would be a hundred per cent.
#[constant]
pub const OUTLIER_MIN_JUDGED: u16 = 72;

/// Days a cell's reputation ring holds: exactly the window, because a day
/// older than it is a day no exclusion may count.
pub const REPUTATION_DAYS: usize = OUTLIER_WINDOW_DAYS as usize;

/// Days a cell's reward schedule reaches ahead of the first day it has not
/// paid — `FR-062`. A policy's reward share is laid out over the days of its
/// window, so the window has to end inside this horizon: a 90-day cover can be
/// bought up to about 420 days before it starts, which is a season ahead with
/// room to spare. Past it `issue_policy` refuses with `WindowTooFarAhead`
/// rather than letting a far day land on the slot of a near one.
#[constant]
pub const REWARD_SCHEDULE_DAYS: u16 = 512;

/// What one judged interval is worth in the weights the aggregator sends with
/// a day — `FR-062`. Each interval hands this out between its votes, a vote's
/// part equally between the vote's accepted sensors, and a slot's weight is the
/// sum over the day. The program divides the day's budget in proportion to the
/// weights, so the unit sets the precision of the split and nothing else.
///
/// Twinned in `@pumpking/shared` (`rewards.ts`).
#[constant]
pub const REWARD_WEIGHT_UNIT: u32 = 1000000;

/// `REWARD_SCHEDULE_DAYS` as an index width.
pub const SCHEDULE_LEN: usize = REWARD_SCHEDULE_DAYS as usize;

/// A cell's reward schedule — `FR-062`.
pub const REWARDS_SEED: &[u8] = b"rewards";

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
    /// Reward share of premiums taken before the cell had a schedule. Since
    /// `T036` the reserve lives in `CellRewards::reserve`, and opening that
    /// account returns what is here to capital — it was never laid out over
    /// any day, so no day could pay it. Zero from then on; the field stays
    /// because the deployed cells carry it.
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
    /// The cell and slot the sensor held before its last move — `FR-059`.
    /// Equal to `cell_id` and `slot_in_cell` when there is none: before the
    /// first move, and after `reinstate_sensor` wipes the record. A move
    /// always takes a fresh slot, so the two can only be equal on purpose.
    /// The old slot stays the sensor's: its record counts towards an
    /// exclusion while the window reaches back to it, and what it earned is
    /// still the operator's to claim.
    pub previous_cell_id: u64,
    pub previous_slot: u8,
    /// Unix time of the last move, `None` for a sensor that never moved. The
    /// aggregator reads the interval boundary off it: the old cell counts the
    /// intervals that ended before it, the new one those that start after.
    /// It also spaces moves a window apart, and a reinstatement keeps it.
    pub moved_at: Option<i64>,
    /// Stake that votes — `FR-050`. What the registry mirror reads as stake.
    pub stake: u64,
    /// Stake on its way out — `FR-053`. Moved here from `stake` by
    /// `request_unstake`, it no longer votes but stays in the stake vault and
    /// burns with the rest if the sensor is excluded (`FR-052`): a thaw is a
    /// promise to leave, not a way out of what the readings already did.
    pub unstaking: u64,
    /// Day the thaw ends — `FR-053`. `None` while nothing is thawing.
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

    /// The cell and slot held before the last move, or `None` when there is
    /// no such slot to answer for — `FR-059`.
    pub fn previous(&self) -> Option<(u64, u8)> {
        let previous = (self.previous_cell_id, self.previous_slot);
        (previous != (self.cell_id, self.slot_in_cell)).then_some(previous)
    }

    /// Forgets the slot before the last move.
    pub fn drop_previous(&mut self) {
        self.previous_cell_id = self.cell_id;
        self.previous_slot = self.slot_in_cell;
    }

    /// The slot this sensor holds in `cell_id` — the current one, or the one
    /// before the last move — or `None`. A move always changes the cell, so
    /// the two are never in the same one: a sensor that moves back into a
    /// cell it left takes a fresh slot there, and the pointer names the cell
    /// it has just come from.
    pub fn slot_in(&self, cell_id: u64) -> Option<u8> {
        if self.cell_id == cell_id {
            return Some(self.slot_in_cell);
        }
        self.previous()
            .and_then(|(cell, slot)| (cell == cell_id).then_some(slot))
    }
}

/* -------------------------------------------------------------------------- */
/* CellReputation                                                             */
/* -------------------------------------------------------------------------- */

/// One day of a cell's verdicts, per sensor slot — `FR-011`.
#[zero_copy]
#[derive(PartialEq, Eq, Debug)]
pub struct ReputationDay {
    pub day_index: u32,
    /// Intervals each slot was judged in that day.
    pub judged: [u16; MAX_SENSORS_PER_CELL as usize],
    /// Of those, the ones it was an outlier in.
    pub outliers: [u16; MAX_SENSORS_PER_CELL as usize],
}

impl ReputationDay {
    const EMPTY: Self = Self {
        day_index: 0,
        judged: [0; MAX_SENSORS_PER_CELL as usize],
        outliers: [0; MAX_SENSORS_PER_CELL as usize],
    };
}

/// Why a reputation day cannot be written.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReputationError {
    /// The ring only grows forwards, like the day log it follows.
    NotNewer,
}

/// PDA `["reputation", cell_id]` — the record `exclude_sensor` judges by.
///
/// Its own account rather than more of `CellState`: the cell's layout is what
/// the deployed demo pool already holds, and a ring of the window is all the
/// program ever needs to read. A day older than `OUTLIER_WINDOW_DAYS` counts
/// for no exclusion, so it is overwritten rather than kept.
///
/// **Zero-copy**, unlike every other account here. At close to two kilobytes
/// the ring does not fit beside anything else in the 4 KiB frame
/// `try_accounts` is given — boxing does not help, because the struct is
/// built on the stack before it is boxed — so it is read in place. The fields
/// are laid out with no padding, which makes the bytes the same as Borsh would
/// write and keeps the client's decoder honest.
#[account(zero_copy)]
pub struct CellReputation {
    pub cell_id: u64,
    /// The last day written, meaningful only once `has_days` is set.
    pub last_day_index: u32,
    pub bump: u8,
    /// `1` once a day has been written. Not an `Option`: zero-copy has none.
    pub has_days: u8,
    pub padding: [u8; 2],
    /// Indexed by `day_index % REPUTATION_DAYS`.
    pub days: [ReputationDay; REPUTATION_DAYS],
}

impl CellReputation {
    /// Bytes after the discriminator.
    pub const SPACE: usize = std::mem::size_of::<Self>();

    /// The last day written, or `None` before the first.
    pub fn last_day(&self) -> Option<u32> {
        (self.has_days != 0).then_some(self.last_day_index)
    }

    /// Writes one day, which has to be newer than the last.
    pub fn record_day(
        &mut self,
        day_index: u32,
        judged: [u16; MAX_SENSORS_PER_CELL as usize],
        outliers: [u16; MAX_SENSORS_PER_CELL as usize],
    ) -> std::result::Result<(), ReputationError> {
        if let Some(last) = self.last_day() {
            if day_index <= last {
                return Err(ReputationError::NotNewer);
            }
        }
        self.days[day_index as usize % REPUTATION_DAYS] = ReputationDay {
            day_index,
            judged,
            outliers,
        };
        self.last_day_index = day_index;
        self.has_days = 1;
        Ok(())
    }

    /// A slot's judged and outlier intervals over the days `[from, to]`.
    ///
    /// An entry left from an earlier lap of the ring carries its own day and
    /// falls outside the range, so a day nobody wrote counts for nothing —
    /// which is right: no record is not a bad one.
    pub fn window(&self, slot: u8, from: u32, to: u32) -> (u32, u32) {
        let slot = usize::from(slot);
        if slot >= MAX_SENSORS_PER_CELL as usize {
            return (0, 0);
        }
        let mut judged = 0u32;
        let mut outliers = 0u32;
        for day in &self.days {
            if day.day_index < from || day.day_index > to {
                continue;
            }
            // A ring that was never written is all zeroes, day 0 included:
            // it lands in the range only to add nothing.
            judged += u32::from(day.judged[slot]);
            outliers += u32::from(day.outliers[slot]);
        }
        (judged, outliers)
    }

    /// Forgets a slot's history — the clean slate `reinstate_sensor` gives.
    pub fn clear_slot(&mut self, slot: u8) {
        let slot = usize::from(slot);
        if slot >= MAX_SENSORS_PER_CELL as usize {
            return;
        }
        for day in &mut self.days {
            day.judged[slot] = 0;
            day.outliers[slot] = 0;
        }
    }

    pub fn empty(cell_id: u64, bump: u8) -> Self {
        Self {
            cell_id,
            last_day_index: 0,
            bump,
            has_days: 0,
            padding: [0; 2],
            days: [ReputationDay::EMPTY; REPUTATION_DAYS],
        }
    }
}

/// The days an exclusion on `today` counts: the window of closed days before
/// it — `[today − OUTLIER_WINDOW_DAYS, today − 1]` — or none on day zero.
pub fn outlier_window(today: u32) -> Option<(u32, u32)> {
    let to = today.checked_sub(1)?;
    Some((today.saturating_sub(u32::from(OUTLIER_WINDOW_DAYS)), to))
}

/* -------------------------------------------------------------------------- */
/* CellRewards                                                                */
/* -------------------------------------------------------------------------- */

/// Why the reward schedule refuses a change.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RewardsError {
    /// A day at or before one already paid or returned.
    NotNewer,
    /// A window that starts before the first unpaid day — its early days
    /// would never be paid.
    BeforeSchedule,
    /// A window that ends past the schedule's horizon — its late days would
    /// land on the slots of near ones.
    TooFarAhead,
    Overflow,
}

/// What paying one day did to the money.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct DayPayout {
    /// Handed to the slots, now theirs to claim.
    pub distributed: u64,
    /// Back to capital: the budget of days without coverage — the ones
    /// skipped as well as the one paid, if nobody earned it — and the dust of
    /// the division — `FR-064`.
    pub returned: u64,
}

/// PDA `["rewards", cell_id]` — where the reward share of a cell's premiums
/// waits for the days that earn it, and where what they earned waits to be
/// claimed — `FR-036`, `FR-062`, `FR-064`.
///
/// **A schedule, not a pot.** `issue_policy` lays a policy's reward share out
/// evenly over the days of its window; each day, in the transaction that
/// writes it, hands its budget to the slots that earned it or, without
/// coverage, back to capital. So a sensor is paid for the day it worked
/// (`FR-061`), a cell with no policy earns nothing because its schedule is
/// zero (`FR-063`), and nothing waits for a policy to close.
///
/// `next_day` is the cursor: every day before it is settled one way or the
/// other. A day the aggregator never wrote is a day without coverage, as in
/// the day log, so paying any later day returns the skipped days' budget too.
///
/// Zero-copy for the reason `CellReputation` is: four kilobytes of schedule
/// do not fit in the `try_accounts` frame. No padding, so the bytes are Borsh.
#[account(zero_copy)]
pub struct CellRewards {
    pub cell_id: u64,
    /// Reward money of this cell in the capital vault: scheduled plus earned
    /// and not yet claimed. Never part of `capital_total` (`FR-061`).
    pub reserve: u64,
    /// The first day not yet paid or returned.
    pub next_day: u32,
    pub bump: u8,
    pub padding: [u8; 3],
    /// Earned and not yet claimed, per sensor slot.
    pub accrued: [u64; MAX_SENSORS_PER_CELL as usize],
    /// Budget of each day in `[next_day, next_day + REWARD_SCHEDULE_DAYS)`,
    /// indexed by `day % REWARD_SCHEDULE_DAYS`.
    pub schedule: [u64; SCHEDULE_LEN],
}

impl CellRewards {
    /// Bytes after the discriminator.
    pub const SPACE: usize = std::mem::size_of::<Self>();

    fn slot(day: u32) -> usize {
        day as usize % SCHEDULE_LEN
    }

    /// The budget of one day, or zero for a day outside the schedule.
    pub fn budget_of(&self, day: u32) -> u64 {
        let ahead = day.checked_sub(self.next_day);
        match ahead {
            Some(ahead) if (ahead as usize) < SCHEDULE_LEN => self.schedule[Self::slot(day)],
            _ => 0,
        }
    }

    /// Lays `amount` out evenly over `[start, end]` — `FR-062`.
    ///
    /// The remainder of the division goes one unit each to the first days, so
    /// the schedule holds exactly what the premium put aside.
    pub fn schedule_window(
        &mut self,
        amount: u64,
        start: u32,
        end: u32,
    ) -> std::result::Result<(), RewardsError> {
        if start < self.next_day {
            return Err(RewardsError::BeforeSchedule);
        }
        let horizon = u64::from(self.next_day) + SCHEDULE_LEN as u64;
        if end < start || u64::from(end) >= horizon {
            return Err(RewardsError::TooFarAhead);
        }
        let days = u64::from(end - start) + 1;
        let base = amount / days;
        let extra = amount % days;
        for (i, day) in (start..=end).enumerate() {
            let share = base + u64::from((i as u64) < extra);
            let slot = &mut self.schedule[Self::slot(day)];
            *slot = slot.checked_add(share).ok_or(RewardsError::Overflow)?;
        }
        self.reserve = self
            .reserve
            .checked_add(amount)
            .ok_or(RewardsError::Overflow)?;
        Ok(())
    }

    /// Pays day `day` in proportion to `weights` and returns every skipped
    /// day's budget — `FR-062`, `FR-064`.
    ///
    /// All-zero weights are a day nobody earned: its budget goes back to
    /// capital with the skipped ones. The division rounds each slot down, and
    /// the dust goes to capital, the direction every rounding here takes.
    pub fn pay_day(
        &mut self,
        day: u32,
        weights: &[u64; MAX_SENSORS_PER_CELL as usize],
    ) -> std::result::Result<DayPayout, RewardsError> {
        if day < self.next_day {
            return Err(RewardsError::NotNewer);
        }

        let mut returned = 0u64;
        let skipped = day - self.next_day;
        if skipped as usize >= SCHEDULE_LEN {
            // Every scheduled day is behind `day`: the whole schedule goes.
            for budget in &mut self.schedule {
                returned = returned
                    .checked_add(*budget)
                    .ok_or(RewardsError::Overflow)?;
                *budget = 0;
            }
        } else {
            for past in self.next_day..day {
                let budget = &mut self.schedule[Self::slot(past)];
                returned = returned
                    .checked_add(*budget)
                    .ok_or(RewardsError::Overflow)?;
                *budget = 0;
            }
        }

        // Zero after a sweep of the whole schedule, which is right: a day that
        // far past the cursor was never inside the horizon to be scheduled.
        let budget = std::mem::take(&mut self.schedule[Self::slot(day)]);

        let total: u128 = weights.iter().map(|w| u128::from(*w)).sum();
        let mut distributed = 0u64;
        if total > 0 {
            for (accrued, weight) in self.accrued.iter_mut().zip(weights) {
                // At most `budget`, so the narrowing cannot fail.
                let share = (u128::from(budget) * u128::from(*weight) / total) as u64;
                *accrued = accrued.checked_add(share).ok_or(RewardsError::Overflow)?;
                distributed += share;
            }
        }
        returned = returned
            .checked_add(budget - distributed)
            .ok_or(RewardsError::Overflow)?;

        self.reserve = self
            .reserve
            .checked_sub(returned)
            .ok_or(RewardsError::Overflow)?;
        self.next_day = day + 1;
        Ok(DayPayout {
            distributed,
            returned,
        })
    }

    /// Takes everything a slot has earned, leaving it at zero.
    pub fn take_accrued(&mut self, slot: u8) -> std::result::Result<u64, RewardsError> {
        let slot = usize::from(slot);
        if slot >= MAX_SENSORS_PER_CELL as usize {
            return Ok(0);
        }
        let amount = std::mem::take(&mut self.accrued[slot]);
        // `reserve` holds every slot's accrual, so a shortfall is a bug in the
        // books, and it fails the transaction rather than hiding.
        self.reserve = self
            .reserve
            .checked_sub(amount)
            .ok_or(RewardsError::Overflow)?;
        Ok(amount)
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
            previous_cell_id: 0,
            previous_slot: 0,
            moved_at: None,
            stake,
            unstaking: 0,
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

    fn slots(pairs: &[(usize, u16)]) -> [u16; MAX_SENSORS_PER_CELL as usize] {
        let mut out = [0u16; MAX_SENSORS_PER_CELL as usize];
        for &(slot, n) in pairs {
            out[slot] = n;
        }
        out
    }

    #[test]
    fn the_reputation_ring_sums_a_slot_over_the_window_only() {
        let mut rep = CellReputation::empty(1, 255);
        for day in 0..20u32 {
            rep.record_day(day, slots(&[(2, 24)]), slots(&[(2, (day % 2) as u16)]))
                .unwrap();
        }
        // Days 6..=19 survive the ring; day 5 was overwritten by day 19.
        assert_eq!(rep.window(2, 6, 19), (14 * 24, 7));
        assert_eq!(rep.window(2, 0, 5), (0, 0));
        assert_eq!(rep.window(2, 18, 19), (48, 1));
        // Another slot, and a slot the mask cannot address, have nothing.
        assert_eq!(rep.window(3, 0, 19), (0, 0));
        assert_eq!(rep.window(MAX_SENSORS_PER_CELL, 0, 19), (0, 0));
    }

    #[test]
    fn the_reputation_ring_has_no_padding() {
        // What makes the zero-copy bytes the Borsh bytes the client decodes.
        assert_eq!(std::mem::size_of::<ReputationDay>(), 4 + 2 * 2 * 32);
        assert_eq!(
            CellReputation::SPACE,
            8 + 4 + 1 + 1 + 2 + REPUTATION_DAYS * std::mem::size_of::<ReputationDay>()
        );
    }

    #[test]
    fn the_reputation_ring_only_grows_forwards() {
        let mut rep = CellReputation::empty(1, 255);
        rep.record_day(7, slots(&[]), slots(&[])).unwrap();
        assert_eq!(
            rep.record_day(7, slots(&[]), slots(&[])),
            Err(ReputationError::NotNewer)
        );
        assert_eq!(
            rep.record_day(3, slots(&[]), slots(&[])),
            Err(ReputationError::NotNewer)
        );
        // A gap is fine: a day the aggregator had no verdicts for adds nothing.
        rep.record_day(30, slots(&[]), slots(&[])).unwrap();
    }

    #[test]
    fn a_cleared_slot_has_no_history_and_the_others_keep_theirs() {
        let mut rep = CellReputation::empty(1, 255);
        rep.record_day(1, slots(&[(0, 24), (1, 24)]), slots(&[(0, 24), (1, 3)]))
            .unwrap();
        rep.clear_slot(0);
        assert_eq!(rep.window(0, 0, 13), (0, 0));
        assert_eq!(rep.window(1, 0, 13), (24, 3));
    }

    /* ------------------------------------------------------------ Rewards */

    fn rewards(next_day: u32) -> CellRewards {
        let mut rewards = <CellRewards as bytemuck::Zeroable>::zeroed();
        rewards.next_day = next_day;
        rewards
    }

    fn weights(pairs: &[(usize, u64)]) -> [u64; MAX_SENSORS_PER_CELL as usize] {
        let mut out = [0u64; MAX_SENSORS_PER_CELL as usize];
        for &(slot, w) in pairs {
            out[slot] = w;
        }
        out
    }

    /// The books balance: the reserve is exactly the schedule plus what the
    /// slots have earned.
    fn assert_reserve_holds(rewards: &CellRewards) {
        let scheduled: u64 = rewards.schedule.iter().sum();
        let accrued: u64 = rewards.accrued.iter().sum();
        assert_eq!(rewards.reserve, scheduled + accrued);
    }

    #[test]
    fn a_window_holds_exactly_the_reward_share_with_the_remainder_up_front() {
        let mut r = rewards(10);
        r.schedule_window(1_003, 20, 29).unwrap();
        assert_eq!(r.budget_of(20), 101);
        assert_eq!(r.budget_of(22), 101);
        assert_eq!(r.budget_of(23), 100);
        assert_eq!(r.budget_of(29), 100);
        assert_eq!(r.budget_of(30), 0);
        assert_eq!(r.reserve, 1_003);
        assert_reserve_holds(&r);
    }

    #[test]
    fn overlapping_windows_add_up_day_by_day() {
        let mut r = rewards(0);
        r.schedule_window(100, 5, 9).unwrap();
        r.schedule_window(30, 8, 10).unwrap();
        assert_eq!(r.budget_of(7), 20);
        assert_eq!(r.budget_of(8), 30);
        assert_eq!(r.budget_of(10), 10);
        assert_reserve_holds(&r);
    }

    #[test]
    fn a_window_has_to_end_inside_the_horizon() {
        let mut r = rewards(100);
        let last = 100 + u32::from(REWARD_SCHEDULE_DAYS) - 1;
        assert!(r.schedule_window(90, last - 89, last).is_ok());
        assert_eq!(
            r.schedule_window(90, last - 88, last + 1),
            Err(RewardsError::TooFarAhead)
        );
        // Nothing was written by the refusal.
        assert_eq!(r.reserve, 90);
        assert_reserve_holds(&r);
    }

    #[test]
    fn a_window_cannot_start_on_a_day_already_paid() {
        let mut r = rewards(100);
        assert_eq!(
            r.schedule_window(10, 99, 105),
            Err(RewardsError::BeforeSchedule)
        );
    }

    #[test]
    fn a_day_divides_its_budget_by_weight_and_dust_goes_to_capital() {
        let mut r = rewards(0);
        r.schedule_window(100, 0, 0).unwrap();
        let paid = r.pay_day(0, &weights(&[(0, 1), (1, 1), (2, 1)])).unwrap();
        assert_eq!(r.accrued[..3], [33, 33, 33]);
        assert_eq!(
            paid,
            DayPayout {
                distributed: 99,
                returned: 1
            }
        );
        assert_eq!(r.next_day, 1);
        assert_reserve_holds(&r);
    }

    #[test]
    fn a_day_nobody_earned_returns_its_budget() {
        let mut r = rewards(0);
        r.schedule_window(70, 0, 6).unwrap();
        let paid = r.pay_day(0, &weights(&[])).unwrap();
        assert_eq!(
            paid,
            DayPayout {
                distributed: 0,
                returned: 10
            }
        );
        assert_eq!(r.reserve, 60);
        assert_reserve_holds(&r);
    }

    #[test]
    fn days_never_written_go_back_with_the_next_day_paid() {
        let mut r = rewards(0);
        r.schedule_window(70, 0, 6).unwrap();
        r.pay_day(0, &weights(&[(0, 1)])).unwrap();
        // Days 1..=3 never reached the chain.
        let paid = r.pay_day(4, &weights(&[(0, 1)])).unwrap();
        assert_eq!(
            paid,
            DayPayout {
                distributed: 10,
                returned: 30
            }
        );
        assert_eq!(r.accrued[0], 20);
        assert_eq!(r.budget_of(5), 10);
        assert_reserve_holds(&r);
    }

    #[test]
    fn a_gap_longer_than_the_schedule_returns_all_of_it() {
        let mut r = rewards(0);
        r.schedule_window(900, 400, 489).unwrap();
        r.schedule_window(10, 1, 1).unwrap();
        let paid = r.pay_day(5_000, &weights(&[(0, 1)])).unwrap();
        assert_eq!(
            paid,
            DayPayout {
                distributed: 0,
                returned: 910
            }
        );
        assert_eq!(r.reserve, 0);
        assert_eq!(r.next_day, 5_001);
        assert_reserve_holds(&r);
    }

    #[test]
    fn a_day_is_paid_once() {
        let mut r = rewards(0);
        r.pay_day(3, &weights(&[])).unwrap();
        assert_eq!(r.pay_day(3, &weights(&[])), Err(RewardsError::NotNewer));
        assert_eq!(r.pay_day(2, &weights(&[])), Err(RewardsError::NotNewer));
    }

    #[test]
    fn a_claim_takes_the_slot_to_zero() {
        let mut r = rewards(0);
        r.schedule_window(50, 0, 0).unwrap();
        r.pay_day(0, &weights(&[(4, 3), (5, 2)])).unwrap();
        assert_eq!(r.take_accrued(4), Ok(30));
        assert_eq!(r.take_accrued(4), Ok(0));
        assert_eq!(r.take_accrued(MAX_SENSORS_PER_CELL), Ok(0));
        assert_eq!(r.reserve, 20);
        assert_reserve_holds(&r);
    }

    #[test]
    fn the_reward_schedule_has_no_padding() {
        assert_eq!(
            CellRewards::SPACE,
            8 + 8 + 4 + 1 + 3 + 8 * MAX_SENSORS_PER_CELL as usize + 8 * SCHEDULE_LEN
        );
    }

    #[test]
    fn the_outlier_window_is_the_closed_days_before_today() {
        assert_eq!(outlier_window(0), None);
        assert_eq!(outlier_window(1), Some((0, 0)));
        assert_eq!(outlier_window(20), Some((6, 19)));
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
            8 + CellReputation::SPACE,
            8 + CellRewards::SPACE,
        ] {
            assert!(space <= MAX_INIT, "account of {space} bytes is too large");
        }
        // The day log and the contributor masks are the whole weight of a cell.
        assert!(CellState::INIT_SPACE > DAY_LOG_LEN * 5);
    }
}
