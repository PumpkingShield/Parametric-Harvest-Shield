#!/usr/bin/env bash
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
cd /mnt/e/Arena/Pumpking
cargo fetch
echo "=== solana-address у локі ==="
grep -A1 'name = "solana-address"' Cargo.lock
echo "=== збірка тестових таргетів ==="
export SBF_OUT_DIR=/mnt/e/Arena/Pumpking/target/deploy
cargo check --tests -p pumpking
