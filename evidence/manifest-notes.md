# Notes on the evidence set

## Onchain activity not represented by a capsule

An external audit swept every `Flightcheck` event the canary has ever emitted, from its deploy
block to head, and found 7 events with 7 distinct challenges, none repeated. Six map to files in
`evidence/`. One does not:

```
block 45340757   2026-08-11T12:03:22Z
tx    0x1b6b82636eca9985ee...
challenge 0x5c9c8faf6d81191dda769064564384b82251bae53ee3c1c2f49ab80e9f031d26
```

That transaction is from the first attempt at the fault-injection acceptance test. The injection
worked, the recovery worked, and the script then crashed in its own reporting step: it queried
`eth_getLogs` with `fromBlock: "earliest"`, which the public node rejects. So the run produced a
real transaction and no evidence file, and the test was re-run with a bounded block range.

It is recorded here rather than left as an unexplained onchain event. `evidence/runs/` holds the
capsules the tool wrote, which is not the same set as every transaction the canary has ever seen,
and the difference is worth stating rather than letting someone find it.

## What `runs.fastestEndToEndMs` counts

Cold runs only. A resumed run skips simulation and re-reads a transaction that is already mined,
so its total is not comparable to a run that did the whole sequence. 4 of the 5 verified capsules
are cold; the fifth is a resume performed as a regression probe during the benchmark.
