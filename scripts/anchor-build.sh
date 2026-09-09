#!/usr/bin/env bash
# Збирає програму і генерує IDL та TS-типи — джерело `packages/anchor-client/src/idl`.
# Запуск: wsl -d Ubuntu-24.04 -- bash /mnt/e/Arena/Pumpking/scripts/anchor-build.sh
set -euo pipefail
# Оболонка не логін-ова: rustup/cargo/avm лежать поза PATH.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
# `anchor build` кличе `cargo build-sbf`, а це окремий бінар з тулчейна Agave:
# без нього cargo відповідає `no such command: build-sbf`.
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd /mnt/e/Arena/Pumpking
anchor build
ls -l target/idl/pumpking.json target/types/pumpking.ts
