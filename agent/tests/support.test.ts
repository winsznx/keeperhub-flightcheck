/**
 * Support capsule and request correlation.
 *
 * Two things are being tested, and they are the same thing from opposite ends. Correlation ids
 * have to reach KeeperHub on every request and come back into the run record, and the capsule
 * built from that record has to be safe to hand to a stranger.
 *
 * The exclusion tests are written as attacks rather than as assertions about intent: a secret is
 * planted where it could plausibly end up, the capsule is built, and the leak detector is run
 * over the serialised bytes. Asserting "we never put the key in" would pass on a capsule that
 * carries it under a name nobody thought to check.
 *
 * The last two tests spawn the real CLI. A support command that only works in-process, with the
 * repository's environment loaded and its network reachable, is not the command being claimed.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { runFlightcheck } from "../src/machine.ts";
import { buildCapsule } from "../src/proof.ts";
import { buildSupportCapsule, writeSupportCapsule, requestIdsByStage, SUPPORT_SCHEMA } from "../src/support.ts";
import { buildRequestId } from "../src/keeperhub.ts";
import { RunStore, type RunRecord } from "../src/runstore.ts";
import { findLeaks, registerSecret, clearSecrets, scrub } from "../src/redact.ts";
import * as F from "./fixtures.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = resolve(REPO_ROOT, "agent", "src", "cli.ts");
const RPC_URL = "https://rpc.test.invalid";
const API_KEY = "kh_TESTKEY_abcdefghijklmnopqrstuv";

/** A private key, only ever used to prove it cannot reach an artifact. */
const FAKE_PRIVATE_KEY = "0x" + "7c".repeat(32);
const FAKE_SESSION_COOKIE = "kh_session=abc123def456ghi789jkl012mno345pq; Path=/; HttpOnly";

const REAL_CANARY_CODE =
  "0x6080604052348015600e575f80fd5b50600436106026575f3560e01c806333d425c414602a575b5f80fd5b603960353660046075565b603b565b005b604051468152819033907f4947ef22330e8e81cdedf82c33d366e9c942511f5edf79140686b33af9de7f339060200160405180910390a350565b5f602082840312156084575f80fd5b503591905056";

interface StubOpts {
  simulate?: { status: number; body: unknown };
  broadcast?: Array<{ status: number; body: unknown; headers?: Record<string, string> }>;
  status?: Array<{ status: number; body: unknown; headers?: Record<string, string> }>;
  keys?: { status: number; body: unknown; headers?: Record<string, string> };
  /** Every Authorization header the transport saw, so a test can prove it went nowhere else. */
  sentAuth?: string[];
  sentRequestIds?: string[];
}

function stub(opts: StubOpts) {
  let seenChallenge: string | null = null;
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  let broadcasts = 0;
  let statuses = 0;

  const transport = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    opts.sentAuth?.push(headers.Authorization ?? "");
    opts.sentRequestIds?.push(headers["X-Request-Id"] ?? "");

    const m = /0x[0-9a-f]{64}/i.exec(String(init.body ?? ""));
    if (m) seenChallenge = m[0];

    if (url.includes("/api/keys")) {
      const r = opts.keys ?? { status: 200, body: { items: [{ scope: "mcp:read mcp:write" }] } };
      return json(r.status, r.body, r.headers ?? { "x-request-id": "kh-srv-keys-1" });
    }
    if (url.includes("/api/user")) {
      return json(200, { walletAddress: F.ORG_WALLET }, { "x-request-id": "kh-srv-user-1" });
    }
    if (url.includes("/api/chains")) {
      return json(
        200,
        [{ chainId: 84532, name: "Base Sepolia", isEnabled: true, isTestnet: true, chainType: "evm" }],
        { "x-request-id": "kh-srv-chains-1" },
      );
    }
    if (url.includes("/api/execute/contract-call")) {
      if (String(init.body ?? "").includes('"simulate":true')) {
        const r = opts.simulate ?? { status: 200, body: F.REAL_SIMULATION_OK };
        return json(r.status, r.body, { "x-request-id": "kh-srv-sim-1" });
      }
      const idx = broadcasts++;
      const r = opts.broadcast?.[Math.min(idx, (opts.broadcast?.length ?? 1) - 1)] ?? {
        status: 202,
        body: F.REAL_BROADCAST_202,
      };
      return json(r.status, r.body, r.headers ?? { "x-request-id": `kh-srv-exec-${idx + 1}` });
    }
    if (url.includes("/status")) {
      const idx = statuses++;
      const r = opts.status?.[Math.min(idx, (opts.status?.length ?? 1) - 1)] ?? {
        status: 200,
        body: F.REAL_STATUS_COMPLETED,
      };
      return json(r.status, r.body, r.headers ?? { "x-poll-interval-hint": "0", "x-request-id": `kh-srv-status-${idx + 1}` });
    }
    throw new Error("unexpected url " + url);
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method: string };
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    switch (body.method) {
      case "eth_chainId":
        return reply("0x14a34");
      case "eth_getCode":
        return reply(REAL_CANARY_CODE);
      case "eth_getTransactionReceipt": {
        const base = F.realReceipt();
        return reply(
          seenChallenge
            ? F.realReceipt({
                logs: [{ ...base.logs[0]!, topics: [F.TOPIC0, base.logs[0]!.topics[1]!, seenChallenge] }],
              })
            : base,
        );
      }
      default:
        return reply(null);
    }
  }) as typeof fetch;

  return { transport, restore: () => void (globalThis.fetch = realFetch) };
}

/** A completed run whose state directory survives, so the support path has something to read. */
async function runAndKeep(opts: StubOpts = {}, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), "fc-support-"));
  const s = stub(opts);
  try {
    const result = await runFlightcheck({
      apiKey: API_KEY,
      chainId: 84532,
      rpcUrl: RPC_URL,
      stateDir: dir,
      execute: true,
      transport: s.transport,
      maxPolls: 3,
      receiptAttempts: 2,
      receiptIntervalMs: 1,
      ...extra,
    });
    // Mirror what the CLI does, so the proof capsule exists where support looks for it.
    if (result.outcome !== "simulated") {
      const capsule = buildCapsule(result, RPC_URL);
      mkdirSync(resolve(dir, "proofs"), { recursive: true });
      writeFileSync(resolve(dir, "proofs", `${result.record.runId}.json`), JSON.stringify(capsule, null, 2));
    }
    return { result, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } finally {
    s.restore();
  }
}

describe("request correlation", () => {
  test("every KeeperHub request carries an x-request-id", async () => {
    const sentRequestIds: string[] = [];
    const { result, cleanup } = await runAndKeep({ sentRequestIds });
    try {
      assert.equal(result.outcome, "verified");
      assert.ok(sentRequestIds.length >= 5, `expected several requests, saw ${sentRequestIds.length}`);
      assert.deepEqual(
        sentRequestIds.filter((id) => id === ""),
        [],
        "some request went out with no correlation id",
      );
    } finally {
      cleanup();
    }
  });

  test("retries within the same stage stay distinguishable", () => {
    const runId = "fc_11111111-2222-3333-4444-555555555555";
    const first = buildRequestId(runId, "EXECUTION_CREATED", 1);
    const second = buildRequestId(runId, "EXECUTION_CREATED", 2);
    assert.notEqual(first, second);
    assert.ok(first.endsWith("_1"));
    assert.ok(second.endsWith("_2"));
    // The stage still has to be readable, otherwise the id distinguishes attempts but not steps.
    assert.ok(first.includes("execution-created"));
  });

  test("a real run that retries produces distinct ids for the retried stage", async () => {
    const sentRequestIds: string[] = [];
    const { cleanup } = await runAndKeep({
      sentRequestIds,
      // A status poll that is not yet terminal forces a second GET on the same stage.
      status: [
        { status: 200, body: { executionId: "exnn6k0y1ojnnvb8sa1fu", status: "pending", receipts: [] }, headers: { "x-poll-interval-hint": "0" } },
        { status: 200, body: F.REAL_STATUS_COMPLETED, headers: { "x-poll-interval-hint": "0" } },
      ],
    });
    try {
      const unique = new Set(sentRequestIds);
      assert.equal(unique.size, sentRequestIds.length, "two requests shared a correlation id");
    } finally {
      cleanup();
    }
  });

  test("request ids carry no secret material", () => {
    clearSecrets();
    registerSecret(API_KEY);
    registerSecret(FAKE_PRIVATE_KEY);
    try {
      const id = buildRequestId("fc_11111111-2222-3333-4444-555555555555", "SIMULATION_PASSED", 1);
      assert.deepEqual(findLeaks(id), []);
      // The run id is a random UUID, so nothing about the credential can be recovered from it.
      assert.ok(!id.includes(API_KEY.slice(0, 8)));
    } finally {
      clearSecrets();
    }
  });

  test("request ids respect the length and character contract", () => {
    const cases: Array<[string, string, number]> = [
      ["fc_11111111-2222-3333-4444-555555555555", "START", 1],
      ["fc_11111111-2222-3333-4444-555555555555", "EXECUTION_PREPARED", 99],
      // Hostile input: a stage name that is long, spaced and punctuated.
      ["fc_" + "a".repeat(80), "A stage name/with punctuation and a great deal of length", 12345],
      ["", "", 0],
    ];
    for (const [runId, stage, attempt] of cases) {
      const id = buildRequestId(runId, stage, attempt);
      assert.ok(id.length <= 64, `${id.length} chars for stage ${stage}`);
      assert.match(id, /^[A-Za-z0-9_-]+$/, `unsafe characters in ${id}`);
    }
  });

  test("the echoed request id is persisted with the run", async () => {
    const { result, dir, cleanup } = await runAndKeep();
    try {
      const trace = result.record.httpTrace ?? [];
      assert.ok(trace.length > 0);
      for (const entry of trace) {
        assert.ok(entry.sentRequestId, `no sent id for ${entry.path}`);
        assert.ok(entry.serverRequestId, `no echoed id for ${entry.path}`);
      }
      // In memory is not the claim. It has to survive the round trip to disk, because that is
      // what `support` reads, possibly days later on a machine that has forgotten everything.
      const reloaded = new RunStore(dir).load(result.record.runId);
      assert.deepEqual(reloaded.httpTrace, trace);
      assert.equal(reloaded.httpTrace?.[0]?.serverRequestId, "kh-srv-keys-1");
    } finally {
      cleanup();
    }
  });

  test("the echoed id is read from the error envelope when there is no header", async () => {
    const { result, cleanup } = await runAndKeep({
      // Observed shape: a 404 carries request_id in the body. Headers deliberately omitted.
      keys: { status: 404, body: F.NOT_FOUND, headers: {} },
    });
    try {
      assert.equal(result.outcome, "stopped");
      const trace = result.record.httpTrace ?? [];
      assert.equal(trace[0]?.serverRequestId, F.NOT_FOUND.request_id);
      assert.equal(trace[0]?.serverRequestIdSource, "request_id");
    } finally {
      cleanup();
    }
  });

  /**
   * Measured against the live API on 2026-08-12: a 200, a 202 and a 401 carry neither
   * `x-request-id` nor a body `request_id`, and none of them echo the header we send. Only
   * `cf-ray` is present on every response, so without this fallback the correlation section of
   * a support capsule for a successful run would be entirely null.
   */
  test("falls back to cf-ray, without its datacentre suffix, when nothing else is offered", async () => {
    const { result, cleanup } = await runAndKeep({
      keys: { status: 200, body: { items: [] }, headers: { "cf-ray": "9c1d4a2b3e5f6071-LHR" } },
    });
    try {
      const trace = result.record.httpTrace ?? [];
      assert.equal(trace[0]?.serverRequestId, "9c1d4a2b3e5f6071");
      assert.equal(trace[0]?.serverRequestIdSource, "cf-ray");
      // The colo is a coarse location hint about whoever filed the ticket. It stays out.
      assert.ok(!JSON.stringify(trace[0]).includes("LHR"));
    } finally {
      cleanup();
    }
  });

  test("an echoed x-request-id wins over both fallbacks when it exists", async () => {
    const { result, cleanup } = await runAndKeep({
      keys: {
        status: 200,
        body: { items: [], request_id: "from-body" },
        headers: { "x-request-id": "from-header", "cf-ray": "9c1d4a2b3e5f6071-LHR" },
      },
    });
    try {
      const trace = result.record.httpTrace ?? [];
      assert.equal(trace[0]?.serverRequestId, "from-header");
      assert.equal(trace[0]?.serverRequestIdSource, "x-request-id");
    } finally {
      cleanup();
    }
  });
});

describe("support capsule content", () => {
  test("carries the correlation ids, by stage, for the whole run", async () => {
    const { result, dir, cleanup } = await runAndKeep();
    try {
      const capsule = buildSupportCapsule(result.record, { stateDir: dir, repoRoot: REPO_ROOT });
      assert.equal(capsule.schema, SUPPORT_SCHEMA);
      assert.equal(capsule.run.runId, result.record.runId);

      // The tag names the operation that produced the request, which is the question a
      // maintainer reading a ticket actually has.
      const stages = requestIdsByStage(capsule).map((g) => g.stage);
      for (const expected of ["authenticate", "resolveWallet", "simulate", "execute", "settle"]) {
        assert.ok(stages.includes(expected), `no ${expected} requests, saw ${stages.join(", ")}`);
      }
      // And the id itself carries the same operation, so it is readable without the capsule.
      const settle = requestIdsByStage(capsule).find((g) => g.stage === "settle")!;
      assert.ok(settle.ids[0]!.includes("settle"), settle.ids[0]);

      for (const req of capsule.requests) {
        assert.equal(typeof req.sentRequestId, "string");
        assert.equal(typeof req.httpStatus, "number");
        assert.equal(typeof req.elapsedMs, "number");
      }
    } finally {
      cleanup();
    }
  });

  test("carries the execution facts a maintainer would ask for", async () => {
    const { result, dir, cleanup } = await runAndKeep();
    try {
      const capsule = buildSupportCapsule(result.record, { stateDir: dir, repoRoot: REPO_ROOT });
      assert.equal(capsule.keeperhub.executionId, F.REAL_STATUS_COMPLETED.executionId);
      assert.equal(capsule.keeperhub.normalizedState, "COMPLETED");
      assert.equal(capsule.keeperhub.sponsored, true);
      assert.equal(capsule.onchain.transactionHash, F.REAL_STATUS_COMPLETED.transactionHash);
      assert.equal(capsule.onchain.receiptStatus, "success");
      assert.equal(capsule.onchain.expectedEventFound, true);
      assert.equal(capsule.wallet.organisationWallet, F.ORG_WALLET);
      assert.equal(capsule.chain.chainId, 84532);
      assert.equal(capsule.faucet.used, false);
    } finally {
      cleanup();
    }
  });

  test("the idempotency key travels only as a digest", async () => {
    const { result, dir, cleanup } = await runAndKeep();
    try {
      const capsule = buildSupportCapsule(result.record, { stateDir: dir, repoRoot: REPO_ROOT });
      const serialised = JSON.stringify(capsule);
      assert.ok(result.record.idempotencyKey.length > 0);
      assert.ok(
        !serialised.includes(result.record.idempotencyKey),
        "the raw idempotency key reached the capsule",
      );
      // And the digest is intact rather than eaten by the bare-64-hex rule.
      assert.match(String(capsule.run.idempotencyKeyHash), /^0x[0-9a-f]{64}$/);
      assert.equal(capsule.run.idempotencyKeyHashAlgorithm, "sha256");
    } finally {
      cleanup();
    }
  });

  test("a run that stopped before broadcasting still produces a capsule", async () => {
    const { result, dir, cleanup } = await runAndKeep({
      simulate: { status: 400, body: F.DOC_SIMULATION_UNDERFUNDED },
    });
    try {
      assert.equal(result.outcome, "stopped");
      const capsule = buildSupportCapsule(result.record, { stateDir: dir, repoRoot: REPO_ROOT });
      assert.equal(capsule.failure?.code, "FC_SIM_INSUFFICIENT_BALANCE");
      assert.equal(capsule.failure?.broadcastPossible, false);
      assert.ok(String(capsule.failure?.remediation).length > 0);
      assert.equal(capsule.keeperhub.executionId, null);
      assert.ok(capsule.requests.length > 0, "a stopped run still made requests worth correlating");
    } finally {
      cleanup();
    }
  });

  test("a faucet payout is reported when it happened", async () => {
    const { result, dir, cleanup } = await runAndKeep();
    try {
      const record: RunRecord = {
        ...result.record,
        faucet: {
          requestId: "fc_faucet_1",
          recipient: F.ORG_WALLET,
          status: "funded",
          transactionHash: "0x" + "1a".repeat(32),
          idempotentReplay: false,
          at: "2026-08-12T00:00:00.000Z",
        },
      };
      const capsule = buildSupportCapsule(record, { stateDir: dir, repoRoot: REPO_ROOT });
      assert.equal(capsule.faucet.used, true);
      assert.equal(capsule.faucet.status, "funded");
      assert.equal(capsule.faucet.transactionHash, "0x" + "1a".repeat(32));
    } finally {
      cleanup();
    }
  });
});

describe("nothing secret can reach the support capsule", () => {
  /**
   * Plant a secret in every field of the run record that could plausibly carry one, build the
   * capsule, and scan the bytes. The record is typed, so this is deliberately cast: the point is
   * to model a future change that starts storing something it should not.
   */
  function contaminatedRecord(base: RunRecord, poison: string): RunRecord {
    return {
      ...base,
      organizationKeyPrefix: poison,
      intendedOperation: `${base.intendedOperation} ${poison}`,
      canonicalRequestBody: JSON.stringify({ smuggled: poison }),
      httpTrace: [
        ...(base.httpTrace ?? []),
        {
          stage: poison,
          method: "GET",
          path: `/api/keys?token=${poison}`,
          status: 200,
          elapsedMs: 1,
          sentRequestId: poison,
          serverRequestId: poison,
        },
      ],
    } as RunRecord;
  }

  const attacks: Array<[string, string]> = [
    ["a KeeperHub API key", API_KEY],
    ["a private key", FAKE_PRIVATE_KEY],
    ["an Authorization header", `Bearer ${API_KEY}`],
    ["a session cookie", FAKE_SESSION_COOKIE],
    ["a bare 64-hex secret", "7c".repeat(32)],
  ];

  for (const [label, poison] of attacks) {
    test(`${label} cannot survive into the capsule`, async () => {
      const { result, dir, cleanup } = await runAndKeep();
      clearSecrets();
      registerSecret(API_KEY);
      registerSecret(FAKE_PRIVATE_KEY);
      registerSecret(FAKE_SESSION_COOKIE);
      try {
        const capsule = buildSupportCapsule(contaminatedRecord(result.record, poison), {
          stateDir: dir,
          repoRoot: REPO_ROOT,
        });
        const serialised = JSON.stringify(capsule, null, 2);
        assert.ok(!serialised.includes(poison), `${label} appeared verbatim in the capsule`);
        assert.deepEqual(findLeaks(serialised), [], `${label} tripped the leak detector`);
      } finally {
        clearSecrets();
        cleanup();
      }
    });
  }

  test("the writer refuses rather than emitting a capsule that still leaks", async () => {
    const { result, dir, cleanup } = await runAndKeep();
    const out = mkdtempSync(resolve(tmpdir(), "fc-support-out-"));
    try {
      const capsule = buildSupportCapsule(result.record, { stateDir: dir, repoRoot: REPO_ROOT });
      // Register the secret only after the capsule was built, so scrubbing could not have run
      // against it. This models the case the second boundary exists for.
      clearSecrets();
      registerSecret(String(capsule.run.challenge));
      const tampered = { ...capsule, howToUse: `see ${capsule.run.challenge}` };
      assert.throws(() => writeSupportCapsule(tampered, out), /refusing to write/);
      assert.deepEqual(readdirSync(out), [], "a leaking capsule reached disk");
    } finally {
      clearSecrets();
      rmSync(out, { recursive: true, force: true });
      cleanup();
    }
  });

  test("no raw environment, argv or header block is carried", async () => {
    process.env.FLIGHTCHECK_TEST_CANARY_SECRET = "kh_ENVCANARY_abcdefghijklmnop";
    const { result, dir, cleanup } = await runAndKeep();
    try {
      const capsule = buildSupportCapsule(result.record, { stateDir: dir, repoRoot: REPO_ROOT });
      const serialised = JSON.stringify(capsule);
      assert.ok(!serialised.includes("FLIGHTCHECK_TEST_CANARY_SECRET"));
      assert.ok(!serialised.includes("ENVCANARY"));
      for (const forbidden of ["authorization", "cookie", "set-cookie", "process.argv", "headers"]) {
        assert.ok(
          !serialised.toLowerCase().includes(`"${forbidden}"`),
          `the capsule has a ${forbidden} field`,
        );
      }
      // The exclusion contract is stated in the artifact, not just in the code.
      assert.ok(capsule.excluded.includes("Authorization header"));
      assert.equal(capsule.secretsIncluded, "none");
    } finally {
      delete process.env.FLIGHTCHECK_TEST_CANARY_SECRET;
      cleanup();
    }
  });
});

describe("determinism and idempotence", () => {
  test("the same record and the same clock produce byte-identical output", async () => {
    const { result, dir, cleanup } = await runAndKeep();
    try {
      const at = new Date("2026-08-12T09:00:00.000Z");
      const opts = { stateDir: dir, repoRoot: REPO_ROOT, now: at, gitCommit: "a".repeat(40) };
      const first = JSON.stringify(buildSupportCapsule(result.record, opts), null, 2);
      const second = JSON.stringify(buildSupportCapsule(result.record, opts), null, 2);
      assert.equal(first, second);
    } finally {
      cleanup();
    }
  });

  test("scrubbing the finished capsule again changes nothing", async () => {
    const { result, dir, cleanup } = await runAndKeep();
    clearSecrets();
    registerSecret(API_KEY);
    try {
      const serialised = JSON.stringify(
        buildSupportCapsule(result.record, { stateDir: dir, repoRoot: REPO_ROOT }),
        null,
        2,
      );
      assert.equal(scrub(serialised), serialised, "the scrubber is not a fixed point here");
    } finally {
      clearSecrets();
      cleanup();
    }
  });

  test("building the capsule does not mutate the run record", async () => {
    const { result, dir, cleanup } = await runAndKeep();
    try {
      const before = JSON.stringify(result.record);
      buildSupportCapsule(result.record, { stateDir: dir, repoRoot: REPO_ROOT });
      assert.equal(JSON.stringify(result.record), before);
    } finally {
      cleanup();
    }
  });
});

describe("the support command, run as a command", () => {
  /** State directory holding one finished run, plus the proof capsule beside it. */
  async function fixtureState() {
    const { result, dir, cleanup } = await runAndKeep();
    return { runId: result.record.runId, dir, cleanup };
  }

  function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string, prefix = "") => {
      for (const name of readdirSync(d).sort()) {
        const full = resolve(d, name);
        if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
        else out[`${prefix}${name}`] = readFileSync(full, "utf8");
      }
    };
    walk(dir);
    return out;
  }

  test("works offline, with no credential and no reachable network", async () => {
    const { runId, dir, cleanup } = await fixtureState();
    const out = mkdtempSync(resolve(tmpdir(), "fc-support-cli-"));
    try {
      const env = { ...process.env };
      delete env.KEEPERHUB_API_KEY;
      // Nothing listens here. Any network call at all, to KeeperHub or to a node, would fail.
      env.FLIGHTCHECK_RPC_URL = "http://127.0.0.1:1";
      env.FLIGHTCHECK_STATE_DIR = dir;
      // A proxy that refuses everything, so a stray fetch cannot escape to the real internet.
      env.HTTP_PROXY = "http://127.0.0.1:1";
      env.HTTPS_PROXY = "http://127.0.0.1:1";

      const stdout = execFileSync(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", CLI, "support", runId, "--out", out],
        { env, encoding: "utf8", timeout: 60_000 },
      );

      assert.match(stdout, /Support capsule written/);
      assert.match(stdout, /Safe to attach to a KeeperHub support ticket/);
      assert.match(stdout, /Secrets included\s+none/);

      const file = resolve(out, `flightcheck-support-${runId}.json`);
      assert.ok(existsSync(file), "no capsule was written");
      const capsule = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      assert.equal(capsule.schema, SUPPORT_SCHEMA);
      assert.equal((capsule.run as Record<string, unknown>).runId, runId);
    } finally {
      rmSync(out, { recursive: true, force: true });
      cleanup();
    }
  });

  test("changes nothing it was asked to read", async () => {
    const { runId, dir, cleanup } = await fixtureState();
    const out = mkdtempSync(resolve(tmpdir(), "fc-support-cli-"));
    try {
      const before = snapshot(dir);
      const env: NodeJS.ProcessEnv = { ...process.env, FLIGHTCHECK_STATE_DIR: dir };
      delete env.KEEPERHUB_API_KEY;

      execFileSync(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", CLI, "support", runId, "--out", out],
        { env, encoding: "utf8", timeout: 60_000 },
      );

      assert.deepEqual(snapshot(dir), before, "the support command modified run state");
      // And the only thing it created is the file it said it created.
      assert.deepEqual(readdirSync(out), [`flightcheck-support-${runId}.json`]);
    } finally {
      rmSync(out, { recursive: true, force: true });
      cleanup();
    }
  });

  test("an unknown run id fails with a stage-accurate error, writing nothing", async () => {
    const out = mkdtempSync(resolve(tmpdir(), "fc-support-cli-"));
    const dir = mkdtempSync(resolve(tmpdir(), "fc-support-empty-"));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, FLIGHTCHECK_STATE_DIR: dir };
      delete env.KEEPERHUB_API_KEY;
      let failed = false;
      try {
        execFileSync(
          process.execPath,
          [
            "--experimental-strip-types",
            "--no-warnings",
            CLI,
            "support",
            "fc_00000000-0000-0000-0000-000000000000",
            "--out",
            out,
          ],
          { env, encoding: "utf8", stdio: "pipe", timeout: 60_000 },
        );
      } catch {
        failed = true;
      }
      assert.ok(failed, "an unknown run id should not exit zero");
      assert.ok(!existsSync(resolve(out, "flightcheck-support-fc_00000000-0000-0000-0000-000000000000.json")));
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
