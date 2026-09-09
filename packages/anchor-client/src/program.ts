import { PUMPKING_IDL } from './idl/idl.ts'
import { PublicKey } from './web3.ts'

/**
 * The deployed program — read out of the IDL rather than written down again.
 *
 * `declare_id!` in the program and this constant are the same value by
 * construction: `anchor build` stamps the address into the IDL, `pnpm idl:sync`
 * copies it here. A client pointed at a stale address derives every PDA under
 * it and finds nothing, which is the kind of failure that reads as "the pool
 * does not exist" rather than as a wrong constant.
 */
export const PROGRAM_ID: PublicKey = new PublicKey(PUMPKING_IDL.address)
