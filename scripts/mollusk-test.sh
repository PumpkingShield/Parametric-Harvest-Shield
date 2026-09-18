#!/usr/bin/env bash
# Mollusk-покриття інструкцій: справжній рантайм над target/deploy/pumpking.so.
# Запуск із WSL: wsl -d <дистрибутив> -- bash <шлях до репо>/scripts/mollusk-test.sh
#
# `SBF_OUT_DIR` обов'язковий: mollusk шукає `<назва>.so` у `tests/fixtures`,
# у цій змінній і в поточному каталозі, а cargo ставить робочим каталогом
# тесту корінь пакета (`programs/pumpking`) — `target/deploy` він не знайде.
set -euo pipefail
# Оболонка не логін-ова: rustup/cargo лежать поза PATH.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
# Працює з будь-якого каталогу: корінь репозиторію береться від самого скрипта,
# а не зашивається — шлях цієї робочої копії не є частиною проєкту.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export SBF_OUT_DIR="$PWD/target/deploy"
# Без --nocapture: cargo і так друкує вивід тесту, що впав, а логи mollusk
# на успішному прогоні — це сотні кілобайт.
cargo test -p pumpking --test "${1:-*}"
