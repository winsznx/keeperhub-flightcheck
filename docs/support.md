# The support capsule

```bash
npm run flightcheck -- support <run-id>
```

Writes `evidence/support/flightcheck-support-<run-id>.json`. Attach it to a KeeperHub support
ticket, or don't. Nothing is uploaded.

## Why it exists

A first run that fails reaches a maintainer as "it didn't work", usually with a screenshot,
usually cropped, because the person reporting it cannot tell which parts of their terminal are
safe to paste. They are right to be careful. The terminal has their organisation key in it three
lines up.

So the reporter sends too little and the maintainer asks for more, and the loop costs a day. The
fix is not to ask people to redact better. It is to produce a file that is already safe, from
data the tool already has.

## What is in it

Everything a maintainer would ask for, and nothing they would have to ask you to remove.

```
run          run id, created timestamp, stage reached, outcome, attempts,
             replay and conflict counters, the challenge, a digest of the
             idempotency key
failure      the Flightcheck code, its stage, broadcastPossible, and the
             remediation text the user was shown
chain        chain id, pinned canary address, expected and observed runtime
             bytecode hashes, whether they matched
wallet       the organisation wallet's public address
keeperhub    execution id, server status, normalised state, sponsored,
             poll count
onchain      transaction hash, explorer link, receipt status and block,
             whether the expected event was found, whether the challenge and
             the sender matched
faucet       whether the gas fallback fired, and its transaction if it did
requests     every KeeperHub request: operation, method, path, HTTP status,
             elapsed ms, the id we sent, the id the server gave back, and
             which field that came from
timingsMs    per-operation durations and the total
excluded     the list of things deliberately absent, stated in the artifact
```

## What cannot be in it

The organisation key, an `Authorization` header, cookies, private keys, Cloudflare secrets, RPC
credentials, the raw environment, raw argv, complete request headers, the faucet's rate-limit
identity, IP addresses, wallet signing secrets.

That list is enforced twice. The capsule is assembled from an explicit field list, so a value has
to be named in `agent/src/support.ts` to appear at all, and the finished object goes through the
same redactor the proof capsule uses. The writer then runs the leak detector over the serialised
bytes and throws rather than writing a file that trips it, so the failure mode is an error rather
than a disclosure.

The tests are written as attacks rather than as assertions of intent. A key, a private key, a
`Bearer` header, a session cookie and a bare 64-hex string are each planted into every field of
the run record that could plausibly carry one, and the capsule is scanned afterwards. Asserting
"we never put the key in" would pass on a capsule that carries it under a name nobody thought to
check.

The idempotency key is the one interesting case. It is derived from public request parts, so it
is not a secret in the usual sense, but it is the single value that can replay a stored response
inside KeeperHub's 24-hour window. Only a SHA-256 of it travels.

## Request correlation

Every KeeperHub request Flightcheck makes carries an `X-Request-Id`:

```
fc_42f39246d384_authenticate_1
fc_42f39246d384_resolvewallet_1
fc_42f39246d384_simulate_1
fc_42f39246d384_execute_1
fc_42f39246d384_settle_1
```

Run id, operation, attempt. The run id is a random UUID with no relationship to any credential,
the operation is the thing the request was for rather than the last stage that completed, and the
counter keeps retries of the same operation distinguishable. Capped at 64 characters and
restricted to `[A-Za-z0-9_-]`, so it cannot become a channel for anything else.

The server side is more awkward, and the capsule is honest about it. Measured against the live
API on 2026-08-12:

| response | `x-request-id` | body `request_id` | `cf-ray` |
|---|---|---|---|
| `200 /api/chains` | no | no | yes |
| `200 /api/keys` | no | no | yes |
| `401 /api/keys` | no | no | yes |
| `202 /api/execute/contract-call` | no | no | yes |
| `200 /api/execute/{id}/status` | no | no | yes |
| `404` unknown route | yes | yes | yes |

None of them echo the `X-Request-Id` we send. The only response that carries a KeeperHub request
id is the one where nothing happened: a route that does not exist. So for a run that completed
and behaved strangely, which is exactly when a ticket gets filed, there is no id to quote.

What every response does carry is Cloudflare's `cf-ray`, so that is what the capsule records,
tagged `serverRequestIdSource: "cf-ray"` so nobody mistakes it for something KeeperHub issued.
The datacentre suffix is dropped: a ray reads `<16 hex>-<colo>`, and the colo is a coarse
location hint about the person filing the ticket while the hex identifies the request on its own.

This is written up as a finding in
[onboarding-teardown.md §9a](onboarding-teardown.md), alongside the related one about 401
envelopes carrying no `request_id` at all.

## It is read-only and offline

The command opens a persisted run, optionally reads the proof capsule beside it, and writes one
file. It runs no subprocess, so the git commit it reports comes from parsing `.git/HEAD` rather
than from calling `git`. It creates no client and makes no request.

Two tests hold that line. One spawns the real CLI with `KEEPERHUB_API_KEY` unset, an unroutable
RPC URL and an unroutable proxy, and asserts a capsule is still written. The other snapshots the
entire state directory before and after and asserts it is byte-identical, and that the only file
created is the one the command named.

It also works on a run from days ago, which matters: `support` is deliberately not gated behind
`loadEnv()`. A diagnostic command that refuses to run for the same reason as the thing being
diagnosed is worse than useless.

## What it is not

No telemetry backend. No submission endpoint. No account linking. Nothing is sent anywhere, at
any point, by any code path in this command. The file lands on disk and the person who ran it
decides what happens next.

## Flags

```
--out DIR   write somewhere other than evidence/support
--json      print the capsule on stdout instead of the summary
```

`FLIGHTCHECK_STATE_DIR` moves where run records are read from, which is useful on a read-only
checkout or when one machine talks to two KeeperHub organisations.
