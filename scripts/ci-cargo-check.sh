#!/usr/bin/env bash
# Дзеркало джоба `rust` з .github/workflows/ci.yml — щоб перевіряти локально.
# Запуск: wsl -d Ubuntu-24.04 -- bash /mnt/e/Arena/Pumpking/scripts/ci-cargo-check.sh
set -euo pipefail
# Оболонка не логін-ова: rustup/cargo лежать поза PATH.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
cd /mnt/e/Arena/Pumpking
cargo check --locked --lib -p pumpking
cargo test --locked --lib -p pumpking
