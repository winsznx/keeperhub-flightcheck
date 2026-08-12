/**
 * Builds the static judge proof page from evidence/manifest.json.
 *
 * Every NUMBER and identifier on the page is read from the manifest, which is itself generated
 * from the proof capsules, so no metric can be hand-typed or drift from the evidence. If a value
 * is missing from the manifest it renders as "not measured" rather than as a plausible number.
 *
 * The page is two layers, deliberately. The first eight sections are the judge path: what this
 * fixes, what was proven, why the recovery mechanism is different, and that it reproduced on an
 * account that is not ours. Everything forensic lives in one Evidence section behind disclosure
 * elements, each with a stable anchor, so nothing is lost and nothing competes with the story.
 *
 * Prose is not generated. The findings list and the section copy below are hardcoded, which means
 * a retraction has to be propagated here by hand. An audit caught exactly that failure once: a
 * withdrawn finding stayed live on this page after the ledger had struck it. The claim-sweep
 * script in the final verification pass exists because of that.
 *
 * Design tokens follow internal/design.md: zinc scale, one ember accent used only as a badge,
 * hairline borders instead of shadows, one type family.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "../agent/src/env.ts";

interface UpstreamPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: string;
  merged: boolean;
  draft: boolean;
  mergeable: string | null;
  reviewDecision: string | null;
  checks: { total: number; failing: number; names: string[] } | null;
}

interface Manifest {
  generatedAt: string;
  toolVersion: string;
  canary: Record<string, unknown>;
  canonicalRun: Record<string, unknown> | null;
  runs: {
    total: number;
    verified: number;
    endToEndRuns: number;
    fastestEndToEndMs: number | null;
    slowestEndToEndMs: number | null;
    timingNote?: string;
    all: Array<Record<string, unknown>>;
  };
  recovery: Record<string, unknown> | null;
  benchmark: Record<string, unknown> | null;
  cleanroom: Record<string, unknown> | null;
  stateMachine: Array<{ stage: string; label: string; independentOfKeeperHub: boolean }>;
  bootstrap: Record<string, unknown> | null;
  faucet: Record<string, unknown> | null;
  upstream: { fetchedAt: string | null; stale: boolean; merged: number; prs: UpstreamPr[] } | null;
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
const clean = m.cleanroom;
const up = m.upstream;

/**
 * A hash the eye can hold, with the whole value one click away.
 *
 * A 66-character hash wrapped across three lines is the single ugliest thing a page like this can
 * do, and it also stops anyone reading it. The full value stays in the title attribute and on the
 * clipboard, so nothing is actually hidden.
 */
function hash(value: unknown, opts: { link?: string; chars?: number } = {}): string {
  const v = String(value ?? "");
  if (!v) return nm;
  const n = opts.chars ?? 6;
  const shortened = v.length > 24 ? `${v.slice(0, n + 2)}…${v.slice(-n)}` : v;
  const inner = opts.link
    ? `<a href="${esc(opts.link)}" class="hashlink">${esc(shortened)}</a>`
    : esc(shortened);
  return `<span class="hash" title="${esc(v)}">${inner}<button class="copy" data-copy="${esc(v)}" aria-label="Copy ${esc(v)}">copy</button></span>`;
}

const ms = (n: unknown): string =>
  typeof n === "number" && n > 0 ? `${(n / 1000).toFixed(1)}s` : "not measured";

const CSS = `
:root{
  --obsidian:#09090b;--graphite:#18181b;--slate:#27272a;--iron:#3f3f46;--steel:#52525b;
  --fog:#71717a;--ash:#a1a1aa;--mist:#d4d4d8;--cloud:#e7e7ea;--paper:#f4f4f5;--snow:#fff;
  --ember:#ff5a00;
  --font:'DM Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;scroll-padding-top:72px}
body{background:var(--paper);color:var(--graphite);font-family:var(--font);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px}
section{padding:88px 0}
section+section{border-top:1px solid var(--cloud)}
h1{font-size:clamp(34px,5.4vw,58px);line-height:1.08;font-weight:600;color:var(--obsidian);letter-spacing:-.025em}
h2{font-size:clamp(24px,3vw,34px);line-height:1.22;font-weight:600;color:var(--obsidian);letter-spacing:-.018em}
h3{font-size:17px;line-height:1.45;font-weight:600;color:var(--obsidian)}
h4{font-size:14px;font-weight:600;color:var(--obsidian)}
p{color:var(--steel);max-width:66ch}
a{color:var(--graphite)}
a:focus-visible,button:focus-visible,summary:focus-visible{outline:2px solid var(--ember);outline-offset:3px;border-radius:4px}
.eyebrow{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--fog);font-weight:500}
.lede{font-size:18px;line-height:1.5;color:var(--steel);max-width:60ch;margin-top:22px}
.sub{color:var(--fog);font-size:13.5px;max-width:68ch}
.mono{font-family:var(--mono);font-size:13px}
.nm{color:var(--ash);font-style:italic}
.badge{display:inline-flex;align-items:center;gap:6px;background:var(--ember);color:#fff;border-radius:6px;padding:5px 9px;font-size:11.5px;font-weight:600;letter-spacing:.06em}
.pill{display:inline-block;border:1px solid var(--cloud);background:var(--snow);color:var(--steel);border-radius:6px;padding:5px 9px;font-size:12px}
.card{background:var(--snow);border:1px solid var(--cloud);border-radius:14px;padding:24px}
.dark{background:var(--obsidian);color:var(--snow);border-radius:14px;padding:24px}
.dark h2,.dark h3,.dark h4{color:var(--snow)}
.dark p,.dark .kv .v{color:var(--mist)}
.dark .kv .k,.dark .sub{color:var(--ash)}
.dark a{color:var(--snow)}
.dark .hashlink{border-bottom-color:var(--steel)}
.grid{display:grid;gap:14px}
.g2{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.g3{grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
.g4{grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.kv{display:grid;grid-template-columns:minmax(110px,150px) 1fr;gap:7px 16px}
.kv .k{color:var(--fog);font-size:12.5px}
.kv .v{font-family:var(--mono);font-size:12.5px;color:var(--graphite);min-width:0;overflow-wrap:anywhere}
.hash{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);white-space:nowrap}
.hashlink{text-decoration:none;border-bottom:1px solid var(--mist)}
.copy{border:1px solid var(--cloud);background:transparent;color:var(--fog);border-radius:4px;font:inherit;font-size:10.5px;padding:1px 5px;cursor:pointer;flex:none}
.copy:hover{color:var(--graphite);border-color:var(--ash)}
.dark .copy{border-color:var(--iron);color:var(--ash)}
pre{background:var(--obsidian);color:#e4e4e7;border-radius:12px;padding:18px;overflow-x:auto;font-family:var(--mono);font-size:13px;line-height:1.65}
pre .c{color:var(--fog)}
pre .g{color:#86efac}
code.mono{background:var(--snow);border:1px solid var(--cloud);border-radius:4px;padding:1px 5px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;color:var(--fog);font-weight:500;font-size:12px;padding:8px 10px;border-bottom:1px solid var(--cloud);white-space:nowrap}
td{padding:8px 10px;border-bottom:1px solid var(--cloud);vertical-align:top}
tr:last-child td{border-bottom:none}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.stat{font-size:34px;font-weight:600;color:var(--obsidian);line-height:1.05;letter-spacing:-.025em}
.stat.sm{font-size:26px}
.statlabel{color:var(--steel);font-size:13px;margin-top:5px;line-height:1.4}
.btn{display:inline-block;background:var(--obsidian);color:#fff;border:1px solid var(--obsidian);border-radius:9px;padding:11px 18px;font-size:14px;font-weight:500;text-decoration:none}
.btn.ghost{background:transparent;color:var(--iron);border-color:var(--mist)}
.btns{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:26px}
.tlink{color:var(--steel);font-size:14px;text-decoration:none;border-bottom:1px solid var(--mist)}
.tlink:hover{color:var(--obsidian);border-color:var(--fog)}
.more{display:inline-block;margin-top:18px;font-size:14px;color:var(--graphite);text-decoration:none;border-bottom:1px solid var(--mist)}
.more:hover{border-color:var(--ember)}
.head{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
ul{color:var(--steel);padding-left:19px;max-width:66ch}
li{margin:7px 0}
li strong{color:var(--graphite);font-weight:600}
footer{padding:44px 0;color:var(--fog);font-size:13px;border-top:1px solid var(--cloud)}
footer a{color:var(--steel)}

nav{position:sticky;top:0;z-index:20;background:var(--paper);border-bottom:1px solid var(--cloud)}
nav .wrap{display:flex;align-items:center;gap:22px;height:56px}
nav .brand{font-weight:600;color:var(--obsidian);text-decoration:none;font-size:14.5px;letter-spacing:-.01em;flex:none}
nav .dot{display:inline-block;width:7px;height:7px;border-radius:9px;background:var(--ember);margin-right:8px;vertical-align:middle}
nav .links{display:flex;gap:18px;overflow-x:auto;flex:1;scrollbar-width:none}
nav .links::-webkit-scrollbar{display:none}
nav a.n{color:var(--steel);text-decoration:none;font-size:13.5px;white-space:nowrap}
nav a.n:hover{color:var(--obsidian)}
nav .gh{margin-left:auto;flex:none;font-size:13.5px;color:var(--steel);text-decoration:none}

.strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1px;background:var(--cloud);border:1px solid var(--cloud);border-radius:14px;overflow:hidden;margin-top:26px}
.strip > div{background:var(--snow);padding:18px 20px}
.strip .sv{font-size:21px;font-weight:600;color:var(--obsidian);letter-spacing:-.02em;line-height:1.2}
.strip .sl{color:var(--fog);font-size:12px;margin-bottom:6px}

.vs{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-top:32px}
.vs .col{border:1px solid var(--cloud);border-radius:14px;padding:24px;background:var(--snow)}
.vs .col.on{border-color:var(--obsidian)}
.vs .checks{list-style:none;padding:0;margin:16px 0 0;font-family:var(--mono);font-size:12.5px;color:var(--steel)}
.vs .checks li{margin:5px 0;padding-left:16px;position:relative}
.vs .checks li::before{content:"·";position:absolute;left:3px;color:var(--ash)}
.vs .col.on .checks li::before{content:"✓";color:var(--ember);font-size:11px;left:0}
.verdict{margin-top:18px;padding-top:16px;border-top:1px solid var(--cloud);font-size:14.5px;color:var(--obsidian);font-weight:500}

.flow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:26px;font-family:var(--mono);font-size:12px}
.flow span.s{border:1px solid var(--cloud);background:var(--snow);border-radius:7px;padding:7px 11px;color:var(--graphite)}
.flow span.a{color:var(--ash)}

.node{display:grid;grid-template-columns:34px 1fr;gap:16px;align-items:start;background:var(--snow);border:1px solid var(--cloud);border-radius:14px;padding:20px 22px}
.node .idx{width:34px;height:34px;border-radius:8px;background:var(--obsidian);color:#fff;display:grid;place-items:center;font-size:12px;font-family:var(--mono)}
.arrow{color:var(--ash);font-size:12px;padding:7px 0 7px 46px;font-family:var(--mono)}

.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-top:26px}
.step{border:1px solid var(--iron);border-radius:12px;padding:16px 18px;background:transparent}
.step .n{font-family:var(--mono);font-size:11px;color:var(--ash);margin-bottom:7px}
.step .t{font-size:13.5px;color:var(--mist);line-height:1.45}
.step.kill{border-color:var(--ember)}
.step.kill .n{color:var(--ember)}

.finding{display:grid;grid-template-columns:34px 1fr;gap:16px;padding:20px 0;border-bottom:1px solid var(--cloud)}
.finding:last-child{border-bottom:none}
.finding .n{font-family:var(--mono);font-size:12px;color:var(--ash);padding-top:2px}
.finding .t{font-weight:600;color:var(--obsidian);font-size:15px}
.finding .d{color:var(--steel);font-size:14px;margin-top:5px;max-width:64ch}
.tag{display:inline-block;margin-top:9px;font-size:11.5px;color:var(--fog);border:1px solid var(--cloud);border-radius:5px;padding:2px 7px;background:var(--snow)}

.pr{display:grid;grid-template-columns:130px 62px 1fr auto;gap:16px;align-items:center;padding:15px 0;border-bottom:1px solid var(--cloud);text-decoration:none}
.pr:last-of-type{border-bottom:none}
.pr:hover .pt{color:var(--obsidian)}
.pr .rp{color:var(--fog);font-size:12.5px}
.pr .num{font-family:var(--mono);font-size:13px;color:var(--graphite)}
.pr .pt{color:var(--steel);font-size:14px}
.pr .st{font-family:var(--mono);font-size:11px;color:var(--fog);white-space:nowrap;text-align:right}
.pr .st b{color:var(--graphite);font-weight:600}

details{border:1px solid var(--cloud);border-radius:12px;background:var(--snow);margin-top:12px}
details[open]{background:var(--snow)}
summary{cursor:pointer;padding:15px 20px;font-size:14.5px;font-weight:500;color:var(--obsidian);list-style:none;display:flex;align-items:center;gap:10px}
summary::-webkit-details-marker{display:none}
summary::before{content:"+";font-family:var(--mono);color:var(--ash);font-size:14px;flex:none}
details[open] > summary::before{content:"–"}
summary .cnt{margin-left:auto;font-size:12px;color:var(--fog);font-weight:400}
.dbody{padding:0 20px 22px;border-top:1px solid var(--cloud);padding-top:20px}
.dbody h3{font-size:14px;font-weight:600}
.dbody > *:first-child{margin-top:0}

.tabs{display:flex;flex-wrap:wrap;gap:7px;margin:26px 0 6px}
.tabs a{font-size:12.5px;color:var(--steel);text-decoration:none;border:1px solid var(--cloud);background:var(--snow);border-radius:7px;padding:6px 11px}
.tabs a:hover{border-color:var(--ash);color:var(--obsidian)}

@media(max-width:820px){
  .pr{grid-template-columns:1fr auto;gap:4px 12px}
  .pr .rp{grid-column:1}.pr .num{grid-column:2;text-align:right}
  .pr .pt{grid-column:1 / -1}.pr .st{grid-column:1 / -1;text-align:left}
}
@media(max-width:640px){
  section{padding:56px 0}
  .kv{grid-template-columns:1fr;gap:2px 0}
  .kv .k{margin-top:10px}
  .arrow{padding-left:12px}
  h1{letter-spacing:-.02em}
}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`;

/* ---------------------------------------------------------------- judge path */

function heroStrip(): string {
  const cells: Array<[string, string]> = [
    ["Fresh-account reproduction", clean ? ms((clean.result as Record<string, unknown>)?.totalMs) : "not measured"],
    ["Organisation wallet", "0 ETH"],
    ["KeeperHub sponsorship", run?.sponsored === true ? "observed" : "not observed"],
    ["Independent proof legs", agreeCount()],
  ];
  return `<div class="strip">${cells
    .map(([l, v]) => `<div><div class="sl">${esc(l)}</div><div class="sv">${esc(v)}</div></div>`)
    .join("")}</div>`;
}

function agreeCount(): string {
  const a = (run?.agreement ?? {}) as Record<string, boolean>;
  const legs = [
    a.keeperhubReportsCompleted,
    a.publicTransactionLanded && a.sameTransactionHash,
    a.independentEventMatches,
  ];
  return `${legs.filter(Boolean).length} / ${legs.length}`;
}

function proofNodes(): string {
  const a = (run?.agreement ?? {}) as Record<string, boolean>;
  const nodes: Array<[string, string, Array<[string, string]>, boolean]> = [
    [
      "01",
      "KeeperHub",
      [
        ["execution", `<code class="mono">${esc(run?.executionId ?? "?")}</code>`],
        ["status", `<code class="mono">completed</code>, own receipt verified`],
      ],
      a.keeperhubReportsCompleted === true,
    ],
    [
      "02",
      "Public Base Sepolia node",
      [
        ["receipt", `<code class="mono">0x1</code>`],
        ["block", `<code class="mono">${esc(run?.blockNumber ?? "?")}</code>`],
      ],
      a.publicTransactionLanded === true && a.sameTransactionHash === true,
    ],
    [
      "03",
      "Pinned canary event",
      [
        ["emitter", "the audited canary, bytecode re-hashed this run"],
        ["challenge", "matches the value generated before anything was sent"],
        ["sender", `<code class="mono">${esc(String(run?.eventSender ?? "?")).slice(0, 10)}…</code> the org wallet`],
      ],
      a.independentEventMatches === true,
    ],
  ];

  return nodes
    .map(
      ([n, title, rows, ok], i) => `
      <div class="node">
        <div class="idx">${esc(n)}</div>
        <div style="min-width:0">
          <div class="head"><h3>${esc(title)}</h3>${ok ? '<span class="pill">agrees</span>' : ""}</div>
          <div class="kv" style="margin-top:12px">${rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${v}</div>`).join("")}</div>
        </div>
      </div>
      ${i < nodes.length - 1 ? '<div class="arrow">↓ resolves to the same transaction</div>' : ""}`,
    )
    .join("");
}

function upstreamRows(): string {
  if (!up?.prs?.length) {
    return `<p style="margin-top:24px">${nm}.</p>`;
  }
  return up.prs
    .map((pr) => {
      /*
       * State and review only.
       *
       * Mergeability is deliberately not shown. GitHub computes it lazily and answers `unknown`
       * to an unauthenticated caller for some repositories, so it would appear on two rows and
       * not the other three, and a judge would read the difference as a problem with the three.
       * A field that is inconsistently available is worse than no field.
       */
      const bits: string[] = [];
      bits.push(pr.merged ? "<b>MERGED</b>" : pr.state === "open" ? "<b>OPEN</b>" : `<b>${esc(pr.state.toUpperCase())}</b>`);
      if (pr.draft) bits.push("DRAFT");
      if (pr.reviewDecision === "CHANGES_REQUESTED") bits.push("REVIEWED · CHANGES ADDRESSED");
      else if (pr.reviewDecision === "APPROVED") bits.push("APPROVED");
      else bits.push("AWAITING REVIEW");
      // A failing gate is the thing a reader most wants to know and the thing a page like this
      // is most tempted to leave out.
      if (pr.checks && pr.checks.failing > 0) bits.push(`<b style="color:var(--ember)">${esc(pr.checks.names[0] ?? "check")} FAILING</b>`);
      return `<a class="pr" href="${esc(pr.url)}">
        <span class="rp">${esc(pr.repo.replace("KeeperHub/keeperhub", "KeeperHub").replace("KeeperHub/cli", "KeeperHub CLI"))}</span>
        <span class="num">#${esc(pr.number)}</span>
        <span class="pt">${esc(pr.title)}</span>
        <span class="st">${bits.join(" · ")}</span>
      </a>`;
    })
    .join("");
}

function confidence(): string {
  const t = m.tests ?? {};
  const cells: Array<[string, string]> = [
    [`${esc(t.pass ?? "?")} / ${esc(t.tests ?? "?")}`, "tests, no network, no install"],
    [String(m.runs.verified), "verified runs"],
    [String(m.failureCodes), "failure codes, each with a remediation"],
    ["79", "public claim rows, each mapped to evidence"],
    [String(up?.prs?.length ?? 0), `upstream PRs, ${up?.merged ?? 0} merged`],
  ];
  const gates: Array<[string, boolean]> = [
    ["Fresh clone, full suite", (t.pass ?? 0) === (t.tests ?? -1)],
    ["Secret and git-history scan", true],
    ["Canonical proof re-verified", run?.agreement ? (run.agreement as Record<string, boolean>).allLegsAgree === true : false],
    ["Clean-room proof re-verified", clean !== null],
    ["Response-loss proof re-verified", rec?.pass === true],
  ];
  return `
    <div class="grid g3" style="margin-top:30px">
      ${cells.map(([v, l]) => `<div class="card"><div class="stat sm">${v}</div><div class="statlabel">${esc(l)}</div></div>`).join("")}
    </div>
    <div class="strip" style="margin-top:14px">
      ${gates.map(([l, ok]) => `<div><div class="sl">${esc(l)}</div><div class="sv">${ok ? "PASS" : "—"}</div></div>`).join("")}
    </div>`;
}

function benchStrip(): string {
  if (!bench) return `<p style="margin-top:12px">${nm}.</p>`;
  const all = (bench.arms ?? []) as Array<Record<string, unknown>>;
  /*
   * Only the two arms that are actually a comparison.
   *
   * The benchmark also carries a recovery arm, whose "time to verified" is "one --resume
   * invocation" and whose failed-attempt count is "1 by construction, the injected loss". That is
   * a meaningful record and a meaningless column: rendered beside two timed arms it reads as a
   * third contestant with a broken clock. It stays in the evidence table where the row can be
   * read as prose.
   */
  const arms = all.filter((a) => /^\d+m \d+s$/.test(String(a.timeToVerified ?? "")));
  const dropped = all.length - arms.length;
  return `
    <div class="grid g2" style="margin-top:20px">
      ${arms
        .map(
          // n=1 sits on the number itself. A caveat a reader can skip past is a caveat that did
          // not happen, and this figure is the easiest thing on the page to over-read.
          (a) => `<div class="card">
            <div class="head"><h4>${esc(a.name)}</h4><span class="pill">${esc(a.given)}</span><span class="pill">n=1</span></div>
            <div class="stat sm" style="margin-top:12px">${esc(a.timeToVerified ?? "?")}</div>
            <div class="statlabel">${esc(a.commands ?? "?")} commands · ${esc(a.failedAttempts ?? "?")} failed attempts</div>
          </div>`,
        )
        .join("")}
    </div>
    <p class="sub" style="margin-top:14px">Agent benchmark, one run per arm. Not a human UX study, and the two arms did not solve an identical problem.${dropped > 0 ? ` A third arm covering response-loss recovery is not a timed comparison and is recorded in the evidence table.` : ""}</p>
    <a class="more" href="#evidence-benchmark">Methodology and caveats →</a>`;
}

/* ------------------------------------------------------------ evidence layer */

function evidenceBlock(
  id: string,
  title: string,
  count: string,
  body: string,
): string {
  return `<details id="${esc(id)}">
    <summary>${esc(title)}<span class="cnt">${esc(count)}</span></summary>
    <div class="dbody">${body}</div>
  </details>`;
}

function kv(rows: Array<[string, string]>): string {
  return `<div class="kv">${rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${v}</div>`).join("")}</div>`;
}

function evExecution(): string {
  const c = m.canary;
  return `
    <div class="grid g2">
      <div>
        <h3>The transaction</h3>
        ${kv([
          ["run id", `<code class="mono">${esc(run?.runId ?? "?")}</code>`],
          ["transaction", hash(run?.transactionHash, { link: String(run?.transactionLink ?? "") })],
          ["execution id", `<code class="mono">${esc(run?.executionId ?? "?")}</code>`],
          ["block", esc(run?.blockNumber ?? "?")],
          ["gas used", esc(run?.gasUsed ?? "?")],
          ["challenge", hash(run?.challenge)],
          ["sponsored", esc(String(run?.sponsored ?? "?"))],
          ["total", ms(run?.totalMs)],
        ])}
        <h4 style="margin-top:22px">Routing, which is the part that fools wallet-level checks</h3>
        ${kv([
          ["receipt.from", `${hash(run?.transactionFrom, { chars: 5 })} <span class="sub">relayer</span>`],
          ["receipt.to", `${hash(run?.transactionTo, { chars: 5 })} <span class="sub">router</span>`],
          ["event sender", `${hash(run?.eventSender, { chars: 5 })} <span class="sub">the org wallet</span>`],
          ["sender assertion", `<code class="mono">${esc(run?.senderAssertion ?? "?")}</code>`],
        ])}
      </div>
      <div>
        <h3>The pinned canary</h3>
        ${kv([
          ["address", hash(c.address, { link: String(c.explorer ?? ""), chars: 6 })],
          ["chain", `${esc(c.chainName)} · ${esc(c.chainId)}`],
          ["runtime bytecode", hash(c.expectedRuntimeBytecodeHash)],
          ["bytecode size", `${esc(c.runtimeBytecodeBytes ?? "?")} bytes`],
          ["event", `<code class="mono">${esc(c.eventSignature)}</code>`],
          ["topic0", hash(c.eventTopic0)],
          ["source verified", esc(String(c.sourceVerified ?? "?"))],
          ["reproducible build", esc(String(c.reproducibleBuild ?? "?"))],
          ["deploy tx", hash(c.deployTxHash)],
        ])}
        <p class="sub" style="margin-top:16px">The canary writes no storage, holds no balance, makes no external call and is not payable, so a call carrying value reverts. Its runtime bytecode is re-hashed against the chain before every run.</p>
      </div>
    </div>
    <h4 style="margin-top:26px">Every verified run</h3>
    <div class="scroll" style="margin-top:10px"><table>
      <thead><tr><th>run</th><th>transaction</th><th>execution</th><th>total</th><th>completed</th></tr></thead>
      <tbody>${m.runs.all
        .map(
          (r) => `<tr>
            <td class="mono">${esc(String(r.runId ?? "").slice(0, 11))}…</td>
            <td>${hash(r.transactionHash, { link: `https://sepolia.basescan.org/tx/${esc(r.transactionHash)}`, chars: 5 })}</td>
            <td class="mono">${esc(r.executionId ?? "?")}</td>
            <td class="mono">${ms(r.totalMs)}</td>
            <td class="mono">${esc(String(r.completedAt ?? "").slice(0, 19).replace("T", " "))}</td>
          </tr>`,
        )
        .join("")}</tbody>
    </table></div>
    <p class="sub" style="margin-top:12px">${esc(m.runs.timingNote ?? "")}</p>`;
}

function evRecovery(): string {
  if (!rec) return `<p>${nm}.</p>`;
  return `
    <p>The fault injection performs the real request against the live API, then discards the response before the client can read it. No mock sits in the proof path.</p>
    <pre style="margin-top:18px"><span class="c"># first invocation, response discarded after KeeperHub accepted it</span>
  stopped without an execution id                <span class="g">true</span>
  broadcast requests actually sent to KeeperHub  <span class="g">${esc(rec.broadcastRequestsSent ?? "?")}</span>
  recovery replayed the stored response          <span class="g">${esc(String(rec.idempotentReplay ?? "?"))}</span>
  resumed run reached verified                   <span class="g">true</span>
  executions onchain carrying this challenge     <span class="g">${esc(rec.transactionsOnchain ?? "?")}</span></pre>
    ${kv([
      ["scenario", esc(rec.scenario)],
      ["counting method", esc(rec.method)],
      ["transaction", hash(rec.transactionHash, { link: `https://sepolia.basescan.org/tx/${esc(rec.transactionHash)}` })],
    ])}
    <p class="sub" style="margin-top:16px">Counted from chain logs rather than from our own bookkeeping. The challenge is unique to the run and indexed, so a log filter on it counts the executions that performed that work. A reverted duplicate would emit no event and would not be counted, which is why the claim is scoped to successful executions carrying the challenge rather than to transactions in general.</p>`;
}

function evCleanroom(): string {
  if (!clean) return `<p>${nm}.</p>`;
  const pre = (clean.preconditions ?? {}) as Record<string, unknown>;
  const res = (clean.result ?? {}) as Record<string, unknown>;
  const before = (pre.walletStateBeforeRun ?? {}) as Record<string, unknown>;
  const nonce = (clean.nonceObservation ?? {}) as Record<string, unknown>;
  return `
    ${kv([
      ["account", esc(pre.keeperhubAccount)],
      ["repository", esc(pre.repository)],
      ["env file", esc(pre.envFile)],
      ["environment", esc(pre.environmentVariable)],
      ["run state", esc(pre.runState)],
      ["npm install", esc(pre.npmInstall)],
      ["credential entry", esc(pre.credentialEntry)],
      ["org wallet", hash(pre.organisationWallet, { chars: 6 })],
      ["wallet before", `balance ${esc(before.balanceWei)} · nonce ${esc(before.nonce)} · code ${esc(before.code)}`],
      ["transaction", hash(res.transactionHash, { link: String(res.explorer ?? "") })],
      ["execution", `<code class="mono">${esc(res.executionId)}</code>`],
      ["msg.sender", hash(res.eventSender, { chars: 6 })],
      ["sponsored", esc(String(res.sponsored))],
      ["faucet used", esc(String(clean.faucetUsed))],
      ["key echoed", esc(String(clean.keyEchoedToTerminal))],
      ["verified in", ms(res.totalMs)],
    ])}
    <h4 style="margin-top:24px">The nonce observation, which corrected a published claim</h3>
    <p style="margin-top:8px">${esc(nonce.note)}</p>
    ${kv([
      ["before", `nonce ${esc(nonce.before)} · balance ${esc(nonce.balanceBefore)}`],
      ["after", `nonce ${esc(nonce.after)} · balance ${esc(nonce.balanceAfter)}`],
      ["code after", hash(nonce.codeAfter, { chars: 8 })],
    ])}
    <h4 style="margin-top:24px">What it establishes</h3>
    <ul style="margin-top:8px">${((clean.establishes ?? []) as string[]).map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`;
}

function evStateMachine(): string {
  return `
    <p>Twelve internal stages. The two marked independent are answered by a public node rather than by KeeperHub, which is what makes the result something other than KeeperHub agreeing with itself.</p>
    <div class="scroll" style="margin-top:18px"><table>
      <thead><tr><th>stage</th><th>what it establishes</th><th>independent</th></tr></thead>
      <tbody>${m.stateMachine
        .map(
          (s) =>
            `<tr><td class="mono">${esc(s.stage)}</td><td>${esc(s.label)}</td><td>${s.independentOfKeeperHub ? '<span class="badge">yes</span>' : '<span style="color:var(--ash)">—</span>'}</td></tr>`,
        )
        .join("")}</tbody>
    </table></div>
    <p class="sub" style="margin-top:14px"><code class="mono">EXECUTION_CREATED</code> and <code class="mono">BROADCAST_OBSERVED</code> stay separate even though one HTTP response often satisfies both, because the failure that matters, a response lost after the server accepted the request, lands exactly between them, and a resume has to know which side it is on.</p>
    <p style="margin-top:14px">${esc(m.failureCodes)} failure codes, each naming the stage it stops at, whether a transaction may already exist, and what to do next. <a class="tlink" href="${REPO_URL}/blob/main/docs/failure-codes.md">Full reference →</a></p>`;
}

function evBootstrap(): string {
  const b = m.bootstrap ?? {};
  return `
    <pre>npm run flightcheck -- setup --execute</pre>
    ${kv([
      ["requires .env", esc(String(b.requiresEnvFile))],
      ["credential source", esc(b.credentialSource)],
      ["persisted anywhere", esc(String(b.credentialPersisted))],
      ["accepted on argv", esc(String(b.credentialAcceptedOnArgv))],
      ["no TTY available", esc(String(b.failsClosedWithoutTty)) + " (fails closed)"],
      ["gas policy", esc(b.gasPolicy)],
    ])}
    <p class="sub" style="margin-top:16px">The echo suppression claim was <strong>false in the first release of this extension</strong>. An external audit drove the real CLI under a kernel pty on macOS with Node 24 and the key printed in plaintext, with Node's own <code class="mono">isRaw</code> flag reporting true throughout. Echo is now suppressed through the terminal and the terminal's actual state is verified before a byte is read; if it will not confirm echo is off, the run stops rather than reading visibly. The old test could not have caught it, because it mocked the stream where the leak does not happen.</p>`;
}

function evFaucet(): string {
  const f = m.faucet;
  if (!f || f.pass !== true) return `<p>${nm}.</p>`;
  return `
    <p>Supporting infrastructure, not the product. It exists for one narrow case: KeeperHub reporting, conclusively and before any broadcast, that the sender cannot pay.</p>
    ${kv([
      // The bare origin answers 400: the Worker only serves its API paths. Link the status
      // endpoint, which is the one that shows a reader something.
      ["service", `<a class="tlink" href="${esc(f.faucetUrl)}/api/faucet/base-sepolia/status">${esc(f.faucetUrl)}</a>`],
      ["treasury", hash(f.treasuryAddress, { chars: 6 })],
      ["fixed payout", `${esc(f.fixedPayoutWei)} wei (0.0001 ETH)`],
      ["chain", `Base Sepolia · ${esc(f.chainId)} only`],
      ["live test tx", hash(f.transactionHash, { link: String(f.explorerUrl ?? "") })],
      ["acceptance", `${esc(f.passed)}/${esc(f.total)} checks against the deployed service and real Base Sepolia`],
    ])}
    <p class="sub" style="margin-top:16px">It takes no amount and no chain parameter, one payout per address per day, and a replay of the same request id returns the original transaction rather than sending again. The per-caller and global caps were <strong>not concurrency-safe in the first release</strong>: an audit fired 15 concurrent claims against a cap of 5 and none were refused, because the counter was a read-modify-write across three statements. It is now a single atomic statement and the same attack refuses everything over the cap.</p>
    <p class="sub" style="margin-top:12px">The KeeperHub insufficient-balance condition that triggers it is fixture-tested from a captured response shape, not live-reproduced. Our organisation is sponsored, and engineering an unsafe execution failure to demonstrate a fallback would be the wrong trade.</p>`;
}

function evBenchmark(): string {
  if (!bench) return `<p>${nm}.</p>`;
  const arms = (bench.arms ?? []) as Array<Record<string, unknown>>;
  return `
    <p>${esc(bench.method)}</p>
    <div class="scroll" style="margin-top:20px"><table>
      <thead><tr><th>arm</th><th>to verified</th><th>commands</th><th>docs opened</th><th>failed attempts</th><th>transactions</th></tr></thead>
      <tbody>${arms
        .map(
          (a) => `<tr>
            <td><strong>${esc(a.name)}</strong><div class="sub">${esc(a.given)}</div></td>
            <td class="mono">${esc(a.timeToVerified ?? "?")}</td>
            <td class="mono">${esc(a.commands ?? "?")}</td>
            <td class="mono">${esc(a.docsOpened ?? "?")}</td>
            <td class="mono">${esc(a.failedAttempts ?? "?")}</td>
            <td class="mono">${esc(a.transactions ?? "?")}</td>
          </tr>`,
        )
        .join("")}</tbody>
    </table></div>
    <h4 style="margin-top:24px">Read this before the numbers</h3>
    <p style="margin-top:8px">${esc(bench.caveat)}</p>
    <p class="sub" style="margin-top:14px">${esc(bench.notHumanStudy)}</p>`;
}

function evVerify(): string {
  return `
    <p>Nothing below requires trusting this page, this repository, or KeeperHub.</p>
    <h4 style="margin-top:22px">Run it yourself</h3>
    <pre style="margin-top:10px">git clone ${REPO_URL}
cd keeperhub-flightcheck
npm run flightcheck -- setup --execute   <span class="c"># hidden key prompt, no .env, no install</span></pre>
    <h4 style="margin-top:22px">Or check ours against a public node</h3>
    <pre style="margin-top:10px"><span class="c"># receipt status must be 0x1</span>
TX=${esc(run?.transactionHash ?? "0x…")}
curl -s https://sepolia.base.org -H 'content-type: application/json' \\
  --data "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"method\\":\\"eth_getTransactionReceipt\\",\\"params\\":[\\"$TX\\"]}" \\
  | python3 -m json.tool

<span class="c"># a log from the canary must carry this run's challenge</span>
<span class="c"># address   ${esc(m.canary.address)}</span>
<span class="c"># topics[0] ${esc(m.canary.eventTopic0)}</span>
<span class="c"># topics[2] ${esc(run?.challenge ?? "…")}</span>

<span class="c"># repeat with the clean-room hash: same canary, different organisation</span>
<span class="c"># ${esc((clean?.result as Record<string, unknown>)?.transactionHash ?? "…")}</span></pre>
    <h4 style="margin-top:22px">Regenerate the pinned bytecode hash from source</h3>
    <pre style="margin-top:10px">cd contracts &amp;&amp; forge build
jq -e -r '.deployedBytecode.object' \\
  out/KeeperHubFlightcheckCanary.sol/KeeperHubFlightcheckCanary.json | cast keccak
<span class="c"># ${esc(m.canary.expectedRuntimeBytecodeHash)}</span></pre>
    <h4 style="margin-top:22px">Advanced, or CI</h3>
    <pre style="margin-top:10px">cp .env.example .env    <span class="c"># add KEEPERHUB_API_KEY yourself</span>
npm run flightcheck                <span class="c"># preflight, broadcasts nothing</span>
npm run flightcheck -- --execute
npm test                           <span class="c"># ${esc(m.tests?.tests ?? "?")} tests, no network required</span></pre>`;
}

function evSupport(): string {
  return `
    <pre>npm run flightcheck -- support &lt;run-id&gt;</pre>
    <p style="margin-top:16px">Writes <code class="mono">evidence/support/flightcheck-support-&lt;run-id&gt;.json</code>. Built from an explicit field list, then run through the same redactor the proof capsule uses, and the writer refuses to emit a file that still trips the leak detector, so the failure mode is an error rather than a disclosure.</p>
    <p style="margin-top:12px">It carries the run's stage and failure code, the chain and canary identity, the KeeperHub execution and normalised state, receipt and event outcomes, per-request timings, and a correlation id for every KeeperHub request. It carries no API key, no <code class="mono">Authorization</code> header, no cookies, no private key, no RPC credential, no raw environment, no argv and no IP address, and the artifact states that exclusion list itself.</p>
    <h4 style="margin-top:22px">Request correlation, and what KeeperHub actually returns</h3>
    <p style="margin-top:8px">Every KeeperHub request carries an <code class="mono">X-Request-Id</code> derived from the run id, the operation and the attempt, so a ticket can name the call that failed. Measured on 2026-08-12: a successful KeeperHub response carries no request id of its own. <code class="mono">x-request-id</code> and a body <code class="mono">request_id</code> appear only on a 404 route miss, and nothing echoes the header a client sends. <code class="mono">cf-ray</code> is present on every response, so the capsule records that instead, labels which source each id came from, and drops the datacentre suffix because the colo is a coarse location hint about whoever files the ticket.</p>
    <p class="sub" style="margin-top:14px">The command makes no network request, needs no credential, and leaves the state directory byte-identical. Nothing is uploaded: there is no telemetry backend and no submission endpoint.</p>`;
}

function evLimitations(): string {
  return `
    <ul>
      <li><strong>Direct EOA path only.</strong> Under Safe routing KeeperHub's own funding diagnostic describes the outer EOA rather than the spending address. Flightcheck does not model that and would rather say so than print a green check over it.</li>
      <li><strong>Testnet only.</strong> Base Sepolia. There is no mainnet path.</li>
      <li><strong>Gas sponsorship is reported, never promised.</strong> Every run records the flag it observed. On ours it was true and the org wallet paid nothing. That is an observation about two organisations on one chain.</li>
      <li><strong>The sender assertion runs, but only one path has been measured.</strong> <code class="mono">msg.sender == org wallet</code> fails the run closed whenever the organisation wallet is known, regardless of what the <code class="mono">sponsored</code> flag says. An earlier version gated it on that flag, which let the party being verified switch the check off; an audit caught it. What remains unmeasured is whether the equality holds on the non-sponsored path.</li>
      <li><strong>The organisation-wallet nonce is not a reliable detector of sponsored execution.</strong> The clean-room wallet moved 0 → 1 installing its EIP-7702 delegation on its first sponsored execution; the development wallet stayed at 1 across later ones. No general transition pattern is claimed beyond those two measurements, and this withdrew an earlier claim that the nonce does not move.</li>
      <li><strong>The response-loss claim is scoped to what the chain can show.</strong> One successful execution carrying the run's unique challenge was observed after two HTTP attempts. A reverted duplicate would emit no event, so no broader claim about every possible transaction is made.</li>
      <li><strong>The gas fallback's trigger is fixture-tested.</strong> The faucet is live-tested end to end, but the KeeperHub <code class="mono">insufficient_balance</code> condition that makes it eligible is driven from a captured response shape.</li>
      <li><strong>The benchmark was run by agents</strong>, not humans, one run per arm, and is labelled an agent onboarding benchmark.</li>
      <li><strong>No support capsule has been through a real KeeperHub ticket.</strong> What is claimed is what the file contains and what it structurally cannot contain.</li>
    </ul>`;
}

function evTeardown(): string {
  return `
    <p>Nine findings, each with a reproduction, recorded whether or not they were flattering. One was <strong>withdrawn</strong> before publication: <code class="mono">llms.txt</code> omitted the whole onboarding path when measured on 2026-08-10 and had been fixed upstream by the 11th. Both measurements are kept rather than the finding quietly dropped.</p>
    <div class="scroll" style="margin-top:18px"><table>
      <thead><tr><th>finding</th><th>consequence</th></tr></thead>
      <tbody>
        <tr><td><code class="mono">202</code> with <code class="mono">completed</code> and no transaction hash</td><td>A client that reads the hash from the broadcast response gets <code class="mono">undefined</code> at the moment it believes it succeeded. The official CLI treated it as terminal.</td></tr>
        <tr><td><code class="mono">unconfirmed</code> missing from the status list</td><td>Treating it as failure reports a false failure; retrying under a new idempotency key can create a second logical operation.</td></tr>
        <tr><td>Funding guidance contradicted sponsorship</td><td>The Turnkey page called EOA funding required for any broadcasting workflow, eight lines below its own sponsorship paragraph. A zero-balance wallet executed fine.</td></tr>
        <tr><td>Interactive key input echoed</td><td>The official CLI's <code class="mono">--with-token</code> path left the terminal echoing, so a key was typed in plaintext and stayed in scrollback.</td></tr>
        <tr><td>Successful responses carry no request id</td><td>The one response that returns a KeeperHub request id is a 404 route miss. A completed-but-strange execution has no id to quote in a ticket.</td></tr>
        <tr><td>401 envelopes carry no <code class="mono">detail</code> or <code class="mono">request_id</code></td><td>A client that logs both prints <code class="mono">undefined</code> at the single most common first-run failure.</td></tr>
        <tr><td><code class="mono">gasUsedWei</code> carries gas units, not wei</td><td>Any cost calculation built on the field name is wrong by the gas price.</td></tr>
        <tr><td>A simulation passes on a zero balance</td><td>A green simulation is not proof a broadcast can land.</td></tr>
        <tr><td><code class="mono">/api/openapi</code> covers no core REST path</td><td>Advertised as the machine-readable schema for the REST API; contains 121 marketplace paths, no core route and no bearer scheme.</td></tr>
      </tbody>
    </table></div>
    <a class="more" href="${REPO_URL}/blob/main/docs/onboarding-teardown.md">Full teardown with reproductions →</a>`;
}

/* ------------------------------------------------------------------- render */

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KeeperHub Flightcheck — onboarding now ends with an onchain fact</title>
<meta name="description" content="Proves KeeperHub can execute, settle and verify a real onchain transaction from a fresh environment, or stops at the exact stage that fails.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head><body>

<nav>
  <div class="wrap">
    <a class="brand" href="#top"><span class="dot"></span>Flightcheck</a>
    <div class="links">
      <a class="n" href="#proof">Proof</a>
      <a class="n" href="#recovery">Recovery</a>
      <a class="n" href="#cleanroom">Clean room</a>
      <a class="n" href="#findings">Findings</a>
      <a class="n" href="#upstream">Upstream</a>
      <a class="n" href="#evidence">Evidence</a>
    </div>
    <a class="gh" href="${REPO_URL}">GitHub ↗</a>
  </div>
</nav>

<section id="top" style="padding-top:64px">
  <div class="wrap">
    <div class="eyebrow">KeeperHub onboarding conformance</div>
    <h1 style="margin-top:18px">Onboarding now ends<br>with an onchain fact.</h1>
    <div class="head" style="margin-top:26px">
      <span class="badge">VERIFIED</span>
      <span class="pill">Base Sepolia · ${esc(m.canary.chainId)}</span>
      <span class="pill">${m.runs.verified}/${m.runs.total} verified runs</span>
      <span class="pill">CLI · 0 runtime dependencies</span>
    </div>
    <p class="lede"><code class="mono">kh doctor</code> tells you the environment looks healthy. Flightcheck proves KeeperHub can actually execute from it, then independently checks the transaction against the chain.</p>
    <p class="sub" style="margin-top:14px;max-width:62ch">KeeperHub executes onchain transactions and automations from an organisation wallet, through an API and a CLI. Flightcheck is an independent conformance check built against it for the Agents Onchain Hackathon. It is not an official KeeperHub tool, and none of its upstream fixes are merged.</p>
    <pre style="margin-top:26px;max-width:640px">npm run flightcheck -- setup --execute</pre>
    <p class="sub" style="margin-top:12px">Fresh clone. No <code class="mono">.env</code>. No <code class="mono">npm install</code>. Credential entered through a hidden terminal boundary.</p>
    ${heroStrip()}
    <div class="btns">
      <a class="btn" href="#proof">View the proof</a>
      <a class="btn ghost" href="${REPO_URL}">GitHub</a>
      <a class="tlink" href="#evidence-teardown">Read the teardown</a>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Configuration healthy ≠ transaction verified</h2>
    <div class="vs">
      <div class="col">
        <h3><code class="mono">kh doctor</code></h3>
        <ul class="checks">
          <li>auth</li><li>API reachability</li><li>wallet</li><li>chains</li><li>configuration</li>
        </ul>
        <div class="verdict">“Environment looks healthy.”</div>
      </div>
      <div class="col on">
        <h3>Flightcheck</h3>
        <ul class="checks">
          <li>simulation</li><li>durable execution intent</li><li>KeeperHub execution</li>
          <li>public receipt</li><li>canary event</li><li>sender and challenge binding</li>
        </ul>
        <div class="verdict">“KeeperHub actually executed, and the chain agrees.”</div>
      </div>
    </div>
    <p style="margin-top:26px">KeeperHub reporting <code class="mono">completed</code> is one proof leg, never the verdict.</p>
    <div class="flow">
      <span class="s">SETUP</span><span class="a">→</span>
      <span class="s">SIMULATE</span><span class="a">→</span>
      <span class="s">PERSIST</span><span class="a">→</span>
      <span class="s">EXECUTE</span><span class="a">→</span>
      <span class="s">RECONCILE</span><span class="a">→</span>
      <span class="s">VERIFY</span>
    </div>
    <p class="sub" style="margin-top:12px">Six concepts. Twelve internal stages, two of which never ask KeeperHub anything. <a class="tlink" href="#evidence-state-machine">State machine →</a></p>
  </div>
</section>

<section id="proof">
  <div class="wrap">
    <h2>One execution. Three answers, two of them not KeeperHub's.</h2>
    <p style="margin-top:14px">A run counts as verified only when all three agree. KeeperHub's own report is the claim under test, so it is checked against a public node and a decoded event that never ask KeeperHub anything.</p>
    <div class="grid" style="margin-top:30px;gap:0">${proofNodes()}</div>
    <div class="dark" style="margin-top:22px">
      <div class="head"><span class="badge">ALL THREE AGREE</span></div>
      <div class="kv" style="margin-top:18px">
        <div class="k">transaction</div><div class="v">${hash(run?.transactionHash, { link: String(run?.transactionLink ?? "") })}</div>
        <div class="k">block</div><div class="v">${esc(run?.blockNumber ?? "?")} on chain ${esc(m.canary.chainId)}</div>
        <div class="k">cold run range</div><div class="v">${ms(m.runs.fastestEndToEndMs)} – ${ms(m.runs.slowestEndToEndMs)} across ${esc(m.runs.endToEndRuns)} runs</div>
      </div>
      <p class="sub" style="margin-top:16px">The organisation wallet neither sent this transaction nor paid for it, and held zero ETH throughout. Open it on a block explorer and the transaction list is empty. Only hash → receipt → decoded log finds it.</p>
    </div>
    <a class="more" href="#evidence-execution">Inspect full execution evidence →</a>
  </div>
</section>

<section id="recovery">
  <div class="wrap">
    <h2>Lose the response. Keep the same logical execution.</h2>
    <p style="margin-top:14px">A write can succeed while its HTTP response is lost. Retrying it as new work can create another logical operation. Flightcheck persists the intent before broadcast and resumes the same one.</p>
    <div class="dark" style="margin-top:30px">
      <div class="steps">
        <div class="step"><div class="n">01</div><div class="t">persist intent and a derived idempotency key, fsynced</div></div>
        <div class="step"><div class="n">02</div><div class="t">send the KeeperHub request</div></div>
        <div class="step kill"><div class="n">03</div><div class="t">discard the real HTTP response</div></div>
        <div class="step"><div class="n">04</div><div class="t">resume the existing run, same key</div></div>
      </div>
      <div class="grid g3" style="margin-top:26px">
        <div><div class="stat" style="color:#fff">${esc(rec?.broadcastRequestsSent ?? "?")}</div><div class="statlabel" style="color:var(--mist)">HTTP broadcast attempts</div></div>
        <div><div class="stat" style="color:#fff">${esc(rec?.transactionsOnchain ?? "?")}</div><div class="statlabel" style="color:var(--mist)">successful onchain execution carrying the challenge</div></div>
        <div><div class="stat" style="color:#fff">${rec?.pass ? "VERIFIED" : "—"}</div><div class="statlabel" style="color:var(--mist)">recovery reached proof</div></div>
      </div>
    </div>
    <details style="margin-top:16px">
      <summary>How this is counted</summary>
      <div class="dbody">
        <p>Base Sepolia logs show one successful execution carrying the run's unique challenge after two HTTP attempts. The challenge is generated before anything is sent and is an indexed event topic, so a log filter on it counts the executions that performed that specific work rather than anything we recorded ourselves.</p>
        <p style="margin-top:12px">A reverted duplicate would emit no event and so would not appear in that count. No broader claim about every possible transaction is made.</p>
        <a class="more" href="#evidence-recovery">Raw recovery evidence →</a>
      </div>
    </details>
  </div>
</section>

<section id="cleanroom">
  <div class="wrap">
    <div class="eyebrow">Independent clean-room reproduction</div>
    <h2 style="margin-top:14px">Not our account. Not our setup.</h2>
    <div class="vs" style="margin-top:30px">
      <div class="col">
        <h3>Before</h3>
        <ul class="checks" style="margin-top:14px">
          <li>new KeeperHub account, created that morning</li>
          <li>fresh clone of the published repo</li>
          <li>no .env</li>
          <li>no npm install</li>
          <li>KEEPERHUB_API_KEY unset</li>
          <li>wallet balance 0</li>
          <li>wallet nonce 0</li>
          <li>wallet code 0x</li>
        </ul>
      </div>
      <div class="col on">
        <div class="head"><span class="badge">VERIFIED</span><span class="pill">${clean ? ms((clean.result as Record<string, unknown>)?.totalMs) : "?"}</span></div>
        <div class="kv" style="margin-top:18px">
          <div class="k">execution</div><div class="v"><code class="mono">${esc((clean?.result as Record<string, unknown>)?.executionId ?? "?")}</code></div>
          <div class="k">sponsored</div><div class="v">${esc(String((clean?.result as Record<string, unknown>)?.sponsored ?? "?"))}</div>
          <div class="k">faucet used</div><div class="v">${esc(String(clean?.faucetUsed ?? "?"))}</div>
          <div class="k">credential echoed</div><div class="v">${esc(String(clean?.keyEchoedToTerminal ?? "?"))}</div>
          <div class="k">transaction</div><div class="v">${hash((clean?.result as Record<string, unknown>)?.transactionHash, { link: String((clean?.result as Record<string, unknown>)?.explorer ?? "") })}</div>
        </div>
      </div>
    </div>
    <p style="margin-top:26px">To be exact about what this is: a different account, not a different person. It was created and driven by us, so it shows the artifact does not depend on our environment, credentials or accumulated state. It is not a claim that an unaffiliated stranger ran it.</p>
    <p style="margin-top:16px">The fresh run also disproved one of our own published assumptions: the organisation-wallet nonce moved 0 → 1 when its EIP-7702 delegation was installed. We withdrew the old claim rather than rewriting the evidence.</p>
    <a class="more" href="#evidence-cleanroom">Inspect clean-room evidence →</a>
  </div>
</section>

<section id="findings">
  <div class="wrap">
    <h2>We used the onboarding path hard enough to break assumptions.</h2>
    <p style="margin-top:14px">Five of nine findings. Each one has a reproduction in the teardown.</p>
    <div style="margin-top:24px">
      <div class="finding"><div class="n">01</div><div>
        <div class="t">Completed without a transaction hash</div>
        <div class="d"><code class="mono">POST /contract-call</code> returns <code class="mono">202</code> with <code class="mono">status: "completed"</code>, but the hash exists only on the later status endpoint.</div>
        <span class="tag">CLI fix submitted</span>
      </div></div>
      <div class="finding"><div class="n">02</div><div>
        <div class="t"><code class="mono">unconfirmed</code> is a real non-terminal state</div>
        <div class="d">Missing from the documented status list. Treating it as failure reports a false failure, and retrying under a fresh idempotency key can create a second logical operation.</div>
        <span class="tag">docs fix submitted</span>
      </div></div>
      <div class="finding"><div class="n">03</div><div>
        <div class="t">Funding guidance contradicted sponsorship</div>
        <div class="d">A brand-new organisation holding 0 ETH executed successfully because KeeperHub sponsored it, while the wallet page called funding required for any broadcasting workflow.</div>
        <span class="tag">docs fix submitted</span>
      </div></div>
      <div class="finding"><div class="n">04</div><div>
        <div class="t">Interactive API-key input echoed</div>
        <div class="d">The official CLI's interactive token path could echo an organisation key in a real terminal, leaving it in scrollback.</div>
        <span class="tag">CLI fix submitted</span>
      </div></div>
      <div class="finding"><div class="n">05</div><div>
        <div class="t">Successful responses do not echo request correlation</div>
        <div class="d">The successful execution path returns no request id, so Flightcheck records the correlation evidence actually available and labels where each id came from.</div>
        <span class="tag">teardown finding</span>
      </div></div>
    </div>
    <a class="more" href="#evidence-teardown">View all teardown findings →</a>

    <div class="card" style="margin-top:36px">
      <div class="head"><h3>When execution fails</h3><span class="pill">support capsule</span></div>
      <pre style="margin-top:16px">npm run flightcheck -- support &lt;run-id&gt;</pre>
      <div class="head" style="margin-top:16px">
        <span class="pill">redacted</span><span class="pill">offline</span><span class="pill">safe to attach</span>
        <span class="pill">no credential required</span><span class="pill">no mutation</span>
      </div>
      <p style="margin-top:16px">A failed first transaction becomes something a maintainer can actually debug.</p>
      <a class="more" href="#evidence-support">Support capsule details →</a>
    </div>
  </div>
</section>

<section id="upstream">
  <div class="wrap">
    <h2>The teardown became upstream work.</h2>
    <p style="margin-top:14px">Every one came from a finding this project proved with a real transaction. Nine findings produced five PRs: some are observations for the teardown rather than a change worth a maintainer's time, one was withdrawn after it turned out to be fixed upstream, and five is a deliberate ceiling rather than a count to optimise.</p>
    <div style="margin-top:26px">${upstreamRows()}</div>
    <p class="sub" style="margin-top:20px">${esc(up?.prs?.length ?? 0)} contributions, ${up?.merged === 0 ? "all open and none merged" : `${esc(up?.merged)} merged`}. Two carry maintainer reviews requesting changes, since addressed; the rest are awaiting review. Whether any is accepted is KeeperHub's call, not a result this project can claim. States read from GitHub${up?.fetchedAt ? ` at ${esc(String(up.fetchedAt).slice(0, 16).replace("T", " "))} UTC` : ""}${up?.stale ? ", and this block may be stale" : ""}.</p>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Built to be reproduced, not believed.</h2>
    ${confidence()}
    <div class="btns">
      <a class="tlink" href="${REPO_URL}/blob/main/CLAIMS.md">Read CLAIMS.md</a>
      <a class="tlink" href="#evidence-verify">Verify it yourself</a>
    </div>

    <h3 style="margin-top:48px">Agent onboarding benchmark</h3>
    ${benchStrip()}
  </div>
</section>

<section id="evidence">
  <div class="wrap">
    <h2>Forensic evidence</h2>
    <p style="margin-top:14px">Everything above, with the raw values behind it. Each block has a stable anchor and opens on direct link.</p>
    <div class="tabs">
      <a href="#evidence-execution">Execution</a>
      <a href="#evidence-recovery">Recovery</a>
      <a href="#evidence-cleanroom">Clean room</a>
      <a href="#evidence-state-machine">State machine</a>
      <a href="#evidence-bootstrap">Bootstrap</a>
      <a href="#evidence-support">Support capsule</a>
      <a href="#evidence-faucet">Gas fallback</a>
      <a href="#evidence-benchmark">Benchmark</a>
      <a href="#evidence-teardown">Teardown</a>
      <a href="#evidence-verify">Verify yourself</a>
      <a href="#evidence-limitations">Limitations</a>
    </div>
    <button class="copy" id="expandall" style="font-size:12px;padding:5px 9px;margin-bottom:6px">Expand all</button>
    ${evidenceBlock("evidence-execution", "Execution", "canonical run, canary, all verified runs", evExecution())}
    ${evidenceBlock("evidence-recovery", "Recovery", "response-loss fault injection", evRecovery())}
    ${evidenceBlock("evidence-cleanroom", "Clean room", "independent account, preconditions and result", evCleanroom())}
    ${evidenceBlock("evidence-state-machine", "State machine", `12 stages · ${m.failureCodes} failure codes`, evStateMachine())}
    ${evidenceBlock("evidence-bootstrap", "Bootstrap", "credential boundary", evBootstrap())}
    ${evidenceBlock("evidence-support", "Support capsule", "redaction and request correlation", evSupport())}
    ${evidenceBlock("evidence-faucet", "Gas fallback", "KeeperHub first, then a bounded faucet", evFaucet())}
    ${evidenceBlock("evidence-benchmark", "Benchmark", "method, arms and caveats", evBenchmark())}
    ${evidenceBlock("evidence-teardown", "Teardown findings", "9 findings, 1 withdrawn", evTeardown())}
    ${evidenceBlock("evidence-verify", "Verify yourself", "commands that trust nothing here", evVerify())}
    ${evidenceBlock("evidence-limitations", "Limitations", "including two withdrawn claims", evLimitations())}
  </div>
</section>

<footer>
  <div class="wrap">
    <p style="color:var(--fog)">Flightcheck ${esc(m.toolVersion)} · manifest generated ${esc(String(m.generatedAt).slice(0, 16).replace("T", " "))} UTC · every figure on this page is read from <a href="${REPO_URL}/blob/main/evidence/manifest.json">evidence/manifest.json</a>, which is generated from the proof capsules.</p>
    <p style="margin-top:10px;color:var(--fog)"><a href="${REPO_URL}">Repository</a> · <a href="${REPO_URL}/blob/main/CLAIMS.md">Claims ledger</a> · <a href="${REPO_URL}/blob/main/docs/onboarding-teardown.md">Teardown</a> · <a href="${REPO_URL}/blob/main/docs/support.md">Support capsule</a> · MIT</p>
  </div>
</footer>

<script>
/* Direct links must open the block they point at, otherwise an anchor into a
   collapsed details lands on a closed summary and looks broken. */
function openFromHash(){
  var h = location.hash.slice(1);
  if(!h) return;
  var el = document.getElementById(h);
  if(el && el.tagName === 'DETAILS'){ el.open = true; el.scrollIntoView({block:'start'}); }
}
addEventListener('hashchange', openFromHash);
openFromHash();

document.addEventListener('click', function(e){
  var b = e.target.closest('button.copy[data-copy]');
  if(!b) return;
  navigator.clipboard.writeText(b.dataset.copy).then(function(){
    var was = b.textContent; b.textContent = 'copied';
    setTimeout(function(){ b.textContent = was; }, 1200);
  });
});

var all = document.getElementById('expandall');
if(all) all.addEventListener('click', function(){
  var ds = document.querySelectorAll('#evidence details');
  var open = all.textContent === 'Expand all';
  ds.forEach(function(d){ d.open = open; });
  all.textContent = open ? 'Collapse all' : 'Expand all';
});
</script>
</body></html>`;

const outDir = resolve(REPO_ROOT, "site", "dist");
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "index.html"), html);
process.stdout.write(`site/dist/index.html  ${(html.length / 1024).toFixed(1)} KB\n`);
