# KeeperHub Flightcheck — measured onboarding run (treatment arm)

Date: 2026-08-11. All timestamps UTC, captured with `date -u +%H:%M:%S` immediately before/after each step.
Operator: autonomous agent, cold start, no prior knowledge of the tool.
Repo: `/Users/mac/keeperhub-flightcheck`

---

## 1. Timeline

| Timestamp | Action | Outcome |
|---|---|---|
| 12:13:24 | **T0.** Open repo root to read `README.md` | **No `README.md` exists.** Root has `.env`, `agent/`, `contracts/`, `docs/`, `evidence/`, `internal/`, `package.json` |
| 12:13:35 | `find . -iname "readme*"` excluding node_modules/.git | Only hit is `contracts/lib/forge-std/README.md` (vendored dep). `docs/` is **empty** |
| 12:13:43 | `git log` to check if README was deleted | `fatal: your current branch 'main' does not have any commits yet` — no history to recover from |
| 12:13:50 | Forced fallback: read `package.json` to find the entry point | Found `"flightcheck": "node --experimental-strip-types --no-warnings agent/src/cli.ts"` |
| 12:13:56 | `npm run flightcheck -- --help` | Clear, actionable. Usage + Flags + Safety + pinned Canary. This became the sole instruction source |
| 12:14:03 | `npm run flightcheck` (preflight, no broadcast) | Passed in **5s**. 5 checks green, gas estimate 23929 |
| 12:14:16 | `npm run flightcheck -- --execute` | Started |
| **12:14:22** | **T_first_tx** — block timestamp `0x6a7b121e` from public RPC log | Transaction exists onchain. **58s after T0** |
| 12:14:24 | `--execute` returns | Tool reports `Verified.` 10 checks green, 8.1s total, exit 0 |
| 12:14:40 | Independent leg 2: `curl` `eth_getTransactionReceipt` at `https://sepolia.base.org` | `"status": "0x1"` — **took 1 second** |
| 12:15:03 | Independent leg 1: read proof JSON | `keeperhubReceipt.verified: true`, `receiptStatus: "success"` |
| 12:15:21 | Independent leg 3a: `cast keccak "Flightcheck(address,bytes32,uint256)"` | `0x4947ef22…f33` — matches `topic0` in the onchain log |
| 12:15:38 | Independent leg 3b: `eth_chainId`, `abi-decode` topic1, `eth_getCode` + keccak | All reconcile (details §5) |
| **12:15:40** | **T_verified** — all three legs confirmed by me, not by the tool | **2m 16s after T0** |
| 12:15:55 | `npm run flightcheck -- status` | **DEFECT 1.** My verified run shown as `tx none observed`, `attempts undefined` |
| 12:16:09 | Inspect persisted run records to characterise the defect | Confirmed schema mismatch between journal and proof shapes |
| 12:16:47 | `npm run flightcheck -- --resume fc_443cab7c-…` (tests the `--help` idempotency safety claim) | **DEFECT 2.** Hard crash: `Cannot read properties of undefined (reading 'slice')`. No second tx |
| 12:17:07 | Re-run resume + status capturing true exit codes (my earlier `$?` read the pipeline, not npm) | resume = **3** (correct, non-zero). status = 0. Crash reproduced |
| 12:17:27 | `--version`, `status <run-id>`, `--json` | `status <run-id>` works fine. **DEFECT 3.** `--json` preflight emits only 2 fields |
| 12:18:02 | Count run records created after T0 to confirm transaction total | Exactly 1 |
| 12:18:23 | Decode `blockTimestamp` for authoritative T_first_tx | 12:14:22 UTC |

---

## 2. Totals

| Metric | Value |
|---|---|
| **T0 → T_first_tx** | **58 seconds** (12:13:24 → 12:14:22) |
| **T0 → T_verified (tool's own claim)** | **60 seconds** (12:13:24 → 12:14:24) |
| **T0 → T_verified (independently confirmed by me)** | **2 min 16 s** (12:13:24 → 12:15:40) |
| Time inside `--execute` | 8.1 s (tool-reported `timingsMs.total` = 8110) |
| Independent RPC verification (leg 2 alone) | **~1 second** |
| Bash tool invocations | 18 |
| Distinct shell commands (excluding `date`/`echo` instrumentation) | 32 |
| **Minimum commands on the happy path to a verified tx** | **3** (`--help`, `--execute`, one `curl`) |
| Files/pages opened | **4** (listed below) |
| Files read under `agent/src/` | **0** |
| Files read under `internal/` | **0** |
| Failed attempts against the primary goal | **0** — first `--execute` worked |
| Failed attempts overall | 4 (§4) |
| **Transactions created onchain** | **1** |

**Files/pages opened (complete list):**
1. `/Users/mac/keeperhub-flightcheck/package.json` — *forced*, because `README.md` does not exist
2. `/Users/mac/keeperhub-flightcheck/evidence/runs/fc_443cab7c-ca6b-4da0-9616-401a2b0ceb16.json` — the proof (tool output, leg 1)
3. `/Users/mac/keeperhub-flightcheck/.keeperhub/flightcheck/fc_443cab7c-ca6b-4da0-9616-401a2b0ceb16.json` — defect 1 analysis
4. `/Users/mac/keeperhub-flightcheck/.keeperhub/flightcheck/fc_25320695-3e95-4449-968e-06beac8cdd88.json` — defect 1 analysis

No source under `agent/src/` was read. The `--help` output was sufficient to reach a verified transaction without it.

**Transaction count integrity.** Four other run records exist in `.keeperhub/flightcheck/` from sessions predating this benchmark (mtimes 12:34, 13:01, 13:03, 13:04 local = 11:34–12:04 UTC, all before T0 = 12:13:24 UTC). Exactly one record, `fc_443cab7c`, was created after T0. Preflight-only runs do not persist a journal record. The two `--resume` invocations crashed before the execute stage and broadcast nothing.

---

## 3. Result

```
execution ID   ulaiz3n0nf4g38bwr458p
run ID         fc_443cab7c-ca6b-4da0-9616-401a2b0ceb16
transaction    0x1793377d34593fb1f7be7c05e3a9cc0b3c517e6c0c408683f25c5ff8947a212f
block          45341087 (0x2b3d99f) on chain 84532
challenge      0x3f001af8cc59152016482c740f72566ae676c1fc54af9c22ab288ab759253c45
canary         0x2A6FC8182Bf9928Ef7517dA980dC79e8107c555A
sponsored      true
```

---

## 4. Friction points, failures and confusion — with exact text

### F1 — BLOCKING: `README.md` does not exist (12:13:24)

The benchmark's premise is "read README.md first and follow it as written, like a stranger who just cloned it." That is unsatisfiable. A stranger cloning this repo finds:

- no `README.md` anywhere in the repo (only `contracts/lib/forge-std/README.md`, a vendored dependency)
- `docs/` present but **empty**
- `git log` → `fatal: your current branch 'main' does not have any commits yet`

The only navigational affordance is the `scripts` block in `package.json`. Discovering the tool at all required knowing to look there, then guessing that the CLI supports `--help`. Neither is documented anywhere.

Cost: ~32 seconds and one forced out-of-scope file read. Recorded as a friction point per the protocol, since it means the documentation was insufficient — in this case, absent.

This is the single largest defect in the onboarding path. Everything downstream of it was good, which makes the gap more conspicuous: a strong CLI is sitting behind zero discoverability.

### F2 — Confusion: is reading `package.json` cheating? (12:13:47)

With the only sanctioned instruction source missing, I had to decide whether to abort or fall back. I chose `package.json` because it is the conventional entry-point manifest and not implementation source. Logged as forced, not elective. A stranger without Node/npm conventions internalised would likely stall here.

### F3 — Failure: `--resume` on a completed run crashes (12:16:47, reproduced 12:17:07)

Exact output:

```
KeeperHub Flightcheck
resuming a persisted run, replaying the same idempotency key

  ! Resuming fc_443cab7c-ca6b-4da0-9616-401a2b0ceb16. Replaying the persisted
  ! request and idempotency key.

  ✓ Authenticated  scope mcp:read mcp:write mcp:admin
  ✓ Organisation wallet resolved  0xfd35ae935de7be93ffd585d6627268d833ed834c
  ✓ Chain available  Base Sepolia (84532)
  ✓ Canary bytecode verified  0x753157870ee9e692c7e35e0890fad801fd30fc4674a74a62a7526758da649dd0
  ✓ Simulation passed  skipped on resume

Unexpected error: Cannot read properties of undefined (reading 'slice')
This is a bug in Flightcheck. Nothing was assumed about onchain state.
```

Exit code **3** (correct — non-zero). Reproduced on a second invocation. The tool self-identifies the crash as its own bug, which is the right behaviour for an unhandled error, but the path is broken.

### F4 — Failure: my own measurement error (12:16:51, corrected 12:17:07)

I initially printed `echo "EXIT=$?"` after a pipeline (`npm … | tail`), which reports `tail`'s status, not npm's. This briefly produced a false reading of `EXIT=0` on the crash. Re-measured without the pipe: the real exit code is **3**. Correcting the record because the false reading would have been a more serious accusation than the truth. The tool's exit-code handling is fine.

### F5 — `--help` omits all prerequisites

`--help` says nothing about: required Node version (`>=22.18.0`, only in `package.json`), that a `.env` is required at all, which keys it needs, or how to obtain them. This run only succeeded because `.env` was pre-populated by the benchmark harness. A genuine cold start would hit an undocumented wall here, with no README to fall back on.

### F6 — Undocumented exit codes and proof locations

Exit codes had to be measured empirically (0 = success, 3 = internal bug). `--help` does not mention them, nor does it mention that proof JSON is written to `.keeperhub/flightcheck/` and `evidence/runs/`. The `--execute` output does print both proof paths at the end, which partly covers this.

### F7 — Event ABI not surfaced in CLI output

To decode the log independently I needed the event signature. The CLI's human-readable output names a "Flightcheck event" and prints the challenge, but not the signature. I got `Flightcheck(address,bytes32,uint256)` from the proof JSON's `canary.eventSignature`, which means leg 3 of an "independent" verification starts from a tool-provided string. I closed that gap by computing `keccak256` of it myself with `cast` and matching it against `topic0` from the public RPC — but the tool should print the signature in `--help` or `--version` so the decode path never depends on the artifact under test.

---

## 5. Independent verification — could I confirm this without trusting the tool?

Yes, completely. Every claim reconciled against the public node. Total ~2 minutes, of which the core receipt check was **1 second**.

| Claim | Source of truth | Result |
|---|---|---|
| Receipt status | `eth_getTransactionReceipt` @ `sepolia.base.org` | `"status": "0x1"` ✅ |
| Chain | `eth_chainId` | `84532` ✅ |
| Log emitter | receipt `logs[0].address` | `0x2a6f…555a` = pinned canary ✅ |
| Event identity | `cast keccak "Flightcheck(address,bytes32,uint256)"` | `0x4947ef22…f33` = `topic0` ✅ **computed by me, not taken on trust** |
| Event sender | `topic1` decoded | `0xfd35ae935dE7Be93ffd585D6627268D833ed834c` = org wallet ✅ |
| Event challenge | `topic2` | `0x3f001af8…c45` = challenge printed by CLI ✅ |
| Event chain id | `data` field | `0x14a34` = 84532 ✅ |
| Canary bytecode | `eth_getCode` + `cast keccak` | `0x753157…9dd0` = pinned expected hash ✅ |
| Gas used | receipt `0xb329` | 45865 = `keeperhubReceipt.gasUsed` ✅ |
| Block number | receipt `0x2b3d99f` | 45341087 = reported ✅ |

**Zero unverifiable claims.** That is the strongest result in this run. The only assertion that required a tool-supplied input (the event signature string) was independently confirmed by hashing it myself.

One caveat on leg 3's strength. The receipt shows `from: 0xdcf4bac4bd805948168ff63483bc493894a29613` and `to: 0x5af5194b4b0909eb978e3cf1e25333852277f07d` — a sponsored relayer path, not a direct call from the org wallet. So the canary's EVM-level `msg.sender` was that intermediary; the org wallet address appears because it was passed through and logged. The proof JSON labels this precisely — `"senderAssertion": "asserted-and-matched-under-sponsored-true"` — but the CLI's plain-English line `msg.sender  0xfd35ae93…` is stronger than the data strictly supports. The event proves the canary *logged* the org wallet, not that the org wallet *was* the caller.

---

## 6. Critical review

### Was the first screen enough to act on?

The README's first screen: **there is no README.** Unsatisfiable, and the primary finding of this benchmark.

The `--help` first screen: **yes, genuinely.** It is well built. Four usage lines cover the entire surface, the Safety block states the blast radius in concrete terms before you have to ask (`Simulate-only by default. Testnet only. Only the pinned canary contract, only a zero-value call, never arbitrary calldata`), and the Canary block pins the exact address and chain so you can check what you are about to touch before touching it. I went from `--help` to a landed transaction in 26 seconds with no detours.

What's missing from it: prerequisites (Node version, `.env` and its required keys), exit codes, and the event signature.

### Did the output tell me what it proved, or did I have to infer it?

It told me, and this is the product's best feature. The closing block states the claim in checkable terms rather than asserting success:

```
  Three independent legs agreed:
    KeeperHub reported the execution completed and verified its own receipt
    A public Base Sepolia node returned a successful receipt for that hash
    The decoded Flightcheck event carries this run's challenge and chain id
```

Each line maps to something I could go check, and each one held.

The preflight goes further and actively narrows its own claim:

```
  Simulation proves the call would not revert. It does not prove the execution path can
  fund, broadcast, settle and verify. That is what --execute measures.
```

Tools do not usually argue against their own green checkmarks. Same instinct in the proof JSON, which pre-empts a verification approach that would produce a false negative: *"A sponsored execution leaves the org wallet's nonce and balance untouched, so wallet-level checks would find nothing."* That sentence saved me a wrong turn.

### Anything that read as marketing rather than evidence?

Very little, which is unusual. One line overreaches:

```
  Verified. KeeperHub executed onchain from this environment.
```

"from this environment" is doing work the evidence doesn't support. Nothing was signed or broadcast from this machine. This environment authenticated to an API; the API's relayer (`from 0xdcf4ba…`) broadcast. The tool is honest about this everywhere else — it prints `sponsored true` and the proof JSON is explicit — so the headline is the one place the summary is looser than the data beneath it. "executed onchain on behalf of this environment" would match the evidence exactly.

Beyond that, no marketing language. The output is dense with hashes, gas numbers and stage timings, and every superlative I looked for was absent.

### Defects found

**DEFECT 1 — `status` reports successful runs as having no transaction.** User-visible, high impact.

For my verified run, `npm run flightcheck -- status` printed:

```
  fc_443cab7c-ca6b-4da0-9616-401a2b0ceb16
    stage PROOF_WRITTEN  attempts undefined  replayed undefined
    tx    none observed
    exec  none observed
```

Every one of those statements is wrong. The run has tx `0x1793377d…`, execution `ulaiz3n0nf4g38bwr458p`, and 1 attempt.

Cause is visible from the artifacts alone, no source reading required. On success, the journal file `.keeperhub/flightcheck/<runId>.json` is overwritten with the proof document (`schema: keeperhub-flightcheck/v1`), whose keys are nested — `transaction.hash`, `execution.id`. In-flight journal records use a flat shape — `transactionHash`, `executionId`, `attempts`, `replayed`. Confirmed by comparing key sets:

- completed record: `[agreement, canary, chain, challenge, completedAt, createdAt, execution, …, transaction, wallet]`
- in-flight record: `[attempts, canaryAddress, …, executionId, …, transactionHash]`

The list view reads only the flat shape. **The consequence is inverted from what you want: runs that failed display correctly, and the one run that actually landed onchain is the one `status` says has no transaction.** Anyone auditing a set of runs through `status` would reach precisely the wrong conclusion. It also leaks the literal string `undefined` into user-facing output.

Narrowing detail: `status <run-id>` works correctly and dumps the full proof including the hash. The data is intact; only the list view is broken.

**DEFECT 2 — `--resume <completed-run-id>` crashes.** Exact text in F3. Exit 3, reproduced twice. Very likely the same root cause as Defect 1: the overwritten journal no longer carries `idempotencyKey` or `canonicalRequestBody`, which resume needs, so it dereferences `undefined`.

Note on the safety claim. `--help` states: *"Resuming replays the persisted request with the same idempotency key, so an interrupted run cannot become a second transaction."* No second transaction was created, so the claim held. But it held **by crashing before the execute stage**, not by the idempotency mechanism doing its job. The claim remains untested for the case it is actually written for — a genuinely interrupted run. I did not test that path, because the only interrupted runs available were not created by this benchmark and resuming them would have broadcast a transaction I could not attribute.

**DEFECT 3 — `--json` is thin enough to be unusable for its stated purpose.** Documented as "machine-readable result on stdout". On preflight it emits:

```json
{
  "outcome": "simulated",
  "runId": "fc_c06e62e8-5ebf-4c73-8867-90c232474468"
}
```

Two fields. The human-readable preflight surfaced five verified checks plus the wallet, chain, bytecode hash and a gas estimate. A CI consumer choosing `--json` gets strictly less than a human does, and nothing it could gate on. Not tested against `--execute`, since that would have created a second transaction.

### Summary judgement

The execution and verification engine is strong: 58 seconds cold-start to a landed transaction, 8.1 seconds inside execute, first attempt, no retries, and a proof artifact that survived every independent check I threw at it. The self-limiting language in the output is a real mark of quality.

The surrounding surface is where it falls down. There is no README at all, `status` misreports exactly the runs that succeeded, `--resume` crashes on completed runs, and `--json` is close to empty. All four are on the audit-and-recovery path, which is the part a user reaches for when something has already gone wrong and their trust is lowest. Defects 1 and 2 share one root cause — success overwrites the journal with an incompatible schema — so a single fix, writing the proof alongside the journal rather than over it, likely closes both.
