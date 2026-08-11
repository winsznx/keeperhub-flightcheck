# KeeperHub Flightcheck — agent onboarding benchmark, treatment arm, clean re-run

Run date 2026-08-11. All timestamps UTC, captured with `date -u +%H:%M:%S` immediately before and
after each step. Repo under test: `/Users/mac/keeperhub-flightcheck`. Agent: Claude Opus 5,
autonomous, no human input during the run.

Ground rules honoured: primary instruction source was `README.md` plus `--help`. **Zero files
under `agent/src/` were opened.** **Zero files under `internal/` were opened.** `.env` contents
were never printed or copied.

---

## 1. Timeline

| timestamp | action | outcome |
|---|---|---|
| 12:27:16 | **T0.** `ls` repo root, open `README.md` | README read start |
| 12:27:30 | `npm run flightcheck` (preflight, per README) | passed in 8s, 5 stages green, nothing broadcast |
| 12:27:54 | `npm run flightcheck -- --json` (regression check 3) | 1306 bytes of JSON, 12 top-level keys |
| 12:28:12 | `npm run --silent flightcheck -- --json \| jq` | clean parse |
| 12:28:25 | `npm run flightcheck -- --json \| jq` (README's exact form) | **FAILED** — `jq: parse error: Invalid numeric literal at line 2, column 2` |
| 12:28:39 | `--help`, then `status` as a pre-execute baseline | help is complete; one pre-existing run listed (`fc_add459bf…`, not mine) |
| 12:28:57 | **`npm run flightcheck -- --execute`** | 11 stages green, first try, no retries |
| **12:29:04** | **T_first_tx** — block 45341528 mined | onchain timestamp read independently via `eth_getBlockByNumber`, not from the tool |
| 12:29:07 | execute returns | `Verified.` 9.8s total, exit 0 |
| 12:29:22 | `npm run flightcheck -- status` (regression check 1) | real tx hash + exec id, stage `PROOF_WRITTEN` |
| 12:29:42 | `curl https://sepolia.base.org` for the receipt + `cast keccak "Flightcheck(address,bytes32,uint256)"` | **legs 2 and 3 confirmed by me in ~1 second** |
| 12:30:05 | grep capsule for `receiptStatus` / `verified`, then read capsule structure | **leg 1 confirmed. T_verified.** |
| 12:30:31 | `eth_getLogs` filtered on canary + this run's challenge | `log_count=1` |
| 12:30:40 | `npm run flightcheck -- --resume fc_871f3a1c…` on the **completed** run (regression check 2) | no crash, exit 0, explicit replay banner, same hash |
| 12:31:05 | `eth_getLogs` again after resume | still `log_count=1` — no second transaction |
| 12:31:26 | Every README-linked path exists; independently re-verified the README's own canonical tx `0xb4098917…` | status `0x1`, topic0 matches, topic2 == the challenge in the README table |
| 12:31:46 | CLI error-path probes (`--resume` bad id / no id, `status` bad id, bogus flag) | two real defects found (D3, D4) |
| 12:32:12 | re-measured exit codes without a pipe (my first probe was invalid) | genuine errors exit 1 — no exit-code defect |
| 12:32:38 | `npm test` | **80 tests, 80 pass, 0 fail** — matches the README claim exactly |
| 12:33:08 | `cd contracts && forge build`, `jq … \| cast keccak` | `0x753157…49dd0` — reproducible-build claim holds |
| 12:33:19 | checked README's manifest claim against reality | **D1 found** — my verified run is absent from `evidence/manifest.json` |
| 12:33:36 | `package.json` scripts, all capsule outcomes, manifest contents | manifest regen requires undocumented `npm run evidence` |
| 12:33:53 | state file vs capsule for the pre-existing run | **D5 found** — stage disagreement |
| 12:34:10 | `eth_getBlockByNumber` for the exact block timestamp | T_first_tx pinned at 12:29:04 |
| 12:34:33 | `CLAIMS.md` read; failure-code count cross-check | **D2 found** — ledger says 38, generated doc and manifest say 39 |

---

## 2. Totals

| metric | value |
|---|---|
| **T0 → T_first_tx** | **1 min 48 s** (12:27:16 → 12:29:04) |
| **T0 → T_verified** | **2 min 49 s** (12:27:16 → 12:30:05) |
| Independent verification alone (legs 2+3, curl + `cast keccak`) | **~1 second** (12:29:42 → 12:29:43) |
| Independent verification incl. leg 1 capsule check | 23 s |
| Commands on the happy path (README → verified tx) | **2** (`npm run flightcheck`, then `npm run flightcheck -- --execute`). 1 if you skip preflight. |
| Total Bash tool invocations across the whole benchmark | 24 (≈70 discrete shell commands, the vast majority auditing rather than onboarding) |
| **Files I had to open to reach a verified tx** | **1** — `README.md` |
| Files opened in total (incl. audit) | 12 — listed in §6 |
| Files opened under `agent/src/` | **0** |
| Files opened under `internal/` | **0** |
| Failed attempts against the tool | **0** |
| Failed attempts total | 1 (a documented command piped to `jq`, see F1) + 2 of my own zsh measurement errors |
| Moments of confusion about what to do next | **0** on the happy path |
| **Transactions put onchain** | **1** — confirmed by `eth_getLogs` on the run's unique challenge, before and after resume |

---

## 3. Regression checks — all three defects are genuinely fixed

### Defect 1 — `status` after a successful `--execute`. **FIXED.**

```
  fc_871f3a1c-27db-4e7e-913e-51f78c662dcb
    stage PROOF_WRITTEN  attempts 1  replayed false
    tx    0x415c661ccf58a89e2e8a4a93048c40c4ed6d7675f6ab48b610c8f745f5c1b971
    exec  xua1gvv62zaydnuprvc2w
```

Real transaction hash, real execution id, correct terminal stage. No "none observed" anywhere.
`status <run-id>` additionally emits a full JSON record including `intendedOperation:
"ping(bytes32)"`, the canonical request body, and the challenge, with the idempotency key and body
hash redacted as `<redacted:RAW_64_HEX>`.

### Defect 2 — `--resume` on a COMPLETED run. **FIXED.** No unhandled error, exit code 0.

It replays and says so, before showing any green checks:

```
  ! KeeperHub replayed the stored response for this idempotency key. This
  ! outcome already happened; no second transaction was created.
```

It then re-runs settlement and verification against the same hash and finishes `Verified.` in 5.6s.
The message is sensible and, more importantly, correct: `eth_getLogs` on the run's challenge
returned `log_count=1` both before and after the resume. The capsule flipped to
`"replayed": true, "attempts": 2, "conflicts": 0` and `status` now shows `attempts 2  replayed true`.
It also correctly skips simulation (`✓ Simulation passed  skipped on resume`).

One wording nit, not a defect: the replay path still prints `✓ Execution created
xua1gvv62zaydnuprvc2w`. Nothing was created on that invocation. `Execution resolved` or
`Execution (replayed)` would be exact. The `!` banner two lines above already prevents any real
misreading.

### Defect 3 — `--json` preflight richness. **FIXED.** Not "a couple of fields": 12 top-level keys.

Contains everything the check asked for, verbatim from the run:

- `wallet` — `orgWallet`, `signerMode: "eoa"`
- `chain` — `chainId: 84532`, `name`, `isTestnet: true`
- `canary` — `expectedRuntimeBytecodeHash`, `observedRuntimeBytecodeHash`, `match: true`
- `challenge` — `0x14e00a53…`
- `simulation` — `passed`, `wouldRevert`, `from`, `to`, `gasEstimate`
- plus `schema`, `outcome`, `runId`, `stageReached`, `broadcast: false`, `note`, `timingsMs`
  (per-stage breakdown)

---

## 4. Remaining defects — six, in severity order

### D1. The README states a manifest guarantee that is false for a fresh run. *(real, user-visible)*

README lines 37-39:

> "every verified run is recorded in `evidence/runs/` and summarised in
> [`evidence/manifest.json`](evidence/manifest.json)."

My run is verified (`"outcome": "verified"`) and is in `evidence/runs/`. It is **not** in the
manifest.

```
evidence/runs/  → 5 capsules, all "outcome": "verified"
manifest.runs   → total 4, and no fc_871f3a1c-27db-4e7e-913e-51f78c662dcb
manifest.generatedAt → 2026-08-11T12:28:04.878Z   (53 seconds before my --execute started)
```

The manifest is produced by `npm run evidence`, which exists in `package.json` but appears
**nowhere in the README** — the `## Commands` section lists five commands and this is not one of
them. So the stated invariant only holds if you run an undocumented script.

This also breaks the README's own strongest meta-claim, line 242: *"Nothing in this README is
allowed to exceed that ledger."* I grepped `CLAIMS.md` for "manifest" — there is no manifest claim
in the ledger at all. That one sentence exceeds it.

Fix: either make `--execute` append to the manifest on success, or soften to "…and summarised in
`evidence/manifest.json`, regenerated with `npm run evidence`", and add that command to the list.

### D2. `CLAIMS.md` says 38 failure codes. There are 39. *(real, and self-contradicting)*

CLAIMS.md #18: "38 distinct failure codes, each with a stage and a remediation".

```
docs/failure-codes.md  → 39 distinct FC_ codes  (file header: "Generated from agent/src/errors.ts by npm run evidence. Do not edit by hand.")
evidence/manifest.json → "failureCodes": 39
```

The ledger disagrees with the generated artifact it cites, and with the manifest generated 24
minutes before I read it. Trivial to fix, but this is precisely the error the ledger exists to
prevent, and it's the first number in it I checked.

### D3. Unknown flags are silently accepted and run a preflight. *(real)*

```
$ npm run --silent flightcheck -- --frobnicate
  ... runs a full preflight ...   EXIT=0

$ npm run --silent flightcheck -- --exec      # the most plausible typo for --execute
  ... runs a full preflight ...   EXIT=0
```

No "unknown flag" error, no warning, exit 0. Mitigating: the banner says `preflight only, nothing
will be broadcast` and the footer says `Re-run with --execute`, so the tool is honest about what it
actually did. Still, a CLI this careful about everything else should reject an argument it doesn't
recognise.

### D4. `--resume` with no run id silently degrades to a preflight. *(real, mildly misleading)*

```
$ npm run --silent flightcheck -- --resume
KeeperHub Flightcheck
preflight only, nothing will be broadcast
  ... 5 green checks ...
  Preflight passed. Nothing was broadcast.
EXIT=0
```

A user who forgets the id gets a green "Preflight passed" and exit 0. It never says "you didn't
give me a run id". Given that `FC_RESUME_NOT_FOUND` already exists and fires correctly for a bad
id, a missing id should get the same treatment.

### D5. `status` can report a stale stage while the capsule for the same run says verified. *(observed on a pre-existing run, not reproduced on mine)*

For the run that was already in the repo when I arrived, `fc_add459bf-a00e-4d8d-b46f-94506247b0f6`:

```
.keeperhub/flightcheck/fc_add459bf….json  → "stageReached": "EXECUTION_CREATED",  attempts 1
evidence/runs/fc_add459bf….json           → "outcome": "verified", "stageReached": "PROOF_WRITTEN"
```

`status` reads the first, so it under-reports a run that the capsule says reached verification.
My own run wrote `PROOF_WRITTEN` to **both** files, so the final state write does normally happen —
this is not the same bug as regression check 1. I could not diagnose the cause without opening
`agent/src/`, which I deliberately did not do. Reporting the observation only.

### D6. The documented `--json` command cannot be piped. *(doc friction)*

README line 175: `npm run flightcheck -- --json  # machine-readable capsule on stdout`.

```
$ npm run flightcheck -- --json | jq -r '.schema'
jq: parse error: Invalid numeric literal at line 2, column 2
```

npm's own `> keeperhub-flightcheck@0.1.0 flightcheck` banner is on stdout. `npm run --silent` fixes
it and parses cleanly. If the README advertises stdout as machine-readable, it should print the
`--silent` form.

---

## 5. Independent verification — done without trusting the tool

Timed at 12:29:42 → 12:29:43. **Roughly one second for both non-KeeperHub legs.**

**Leg 2 — public node.** Raw `curl` against `https://sepolia.base.org`, no library, no tool code:

```
status=0x1  blockNumber=0x2b3db58  from=0xdcf4bac4bd805948168ff63483bc493894a29613
to=0x5af5194b4b0909eb978e3cf1e25333852277f07d  logs=1
```

`0x2b3db58` = 45341528, matching the block the tool reported. Note `from` is a relayer and `to` is
a router, exactly as the README's "why verification goes by hash not wallet state" section warns.
The org wallet appears nowhere in the receipt envelope. Any wallet-nonce or txlist verifier would
have concluded nothing happened.

**Leg 3 — decoded event, computed by me.**

```
$ cast keccak "Flightcheck(address,bytes32,uint256)"
0x4947ef22330e8e81cdedf82c33d366e9c942511f5edf79140686b33af9de7f33

log.topics[0] = 0x4947ef22330e8e81cdedf82c33d366e9c942511f5edf79140686b33af9de7f33   ✓ identical
log.address   = 0x2a6fc8182bf9928ef7517da980dc79e8107c555a                          ✓ the pinned canary
log.topics[1] = 0x000…fd35ae935de7be93ffd585d6627268d833ed834c                      ✓ the org wallet
log.topics[2] = 0xc946c8273a186cd7cc70521e3e607dacad5152aad8be97f043a114a4e870b375  ✓ == this run's challenge
log.data      = 0x…014a34 = 84532                                                   ✓ chain id
```

The challenge in `topics[2]` is byte-identical to the one the CLI printed before it sent anything,
which is what makes this a proof of *this* run rather than a proof that some transaction exists.

**Leg 1 — KeeperHub's own report**, from the capsule at
`evidence/runs/fc_871f3a1c-27db-4e7e-913e-51f78c662dcb.json`:

```json
"keeperhubReceipt": { "verified": true, "receiptStatus": "success", "blockNumber": 45341528, "gasUsed": "45877" }
```

Honest caveat: leg 1 is by definition "what KeeperHub reports", and I read it from the tool's
capsule rather than calling the KeeperHub status endpoint myself. Legs 2 and 3 are the ones that
don't require trusting anything in this repo, and I reproduced both from scratch.

**Exactly-once, counted from the chain, not from bookkeeping:**

```
eth_getLogs (canary address + topic0 + this challenge)
  before resume: log_count=1  hashes=0x415c661ccf58a89e2e8a4a93048c40c4ed6d7675f6ab48b610c8f745f5c1b971
  after  resume: log_count=1  hashes=0x415c661ccf58a89e2e8a4a93048c40c4ed6d7675f6ab48b610c8f745f5c1b971
```

**Other README claims I checked rather than took:**

| claim | result |
|---|---|
| The README's own canonical tx `0xb4098917…d452dc` | fetched it myself: `status=0x1`, `topic0` matches, `topics[2]` == `0x61b3cc48…3fb4e2`, the exact challenge in the README table |
| "80 tests, no network required" | `tests 80 / pass 80 / fail 0 / suites 16` |
| "The build is byte-reproducible" (README's own two-line recipe) | `forge build` + `jq … \| cast keccak` → `0x753157870ee9e692c7e35e0890fad801fd30fc4674a74a62a7526758da649dd0`, identical to the pin |
| "zero runtime dependencies" | `package.json` → `"dependencies": {}`, dev-only `typescript` + `@types/node` |
| every README-linked path exists | 10/10 present, including all four `docs/` files |
| secrets never written to a capsule | idempotency key and body hash appear as `<redacted:RAW_64_HEX>`; no `kh_` string anywhere in the capsule |

---

## 6. Artifacts

| | |
|---|---|
| **transaction** | `0x415c661ccf58a89e2e8a4a93048c40c4ed6d7675f6ab48b610c8f745f5c1b971` |
| **execution id** | `xua1gvv62zaydnuprvc2w` |
| run id | `fc_871f3a1c-27db-4e7e-913e-51f78c662dcb` |
| challenge | `0xc946c8273a186cd7cc70521e3e607dacad5152aad8be97f043a114a4e870b375` |
| block | 45341528 on Base Sepolia (84532), mined 12:29:04 UTC |
| sponsored | `true`; `msg.sender` == org wallet, `senderAssertion: "asserted-and-matched-under-sponsored-true"` |
| explorer | https://sepolia.basescan.org/tx/0x415c661ccf58a89e2e8a4a93048c40c4ed6d7675f6ab48b610c8f745f5c1b971 |
| capsule | `/Users/mac/keeperhub-flightcheck/evidence/runs/fc_871f3a1c-27db-4e7e-913e-51f78c662dcb.json` |

Files opened (12): `README.md`; `CLAIMS.md`; `evidence/runs/fc_871f3a1c….json`;
`evidence/runs/fc_add459bf….json`; `evidence/manifest.json`; `docs/failure-codes.md`;
`package.json`; `.keeperhub/flightcheck/fc_871f3a1c….json`;
`.keeperhub/flightcheck/fc_add459bf….json`;
`contracts/out/KeeperHubFlightcheckCanary.sol/KeeperHubFlightcheckCanary.json`; and two of my own
scratch files (`preflight.json`, `receipt.json`). **Only the first was needed to reach a verified
transaction.**

---

## 7. Critical review

### Was the README's first screen enough to act on? No, but only just barely.

The first ~40 lines are: title, a two-line claim, a 17-line sample terminal transcript, and a table
of a reference transaction. That is a screenful of *"here is proof this worked for us"* before any
*"here is how you run it."* `Run it yourself` doesn't start until line 54.

Missing from the first screen and needed to act:

- **Node 22.18+.** This is the only hard prerequisite and it's invisible until line 56. On a
  machine with Node 20 a reader would hit a native-TS failure with no idea it was a version issue.
- **That you need a `kh_` organisation API key**, and that it's the *organisation* key, not the
  user key. The README handles this beautifully later (the `FC_ENV_WRONG_KEY_TYPE` example is one
  of the best things in the doc) but a first-screen reader doesn't know a key is needed at all.
- **That there is no `npm install`.** Stated at line 57, and it's a genuinely surprising fact worth
  putting up top.
- **That it takes about 10 seconds.** My run: 9.8s.

A reader *can* squint at line 9 of the sample transcript and see `npm run flightcheck -- --execute`,
so the fast path is technically inferrable. But inferring the entry command from a screenshot isn't
the same as being told.

Concrete fix: move `## Run it yourself` above `## A real transaction it produced`, and put the
three prerequisites in the fenced block itself as comments. The proof belongs second — a stranger
who just cloned the repo wants to produce their own fact, not read about yours.

Also missing from `## Commands` entirely: `npm run evidence` (which D1 shows is load-bearing),
`npm run typecheck`, `npm run test:live`.

### Anything that reads as marketing rather than evidence?

Very little. This is a document where nearly every sentence has a number, a hash, or a file path
attached. The `## Limitations` section, five items, each naming a specific unmeasured path, is the
opposite of marketing and it's the most credible thing in the repo. Naming
`recorded-not-asserted` for the unmeasured sender path is the kind of precision most projects would
have quietly rounded up to a green check.

The candidates, quoted:

- Line 6, **"Onboarding now ends with an onchain fact."** A slogan. It earns itself — it is
  literally what happened, in 1 minute 48 seconds — but it is a slogan.
- Line 141, **"This is the part worth reading the code for."** Editorial. Tells the reader what to
  find interesting. Harmless, but it's the one sentence that is pure voice with no fact in it.
- Line 4 / line 77, **"stops at the exact stage that fails"** and **"ends with a transaction hash
  or an exact diagnosis."** I never hit a failure path, so I cannot confirm this. The 39-code
  taxonomy, the `broadcast possible` column, and the test that asserts *"nothing before the
  broadcast claims a transaction might exist"* make it very plausible. But "exact" is unverified
  by me and the README asserts it twice in the first 80 lines.
- Line 96, **"That is what makes the result independent rather than self-reported."** Earned. I
  reproduced both independent legs from scratch in about a second with `curl` and `cast`.
- Line 242, **"Nothing in this README is allowed to exceed that ledger."** Strong, and D1 is a
  counterexample. Since this claim is the repo's stated quality bar, one counterexample matters
  more than its size suggests.

### CLI output

Better than the README. Every line pairs a claim with the value that backs it, so nothing has to be
taken on faith: `✓ Canary bytecode verified 0x753157…`, `✓ Receipt confirmed block 45341528`. The
best line in the whole tool is in the preflight footer, and it argues *against* the tool's own
output:

> `Simulation proves the call would not revert. It does not prove the execution path can fund,`
> `broadcast, settle and verify. That is what --execute measures.`

A CLI that tells you its green checks don't mean what you might think they mean has earned the rest
of its green checks.

Two nits. `✓ Execution created <id>` is printed on the replay path where nothing was created (see
regression check 2). And the three-leg summary block is prose asserting that the legs agreed
rather than showing the three values that agreed — printing `0x1` from the public node and the
computed `topic0` next to the expected one would let a reader verify by eye instead of by trust,
which is otherwise this tool's whole philosophy.

### Bottom line

Two commands and one file to a verified onchain transaction, first try, zero retries, zero
confusion, in under three minutes end to end. All three previously-reported defects are genuinely
fixed. The independent verification path is real and fast — one second to confirm the two legs that
don't trust KeeperHub. Six remaining defects, all minor: one false README invariant (D1), one
off-by-one in the claims ledger (D2), two CLI argument-handling gaps (D3, D4), one state/capsule
inconsistency I could only observe (D5), and one unpipeable documented command (D6). None of them
touch the proof path.
