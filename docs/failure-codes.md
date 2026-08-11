# Failure codes

Generated from `agent/src/errors.ts` by `npm run evidence`. Do not edit by hand.

Every way a Flightcheck run can stop, the stage it stops at, and whether a transaction may
already exist when it does.

`broadcast possible` is the column that matters. When it is yes, the correct response is to
resume the same run rather than start a new one, because a new run derives a new idempotency
key and a new key is what creates a second transaction.

## START

Run started.

| code | means | broadcast possible |
|---|---|---|
| `FC_ENV_MISSING_KEY` | No KeeperHub API key found | no |
| `FC_ENV_WRONG_KEY_TYPE` | That is a user key, not an organisation key | no |
| `FC_ENV_MALFORMED_KEY` | API key is not in a recognised format | no |
| `FC_RESUME_NOT_FOUND` | No stored run with that id | no |
| `FC_RESUME_NOTHING_TO_REPLAY` | That run never sent anything, so there is nothing to resume | no |
| `FC_RESUME_WINDOW_EXPIRED` | Too old to resume safely | **yes** |

### `FC_ENV_MISSING_KEY`

**No KeeperHub API key found**

> Set KEEPERHUB_API_KEY in .env. Create the key at app.keeperhub.com under
> Settings, API Keys, the Organisation tab. Copy .env.example to .env if you have not.

### `FC_ENV_WRONG_KEY_TYPE`

**That is a user key, not an organisation key**

> KEEPERHUB_API_KEY starts with wfb_, which is a user key for webhook triggers. The REST
> execution API needs the organisation key that starts with kh_. The two are not
> interchangeable. Settings, API Keys, Organisation tab.

### `FC_ENV_MALFORMED_KEY`

**API key is not in a recognised format**

> KEEPERHUB_API_KEY should start with kh_. Check for a partial paste, a quoted value or a
> trailing newline in .env.

### `FC_RESUME_NOT_FOUND`

**No stored run with that id**

> Nothing at .keeperhub/flightcheck/<run-id>.json. List stored runs with
> `npm run flightcheck -- status`.

### `FC_RESUME_NOTHING_TO_REPLAY`

**That run never sent anything, so there is nothing to resume**

> Run <run-id> stopped before it persisted a request, which means no
> broadcast was ever attempted and no transaction can exist for it. Start a fresh run:
>   npm run flightcheck -- --execute

### `FC_RESUME_WINDOW_EXPIRED`

**Too old to resume safely**

> KeeperHub replays a stored response for 24 hours. Past that the same key executes again
> silently, so replaying this request could produce a second transaction. Flightcheck
> refuses. Check the original run's transaction on the explorer, then start a new run.

## AUTHENTICATED

Authenticated.

| code | means | broadcast possible |
|---|---|---|
| `FC_AUTH_INVALID` | KeeperHub rejected the API key | no |
| `FC_AUTH_FORBIDDEN` | KeeperHub refused the request | no |

### `FC_AUTH_INVALID`

**KeeperHub rejected the API key**

> GET /api/keys returned 401. The key is wrong, revoked or expired. Issue a fresh
> organisation key and update .env.
> Note that GET /api/chains answers without a credential, so reaching KeeperHub is not
> evidence that your key works.

### `FC_AUTH_FORBIDDEN`

**KeeperHub refused the request**

> 403. Either the organisation daily spending cap is exhausted, or the credential lacks
> the scope this call needs. Check Settings, then Billing and API Keys.

## WALLET_RESOLVED

Organisation wallet resolved.

| code | means | broadcast possible |
|---|---|---|
| `FC_WALLET_UNRESOLVED` | Could not resolve the organisation wallet | no |
| `FC_WALLET_NOT_CONFIGURED` | No execution wallet configured | no |

### `FC_WALLET_UNRESOLVED`

**Could not resolve the organisation wallet**

> GET /api/user did not return a walletAddress. This is the wallet KeeperHub executes
> from, and it is not the address you signed in with. Open app.keeperhub.com and finish
> wallet setup.

### `FC_WALLET_NOT_CONFIGURED`

**No execution wallet configured**

> KeeperHub returned WALLET_NOT_CONFIGURED (422). The organisation has no execution wallet
> yet. Create one in the app before running Flightcheck.

## CHAIN_RESOLVED

Chain available.

| code | means | broadcast possible |
|---|---|---|
| `FC_CHAIN_UNSUPPORTED` | Chain is not offered by KeeperHub | no |
| `FC_CHAIN_DISABLED` | Chain is listed but disabled | no |
| `FC_CHAIN_NOT_TESTNET` | Refusing to run against a non-testnet chain | no |

### `FC_CHAIN_UNSUPPORTED`

**Chain is not offered by KeeperHub**

> Chain 84532 is absent from GET /api/chains. Flightcheck v1 targets Base Sepolia
> (84532). Remove FLIGHTCHECK_CHAIN_ID from .env to use the default.

### `FC_CHAIN_DISABLED`

**Chain is listed but disabled**

> KeeperHub reports isEnabled=false for chain 84532. Try again later.

### `FC_CHAIN_NOT_TESTNET`

**Refusing to run against a non-testnet chain**

> Chain 84532 is not flagged isTestnet. Flightcheck v1 is testnet-only by design and
> has no mainnet path.

## CANARY_VERIFIED

Canary bytecode verified.

| code | means | broadcast possible |
|---|---|---|
| `FC_CANARY_NO_CODE` | No contract code at the canary address | no |
| `FC_CANARY_BYTECODE_MISMATCH` | Canary bytecode does not match the pinned hash | no |
| `FC_RPC_UNREACHABLE` | Independent RPC is unreachable | no |
| `FC_RPC_WRONG_CHAIN` | Independent RPC is on the wrong chain | no |

### `FC_CANARY_NO_CODE`

**No contract code at the canary address**

> eth_getCode returned empty for 0x2A6FC8182Bf9928Ef7517dA980dC79e8107c555A on chain 84532. Either the RPC is
> serving a different chain, or the pinned address is wrong for this network.

### `FC_CANARY_BYTECODE_MISMATCH`

**Canary bytecode does not match the pinned hash**

> The code deployed at the canary address is not the code this build expects. Flightcheck
> fails closed here and will not ask KeeperHub to call it. Rebuild the contract with
> `cd contracts && forge build` and compare, or update to a release whose pin matches.

### `FC_RPC_UNREACHABLE`

**Independent RPC is unreachable**

> Could not reach the configured RPC. Flightcheck verifies results against a
> node that is not KeeperHub, so it will not proceed without one. Set FLIGHTCHECK_RPC_URL
> to any Base Sepolia endpoint.

### `FC_RPC_WRONG_CHAIN`

**Independent RPC is on the wrong chain**

> The RPC reports chain undefined but this run targets undefined. Point
> FLIGHTCHECK_RPC_URL at a Base Sepolia node.

## SIMULATION_PASSED

Simulation passed.

| code | means | broadcast possible |
|---|---|---|
| `FC_SIM_REVERT` | Simulation says the call would revert | no |
| `FC_SIM_INSUFFICIENT_BALANCE` | Execution wallet cannot pay for this transaction | no |
| `FC_SIM_REJECTED` | KeeperHub rejected the simulation request | no |

### `FC_SIM_REVERT`

**Simulation says the call would revert**

> KeeperHub decoded: no reason given
> Nothing was broadcast. Simulation exists precisely so this costs no gas.

### `FC_SIM_INSUFFICIENT_BALANCE`

**Execution wallet cannot pay for this transaction**

> Fund the org wallet on this chain.
>   have      ?
>   need      ?
>   shortfall ?
> This is the organisation wallet KeeperHub executes from. It is not the wallet you signed
> in with, and funding the sign-in wallet will not help.

### `FC_SIM_REJECTED`

**KeeperHub rejected the simulation request**

> The request was malformed. Nothing was broadcast.

## EXECUTION_PREPARED

Request persisted.

| code | means | broadcast possible |
|---|---|---|
| `FC_AUTH_INSUFFICIENT_SCOPE` | Credential cannot broadcast | no |

### `FC_AUTH_INSUFFICIENT_SCOPE`

**Credential cannot broadcast**

> Broadcasting needs the mcp:write scope; this token has mcp:read.
> Simulation works on mcp:read, which is why the earlier stages passed. Reauthorize with
> the write scope, or use an organisation API key, which is not scope-limited.

## EXECUTION_CREATED

Execution created.

| code | means | broadcast possible |
|---|---|---|
| `FC_EXEC_RATE_LIMITED` | Rate limited by KeeperHub | no |
| `FC_EXEC_SPEND_CAP` | Daily spending cap exceeded | no |
| `FC_EXEC_IDEMPOTENCY_CONFLICT` | Idempotency key already used for a different request body | **yes** |
| `FC_EXEC_IDEMPOTENCY_IN_PROGRESS` | An identical request is still running | **yes** |
| `FC_EXEC_NO_ID` | KeeperHub accepted the request but returned no execution id | **yes** |

### `FC_EXEC_RATE_LIMITED`

**Rate limited by KeeperHub**

> Direct execution allows 60 requests per minute per key. Wait a few
> seconds and resume the same run so the idempotency key is reused.
>   npm run flightcheck -- --resume <run-id>

### `FC_EXEC_SPEND_CAP`

**Daily spending cap exceeded**

> Raise or reset the organisation daily spending cap in the KeeperHub app.

### `FC_EXEC_IDEMPOTENCY_CONFLICT`

**Idempotency key already used for a different request body**

> This is the safe answer, not a bug. KeeperHub refused to execute because the body
> differs from the one this key first carried, which is what stops a rebuilt retry from
> double-spending.
> No original execution id was returned, so the first attempt either failed at broadcast
> or is still in flight. Keep the same key and retry; rotating it is the one action that
> can produce a second transaction.
>   npm run flightcheck -- --resume <run-id>

### `FC_EXEC_IDEMPOTENCY_IN_PROGRESS`

**An identical request is still running**

> Wait a moment and resume the same run.
>   npm run flightcheck -- --resume <run-id>

### `FC_EXEC_NO_ID`

**KeeperHub accepted the request but returned no execution id**

> Without an id there is nothing to poll. Resume to replay the same idempotency key, which
> returns the stored original response.
>   npm run flightcheck -- --resume <run-id>

## BROADCAST_OBSERVED

Transaction observed.

| code | means | broadcast possible |
|---|---|---|
| `FC_EXEC_TRANSPORT_LOST` | The response was lost after KeeperHub accepted the request | **yes** |

### `FC_EXEC_TRANSPORT_LOST`

**The response was lost after KeeperHub accepted the request**

> A transaction may already exist. Flightcheck persisted the request and its idempotency
> key before sending, so resuming replays the identical request and recovers the original
> outcome instead of creating a second one.
>   npm run flightcheck -- --resume <run-id>

## RECEIPT_CONFIRMED

Receipt confirmed.

| code | means | broadcast possible |
|---|---|---|
| `FC_EXEC_FAILED` | KeeperHub reports the execution failed | **yes** |
| `FC_STATUS_UNCONFIRMED` | Execution is unconfirmed, which is not a failure | **yes** |
| `FC_STATUS_UNKNOWN` | KeeperHub returned a status this build does not recognise | **yes** |
| `FC_RECEIPT_NOT_FOUND` | No receipt found for the transaction yet | **yes** |
| `FC_RECEIPT_REVERTED` | The transaction landed but reverted | **yes** |
| `FC_RECEIPT_UNVERIFIED` | KeeperHub could not verify its own receipt | **yes** |

### `FC_EXEC_FAILED`

**KeeperHub reports the execution failed**

> No detail was returned.
>   npm run flightcheck -- --resume <run-id>

### `FC_STATUS_UNCONFIRMED`

**Execution is unconfirmed, which is not a failure**

> The transaction was broadcast but its receipt could not be read conclusively yet. This
> state is non-terminal. Do not re-run, which would risk a second transaction. Resume the
> same run instead.
>   npm run flightcheck -- --resume <run-id>

### `FC_STATUS_UNKNOWN`

**KeeperHub returned a status this build does not recognise**

> Status was unset. Unknown states are treated as non-terminal and never
> as success or failure. Resume to reconcile.
>   npm run flightcheck -- --resume <run-id>

### `FC_RECEIPT_NOT_FOUND`

**No receipt found for the transaction yet**

> The independent node has not seen this hash within the polling budget. That is unknown,
> not failed: the transaction may still land. Resume in a minute.
>   npm run flightcheck -- --resume <run-id>

### `FC_RECEIPT_REVERTED`

**The transaction landed but reverted**

> Receipt status is 0x0. Gas was spent and no Flightcheck event exists.
> This is a real onchain failure and is never reported as success.

### `FC_RECEIPT_UNVERIFIED`

**KeeperHub could not verify its own receipt**

> receiptStatus is unknown. not_found and timeout mean verification
> ran out of budget rather than that the transaction failed, so the execution may still
> settle. Resume rather than re-run.
>   npm run flightcheck -- --resume <run-id>

## EVENT_VERIFIED

Flightcheck event verified.

| code | means | broadcast possible |
|---|---|---|
| `FC_EVENT_MISSING` | The receipt carries no Flightcheck event | **yes** |
| `FC_EVENT_WRONG_EMITTER` | The event came from the wrong contract | **yes** |
| `FC_EVENT_CHALLENGE_MISMATCH` | The challenge in the event is not the one generated | **yes** |
| `FC_EVENT_CHAINID_MISMATCH` | The event reports a different chain | **yes** |
| `FC_EVENT_SENDER_MISMATCH` | The canary saw a caller other than the organisation wallet | **yes** |
| `FC_HASH_DISAGREEMENT` | KeeperHub and the public node disagree about the transaction | **yes** |

### `FC_EVENT_MISSING`

**The receipt carries no Flightcheck event**

> The transaction succeeded but did not emit the log this run was built to prove. Something
> other than the intended call executed. Not reported as success.

### `FC_EVENT_WRONG_EMITTER`

**The event came from the wrong contract**

> Expected undefined, saw undefined. A matching signature from an unpinned address
> proves nothing about the canary.

### `FC_EVENT_CHALLENGE_MISMATCH`

**The challenge in the event is not the one generated**

> The per-run challenge exists so a stale or replayed transaction cannot satisfy this run.
> It did not survive end to end, so the run is not verified.

### `FC_EVENT_CHAINID_MISMATCH`

**The event reports a different chain**

> Event says undefined, this run targets undefined.

### `FC_EVENT_SENDER_MISMATCH`

**The canary saw a caller other than the organisation wallet**

> Expected msg.sender undefined, saw undefined.
> This assertion is only applied on the sponsored path, where it was measured. See
> docs/how-verification-works.md.

### `FC_HASH_DISAGREEMENT`

**KeeperHub and the public node disagree about the transaction**

> KeeperHub reported undefined, verification followed undefined. The two proof
> legs must resolve to one transaction or the result means nothing.

## Exit codes

| code | meaning |
|---|---|
| 0 | verified, or a preflight that passed without broadcasting |
| 1 | stopped at a stage, with a diagnosis |
| 2 | unconfirmed, which is neither success nor failure |
| 3 | an unexpected error, which is a bug in Flightcheck |
