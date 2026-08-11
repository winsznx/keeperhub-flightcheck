# FINAL-DELTA

Consistency pass only. No features added, no product behaviour changed.

## Authoritative test count

**84 tests, 84 pass, 0 fail, 16 suites**, measured from a fresh clone with no `npm install`.

`evidence/test-run.json` had recorded 80. It was generated before the adversarial audit added
four regression tests, and never regenerated. It is now written from the run rather than typed.

## Changed files

| file | change |
|---|---|
| `evidence/test-run.json` | regenerated from an actual run, 80 to 84 |
| `evidence/manifest.json` | regenerated, picks up the corrected count |
| `README.md` | test count 80 to 84 in two places; upstream section rewritten to state exact PR status |
| `CLAIMS.md` | row 25 count corrected and evidence wording tightened; row 38 rewritten to state current PR status |
| `REVIEW.md` | section 3 table, section 8 rewritten, DoraHacks copy and shot list updated |
| `evidence/final-gate-run.txt` | re-captured |
| `site/dist/index.html` | rebuilt from the corrected manifest, redeployed |

## Current upstream PR status, checked 2026-08-11T14:00Z

| PR | state | merged | on `staging`? |
|---|---|---|---|
| [#2008](https://github.com/KeeperHub/keeperhub/pull/2008) `unconfirmed` status | **open** | no | no |
| [#2009](https://github.com/KeeperHub/keeperhub/pull/2009) OpenAPI description | **open** | no | no |
| #2005 | closed | no | superseded by #2008 |
| #2006 | closed | no | superseded by #2009 |

Verified directly against the live docs: `/api/direct-execution` still lists four status values
with no `unconfirmed`, and `llms.txt` still calls `/api/openapi` the machine-readable schema for
the REST API. Both findings remain true, and both fixes remain unlanded.

**On why #2005 and #2006 closed simultaneously with no maintainer comment.** I closed them. They
were opened with a git identity not linked to the GitHub account; rewriting the authorship
detached the branches from `staging`, and GitHub would neither reopen them nor accept a new PR
from those branches. Both were closed in the same second because both branches were force-pushed
in one command. Comment counts confirm it: each has exactly one comment, authored by `winsznx`,
and zero maintainer activity. No review, no rejection, no automated cleanup.

Nothing to ask maintainers about yet. If #2008 or #2009 later closes without comment, that would
be a different situation and worth raising in the builder channel.

## What changes in the demo script and submission copy

- Shot at 2:08 says "the two open upstream PRs" and shows #2008 and #2009. It previously showed
  #2005 and #2006, which are closed.
- DoraHacks copy line now reads `Upstream: KeeperHub/keeperhub#2008 and #2009, both open and
  unmerged` rather than implying merged or pending review.
- No other narrative beat changes. The response-loss segment remains the centre of the video.

## Gates re-run, all green

```
[1] typecheck strict                        PASS
[2] tests                                   84/84
[3] contract tests                          5/5
[4] source == pin == chain bytecode         PASS
[5] 0 runtime deps, 0 vulnerabilities       PASS
[6] 55 tracked files vs 3 credentials       no match, incl. 8-char prefixes
[7] git history                             no credential in any commit
[8] fresh clone: hygiene clean, runs with no install, 84/84
[9] headline claim verified with no credentials: receipt 0x1, emitter is the
    canary, topic0 matches the pin, challenge matches, chainId 84532
```

Claim-ledger consistency, withdrawn-claim sweep, PR-status sweep and live-site sweep all pass.

## No correctness defects found

Nothing in this pass exposed a product defect. Every change is documentation catching up to
measurement.

## Credentials to rotate before anything else

Everything that ever appeared in the agent transcript, not only the two the earlier report named:

1. **`KEEPERHUB_API_KEY`**, the `kh_` organisation key. Pasted into chat. Rotate in the KeeperHub
   app, Settings, API Keys, Organisation tab, and revoke the old one.
2. **`ETHERSCAN_API_KEY`**, the Etherscan V2 multichain key. Pasted into chat. Rotate at
   etherscan.io.
3. **`DEPLOYER_PRIVATE_KEY`**. Generated locally and never printed in full, but a six-character
   prefix of an earlier version was echoed once by a masking bug, and that key was rotated
   immediately. The current key has never been displayed. It is a throwaway holding roughly 0.45
   Base Sepolia ETH at `0xE6b01781868Df2c1664F659476245175525Ae914`. Drain and discard it.

Not in the transcript, listed so the sweep is complete: no RPC secrets were used, only public
endpoints. The GitHub token lives in the system keyring and was never displayed. Cloudflare used
an OAuth token from `~/.wrangler`, never displayed.

The repo and git history are clean of all three, verified programmatically against the live
values including prefixes. That protects the published artifact. It does not protect the
credentials, which were exposed the moment they entered the transcript.
