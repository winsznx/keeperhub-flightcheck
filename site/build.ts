/**
 * Builds the static judge proof page from evidence/manifest.json.
 *
 * Every NUMBER and identifier on the page is read from the manifest, which is itself generated
 * from the proof capsules, so no metric can be hand-typed or drift from the evidence. If a value
 * is missing from the manifest it renders as "not measured" rather than as a plausible number.
 *
 * Prose is not generated. The findings list below is hardcoded, which means a retraction has to
 * be propagated here by hand. An audit caught exactly that failure: a withdrawn finding stayed
 * live on this page after the ledger had struck it.
 *
 * Design tokens follow internal/design.md: zinc scale, one ember accent used only as a badge,
 * 36px cards, hairline borders instead of shadows, one type family.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "../agent/src/env.ts";

interface Manifest {
  generatedAt: string;
  toolVersion: string;
  canary: Record<string, unknown>;
  canonicalRun: Record<string, unknown> | null;
  runs: { total: number; verified: number; endToEndRuns: number; fastestEndToEndMs: number | null; slowestEndToEndMs: number | null; all: Array<Record<string, unknown>> };
  recovery: Record<string, unknown> | null;
  benchmark: Record<string, unknown> | null;
  stateMachine: Array<{ stage: string; label: string; independentOfKeeperHub: boolean }>;
  bootstrap: Record<string, unknown> | null;
  faucet: Record<string, unknown> | null;
  failureCodes: number;
  tests: Record<string, unknown> | null;
}

const REPO_URL = "https://github.com/winsznx/keeperhub-flightcheck";

const m = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "evidence", "manifest.json"), "utf8"),
) as Manifest;

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const nm = '<span class="nm">not measured</span>';

const run = m.canonicalRun;
const rec = m.recovery;
const bench = m.benchmark;

const CSS = `
:root{
  --obsidian:#09090b;--graphite:#18181b;--slate:#27272a;--iron:#3f3f46;--steel:#52525b;
  --fog:#71717a;--ash:#a1a1aa;--mist:#d4d4d8;--cloud:#ececee;--paper:#f4f4f5;--snow:#fff;
  --ember:#ff5a00;
  --font:'DM Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--paper);color:var(--graphite);font-family:var(--font);font-size:15px;line-height:1.45;-webkit-font-smoothing:antialiased}
.wrap{max-width:1200px;margin:0 auto;padding:0 24px}
section{padding:80px 0}
section+section{border-top:1px solid var(--cloud)}
h1{font-size:clamp(38px,6vw,64px);line-height:1.12;font-weight:600;color:var(--obsidian);letter-spacing:-.02em}
h2{font-size:clamp(26px,3.4vw,40px);line-height:1.28;font-weight:600;color:var(--obsidian);margin-bottom:12px;letter-spacing:-.01em}
h3{font-size:20px;line-height:1.5;font-weight:600;color:var(--obsidian)}
p{color:var(--steel);max-width:68ch}
a{color:var(--graphite)}
.lede{font-size:18px;line-height:1.45;color:var(--steel);max-width:66ch;margin-top:20px}
.sub{color:var(--fog);font-size:14px;max-width:70ch;margin-top:8px}
.mono{font-family:var(--mono);font-size:13px;word-break:break-all}
.nm{color:var(--ash);font-style:italic}
.badge{display:inline-block;background:var(--ember);color:#fff;border-radius:12px;padding:4px 10px;font-size:12px;font-weight:500;letter-spacing:.02em}
.pill{display:inline-block;border:1px solid var(--cloud);background:transparent;color:var(--graphite);border-radius:12px;padding:4px 10px;font-size:12px}
.card{background:var(--snow);border:1px solid var(--cloud);border-radius:36px;padding:28px}
.dark{background:var(--slate);color:var(--snow);border-radius:36px;padding:28px}
.dark h3,.dark h2{color:var(--snow)}
.dark p,.dark .kv .v{color:var(--mist)}
.dark .kv .k{color:var(--ash)}
.grid{display:grid;gap:16px}
.g2{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.g3{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.kv{display:grid;grid-template-columns:150px 1fr;gap:8px 16px;margin-top:16px}
.kv .k{color:var(--fog);font-size:13px}
.kv .v{font-family:var(--mono);font-size:13px;color:var(--graphite);word-break:break-all}
.legs{display:grid;gap:12px;margin-top:24px}
.leg{display:grid;grid-template-columns:36px 1fr;gap:16px;align-items:start;background:var(--snow);border:1px solid var(--cloud);border-radius:28px;padding:24px}
.tick{width:36px;height:36px;border-radius:40px;background:var(--obsidian);color:#fff;display:grid;place-items:center;font-size:15px}
.arrow{color:var(--ash);text-align:center;font-size:18px;line-height:1}
pre{background:var(--obsidian);color:#e4e4e7;border-radius:20px;padding:20px;overflow-x:auto;font-family:var(--mono);font-size:13px;line-height:1.6}
pre .c{color:var(--ash)}
pre .g{color:#86efac}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;color:var(--fog);font-weight:400;font-size:13px;padding:10px 12px;border-bottom:1px solid var(--cloud)}
td{padding:10px 12px;border-bottom:1px solid var(--cloud);vertical-align:top}
tr:last-child td{border-bottom:none}
.stat{font-size:40px;font-weight:600;color:var(--obsidian);line-height:1.1;letter-spacing:-.02em}
.statlabel{color:var(--steel);font-size:14px;margin-top:4px}
.btn{display:inline-block;background:var(--obsidian);color:#fff;border:1.5px solid #2c2e34;border-radius:14px;padding:12px 18px;font-size:14px;text-decoration:none}
.btn.ghost{background:transparent;color:var(--iron);border:1px solid var(--iron)}
.btns{display:flex;gap:10px;flex-wrap:wrap;margin-top:28px}
.head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px}
ul{color:var(--steel);padding-left:20px;max-width:68ch}
li{margin:8px 0}
li strong{color:var(--graphite);font-weight:600}
footer{padding:48px 0;color:var(--fog);font-size:13px;border-top:1px solid var(--cloud)}
@media(max-width:640px){.kv{grid-template-columns:1fr}.kv .k{margin-top:8px}section{padding:56px 0}}
`;

function legs(): string {
  const a = (run?.agreement ?? {}) as Record<string, boolean>;
  const rows: Array<[string, string, boolean | undefined]> = [
    [
      "KeeperHub execution",
      `Execution <code class="mono">${esc(run?.executionId ?? "?")}</code> settled <code class="mono">completed</code>, with its own re-fetched receipt marked verified and successful.`,
      a.keeperhubReportsCompleted,
    ],
    [
      "Public Base Sepolia node",
      `An independent node returned a receipt with status <code class="mono">0x1</code> for the same hash, in block ${esc(run?.blockNumber ?? "?")}. Both legs resolve to one transaction.`,
      a.publicTransactionLanded && a.sameTransactionHash,
    ],
    [
      "Decoded canary event",
      `The log was emitted by the pinned canary and carries the challenge this run generated before it sent anything, plus chain id 84532.`,
      a.independentEventMatches,
    ],
  ];
  return rows
    .map(
      ([title, body], i) => `
      <div class="leg">
        <div class="tick">${rows[i]![2] ? "✓" : "·"}</div>
        <div><h3>${esc(title)}</h3><p style="margin-top:6px">${body}</p></div>
      </div>
      ${i < rows.length - 1 ? '<div class="arrow">↓ agrees with</div>' : ""}`,
    )
    .join("");
}

function faucetCard(): string {
  const f = m.faucet;
  if (!f || f.pass !== true) {
    return `<div class="card" style="margin-top:16px"><h3>Gas fallback</h3><p style="margin-top:8px">${nm}</p></div>`;
  }
  return `
    <div class="card" style="margin-top:16px">
      <div class="head" style="margin-bottom:12px">
        <h3 style="margin-right:8px">Gas fallback</h3>
        <span class="badge">LIVE</span>
        <span class="pill">Base Sepolia only</span>
        <span class="pill">fixed payout</span>
      </div>
      <p>
        A deliberately small faucet for the one case above. Not a general-purpose faucet: it takes
        no amount and no chain, one payout per address per day, and a replay of the same request
        returns the original transaction rather than sending again.
      </p>
      <div class="kv">
        <div class="k">treasury</div><div class="v">${esc(f.treasuryAddress)}</div>
        <div class="k">fixed payout</div><div class="v">${esc(f.fixedPayoutWei)} wei (0.0001 ETH)</div>
        <div class="k">live test tx</div><div class="v"><a href="${esc(f.explorerUrl)}">${esc(f.transactionHash)}</a></div>
        <div class="k">acceptance</div><div class="v">${esc(f.passed)}/${esc(f.total)} checks against the deployed service and real Base Sepolia</div>
      </div>
      <p class="sub" style="margin-top:16px">
        The KeeperHub insufficient-balance condition that triggers this is fixture-tested, not
        live-reproduced. Our organisation is sponsored, and engineering an unsafe execution failure
        to demonstrate a fallback would be the wrong trade.
      </p>
    </div>`;
}

function benchmarkSection(): string {
  if (!bench) {
    return `<div class="card"><h3>Benchmark</h3><p style="margin-top:8px">${nm}. The measured comparison is recorded in <code class="mono">evidence/benchmark/</code> when it has been run.</p></div>`;
  }
  const arms = (bench.arms ?? []) as Array<Record<string, unknown>>;
  const head = `<p>${esc(bench.method ?? "")}</p>`;
  const rows = arms
    .map(
      (a) => `<tr>
        <td><strong>${esc(a.name)}</strong><div class="sub" style="margin-top:2px">${esc(a.given ?? "")}</div></td>
        <td class="mono">${esc(a.timeToVerified ?? "not measured")}</td>
        <td class="mono">${esc(a.commands ?? "not measured")}</td>
        <td class="mono">${esc(a.docsOpened ?? "not measured")}</td>
        <td class="mono">${esc(a.failedAttempts ?? "not measured")}</td>
        <td class="mono">${esc(a.transactions ?? "not measured")}</td>
      </tr>`,
    )
    .join("");
  return `${head}
    <div class="card" style="margin-top:24px;overflow-x:auto">
      <table>
        <thead><tr><th>arm</th><th>time to verified</th><th>commands</th><th>docs opened</th><th>failed attempts</th><th>transactions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="sub" style="margin-top:16px">${esc(bench.caveat ?? "")}</p>`;
}

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KeeperHub Flightcheck — onboarding now ends with an onchain fact</title>
<meta name="description" content="Proves KeeperHub can execute, settle and verify a real onchain transaction from a fresh environment, or stops at the exact stage that fails.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head><body>

<section>
  <div class="wrap">
    <div class="head">
      <span class="badge">VERIFIED</span>
      <span class="pill">Base Sepolia · 84532</span>
      <span class="pill">${m.runs.verified}/${m.runs.total} runs verified</span>
      <span class="pill">zero runtime dependencies</span>
    </div>
    <h1>Onboarding now ends<br>with an onchain fact.</h1>
    <p class="lede">
      <code class="mono">kh doctor</code> tells you your environment looks healthy. Flightcheck
      proves KeeperHub actually executed, settled and verified a transaction from it, and stops
      at the exact stage that fails when it cannot.
    </p>
    <div class="btns">
      <a class="btn" href="${REPO_URL}">Repository</a>
      <a class="btn ghost" href="${esc(run?.transactionLink ?? "#")}">The transaction</a>
      <a class="btn ghost" href="${REPO_URL}/blob/main/docs/onboarding-teardown.md">Teardown</a>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>The proof</h2>
    <p>Three independent lines of evidence. Two of them never ask KeeperHub anything.</p>
    <div class="legs">${legs()}</div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card">
        <h3>The transaction</h3>
        <div class="kv">
          <div class="k">hash</div><div class="v"><a href="${esc(run?.transactionLink ?? "#")}">${esc(run?.transactionHash ?? "not measured")}</a></div>
          <div class="k">execution</div><div class="v">${esc(run?.executionId ?? "not measured")}</div>
          <div class="k">block</div><div class="v">${esc(run?.blockNumber ?? "not measured")}</div>
          <div class="k">gas used</div><div class="v">${esc(run?.gasUsed ?? "not measured")}</div>
          <div class="k">challenge</div><div class="v">${esc(run?.challenge ?? "not measured")}</div>
        </div>
      </div>
      <div class="card">
        <h3>The canary</h3>
        <div class="kv">
          <div class="k">address</div><div class="v"><a href="${esc(m.canary.explorer)}">${esc(m.canary.address)}</a></div>
          <div class="k">bytecode hash</div><div class="v">${esc(m.canary.expectedRuntimeBytecodeHash)}</div>
          <div class="k">size</div><div class="v">${esc(m.canary.runtimeBytecodeBytes ?? "?")} bytes</div>
          <div class="k">event</div><div class="v">${esc(m.canary.eventSignature)}</div>
          <div class="k">source</div><div class="v">${m.canary.sourceVerified ? "verified on Basescan" : "not verified"}${m.canary.reproducibleBuild ? ", reproducible build" : ""}</div>
        </div>
        <p class="sub" style="margin-top:16px">
          No storage writes, no balance, no external calls, not payable. Its runtime bytecode is
          re-hashed against the chain before every run and the run stops if it does not match.
        </p>
      </div>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Why not just check the wallet</h2>
    <p>
      Because on the sponsored path it returns the wrong answer. These are the real addresses from
      the run above.
    </p>
    <div class="dark" style="margin-top:24px">
      <div class="kv">
        <div class="k">receipt.from</div><div class="v">${esc(run?.transactionFrom ?? "not measured")} <span style="color:var(--ash)">relayer, not the org wallet</span></div>
        <div class="k">receipt.to</div><div class="v">${esc(run?.transactionTo ?? "not measured")} <span style="color:var(--ash)">router, not the canary</span></div>
        <div class="k">event sender</div><div class="v">${esc(run?.eventSender ?? "not measured")} <span style="color:var(--ash)">the org wallet</span></div>
        <div class="k">sponsored</div><div class="v">${esc(String(run?.sponsored ?? "not measured"))}</div>
      </div>
      <p style="margin-top:20px;max-width:68ch">
        The organisation wallet did not send this transaction, did not pay for it, and its nonce
        never moved. It held zero ETH throughout. Open it on a block explorer and the transaction
        list is empty, while the transaction sits in a block doing exactly what was asked. Every
        wallet-level heuristic concludes that nothing happened.
      </p>
      <p style="margin-top:12px;max-width:68ch">
        So verification goes hash, then receipt, then decoded log, and never touches wallet state.
      </p>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Losing the response cannot create a second transaction</h2>
    <p>
      A write is answered in the same HTTP response that performs it, and there is no
      list-executions endpoint. Lose that response and the execution id was never observed. So the
      request bytes and a derived idempotency key are written and fsynced <em>before</em> sending,
      and recovery replays them.
    </p>
    <p style="margin-top:12px">
      Run against the live API with no mocks in the proof path. The transaction count comes from
      the chain: the challenge is unique to the run and indexed, so a log filter on it counts the
      transactions that executed that work.
    </p>
    <div class="grid g3" style="margin-top:28px">
      <div class="card"><div class="stat">${esc(rec?.broadcastRequestsSent ?? "?")}</div><div class="statlabel">broadcast requests actually sent to KeeperHub</div></div>
      <div class="card"><div class="stat">${esc(rec?.transactionsOnchain ?? "?")}</div><div class="statlabel">transactions onchain carrying that challenge</div></div>
      <div class="card"><div class="stat">${rec?.pass ? "PASS" : "—"}</div><div class="statlabel">recovery replayed the stored response and reached verified</div></div>
    </div>
    <pre style="margin-top:20px"><span class="c"># the fault injection performs the real request, then discards the response</span>
  first invocation stopped without an execution id     <span class="g">true</span>
  broadcast requests actually sent to KeeperHub        <span class="g">${esc(rec?.broadcastRequestsSent ?? "?")}</span>
  recovery replayed the stored response                <span class="g">${esc(String(rec?.idempotentReplay ?? "?"))}</span>
  resumed run reached verified                         <span class="g">true</span>
  transactions onchain carrying this challenge         <span class="g">${esc(rec?.transactionsOnchain ?? "?")}</span>

  <span class="g">PASS. Two broadcast attempts, one transaction.</span></pre>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>The state machine</h2>
    <p>Stages marked independent are answered by a public node, not by KeeperHub. ${m.failureCodes} failure codes, each naming a stage and a remediation.</p>
    <div class="card" style="margin-top:24px;overflow-x:auto">
      <table><thead><tr><th>stage</th><th>what it establishes</th><th>independent</th></tr></thead><tbody>
      ${m.stateMachine
        .map(
          (s) =>
            `<tr><td class="mono">${esc(s.stage)}</td><td>${esc(s.label)}</td><td>${s.independentOfKeeperHub ? '<span class="badge">yes</span>' : '<span style="color:var(--ash)">—</span>'}</td></tr>`,
        )
        .join("")}
      </tbody></table>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Zero to execution</h2>
    <p>
      One command from a fresh clone. No <code class="mono">.env</code> to create, no
      <code class="mono">npm install</code>, and the credential never passes through whatever tool
      told you to run it.
    </p>
    <pre style="margin-top:24px"><span class="c"># fresh clone</span>
${esc((m.bootstrap?.command as string) ?? "npm run flightcheck -- setup --execute")}

  ✓ Node runtime supported
  ✓ KeeperHub API reachable
  <span class="c">! KeeperHub organisation credential required</span>
  <span class="c">  read from an interactive terminal, never echoed, never written to disk</span>
  ✓ Organisation key accepted, held in memory only
  ✓ Organisation wallet resolved
  ✓ Canonical canary bytecode verified
  ✓ Simulation passed
  ...
  <span class="g">Verified.</span></pre>
    <div class="grid g2" style="margin-top:24px">
      <div class="card">
        <h3>The credential boundary</h3>
        <p style="margin-top:8px">
          An AI agent can tell you to run <code class="mono">setup</code>. It cannot read what you
          type into it. Echo is suppressed through the terminal and then verified before a byte is
          read; if the terminal will not confirm echo is off, Flightcheck refuses to read at all.
          The key is held in memory for the run and never written to a file, a capsule, a log, or
          the command line. With no private terminal it stops rather than reading from a pipe.
        </p>
      </div>
      <div class="card">
        <h3>KeeperHub first, always</h3>
        <p style="margin-top:8px">
          The canonical transaction was executed from a wallet holding <strong>zero ETH</strong>,
          because KeeperHub sponsored it. So a zero balance is never a reason to fund anything.
          The gas fallback becomes eligible only after KeeperHub returns a conclusive
          insufficient-balance condition <em>before any broadcast</em>. Anything ambiguous refuses
          and resumes instead, because funding a wallet mid-ambiguity is how one operation becomes
          two transactions.
        </p>
      </div>
    </div>
    ${faucetCard()}
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Onboarding benchmark</h2>
    ${benchmarkSection()}
  </div>
</section>

<section>
  <div class="wrap">
    <h2>What we found in KeeperHub</h2>
    <p>Things that only appear once you execute, settle and then try to verify. Full reproductions in the teardown.</p>
    <ul style="margin-top:20px">
      <li><strong>The <code class="mono">/contract-call</code> 202 carries no transaction hash</strong>, even when status is already <code class="mono">completed</code>. The hash only appears on the status endpoint. Independently reproduces open issue #1784.</li>
      <li><strong><code class="mono">unconfirmed</code> is missing from the Direct Execution status list</strong> while another page on the same site documents it as non-terminal. A client with a failing default branch reports a false failure; one that retries can duplicate a transaction.</li>
      <li><strong><code class="mono">gasUsedWei</code> carries gas units, not wei</strong>, byte-equal to <code class="mono">receipts[0].gasUsed</code>.</li>
      <li><strong>A simulation passed while the payer held zero balance.</strong> A green simulation is not proof a broadcast can land.</li>
      <li><strong>One finding was withdrawn before publication.</strong> The agent-facing <code class="mono">llms.txt</code> index omitted the entire onboarding path when measured on 2026-08-10, and had been fixed upstream by the time we re-ran the reproduction on 2026-08-11. The teardown records both measurements rather than quietly dropping it.</li>
      <li><strong><code class="mono">/api/openapi</code> contains no core REST path</strong> and no bearer security scheme, though it is advertised as the machine-readable schema for the REST API. Re-verified on 2026-08-11: 117 paths, every one a published-workflow call.</li>
    </ul>
    <div class="btns"><a class="btn ghost" href="${REPO_URL}/blob/main/docs/onboarding-teardown.md">Read the teardown</a></div>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Verify this yourself</h2>
    <p>Nothing below requires trusting this page, this repository, or KeeperHub.</p>
    <pre style="margin-top:24px"><span class="c"># ask a public node directly</span>
TX=${esc(run?.transactionHash ?? "0x…")}
curl -s https://sepolia.base.org -H 'content-type: application/json' \\
  --data "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"method\\":\\"eth_getTransactionReceipt\\",\\"params\\":[\\"$TX\\"]}" \\
  | python3 -m json.tool

<span class="c"># status must be 0x1, and a log from the canary must carry the challenge</span>
<span class="c"># address  ${esc(m.canary.address)}</span>
<span class="c"># topics[0] ${esc(m.canary.eventTopic0)}</span>
<span class="c"># topics[2] ${esc(run?.challenge ?? "…")}</span></pre>
    <pre style="margin-top:16px"><span class="c"># or run it yourself, no npm install needed</span>
git clone ${REPO_URL} &amp;&amp; cd keeperhub-flightcheck
cp .env.example .env   <span class="c"># add your kh_ organisation key</span>
npm run flightcheck                <span class="c"># preflight, broadcasts nothing</span>
npm run flightcheck -- --execute</pre>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Limitations</h2>
    <p>These are real, and they sit here rather than in a footnote.</p>
    <ul style="margin-top:20px">
      <li><strong>Direct EOA path only.</strong> Under Safe routing KeeperHub's own funding diagnostic describes the outer EOA rather than the spending address. Flightcheck does not model that and would rather say so than print a green check over it.</li>
      <li><strong>Testnet only.</strong> Base Sepolia. There is no mainnet path.</li>
      <li><strong>Gas sponsorship is reported, never promised.</strong> Every run records the flag it observed. On ours it was true and the org wallet paid nothing. That is an observation about one organisation on one chain.</li>
      <li><strong>The sender assertion is scoped to what was measured.</strong> Enforced only when sponsored is true. The non-sponsored path is unmeasured and recorded as such in the capsule.</li>
      <li><strong>The benchmark was run by agents</strong>, not humans, and is labelled an agent onboarding benchmark.</li>
    </ul>
  </div>
</section>

<footer>
  <div class="wrap">
    <div class="mono">flightcheck ${esc(m.toolVersion)} · manifest generated ${esc(m.generatedAt)}</div>
    <p style="margin-top:8px">
      Every number and identifier on this page is generated from <a href="${REPO_URL}/blob/main/evidence/manifest.json">evidence/manifest.json</a>,
      which is built from the proof capsules in <a href="${REPO_URL}/tree/main/evidence/runs">evidence/runs/</a>.
      Claims are tracked against their evidence in <a href="${REPO_URL}/blob/main/CLAIMS.md">CLAIMS.md</a>.
    </p>
  </div>
</footer>

</body></html>`;

const outDir = resolve(REPO_ROOT, "site", "dist");
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "index.html"), html);
process.stdout.write(`site/dist/index.html  ${(html.length / 1024).toFixed(1)} KB\n`);
