# KeeperHub Onboarding Benchmark — BASELINE arm

Run date: 2026-08-11 (all timestamps UTC, measured with `date -u +%H:%M:%S` immediately
before/after each step).
Goal: from public docs only, reach a verified onchain transaction executed through
KeeperHub on Base Sepolia (chainId 84532), and independently verify it.

---

## 1. Timeline

| Timestamp (UTC) | Action | Outcome |
|---|---|---|
| 12:13:12 | **T0.** `date` + `mkdir -p` scratch dir | started |
| 12:13:1x | WebFetch `https://docs.keeperhub.com/` + one web search | Found nav: Getting Started / API / CLI / Guides. Identified 4 entry paths (browser, agent/MCP, api, cli). Chose API. |
| 12:14:0x | WebFetch `/getting-started/api` and `/api` | Learned base URL `https://app.keeperhub.com`, `Authorization: Bearer kh_…`. Quickstart only covers *workflow* execution, but `/api` index revealed a **Direct Execution** section (`/api/execute/transfer`, `/api/execute/contract-call`) — no workflow needed. |
| 12:14:18 | `curl /api/keys` with the org key | `http=200`. Key valid, scope `mcp:read mcp:write mcp:admin`. Auth leg done in 66s. |
| 12:14:38 | `curl /api/chains`, `curl /api/integrations` | Base Sepolia present: `chainId 84532, isEnabled true, isTestnet true`. One integration: `type:"web3"`, address `0xfd35ae935dE7Be93ffd585D6627268D833ed834c`, `isManaged:false`. |
| 12:14:5x | WebFetch `/api/direct-execution` | Got full contract: `simulate` must be JSON boolean, `Idempotency-Key`, `GET /api/execute/{id}/status` returns `receipts[]` with `verified` / `receiptStatus`, `X-Poll-Interval-Hint`. |
| 12:15:05 | **Failure 1.** Simulate `WETH.deposit()` with `value:"0.0001"` on 84532 | `http=400`, `code:"insufficient_balance"`, `"Insufficient BASE balance. Have: 0.0, Need: 0.0001…"`. ~1 min to interpret: this is a *value* shortfall, not a gas shortfall. |
| 12:15:1x | WebFetch `/wallet-management` | Page has no funding/faucet instructions. Dead end. |
| 12:15:38 | `curl` the docs HTML and `grep -oE 'href="/…"'` | Recovered the real sitemap from the rendered nav. **Found `/guides/first-verified-transaction`** — the exact guide for this task. |
| 12:15:5x–12:16:2x | **Failures 2–4.** WebFetch `/sitemap.xml`, `/cli/wallet`, `/wallet-management/funding` | All `HTTP 404 Not Found`. Guessed URLs; wasted ~45s before falling back to the href scrape above. |
| 12:16:1x | WebFetch `/wallet-management/gas` | **Key correction:** "Mainnet usage counts against the cap; testnet usage is not charged", sponsorship covers "Sepolia, Base Sepolia, Polygon Amoy, Arbitrum Sepolia". So gas is sponsored on 84532 — I do **not** need to fund anything, only avoid sending `value`. |
| 12:16:23 | **Failure 5.** `curl …/first-verified-transaction.md` | `http=404` (returned a Next.js error page). Assumed Mintlify-style raw markdown; wrong. |
| 12:16:28 | Simulate zero-value `WETH.approve(0x…dEaD, 1)` on 84532 | `http=200`, `success:true`, `wouldRevert:false`, `gasEstimate:"46136"`, `from: 0xfd35…834c`. Green light. |
| 12:16:47 | `curl` guide HTML + python tag-strip → `guide.txt` (9,976 chars) | Got the guide verbatim. WebFetch's summarizer had compressed away the concrete curl bodies. |
| 12:17:0x | Read `guide.txt` in full | Learned the 4-part definition of "verified", the Turnkey-EOA / Safe / Roles / token-holder role table, and the explicit warning: *"do not fund an address just because a message named it."* |
| 12:17:08 | Public RPC: `eth_getBalance`, `eth_getTransactionCount`, `eth_chainId` for `0xfd35…834c` | `balance = 0x0`, `nonce = 0x1`, `chainId = 0x14a34` (84532). Confirms zero native balance — so the run only works if sponsorship is real. |
| 12:17:14 | `GET /api/integrations/{id}`; **Failure 6** `GET /api/organizations` | Integration detail 200 (`walletAddress` = same EOA, `config:{}` → no Safe routing). Organizations → `{"error":"Unauthorized"}` `http=401` with a valid `kh_` key. |
| **12:17:37** | **Broadcast.** `POST /api/execute/contract-call`, zero value, `Idempotency-Key: baseline-bench-2026-08-11-weth-approve-84532-v1` | `http=202` → `{"executionId":"ls1auzqql7mslxt8qf8uq","status":"completed"}` |
| **12:17:40** | **T_first_tx** — KeeperHub's `verifiedAt`/`completedAt` for the hash | tx `0x7c5876d4…9776` exists onchain |
| 12:17:53 | `GET /api/execute/ls1auzqql7mslxt8qf8uq/status` | **Leg 1 ✅** `status:"completed"`, `receipts[0].verified:true`, `receiptStatus:"success"`, `blockNumber:45341186`, `gasUsed:"67842"`, `sponsored:true`. `X-Poll-Interval-Hint: 0`. One poll only. |
| 12:18:10 | `eth_getTransactionReceipt` on `https://sepolia.base.org` | **Leg 2 ✅** `status: 0x1`, block `0x2b3da02` (45341186), `gasUsed 0x10902` (67842), 1 log. |
| **12:18:37** | `eth_call` allowance at head + at parent block; `eth_getCode` ×3 | **Leg 3 ✅ → T_verified.** allowance went `0x…000` (block 45341185) → `0x…001` (head). |
| 12:19:22 | Own pure-python keccak-256, self-tested against `keccak256("") = c5d2…a470` | `keccak256("Approval(address,address,uint256)") = 0x8c5be1e5…3b925` — byte-identical to the receipt's `topic0`. Decode is now fully independent of any library or explorer. |

---

## 2. Totals

| Metric | Value |
|---|---|
| **T0 → T_verified** | 12:13:12 → 12:18:37 = **5 min 25 s** |
| T0 → T_first_tx | 12:13:12 → 12:17:40 = 4 min 28 s |
| T_first_tx → T_verified | 57 s |
| Shell invocations (`Bash` calls) | **15** |
| Distinct network calls inside those shells (curl/JSON-RPC) | 21 |
| Documentation URLs opened | **11 distinct** (7 returned content, 4 were 404s) |
| Web searches | 1 |
| Failed attempts | **6** (see §3) |
| Transactions put onchain | **1** |
| Wallets funded / attempted to fund | **0** — never needed, never attempted |
| Wrong-wallet funding incidents | none |

### Documentation URLs opened
1. `https://docs.keeperhub.com/` — 200
2. `https://docs.keeperhub.com/getting-started/api` — 200
3. `https://docs.keeperhub.com/api` — 200
4. `https://docs.keeperhub.com/api/direct-execution` — 200
5. `https://docs.keeperhub.com/wallet-management` — 200 (fetched twice: WebFetch, then raw curl for the nav hrefs)
6. `https://docs.keeperhub.com/sitemap.xml` — **404**
7. `https://docs.keeperhub.com/cli/wallet` — **404**
8. `https://docs.keeperhub.com/wallet-management/funding` — **404**
9. `https://docs.keeperhub.com/wallet-management/gas` — 200
10. `https://docs.keeperhub.com/guides/first-verified-transaction` — 200 (fetched twice: WebFetch, then raw curl)
11. `https://docs.keeperhub.com/guides/first-verified-transaction.md` — **404**

---

## 3. Friction points, with exact error text

**F1 — The `value`-bearing first attempt read as "you must fund a wallet".**
Simulating `WETH.deposit()` with `value:"0.0001"` returned `http=400`:
```
"revertReason":"Insufficient BASE balance. Have: 0.0, Need: 0.0001. Fund
 0xfd35ae935de7be93ffd585d6627268d833ed834c with at least 0.0001 BASE on this chain and retry."
"code":"insufficient_balance","balanceWei":"0","requiredWei":"100000000000000",
"shortfallWei":"100000000000000","nativeSymbol":"BASE"
```
Cost: roughly 90 seconds and a detour into wallet/funding docs. The message is accurate but
tells you to go get a faucet, which for a first verified transaction is the single most
expensive branch a new builder can take (faucets are rate-limited, captcha'd, and often
require a mainnet-funded address). Nothing at the point of failure says "if you drop
`value`, gas is sponsored on this chain and you need no funds at all."
Also note the message names an address to fund, while `/guides/first-verified-transaction`
§10 says *"do not fund an address just because a message named it."* The error and the
guide give opposing instincts.

**F2–F4 — Guessed doc URLs 404.**
```
The server returned HTTP 404 Not Found.
```
for `https://docs.keeperhub.com/sitemap.xml`, `https://docs.keeperhub.com/cli/wallet`, and
`https://docs.keeperhub.com/wallet-management/funding`. There is no machine-readable
sitemap, so a programmatic reader has to scrape `href=` out of rendered HTML to discover
that `/guides/first-verified-transaction` exists. Cost: ~45 s.

**F5 — No raw-markdown endpoint.**
`https://docs.keeperhub.com/guides/first-verified-transaction.md` → `http=404`, body is a
Next.js `__next_error__` HTML page. Had to download the 430 KB rendered page and strip
tags to read the guide's exact curl bodies. Cost: ~25 s.

**F6 — `GET /api/organizations` rejects a valid org API key.**
```
{"error":"Unauthorized"}   http=401
```
with the same `kh_` key that `GET /api/keys`, `/api/chains`, `/api/integrations` and
`/api/execute/*` all accept (scope `mcp:read mcp:write mcp:admin`). `/api` documents
Organizations as an org-scoped resource. Either the docs or the endpoint is wrong. Not
blocking — I wanted it only to confirm signer mode, which `GET /api/integrations/{id}`
answered instead (`config:{}`, no Safe).

**F7 (documentation contradiction, not an error) — sponsorship coverage.**
`/getting-started/api` says: *"Your organization receives a Turnkey wallet with monthly gas
sponsorship **on mainnet**."* `/wallet-management/gas` says the opposite is also true:
*"Mainnet usage counts against the cap; testnet usage is not charged,"* covering
"Ethereum, Base, Polygon, and Arbitrum, plus their testnets (Sepolia, Base Sepolia,
Polygon Amoy, Arbitrum Sepolia)." The quickstart's phrasing is what sent me looking for a
faucet. The gas page is what stopped me. These are 4 clicks apart.

**F8 (surprise, handled) — `sponsored: true` breaks naive explorer verification.**
The receipt's `from` is `0xdcf4bac4bd805948168ff63483bc493894a29613` (a relayer) and `to`
is `0x5af5194b4b0909eb978e3cf1e25333852277f07d`, not my wallet and not WETH.
`eth_getCode(0xfd35…834c)` returns `0xef0100955d84139e7621bc571b117d8eb5d28a4a222c6f` —
an **EIP-7702 delegation designator** pointing at `0x955d8413…c6f`. So the org "EOA" is a
7702-delegated account driven by a forwarder, which is why `msg.sender` at WETH is still
`0xfd35…834c` even though neither the tx `from` nor `to` is that address. `/api/direct-execution`
does warn about this ("It won't appear in block explorer `txlist` for the wallet"), and
that warning is correct and load-bearing. Anyone verifying by eyeballing the wallet's
transaction list on Basescan will conclude nothing happened.

---

## 4. Result

- **Execution ID:** `ls1auzqql7mslxt8qf8uq`
- **Transaction hash:** `0x7c5876d4610c341d61262ceed0e77c7373a47938105a9d9a9d15166ebc479776`
- **Chain:** Base Sepolia, chainId 84532 (`eth_chainId` → `0x14a34`, confirmed)
- **Block:** 45341186 (`0x2b3da02`), gasUsed 67842, `sponsored: true`
- **Operation:** `WETH9.approve(0x000000000000000000000000000000000000dEaD, 1)` at the
  Base Sepolia WETH9 predeploy `0x4200000000000000000000000000000000000006`. Chosen
  deliberately: zero `value`, so it needs no funded balance, and it emits a decodable
  event *and* leaves a readable state change.
- **Explorer:** https://sepolia.basescan.org/tx/0x7c5876d4610c341d61262ceed0e77c7373a47938105a9d9a9d15166ebc479776

### Leg 1 — KeeperHub reports it (from `GET /api/execute/ls1auzqql7mslxt8qf8uq/status`)
```json
"status":"completed",
"transactionHash":"0x7c5876d4610c341d61262ceed0e77c7373a47938105a9d9a9d15166ebc479776",
"sponsored":true,
"receipts":[{"hash":"0x7c5876d4…9776","chainId":84532,"gasUsed":"67842",
             "verified":true,"verifiedAt":"2026-08-11T12:17:40.381Z",
             "blockNumber":45341186,"receiptStatus":"success"}]
```
Header `X-Poll-Interval-Hint: 0` (terminal). One poll was sufficient.

### Leg 2 — Public RPC agrees (`https://sepolia.base.org`, `eth_getTransactionReceipt`)
```
status       0x1
blockNumber  0x2b3da02  (45341186)
from         0xdcf4bac4bd805948168ff63483bc493894a29613
to           0x5af5194b4b0909eb978e3cf1e25333852277f07d
gasUsed      0x10902    (67842)
logs         1
```
Block number and gasUsed match KeeperHub's receipt exactly.

### Leg 3 — How the intended operation was proved to have run
Two independent proofs, event and state.

**(a) Decoded event.** The single log in the receipt:
```
address = 0x4200000000000000000000000000000000000006          (WETH9, Base Sepolia)
topic0  = 0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925
topic1  = 0x000000000000000000000000fd35ae935de7be93ffd585d6627268d833ed834c
topic2  = 0x0000000000000000000000000000000000000000000000000000000000dead
data    = 0x0000000000000000000000000000000000000000000000000000000000000001
```
I computed the topic hash myself rather than trusting a library or explorer: a pure-python
keccak-256, self-tested against the known vector
`keccak256("") = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470`, gives
`keccak256("Approval(address,address,uint256)") = 8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925`
— byte-identical to `topic0`. Decoded: `Approval(owner = 0xfd35ae935dE7Be93ffd585D6627268D833ed834c,
spender = 0x…dEaD, value = 1)`. `owner` is the KeeperHub org wallet, i.e. `msg.sender` at
WETH was my account, which is exactly the operation requested.

**(b) State change across the block boundary.** `eth_call` of
`allowance(0xfd35…834c, 0x…dEaD)` (`0xdd62ed3e…`) at WETH9:
```
at block 0x2b3da01 (45341185, parent) → 0x…0000   (0)
at latest                             → 0x…0001   (1)
```
The storage slot changed from 0 to 1 across exactly the block containing the transaction.
That is the intended operation, not a restatement of the receipt.

---

## 5. What would have saved me the most time

One sentence, placed where the failure actually happens: *"On testnets gas is sponsored, so
a zero-`value` call needs no funded wallet — only calls that move native value require a
balance."* The insufficient-balance error told me to go find a faucet and fund
`0xfd35…834c`. If I had believed it, this run would have gone from five minutes to however
long a Base Sepolia faucet takes, which is usually far longer and sometimes fails outright
because faucets gate on a mainnet-funded address. The correct information exists, but it
lives in `/wallet-management/gas`, four clicks from the error, and the quickstart page a
new builder actually reads says sponsorship is "on mainnet" — which reads as *not* on
testnets. Same for `/getting-started/api`: it teaches the workflow-execute path, so I only
found `/api/execute/contract-call` by reading the `/api` index, and I only found
`/guides/first-verified-transaction` (which is genuinely excellent, and is the page that
defines "verified" correctly) by scraping `href=` out of rendered HTML because there is no
sitemap. Second-biggest saver would be a worked, copy-pasteable zero-value testnet example
in the quickstart — a concrete `contractAddress` / `functionName` / `abi` on Base Sepolia
that is known to succeed. Picking WETH9 `approve` was my own judgement call about what
would be free, non-reverting, and cheaply verifiable; a builder who guesses wrong here
burns attempts and possibly puts failed transactions onchain. Third: label the sponsored
7702/forwarder path loudly at the top of the status response, not only in a prose note —
the receipt's `from` and `to` are both addresses the user has never seen, and the natural
"check it on Basescan" instinct shows an empty transaction list for their wallet.

---

## Notes on protocol compliance
- Nothing under the treatment-arm directory was read, listed, or referenced. The API key
  was loaded into the shell with the prescribed `grep | cut` extraction only, never
  printed, and appears in no file.
- Base Sepolia only. `eth_chainId` from the public RPC returned `0x14a34` = 84532 and every
  request carried `chainId: 84532`. No mainnet call was made at any point.
- Exactly one transaction was put onchain. The one `Idempotency-Key` used was never reused
  with a different body.
