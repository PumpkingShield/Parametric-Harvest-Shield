import type { SignedReadingWire } from '@pumpking/shared/reading-bytes'

/**
 * The phone's sensor key and what has to survive a reload with it — `FR-005`.
 *
 * The secret is generated here and never leaves the device (`PLAN.md`,
 * "Кастодія"): the server sees the public key and signatures, nothing else.
 * It is kept as raw bytes for `@noble/ed25519`, the signer the hardware
 * sensors and `signReading` use — one signature scheme, one set of bytes, so
 * the phone is a sensor on equal terms and not a variant of one.
 *
 * Two more things live beside the key, because each one is wrong without it:
 *
 * - **the last counter.** `FR-003` refuses a used counter. It is written
 *   *before* the reading is sent, so a reload mid-request cannot sign a second
 *   reading under the same number — that one would be refused as a replay.
 * - **the reading in flight.** A 3G link drops answers (`SC-009`). The API
 *   takes the same signed body twice as one reading (`readings.ts`), so the
 *   honest retry is the identical body, and the body is kept until an answer
 *   says what happened to it.
 */
export type SensorRecord = {
  secretKey: Uint8Array
  lastCounter: bigint
  pending: SignedReadingWire | null
}

export interface SensorVault {
  load(): Promise<SensorRecord | null>
  save(record: SensorRecord): Promise<void>
}

/** A fresh key: 32 random bytes, which is all an ed25519 secret is. */
export function newRecord(): SensorRecord {
  return { secretKey: crypto.getRandomValues(new Uint8Array(32)), lastCounter: 0n, pending: null }
}

/** For tests, and for a browser that refuses IndexedDB. */
export function memoryVault(initial: SensorRecord | null = null): SensorVault {
  let stored = initial
  return {
    load: () => Promise.resolve(stored),
    save: (record) => {
      stored = record
      return Promise.resolve()
    },
  }
}

const DB_NAME = 'pumpking-sensor'
const STORE = 'sensor'
/** One phone, one sensor: the record has a fixed key (the operator has its own, below). */
const RECORD_KEY = 'this-phone'

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

function open(): Promise<IDBDatabase> {
  const req = indexedDB.open(DB_NAME, 1)
  req.onupgradeneeded = () => {
    req.result.createObjectStore(STORE)
  }
  return request(req)
}

function isRecord(value: unknown): value is SensorRecord {
  if (typeof value !== 'object' || value === null) return false
  return (
    'secretKey' in value &&
    value.secretKey instanceof Uint8Array &&
    value.secretKey.length === 32 &&
    'lastCounter' in value &&
    typeof value.lastCounter === 'bigint' &&
    'pending' in value
  )
}

/**
 * IndexedDB, because it stores a `Uint8Array` and a `bigint` as themselves —
 * structured clone, no encoding to get wrong.
 *
 * The first save asks the browser to keep the storage (`persist()`). Without
 * that, a browser short of space may clear it, and with it the key: the
 * sensor is then gone, and its stake waits for its operator to withdraw it.
 * The answer is not acted on — a browser that says no still stores the key.
 */
export function indexedDbVault(): SensorVault {
  let persistAsked = false
  return {
    async load() {
      const db = await open()
      try {
        const value: unknown = await request(
          db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD_KEY),
        )
        return isRecord(value) ? value : null
      } finally {
        db.close()
      }
    },
    async save(record) {
      if (!persistAsked) {
        persistAsked = true
        // Not awaited: Firefox may answer with a permission prompt, and the
        // key is not to wait on a person reading one.
        void navigator.storage?.persist?.().catch(() => false)
      }
      const db = await open()
      try {
        // `complete`, not the put's `success`: the counter is saved so that it
        // is on disk before the reading leaves, and only `complete` says so.
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put(record, RECORD_KEY)
        await committed(tx)
      } finally {
        db.close()
      }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* The operator                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The operator's wallet — `T038a`, `FR-001`, `FR-007`.
 *
 * A second key, not the sensor's: the sensor key signs readings, the operator
 * pays for the registration, owns the stake and is paid the rewards. One
 * operator may run several sensors, and a sensor key that also held the money
 * would make every reading device a wallet.
 *
 * Kept the same way, as the 32-byte ed25519 seed, beside the sensor's record
 * in the same database. It is the one secret on this phone worth money (on
 * devnet, a mock of money), so the page offers it for download: a cleared
 * browser without a copy loses the stake.
 */
export type OperatorRecord = { secretKey: Uint8Array }

export interface OperatorVault {
  load(): Promise<OperatorRecord | null>
  save(record: OperatorRecord): Promise<void>
}

export function newOperator(): OperatorRecord {
  return { secretKey: crypto.getRandomValues(new Uint8Array(32)) }
}

export function memoryOperatorVault(initial: OperatorRecord | null = null): OperatorVault {
  let stored = initial
  return {
    load: () => Promise.resolve(stored),
    save: (record) => {
      stored = record
      return Promise.resolve()
    },
  }
}

const OPERATOR_KEY = 'operator'

function isOperator(value: unknown): value is OperatorRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'secretKey' in value &&
    value.secretKey instanceof Uint8Array &&
    value.secretKey.length === 32
  )
}

/** The same database and store as the sensor, under its own key. */
export function indexedDbOperatorVault(): OperatorVault {
  return {
    async load() {
      const db = await open()
      try {
        const value: unknown = await request(
          db.transaction(STORE, 'readonly').objectStore(STORE).get(OPERATOR_KEY),
        )
        return isOperator(value) ? value : null
      } finally {
        db.close()
      }
    },
    async save(record) {
      void navigator.storage?.persist?.().catch(() => false)
      const db = await open()
      try {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put(record, OPERATOR_KEY)
        await committed(tx)
      } finally {
        db.close()
      }
    },
  }
}
