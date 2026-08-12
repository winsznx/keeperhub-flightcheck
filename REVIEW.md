# REVIEW — KeeperHub Flightcheck

> **Superseded in part.** This documents the build up to 2026-08-11 14:00Z. Three things came
> after it: the Flightcheck Bootstrap extension (guided setup, KeeperHub-first gas policy, Base
> Sepolia gas fallback), the clean-room reproduction on an independent KeeperHub account, and the
> support capsule with KeeperHub request correlation. Current numbers, the extension's own
> adversarial audit, and the updated DoraHacks fields are in
> [SUBMISSION-DELTA.md](SUBMISSION-DELTA.md), whose final section is the state as of 2026-08-12.
> Everything below about the canonical transaction, the state machine, the response-loss proof
> and the benchmark is unchanged.
>
> One claim below was **withdrawn** after this was written. Section 4 and the proof page said a
> sponsored execution leaves the organisation wallet's nonce untouched. The clean-room wallet
> moved from nonce 0 to 1 installing its EIP-7702 delegation, so the narrower and correct
> statement is that the nonce is not a reliable detector of sponsored execution in either
> direction. `CLAIMS.md` row 59 carries it.

For Tim, before anything is submitted anywhere. Nothing has been submitted to DoraHacks, posted,
or announced.

Built 2026-08-10 to 2026-08-11. Deadline 2026-08-13 12:00 UTC+2.

---

## 1. What it is

An execution conformance check for KeeperHub onboarding. One command drives the documented
simulate → idempotent execute → reconcile → verify sequence against a pinned contract that moves
nothing, and ends with either a real Base Sepolia transaction plus a machine-readable proof
capsule, or a stop at the exact stage that failed with the remediation for it.

`kh doctor` says your environment looks healthy. Flightcheck proves KeeperHub actually executed,
settled and verified a transaction from it.

**Onboarding now ends with an onchain fact.**

## 2. Architecture

```
fresh KeeperHub environment
        │
   preflight + 12-stage state machine ──── failure ──► exact stage + remediation (39 codes)
        │
   simulate  (branches on wouldRevert, not on the HTTP status code)
        │
   persist request bytes + derived idempotency key, fsync  ◄── before anything is sent
        │
   KeeperHub execution
        │
   reconcile ──── response lost ──► replay the persisted request, same key
        │
   independent RPC receipt      ◄── not KeeperHub
        │
   decoded canary event         ◄── not KeeperHub
        │
   proof capsule ──► CLI output, evidence/runs/, manifest, proof site
```

Two of the twelve stages never ask KeeperHub anything: `CANARY_VERIFIED` hashes the deployed
bytecode against a pin, `EVENT_VERIFIED` decodes the log. That is what makes a result independent
rather than self-reported.

## 3. Live URLs

| what | where |
|---|---|
| repository | https://github.com/winsznx/keeperhub-flightcheck |
| proof page | https://keeperhub-flightcheck.timjosh507.workers.dev |
| canonical transaction | https://sepolia.basescan.org/tx/0xb4098917d12030a249e9376217d765b715362c744dd23e9b03e0213253d452dc |
| canary contract | https://sepolia.basescan.org/address/0x2a6fc8182bf9928ef7517da980dc79e8107c555a |
| clean-room transaction | https://sepolia.basescan.org/tx/0x642002f79b9a6ae4570c84f6b8d3c0a12a9f001304a7921e48f5eb7149aff852 |
| gas fallback service | https://keeperhub-flightcheck-faucet.timjosh507.workers.dev |
| upstream, keeperhub | [#2008](https://github.com/KeeperHub/keeperhub/pull/2008), [#2009](https://github.com/KeeperHub/keeperhub/pull/2009), [#2039](https://github.com/KeeperHub/keeperhub/pull/2039) |
| upstream, cli | [#99](https://github.com/KeeperHub/cli/pull/99), [#100](https://github.com/KeeperHub/cli/pull/100) |
| superseded | #2005 and #2006, closed by me, unmerged, never reviewed |

Five open, none merged. #2008 and #2009 were reviewed on 2026-08-11 with changes requested, and
every point was addressed on 2026-08-12; see the final section of
[SUBMISSION-DELTA.md](SUBMISSION-DELTA.md).

## 4. Canonical evidence

```
transaction   0xb4098917d12030a249e9376217d765b715362c744dd23e9b03e0213253d452dc
execution     exnn6k0y1ojnnvb8sa1fu
block         45339897, Base Sepolia (84532)
challenge     0x61b3cc48dd907bdfff36b62bf6b7faddc5adcaede477797ca0a035114a3fb4e2
canary        0x2A6FC8182Bf9928Ef7517dA980dC79e8107c555A, source-verified
bytecode pin  0x753157870ee9e692c7e35e0890fad801fd30fc4674a74a62a7526758da649dd0
sponsored     true
```

5 verified runs recorded in `evidence/runs/`. Of those, 4 are cold end-to-end runs: fastest 8.1s,
slowest 10.5s. The fifth is a resumed run and is excluded from timing, since it skips simulation
and re-reads an already-mined transaction. An audit caught that contamination.

## 5. Benchmark

Agent onboarding benchmark, not a human study, and labelled that way everywhere.

| arm | given | time to verified | commands | docs opened | failed attempts | transactions |
|---|---|---:|---:|---:|---:|---:|
| Baseline | public KeeperHub docs only | 5m 25s | 15 | 11 | 6 | 1 |
| Flightcheck | the README only | 2m 49s | 2 | 1 | 0 | 1 |
| Recovery | an injected response loss | one `--resume` | 1 | 0 | 1 by design | 1 |

Both arms started from the same prerequisite state and had to reach the same finish line: three
agreeing proof legs, verified by the agent itself rather than taken from tool output.

Honest caveats, also in `evidence/benchmark/benchmark.json`: one run per arm, both agents were
capable, and the baseline agent chose its own contract call while the treatment arm's target was
fixed. The baseline agent performed unusually well, which makes the gap conservative rather than
flattering.

## 6. Failure cases demonstrated

39 failure codes, each with a stage, a remediation, and a `broadcastPossible` flag that decides
whether the correct response is resume or restart. Generated reference in `docs/failure-codes.md`.

Exercised through the real state machine against captured response shapes: wrong key type, bad
auth, unresolved wallet, unconfigured wallet, unsupported chain, disabled chain, non-testnet
chain, no code at the canary, bytecode mismatch, RPC on the wrong chain, simulation revert,
insufficient balance, insufficient scope, idempotency conflict with and without an original
execution id, in-progress conflict, replayed response, transport loss with and without recovery,
unconfirmed status, unknown future status, failed-with-timeout downgrade, reverted receipt,
missing receipt, missing event, wrong emitter, challenge mismatch, chain id mismatch, hash
disagreement, sender mismatch.

Reproduced against the live API rather than fixtures: the transport-loss recovery, the
idempotent replay, gas sponsorship, the 202 with no transaction hash.

## 7. The response-loss proof

The one worth showing.

```
first invocation stopped without an execution id     true
broadcast requests actually sent to KeeperHub        2
recovery replayed the stored response                true
resumed run reached verified                         true
transactions onchain carrying this challenge         1
recovered hash is that transaction                   true

PASS. Two broadcast attempts, one transaction.
```

No mocks in the proof path. The transport performs the real HTTP request, reads and discards the
real response, then throws. The count comes from `eth_getLogs` filtered to the canary and the
run's unique challenge topic, so it is the chain's count and not our bookkeeping. Full log in
`evidence/recovery/`.

## 8. Upstream

**Current status, checked 2026-08-12.** Five PRs open, none merged, and five is the ceiling. Two
earlier PRs closed and unmerged.

| PR | state | merged | what |
|---|---|---|---|
| [keeperhub #2008](https://github.com/KeeperHub/keeperhub/pull/2008) | open, review addressed | no | `unconfirmed` missing from the Direct Execution status list. Review requested changes; the coverage artifact was regenerated, the same gap was fixed on the workflow-runs page, `system_error` was added after confirming it too was missing, and both pages now derive terminality from `X-Poll-Interval-Hint` |
| [keeperhub #2009](https://github.com/KeeperHub/keeperhub/pull/2009) | open, review addressed | no | OpenAPI described as the REST schema when it contains no core REST path. The reviewer caught that the replacement named SIWX as a payment scheme and omitted MPP; rewritten against the live document |
| [keeperhub #2039](https://github.com/KeeperHub/keeperhub/pull/2039) | open, mergeable | no | the Turnkey page called EOA funding required for any broadcasting workflow, contradicting its own sponsorship paragraph and the gas page it links to |
| [cli #99](https://github.com/KeeperHub/cli/pull/99) | open, mergeable | no | `--wait` treated a `202 completed` with no transaction hash as terminal, and `X-Poll-Interval-Hint` was discarded for a hardcoded ticker |
| [cli #100](https://github.com/KeeperHub/cli/pull/100) | open, mergeable | no | `--with-token` left the terminal echoing, so an organisation key was typed in plaintext and stayed in scrollback |
| #2005 | closed | no | superseded by #2008 |
| #2006 | closed | no | superseded by #2009 |

**The two reviews are the most useful thing that happened upstream.** Both were specific, both
were right, and one of them caught me replacing a false claim with a different false claim: #2009
originally said the OpenAPI document covers "x402/SIWX payment schemes", and SIWX is a CAIP-122
identity proof, not a payment scheme, while MPP, the one that would actually settle a call, was
missing. Verified against the live document before rewriting: 121 operations, 78 paid, every one
declaring both x402 and mpp, and zero carrying a per-operation `security` array.

**Why #2005 and #2006 are closed, since a closed PR with no maintainer comment looks like a
rejection.** It was not. I closed them. They were opened with a git identity not linked to your
GitHub account, and rewriting the authorship detached the branches from `staging`, so GitHub
would neither reopen them nor accept a new PR from the same branches. Both were closed at the
same timestamp because both branches were force-pushed in one command. No maintainer reviewed,
commented on, or rejected either. Both carry an explanatory comment from me.

If a maintainer later closes #2008 or #2009 without comment, that is a different situation and
worth asking about in the builder channel. Nothing so far indicates it.

**#2008 is the one that matters.** It is the only finding with an onchain consequence: a client
written against the endpoint reference sees four states, and both plausible reactions to a fifth
are wrong. Failing reports a false failure for a settling transaction; retrying with a fresh key
can duplicate one.

**I did not open the `kh flightcheck` Go PR your brief named as primary.** Reasoning is in
`internal/decision-log.md`: writing a command that correctly reuses the CLI's `internal/http`,
`internal/auth`, `internal/config` and `internal/output` means matching a codebase I only
enumerated, and a half-understood PR against an execution CLI costs a maintainer more than it
gives them. The standalone artifact already is that command.

What did go into the Go CLI, later, were two narrow correctness fixes rather than a feature: #99
and #100. Both are places where the official client diverged from KeeperHub's own documented safe
execution contract, both were found by running the reference implementation against the live API,
and each behavioural test was confirmed to fail against the old code before the fix went in.

**Nothing further will be opened.** A sixth PR needs a new live reproducible bug, no overlapping
work, a narrowly maintainable fix, and tests that prove the old behaviour fails, or a maintainer
asking for it. `kh doctor`'s wallet message was a candidate and was dropped for exactly this
reason: it could not be reproduced, and the probe says so rather than inferring
(`evidence/probes/doctor-wallet-provisioning.md`).

## 9. Every public claim

*Updated 2026-08-12.* `CLAIMS.md` holds 79 rows, each mapped to evidence and a proof level:
onchain, live-api, measured, automated, fixture, observed, or withdrawn. The README is not
allowed to exceed it.

Two claims have been withdrawn, and both are published as withdrawals rather than deleted.

`llms.txt` omitting the onboarding path was true when measured on Aug 10 and had been fixed
upstream before publication. It is struck through with both measurements recorded.

The nonce claim is the more embarrassing one, because it was ours rather than a moving target.
Every capsule, the proof page and three documents said a sponsored execution leaves the
organisation wallet's nonce untouched. The clean-room wallet went from nonce 0 to 1 installing
its EIP-7702 delegation. Row 59 now says the nonce is not a reliable detector in either
direction, and deliberately claims no general pattern beyond the two wallets measured. Capsules
written before the correction keep the old sentence, with the correction beside them in
`evidence/manifest-notes.md`.

## 10. Limitations, stated in the README next to the claims they qualify

- Direct EOA path only. Under Safe routing KeeperHub's own funding diagnostic describes the outer
  EOA rather than the spending address, so Flightcheck does not model it.
- Testnet only. Base Sepolia. No mainnet path.
- Gas sponsorship is reported as observed on each run, never promised.
- The `msg.sender == org wallet` assertion applies only on the sponsored path, because that is
  the path measured. The non-sponsored path is recorded as `recorded-not-asserted`.
- One canary, one chain.
- The benchmark is agents, one run per arm.

## 11. Unresolved risks

- **The hand-written keccak256** in `agent/src/rpc.ts` is the highest-risk code in the repo. It is
  tested against known vectors, the rate boundary, the pinned event topic and the `ping` selector,
  and it reproduces the real deployed bytecode hash. It is still 60 lines of hand-rolled crypto
  where a library would do, and the reason it exists is the zero-dependency property.
- **Both credentials you pasted are in this conversation's transcript.** The `kh_` organisation
  key and the Etherscan key both need rotating. Neither appears in the repo, the site, or git
  history, verified by scanning every staged file against the live values including 8-character
  prefixes. That scan caught one real leak: I had used the key's actual prefix as an illustrative
  example in two files. Fixed before the first commit.
- **The deployer wallet** `0xE6b01781868Df2c1664F659476245175525Ae914` still holds about 0.45
  Base Sepolia ETH. Throwaway key, drain whenever.
- One capsule, the Phase 1 one, was hand-written by a script before the CLI existed, so it has no
  timing data. Every other capsule was produced by the tool.

## 12. Security audit result

Full captured run in `evidence/final-gate-run.txt`. Eight gates, all passing:

```
[1] typecheck strict                        PASS
[2] tests                                   84/84
[3] contract tests                          5/5
[4] source == pin == chain bytecode         PASS
[5] 0 runtime deps, 0 vulnerabilities       PASS
[6] 55 tracked files vs 3 live credentials  no match, incl. 8-char prefixes
[7] git history                             no credential in any commit
[8] withdrawn finding absent from README, site and docs
[9] live site serves the corrected build
```

- 0 runtime dependencies, `npm audit` clean.
- No live credential or 8+ character prefix in any tracked file, verified programmatically.
- No credential anywhere in git history.
- `internal/`, `.env` and `.keeperhub/` absent from the published repo, verified from a fresh
  clone.
- The published proof page contains no credential-shaped value.
- Redaction is enforced by a test that builds a capsule with a registered key and asserts
  `findLeaks` returns nothing.

## 13. Diff statistics

*Recounted 2026-08-12.* 89 tracked files. 8,866 lines of TypeScript, 150 of Solidity, 3,875 of
markdown, 29 evidence files. 142 tests across 27 suites, all passing, no network required, from a
clean clone with no `npm install`, re-verified from a fresh clone of the published repository.

## 14. DoraHacks submission draft

> **Superseded.** Paste from `SUBMISSION-DELTA.md` instead: sections 1–5 for the current body,
> then section 11 for everything after 2026-08-11. The draft below is kept because it is the
> version the benchmark numbers were measured against, and because one line in it is now known to
> be wrong: "a sponsored execution leaves the org wallet's explorer page empty" is true, but the
> nonce claim that used to sit beside it was withdrawn.

> **KeeperHub Flightcheck — onboarding now ends with an onchain fact**
>
> `kh doctor` tells a new builder their environment looks healthy. It cannot tell them whether
> KeeperHub can actually execute. Flightcheck closes that gap: one command drives the documented
> simulate → idempotent execute → reconcile → verify sequence against a pinned contract that
> moves nothing, and ends with a real Base Sepolia transaction plus a machine-readable proof
> capsule, or a stop at the exact stage that failed.
>
> A run is verified only when three things agree: KeeperHub's execution record, a public Base
> Sepolia receipt, and a decoded event carrying the challenge generated before the request was
> sent. Two of the twelve stages never ask KeeperHub anything.
>
> Building it surfaced things that only appear once you execute: the `/contract-call` 202 carries
> no transaction hash even when status is already `completed`; `unconfirmed` is a live execution
> state missing from the status reference, which is a documentation gap with an onchain
> consequence; a simulation passes while the payer holds zero balance; and a sponsored execution
> leaves the org wallet's explorer page empty, so the obvious way to verify your first transaction
> returns the wrong answer.
>
> The reliability demo is the part worth watching. Kill the response after KeeperHub has accepted
> the request, resume, and exactly one transaction exists on chain, counted from chain logs
> rather than from our own bookkeeping.
>
> Measured: an agent given only public docs reached a verified transaction in 5m25s across 15
> commands with 6 failed attempts. Given only this README, 2m49s across 2 commands with none.
>
> Transaction: 0xb4098917d12030a249e9376217d765b715362c744dd23e9b03e0213253d452dc
> Execution: exnn6k0y1ojnnvb8sa1fu
> Repo: https://github.com/winsznx/keeperhub-flightcheck
> Proof page: https://keeperhub-flightcheck.timjosh507.workers.dev
> Upstream: KeeperHub/keeperhub#2008 and #2009, both open and unmerged

## 15. Demo video shot list

Target 2:15. Must make sense with the sound off, so every claim appears as text on screen.

| time | shot | on screen |
|---|---|---|
| 0:00 | fresh terminal, `kh doctor` equivalent | "configuration looks healthy" |
| 0:12 | cut to the gap | "healthy is not the same as: it executed" |
| 0:22 | `npm run flightcheck` | preflight, five green stages, nothing broadcast |
| 0:38 | highlight the preflight's own caveat line | "simulation does not prove it can fund, broadcast, settle and verify" |
| 0:50 | `npm run flightcheck -- --execute` | stages tick through to PROOF_WRITTEN |
| 1:05 | freeze on the result block | execution id, tx hash, block, challenge, sponsored true |
| 1:15 | split screen: Basescan tx, and the org wallet's empty tx list | "the wallet page shows nothing. sponsored execution" |
| 1:28 | `cat evidence/runs/*.json | jq .agreement` | all three legs true |
| 1:38 | run the fault injection | "response discarded after KeeperHub accepted it" |
| 1:50 | `--resume` | "replayed the stored response, no second transaction" |
| 2:00 | `eth_getLogs` count for the challenge | **1** |
| 2:08 | the two open upstream PRs | #2008, #2009 |
| 2:12 | close | "onboarding now ends with an onchain fact" |

The fault-recovery segment is mandatory and is the differentiator. Do not cut it for time.

**Two shots added 2026-08-12**, inserted after 2:00 and pushing the close to about 2:35. Full
wording in `SUBMISSION-DELTA.md` section 11e.

| time | shot | on screen |
|---|---|---|
| +0:14 | `support <run-id>` on the run that stopped, showing the request-id table | "a failed run becomes something safe to send. Secrets included: none" |
| +0:08 | the clean-room section of the proof page | "reproduced on an account that isn't ours" |

Also update the 2:08 card: five PRs now, not two.

## 16. Two-minute judge verification path

1. Open the proof page. Every figure on it is generated from `evidence/manifest.json`.
2. Copy the transaction hash, paste into `curl https://sepolia.base.org` with
   `eth_getTransactionReceipt`. Status is `0x1`.
3. Check the log: emitter is the canary, `topics[0]` is
   `keccak256("Flightcheck(address,bytes32,uint256)")`, `topics[2]` is the challenge printed in
   the capsule.
4. `cast code <canary> | cast keccak` equals the pinned hash in `agent/src/config.ts`.
5. `cd contracts && forge build` regenerates that same hash from source.
6. Repeat steps 2 and 3 with the clean-room hash
   `0x642002f79b9a6ae4570c84f6b8d3c0a12a9f001304a7921e48f5eb7149aff852`. Same canary, same event,
   different organisation wallet, on an account with no relationship to ours.

Nothing in that path requires trusting the repo, the page, or KeeperHub.

Every step of it was re-run on 2026-08-12 as part of the final evidence sync, along with a
secret scan over every tracked file, a scan of every blob in git history, a check that neither
canonical transaction carries anything credential-shaped, and a fresh clone of the published
repository running the whole suite with no install. The two published digests that look
secret-shaped, an idempotency key and a canonical-body hash, were recomputed from public inputs
to demonstrate they carry nothing.

## 17. What you must do before submitting

*Updated 2026-08-12. Item 3 is resolved: the Go work shipped as cli #99 and #100.*

1. **Rotate four credentials.** Two `kh_` organisation keys, the Etherscan key, and the deployer
   private key. All were pasted into an agent session. The faucet treasury key was never exposed
   and does not need rotating.
2. **Drain the deployer wallet** `0xE6b01781868Df2c1664F659476245175525Ae914`, roughly 0.4999
   Base Sepolia ETH. Testnet funds, so this is tidiness rather than urgency.
3. **Record the demo video.** Shot list in section 15, plus the two shots in `SUBMISSION-DELTA.md`
   section 11e. This is the one deliverable I cannot produce.
4. **Submit on DoraHacks** at dorahacks.io/hackathon/bounty/1363, pasting from
   `SUBMISSION-DELTA.md` rather than from section 14 above. Not done, and will not be done
   without you.

---

## 18. Independent adversarial audit

A fresh agent was given only the public repository, the public proof page, and public chain data.
No credentials, no working copy, no strategy notes. Told to falsify rather than help. 66 tool
calls: it cloned the repo, rebuilt the contract twice, swept the canary's entire event history,
cross-checked keccak against two independent implementations, and built a stub harness to attack
the state machine.

Its verdict:

> Yes. "KeeperHub executed a real transaction on Base Sepolia and you can verify it without
> credentials or trusting this repo" is true, and I verified every link of it myself with no API
> key. What does not survive is the framing around it.

**Attacks that failed:** the transaction and receipt, topic0, the bytecode pin, the reproducible
build, the keccak implementation (433 vectors, zero mismatches), zero dependencies, the site's
numbers against the manifest, and the marketing sweep, which came back empty.

**It found a real security hole.** The `msg.sender == org wallet` assertion was gated on
`status.sponsored === true`, a value KeeperHub supplies. Omitting one optional boolean skipped the
only check binding the onchain event to the organisation's identity. The auditor reached
`PROOF_WRITTEN` with a `0xdeadbeef` sender and `allLegsAgree: true`. Fixed: the assertion now runs
whenever the org wallet is known, fails closed, and is part of `independentEventMatches`. Three
regression tests added, one of which omits `sponsored` and asserts the run still fails.

**It found a real honesty failure.** I withdrew the `llms.txt` finding in `CLAIMS.md` and the
teardown and left it standing in the README and on the live site, which is precisely the failure
a claims ledger exists to prevent. Fixed in both.

**Everything else it raised, and what happened:** two tests asserted branches they never reached,
including the one covering the fail-open assertion; the path-traversal test passed whether or not
the guard existed; `npm run test:live` was a label with nothing behind it; `scrub` was not a fixed
point; "exactly one transaction" was stronger than a log filter can support; the benchmark caveat
was materially smaller than the real caveat; `canary-build.json` could not prove the ordering it
claimed; the README's `forge build` recipe failed on a fresh clone and swallowed the failure;
`fastestVerifiedMs` was a resumed run presented beside cold ones; one onchain transaction had no
evidence file. All fixed or downgraded. Three findings were accepted and not fixed, with reasons.

Full report and the disposition of every finding: `internal/audit-report.md`.

The audit changed the product, not just the wording. That is the reason to run one.
