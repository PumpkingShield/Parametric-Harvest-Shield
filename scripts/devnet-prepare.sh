#!/usr/bin/env bash
# Funds the two demo keys and creates the mock asset — step 0 of docs/DEPLOY.md.
# Run: wsl -d Ubuntu-24.04 -- bash /mnt/e/Arena/Pumpking/scripts/devnet-prepare.sh
#
# Everything here is CLI work from the deployer's wallet: SOL for the keys that
# send transactions, a mock SPL mint, a treasury account owned by the pool
# authority, and a supply minted into it. What the program itself is asked to
# do comes after, in scripts/devnet-init.mjs.
#
# The mint authority stays this wallet and is NEVER the pool authority: a pool
# that can print its own asset is solvent by definition, and the SC-006 check
# would be checking nothing.
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

REPO=/mnt/e/Arena/Pumpking
URL=https://api.devnet.solana.com
ENV_FILE="$REPO/.env"

DECIMALS=6
SUPPLY=1000000          # whole tokens minted to the treasury
POOL_AUTHORITY_SOL=0.05
AGGREGATOR_SOL=0.10

[ -f "$ENV_FILE" ] || { echo "no .env — run: node scripts/devnet-keys.mjs"; exit 1; }

# The keys live in .env as JSON arrays; only their addresses are needed here,
# and `solana address` will read one off stdin.
address_of() {
  local name=$1 json
  json=$(sed -n "s/^${name}=//p" "$ENV_FILE" | head -1)
  [ -n "$json" ] || { echo "no $name in .env — run: node scripts/devnet-keys.mjs" >&2; exit 1; }
  printf '%s' "$json" | solana address -k /dev/stdin
}

POOL_AUTHORITY=$(address_of POOL_AUTHORITY_KEYPAIR)
AGGREGATOR=$(address_of AGGREGATOR_KEYPAIR)

echo "pool authority : $POOL_AUTHORITY"
echo "aggregator     : $AGGREGATOR"
echo "payer          : $(solana address)"
echo

# --- SOL for the two roles ---------------------------------------------------
# The aggregator pays for every day record, settlement and closure; the pool
# authority pays rent for the Pool account and its two vaults. Neither can be
# funded by the program.
fund() {
  local who=$1 amount=$2 have
  have=$(solana balance "$who" --url "$URL" | sed 's/ SOL//')
  if awk -v h="$have" -v a="$amount" 'BEGIN { exit !(h >= a) }'; then
    echo "  $who already has $have SOL"
    return
  fi
  solana transfer "$who" "$amount" --url "$URL" --allow-unfunded-recipient --no-wait >/dev/null
  echo "  sent $amount SOL to $who"
}

echo "funding:"
fund "$POOL_AUTHORITY" "$POOL_AUTHORITY_SOL"
fund "$AGGREGATOR" "$AGGREGATOR_SOL"
echo

# --- the mock asset ----------------------------------------------------------
EXISTING=$(sed -n 's/^ASSET_MINT=//p' "$ENV_FILE" | head -1)
if [ -n "$EXISTING" ]; then
  echo "ASSET_MINT already set: $EXISTING"
  echo "Delete that line from .env to create a new one."
  exit 0
fi

echo "creating the mock asset (decimals $DECIMALS, mint authority = this wallet):"
MINT=$(spl-token create-token --decimals "$DECIMALS" --url "$URL" --output json | sed -n 's/.*"commandOutput":.*"address": *"\([^"]*\)".*/\1/p')
[ -n "$MINT" ] || MINT=$(spl-token create-token --decimals "$DECIMALS" --url "$URL" | sed -n 's/^Address: *//p')
[ -n "$MINT" ] || { echo "could not read the new mint address"; exit 1; }
echo "  mint     : $MINT"

TREASURY=$(spl-token create-account "$MINT" --owner "$POOL_AUTHORITY" --url "$URL" --fee-payer "$HOME/.config/solana/id.json" 2>&1 | sed -n 's/^Creating account *//p' | head -1)
[ -n "$TREASURY" ] || TREASURY=$(spl-token address --token "$MINT" --owner "$POOL_AUTHORITY" --verbose --url "$URL" | sed -n 's/^Associated token address: *//p')
echo "  treasury : $TREASURY"

spl-token mint "$MINT" "$SUPPLY" "$TREASURY" --url "$URL" >/dev/null
echo "  minted   : $SUPPLY tokens"

# Written back so the next step needs no copying by hand. Replaced in place
# when the key is already there — .env.example ships ASSET_MINT= empty, and a
# second line with the same name is a variable whose value depends on who
# reads it. Appending checks the trailing newline first: without one, the new
# variable would be glued onto the end of the last.
set_env() {
  local name=$1 value=$2
  if grep -q "^${name}=" "$ENV_FILE"; then
    sed -i "s|^${name}=.*|${name}=${value}|" "$ENV_FILE"
  else
    [ -n "$(tail -c 1 "$ENV_FILE")" ] && printf '\n' >> "$ENV_FILE"
    printf '%s\n' "${name}=${value}" >> "$ENV_FILE"
  fi
}

set_env ASSET_MINT "$MINT"
set_env TREASURY_TOKENS "$TREASURY"

echo
echo "ASSET_MINT and TREASURY_TOKENS written to .env."
echo "Next: node scripts/devnet-init.mjs"
