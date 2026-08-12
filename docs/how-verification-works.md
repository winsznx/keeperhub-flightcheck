# How verification works

A Flightcheck run is `verified` only when three lines of evidence agree, two of which never ask
KeeperHub anything. Calling all three "independent" would be the wrong word and this document is
the precise version of the claim, including where it is weaker than it looks: leg 1 is KeeperHub's
own report, which is the thing being checked rather than a check on it.

## The three legs

**Leg 1, KeeperHub's own account.** `GET /api/execute/{id}/status` reports the execution
`completed`, and its `receipts[]` entry carries `verified: true` with `receiptStatus: "success"`.
KeeperHub re-fetches that receipt from the chain itself before settling, so this is stronger
than a self-reported status, but it is still KeeperHub grading its own work.

**Leg 2, a public node.** `eth_getTransactionReceipt` against `FLIGHTCHECK_RPC_URL`, which
defaults to `https://sepolia.base.org` and is not operated by KeeperHub, returns a receipt with
status `0x1` for the same hash. The node is asked for its chain id first and the run stops if it
is not serving 84532, so a node on the wrong network cannot vouch for anything.

**Leg 3, the event.** That receipt contains a log emitted by the pinned canary address, with
topic0 equal to `keccak256("Flightcheck(address,bytes32,uint256)")`, whose challenge topic is
byte-equal to the 32 random bytes this run generated before it sent anything, and whose data
decodes to chain id 84532.

Plus a fourth check that is easy to forget: the hash leg 1 named and the hash leg 2 resolved
must be the same transaction. Two proof legs that describe different transactions prove nothing.

## Why not just check the wallet

Because on the sponsored path it returns the wrong answer. Measured:

```
receipt.from   0xdcf4bac4bd805948168ff63483bc493894a29613   relayer
receipt.to     0x5af5194b4b0909eb978e3cf1e25333852277f07d   router
event sender   0xfd35ae935de7be93ffd585d6627268d833ed834c   org wallet
org wallet native balance throughout the run: 0
```

The org wallet did not send the transaction and did not pay for it. Open it on Basescan and the
transaction list is empty, while a transaction sits in block 45339897 doing exactly what was asked.

The nonce deserves its own paragraph, because an earlier version of this document said it "did not
move" and that was wrong. **The organisation-wallet nonce is not a reliable detector of sponsored
execution.** The organisation wallet is an EIP-7702 delegated account, and installing that
delegation consumes a nonce:

```
clean-room wallet, before its first run   nonce 0   balance 0   code 0x
clean-room wallet, after                  nonce 1   balance 0   code 0xef0100955d84139e7621bc571b117d8eb5d28a4a222c6f
development wallet, across 8 executions   nonce 1   balance 0   same delegation
```

So the clean-room wallet moved from 0 to 1 when its delegation was installed on its first
sponsored execution, and the development wallet remained at 1 across later sponsored canary
executions. Two observations, and they disagree about whether the nonce moves. That is the whole
point: a verifier reading the nonce sees a single increment sitting behind an unknown number of
transactions, and gets a different answer depending on which execution it happened to look at. We
do not claim a general rule beyond those two measurements.

Balance is the reliable negative. It never changes, because the relayer pays.

So verification goes hash → receipt → log, and never touches wallet state.

## The challenge

32 bytes from `crypto.randomBytes`, generated at the start of the run and persisted before the
request is sent. It is an indexed event parameter, so it lands in the log topics.

It does two jobs. It makes an old transaction useless as evidence for a new run, since the log
must carry this run's bytes. And it makes counting exact: `eth_getLogs` filtered to the canary
address and that topic returns precisely the transactions that executed this logical work, which
is how the recovery test proves that two broadcast attempts produced one transaction rather than
taking our word for it.

## The bytecode pin

Before simulating, Flightcheck fetches the canary's runtime bytecode from the public node and
compares `keccak256` of it to a hash compiled into the binary. A mismatch stops the run at
`CANARY_VERIFIED` and nothing is sent.

That guards against a stale address, a redeployment, or a repository edit pointing somewhere
else. It matters because the alternative is asking an execution layer to call whatever happens
to live at an address, which is the thing the tool exists to be careful about.

The keccak implementation is written out rather than pulled from a package, so that a tool
handling an API key has no runtime dependencies. It is differential-tested against Foundry's `cast keccak`, 60 cases spanning every length that
straddles the 136-byte rate boundary, with zero divergences (`evidence/keccak-differential.json`),
and against two oracles that would catch a subtle error: it must reproduce the pinned event topic from the
event signature string, and the `ping(bytes32)` selector from the function signature.

The pin is falsifiable. `cd contracts && forge build` on a clean checkout regenerates the same
runtime bytecode, because solc version, evm version, optimizer runs and CBOR metadata are all
pinned. If it did not, the hash would be an assertion instead of a claim.

## The sender assertion, and its limits

Under `sponsored: true`, `msg.sender` at the canary was measured to be the org wallet even though
the paying EOA and the top-level callee were both KeeperHub infrastructure. Flightcheck asserts
that identity, but only on that path.

The non-sponsored path has not been measured. Asserting there would be inventing a failure mode
from a guess. The capsule records which happened:

```json
"senderAssertion": "asserted-and-matched-under-sponsored-true"
"senderAssertion": "recorded-not-asserted"
```

## What a `verified` result does not mean

It does not mean gas sponsorship will apply to your organisation. It means it applied on this
run, and the flag is recorded.

It does not mean a Safe-routed execution would work. Flightcheck does not model Safe routing,
and KeeperHub's own funding diagnostics are documented as describing the outer EOA rather than
the spending address in that case.

It does not mean mainnet would behave the same way. There is no mainnet path.

It does not mean KeeperHub is healthy in general. It means this environment, this credential,
this chain and this execution path produced one verified transaction at one point in time.

## Verify a run yourself

Take any hash from `evidence/runs/` and ask a node directly:

```bash
TX=0xb4098917d12030a249e9376217d765b715362c744dd23e9b03e0213253d452dc
curl -s https://sepolia.base.org -H 'content-type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionReceipt\",\"params\":[\"$TX\"]}" \
  | python3 -m json.tool
```

Check that `status` is `0x1`, that a log has `address` `0x2a6fc8182bf9928ef7517da980dc79e8107c555a`,
that `topics[0]` is `0x4947ef22330e8e81cdedf82c33d366e9c942511f5edf79140686b33af9de7f33`, and that
`topics[2]` equals the `challenge` field in the capsule. `topics[1]` is the sender, left-padded
to 32 bytes, and `data` is the chain id.

That is the entire proof. Nothing in it requires trusting this repository.
