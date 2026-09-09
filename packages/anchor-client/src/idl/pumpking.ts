/**
 * ЗГЕНЕРОВАНО `pnpm idl:sync` з `target/` після `anchor build`. Не редагувати:
 * джерело — `programs/pumpking`, ручна правка зникне на наступному прогоні.
 */

/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/pumpking.json`.
 */
export type Pumpking = {
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
    },
    {
      "name": "issuePolicy",
      "docs": [
        "Sells cover — `FR-018`. Once this returns, the payout is owed the",
        "moment the index says so: `settle_policy` has no discretion, so every",
        "question the pool gets to ask is asked here."
      ],
      "discriminator": [
        126,
        159,
        34,
        92,
        118,
        55,
        15,
        196
      ],
      "accounts": [
        {
          "name": "owner",
          "docs": [
            "`FR-025` and `FR-067`: buyer, owner and payer are one account. The",
            "policy holds no payer field, so a cooperative or a donor paying for",
            "somebody else changes this instruction later and nothing downstream —",
            "not settlement, not consensus, not the index."
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
          "name": "cell",
          "docs": [
            "Must already exist: cover is sold on a cell the network is publishing",
            "for, and `FR-022` is that sentence enforced."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  101,
                  108,
                  108
                ]
              },
              {
                "kind": "arg",
                "path": "params.cell_id"
              }
            ]
          }
        },
        {
          "name": "policy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "params.nonce"
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
          "name": "ownerTokens",
          "docs": [
            "The buyer's own token account — `FR-025`."
          ],
          "writable": true
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
              "name": "policyParams"
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
      "name": "cellState",
      "discriminator": [
        183,
        122,
        196,
        168,
        99,
        142,
        27,
        53
      ]
    },
    {
      "name": "policy",
      "discriminator": [
        222,
        135,
        7,
        163,
        235,
        177,
        33,
        68
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
    },
    {
      "code": 6011,
      "name": "payoutNotSet",
      "msg": "A policy must pay out something"
    },
    {
      "code": 6012,
      "name": "windowNotOrdered",
      "msg": "The coverage window ends before it starts"
    },
    {
      "code": 6013,
      "name": "windowTooLong",
      "msg": "The coverage window is longer than the day log can answer for"
    },
    {
      "code": 6014,
      "name": "thresholdOutOfWindow",
      "msg": "The spell threshold cannot be reached inside the coverage window"
    },
    {
      "code": 6015,
      "name": "waitingPeriodNotElapsed",
      "msg": "Coverage may not start before the waiting period has elapsed"
    },
    {
      "code": 6016,
      "name": "cellNotCovered",
      "msg": "The cell has fewer sensors than a value needs"
    },
    {
      "code": 6017,
      "name": "insufficientLiquidity",
      "msg": "Free liquidity does not cover this payout"
    },
    {
      "code": 6018,
      "name": "cellExposureExceeded",
      "msg": "The cell would owe more than its share of the capital"
    },
    {
      "code": 6019,
      "name": "dayIndexUnavailable",
      "msg": "The pool has no day index for this moment"
    },
    {
      "code": 6020,
      "name": "cellHistoryTooShort",
      "msg": "The cell has too few recorded days to price cover on"
    },
    {
      "code": 6021,
      "name": "premiumAboveLimit",
      "msg": "The premium is above the limit the buyer set"
    },
    {
      "code": 6022,
      "name": "riskLoadingOutOfRange",
      "msg": "Risk loading must not exceed 10000 basis points"
    },
    {
      "code": 6023,
      "name": "minRateOutOfRange",
      "msg": "The floor rate must be between 1 and 10000 basis points"
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
      "name": "cellState",
      "docs": [
        "PDA `[\"cell\", cell_id]`. Everything the settlement of a policy reads."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "cellId",
            "docs": [
              "H3 index — `FR-006`. The grid level is read back out of it (`FR-069`),",
              "so a policy is settled at the level it was sold on."
            ],
            "type": "u64"
          },
          {
            "name": "sensorCount",
            "docs": [
              "Registered sensors, at most `MAX_SENSORS_PER_CELL`."
            ],
            "type": "u8"
          },
          {
            "name": "underInvestigation",
            "docs": [
              "`FR-045`: systematic divergence from the reference stops new policies",
              "on this cell. Policies already sold keep being served by the median —",
              "the reference moves future underwriting, never a live obligation."
            ],
            "type": "bool"
          },
          {
            "name": "reserved",
            "docs": [
              "Payout committed to policies on this cell — checked against",
              "`Pool::cell_exposure_limit`."
            ],
            "type": "u64"
          },
          {
            "name": "rewardsReserve",
            "docs": [
              "`FR-062`: the reward reserve belongs to the cell, fed by the premiums",
              "of its own policies and split between the sensors that voted."
            ],
            "type": "u64"
          },
          {
            "name": "firstDayIndex",
            "docs": [
              "Oldest day the ring buffer still holds."
            ],
            "type": "u32"
          },
          {
            "name": "lastDayIndex",
            "docs": [
              "Newest day recorded; `None` until the cell has its first day."
            ],
            "type": {
              "option": "u32"
            }
          },
          {
            "name": "dayLog",
            "docs": [
              "`0` no coverage, `1` dry, `2` wet, indexed by `day_index % DAY_LOG_LEN`.",
              "A day inside the window that was never written reads as no coverage,",
              "which is the honest answer and breaks a run — `FR-047`."
            ],
            "type": {
              "array": [
                "u8",
                128
              ]
            }
          },
          {
            "name": "contributors",
            "docs": [
              "Bitmask of the sensors that voted in that day, same slot."
            ],
            "type": {
              "array": [
                "u32",
                128
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "policy",
      "docs": [
        "PDA `[\"policy\", owner, nonce]`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "docs": [
              "`FR-066`: fixed at issue and never changed. There is no path to",
              "redirect someone else's payout, because there is no field to change."
            ],
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "docs": [
              "Distinguishes several policies of one owner; part of the seeds, so it",
              "is stored to let the address be rebuilt from the account."
            ],
            "type": "u64"
          },
          {
            "name": "cellId",
            "type": "u64"
          },
          {
            "name": "spellDaysThreshold",
            "docs": [
              "`FR-046`: consecutive dry days that trigger the event."
            ],
            "type": "u8"
          },
          {
            "name": "payout",
            "type": "u64"
          },
          {
            "name": "premium",
            "docs": [
              "`FR-025`: paid by the owner from their own wallet, so there is no",
              "separate payer field to hold."
            ],
            "type": "u64"
          },
          {
            "name": "windowStartDay",
            "docs": [
              "Day indices, inclusive. `FR-069`: the window is counted at the grid",
              "level this cell was sold on."
            ],
            "type": "u32"
          },
          {
            "name": "windowEndDay",
            "type": "u32"
          },
          {
            "name": "state",
            "type": {
              "defined": {
                "name": "policyState"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "policyParams",
      "docs": [
        "Selling cover — the point where the pool takes on risk it cannot refuse",
        "later. Everything the underwriting depends on is checked here, because",
        "`settle_policy` (`FR-030`) has no discretion at all: once this instruction",
        "returns `Ok`, the payout is owed the moment the index says so.",
        "The terms of one policy, as the buyer states them.",
        "",
        "Gathered into one type for the same reason as `PoolParams`: the rules that",
        "make a set of terms sellable live in one place and can be checked without a",
        "runtime. `owner` is not among them — it is the signer, and `FR-066` gives",
        "the policy no field to point the money somewhere else."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "nonce",
            "docs": [
              "Distinguishes several policies of one buyer; part of the seeds."
            ],
            "type": "u64"
          },
          {
            "name": "cellId",
            "docs": [
              "`FR-006`: cover is sold on a cell, never on a field."
            ],
            "type": "u64"
          },
          {
            "name": "spellDaysThreshold",
            "docs": [
              "`FR-046`: consecutive dry days that trigger the event."
            ],
            "type": "u8"
          },
          {
            "name": "payout",
            "type": "u64"
          },
          {
            "name": "maxPremium",
            "docs": [
              "The most the buyer will pay. `FR-021` sets the price, not this: the",
              "program charges what the formula says and refuses above this bound.",
              "Without it a quote and the transaction that follows it are two",
              "different prices whenever a day is recorded in between."
            ],
            "type": "u64"
          },
          {
            "name": "windowStartDay",
            "docs": [
              "Day indices, both ends inclusive — `FR-024`."
            ],
            "type": "u32"
          },
          {
            "name": "windowEndDay",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "policyState",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "active"
          },
          {
            "name": "paidOut"
          },
          {
            "name": "closedNoEvent"
          },
          {
            "name": "unclaimed"
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
            "name": "riskLoadingBps",
            "docs": [
              "`FR-021`: what the pool charges on top of the expected loss. A pool",
              "charging exactly its expected loss breaks even on average and goes",
              "insolvent on variance; this is the difference between a pool and a",
              "coin flip, and it is published rather than negotiated."
            ],
            "type": "u16"
          },
          {
            "name": "minRateBps",
            "docs": [
              "`FR-021`: the rate below which cover is not sold at any history. A",
              "fortnight without a dry day is not proof that a cell never dries out,",
              "and the formula has no other way to say \"we do not know yet\"."
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
            "name": "riskLoadingBps",
            "docs": [
              "`FR-021`: what the pool charges on top of the expected loss."
            ],
            "type": "u16"
          },
          {
            "name": "minRateBps",
            "docs": [
              "`FR-021`: the rate below which cover is not sold at any history."
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
};
