# The Base Sepolia gas fallback

A tiny, deliberately boring faucet that exists for one job: unblock a KeeperHub organisation
wallet that has conclusively been proven, before any broadcast, to lack gas for a Flightcheck
canary call.

**This is not a general-purpose faucet.** If you need Base Sepolia ETH for something else, use a
public one. Everything about this interface is shaped to keep it from becoming that.

| | |
|---|---|
| service | https://keeperhub-flightcheck-faucet.timjosh507.workers.dev |
| chain | Base Sepolia, 84532, pinned in code |
| treasury | [`0x944471E945bcdFc5e4bb4afc481375E54D48BeBd`](https://sepolia.basescan.org/address/0x944471e945bcdfc5e4bb4afc481375e54d48bebd) |
| payout | 0.0001 ETH, fixed |
| live acceptance test | [`0x39b1504c2f4f371bdab5451da6251b7e5fa397757882a957fb285e75f6a69ab9`](https://sepolia.basescan.org/tx/0x39b1504c2f4f371bdab5451da6251b7e5fa397757882a957fb285e75f6a69ab9) |

## Why 0.0001 ETH

A verified Flightcheck canary call used 85,465 gas at 0.006 gwei. The payout covers that by
several orders of magnitude at observed Base Sepolia prices, and is still small enough that the
treasury is not worth attacking. The treasury holding 2 test ETH is not a reason to send more.

## The API

Two routes. Neither takes an amount, a chain, or an RPC URL.

```
GET  /api/faucet/base-sepolia/status
POST /api/faucet/base-sepolia
```

```json
{ "recipient": "0x...", "requestId": "flightcheck-faucet-..." }
```

The request id is not a secret. Flightcheck derives it deterministically from the run that
justified the request, so a retry of the same logical claim replays rather than sends again.

Responses carry one of: `funded`, `already_sufficient`, `cooldown`, `rate_limited`,
`treasury_low`, `disabled`, `invalid_address`, `invalid_request`, `rpc_unavailable`,
`send_failed`. A replay of a funded claim returns the original transaction hash with
`idempotentReplay: true`.

Passing `amount`, `amountWei`, `value`, `chainId`, `chain` or `rpcUrl` is rejected
with `invalid_request` rather than ignored. A caller who thinks they set an amount should be
told they cannot, not silently given the default.

## Abuse controls

- Base Sepolia only, chain id pinned in code and never read from a request
- fixed payout, no caller-selectable amount
- one payout per recipient per 24 hours
- 5 claims per hour per caller
- 200 claims and 0.02 ETH per day globally
- the treasury refuses to go below a 0.01 ETH reserve
- a recipient already holding the payout is sent nothing
- the zero address, malformed addresses and the treasury itself are all rejected
- `FAUCET_ENABLED=false` is an emergency kill switch
- request-level idempotency, so a replay returns the original transaction
- `funded` is only reported after a successful mined receipt, never on a hash alone
- RPC failure and send failure both fail closed

### Concurrency

Two simultaneous valid requests for the same recipient or the same request id produce at most one
transaction. Both guards are primary-key inserts in D1, so the database resolves the race and the
reservation is taken **before** anything is signed.

The aggregate caps needed the same treatment and did not originally get it. An audit fired 15
concurrent claims from one caller against a cap of 5, using distinct addresses and distinct
request ids so neither primary-key guard applied, and none were refused: the counter was a
read-modify-write across three statements and lost updates. It is now a single
`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, so concurrent callers serialise on the row. The
same attack now refuses every request over the cap, and the counter records all 15 attempts where
it previously recorded about three.

A send that fails stays failed under that request id. Freeing the row for retry would let a caller
re-drive an id whose transaction may in fact have reached the network. The recipient's cooldown
window is released instead, so a new request id can try later.

## Privacy boundary

The faucet is a separate service on separate infrastructure. It receives a recipient address, a
request id, and a Flightcheck version string. That is the entire request, and there is no field in
which a credential could travel.

It never receives a KeeperHub key of any kind, an OAuth token, a wallet key, a KeeperHub response,
a KeeperHub header, a proof capsule, or an RPC secret. There is not even an `Authorization`
header on the request for one to be attached to by mistake.

An automated test registers a realistic `kh_` key with the redactor, issues a faucet request
through the real client, and asserts that no byte of that key appears anywhere in the outbound
URL, headers or body.

Client IP addresses are never stored. Where rate limiting needs a per-caller key, the IP is HMAC'd
with a server-only secret and only the digest is kept.

## Treasury key handling

The private key was generated locally and piped straight from the generator into
`wrangler secret put` over stdin. It never appeared in a shell argument, a file that outlived
the command, a repository file, or any model-visible output. The address published above was read
back from the deployed Worker, which derives it from the secret it holds, which is a stronger
check than trusting the generator's own output.

The key is a Cloudflare secret, is never exposed to any browser bundle, and is deliberately kept
out of every error path: chain errors carry bare codes, because a library error can contain the
full signed transaction.

## Limitations

- One chain. Extending means another treasury and another set of limits.
- Testnet only. This treasury must never hold mainnet assets, and the code has no mainnet path.
- Not production infrastructure. It is a hackathon fallback with a kill switch.
- The abuse controls raise the cost of misuse. They do not make it impossible.
- The KeeperHub insufficient-balance condition that triggers it is fixture-tested rather than
  live-reproduced, because our organisation is sponsored and we will not engineer an unsafe
  failure to demonstrate a fallback. The faucet itself is live-tested end to end.
