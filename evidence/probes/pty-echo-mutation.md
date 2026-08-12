# Mutation test: can the echo test actually fail?

**Date:** 2026-08-12. **Result:** yes, and it now says which of two things went wrong.

This is the most important security test in the project, and during the final presentation pass it
turned out to be flaky. Roughly one run in three failed with "the typed key must never appear in
terminal output", which reads as a credential leak. It was not one, and finding out what it
actually was took two attempts.

## What was wrong

The harness slept a flat 2.0 seconds and then typed the probe key. `setup` makes a live
reachability call to KeeperHub before it prompts, so when that call took longer than two seconds
the key went into the pty while the terminal's line discipline was still echoing and before
`stty -echo` had run. The terminal echoed it, exactly as a terminal should, and the test reported
a leak that had not happened.

Measured across six runs of an instrumented harness:

```
attempt 1   probe echoed at 2.20s, prompt appeared at 2.56s   probe index 67, prompt index 476
attempt 2   no echo                                            prompt at 0.78s
attempt 3   probe echoed at 2.18s, prompt appeared at 4.06s   probe index 67, prompt index 476
attempt 4   probe echoed at 2.17s, prompt appeared at 2.90s   probe index 67, prompt index 476
attempt 5   no echo                                            prompt at 1.45s
attempt 6   probe echoed at 2.16s, prompt appeared at 2.39s   probe index 67, prompt index 476
```

In every failing run the probe sits at index 67 and the prompt at index 476. The echo came before
the program had asked for anything. Echo suppression never failed.

That is worse than a flaky test. The property under test is "after the program asks, typing does
not echo", and a harness that types early cannot tell a real echo failure from its own race,
because both look identical: the probe appearing in the captured output.

## The fix, and the second bug in it

The harness now waits for the prompt before typing, and the assertion classifies the two cases by
where the probe sits relative to the prompt.

The first attempt at that classification compared the probe's offset against `len(out)` at the
moment the prompt was detected. Those differ by however many bytes the read happened to carry past
the prompt text, which was enough to misclassify a genuine echo as a harness race: with both
suppression layers removed the probe landed at offset 464, the detection offset was 474, and the
test failed with the wrong reason. The comparison is now against the offset of the prompt string
itself.

## Mutation matrix

The credential read path suppresses echo twice: `stty -echo` with the terminal's own state
verified afterwards, and `stdin.setRawMode(true)`. Each layer was removed in turn.

| mutation | test result | verdict reported |
|---|---|---|
| none | pass | — |
| `stty -echo` removed, guard forced true | **pass** | — |
| `setRawMode(true)` removed | **pass** | — |
| both removed | **fail** | `Echo suppression failed` |

Four clean runs before the matrix and four after, with no flakes.

## What this establishes, and what it does not

The test can fail, it fails when echo genuinely leaks, and it now names the cause rather than
reporting every appearance of the probe as a leak.

It does not detect the loss of a single layer, and cannot: each layer alone suppresses echo under
a `pty.fork()` terminal, so removing one produces no observable difference. That is the correct
scope for a test of an observable property, but it means single-layer regression is not covered
here and the redundancy is justified by the audit rather than by this test.

The redundancy is justified. The external audit that originally found this bug caught
`setRawMode` silently failing on macOS with Node 24 in a real terminal while its own `isRaw` flag
reported true, which is why `stty` was added and why the terminal's state is now verified rather
than assumed. Under a Python pty, as the matrix shows, `setRawMode` alone is sufficient. Neither
layer can be relied on across environments, so both stay.

Reproduce with `node --experimental-strip-types --test agent/tests/pty-echo.test.ts`, and
reproduce the matrix by removing either suppression call in `agent/src/secret-input.ts`.
