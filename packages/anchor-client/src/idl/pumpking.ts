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
      "name": "claimUnclaimedPayout",
      "docs": [
        "Delivers a payout settlement could not — `FR-029`. Reachable only for",
        "a policy whose owner's account was frozen when the event landed; the",
        "money waited in the vault, reserved, the whole time."
      ],
      "discriminator": [
        254,
        75,
        48,
        47,
        12,
        77,
        124,
        113
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Anybody again. The destination is bound to the owner either way, so a",
            "stranger completing the delivery for a farmer is help, not a risk."
          ],
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
                "kind": "account",
                "path": "policy.cell_id",
                "account": "policy"
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
                "path": "policy.owner",
                "account": "policy"
              },
              {
                "kind": "account",
                "path": "policy.nonce",
                "account": "policy"
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
            "`FR-066` once more: the owner's account, and the money has nowhere",
            "else it could go."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "closePolicy",
      "docs": [
        "Closes a policy whose window ended without the event — `FR-028`. No",
        "money moves: the premium became capital at issue. What is released is",
        "the reservation, which is the pool's capacity to sell more cover."
      ],
      "discriminator": [
        55,
        42,
        248,
        229,
        222,
        138,
        26,
        252
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Anybody, for the same reason settlement is: a policy that needed a",
            "particular key to be closed would tie up the pool's capacity at that",
            "key's convenience."
          ],
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
                "kind": "account",
                "path": "policy.cell_id",
                "account": "policy"
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
                "path": "policy.owner",
                "account": "policy"
              },
              {
                "kind": "account",
                "path": "policy.nonce",
                "account": "policy"
              }
            ]
          }
        }
      ],
      "args": []
    },
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
    },
    {
      "name": "settlePolicy",
      "docs": [
        "Pays a policy the index has triggered — `FR-026`, `FR-027`, `FR-030`.",
        "Permissionless by construction: there is no authority account in the",
        "context, so there is no key that could withhold a payout that is owed",
        "and none that could produce one the day log does not support."
      ],
      "discriminator": [
        180,
        234,
        21,
        174,
        50,
        214,
        91,
        113
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "`FR-030`: anybody. The caller pays the transaction fee and gets",
            "nothing, and is checked against nothing — a payout that needed a",
            "particular key to arrive would be a payout that key could withhold.",
            "In practice the worker calls it; the owner, a neighbour or a bot",
            "calling it instead changes nothing about the outcome."
          ],
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
                "kind": "account",
                "path": "policy.cell_id",
                "account": "policy"
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
                "path": "policy.owner",
                "account": "policy"
              },
              {
                "kind": "account",
                "path": "policy.nonce",
                "account": "policy"
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
            "`FR-066`: an account the policy's owner holds the authority over, and",
            "the constraint is the whole of \"the recipient cannot be changed\". The",
            "caller chooses which of the owner's accounts, never whose."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "submitDayRecord",
      "docs": [
        "Writes one day of a cell — `FR-015`. The only door the day log has, and",
        "the aggregator is the only key that opens it. The Merkle root of the",
        "values the day was summed from goes out as an event, which is what",
        "makes the day auditable rather than merely asserted (`FR-037`)."
      ],
      "discriminator": [
        44,
        39,
        117,
        161,
        74,
        198,
        100,
        180
      ],
      "accounts": [
        {
          "name": "aggregator",
          "docs": [
            "`FR-015`: the aggregator is the only role that may write a day, and it",
            "cannot spend. The constraint is on the key rather than on a list, so",
            "there is exactly one of it and rotating it is a pool parameter change."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "pool",
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
            "Opened by the first day the network publishes for this cell. A cell is",
            "exactly \"somewhere readings come from\", so there is nothing to register",
            "before the readings arrive — and only the aggregator reaches this",
            "instruction, so `init_if_needed` opens nothing a stranger could."
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
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "dayRecordParams"
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
  "events": [
    {
      "name": "dayRecorded",
      "discriminator": [
        65,
        62,
        166,
        104,
        108,
        221,
        163,
        182
      ]
    },
    {
      "name": "payoutClaimed",
      "discriminator": [
        200,
        39,
        105,
        112,
        116,
        63,
        58,
        149
      ]
    },
    {
      "name": "payoutUnclaimed",
      "discriminator": [
        22,
        150,
        189,
        238,
        181,
        9,
        61,
        85
      ]
    },
    {
      "name": "policyClosed",
      "discriminator": [
        19,
        126,
        82,
        173,
        79,
        86,
        50,
        51
      ]
    },
    {
      "name": "policySettled",
      "discriminator": [
        67,
        45,
        149,
        235,
        199,
        184,
        83,
        77
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
    },
    {
      "code": 6024,
      "name": "notTheAggregator",
      "msg": "Only the aggregator may write a day record"
    },
    {
      "code": 6025,
      "name": "unknownDayState",
      "msg": "The day classification is not one the log knows"
    },
    {
      "code": 6026,
      "name": "dayNotOver",
      "msg": "A day can only be recorded once it is over"
    },
    {
      "code": 6027,
      "name": "dayNotNewer",
      "msg": "The day log only grows forwards"
    },
    {
      "code": 6028,
      "name": "dayHasNoIntervals",
      "msg": "A day must have had intervals to be measured from"
    },
    {
      "code": 6029,
      "name": "coverageCountsDisagree",
      "msg": "More intervals were covered than the day had"
    },
    {
      "code": 6030,
      "name": "dayHasNoCoverage",
      "msg": "A day with a value must have had a covered interval"
    },
    {
      "code": 6031,
      "name": "uncoveredDayHasRainfall",
      "msg": "A day without coverage cannot carry rainfall"
    },
    {
      "code": 6032,
      "name": "measuredDayHasNoRainfall",
      "msg": "A measured day must carry the rainfall it was measured as"
    },
    {
      "code": 6033,
      "name": "uncoveredDayHasContributors",
      "msg": "A day without coverage earns nobody a contribution"
    },
    {
      "code": 6034,
      "name": "contributorsOutOfRange",
      "msg": "The contributor mask addresses a sensor slot the cell has not"
    },
    {
      "code": 6035,
      "name": "tooFewContributors",
      "msg": "A day with a value needs the minimum number of independent votes"
    },
    {
      "code": 6036,
      "name": "rainfallNegative",
      "msg": "Rainfall cannot be negative"
    },
    {
      "code": 6037,
      "name": "dayStateContradictsRainfall",
      "msg": "The day classification disagrees with the rainfall it came from"
    },
    {
      "code": 6038,
      "name": "policyNotActive",
      "msg": "The policy is not active"
    },
    {
      "code": 6039,
      "name": "policyCellMismatch",
      "msg": "The policy was written on a different cell"
    },
    {
      "code": 6040,
      "name": "eventHasNotHappened",
      "msg": "The index has not reached the policy's threshold"
    },
    {
      "code": 6041,
      "name": "windowNotOver",
      "msg": "The coverage window still has a day the log has not answered for"
    },
    {
      "code": 6042,
      "name": "eventHasHappened",
      "msg": "The event happened; this policy is settled, not closed"
    },
    {
      "code": 6043,
      "name": "policyNotUnclaimed",
      "msg": "The policy has no undelivered payout waiting"
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
      "name": "dayRecordParams",
      "docs": [
        "One day of one cell, written by the aggregator — `FR-015`.",
        "",
        "This is the only door the day log has. Everything downstream reads it and",
        "nothing else: `price_of` counts dry days in it, `dry_spell` finds the run",
        "in it, and `settle_policy` owes money because of what it says. So the",
        "questions worth asking are asked here, once, on the way in.",
        "",
        "**What the chain checks and what it takes on trust.** The classification",
        "arrives already made — the aggregator collected the intervals, took the",
        "median of each (`FR-008`, `FR-010`) and summed the day — because the",
        "intervals themselves never reach the chain. But the pool publishes the dry",
        "threshold, so the chain re-derives dry from wet itself rather than",
        "believing the label: mislabelling a wet day as dry is the cheapest way to",
        "fabricate a payout, and it is the one thing here the chain already knows",
        "enough to refuse.",
        "",
        "The share of intervals a day needs to count as measured (`FR-048`) stays",
        "the aggregator's call, because that parameter lives in the registry rather",
        "than in the pool. The asymmetry is deliberate and it leans one way: a day",
        "wrongly called uncovered denies cover, which `FR-047` is already",
        "conservative about, while a day wrongly called dry pays money out.",
        "",
        "What makes the rest auditable is `readings_root`: the Merkle root of the",
        "cell values the day was summed from, emitted with the record. `FR-037` and",
        "`SC-010` are that root plus the API that serves the leaves — a stranger",
        "redoes the arithmetic and proves any one value belongs to the day."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "cellId",
            "type": "u64"
          },
          {
            "name": "dayIndex",
            "docs": [
              "Day index, on the pool's clock — `FR-049`."
            ],
            "type": "u32"
          },
          {
            "name": "state",
            "docs": [
              "`DayState` as the log stores it: 0 none, 1 dry, 2 wet."
            ],
            "type": "u8"
          },
          {
            "name": "contributors",
            "docs": [
              "Bit per sensor slot whose readings entered the day's medians."
            ],
            "type": "u32"
          },
          {
            "name": "readingsRoot",
            "docs": [
              "Merkle root of the cell values this day was summed from — `FR-037`."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "rainfallX100",
            "docs": [
              "Sum of the covered intervals, `None` when the day has no value. Not",
              "zero: zero is a real, dry reading of the sky, and silence is not."
            ],
            "type": {
              "option": "i32"
            }
          },
          {
            "name": "coveredIntervals",
            "docs": [
              "Intervals that carried a value, and intervals the day had at all.",
              "Shown in the trace, because a day measured from half its hours is a",
              "different claim than one measured from all of them — `FR-048`."
            ],
            "type": "u16"
          },
          {
            "name": "totalIntervals",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "dayRecorded",
      "docs": [
        "What a recorded day says, for anyone reconstructing the trace — `FR-016`,",
        "`FR-037`.",
        "",
        "An event rather than an account: 32 bytes of root per day per cell would be",
        "four kilobytes of rent on every cell to hold what the transaction log",
        "already keeps, and the trace is read off-chain by definition."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "cellId",
            "type": "u64"
          },
          {
            "name": "dayIndex",
            "type": "u32"
          },
          {
            "name": "state",
            "type": "u8"
          },
          {
            "name": "contributors",
            "type": "u32"
          },
          {
            "name": "readingsRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "rainfallX100",
            "type": {
              "option": "i32"
            }
          },
          {
            "name": "coveredIntervals",
            "type": "u16"
          },
          {
            "name": "totalIntervals",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "payoutClaimed",
      "docs": [
        "A deferred payout, finally delivered — `FR-029`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "policy",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "payout",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "payoutUnclaimed",
      "docs": [
        "A payout that was owed and could not be delivered — `FR-029`. The money is",
        "still in the vault and still reserved against this policy; what the event",
        "records is that the obligation was recognised and delivery deferred."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "policy",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "payout",
            "type": "u64"
          },
          {
            "name": "spellDays",
            "docs": [
              "The run that triggered it, kept here so the trace does not have to",
              "re-derive an index from a window the ring may no longer hold."
            ],
            "type": "u32"
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
      "name": "policyClosed",
      "docs": [
        "A window that ended without the event — `FR-028`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "policy",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "cellId",
            "type": "u64"
          },
          {
            "name": "spellDays",
            "docs": [
              "The longest run the window did hold, and the one it needed."
            ],
            "type": "u32"
          },
          {
            "name": "spellDaysThreshold",
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
      "name": "policySettled",
      "docs": [
        "The event, recorded where anyone can read it — `FR-016`, `FR-037`.",
        "",
        "`spell_days` is the index that crossed the threshold, and the window says",
        "which days it was found in. Together with the `DayRecorded` events of those",
        "days and the Merkle roots they carry, this is the whole trace: readings →",
        "cell values → days → index → this transaction."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "policy",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "cellId",
            "type": "u64"
          },
          {
            "name": "payout",
            "type": "u64"
          },
          {
            "name": "spellDays",
            "docs": [
              "The run that triggered it, and the threshold it had to reach."
            ],
            "type": "u32"
          },
          {
            "name": "spellDaysThreshold",
            "type": "u8"
          },
          {
            "name": "windowStartDay",
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
