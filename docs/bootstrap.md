# Bootstrap

`npm run flightcheck -- setup --execute` is the first-run path. It exists to remove the last two
pieces of friction between a KeeperHub account and a verified onchain transaction: creating a
config file, and working out whether gas is your problem.

## The human/agent credential boundary

This is the part worth understanding, because it is a security property rather than a convenience.

An AI coding agent can tell you to run `flightcheck setup`. It cannot read what you type into it.
The key goes from your keyboard into Flightcheck's own process, and nowhere the agent can see.

```
you ──types──> Flightcheck process ──Authorization header──> KeeperHub
                      │
                      └── never: .env, run state, proof capsule, logs, argv, the faucet
```

The key is read in raw TTY mode with echo suppressed, so not a single character reaches the
terminal and a paste never lands in scrollback. It is held in one string for the process lifetime
and disappears when the process exits.

It is registered with the redactor the instant it is read, before any request, so even a crash
between reading it and using it cannot print it through an error path.

### What is refused, and why

**A key on the command line.** `--key`, `--api-key`, or a bare `kh_...` argument all fail with
`FC_SECRET_IN_ARGV`. Argv is readable by every process on the machine through `ps`, and it lands
in shell history. There is no way to take that back, so the remediation says to treat the key as
exposed and rotate it.

**A key on a pipe.** If stdin is not an interactive TTY and no environment key is set, Flightcheck
fails with `FC_SECRET_TTY_REQUIRED` rather than reading. A pipe, a heredoc, a file redirect and an
agent-controlled stdin all look identical here, and they all mean something other than a human at
a keyboard is holding the key.

```
$ npm run flightcheck -- setup --execute < /dev/null

No private terminal to type a credential into
FC_SECRET_TTY_REQUIRED
```

**The environment path still works.** `KEEPERHUB_API_KEY` is checked first, so CI and existing
users are unaffected. That path is documented as advanced setup rather than the recommended one.

## Organisation wallet readiness

After authentication, `setup` resolves the organisation wallet from `GET /api/user` and shows its
public information: the address, its Base Sepolia balance, and whether the chain is available.

Flightcheck creates no wallet, exports no key, and adds no custody. Your execution wallet remains
KeeperHub's Turnkey organisation wallet. The only wallet this project owns is the faucet treasury,
which is a separate service holding testnet dust.

## KeeperHub-first gas policy

The rule that matters:

**A zero balance is not a reason to fund anything.**

The canonical Flightcheck transaction was executed from an organisation wallet holding exactly
zero ETH, because KeeperHub sponsored it. Pre-funding on a zero balance would be answering a
question that, on a sponsored organisation, is never asked.

So KeeperHub is tried first. Always. The gas fallback becomes eligible only when every one of
these is true:

1. the chain is Base Sepolia, 84532
2. the call is the canonical zero-value canary `ping`
3. KeeperHub returned a conclusive insufficient-balance condition
4. the failure is classified `broadcastPossible: false`
5. no execution id and no transaction hash was ever observed
6. the canary bytecode was verified on this run
7. the recipient is exactly the resolved organisation wallet
8. that wallet holds less than the fixed payout

Any other outcome refuses, and the refusal names its reason.

### The refusals that matter most

An **ambiguous** failure never funds. If the response was lost, or the execution is `unconfirmed`,
or an execution id exists whose outcome is unresolved, then a transaction may already be on the
wire. Funding a wallet and starting a new run in that state is exactly how one logical operation
becomes two transactions.

That check runs before anything else about the failure, including before the "is this even a gas
problem" check, because for a transport loss the safety-critical fact is the possible broadcast,
not the category of error.

A **sponsored success** never funds. There is nothing to fix.

## Safe retry after funding

When funding does happen, the run that preceded it is a completed logical failure: it provably
never broadcast, and there is no earlier transaction for a new attempt to duplicate. Only then is
a **new** idempotency key correct.

```
conclusive pre-broadcast insufficient balance
        │
        ├── mark the run FAILED_PRE_BROADCAST, keep its evidence
        ├── request the fixed faucet payout
        ├── confirm the faucet receipt independently
        ├── confirm the recipient balance independently
        └── new logical run, new idempotency key
```

For every ambiguous failure the existing resume logic wins instead: same run, same key, no faucet,
no new work. The two paths are deliberately separate, and `mayStartNewLogicalRun` is the single
function that decides which applies.

## What this is not

It does not make gas sponsorship predictable. Whether KeeperHub sponsors your organisation is not
knowable in advance, and Flightcheck reports the `sponsored` flag it observed rather than
promising anything.

It does not generalise beyond Base Sepolia. KeeperHub supports many chains; Flightcheck v1 covers
the one whose execution and verification model has actually been proven here.
