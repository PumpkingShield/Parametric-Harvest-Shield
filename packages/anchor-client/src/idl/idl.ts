/**
 * ЗГЕНЕРОВАНО `pnpm idl:sync` з `target/` після `anchor build`. Не редагувати:
 * джерело — `programs/pumpking`, ручна правка зникне на наступному прогоні.
 */

import type { Pumpking } from './pumpking.ts'

export const PUMPKING_IDL: Pumpking = {
  "address": "F2cw4FWjzUL29G4WEWHANUE2jXAyF9QJLCdvmsjy7YbY",
  "metadata": {
    "name": "pumpking",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Parametric drought cover settled from a DePIN sensor median"
  },
  "instructions": [
    {
      "name": "depositCapital",
      "docs": [
        "Puts capital in and takes a proportional share out — `FR-032`. The same",
        "instruction seeds the pool and funds it later; there is no second path."
      ],
      "discriminator": [
        157,
        98,
        40,
        41,
        205,
        210,
        121,
        253
      ],
      "accounts": [
        {
          "name": "depositor",
          "writable": true,
          "signer": true
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "assetMint"
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "depositorTokens",
          "writable": true
        },
        {
          "name": "position",
          "docs": [
            "`FR-032`. One position per wallet, opened on the first deposit and",
            "added to afterwards."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "depositor"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initializePool",
      "docs": [
        "Creates the pool, its capital vault and its stake vault, and fixes the",
        "asset all three of premium, stake and payout are denominated in."
      ],
      "discriminator": [
        95,
        180,
        10,
        172,
        84,
        174,
        232,
        40
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "Sets parameters and registries, and pays the rent. Never a signer over",
            "the vaults: they are owned by the pool PDA, so `FR-030` holds by",
            "construction — there is no key that can move a policy's money."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "assetMint",
          "docs": [
            "`FR-031`, `FR-055`. An interface account, not a plain SPL mint, so the",
            "day this points at a real stablecoin the token program it lives under",
            "is its own business."
          ]
        },
        {
          "name": "vault",
          "docs": [
            "Capital. Everything a policy is paid from."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "stakeVault",
          "docs": [
            "`FR-051`: sensor stake, held apart. It backs no policy and takes no",
            "part in the solvency check; one account for both would make a sensor's",
            "collateral into silent capital of the insurer."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  107,
                  101,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "poolParams"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "capitalPosition",
      "discriminator": [
        192,
        202,
        203,
        27,
        117,
        205,
        221,
        66
      ]
    },
    {
      "name": "pool",
      "discriminator": [
        241,
        154,
        109,
        4,
        17,
        177,
        109,
        188
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "exposureShareOutOfRange",
      "msg": "Cell exposure share must be between 1 and 10000 basis points"
    },
    {
      "code": 6001,
      "name": "rewardsShareOutOfRange",
      "msg": "Premium rewards share must not exceed 10000 basis points"
    },
    {
      "code": 6002,
      "name": "minSensorsOutOfRange",
      "msg": "Minimum sensors per cell must be between 1 and 32"
    },
    {
      "code": 6003,
      "name": "dayLengthNotSet",
      "msg": "A day must be longer than zero seconds"
    },
    {
      "code": 6004,
      "name": "waitingPeriodNotSet",
      "msg": "Waiting period must be at least one day"
    },
    {
      "code": 6005,
      "name": "unstakeDelayNotSet",
      "msg": "Unstake delay must be at least one day"
    },
    {
      "code": 6006,
      "name": "rolesNotSeparated",
      "msg": "Authority and aggregator must be different keys"
    },
    {
      "code": 6007,
      "name": "mintAuthorityHasPoolPower",
      "msg": "The mint authority of the asset must hold no power over the pool"
    },
    {
      "code": 6008,
      "name": "depositTooSmall",
      "msg": "Deposit is too small to be worth a share of the pool"
    },
    {
      "code": 6009,
      "name": "poolValueUnknown",
      "msg": "The pool holds shares against no capital; a deposit cannot be priced"
    },
    {
      "code": 6010,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    }
  ],
  "types": [
    {
      "name": "capitalPosition",
      "docs": [
        "PDA `[\"lp\", owner]`. A share of the pool — `FR-032`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "pool",
      "docs": [
        "PDA `[\"pool\"]`. Parameters, totals, and the two vaults.",
        "",
        "`authority` is deliberately not a treasury key. It sets parameters and",
        "registries and nothing else; the vaults are owned by this PDA, so no human",
        "key can move a policy's money and `FR-030` holds by construction rather",
        "than by promise. `aggregator` is the only role that may write a day log,",
        "and it cannot spend either."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "docs": [
              "Parameters and registries only — never a signer over the vaults."
            ],
            "type": "pubkey"
          },
          {
            "name": "aggregator",
            "docs": [
              "The single role allowed to write day records — `FR-015`."
            ],
            "type": "pubkey"
          },
          {
            "name": "assetMint",
            "docs": [
              "`FR-031`, `FR-055`: the settlement asset is a parameter of the pool, so",
              "replacing the mock token with a real stablecoin is a deployment choice",
              "rather than an edit to policy, consensus or payout logic."
            ],
            "type": "pubkey"
          },
          {
            "name": "vault",
            "docs": [
              "Token account holding capital. Authority is this PDA."
            ],
            "type": "pubkey"
          },
          {
            "name": "stakeVault",
            "docs": [
              "`FR-051`: sensor stake sits apart from capital. It backs no policy, is",
              "reserved against nothing and takes no part in the solvency check."
            ],
            "type": "pubkey"
          },
          {
            "name": "capitalTotal",
            "type": "u64"
          },
          {
            "name": "reservedTotal",
            "docs": [
              "Committed to active policies — `FR-019` sells against what is left."
            ],
            "type": "u64"
          },
          {
            "name": "sharesTotal",
            "type": "u64"
          },
          {
            "name": "cellExposureBps",
            "docs": [
              "`FR-020`: share of capital any one cell may be exposed to. Drought is",
              "correlated — one event triggers every policy in the cell at once."
            ],
            "type": "u16"
          },
          {
            "name": "premiumRewardsBps",
            "docs": [
              "`FR-034`: share of a premium that goes to the cell's reward reserve at",
              "issue time. The rest becomes capital there and then."
            ],
            "type": "u16"
          },
          {
            "name": "minSensorsPerCell",
            "docs": [
              "`FR-010`: independent votes an interval needs to get a value at all."
            ],
            "type": "u8"
          },
          {
            "name": "minStake",
            "docs": [
              "`FR-050`: below this a sensor still publishes, but does not vote."
            ],
            "type": "u64"
          },
          {
            "name": "unstakeDelayDays",
            "docs": [
              "`FR-053`: thaw longer than the outlier observation window, so spoiling",
              "data and withdrawing before detection is not free."
            ],
            "type": "u16"
          },
          {
            "name": "waitingPeriodDays",
            "docs": [
              "`FR-023`: gap between buying a policy and the start of its cover."
            ],
            "type": "u16"
          },
          {
            "name": "dryDayThresholdMmX100",
            "docs": [
              "`FR-047`: a day is dry when its hourly total does not exceed this."
            ],
            "type": "u32"
          },
          {
            "name": "secondsPerDay",
            "docs": [
              "86_400 in production, seconds in a scenario run — `FR-049`. A day is an",
              "index, not a date, so compressing time changes the clock and nothing",
              "else: index, consensus and money move identically in both modes."
            ],
            "type": "u32"
          },
          {
            "name": "genesisTs",
            "docs": [
              "`day_index = (now - genesis_ts) / seconds_per_day`."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "poolParams",
      "docs": [
        "Bringing the pool into existence: its parameters, its two vaults, and the",
        "asset all three of premium, stake and payout are denominated in.",
        "",
        "The asset is an argument, never a constant — `FR-031`, `FR-055`. Swapping",
        "the mock token for a real stablecoin is a deployment choice, and no line of",
        "policy, consensus or payout logic knows the difference.",
        "Everything the authority sets at deployment. Gathered into one type so the",
        "rules that make a set of parameters valid live in one place and can be",
        "checked without a runtime."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "aggregator",
            "docs": [
              "The only role allowed to write a day record — `FR-015`. It cannot",
              "issue, settle or move anything."
            ],
            "type": "pubkey"
          },
          {
            "name": "cellExposureBps",
            "docs": [
              "`FR-020`: share of capital one cell may be exposed to."
            ],
            "type": "u16"
          },
          {
            "name": "premiumRewardsBps",
            "docs": [
              "`FR-034`: share of a premium that becomes the cell's reward reserve."
            ],
            "type": "u16"
          },
          {
            "name": "minSensorsPerCell",
            "docs": [
              "`FR-010`: independent votes an interval needs to get a value."
            ],
            "type": "u8"
          },
          {
            "name": "minStake",
            "docs": [
              "`FR-050`: stake below which a sensor publishes but does not vote."
            ],
            "type": "u64"
          },
          {
            "name": "unstakeDelayDays",
            "docs": [
              "`FR-053`: thaw before stake can leave."
            ],
            "type": "u16"
          },
          {
            "name": "waitingPeriodDays",
            "docs": [
              "`FR-023`: gap between buying cover and the start of the window."
            ],
            "type": "u16"
          },
          {
            "name": "dryDayThresholdMmX100",
            "docs": [
              "`FR-047`: a day is dry when its total does not exceed this."
            ],
            "type": "u32"
          },
          {
            "name": "secondsPerDay",
            "docs": [
              "`FR-049`: 86_400 in production, seconds in a scenario run."
            ],
            "type": "u32"
          }
        ]
      }
    }
  ]
}
