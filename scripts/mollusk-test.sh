#!/usr/bin/env bash
# Mollusk-покриття інструкцій: справжній рантайм над target/deploy/pumpking.so.
# Запуск: wsl -d Ubuntu-24.04 -- bash /mnt/e/Arena/Pumpking/scripts/mollusk-test.sh
#
# `SBF_OUT_DIR` обов'язковий: mollusk шукає `<назва>.so` у `tests/fixtures`,
# у цій змінній і в поточному каталозі, а cargo ставить робочим каталогом
# тесту корінь пакета (`programs/pumpking`) — `target/deploy` він не знайде.
set -euo pipefail
# Оболонка не логін-ова: rustup/cargo лежать поза PATH.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
cd /mnt/e/Arena/Pumpking
export SBF_OUT_DIR=/mnt/e/Arena/Pumpking/target/deploy
# Без --nocapture: cargo і так друкує вивід тесту, що впав, а логи mollusk
# на успішному прогоні — це сотні кілобайт.
cargo test -p pumpking --test "${1:-*}"
