#!/usr/bin/env bash
# Funds the demo keys and creates the mock asset — step 0 of docs/DEPLOY.md.
# Run from WSL: wsl -d <distro> -- bash <path to repo>/scripts/devnet-prepare.sh
#
# Everything here is CLI work from the deployer's wallet: SOL for the keys that
# send transactions, a mock SPL mint, a treasury account owned by the pool
# authority, a supply minted into it, and a token account for the farmer with
# enough to pay a premium. What the program itself is asked to do comes after,
# in scripts/devnet-init.mjs and scripts/devnet-issue.mjs.
#
# The mint authority is NEVER the pool authority: a pool that can print its own
# asset is solvent by definition, and the SC-006 check would be checking
# nothing. This wallet creates the mint and, last, hands its authority to
# FAUCET_KEYPAIR (T038a) — the API faucet's key, which holds no role in the
# program — so this wallet keeps only the program's upgrade authority. A run
# after the handover mints with the faucet key instead.
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Both overridable, so the same steps can be tried on a local validator
# without touching the devnet .env: SOLANA_URL=http://127.0.0.1:8899
# PUMPKING_ENV=<another file>.
URL="${SOLANA_URL:-https://api.devnet.solana.com}"
ENV_FILE="${PUMPKING_ENV:-$REPO/.env}"

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
# T077: the three operators register and stake the show's sensors and the
# SC-008 feeder's. Registration costs rent — ~0.0016 SOL a Sensor account, and
# the first sensor of a cell opens its CellState — so the busiest operator
# (34 feeder sensors, one show sensor, two cells) spends ~0.08 SOL. Staking
# costs `pool.min_stake` a sensor. T041a prices a vote at half a cell's limit
# or more, so the demo pool's minimum is thousands of tokens, not one: enough
# for one show sensor at 6 250 (docs/DEPLOY.md, block T041a) plus the
# feeder's 34 at the SC-008 pool's one token.
OPERATOR_SOL=0.10
OPERATOR_TOKENS=6300
# T038a: the faucet gives 0.03 SOL a grant (FAUCET_LAMPORTS), so this is ~16
# phones registered. Top it up with `solana transfer` when it runs low.
FAUCET_SOL=0.5

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
OPERATORS=("$(address_of OPERATOR_A_KEYPAIR)" "$(address_of OPERATOR_B_KEYPAIR)" "$(address_of OPERATOR_C_KEYPAIR)")
FAUCET=$(address_of FAUCET_KEYPAIR)

echo "pool authority : $POOL_AUTHORITY"
echo "aggregator     : $AGGREGATOR"
echo "policy owner   : $POLICY_OWNER"
echo "operators      : ${OPERATORS[*]}"
echo "faucet         : $FAUCET"
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
for OPERATOR in "${OPERATORS[@]}"; do fund "$OPERATOR" "$OPERATOR_SOL"; done
fund "$FAUCET" "$FAUCET_SOL"
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

# Whoever the mint names now signs the mints below: this wallet before the
# handover at the end of this script, the faucet key after it. spl-token takes
# a signer only as a file, so the faucet's key is written to one only this
# user can read, and removed when the script exits however it exits.
mint_authority() {
  spl-token display "$MINT" --url "$URL" | sed -n 's/^ *Mint authority: *//p' | head -1
}
MINT_AUTHORITY_ARGS=()
if [ "$(mint_authority)" = "$FAUCET" ]; then
  FAUCET_KEYFILE=$(umask 077; mktemp "$HOME/.pumpking-faucet-XXXXXX.json")
  trap 'rm -f "$FAUCET_KEYFILE"' EXIT
  sed -n 's/^FAUCET_KEYPAIR=//p' "$ENV_FILE" | head -1 > "$FAUCET_KEYFILE"
  MINT_AUTHORITY_ARGS=(--mint-authority "$FAUCET_KEYFILE")
  echo "  minting as the faucet (it holds the mint authority)"
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
  spl-token mint "$MINT" "$POLICY_OWNER_TOKENS" "$FARMER_TOKENS" --url "$URL" "${MINT_AUTHORITY_ARGS[@]}" >/dev/null
  echo "  $FARMER_TOKENS minted $POLICY_OWNER_TOKENS tokens"
fi

# --- the operators' token accounts -------------------------------------------
# What they stake from (FR-051: the stake is in the pool's asset, and it goes
# into the stake vault, never into capital). Minted from the mock asset like
# the farmer's, for the same reason: the treasury's supply is the pool's.
echo
echo "operators' token accounts:"
for OPERATOR in "${OPERATORS[@]}"; do
  TOKENS=$(spl-token address --token "$MINT" --owner "$OPERATOR" --verbose --url "$URL" | sed -n 's/^Associated token address: *//p')
  [ -n "$TOKENS" ] || { echo "could not derive the token account of $OPERATOR"; exit 1; }
  HAVE=$(spl-token balance --address "$TOKENS" --url "$URL" 2>/dev/null || echo 0)
  if awk -v h="$HAVE" -v a="$OPERATOR_TOKENS" 'BEGIN { exit !(h >= a) }'; then
    echo "  $TOKENS already holds $HAVE tokens"
  else
    spl-token create-account "$MINT" --owner "$OPERATOR" --url "$URL" --fee-payer "$HOME/.config/solana/id.json" >/dev/null 2>&1 || true
    spl-token mint "$MINT" "$OPERATOR_TOKENS" "$TOKENS" --url "$URL" "${MINT_AUTHORITY_ARGS[@]}" >/dev/null
    echo "  $TOKENS minted $OPERATOR_TOKENS tokens"
  fi
done

# --- the mint authority goes to the faucet -----------------------------------
# Last, after every mint above. Irreversible from this wallet: once the faucet
# holds it, only the faucet's key can mint or hand it on.
echo
echo "mint authority:"
CURRENT=$(mint_authority)
if [ "$CURRENT" = "$FAUCET" ]; then
  echo "  already the faucet ($FAUCET)"
elif [ "$CURRENT" = "$(solana address)" ]; then
  spl-token authorize "$MINT" mint "$FAUCET" --url "$URL" >/dev/null
  echo "  handed from this wallet to the faucet ($FAUCET)"
else
  echo "  the mint names $CURRENT — neither this wallet nor the faucet; left alone"
fi

echo
echo "Next: node scripts/devnet-init.mjs, then node scripts/devnet-register.mjs"
