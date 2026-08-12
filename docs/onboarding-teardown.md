# Onboarding teardown

What broke, or nearly broke, on the way from a fresh KeeperHub account to a verified onchain
transaction. Written while building Flightcheck, so every item below cost real time.

KeeperHub's docs are unusually good for a product at this stage. That is what makes the
remaining gaps worth naming: they are concentrated in a handful of places where the
documentation and the running system disagree, and those are exactly the places a newcomer
cannot debug, because the docs are the thing they are trusting.

Each finding carries an evidence grade:

| grade | meaning |
|---|---|
| **VERIFIED LIVE** | reproduced against the running API, raw response retained |
| **DOC CONFLICT** | two current KeeperHub sources contradict each other, both quoted |
| **REPRODUCED BUG** | behaviour that contradicts the documentation |
| **EXISTING ISSUE** | already reported publicly; we hit it independently |
| **STRONG INFERENCE** | consistent with what we saw, not directly proven |
| **UNRESOLVED** | noticed, not chased down |

---

## 1. The write response does not contain the transaction hash

**Grade: REPRODUCED BUG, and EXISTING ISSUE (#1784)**

What the reference says, under Transfer Funds:

> Successful broadcast requests return HTTP 202 Accepted:
> ```json
> {"executionId": "direct_123", "status": "completed",
>  "transactionHash": "0x...", "transactionLink": "https://etherscan.io/tx/0x..."}
> ```
> `transactionHash` and `transactionLink` are present only when status is `completed`.

What `/api/execute/contract-call` actually returned:

```
POST /api/execute/contract-call -> HTTP 202
{"executionId":"exnn6k0y1ojnnvb8sa1fu","status":"completed"}
```

Status is already `completed` and there is no hash. It only appears on
`GET /api/execute/{id}/status`.

**What a newcomer sees.** They follow the documented shape, read `transactionHash` off the
broadcast response, and get `undefined` at the exact moment the API told them the work
succeeded. The natural next move is to retry, which is the worst available move.

The public feedback issue #1784 reports the same missing hash. This is an independent
reproduction against `/contract-call`.

**How Flightcheck handles it.** `EXECUTION_CREATED` and `BROADCAST_OBSERVED` are separate
stages. The hash is only ever read from the status endpoint, never from the broadcast response.

**Proposed fix.** Either include the hash on the `/contract-call` 202 when status is
`completed`, or scope that sentence in the reference to `/transfer`.

---

## 2. `unconfirmed` is a real state that the endpoint reference does not list

**Grade: DOC CONFLICT**

`docs.keeperhub.com/api/direct-execution`, under Get Execution Status:

> Status Values:
> `pending`: Queued for execution
> `running`: Currently executing
> `completed`: Successfully completed
> `failed`: Execution failed

`docs.keeperhub.com/guides/first-verified-transaction`, same site:

> When a broadcast transaction's receipt cannot be read conclusively, the execution settles as
> `unconfirmed`, which is non-terminal: the status endpoint keeps telling you to poll rather
> than handing you an outcome.

**Why this one matters more than the others.** It has an onchain consequence. A client written
against the endpoint reference sees four states and writes a `switch`. The `default` branch
either fails or retries. Failing reports a false failure for a transaction that is still
settling. Retrying, with a fresh idempotency key, puts a second transaction onchain.

**How Flightcheck handles it.** The documented set is treated as a lower bound. `unconfirmed`
is a first-class state, and anything unrecognised is `UNKNOWN`. Both are non-terminal, neither
is success or failure, and neither ever starts new work.

**Proposed fix.** Add `unconfirmed` to the Status Values list with a sentence saying it is
non-terminal and must not be retried with a new key.

---

## 3. `gasUsedWei` does not carry wei

**Grade: REPRODUCED BUG**

From a real status response:

```json
"gasUsedWei": "85465",
"gasPriceWei": "6000000",
"receipts": [{ "gasUsed": "85465", ... }]
```

`gasUsedWei` is byte-identical to `receipts[0].gasUsed`, which is gas units. Cost in wei would
be units multiplied by price. Anyone computing spend from that field is out by a factor of the
gas price, which on this run was six million.

**Proposed fix.** Rename to `gasUsed`, or make the value actually wei. A rename is the smaller
change and the field is not in the documented response shape, so the blast radius is small.

---

## 4. A green simulation does not mean the transaction can be paid for

**Grade: VERIFIED LIVE**

Simulation returned:

```json
{"success": true, "status": "simulated", "from": "0xfd35ae93…d834c",
 "gasEstimate": "23929", "wouldRevert": false}
```

At that moment the resolved sender held exactly zero Base Sepolia ETH, confirmed independently
with `cast balance`.

This is not a bug. `estimateGas` answers whether the call reverts, and the docs are explicit
that the underfunded case is only detected when the node rejects the estimate outright. On our
run it did not matter, because the write was sponsored.

It is still the single most load-bearing misunderstanding available to a new builder, because
simulation is presented as the safety step and it is genuinely reassuring. It answers a
narrower question than it appears to.

**How Flightcheck handles it.** Preflight output says so in as many words: "Simulation proves
the call would not revert. It does not prove the execution path can fund, broadcast, settle and
verify. That is what `--execute` measures."

**Proposed fix.** One sentence in the Dry-Run Simulation section drawing the line between "would
not revert" and "will land".

---

## 5. Sponsored execution makes the obvious verification method wrong

**Grade: VERIFIED LIVE, and correctly documented**

Measured on a sponsored run:

```
receipt.from   0xdcf4bac4bd805948168ff63483bc493894a29613   a relayer
receipt.to     0x5af5194b4b0909eb978e3cf1e25333852277f07d   a router
event emitter  0x2a6fc8182bf9928ef7517da980dc79e8107c555a   the canary
event sender   0xfd35ae935de7be93ffd585d6627268d833ed834c   the org wallet
org wallet balance throughout: 0
```

KeeperHub documents this clearly:

> A sponsored execution does not change your EOA's nonce or native balance, and it will not
> appear in a block explorer's txlist for that address, checks against the EOA will conclude
> nothing happened even though the transaction succeeded.

Credit where due: this is one of the better-documented sharp edges in the product. It is in the
teardown because the first instinct of every builder verifying their first transaction is to
open their wallet address on the explorer, and that instinct returns an empty page. Nothing in
the onboarding path warns you before you form that instinct.

Also worth recording, because we had to measure it: under sponsorship `msg.sender` inside the
called contract is still the org wallet, even though the paying EOA and the top-level callee are
both KeeperHub infrastructure. Measured on two independent organisations.

And the nonce behaves in a way that actively misleads. The organisation wallet is an EIP-7702
delegated account, so the first sponsored execution installs the delegation and consumes exactly
one nonce, then never moves again:

```
fresh wallet, before   nonce 0   balance 0   code 0x
fresh wallet, after    nonce 1   balance 0   code 0xef0100955d84…222c6f
dev wallet, 8 runs     nonce 1   balance 0   same delegation
```

A builder checking "did my wallet do anything" sees one increment covering eight transactions.
Balance is the only wallet-level field that stays honest, and it stays at zero throughout.

**How Flightcheck handles it.** Verification is always hash → receipt → decoded log, never
wallet state. The sender assertion is applied only on the sponsored path, because that is the
path we measured.

**Proposed fix.** A line in the quickstart's verification step: to check your first transaction,
use the hash, not your wallet page.

---

## 6. The agent-facing index was missing the onboarding path, and has since been fixed

**Grade: WITHDRAWN, corrected on re-verification**

This started as our strongest finding and it no longer holds. Recording it anyway, because a
teardown that only lists things still broken is not an honest teardown.

On 2026-08-10 we measured `docs.keeperhub.com/llms.txt`, the canonical agent-facing index, and
found zero occurrences of `quickstart`, `first-verified`, `headless`, `onboarding`, `idempot`,
`simulate`, `faucet` or `Turnkey`, and two references naming Para as the wallet provider, while
all three onboarding pages returned 200. So the entire zero-to-first-transaction path was
unreachable from the index agents are pointed at.

On 2026-08-11, re-running the same commands before writing this up, the file had been
restructured. It now carries four Getting Started entries, a Platform Reference line covering
the MCP endpoint, chains, faucets, key types and rate limits, a Wallet Management line naming
Turnkey wallets and sponsorship, and a Guides line naming the verified first transaction. Para
is gone.

The lesson we would keep: this took roughly 24 hours to fix, and we would not have noticed the
fix if we had written the teardown from notes instead of re-running the reproduction. Verify
findings immediately before publishing them, not when you discover them.

What is still true from that measurement is item 7 below, which we re-verified today.

## 7. `/api/openapi` does not describe the REST API

**Grade: VERIFIED LIVE**

`llms.txt` advertises it as "Machine-readable schema for the REST API". Reproduce:

```bash
curl -s https://app.keeperhub.com/api/openapi -o openapi.json
python3 -c "
import json; d=json.load(open('openapi.json')); p=list(d['paths'])
print('paths', len(p))
print('non-workflow paths', [x for x in p if not x.startswith('/api/mcp/workflows')])
print('paths with execute', [x for x in p if 'execute' in x])
print('schemas', list(d.get('components',{}).get('schemas',{})))
print('security', list(d.get('components',{}).get('securitySchemes',{})))"
```

Result on 2026-08-11: 117 paths, every one a published workflow call endpoint. Zero core REST paths. Empty
`components.schemas`. Security schemes are `x402` and `siwx` only, so the `kh_` bearer scheme
that every documented REST call requires is not discoverable from the spec at all.

An agent handed this as the machine-readable contract cannot find the execution API and cannot
learn how to authenticate to it.

**Proposed fix.** The honest minimum is a one-line correction in `llms.txt` describing what the
file actually is. Adding the core paths would be better and is a larger change.

---

## 8. Two identifiers per chain, one of which does not work

**Grade: VERIFIED LIVE**

`GET /api/chains` returns both an opaque internal id and the numeric chain id:

```json
{"id":"tqwfqleepzicpldtpomcf","chainId":84532,"name":"Base Sepolia", ...}
```

The execute endpoints take `chainId`. The internal `id` appears in no documented request body.
A newcomer reading this response has a 50/50 choice and no signal about which field the API
wants.

**Proposed fix.** A note on the chains endpoint: `id` is internal, use `chainId` in requests.

---

## 9. Error envelopes are not uniform

**Grade: VERIFIED LIVE**

```
GET /api/keys        (no auth) -> 401  {"error":"Unauthorized"}
GET /api/executions  (no auth) -> 404  {"error":"not_found","detail":"…","request_id":"759d7d0c-…"}
```

The 404 carries `detail` and a `request_id`. The 401, the single most common first-run failure,
carries neither. A client that logs `detail` and `request_id` prints `undefined` exactly when a
new builder most needs something to paste into a support request.

**Proposed fix.** Include `request_id` on auth failures.

---

## 10. The wallet you fund is not the wallet you signed in with

**Grade: VERIFIED LIVE, and documented**

This is the friction point KeeperHub has already documented in at least two places, and it is
still the one most likely to cost an afternoon, because reading it and internalising it are
different things. `GET /api/user` returns `walletAddress`, and that is the address that executes.

Worth noting: on our account the org wallet held zero ETH for every run and every transaction
still landed, because execution was sponsored. So the funding step that the docs emphasise was
not actually required for us. A builder who reads the funding guidance, funds the wrong address,
and then succeeds anyway will draw entirely the wrong conclusion about what fixed it.

**How Flightcheck handles it.** The org wallet is resolved and printed at `WALLET_RESOLVED`
before anything else happens, and the insufficient-balance remediation names that address and
says explicitly that it is not the sign-in wallet.

---

## 11. `simulate` must be a boolean

**Grade: documented, not independently reproduced**

The reference states that `simulate` must be the JSON boolean `true`, and that strings and
numbers are rejected with HTTP 400 specifically to stop a typo falling through to a real
broadcast. We did not test the string form, because doing so proves nothing we did not already
know and the failure mode it guards against is a real broadcast.

This is good design and is listed here to note that we did not verify it rather than to imply we
did.

---

## 12. Two key systems, and the wrong one fails silently

**Grade: STRONG INFERENCE**

`kh_` organisation keys and `wfb_` user keys are documented as not interchangeable. We used a
`kh_` key throughout and did not deliberately test a `wfb_` key against the execution API, so we
have not measured what it returns. Based on the unauthenticated behaviour we did measure, the
most likely response is a bare `{"error":"Unauthorized"}`, which does not name the mistake.

Flightcheck classifies the prefix before any network call and names the mistake directly, which
costs one string comparison. We are flagging the shape of the problem, not claiming to have
reproduced the exact response.

---

## Not chased down

**UNRESOLVED.** The cold-start `upstream_cold_start` 5xx documented for workflow creation. We
never triggered it on the direct-execution path across roughly a dozen runs.

**UNRESOLVED.** Whether the deprecated `get_execution_status` / `get_execution_logs` MCP tools
still appear in the live tool list. We used REST throughout and never enumerated MCP tools.

**UNRESOLVED.** The mainnet gas-sponsorship opt-in path, advertised on the hackathon page and
absent from the docs we read. Out of scope for a testnet-only tool, and we will not speculate
about a path we did not touch.

**Noted, not a finding.** `/api/openapi` enumerates 114 published workflow slugs including other
hackathon entrants. That is a product decision about a public catalog, not a defect, and
characterising it is not our business.

---

## Where this leaves Flightcheck

Six of the twelve items above are things you cannot discover by reading. They only appear when
you execute, settle and then try to verify. That is the argument for the tool: `kh doctor`
answers configuration questions, the docs answer procedure questions, and neither can tell you
that your `202` came back without a transaction hash, or that your wallet page will be empty
even though your transaction succeeded.

The merged first-verified-transaction guide describes the safe sequence a human should follow.
Flightcheck executes that sequence deterministically and hands back a proof capsule. Those are
complementary, and the guide is the better place to learn what is happening.
