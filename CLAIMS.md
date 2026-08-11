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

Last verified: 2026-08-11, after an external adversarial audit and the Bootstrap extension. Rows 8 and 35 were downgraded or
withdrawn as a result, and rows 4, 12 and 14 were narrowed to what the evidence actually shows.
The audit report is in `internal/audit-report.md`.

---

## The headline claim

| # | Claim | Level | Evidence |
|---|---|---|---|
| 1 | KeeperHub executed a real transaction on Base Sepolia from a fresh environment | onchain | tx [`0xb4098917…d452dc`](https://sepolia.basescan.org/tx/0xb4098917d12030a249e9376217d765b715362c744dd23e9b03e0213253d452dc), block 45339897 |
| 2 | That transaction corresponds to KeeperHub execution `exnn6k0y1ojnnvb8sa1fu` | live-api | `evidence/runs/`, status response retained in `internal/seam-raw/` |
| 3 | The transaction emitted `Flightcheck(sender, challenge, chainId)` from the pinned canary | onchain | receipt log, topic0 `0x4947ef22…de7f33`, emitter `0x2a6f…555a` |
| 4 | The challenge in the event is byte-identical to the one in the capsule | onchain | challenge `0x61b3cc48…3fb4e2` is topic 3 of the log |
| 4a | That challenge was generated before the request was sent | code inspection | `machine.ts` mints it at record construction, before any network call. A public node cannot establish ordering, only that the value is present. The security property that matters, that 32 fresh random bytes cannot appear in a pre-existing transaction, does not depend on this row |
| 5 | All three proof legs agreed on that run | onchain + live-api | `agreement.allLegsAgree: true` in the capsule |

## The canary

| # | Claim | Level | Evidence |
|---|---|---|---|
| 6 | The canary moves no value and writes no storage | automated | `contracts/test/`, 5 tests including a non-payable check and a storage-slot check |
| 7 | Its runtime bytecode hash is `0x753157…49dd0` and matches onchain | onchain | `cast code … \| cast keccak`, compared every run at `CANARY_VERIFIED` |
| 8 | ~~That hash was committed before deployment~~ **DOWNGRADED.** The file was written before deployment on the build machine, but the public repo is a single squashed commit made after, so no public artifact establishes the ordering | unverifiable | An audit checked `git log -p` and found no commit containing the pre-deploy state. Claim 9 makes this nearly redundant: the build reproduces from source and matches the deployed code, so the pin is checkable regardless of when it was written |
| 9 | The build is byte-reproducible | measured | hashed across two clean `forge clean && forge build` cycles; solc, evm version, optimizer and CBOR metadata all pinned |
| 10 | The source is verified on Basescan | onchain | [contract page](https://sepolia.basescan.org/address/0x2a6fc8182bf9928ef7517da980dc79e8107c555a) |
| 11 | Flightcheck fails closed on a bytecode mismatch | automated | `machine.test.ts`, "wrong bytecode stops the run before KeeperHub is asked to call it" |

## Idempotency and recovery

| # | Claim | Level | Evidence |
|---|---|---|---|
| 12 | On the observed run, losing the broadcast response produced exactly one *successfully executed* transaction | onchain + measured, n=1 | `evidence/recovery/fault-injection.json`: 2 broadcast requests sent, 1 log onchain for the run's challenge. **Scope:** `eth_getLogs` only returns logs from successful transactions, so a duplicate that reverted or ran out of gas would be invisible to this count. And KeeperHub's idempotency is a third-party guarantee observed once, not a property we can enforce |
| 13 | Recovery works by replaying the persisted key, and KeeperHub marks it `idempotentReplay` | live-api | same file, `recovery.idempotentReplay: true` |
| 14 | The count comes from the chain, not from our bookkeeping | onchain | `eth_getLogs` filtered to the canary address and the run's unique challenge topic. An external audit re-ran this across the canary's entire history from its deploy block: 7 events, 7 distinct challenges, none repeated |
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
| 25 | 113 tests pass with no network access, from a fresh clone with no install | measured | `evidence/test-run.json`, regenerated from the run rather than typed |

## Secrets

| # | Claim | Level | Evidence |
|---|---|---|---|
| 26 | No API key or private key appears in any capsule, log or console output | automated | `machine.test.ts` "the capsule carries no secret, even with the key registered", using `findLeaks` |
| 27 | A keyed RPC URL is never published as provenance | automated | `unit.test.ts` safeRpcOrigin tests; capsule emits `redacted` |
| 28 | Redaction catches secret shapes that were never registered | automated | `unit.test.ts` "catches secret shapes nobody registered" |
| 29 | Values we publish on purpose are not mangled by the redactor | automated | `unit.test.ts` "does not mangle values we publish on purpose" |
| 30 | Zero runtime dependencies | measured | `package.json` `dependencies: {}`; only `typescript` and `@types/node` as dev deps |
| 30b | The hand-written keccak256 is byte-identical to independent implementations across every rate boundary | measured | `evidence/keccak-differential.json`, 60 cases vs Foundry. An external audit independently ran 433 vectors against pycryptodome and eth_hash with zero mismatches |
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
| 38 | Two PRs are open and unmerged against KeeperHub/keeperhub, and neither change is on `staging` as of 2026-08-11 | verifiable | [#2008](https://github.com/KeeperHub/keeperhub/pull/2008), [#2009](https://github.com/KeeperHub/keeperhub/pull/2009). Predecessors #2005/#2006 were closed by us, not by a maintainer, after a commit-authorship rewrite detached their branches |
| 37 | The org wallet's explorer view shows nothing for a sponsored execution | onchain | `receipt.from` is a relayer; org wallet balance was 0 throughout |

## Bootstrap and the gas fallback

| # | Claim | Level | Evidence |
|---|---|---|---|
| 39 | The interactive key prompt echoes nothing | live pty | **This claim was false in the first release of the extension.** An external audit drove the real CLI under a kernel pty on macOS with Node 24 and the key printed in plaintext. Echo is now suppressed with `stty` and the terminal's actual state is verified before a byte is read; re-tested under the same pty harness, no echo. `agent/tests/pty-echo.test.ts` |
| 39a | If the terminal will not confirm echo is off, Flightcheck refuses to read rather than reading visibly | automated | `FC_SECRET_ECHO_UNSAFE`; `bootstrap.test.ts` "a terminal that will not suppress echo is refused rather than read from" |
| 40 | An interactively supplied key is never written to `.env`, run state, a capsule or a log | automated | it exists only as a local in `runBootstrap`; the capsule redaction test covers the output side |
| 41 | A credential on the command line is refused | automated | `bootstrap.test.ts` covers `--key`, `--api-key=`, a bare `kh_` and a bare `wfb_` argument |
| 42 | With no TTY and no environment key, Flightcheck fails closed rather than reading a pipe | automated + live | `FC_SECRET_TTY_REQUIRED`; reproduced live with `< /dev/null` |
| 43 | The environment path still works for CI | automated + live | `bootstrap.test.ts`; the live `setup --execute` run used it |
| 44 | The faucet request contains no KeeperHub credential | automated | a realistic `kh_` key is registered, a real client request is issued, and the whole outbound URL, headers and body are asserted to contain no byte of it and no `Authorization` header |
| 45 | A zero balance alone never triggers the faucet | automated + onchain | `gaspolicy` refuses on `sponsored_success`; the canonical transaction was executed from a zero-balance wallet |
| 46 | An ambiguous or possibly-broadcast failure never triggers the faucet | automated | 11 refusal cases in `bootstrap.test.ts`, including transport loss, unconfirmed, and an existing execution id |
| 47 | A new idempotency key is only minted after a proven pre-broadcast failure | automated | `mayStartNewLogicalRun` tests |
| 48 | The faucet is Base Sepolia only and takes no caller-selected chain or amount | live | live acceptance rejects `amountWei` and `chainId` with `invalid_request` |
| 49 | The faucet sends exactly one transaction per logical claim, keyed on recipient and request id | live | live acceptance: replay returns the original hash, balance unchanged, concurrent claims produce one distinct hash |
| 50 | A live faucet transfer was executed and independently verified | onchain | [`0x39b1504c2f4f371bdab5451da6251b7e5fa397757882a957fb285e75f6a69ab9`](https://sepolia.basescan.org/tx/0x39b1504c2f4f371bdab5451da6251b7e5fa397757882a957fb285e75f6a69ab9), receipt status `0x1`, recipient balance increased by exactly the fixed payout |
| 51 | 21/21 live faucet acceptance checks pass against the deployed service and real Base Sepolia | live | `evidence/faucet/live-acceptance.json` |
| 52 | The treasury private key never entered the repository, git history, or any model-visible output | measured | generated locally, piped to `wrangler secret put` over stdin; the published address was read back from the Worker, which derives it from the secret |
| 49a | The faucet's per-caller and global caps are enforced atomically | live | **Not true in the first release.** An audit fired 15 concurrent claims against a cap of 5 and none were refused, because the counter was a read-modify-write across three statements. It is now a single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`. Re-tested with the same 15-concurrent attack: all refused, and the counter recorded all 15 where it previously recorded about 3 |
| 53 | The Flightcheck CLI has zero runtime dependencies. The faucet Worker has one, `viem` | measured | root `package.json` empty `dependencies`; `faucet/package.json` has `viem` only, `npm audit` clean on both |

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
- Not claimed: that every KeeperHub user needs faucet gas. Ours never has; the canonical
  transaction was sponsored from a zero-balance wallet.
- Not claimed: that gas sponsorship can be known in advance, or that every KeeperHub organisation
  is sponsored. Each run reports the `sponsored` flag it observed.
- **Not claimed: that the gas fallback has been observed after a real KeeperHub
  `insufficient_balance` response.** It has not. The policy that decides when to fund is
  fixture-tested from a captured response shape, and the faucet is live-tested separately. We will
  not engineer an unsafe execution failure to make a fallback look useful.
- Not claimed: that the faucet prevents all abuse, supports any chain other than Base Sepolia, or
  is production infrastructure.
- Not claimed: a measured time saving from the bootstrap path. What is claimed is narrower and
  testable: the primary first-run path no longer requires creating or editing a `.env` file.
