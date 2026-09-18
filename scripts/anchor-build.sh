#!/usr/bin/env bash
# Збирає програму і генерує IDL та TS-типи — джерело `packages/anchor-client/src/idl`.
# Запуск із WSL: wsl -d <дистрибутив> -- bash <шлях до репо>/scripts/anchor-build.sh
set -euo pipefail
# Оболонка не логін-ова: rustup/cargo/avm лежать поза PATH.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
# `anchor build` кличе `cargo build-sbf`, а це окремий бінар з тулчейна Agave:
# без нього cargo відповідає `no such command: build-sbf`.
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
# Працює з будь-якого каталогу: корінь репозиторію береться від самого скрипта,
# а не зашивається — шлях цієї робочої копії не є частиною проєкту.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Two builds, and the second one is the artefact.
#
# `anchor build` is kept for what only it produces: target/idl/pumpking.json and
# target/types/pumpking.ts, the source `pnpm idl:sync` copies into the client.
# Its .so, however, is SBPF **v3** — `anchor build --help` says the default is
# v3, and its own `--arch` flag refuses "v0" (it only takes bpf|sbf). A v3
# program deploys without a word and then fails every instruction after 44
# compute units with "Access violation writing 8 bytes at address 0x5": a
# message about memory that means "this cluster does not execute this bytecode
# version". Mollusk runs v3 happily, so the local floor stays green throughout.
#
# `cargo-build-sbf` defaults to v0, which is what the cluster runs, and it
# overwrites target/deploy/pumpking.so after anchor has had its turn. The cost
# of v0 is a stricter frame: what v3 reports as "Stack offset exceeded max
# offset" warnings can become build errors, and the fix is boxing the largest
# cold accounts of a context, never widening the frame.
#
# `--tools-version v1.57` is pinned for the same class of reason. Bare
# `cargo-build-sbf` defaults to the platform-tools it ships with (v1.52 here)
# and produces a 450 800-byte artefact that no runtime executes: every
# instruction dies after 44 compute units, on devnet and under mollusk alike.
# The v1.57 toolchain — the one `anchor build` asks for — produces 421 560
# bytes that both accept. The version is therefore part of the artefact's
# identity, not a detail of the machine that built it.
anchor build
cargo-build-sbf --manifest-path programs/pumpking/Cargo.toml --tools-version v1.57

ls -l target/idl/pumpking.json target/types/pumpking.ts
ls -l target/deploy/pumpking.so
