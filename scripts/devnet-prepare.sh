#!/usr/bin/env bash
# Funds the three demo keys and creates the mock asset — step 0 of docs/DEPLOY.md.
# Run from WSL: wsl -d <distro> -- bash <path to repo>/scripts/devnet-prepare.sh
#
# Everything here is CLI work from the deployer's wallet: SOL for the keys that
# send transactions, a mock SPL mint, a treasury account owned by the pool
# authority, a supply minted into it, and a token account for the farmer with
# enough to pay a premium. What the program itself is asked to do comes after,
# in scripts/devnet-init.mjs and scripts/devnet-issue.mjs.
#
# The mint authority stays this wallet and is NEVER the pool authority: a pool
# that can print its own asset is solvent by definition, and the SC-006 check
# would be checking nothing.
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL=https://api.devnet.solana.com
ENV_FILE="$REPO/.env"

DECIMALS=6
SUPPLY=1000000          # whole tokens minted to the treasury
POOL_AUTHORITY_SOL=0.05
AGGREGATOR_SOL=0.10
# Rent for one Policy account, an ATA and a handful of transactions.
POLICY_OWNER_SOL=0.02
# Whole tokens the farmer holds to pay premiums from. A premium is at most
# 125% of the payout (frequency <= 100%, loaded by risk_loading_bps = 2500),
# so this covers several demo policies at the default 1 000-token payout.
POLICY_OWNER_TOKENS=10000

[ -f "$ENV_FILE" ] || { echo "no .env — run: node scripts/devnet-keys.mjs"; exit 1; }

# The keys live in .env as JSON arrays; only their addresses are needed here,
# and `solana address` will read one off stdin.
address_of() {
  local name=$1 json
  json=$(sed -n "s/^${name}=//p" "$ENV_FILE" | head -1)
  [ -n "$json" ] || { echo "no $name in .env — run: node scripts/devnet-keys.mjs" >&2; exit 1; }
  printf '%s' "$json" | solana address -k /dev/stdin
}

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

POOL_AUTHORITY=$(address_of POOL_AUTHORITY_KEYPAIR)
AGGREGATOR=$(address_of AGGREGATOR_KEYPAIR)
POLICY_OWNER=$(address_of POLICY_OWNER_KEYPAIR)

echo "pool authority : $POOL_AUTHORITY"
echo "aggregator     : $AGGREGATOR"
echo "policy owner   : $POLICY_OWNER"
echo "payer          : $(solana address)"
echo

# --- SOL for the three roles -------------------------------------------------
# The aggregator pays for every day record, settlement and closure; the pool
# authority pays rent for the Pool account and its two vaults; the farmer pays
# rent for the policy and the fee of buying it. None can be funded by the
# program.
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
fund "$POLICY_OWNER" "$POLICY_OWNER_SOL"
echo

# --- the mock asset ----------------------------------------------------------
MINT=$(sed -n 's/^ASSET_MINT=//p' "$ENV_FILE" | head -1)
if [ -n "$MINT" ]; then
  echo "ASSET_MINT already set: $MINT (delete that line from .env to create a new one)"
else
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

  set_env ASSET_MINT "$MINT"
  set_env TREASURY_TOKENS "$TREASURY"
  echo "  ASSET_MINT and TREASURY_TOKENS written to .env"
fi

# --- the farmer's token account ----------------------------------------------
# The buyer of the demo policy pays the premium from this account, and the
# payout lands in the same one (FR-066: the destination is derived from the
# owner, never chosen). The tokens are minted straight to it rather than moved
# out of the treasury: this is the mock asset, and the treasury's supply is
# the pool's story, not the farmer's.
echo
echo "farmer's token account:"
FARMER_TOKENS=$(spl-token address --token "$MINT" --owner "$POLICY_OWNER" --verbose --url "$URL" | sed -n 's/^Associated token address: *//p')
[ -n "$FARMER_TOKENS" ] || { echo "could not derive the farmer's token account"; exit 1; }
HAVE=$(spl-token balance --address "$FARMER_TOKENS" --url "$URL" 2>/dev/null || echo 0)
if awk -v h="$HAVE" -v a="$POLICY_OWNER_TOKENS" 'BEGIN { exit !(h >= a) }'; then
  echo "  $FARMER_TOKENS already holds $HAVE tokens"
else
  # `create-account` refuses an account that already exists, and a balance of
  # 0 does not say whether the account is there — so creation may fail, and
  # the mint after it is what has to succeed.
  spl-token create-account "$MINT" --owner "$POLICY_OWNER" --url "$URL" --fee-payer "$HOME/.config/solana/id.json" >/dev/null 2>&1 || true
  spl-token mint "$MINT" "$POLICY_OWNER_TOKENS" "$FARMER_TOKENS" --url "$URL" >/dev/null
  echo "  $FARMER_TOKENS minted $POLICY_OWNER_TOKENS tokens"
fi

echo
echo "Next: node scripts/devnet-init.mjs"
