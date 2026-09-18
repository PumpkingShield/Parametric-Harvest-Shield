#!/usr/bin/env bash
# Дзеркало джоба `rust` з .github/workflows/ci.yml — щоб перевіряти локально.
# Запуск із WSL: wsl -d <дистрибутив> -- bash <шлях до репо>/scripts/ci-cargo-check.sh
set -euo pipefail
# Оболонка не логін-ова: rustup/cargo лежать поза PATH.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
# Працює з будь-якого каталогу: корінь репозиторію береться від самого скрипта,
# а не зашивається — шлях цієї робочої копії не є частиною проєкту.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cargo check --locked --lib -p pumpking
cargo test --locked --lib -p pumpking
