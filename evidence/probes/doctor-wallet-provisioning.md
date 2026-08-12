# Probe: does `kh doctor` mislead a brand-new account?

**Result: not reproduced. No PR opened.**

## The hypothesis

`kh doctor` renders an absent organisation wallet as:

```
no wallet configured (create one in Settings)
```

[`cmd/doctor/doctor.go:295`](https://github.com/KeeperHub/cli/blob/main/cmd/doctor/doctor.go),
reached when `GET /api/user` answers with `walletAddress` null or empty. The surrounding comment
says the field "answers with walletAddress set or null", and that Direct Execution answers `422
WALLET_NOT_CONFIGURED` in the same situation.

Meanwhile KeeperHub provisions organisation wallets automatically for new accounts. If there is a
window between an account becoming valid and its wallet appearing, a builder who runs `kh doctor`
during that window is told to go and create a wallet by hand, for a wallet the platform is about
to create for them. That would be a genuine first-run trap, and a one-line message change would
fix it.

## What we actually measured

The clean-room run on 2026-08-12 used a KeeperHub account created the same morning. By the time
the first `GET /api/user` went out, `walletAddress` was already populated:
`0xaa943223d9601cfa673a9a574b381864ec1a42ee`, with balance 0, nonce 0 and no code. The run reached
`WALLET_RESOLVED` on its first attempt with no retry and no null.

So on the one fresh account we have, the transient window was either shorter than the time between
signup and the first API call, or it does not exist.

## Why there is no PR

The measurement Part C asks for is the interval between account creation and `walletAddress`
turning non-null, and it needs a second brand-new account to observe. Creating one means another
signup on KeeperHub with another identity, days before a submission deadline, on infrastructure
the bounty work depends on. That is not a trade worth making for a message-wording fix.

Without that reproduction the claim would be inferred rather than measured, and an upstream PR
that says "this message is wrong" without a reproduction is a maintainer's problem, not a
contribution. So the finding stops here.

## What a PR would say if it ever reproduces

The current message asserts a cause ("no wallet configured") and prescribes a manual fix ("create
one in Settings"). Both are wrong during automatic provisioning. Something closer to:

```
organization wallet not available yet; new wallets are provisioned automatically.
Retry shortly. If it persists, check Settings or contact support.
```

is correct in both cases, because it describes the observation rather than guessing at the cause.

Anyone with a fresh account can settle this in a minute: sign up, then poll `GET /api/user` and
record how long `walletAddress` stays null. If it is ever null, the message is wrong.
