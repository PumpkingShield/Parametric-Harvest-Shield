#!/usr/bin/env bash
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
# Працює з будь-якого каталогу: корінь репозиторію береться від самого скрипта,
# а не зашивається — шлях цієї робочої копії не є частиною проєкту.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cargo fetch
echo "=== solana-address у локі ==="
grep -A1 'name = "solana-address"' Cargo.lock
echo "=== збірка тестових таргетів ==="
export SBF_OUT_DIR="$PWD/target/deploy"
cargo check --tests -p pumpking
