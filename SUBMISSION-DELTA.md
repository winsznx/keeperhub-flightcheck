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
| +0:12 | the faucet's live acceptance output | "21/21 checks, one transaction per claim" |
| +0:08 | one line of framing | "fallback only for conclusive pre-broadcast gas failure" |

Do not engineer a KeeperHub failure to make the faucet look useful. Sponsorship working from a
zero-balance wallet is the stronger demonstration.

## 6. Changed numbers

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

> [`0x39b1504c2f4f371bdab5451da6251b7e5fa397757882a957fb285e75f6a69ab9`](https://sepolia.basescan.org/tx/0x39b1504c2f4f371bdab5451da6251b7e5fa397757882a957fb285e75f6a69ab9)
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

## Unchanged and still canonical

| | |
|---|---|
| hackathon transaction | [`0xb4098917d12030a249e9376217d765b715362c744dd23e9b03e0213253d452dc`](https://sepolia.basescan.org/tx/0xb4098917d12030a249e9376217d765b715362c744dd23e9b03e0213253d452dc) |
| execution id | `exnn6k0y1ojnnvb8sa1fu` |
| canary | `0x2A6FC8182Bf9928Ef7517dA980dC79e8107c555A` |
| repo | https://github.com/winsznx/keeperhub-flightcheck |
| proof page | https://keeperhub-flightcheck.timjosh507.workers.dev |
| upstream | #2008 and #2009, both open and unmerged |
