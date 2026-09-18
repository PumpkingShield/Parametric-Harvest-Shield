# Pumpking

Parametric drought cover for smallholders. A cheap sensor network measures
rainfall, the chain counts dry days, and when the run reaches the policy's
threshold the payout arrives on its own — no claim form, no inspector, no
argument.

**All numbers in this deployment are synthetic and no real money moves.** The
settlement asset is a mock SPL token on devnet.

---

## What it does

A policy names a cell, a window of days, a payout and a threshold: *N dry days
in a row*. Sensors publish signed readings every interval; the aggregator takes
a median per interval, classifies each day, and writes it to the cell's on-chain
journal. When the journal shows a run at or past the threshold, anybody can call
`settle_policy` — the owner does nothing, and nobody can stop it.

**The index is not the damage, and the policy says so to the owner's face.**
Rain measured across the cell can miss a field, and a field can come through a
dry spell unharmed. The screen states both directions, with this policy's own
threshold and payout in the sentence.

### What decides a payout

| Rule | Where it lives |
|---|---|
| A day is dry when its rainfall does not exceed the threshold | `packages/shared/src/day.ts` + `programs/pumpking/src/index.rs` |
| A day needs a minimum share of intervals with a value, or it has none | same pair |
| A day without coverage **breaks** a run — silence is not drought | same pair |
| The run is the longest sequence of dry days inside the policy's window | `dry_spell`, implemented twice and cross-checked |

`dry_spell` exists in Rust and in TypeScript, and both run the same fixtures
(`fixtures/index-cases.json`). A one-day disagreement between them is a payout
the interface promised and the program refuses, so the two are held equal by
tests rather than by discipline.

## Layout

```
apps/
  api/        Hono — reading intake, the day journal, policy reads
  worker/     interval close, median, day record, settlement, closure
  web/        React + Vite — the owner's policy screen
packages/
  shared/     canonical serialisation, median, day classification, dry spell, Merkle
  anchor-client/  PDAs, instruction encoding, decoded accounts
  db/         schema and stores (Drizzle + Postgres)
programs/
  pumpking/   the Anchor program: pool, cell journal, policies, settlement
tests/        the end-to-end drought scenario, in compressed time
fixtures/     scenario files and the index cases both implementations run
```

Design notes, the requirement list and the task breakdown live outside the
repository — `.gitignore` keeps every `.md` but this one out, so a fresh clone
arrives without them.

## Requirements

Node 26 (`.nvmrc`), pnpm 9.15. The program is built with Anchor 0.32.1 and the
Agave toolchain inside WSL; those versions are a matched set and moving one of
them alone breaks the others.

## Running it locally

```bash
pnpm install
pnpm gate                 # lint, typecheck, tests — green before every commit

cp .env.example .env      # fill DATABASE_URL and the keys you need
pnpm --filter @pumpking/db db:migrate

pnpm --filter @pumpking/api start      # the API, port 8080
pnpm --filter @pumpking/worker start   # the aggregation loop, its own health port
pnpm --filter @pumpking/web dev        # the interface
```

The on-chain program is built inside WSL, and the build is two commands on
purpose:

```bash
bash scripts/anchor-build.sh   # anchor build for the IDL, cargo-build-sbf for the .so
pnpm idl:sync                  # copy the IDL into the client — never edit it by hand
```

`--tools-version v1.57` inside that script is load-bearing. The platform-tools
bare `cargo-build-sbf` ships with produce an artefact **no runtime executes**:
the deploy succeeds and then every instruction fails after 44 compute units with
an access violation, on devnet and under mollusk alike.

### Tests

```bash
pnpm test                          # TypeScript, every package
bash scripts/ci-cargo-check.sh     # the program's pure functions
bash scripts/mollusk-test.sh       # the instructions, against the built .so
```

The last one runs the real runtime over `target/deploy/pumpking.so`, so it sees
the artefact rather than the sources: build before running it, or it re-tests the
previous version and its green means nothing.

## Deploying

One Render free web service carries the API **and** the aggregation loop
(`RUN_WORKER=on` — the free plan has no background worker), GitHub Pages carries
the interface, Supabase carries Postgres. `render.yaml` and the two workflows in
`.github/workflows` hold the configuration.

```bash
node scripts/devnet-keys.mjs                  # pool authority + aggregator into .env
bash scripts/devnet-deploy.sh                 # the program, with its pre-flight checks
bash scripts/devnet-prepare.sh                # SOL for the keys, mock mint, treasury
node scripts/devnet-init.mjs                  # initialize_pool + deposit_capital
```

Every one of the four is idempotent. Two things they will not do for you: fund
the deployer (devnet SOL, roughly 2.8 for the program's rent) and issue the demo
policy — `issue_policy` needs a cell with coverage, and a cell is opened by its
first recorded day, so the policy is issued once a run is under way.

**Render sleeps a free service after 15 minutes of silence, and a sleeping
service is a sleeping aggregator**: no day is written while it sleeps, and a day
with no coverage ends a run. The keep-alive workflow is part of the deployment,
not housekeeping.

## Status

Milestone M1 — the payout without a claim — is built, and this is what each
part of it has actually been shown to do.

| Claim | Where it is proven | State |
|---|---|---|
| The instructions do what they say — solvency, exposure limit, waiting period, settlement, closure, the 128-day ring | mollusk over the built `.so` | 35/35 |
| The index is one thing in two languages | shared fixtures, Rust and TypeScript | 121 + 544 tests |
| Drought from first reading to payout, in compressed time | `tests/e2e/drought.test.ts` | deterministic, and it does **not** execute the program |
| The program runs on devnet | pool initialised, capital deposited, the loop reads the clock off the pool | done |
| A full scenario run against devnet | — | **not done yet** |

So: the payout path is complete and exercised, but the sentence "a drought
happened on devnet and the money arrived" cannot be said yet. It needs the
deployment (`render.yaml`), a policy issued against a cell with coverage, and a
scenario run through `POST /v1/scenario/run`.

The sensors are our own keys and the weather comes from a scenario file. Open
sensor registration, staking, reputation, rewards and the public audit trail are
later milestones.

Not proven, and worth saying out loud: nothing here demonstrates resistance to
collusion while every key belongs to one operator, and 30 days of uninterrupted
collection is not provable on a free tier that sleeps.
