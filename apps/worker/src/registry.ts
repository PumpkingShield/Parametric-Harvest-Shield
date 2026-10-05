import {
  type Connection,
  decodeSensor,
  PROGRAM_ID,
  type PublicKey,
  SENSOR_DISCRIMINATOR,
  type SensorAccount,
} from '@pumpking/anchor-client'
import type { ChainSensor, RegistryMirrorStore, RegistryRow } from '@pumpking/db'
import { encodeBase58 } from '@pumpking/shared'

/**
 * The mirror of the on-chain sensor registry — `T076`, `FR-001`, `FR-050`.
 *
 * Registration is open and on chain (`register_sensor`, `T031`): anyone, from
 * any wallet, with no call to this service. So the service cannot learn about
 * a sensor from a request — it learns by reading the program's accounts, and
 * that is the whole of this file. The fifth dispatcher, and the first step of
 * a cycle, because every day it closes is a median over the sensors this
 * mirror says are voting (`votingSensor` in `@pumpking/db`).
 *
 * **The chain is read, not trusted to a signature.** An API that recorded a
 * registration from the transaction a client reported would miss every one
 * sent from elsewhere, and would believe a client that lied. `getProgramAccounts`
 * over the `Sensor` discriminator is one call and returns the registry as the
 * program has it — stake, exclusion and slot included.
 *
 * **Every few minutes, not every cycle.** A registry changes when an operator
 * registers or stakes, which is rare next to a cycle every few seconds, and a
 * scan returns every sensor at once. What the lag costs is bounded and
 * one-sided: a sensor staked in the last five minutes before a day closes
 * does not vote that day. Nobody loses a vote they already had.
 *
 * **Only what changed is written.** On the free deployment the database's
 * traffic allowance is spent on writes (`T073`), and rewriting a hundred rows
 * every five minutes to say nothing has changed is 29 000 rows a day of it.
 *
 * **Days wait for the first read.** Until the mirror has read the chain once
 * in this process, the cycle closes no day (`CycleSkip` `registry-unread`). A
 * day closed on a registry of unknown age — a fresh database, or one a
 * restart has not re-read — is written to the chain for good, and a cell whose
 * voters were not mirrored yet would be written as a day without coverage.
 * Waiting a cycle costs a few seconds; the backlog closes the day after.
 */

/** Five minutes — how stale a stake the median may run on. */
export const MIRROR_EVERY_MS = 300_000

/**
 * How soon a failed read is tried again. Shorter than the period, because a
 * worker that has not read the registry yet is closing no days; not every
 * cycle, because a scan the RPC refused with 429 is not helped by asking
 * again five seconds later.
 */
export const MIRROR_RETRY_MS = 30_000

/** Where the registry is read from. An interface so the diff is testable without a cluster. */
export interface RegistrySource {
  sensors(): Promise<ChainSensor[]>
}

/** A decoded `Sensor` account, as the store takes it. */
export function chainSensorOf(account: SensorAccount): ChainSensor {
  const cellId = BigInt(account.cellId.toString())
  const previousCellId = BigInt(account.previousCellId.toString())
  // The program writes "no previous slot" as the current cell and slot —
  // before the first move and after a reinstatement (`FR-059`). A move always
  // changes the cell, so the pair can only be equal on purpose.
  const moved = previousCellId !== cellId || account.previousSlot !== account.slotInCell
  return {
    pubkey: account.sensorKey.toBase58(),
    operatorWallet: account.operator.toBase58(),
    cellId,
    slotInCell: account.slotInCell,
    previousCellId: moved ? previousCellId : null,
    previousSlot: moved ? account.previousSlot : null,
    movedAt:
      account.movedAt === null ? null : new Date(Number(account.movedAt.toString()) * 1000),
    stake: BigInt(account.stake.toString()),
    accepted: account.accepted,
    outliers: account.outliers,
    active: account.active,
  }
}

/** The `RegistrySource` backed by a cluster — one `getProgramAccounts` a read. */
export function rpcRegistrySource(connection: Connection, programId?: PublicKey): RegistrySource {
  const program = programId ?? PROGRAM_ID
  return {
    async sensors() {
      const accounts = await connection.getProgramAccounts(program, {
        filters: [{ memcmp: { offset: 0, bytes: encodeBase58(SENSOR_DISCRIMINATOR) } }],
      })
      return accounts.map(({ account }) => chainSensorOf(decodeSensor(account.data)))
    },
  }
}

/** True when the row already says everything the chain does. */
function agrees(row: RegistryRow, chain: ChainSensor): boolean {
  return (
    row.mirrored &&
    row.operatorWallet === chain.operatorWallet &&
    row.cellId === chain.cellId &&
    row.slotInCell === chain.slotInCell &&
    row.previousCellId === chain.previousCellId &&
    row.previousSlot === chain.previousSlot &&
    row.movedAt?.getTime() === chain.movedAt?.getTime() &&
    row.stake === chain.stake &&
    row.accepted === chain.accepted &&
    row.outliers === chain.outliers &&
    row.active === chain.active
  )
}

/** What a read of the chain changes in the registry. */
export type RegistryDiff = {
  /** Sensors to write: new, changed, or never mirrored before. */
  changed: ChainSensor[]
  /**
   * Mirrored rows whose account the scan no longer returned. Reported and
   * left alone: the program closes no `Sensor` account today, so this is a
   * scan that came back short or a program that has changed, and neither is
   * a reason to take a vote away on the strength of one read.
   */
  missing: string[]
}

export function diffRegistry(
  chain: readonly ChainSensor[],
  rows: readonly RegistryRow[],
): RegistryDiff {
  const byKey = new Map(rows.map((row) => [row.pubkey, row]))
  const onChain = new Set(chain.map((sensor) => sensor.pubkey))
  return {
    changed: chain.filter((sensor) => {
      const row = byKey.get(sensor.pubkey)
      return row === undefined || !agrees(row, sensor)
    }),
    missing: rows
      .filter((row) => row.mirrored && !onChain.has(row.pubkey))
      .map((row) => row.pubkey),
  }
}

export type MirrorOutcome =
  | { status: 'mirrored'; onChain: number; written: number; missing: string[] }
  | { status: 'failed'; error: Error }

export interface RegistryMirror {
  /**
   * Reads the chain and writes the difference if a period has passed since
   * the last successful read (or a retry interval since the last failure),
   * and returns null otherwise.
   */
  syncIfDue(now: Date): Promise<MirrorOutcome | null>
  /** Whether a read has succeeded in this process — the cycle's gate on closing days. */
  readonly synced: boolean
}

export function registryMirror(
  source: RegistrySource,
  store: RegistryMirrorStore,
  everyMs: number = MIRROR_EVERY_MS,
  retryMs: number = MIRROR_RETRY_MS,
): RegistryMirror {
  for (const [name, value] of [
    ['everyMs', everyMs],
    ['retryMs', retryMs],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive integer: ${value}`)
    }
  }

  let synced = false
  let nextAt: number | null = null

  return {
    get synced() {
      return synced
    },

    async syncIfDue(now) {
      const at = now.getTime()
      if (nextAt !== null && at < nextAt) return null
      try {
        const chain = await source.sensors()
        const diff = diffRegistry(chain, await store.sensorRows())
        await store.mirrorSensors(diff.changed, now)
        synced = true
        nextAt = at + everyMs
        return {
          status: 'mirrored',
          onChain: chain.length,
          written: diff.changed.length,
          missing: diff.missing,
        }
      } catch (cause) {
        nextAt = at + retryMs
        return {
          status: 'failed',
          error: cause instanceof Error ? cause : new Error(String(cause)),
        }
      }
    },
  }
}
