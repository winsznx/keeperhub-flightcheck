# SUBMISSION-DELTA

Updated DoraHacks fields after the Flightcheck Bootstrap extension. **Nothing has been submitted.**
Paste-ready, but review first.

The canonical hackathon transaction is unchanged. The faucet transfer is supporting evidence only.

---

## 1. Vision

> `kh doctor` checks configuration. Flightcheck proves the last mile actually works, and proves it
> independently even when the first execution response disappears.
>
> Onboarding now ends with an onchain fact.

## 2. Details

> Flightcheck is an execution conformance check for KeeperHub onboarding. One command drives the
> documented simulate to idempotent execute to reconcile to verify sequence against a pinned
> contract that moves nothing, and ends with either a real Base Sepolia transaction plus a
> machine-readable proof capsule, or a stop at the exact stage that failed with the remediation
> for it.
>
> A run is verified only when three things agree: KeeperHub's execution record, a public Base
> Sepolia receipt, and a decoded event carrying the challenge generated before the request was
> sent. Two of the twelve stages never ask KeeperHub anything.
>
> **Bootstrap** removes the last of the setup friction. `npm run flightcheck -- setup --execute`
> works from a fresh clone with no `.env` and no `npm install`. The KeeperHub organisation key is
> read through a hidden terminal prompt, used in memory, and never written to a file, a proof
> capsule, a log, or the command line. If there is no private TTY it stops rather than reading
> from a pipe, and a key passed as an argument is refused outright. That is a deliberate boundary:
> an AI coding agent can tell you to run `setup`, but it cannot read what you type into it.
>
> **Gas is handled KeeperHub-first.** The canonical transaction was executed from an organisation
> wallet holding zero ETH, because the write was sponsored, so a zero balance is never treated as
> a reason to fund anything. A small Base Sepolia fallback exists for the one case where KeeperHub
> returns a conclusive insufficient-balance condition before any broadcast. Every ambiguous
> failure refuses to fund and resumes the existing run instead, because funding a wallet
> mid-ambiguity is exactly how one logical operation becomes two transactions.
>
> The reliability demo is still the centre: kill the response after KeeperHub has accepted the
> request, resume, and exactly one transaction exists on chain, counted from chain logs rather
> than from our own bookkeeping.

## 3. Which KeeperHub surfaces did you use?

> REST direct execution: `POST /api/execute/contract-call` for both simulation and broadcast,
> `GET /api/execute/{id}/status` for reconciliation, honouring `X-Poll-Interval-Hint`.
> `GET /api/keys` to prove the credential works, since `GET /api/chains` answers without one.
> `GET /api/user` to resolve the organisation wallet, which is not the sign-in wallet.
> `GET /api/chains` for availability and testnet enforcement.
> Idempotency-Key on every broadcast, with replay recovery inside the documented 24-hour window.
> Not used: MCP, workflows, x402/MPP, Safe routing, mainnet.

## 4. What still breaks or is unfinished?

> Direct EOA path only. Under Safe routing KeeperHub's own funding diagnostic describes the outer
> EOA rather than the address that actually spends, so Flightcheck does not model it rather than
> printing a green check over it.
>
> Base Sepolia only. Extending means another canary and another faucet treasury.
>
> Gas sponsorship is reported as observed per run, never promised. Whether it applies to your
> organisation is not knowable in advance.
>
> The `msg.sender == org wallet` assertion is enforced whenever the wallet is known, but the
> non-sponsored execution path has never been exercised on our organisation.
>
> The gas fallback is fixture-tested at the KeeperHub end. The faucet itself is live-tested end to
> end, but the `insufficient_balance` condition that triggers it is driven from a captured response
> shape, because our organisation is sponsored and engineering an unsafe execution failure to
> demonstrate a fallback would be the wrong trade.
>
> The faucet is a hackathon fallback with a kill switch, not production infrastructure. Its abuse
> controls raise the cost of misuse rather than making it impossible.
>
> Two upstream docs PRs are open and unmerged, and neither change is on `staging`.
>
> The onboarding benchmark was run by agents, not humans, and is one run per arm.

## 5. Demo video shot-list delta

Insert a Bootstrap opening before the existing response-loss demo. About 35 seconds added.

| time | shot | on screen |
|---|---|---|
| 0:00 | fresh clone, nothing configured | `git clone ... && cd keeperhub-flightcheck` |
| 0:08 | `npm run flightcheck -- setup --execute` | no .env, no npm install |
| 0:14 | the hidden prompt | "KeeperHub organisation key:" with nothing echoed as it is typed |
| 0:22 | stages tick through | org wallet resolved, balance 0 ETH |
| 0:28 | freeze on the gas line | "0 ETH in org wallet, KeeperHub sponsored, faucet not used" |
| 0:36 | verified | tx hash, execution id, sponsored true |

Then the existing demo continues unchanged, from the `kh doctor` contrast through the
response-loss recovery, which remains mandatory and remains the centre.

Add one short segment after the recovery proof:

| time | shot | on screen |
|---|---|---|
| +0:12 | the faucet's live acceptance output | "24/24 checks, one transaction per claim" |
| +0:08 | one line of framing | "fallback only for conclusive pre-broadcast gas failure" |

Do not engineer a KeeperHub failure to make the faucet look useful. Sponsorship working from a
zero-balance wallet is the stronger demonstration.

## 6. Changed numbers

*Point-in-time, 2026-08-11. Section 11 below carries the current figures.*

| | before | now |
|---|---|---|
| tests | 84 | 115 |
| failure codes | 39 | 43 |
| verified runs | 5 | 6 |
| claim rows | 41 | 56 |
| runtime deps | "zero" | CLI zero, faucet Worker one (`viem`) |

## 7. Faucet public URL

> https://keeperhub-flightcheck-faucet.timjosh507.workers.dev

## 8. Faucet treasury address

> `0x944471E945bcdFc5e4bb4afc481375E54D48BeBd`
> Base Sepolia testnet only. Never holds mainnet assets.

## 9. Faucet live-test transaction

> [`0x0a0f6576336ef771d7a6b0feaca5c1c7a4560bf2382c814da3836ecf3923150d`](https://sepolia.basescan.org/tx/0x0a0f6576336ef771d7a6b0feaca5c1c7a4560bf2382c814da3836ecf3923150d)
> Fixed payout of 0.0001 ETH to a fresh address, receipt verified independently, replay of the
> same request id returned the original transaction rather than sending again.

## 10a. Independent audit of the extension, and what it found

A hostile audit was run against the extension with no KeeperHub credential, attacking the live
faucet and the published code. It found two real holes, both fixed and re-verified before
anything shipped. Worth mentioning in the submission because the fixes are more interesting than
the features.

**The credential prompt echoed the key.** Under a real pty on macOS with Node 24, the typed
KeeperHub key printed in plaintext directly beneath the line promising it would not, with Node's
own `isRaw` flag reporting true throughout. Reordering the prompt did not fix it. Echo is now
suppressed through the terminal and the terminal's actual state is verified before a byte is read;
if it will not confirm echo is off, the run stops rather than reading visibly. The old unit test
could not have caught this, because it mocked the stream where the leak does not happen; the new
test drives the real CLI under a real pty and was confirmed to fail against the old behaviour.

**The faucet's rate caps were not concurrency-safe.** The counter was a read-modify-write across
three statements, so 15 concurrent claims against a cap of 5 were all allowed and real testnet ETH
moved past the documented limit. It is now a single atomic statement, and the same attack now
refuses everything over the cap.

Both are recorded in `CLAIMS.md` as having been false in the first release, with what changed and
how each is verified. Full disposition in `internal/audit-report-extension.md`.

## 10. New limitations

Added to section 4: the fixture-tested trigger condition, the faucet's non-production status, and
the single-chain scope of the treasury.

---

# 11. Final state, 2026-08-12

Everything above stands. This section is what changed after it, and it is the section to paste
from where the two disagree.

## 11a. One more paragraph for Details

> **When it fails, you get something to send.** A first run that breaks reaches a maintainer as
> "it didn't work" plus a cropped screenshot, because the person reporting it cannot tell which
> parts of their terminal are safe to paste. `npm run flightcheck -- support <run-id>` writes a
> redacted diagnostic file built from an explicit field list, run through the same redactor the
> proof capsule uses, with a writer that refuses to emit a file still tripping the leak detector.
> Every KeeperHub request carries an `X-Request-Id` naming the run, the operation and the attempt,
> so a ticket can say which call failed instead of roughly when. The command makes no network
> request, needs no credential, and changes nothing it reads.

## 11b. One more finding for the teardown list

> A successful KeeperHub response carries no request id. `x-request-id` and a body `request_id`
> appear only on a 404 route miss, and nothing echoes the header a client sends. The one response
> that carries an id is the one where nothing happened. Measured across `/api/chains`, `/api/keys`
> authenticated and not, `/api/execute/contract-call` and the status endpoint.

## 11c. Independent reproduction, now first-class

The clean-room run has a section on the proof page and in the evidence manifest rather than
living only in `evidence/cleanroom/`. Worth naming in the submission because it answers the
question a judge actually has, which is not "does it work for you".

> A KeeperHub account created that morning, unrelated to ours. Fresh clone, no `.env`, no
> `npm install`, `KEEPERHUB_API_KEY` unset, key typed into the hidden prompt over a real pty and
> verified never echoed. Wallet at balance 0, nonce 0, no code. Verified in 7.4 seconds, sponsored,
> faucet unused.
>
> [`0x642002f79b9a6ae4570c84f6b8d3c0a12a9f001304a7921e48f5eb7149aff852`](https://sepolia.basescan.org/tx/0x642002f79b9a6ae4570c84f6b8d3c0a12a9f001304a7921e48f5eb7149aff852),
> execution `j6cjarjfr3obh6syblyjd`, org wallet `0xaa943223d9601cfa673a9a574b381864ec1a42ee`.

## 11d. A published claim, withdrawn

Say this rather than hide it. It is the second time the project has corrected itself in public and
it is the part that makes the rest of the ledger worth anything.

> Every proof capsule and the proof page said a sponsored execution leaves the organisation
> wallet's nonce untouched. The clean-room wallet disproved it: nonce 0 → 1, because the first
> sponsored execution installs the wallet's EIP-7702 delegation. The correct statement is narrower
> and more useful: the nonce is not a reliable detector of sponsored execution in either
> direction. The development wallet stayed at 1 across eight executions; the fresh one moved once
> on its first. No general pattern is claimed beyond those two measurements. Capsules written
> before the correction keep the old sentence verbatim, with the correction recorded beside them.

## 11e. Two more demo shots

Insert after the response-loss recovery, before the close:

| time | shot | on screen |
|---|---|---|
| +0:14 | `support <run-id>` on the failed run from the failure segment, showing the request-id table and `Secrets included: none` | "a failed run becomes something safe to send" |
| +0:08 | the clean-room section of the proof page | "reproduced on an account that isn't ours" |

Still do not engineer a KeeperHub failure. The failure segment already uses a real stop.

## 11f. Upstream, final

Five PRs, none merged, and that is the ceiling. Two carry maintainer reviews with changes
requested, both addressed on 2026-08-12.

| PR | state |
|---|---|
| [keeperhub #2008](https://github.com/KeeperHub/keeperhub/pull/2008) | open, changes requested and addressed. Regenerated `specs/api-coverage.json`, carried the fix to `docs/api/executions.md` for workflow runs, added the missing `system_error` status found while there, and pointed terminality at `X-Poll-Interval-Hint` instead of at string matching |
| [keeperhub #2009](https://github.com/KeeperHub/keeperhub/pull/2009) | open, changes requested and addressed. The reviewer caught that the replacement line named SIWX as a payment scheme and omitted MPP; verified against the live document (121 operations, 78 paid, all declaring x402 and mpp, 0 with a per-operation `security` array) and rewritten |
| [keeperhub #2039](https://github.com/KeeperHub/keeperhub/pull/2039) | open, mergeable, no review yet |
| [cli #99](https://github.com/KeeperHub/cli/pull/99) | open, mergeable. File overlap with #95 disclosed by us, with an offer to rebase |
| [cli #100](https://github.com/KeeperHub/cli/pull/100) | open, mergeable, no review yet |

## 11g. Current numbers

| | 2026-08-11 | now |
|---|---|---|
| tests | 115 | 142 |
| suites | 22 | 27 |
| failure codes | 43 | 44 |
| verified runs | 6 | 9 |
| claim rows | 56 | 79 |
| upstream PRs | 2 | 5 |

## 11h. Not claimed, and worth saying out loud

- No support capsule has been through a real KeeperHub ticket. What is claimed is what the file
  contains and what it structurally cannot contain.
- Whether KeeperHub can resolve a `cf-ray` on its end is theirs to say. It is what a successful
  response actually carries.
- `kh doctor` may or may not misreport a wallet during automatic provisioning. We looked, could
  not reproduce it on the one fresh account available, and did not open a PR on an inference. The
  probe is published with the reason.

---

## Unchanged and still canonical

| | |
|---|---|
| hackathon transaction | [`0xb4098917d12030a249e9376217d765b715362c744dd23e9b03e0213253d452dc`](https://sepolia.basescan.org/tx/0xb4098917d12030a249e9376217d765b715362c744dd23e9b03e0213253d452dc) |
| execution id | `exnn6k0y1ojnnvb8sa1fu` |
| canary | `0x2A6FC8182Bf9928Ef7517dA980dC79e8107c555A` |
| repo | https://github.com/winsznx/keeperhub-flightcheck |
| proof page | https://keeperhub-flightcheck.timjosh507.workers.dev |
| upstream | five open, none merged: keeperhub #2008, #2009, #2039 and cli #99, #100 |
