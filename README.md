# KeeperHub Flightcheck

Proves that KeeperHub can execute, settle and verify a real onchain transaction from *this*
environment, and stops at the exact stage that fails when it cannot.

**Onboarding now ends with an onchain fact.**

```
$ npm run flightcheck -- --execute

  ✓ Authenticated  scope mcp:read mcp:write mcp:admin
  ✓ Organisation wallet resolved  0xfd35ae935de7be93ffd585d6627268d833ed834c
  ✓ Chain available  Base Sepolia (84532)
  ✓ Canary bytecode verified  0x753157870ee9e692c7e35e0890fad801fd30fc4674a74a62a7526758da649dd0
  ✓ Simulation passed  gas 23929
  ✓ Request persisted  aee743c6d5cd4917…
  ✓ Execution created  6dfc6pvc7hd2s4w2nbkj2
  ✓ Transaction observed  0xfb878a7c…
  ✓ Receipt confirmed  block 45340709
  ✓ Flightcheck event verified  0x28cef04b…
  ✓ Proof written

  Verified. KeeperHub executed onchain from this environment.
```

## A real transaction it produced

| | |
|---|---|
| transaction | [`0xb4098917d12030a249e9376217d765b715362c744dd23e9b03e0213253d452dc`](https://sepolia.basescan.org/tx/0xb4098917d12030a249e9376217d765b715362c744dd23e9b03e0213253d452dc) |
| KeeperHub execution | `exnn6k0y1ojnnvb8sa1fu` |
| block | 45339897 on Base Sepolia (84532) |
| challenge | `0x61b3cc48dd907bdfff36b62bf6b7faddc5adcaede477797ca0a035114a3fb4e2` |
| canary contract | [`0x2A6FC8182Bf9928Ef7517dA980dC79e8107c555A`](https://sepolia.basescan.org/address/0x2a6fc8182bf9928ef7517da980dc79e8107c555a) (source-verified) |
| proof capsule | [`evidence/runs/`](evidence/runs/) |

### Reproduced on an account that is not ours

The canonical transaction proves the mechanism works. This proves it works for someone else:

| | |
|---|---|
| transaction | [`0x642002f79b9a6ae4570c84f6b8d3c0a12a9f001304a7921e48f5eb7149aff852`](https://sepolia.basescan.org/tx/0x642002f79b9a6ae4570c84f6b8d3c0a12a9f001304a7921e48f5eb7149aff852) |
| execution | `j6cjarjfr3obh6syblyjd` |
| conditions | KeeperHub account created that morning, fresh clone, no `.env`, no `npm install`, no run state, key typed into the hidden prompt over a real terminal |
| wallet before | balance 0, nonce 0, no code, never used |
| result | verified in 7.4s, sponsored, faucet correctly not used |

Full preconditions and transcript in [`evidence/cleanroom/`](evidence/cleanroom/).

That one is the canonical reference. The terminal output above is from a later run through the
finished CLI; every verified run is recorded in [`evidence/runs/`](evidence/runs/) and summarised
in [`evidence/manifest.json`](evidence/manifest.json).

Verify it yourself in one command, without trusting this repo or KeeperHub:

```bash
curl -s https://sepolia.base.org -H 'content-type: application/json' --data \
'{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0xb4098917d12030a249e9376217d765b715362c744dd23e9b03e0213253d452dc"]}' \
| python3 -m json.tool
```

The log emitted by `0x2a6f…555a` with topic
`0x4947ef22330e8e81cdedf82c33d366e9c942511f5edf79140686b33af9de7f33` is the proof. Its third
topic is the challenge that run generated before it sent anything, which is the value in the
table above.

## Run it yourself

Needs Node 22.18+ and a KeeperHub organisation API key. No `npm install`, because the CLI has
zero runtime dependencies. No `.env` to create either.

```bash
git clone https://github.com/winsznx/keeperhub-flightcheck && cd keeperhub-flightcheck
npm run flightcheck -- setup --execute
```

`setup` asks for your KeeperHub organisation key through a hidden terminal prompt. The key is
used in memory for that run and is never written to `.env`, run state, a proof capsule, a log, or
the command line. It is not accepted as an argument, and if there is no private TTY to type it
into, Flightcheck stops rather than reading from a pipe.

That boundary is the point: an AI agent can tell you to run `setup`, but it cannot read what you
type into it.

You do not deploy a contract. The canary is already live and its bytecode hash is pinned in
[`agent/src/config.ts`](agent/src/config.ts).

<details>
<summary>Advanced and CI setup</summary>

Set `KEEPERHUB_API_KEY` in the environment, or copy `.env.example` to `.env` and fill it in, then
use the direct commands:

```bash
npm run flightcheck                # preflight only, broadcasts nothing
npm run flightcheck -- --execute
```

The environment path is unchanged and takes precedence over the prompt.
</details>

### If gas is genuinely the blocker

KeeperHub is always tried first. On our organisation the canonical transaction was executed from
a wallet holding **zero ETH**, because the write was sponsored, so a zero balance is not a reason
to fund anything.

If KeeperHub does return a conclusive insufficient-balance condition *before any broadcast*,
`setup` offers a fixed 0.0001 ETH Base Sepolia top-up from a small treasury, then retries. If the
failure is ambiguous in any way, meaning a transaction might already exist, it refuses to fund and
tells you to resume instead. Details in [docs/bootstrap.md](docs/bootstrap.md) and
[docs/faucet.md](docs/faucet.md).

## What this proves that `kh doctor` does not

`kh doctor` checks that your configuration looks healthy: authentication, API reachability,
wallet presence, spend cap, chain availability. Those checks stop before anything executes.

A builder can pass all of them and still fail at simulation, funding, routing, broadcast, or
receipt verification. Flightcheck is the other half: it drives the documented
simulate → idempotent execute → reconcile → verify sequence against a contract that moves
nothing, and ends with a transaction hash or an exact diagnosis.

```
kh doctor        "your environment appears healthy"
kh flightcheck   "KeeperHub executed, settled and verified a transaction, here is the hash"
```

## Three legs, and two of them do not trust KeeperHub

A run is `verified` only when all three agree:

1. **KeeperHub** reports the execution completed and its own re-fetched receipt is `verified` with `receiptStatus: success`
2. **A public Base Sepolia node** returns a receipt with status `0x1` for that same hash
3. **The decoded `Flightcheck` event** carries the challenge this run generated, the right chain id, and was emitted by the pinned canary

KeeperHub saying `completed` is one leg. It is never the verdict.

Two stages are answered entirely by a public node, not by KeeperHub: `CANARY_VERIFIED`, which
hashes the deployed bytecode and compares it to the pin, and `EVENT_VERIFIED`, which decodes the
log. That is what makes the result independent rather than self-reported.

### Why verification goes by transaction hash and not by wallet state

On the sponsored path, measured on a real run:

```
receipt.from   0xdcf4bac4…29613   a KeeperHub relayer, not the org wallet
receipt.to     0x5af5194b…7f07d   a router, not the canary
event sender   0xfd35ae93…d834c   the org wallet
```

The org wallet neither sent nor paid for that transaction, and it held zero ETH throughout. Open
it on Basescan and its transaction list shows nothing. Only hash → receipt → decoded log finds it.
Any verifier that checks a wallet's nonce, balance or txlist concludes, wrongly, that nothing
happened.

## The state machine

```
START → AUTHENTICATED → WALLET_RESOLVED → CHAIN_RESOLVED → CANARY_VERIFIED
      → SIMULATION_PASSED → EXECUTION_PREPARED → EXECUTION_CREATED
      → BROADCAST_OBSERVED → RECEIPT_CONFIRMED → EVENT_VERIFIED → PROOF_WRITTEN
```

A failure names the stage and what to do about it, rather than surfacing a status code:

```
  ✗ Simulation passed
    · Request persisted
    · Execution created
    ...

That is a user key, not an organisation key
FC_ENV_WRONG_KEY_TYPE

  KEEPERHUB_API_KEY starts with wfb_, which is a user key for webhook triggers. The REST
  execution API needs the organisation key that starts with kh_. The two are not
  interchangeable. Settings, API Keys, Organisation tab.
```

Every code is listed in [docs/failure-codes.md](docs/failure-codes.md).

## Losing the response did not create a second transaction

This is the part worth reading the code for.

A write is answered in the same HTTP response that performs it, and there is no
list-executions endpoint. If that response is lost, the execution id was never observed and
cannot be looked up afterwards. So Flightcheck derives an idempotency key, writes it and the
exact request bytes to disk, and **fsyncs before sending**. Recovery replays those bytes with
that key, and KeeperHub returns the original outcome marked `idempotentReplay: true`.

A transport retry never mints a new key. A new key means new work.

The acceptance test does this for real against the live API, with no mocks in the proof path:

```
  first invocation stopped without an execution id     true
  broadcast requests actually sent to KeeperHub        2
  recovery replayed the stored response                true
  resumed run reached verified                         true
  transactions onchain carrying this challenge         1
  recovered hash is that transaction                   true

  PASS. Two broadcast attempts, one transaction.
```

The count comes from the chain, not from our bookkeeping: the challenge is unique to the run and
is an indexed topic, so `eth_getLogs` on it counts the transactions that executed that work. Full
log in [`evidence/recovery/`](evidence/recovery/).

Two honest limits on that sentence, both raised by an external audit. `eth_getLogs` only returns
logs from *successful* transactions, so a duplicate that reverted or ran out of gas would be
invisible to this count; the claim is one successfully executed transaction, not one broadcast
attempt. And KeeperHub's idempotency is a third-party guarantee we observed once, not a property
this tool enforces. What Flightcheck controls is its own side: it never mints a new key for a
retry, which is the behaviour that turns a lost response into a second transaction.

## Commands

```bash
npm run flightcheck                       # preflight, broadcasts nothing
npm run flightcheck -- --execute          # one zero-value call to the pinned canary
npm run flightcheck -- --resume <run-id>  # recover a run whose response was lost
npm run flightcheck -- status             # list persisted runs
npm run --silent flightcheck -- --json    # machine-readable capsule, pipeable into jq
npm run flightcheck -- setup --execute    # guided first run, no .env needed
npm test                                  # 115 tests, no network required
npm run evidence                          # regenerate evidence/manifest.json by hand
```

## Safety

Simulate-only unless `--execute`. Testnet enforced. Only the pinned canary, only a zero-value
call, never arbitrary calldata. The canary writes no storage, holds no balance, makes no external
call and is not payable, so a call carrying value reverts. Its runtime bytecode is 139 bytes and
is re-hashed against the chain before every run.

The build is byte-reproducible, so the pinned hash is something you can regenerate rather than
something you take on trust:

```bash
cd contracts
forge install foundry-rs/forge-std   # lib/ is gitignored; only needed for the tests
forge build
jq -e -r '.deployedBytecode.object' out/KeeperHubFlightcheckCanary.sol/KeeperHubFlightcheckCanary.json | cast keccak
# 0x753157870ee9e692c7e35e0890fad801fd30fc4674a74a62a7526758da649dd0
```

`jq -e` matters: without it a build failure feeds empty input to `cast keccak`, which cheerfully
returns the hash of the empty string rather than erroring.

Or skip the build entirely and compare the deployed code against the pin:

```bash
cast code 0x2A6FC8182Bf9928Ef7517dA980dC79e8107c555A --rpc-url https://sepolia.base.org | cast keccak
```

Secrets: the API key is never printed, logged, written to any capsule, accepted on the command
line, or sent to the faucet. Output passes through a
redactor that scrubs both registered values and secret-shaped patterns, and the test suite fails
the build if either appears. See [docs/threat-model.md](docs/threat-model.md).

## Limitations

These are real and they sit here rather than in a footnote.

- **Direct EOA path only.** Under Safe routing, KeeperHub's own funding diagnostic describes the
  outer EOA rather than the address that actually spends. Flightcheck does not model that, and
  would rather say so than print a green check over it.
- **Testnet only.** Base Sepolia. There is no mainnet path and adding one is not a config change.
- **Gas sponsorship is reported, never promised.** Every run records the `sponsored` flag it
  observed. On our runs it was `true` and the org wallet paid nothing. That is an observation
  about this organisation on this chain, not a guarantee about yours.
- **The sender assertion is scoped to what was measured.** `msg.sender == org wallet` is enforced
  only when `sponsored` is true, because that is the path we measured. The non-sponsored path is
  unmeasured and the capsule records it as `recorded-not-asserted`.
- **One canary, one chain.** Extending to another chain means deploying and pinning another
  canary, and another faucet treasury.
- **The gas fallback is fixture-tested at the KeeperHub end.** The faucet itself is live-tested
  end to end, but the KeeperHub `insufficient_balance` condition that triggers it is driven from a
  captured response shape. Our organisation is sponsored, and engineering an unsafe execution
  failure to demonstrate a fallback would be the wrong trade.
- **The faucet is not production infrastructure.** It is a hackathon fallback with a kill switch,
  and its abuse controls raise the cost of misuse rather than making it impossible.

## What we found in KeeperHub along the way

Flightcheck exists because of things that only show up when you actually execute. The full
writeup with reproductions is in [docs/onboarding-teardown.md](docs/onboarding-teardown.md).
The short version:

- The `/contract-call` broadcast returns `202` with `status: "completed"` and **no
  `transactionHash`**. The hash only appears on the status endpoint.
- `unconfirmed` is a live execution state that is missing from the Direct Execution reference's
  status list, while another page on the same site documents it as non-terminal.
- `gasUsedWei` carries gas units, not wei.
- A simulation passes while the payer holds zero balance, so a green simulation is not proof a
  broadcast can land.
- `/api/openapi` is advertised as the machine-readable schema for the REST API and contains no
  core REST path and no bearer scheme.

One finding was **withdrawn** before publication. `llms.txt` omitted the whole onboarding path
when measured on Aug 10; re-running the reproduction on Aug 11 showed it had been fixed upstream.
The teardown records both measurements rather than dropping it.

## Upstream

Four PRs open against KeeperHub, all from findings this project proved with real transactions.
None is merged, and nothing here depends on them being merged.

**KeeperHub/cli**

- [#99](https://github.com/KeeperHub/cli/pull/99) `fix(execute)`: a write can return `202` with
  `status: "completed"` and no `transactionHash`, and the CLI treated that as terminal, so
  `--wait` returned a success the caller could not verify. Also honours `X-Poll-Interval-Hint`,
  which was being discarded in favour of a hardcoded 2s ticker. Verified each behavioural test
  fails against the old behaviour.
- [#100](https://github.com/KeeperHub/cli/pull/100) `fix(auth)`: `--with-token` left the terminal
  echoing, so an organisation key was typed in plaintext and stayed in scrollback, and the
  command's own example piped a live credential through shell history. Now prompts without echo,
  piped input unchanged.

**KeeperHub/keeperhub**

- [#2008](https://github.com/KeeperHub/keeperhub/pull/2008) documents the `unconfirmed` execution
  status, which is live but missing from the Direct Execution status list
- [#2009](https://github.com/KeeperHub/keeperhub/pull/2009) corrects what the OpenAPI document is
  described as covering

The two CLI fixes are the ones worth reading. Both are places where the official client diverged
from KeeperHub's own documented safe-execution contract, and we found them by building the
reference implementation and running it against the live API.

## Repository

```
agent/src/       state machine, KeeperHub client, independent verifier, proof writer,
                 bootstrap, gas policy, faucet client
faucet/          the Base Sepolia gas fallback Worker (separate service, own dependencies)
agent/tests/     115 tests plus the live fault-injection acceptance test
contracts/       the canary, its Foundry tests, and the deploy script
evidence/        proof capsules, the recovery log, the benchmark, the build manifest
docs/            teardown, threat model, failure codes, how verification works
```

Claims are tracked against their evidence in [CLAIMS.md](CLAIMS.md). Nothing in this README is
allowed to exceed that ledger.

Proof page, generated from the evidence manifest:
[keeperhub-flightcheck.timjosh507.workers.dev](https://keeperhub-flightcheck.timjosh507.workers.dev)

MIT licensed.
