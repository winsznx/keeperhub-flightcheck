/**
 * State-machine tests.
 *
 * These drive the real state machine against a stub transport that replays response shapes
 * captured from the live API. They are parser and control-flow tests, not live reproductions,
 * and the distinction matters: they prove Flightcheck reacts correctly to a shape, not that
 * KeeperHub produced it today.
 *
 * The cases that were reproduced against the live API are marked as such and are recorded in
 * evidence/, not here.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { runFlightcheck } from "../src/machine.ts";
import { buildCapsule } from "../src/proof.ts";
import { findLeaks, registerSecret, clearSecrets } from "../src/redact.ts";
import { BASE_SEPOLIA } from "../src/config.ts";
import * as F from "./fixtures.ts";

const RPC_URL = "https://rpc.test.invalid";
const API_KEY = "kh_TESTKEY_abcdefghijklmnop";

interface StubOpts {
  keys?: { status: number; body: unknown };
  user?: { status: number; body: unknown };
  chains?: { status: number; body: unknown };
  simulate?: { status: number; body: unknown };
  broadcast?: Array<{ status: number; body: unknown; headers?: Record<string, string> }>;
  status?: Array<{ status: number; body: unknown; headers?: Record<string, string> }>;
  code?: string;
  receipt?: unknown;
  /** Mutate the challenge-echoing receipt so one field can be varied in isolation. */
  receiptTransform?: (r: ReturnType<typeof echoingReceipt>) => unknown;
  chainIdHex?: string;
  throwOnBroadcast?: number;
}

function stub(opts: StubOpts) {
  const calls = { broadcast: 0, status: 0 };
  // The canary echoes back whatever challenge it was called with. The stub has to do the same,
  // otherwise every run fails verification against a fixture's frozen challenge, which would
  // test the fixture rather than the machine.
  let seenChallenge: string | null = null;
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  const captureChallenge = (body: unknown) => {
    const m = /0x[0-9a-f]{64}/i.exec(String(body ?? ""));
    if (m) seenChallenge = m[0];
  };

  const transport = async (url: string, init: RequestInit): Promise<Response> => {
    captureChallenge(init.body);
    if (url.includes("/api/keys")) {
      const r = opts.keys ?? { status: 200, body: { items: [{ scope: "mcp:read mcp:write" }] } };
      return json(r.status, r.body);
    }
    if (url.includes("/api/user")) {
      const r = opts.user ?? { status: 200, body: { walletAddress: F.ORG_WALLET } };
      return json(r.status, r.body);
    }
    if (url.includes("/api/chains")) {
      const r = opts.chains ?? {
        status: 200,
        body: [{ chainId: 84532, name: "Base Sepolia", isEnabled: true, isTestnet: true, chainType: "evm" }],
      };
      return json(r.status, r.body);
    }
    if (url.includes("/api/execute/contract-call")) {
      const isSimulate = String(init.body ?? "").includes('"simulate":true');
      if (isSimulate) {
        const r = opts.simulate ?? { status: 200, body: F.REAL_SIMULATION_OK };
        return json(r.status, r.body);
      }
      const idx = calls.broadcast++;
      if (opts.throwOnBroadcast !== undefined && idx < opts.throwOnBroadcast) {
        throw new Error("simulated transport failure");
      }
      const r = opts.broadcast?.[Math.min(idx, (opts.broadcast?.length ?? 1) - 1)] ?? {
        status: 202,
        body: F.REAL_BROADCAST_202,
      };
      return json(r.status, r.body, r.headers);
    }
    if (url.includes("/status")) {
      const idx = calls.status++;
      const r = opts.status?.[Math.min(idx, (opts.status?.length ?? 1) - 1)] ?? {
        status: 200,
        body: F.REAL_STATUS_COMPLETED,
        headers: { "x-poll-interval-hint": "0" },
      };
      return json(r.status, r.body, r.headers ?? { "x-poll-interval-hint": "0" });
    }
    throw new Error("unexpected url " + url);
  };

  // The independent RPC is stubbed by patching globalThis.fetch, which is what Rpc uses.
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
        return reply(opts.chainIdHex ?? "0x14a34");
      case "eth_getCode":
        return reply(opts.code ?? REAL_CANARY_CODE);
      case "eth_getTransactionReceipt":
        if (opts.receipt !== undefined) return reply(opts.receipt);
        if (opts.receiptTransform) return reply(opts.receiptTransform(echoingReceipt(seenChallenge)));
        return reply(echoingReceipt(seenChallenge));
      default:
        return reply(null);
    }
  }) as typeof fetch;

  return { transport, calls, restore: () => void (globalThis.fetch = realFetch) };
}

/** The real runtime bytecode of the deployed canary, so the pinned hash check passes honestly. */
const REAL_CANARY_CODE =
  "0x6080604052348015600e575f80fd5b50600436106026575f3560e01c806333d425c414602a575b5f80fd5b603960353660046075565b603b565b005b604051468152819033907f4947ef22330e8e81cdedf82c33d366e9c942511f5edf79140686b33af9de7f339060200160405180910390a350565b5f602082840312156084575f80fd5b503591905056";

/** A real receipt whose event carries the challenge the machine actually sent. */
function echoingReceipt(challenge: string | null) {
  const base = F.realReceipt();
  if (!challenge) return base;
  return F.realReceipt({
    logs: [{ ...base.logs[0]!, topics: [F.TOPIC0, base.logs[0]!.topics[1]!, challenge] }],
  });
}

async function run(opts: StubOpts, extra: Partial<Parameters<typeof runFlightcheck>[0]> = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), "fc-machine-"));
  const s = stub(opts);
  try {
    return {
      result: await runFlightcheck({
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
      }),
      calls: s.calls,
      dir,
    };
  } finally {
    s.restore();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("happy path", () => {
  test("reaches PROOF_WRITTEN and agrees across all legs", async () => {
    const { result } = await run({});
    assert.equal(result.outcome, "verified");
    assert.equal(result.stageReached, "PROOF_WRITTEN");
    assert.equal(result.normalizedState, "COMPLETED");
    assert.equal(result.sponsored, true);
    assert.equal(result.senderMatchesOrgWallet, true);
  });

  test("simulate-only never reaches the broadcast", async () => {
    const { result, calls } = await run({}, { execute: false });
    assert.equal(result.outcome, "simulated");
    assert.equal(calls.broadcast, 0);
    assert.equal(result.record.transactionHash, null);
  });

  test("the capsule carries no secret, even with the key registered", async () => {
    clearSecrets();
    registerSecret(API_KEY);
    const { result } = await run({});
    const capsule = buildCapsule(result, "https://eth-sepolia.g.alchemy.com/v2/SUPERSECRETKEY");
    const serialised = JSON.stringify(capsule);
    assert.deepEqual(findLeaks(serialised), []);
    // A keyed RPC URL must never be published as provenance.
    assert.equal((capsule.independentVerification as Record<string, unknown>).rpcOrigin, "redacted");
    clearSecrets();
  });
});

describe("configuration and preflight failures", () => {
  test("a 401 stops at AUTHENTICATED and never simulates", async () => {
    const { result, calls } = await run({ keys: { status: 401, body: F.UNAUTHORIZED } });
    assert.equal(result.outcome, "stopped");
    assert.equal(result.error?.code, "FC_AUTH_INVALID");
    assert.equal(calls.broadcast, 0);
    assert.equal(result.error?.broadcastPossible, false);
  });

  test("a missing walletAddress is a wallet-stage failure, not an auth failure", async () => {
    const { result } = await run({ user: { status: 200, body: { id: "u", email: "a@b.c" } } });
    assert.equal(result.error?.code, "FC_WALLET_UNRESOLVED");
    assert.equal(result.stageReached, "AUTHENTICATED");
  });

  test("422 is reported as an unconfigured wallet", async () => {
    const { result } = await run({ user: { status: 422, body: { error: "WALLET_NOT_CONFIGURED" } } });
    assert.equal(result.error?.code, "FC_WALLET_NOT_CONFIGURED");
  });

  test("a non-testnet chain is refused before any calldata is built", async () => {
    const { result, calls } = await run({
      chains: { status: 200, body: [{ chainId: 84532, name: "x", isEnabled: true, isTestnet: false, chainType: "evm" }] },
    });
    assert.equal(result.error?.code, "FC_CHAIN_NOT_TESTNET");
    assert.equal(calls.broadcast, 0);
  });

  test("an absent chain is distinguished from a disabled one", async () => {
    const absent = await run({ chains: { status: 200, body: [] } });
    assert.equal(absent.result.error?.code, "FC_CHAIN_UNSUPPORTED");
    const disabled = await run({
      chains: { status: 200, body: [{ chainId: 84532, name: "x", isEnabled: false, isTestnet: true, chainType: "evm" }] },
    });
    assert.equal(disabled.result.error?.code, "FC_CHAIN_DISABLED");
  });
});

describe("canary verification fails closed", () => {
  test("wrong bytecode stops the run before KeeperHub is asked to call it", async () => {
    const { result, calls } = await run({ code: "0xdeadbeef" });
    assert.equal(result.error?.code, "FC_CANARY_BYTECODE_MISMATCH");
    assert.equal(result.stageReached, "CHAIN_RESOLVED");
    assert.equal(calls.broadcast, 0);
  });

  test("no code at the address is its own diagnosis", async () => {
    const { result } = await run({ code: "0x" });
    assert.equal(result.error?.code, "FC_CANARY_NO_CODE");
  });

  test("an RPC serving another chain is caught before it can vouch for anything", async () => {
    const { result } = await run({ chainIdHex: "0x1" });
    assert.equal(result.error?.code, "FC_RPC_WRONG_CHAIN");
  });
});

describe("simulation", () => {
  test("a would-revert answer arrives as HTTP 400 and is read from the body", async () => {
    const { result, calls } = await run({ simulate: { status: 400, body: F.DOC_SIMULATION_REVERT } });
    assert.equal(result.error?.code, "FC_SIM_REVERT");
    assert.match(result.error!.remediation, /ERC20: transfer amount exceeds balance/);
    assert.equal(calls.broadcast, 0, "a failed simulation must never broadcast");
  });

  test("an underfunded sender is branched on the code, not on string matching", async () => {
    const { result } = await run({ simulate: { status: 400, body: F.DOC_SIMULATION_UNDERFUNDED } });
    assert.equal(result.error?.code, "FC_SIM_INSUFFICIENT_BALANCE");
    assert.match(result.error!.remediation, /0\.75/);
    assert.match(result.error!.remediation, /organisation wallet/);
  });

  test("insufficient scope names both scopes", async () => {
    const { result } = await run({ simulate: { status: 403, body: F.INSUFFICIENT_SCOPE } });
    assert.equal(result.error?.code, "FC_AUTH_INSUFFICIENT_SCOPE");
    assert.match(result.error!.remediation, /mcp:write/);
  });
});

describe("idempotency and recovery", () => {
  test("a conflict naming the original execution reconciles instead of re-broadcasting", async () => {
    const { result, calls } = await run({
      broadcast: [{ status: 409, body: F.IDEMPOTENCY_CONFLICT }],
    });
    assert.equal(result.outcome, "verified");
    assert.equal(result.record.executionId, F.IDEMPOTENCY_CONFLICT.originalExecutionId);
    assert.equal(result.record.conflicts, 1);
    assert.equal(calls.broadcast, 1, "must not send a second broadcast");
  });

  test("a conflict with a null original id stops rather than guessing", async () => {
    const { result } = await run({
      broadcast: [{ status: 409, body: F.IDEMPOTENCY_CONFLICT_NULL_ORIGINAL }],
    });
    assert.equal(result.error?.code, "FC_EXEC_IDEMPOTENCY_CONFLICT");
    assert.equal(result.error?.broadcastPossible, true);
  });

  test("in-progress is surfaced as retryable, not as failure", async () => {
    const { result } = await run({ broadcast: [{ status: 409, body: F.IDEMPOTENCY_IN_PROGRESS }] });
    assert.equal(result.error?.code, "FC_EXEC_IDEMPOTENCY_IN_PROGRESS");
  });

  test("a replayed response is recognised and recorded", async () => {
    const { result } = await run({ broadcast: [{ status: 202, body: F.REPLAYED_RESPONSE }] });
    assert.equal(result.record.replayed, true);
    assert.equal(result.outcome, "verified");
  });

  test("a lost response triggers one replay of the same key, not a new request", async () => {
    const { result, calls } = await run({ throwOnBroadcast: 1 });
    assert.equal(result.outcome, "verified");
    // Two POSTs leave the client, but the second carries the identical idempotency key.
    assert.equal(calls.broadcast, 2);
  });

  test("a lost response with no recovery stops with the resume instruction", async () => {
    const { result } = await run({ throwOnBroadcast: 2 });
    assert.equal(result.error?.code, "FC_EXEC_TRANSPORT_LOST");
    assert.equal(result.error?.broadcastPossible, true);
    assert.match(result.error!.remediation, /--resume/);
  });

  test("the request is persisted before the broadcast is attempted", async () => {
    const { result } = await run({ throwOnBroadcast: 2 });
    // Even though everything failed, the record needed for recovery exists and is complete.
    assert.match(result.record.idempotencyKey, /^[0-9a-f]{64}$/);
    assert.match(result.record.canonicalRequestBodyHash, /^sha256:/);
    assert.ok(result.record.canonicalRequestBody.includes(result.record.challenge));
  });
});

describe("settlement and verification", () => {
  test("unconfirmed is an outcome of its own, neither success nor failure", async () => {
    const { result } = await run({
      status: [{ status: 200, body: F.DOC_STATUS_UNCONFIRMED, headers: {} }],
    });
    assert.equal(result.outcome, "unconfirmed");
    assert.equal(result.normalizedState, "UNCONFIRMED");
    assert.equal(result.error?.code, "FC_STATUS_UNCONFIRMED");
  });

  test("an unrecognised status is UNKNOWN and never mapped to success", async () => {
    const { result } = await run({
      status: [{ status: 200, body: { ...F.REAL_STATUS_COMPLETED, status: "settling_v2" }, headers: {} }],
    });
    assert.equal(result.normalizedState, "UNKNOWN");
    assert.notEqual(result.outcome, "verified");
  });

  test("a failed execution carrying only a timeout receipt is not called failed", async () => {
    const { result } = await run({
      status: [{ status: 200, body: F.DOC_STATUS_FAILED_TIMEOUT, headers: {} }],
    });
    assert.equal(result.normalizedState, "UNCONFIRMED");
    assert.equal(result.outcome, "unconfirmed");
  });

  test("a reverted receipt is a real failure and is never claimed as success", async () => {
    const { result } = await run({
      status: [{ status: 200, body: F.DOC_STATUS_FAILED_REVERTED, headers: { "x-poll-interval-hint": "0" } }],
    });
    assert.equal(result.outcome, "stopped");
    assert.notEqual(result.outcome as string, "verified");
  });

  test("a receipt the public node reports as reverted stops the run", async () => {
    const { result } = await run({ receipt: F.realReceipt({ status: "0x0" }) });
    assert.equal(result.error?.code, "FC_RECEIPT_REVERTED");
  });

  test("a missing receipt is unknown, not failed", async () => {
    const { result } = await run({ receipt: null });
    assert.equal(result.outcome, "unconfirmed");
    assert.equal(result.error?.code, "FC_RECEIPT_NOT_FOUND");
  });

  test("a successful receipt with no Flightcheck event fails verification", async () => {
    const { result } = await run({ receipt: F.realReceipt({ logs: [] }) });
    assert.equal(result.error?.code, "FC_EVENT_MISSING");
  });

  test("the right event from the wrong contract fails verification", async () => {
    const impostor = F.realReceipt({
      logs: [{ ...F.realReceipt().logs[0], address: "0x000000000000000000000000000000000000dEaD" }],
    });
    const { result } = await run({ receipt: impostor });
    assert.equal(result.error?.code, "FC_EVENT_WRONG_EMITTER");
  });

  test("a challenge that did not survive end to end fails verification", async () => {
    const wrong = F.realReceipt({
      logs: [{ ...F.realReceipt().logs[0], topics: [F.TOPIC0, "0x" + "0".repeat(24) + F.ORG_WALLET.slice(2), "0x" + "99".repeat(32)] }],
    });
    const { result } = await run({ receipt: wrong });
    assert.equal(result.error?.code, "FC_EVENT_CHALLENGE_MISMATCH");
  });

  test("an event reporting another chain fails verification", async () => {
    // Keeps the run's real challenge so the challenge check passes and the chain-id branch is
    // actually reached. Asserting a disjunction here previously let this test pass without ever
    // executing the branch it is named for.
    const { result } = await run({
      receiptTransform: (r) => ({
        ...r,
        logs: [{ ...r.logs[0]!, data: "0x" + (1).toString(16).padStart(64, "0") }],
      }),
    });
    assert.equal(result.error?.code, "FC_EVENT_CHAINID_MISMATCH");
  });

  test("hashes that disagree between the two legs stop the run", async () => {
    const { result } = await run({
      receipt: F.realReceipt({ transactionHash: "0x" + "11".repeat(32) }),
    });
    assert.equal(result.error?.code, "FC_HASH_DISAGREEMENT");
  });

  test("a foreign event sender fails verification", async () => {
    const { result } = await run({
      receiptTransform: (r) => ({
        ...r,
        logs: [
          {
            ...r.logs[0]!,
            topics: [
              F.TOPIC0,
              "0x000000000000000000000000deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
              r.logs[0]!.topics[2],
            ],
          },
        ],
      }),
    });
    assert.equal(result.error?.code, "FC_EVENT_SENDER_MISMATCH");
    assert.notEqual(result.outcome, "verified");
  });

  test("the sender check cannot be switched off by KeeperHub omitting `sponsored`", async () => {
    // Regression for an external audit finding. The assertion used to be gated on
    // status.sponsored === true, a value KeeperHub supplies, so omitting one optional boolean
    // skipped the only check binding the event to the organisation's identity. A run reached
    // PROOF_WRITTEN with a 0xdeadbeef sender and allLegsAgree: true.
    const withoutSponsored = { ...F.REAL_STATUS_COMPLETED } as Record<string, unknown>;
    delete withoutSponsored.sponsored;

    const { result } = await run({
      status: [{ status: 200, body: withoutSponsored, headers: { "x-poll-interval-hint": "0" } }],
      receiptTransform: (r) => ({
        ...r,
        logs: [
          {
            ...r.logs[0]!,
            topics: [
              F.TOPIC0,
              "0x000000000000000000000000deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
              r.logs[0]!.topics[2],
            ],
          },
        ],
      }),
    });
    assert.equal(result.error?.code, "FC_EVENT_SENDER_MISMATCH");
    assert.notEqual(result.outcome, "verified");
  });

  test("a matching sender still verifies when `sponsored` is absent", async () => {
    const withoutSponsored = { ...F.REAL_STATUS_COMPLETED } as Record<string, unknown>;
    delete withoutSponsored.sponsored;
    const { result } = await run({
      status: [{ status: 200, body: withoutSponsored, headers: { "x-poll-interval-hint": "0" } }],
    });
    assert.equal(result.outcome, "verified");
  });
});

describe("proof capsule", () => {
  test("records the pinned and observed bytecode hashes and their agreement", async () => {
    const { result } = await run({});
    const capsule = buildCapsule(result, "https://sepolia.base.org");
    const canary = capsule.canary as Record<string, unknown>;
    assert.equal(canary.expectedRuntimeBytecodeHash, BASE_SEPOLIA.expectedRuntimeBytecodeHash);
    assert.equal(canary.match, true);
    assert.equal((capsule.agreement as Record<string, unknown>).allLegsAgree, true);
  });

  test("a stopped run still produces a capsule naming the failure", async () => {
    const { result } = await run({ code: "0xdeadbeef" });
    const capsule = buildCapsule(result, "https://sepolia.base.org");
    assert.equal(capsule.outcome, "stopped");
    assert.equal(capsule.failureCode, "FC_CANARY_BYTECODE_MISMATCH");
    assert.equal((capsule.agreement as Record<string, unknown>).allLegsAgree, false);
  });

  test("records that the sender was asserted, and what KeeperHub claimed about sponsorship", async () => {
    const { result } = await run({});
    const capsule = buildCapsule(result, "https://sepolia.base.org");
    const iv = capsule.independentVerification as Record<string, unknown>;
    assert.equal(iv.senderAssertion, "asserted-and-matched");
    assert.equal(iv.senderMatchesOrgWallet, true);
    // Recorded as an observation, never as the thing that decides whether to check.
    assert.equal(iv.sponsoredReportedByKeeperHub, true);
  });

  test("independentEventMatches is false when the sender is foreign", async () => {
    const { result } = await run({
      receiptTransform: (r) => ({
        ...r,
        logs: [
          {
            ...r.logs[0]!,
            topics: [
              F.TOPIC0,
              "0x000000000000000000000000deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
              r.logs[0]!.topics[2],
            ],
          },
        ],
      }),
    });
    const capsule = buildCapsule(result, "https://sepolia.base.org");
    const agree = capsule.agreement as Record<string, unknown>;
    assert.equal(agree.independentEventMatches, false);
    assert.equal(agree.allLegsAgree, false);
  });
});
