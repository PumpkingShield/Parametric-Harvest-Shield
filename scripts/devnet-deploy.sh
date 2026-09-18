#!/usr/bin/env bash
# Deploys the program to devnet — step 0 of docs/DEPLOY.md.
# Run from WSL: wsl -d <distro> -- bash <path to repo>/scripts/devnet-deploy.sh
#
# Every check here exists because its absence is silent. A .so older than the
# sources deploys last week's program; a program id that disagrees with
# declare_id! deploys to an address the client never calls; too small a balance
# fails halfway and leaves a buffer holding the rent.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Found from the script's own location: the path of this working copy is
# not part of the project, and hard-coding it breaks the script everywhere
# else.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SO="$REPO/target/deploy/pumpking.so"
KEYPAIR="$REPO/target/deploy/pumpking-keypair.json"
CLUSTER=devnet
URL=https://api.devnet.solana.com

cd "$REPO"

[ -f "$SO" ] || { echo "no $SO — run scripts/anchor-build.sh first"; exit 1; }
[ -f "$KEYPAIR" ] || { echo "no $KEYPAIR — run scripts/anchor-build.sh first"; exit 1; }

# The .so has to be newer than every source it was built from. `anchor deploy`
# does not check, and a stale artefact is indistinguishable from a fresh one
# once it is on chain.
NEWER=$(find programs/pumpking/src -name '*.rs' -newer "$SO" | head -1 || true)
[ -z "$NEWER" ] || { echo "stale build: $NEWER is newer than the .so — run scripts/anchor-build.sh"; exit 1; }

PROGRAM_ID=$(solana address -k "$KEYPAIR")
DECLARED=$(grep -oE 'declare_id!\("[^"]+"' programs/pumpking/src/lib.rs | cut -d'"' -f2)
IN_TOML=$(sed -n 's/^pumpking = "\(.*\)"$/\1/p' Anchor.toml | head -1)

echo "program id (keypair) : $PROGRAM_ID"
echo "declare_id!          : $DECLARED"
echo "Anchor.toml          : $IN_TOML"
[ "$PROGRAM_ID" = "$DECLARED" ] || { echo "MISMATCH: the deployed address would not be the one the program checks against"; exit 1; }
[ "$PROGRAM_ID" = "$IN_TOML" ] || { echo "MISMATCH: Anchor.toml points elsewhere"; exit 1; }

SIZE=$(stat -c %s "$SO")
RENT=$(solana rent "$SIZE" --url "$URL" | sed -n 's/^Rent-exempt minimum: \([0-9.]*\) SOL$/\1/p')
BALANCE=$(solana balance --url "$URL" | sed 's/ SOL//')
echo "so size              : $SIZE bytes"
echo "rent-exempt minimum  : $RENT SOL"
echo "deployer balance     : $BALANCE SOL"

# The deploy writes a buffer first and refunds it afterwards, so the peak need
# is above the rent itself. A fifth of it is enough head-room for fees.
NEEDED=$(awk -v r="$RENT" 'BEGIN { printf "%.4f", r * 1.2 }')
awk -v b="$BALANCE" -v n="$NEEDED" 'BEGIN { exit !(b >= n) }' || {
  echo "not enough SOL: need about $NEEDED, have $BALANCE"
  echo "top up $(solana address) at https://faucet.solana.com"
  exit 1
}

if solana program show "$PROGRAM_ID" --url "$URL" >/dev/null 2>&1; then
  echo
  echo "NOTE: this program already exists on $CLUSTER — this run upgrades it in place."
fi

# `solana program deploy`, not `anchor deploy`. The two put the same bytes on
# chain, but anchor also writes an on-chain IDL account afterwards, and the CLI
# in this WSL is 1.2.0 while the program is built against anchor 0.32.1 (see
# CLAUDE.md — that version is the one point where CLI, crate and TS client
# meet). The 1.2.0 IDL instruction is refused by a 0.32.1 program with
# "Access violation writing 8 bytes at address 0x5", after the program itself
# has already been deployed — a failure that looks like a failed deploy and is
# not one.
#
# Nothing here needs the on-chain IDL: the TypeScript client carries its own
# (packages/anchor-client/src/idl), kept in step by `pnpm idl:sync`. It is a
# convenience for explorers, and it can be written later with a matching CLI.
echo
solana program deploy "$SO" \
  --program-id "$KEYPAIR" \
  --url "$URL" \
  --commitment confirmed

echo
solana program show "$PROGRAM_ID" --url "$URL"
echo
echo "deployed. Next: scripts/devnet-prepare.sh, then node scripts/devnet-init.mjs"
