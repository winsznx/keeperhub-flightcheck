# Threat model

Flightcheck holds an organisation API key that can move real money on mainnet, and asks a
third-party execution layer to broadcast transactions. That deserves a stated threat model
rather than a reassuring sentence.

## What it can and cannot touch

**Can:** read your KeeperHub account metadata (`/api/keys`, `/api/user`), list chains, and ask
KeeperHub to call exactly one function on exactly one contract, on one testnet, with zero value.

**Cannot, by construction:**

- sign anything. Flightcheck holds no private key and contains no signing code. Every broadcast
  goes through KeeperHub, which owns custody.
- send value. The call is zero-value, and the canary is not payable, so a call carrying value
  reverts at the contract.
- call an arbitrary contract. The target address is a compile-time constant whose runtime
  bytecode is hashed against a pin before every run.
- send arbitrary calldata. The only function is `ping(bytes32)` and the only argument is a
  locally generated random challenge.
- touch mainnet. The chain must be present in `GET /api/chains` with `isTestnet: true`, and the
  pinned deployment list contains one testnet.
- broadcast without an explicit flag. Default is simulate-only.

## The canary

139 bytes of runtime bytecode. No storage writes, no balance, no external calls, no approvals,
no delegatecall, no owner, no upgrade path, not payable. Its only persistent effect is a log.

There is no path by which calling it can lose funds, because it cannot receive, hold, move or
approve them. The worst outcome of an unbounded number of calls is spent gas, and on the
observed path that gas was sponsored.

`contracts/test/` asserts the properties that matter: the event round-trips sender and challenge
under fuzzing, the chain id comes from the chain rather than the caller, a call carrying value
reverts, and no storage slot is ever written.

## Trusting the pinned address

An attacker who could change what `config.ts` points at could make Flightcheck ask KeeperHub to
call something else. Three things stand in the way.

The address is a source constant, so changing it means changing the repository. The runtime
bytecode is hashed against a pin before every simulation, so pointing at a different deployed
contract fails at `CANARY_VERIFIED` rather than executing. And the hash is reproducible: the
Solidity build is pinned to solc 0.8.24, cancun, 200 optimizer runs, with CBOR metadata
disabled, so anyone can rebuild from source and check that the pinned hash is the hash of the
source they just read. That last property is what turns the pin from an assertion into a claim
you can falsify.

The remaining exposure is the usual one: if you run untrusted code from a repository, you are
trusting that repository. The mitigations here reduce what a compromise could do, not whether it
could happen.

## Secrets

`KEEPERHUB_API_KEY` is the only credential the tool needs. `DEPLOYER_PRIVATE_KEY` is
maintainer-only, used once to deploy the canary, and is absent from the onboarding path
entirely: a user of this template deploys nothing.

Containment has two independent layers, because either alone fails in a way the other catches.

Value matching scrubs registered secrets and any prefix of eight characters or more, since a
masked `kh_AbCd1234…` is still a disclosure. Pattern matching scrubs secret-shaped values nobody
registered, which is the realistic failure: someone adds a credential to `.env` next month and
forgets the redactor. The 64-hex pattern deliberately ignores `0x`-prefixed values, because
transaction hashes, challenges and bytecode digests all have that shape and are published on
purpose.

Everything the tool prints goes through the scrubber at the boundary, so a stray error object
cannot bypass it. The proof capsule is built from an explicit field list rather than by
serialising response objects, and is scrubbed again before writing. `machine.test.ts` builds a
capsule with a real-shaped key registered and asserts `findLeaks` returns nothing, so a
regression fails the build.

An RPC URL is only published as provenance when it has no userinfo, no query string and no path.
Anything else, including every keyed provider URL, is written as `redacted`.

`.env` and `/internal/` are gitignored, and the git history is scanned before publication.

## What Flightcheck deliberately does not defend against

**A malicious KeeperHub.** If the execution layer lied about everything, the independent legs
would still catch it: the receipt and the decoded event come from a public node, and the
challenge is generated locally before the request is sent, so a fabricated success cannot
produce a matching log. What we do not defend against is a compromised public RPC agreeing with
a compromised KeeperHub. Point `FLIGHTCHECK_RPC_URL` at a node you trust if that matters to you.

**Replay of an old transaction.** The challenge is 32 random bytes per run and must appear in
the event for the run to verify, so a previous transaction cannot satisfy a later run.

**A compromised local machine.** If an attacker can read `.env`, they have the key, and nothing
in this tool helps.

**Denial of service against KeeperHub.** Rate limits are respected, not tested.

## Reporting

Open an issue. There is no bug bounty, and the canary holds nothing worth attacking.
