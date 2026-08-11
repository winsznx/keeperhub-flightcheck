# Claims ledger

Every public claim this project makes, the evidence behind it, and how strong that evidence is.
The README is not allowed to say anything this file does not support.

Proof levels:

| level | meaning |
|---|---|
| **onchain** | verifiable by a third party against a public node, without trusting us |
| **live-api** | reproduced against the live KeeperHub API, raw response retained |
| **measured** | timed or counted during a real run, raw log retained |
| **automated** | enforced by a test that fails the build |
| **fixture** | a parser or state-machine test against a captured real response shape, not a live reproduction |
| **observed** | seen on our runs, not guaranteed to generalise |

Last verified: 2026-08-11.

---

## The headline claim

| # | Claim | Level | Evidence |
|---|---|---|---|
| 1 | KeeperHub executed a real transaction on Base Sepolia from a fresh environment | onchain | tx [`0xb4098917…d452dc`](https://sepolia.basescan.org/tx/0xb4098917d12030a249e9376217d765b715362c744dd23e9b03e0213253d452dc), block 45339897 |
| 2 | That transaction corresponds to KeeperHub execution `exnn6k0y1ojnnvb8sa1fu` | live-api | `evidence/runs/`, status response retained in `internal/seam-raw/` |
| 3 | The transaction emitted `Flightcheck(sender, challenge, chainId)` from the pinned canary | onchain | receipt log, topic0 `0x4947ef22…de7f33`, emitter `0x2a6f…555a` |
| 4 | The challenge in that event is the one generated before the request was sent | onchain | challenge `0x61b3cc48…3fb4e2` appears in the capsule and as topic 3 of the log |
| 5 | All three proof legs agreed on that run | onchain + live-api | `agreement.allLegsAgree: true` in the capsule |

## The canary

| # | Claim | Level | Evidence |
|---|---|---|---|
| 6 | The canary moves no value and writes no storage | automated | `contracts/test/`, 5 tests including a non-payable check and a storage-slot check |
| 7 | Its runtime bytecode hash is `0x753157…49dd0` and matches onchain | onchain | `cast code … \| cast keccak`, compared every run at `CANARY_VERIFIED` |
| 8 | That hash was committed before deployment | measured | `evidence/canary-build.json`, written pre-deploy with `address: null` |
| 9 | The build is byte-reproducible | measured | hashed across two clean `forge clean && forge build` cycles; solc, evm version, optimizer and CBOR metadata all pinned |
| 10 | The source is verified on Basescan | onchain | [contract page](https://sepolia.basescan.org/address/0x2a6fc8182bf9928ef7517da980dc79e8107c555a) |
| 11 | Flightcheck fails closed on a bytecode mismatch | automated | `machine.test.ts`, "wrong bytecode stops the run before KeeperHub is asked to call it" |

## Idempotency and recovery

| # | Claim | Level | Evidence |
|---|---|---|---|
| 12 | Losing the broadcast response does not create a second transaction | onchain + measured | `evidence/recovery/fault-injection.json`: 2 broadcast requests sent, 1 log onchain for the run's challenge |
| 13 | Recovery works by replaying the persisted key, and KeeperHub marks it `idempotentReplay` | live-api | same file, `recovery.idempotentReplay: true` |
| 14 | "Exactly one transaction" is counted from the chain, not from our bookkeeping | onchain | `eth_getLogs` filtered to the canary address and the run's unique challenge topic |
| 15 | The request and key are persisted and fsynced before the request is sent | automated | `runstore.ts` fsyncs; `machine.test.ts` "the request is persisted before the broadcast is attempted" |
| 16 | A transport retry never mints a new idempotency key | automated | `machine.test.ts` "a lost response triggers one replay of the same key, not a new request" |
| 17 | A run older than the 24-hour replay window refuses to resume | automated | `unit.test.ts` "refuses to resume past the 24 hour replay window" |

## Failure handling

| # | Claim | Level | Evidence |
|---|---|---|---|
| 18 | Every failure code has a stage and a remediation, and the count in `docs/failure-codes.md` and `evidence/manifest.json` is generated from the same source | automated | `unit.test.ts` "every code has a stage, a title and a usable remediation"; `docs/failure-codes.md` is generated from the same source |
| 19 | A failed simulation never broadcasts | automated | `machine.test.ts` asserts `calls.broadcast === 0` on revert |
| 20 | `unconfirmed` is modelled as non-terminal and never as failure | automated | `unit.test.ts` and `machine.test.ts` |
| 21 | An unrecognised future status is UNKNOWN and never mapped to success | automated | `machine.test.ts` "an unrecognised status is UNKNOWN and never mapped to success" |
| 22 | A `failed` execution whose receipts are only `not_found`/`timeout` is downgraded to UNCONFIRMED | automated | `unit.test.ts` reconcileState tests |
| 23 | A wrong-key-type mistake is diagnosed by name before any network call | automated | `unit.test.ts` classifyKey plus the FC_ENV_WRONG_KEY_TYPE message test |
| 24 | Wrong emitter, wrong challenge, wrong chain id and hash disagreement each fail verification | fixture | `machine.test.ts` settlement and verification suite |
| 25 | 80 tests pass with no network access | measured | `evidence/test-run.json` |

## Secrets

| # | Claim | Level | Evidence |
|---|---|---|---|
| 26 | No API key or private key appears in any capsule, log or console output | automated | `machine.test.ts` "the capsule carries no secret, even with the key registered", using `findLeaks` |
| 27 | A keyed RPC URL is never published as provenance | automated | `unit.test.ts` safeRpcOrigin tests; capsule emits `redacted` |
| 28 | Redaction catches secret shapes that were never registered | automated | `unit.test.ts` "catches secret shapes nobody registered" |
| 29 | Values we publish on purpose are not mangled by the redactor | automated | `unit.test.ts` "does not mangle values we publish on purpose" |
| 30 | Zero runtime dependencies | measured | `package.json` `dependencies: {}`; only `typescript` and `@types/node` as dev deps |
| 30a | `evidence/manifest.json` summarises every verified run and is regenerated automatically after each one | automated | `cli.ts` calls the manifest generator on a verified outcome; `npm run evidence` regenerates it manually |

## Findings reported about KeeperHub

Each of these is stated in the teardown at the level below and nowhere stronger.

| # | Claim | Level | Evidence |
|---|---|---|---|
| 31 | The `/contract-call` 202 carries no `transactionHash` even when status is `completed` | live-api | `internal/seam-raw/auth_execute_run.json`, `execBody` |
| 32 | `unconfirmed` is absent from the Direct Execution status list while documented elsewhere on the same site | verified doc conflict | two URLs, quoted in the teardown |
| 33 | `gasUsedWei` carries gas units, byte-equal to `receipts[0].gasUsed` | live-api | same capture |
| 34 | A simulation passed while the resolved sender held zero native balance | live-api + onchain | simulation response plus `cast balance` at the same time |
| 35 | ~~`llms.txt` omits the onboarding pages~~ WITHDRAWN. True on 2026-08-10, fixed upstream by 2026-08-11 and re-verified before publication | withdrawn | teardown item 6 records both measurements |
| 36 | `/api/openapi` contains no core REST path and no bearer security scheme, while being advertised as the REST schema | live-api | reproduction in the teardown, re-verified 2026-08-11: 117 paths, all workflow calls |
| 38 | Two upstream PRs opened against KeeperHub/keeperhub | verifiable | [#2005](https://github.com/KeeperHub/keeperhub/pull/2005) unconfirmed status, [#2006](https://github.com/KeeperHub/keeperhub/pull/2006) OpenAPI description |
| 37 | The org wallet's explorer view shows nothing for a sponsored execution | onchain | `receipt.from` is a relayer; org wallet balance was 0 throughout |

## Deliberately not claimed

- Not claimed: that gas sponsorship applies to any organisation other than ours. Every run
  records the `sponsored` flag it observed and the README says observed, not promised.
- Not claimed: that `msg.sender == org wallet` holds on the non-sponsored path. Unmeasured, and
  the capsule records `recorded-not-asserted` there.
- Not claimed: that Flightcheck works under Safe routing. It does not model it and says so.
- Not claimed: any mainnet behaviour.
- Not claimed: a human onboarding study. The benchmark was run by agents and is labelled an
  agent onboarding benchmark.
- Not claimed: that the fixture-based tests are live reproductions. They are labelled `fixture`
  above and in the test file header.
