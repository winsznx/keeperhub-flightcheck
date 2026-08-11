import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { keccak256, decodeFlightcheckEvent, findForeignFlightcheckLog, hashRuntimeBytecode, isEmptyCode } from "../src/rpc.ts";
import { normalizeState, reconcileState, normalizeReceiptStatus, isTerminal, mayHaveBroadcast, isInconclusive } from "../src/execstate.ts";
import { deriveIdempotencyKey, buildCanonicalBody, hashBody, RunStore, newChallenge, newRunId } from "../src/runstore.ts";
import { scrub, registerSecret, clearSecrets, findLeaks, safeRpcOrigin, scrubValue } from "../src/redact.ts";
import { classifyKey, parseDotenv } from "../src/env.ts";
import { FAILURES, FlightcheckError, type FailureCode } from "../src/errors.ts";
import { STAGES, isAtLeast, INDEPENDENT_STAGES } from "../src/stages.ts";
import { BASE_SEPOLIA } from "../src/config.ts";
import * as F from "./fixtures.ts";

const k = (s: string) => "0x" + keccak256(Buffer.from(s, "utf8")).toString("hex");

describe("keccak256", () => {
  test("matches known vectors", () => {
    assert.equal(k(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    assert.equal(k("abc"), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  });

  test("reproduces the pinned event topic and function selector", () => {
    assert.equal(k(BASE_SEPOLIA.eventSignature), BASE_SEPOLIA.eventTopic0);
    assert.equal(k("ping(bytes32)").slice(0, 10), "0x33d425c4");
  });

  test("survives inputs that straddle the 136-byte rate boundary", () => {
    for (const len of [135, 136, 137, 271, 272]) {
      const out = keccak256(Buffer.alloc(len, 0x61));
      assert.equal(out.length, 32);
    }
    // A second absorb block must change the digest.
    assert.notEqual(k("a".repeat(135)), k("a".repeat(136)));
  });

  test("empty code detection", () => {
    assert.ok(isEmptyCode("0x"));
    assert.ok(isEmptyCode(""));
    assert.ok(!isEmptyCode("0x60806040"));
  });

  test("hashes runtime bytecode the way cast does", () => {
    // keccak of the empty byte string, which is what an empty account returns.
    assert.equal(hashRuntimeBytecode("0x"), k(""));
  });
});

describe("execution state normalisation", () => {
  test("maps every documented value", () => {
    assert.equal(normalizeState("pending"), "PENDING");
    assert.equal(normalizeState("running"), "RUNNING");
    assert.equal(normalizeState("completed"), "COMPLETED");
    assert.equal(normalizeState("failed"), "FAILED");
  });

  test("unconfirmed is a first-class state, not UNKNOWN", () => {
    assert.equal(normalizeState("unconfirmed"), "UNCONFIRMED");
    assert.notEqual(normalizeState("unconfirmed"), "UNKNOWN");
    assert.equal(isTerminal("UNCONFIRMED"), false);
  });

  test("an unrecognised future status is UNKNOWN and non-terminal", () => {
    for (const v of ["settling", "queued_v2", "", null, undefined, 42, {}]) {
      assert.equal(normalizeState(v), "UNKNOWN");
    }
    assert.equal(isTerminal("UNKNOWN"), false);
  });

  test("only completed and failed end the poll loop", () => {
    assert.ok(isTerminal("COMPLETED"));
    assert.ok(isTerminal("FAILED"));
    for (const s of ["PENDING", "RUNNING", "UNCONFIRMED", "UNKNOWN"] as const) {
      assert.ok(!isTerminal(s));
    }
  });

  test("anything past PENDING may already have broadcast", () => {
    assert.equal(mayHaveBroadcast("PENDING"), false);
    for (const s of ["RUNNING", "UNCONFIRMED", "COMPLETED", "FAILED", "UNKNOWN"] as const) {
      assert.ok(mayHaveBroadcast(s));
    }
  });

  test("receipt statuses, with the inconclusive ones identified", () => {
    assert.equal(normalizeReceiptStatus("success"), "success");
    assert.equal(normalizeReceiptStatus("safe_inner_failure"), "safe_inner_failure");
    assert.equal(normalizeReceiptStatus("something_new"), "unrecognised");
    assert.ok(isInconclusive("not_found"));
    assert.ok(isInconclusive("timeout"));
    assert.ok(isInconclusive("unrecognised"));
    assert.ok(!isInconclusive("reverted"));
  });

  test("a failed execution with only inconclusive receipts downgrades to UNCONFIRMED", () => {
    const state = reconcileState(
      normalizeState(F.DOC_STATUS_FAILED_TIMEOUT.status),
      F.DOC_STATUS_FAILED_TIMEOUT.receipts,
    );
    assert.equal(state, "UNCONFIRMED");
  });

  test("a failed execution with a reverted receipt stays FAILED", () => {
    const state = reconcileState(
      normalizeState(F.DOC_STATUS_FAILED_REVERTED.status),
      F.DOC_STATUS_FAILED_REVERTED.receipts,
    );
    assert.equal(state, "FAILED");
  });

  test("a completed execution is never downgraded", () => {
    assert.equal(
      reconcileState(normalizeState(F.REAL_STATUS_COMPLETED.status), F.REAL_STATUS_COMPLETED.receipts),
      "COMPLETED",
    );
  });
});

describe("idempotency identity", () => {
  const base = {
    runId: "fc_11111111-1111-4111-8111-111111111111",
    chainId: 84532,
    contractAddress: F.CANARY,
    functionName: "ping",
    functionArgs: '["0xdead"]',
    value: "0",
  };

  test("is deterministic across processes, which is what makes resume possible", () => {
    assert.equal(deriveIdempotencyKey(base), deriveIdempotencyKey({ ...base }));
    assert.match(deriveIdempotencyKey(base), /^[0-9a-f]{64}$/);
  });

  test("address casing does not change the key", () => {
    assert.equal(
      deriveIdempotencyKey(base),
      deriveIdempotencyKey({ ...base, contractAddress: F.CANARY.toLowerCase() }),
    );
  });

  test("different work gives a different key", () => {
    const other = deriveIdempotencyKey({ ...base, functionArgs: '["0xbeef"]' });
    assert.notEqual(deriveIdempotencyKey(base), other);
    assert.notEqual(deriveIdempotencyKey(base), deriveIdempotencyKey({ ...base, chainId: 11155111 }));
  });

  test("a separator embedded in a field cannot forge another intent", () => {
    // Without escaping, runId "a|84532" would join to the same string as runId "a" on 84532.
    const forged = deriveIdempotencyKey({ ...base, runId: "fc_x|84532" });
    const honest = deriveIdempotencyKey({ ...base, runId: "fc_x" });
    assert.notEqual(forged, honest);
  });

  test("the canonical body has stable key order so a resume reproduces the bytes", () => {
    const body = buildCanonicalBody({
      contractAddress: F.CANARY,
      chainId: 84532,
      functionName: "ping",
      functionArgs: '["0x01"]',
      abi: "[]",
    });
    assert.equal(
      body,
      '{"contractAddress":"' + F.CANARY + '","chainId":84532,"functionName":"ping","functionArgs":"[\\"0x01\\"]","abi":"[]"}',
    );
    assert.match(hashBody(body), /^sha256:[0-9a-f]{64}$/);
  });
});

describe("run store", () => {
  test("persists, reloads and round-trips a record", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "fc-store-"));
    try {
      const store = new RunStore(dir);
      const record = {
        runId: newRunId(),
        challenge: newChallenge(),
        chainId: 84532,
        canaryAddress: F.CANARY,
        expectedRuntimeBytecodeHash: BASE_SEPOLIA.expectedRuntimeBytecodeHash,
        intendedOperation: "ping(bytes32)",
        canonicalRequestBody: "{}",
        canonicalRequestBodyHash: "sha256:x",
        idempotencyKey: "k".repeat(64),
        orgWallet: F.ORG_WALLET,
        organizationKeyPrefix: null,
        createdAt: new Date().toISOString(),
        executionId: null,
        transactionHash: null,
        stageReached: "EXECUTION_PREPARED" as const,
        attempts: 0,
        replayed: false,
        conflicts: 0,
      };
      store.save(record);
      assert.deepEqual(store.load(record.runId), record);
      assert.equal(store.list().length, 1);

      // The record is written before a request goes out, so it must not be world-readable.
      const raw = readFileSync(resolve(dir, `${record.runId}.json`), "utf8");
      assert.ok(raw.includes(record.idempotencyKey));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a run id that could escape the state directory", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "fc-store-"));
    try {
      const store = new RunStore(dir);
      for (const bad of ["../../etc/passwd", "fc_../x", "not-a-run-id", ""]) {
        assert.throws(() => store.load(bad), /FC_RESUME_NOT_FOUND|Error/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses to resume past the 24 hour replay window", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "fc-store-"));
    try {
      const store = new RunStore(dir);
      const old = { createdAt: new Date(Date.now() - 25 * 3600_000).toISOString(), runId: "fc_x" } as never;
      assert.throws(() => store.assertResumable(old), (e: FlightcheckError) => e.code === "FC_RESUME_WINDOW_EXPIRED");

      const fresh = { createdAt: new Date().toISOString(), runId: "fc_x" } as never;
      assert.doesNotThrow(() => store.assertResumable(fresh));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("event verification", () => {
  test("decodes the real Phase 1 receipt", () => {
    const ev = decodeFlightcheckEvent(F.realReceipt() as never, F.CANARY, F.TOPIC0);
    assert.ok(ev);
    assert.equal(ev.sender, F.ORG_WALLET);
    assert.equal(ev.challenge, "0x61b3cc48dd907bdfff36b62bf6b7faddc5adcaede477797ca0a035114a3fb4e2");
    assert.equal(ev.chainId, 84532);
    assert.equal(ev.emitter, F.CANARY.toLowerCase());
  });

  test("a matching signature from another contract does not count", () => {
    const impostor = F.realReceipt({
      logs: [{ ...F.realReceipt().logs[0], address: "0x000000000000000000000000000000000000dead" }],
    });
    assert.equal(decodeFlightcheckEvent(impostor as never, F.CANARY, F.TOPIC0), null);
    assert.ok(findForeignFlightcheckLog(impostor as never, F.TOPIC0));
  });

  test("no matching log at all returns null", () => {
    const empty = F.realReceipt({ logs: [] });
    assert.equal(decodeFlightcheckEvent(empty as never, F.CANARY, F.TOPIC0), null);
    assert.equal(findForeignFlightcheckLog(empty as never, F.TOPIC0), undefined);
  });

  test("a different chain id in the event data is visible to the caller", () => {
    const wrongChain = F.realReceipt({
      logs: [{ ...F.realReceipt().logs[0], data: "0x" + (1).toString(16).padStart(64, "0") }],
    });
    const ev = decodeFlightcheckEvent(wrongChain as never, F.CANARY, F.TOPIC0);
    assert.equal(ev?.chainId, 1);
  });

  test("the sponsored path really does hide the org wallet from receipt-level checks", () => {
    // This is the reason verification goes hash to receipt to log rather than by wallet state.
    const r = F.realReceipt();
    assert.notEqual(r.from.toLowerCase(), F.ORG_WALLET);
    assert.notEqual((r.to ?? "").toLowerCase(), F.CANARY.toLowerCase());
    assert.equal(decodeFlightcheckEvent(r as never, F.CANARY, F.TOPIC0)?.sender, F.ORG_WALLET);
  });
});

describe("secret containment", () => {
  test("scrubs a registered value and any usable prefix of it", () => {
    clearSecrets();
    registerSecret("kh_SUPERSECRETVALUE123456");
    assert.ok(!scrub("key=kh_SUPERSECRETVALUE123456").includes("SUPERSECRET"));
    assert.ok(!scrub("masked kh_SUPER…").includes("kh_SUPER"));
    clearSecrets();
  });

  test("catches secret shapes nobody registered", () => {
    clearSecrets();
    assert.ok(!scrub("Bearer kh_abcdefghijklmnop").includes("kh_abcdefghijklmnop"));
    assert.ok(!scrub("wfb_abcdefghijklmnop").includes("wfb_abcdefghijklmnop"));
    assert.ok(!scrub("pk " + "a".repeat(64)).includes("a".repeat(64)));
  });

  test("does not mangle values we publish on purpose", () => {
    clearSecrets();
    const tx = "0xb4098917d12030a249e9376217d765b715362c744dd23e9b03e0213253d452dc";
    assert.equal(scrub(tx), tx);
    assert.equal(scrub(BASE_SEPOLIA.expectedRuntimeBytecodeHash), BASE_SEPOLIA.expectedRuntimeBytecodeHash);
    assert.equal(scrub(F.CANARY), F.CANARY);
  });

  test("scrubs nested structures including keys", () => {
    clearSecrets();
    registerSecret("kh_NESTEDSECRET0000");
    const out = scrubValue({ a: { b: ["kh_NESTEDSECRET0000"] } }) as { a: { b: string[] } };
    assert.ok(!JSON.stringify(out).includes("NESTEDSECRET"));
    clearSecrets();
  });

  test("findLeaks reports without echoing the secret", () => {
    clearSecrets();
    registerSecret("kh_LEAKDETECTIONVALUE");
    const hits = findLeaks("oops kh_LEAKDETECTIONVALUE");
    assert.ok(hits.length > 0);
    assert.ok(!JSON.stringify(hits).includes("LEAKDETECTION"));
    clearSecrets();
  });

  test("only a keyless RPC origin is publishable as provenance", () => {
    assert.equal(safeRpcOrigin("https://sepolia.base.org"), "https://sepolia.base.org");
    assert.equal(safeRpcOrigin("https://sepolia.base.org/"), "https://sepolia.base.org");
    assert.equal(safeRpcOrigin("https://eth-sepolia.g.alchemy.com/v2/SECRETKEY"), "redacted");
    assert.equal(safeRpcOrigin("https://node.example/?apikey=SECRET"), "redacted");
    assert.equal(safeRpcOrigin("https://user:pass@node.example"), "redacted");
  });
});

describe("environment and credential shape", () => {
  test("classifies key types before any network call", () => {
    assert.equal(classifyKey("kh_realkey"), "organisation");
    assert.equal(classifyKey("wfb_userkey"), "user");
    assert.equal(classifyKey("sk-something"), "unknown");
    assert.equal(classifyKey(undefined), "absent");
    assert.equal(classifyKey("kh_..."), "absent");
  });

  test("parses .env without a dependency, including quotes and comments", () => {
    const parsed = parseDotenv(
      ['# comment', 'A=1', 'B="two"', "C='three'", "D=has=equals", "  E = spaced ", "bad"].join("\n"),
    );
    assert.deepEqual(parsed, { A: "1", B: "two", C: "three", D: "has=equals", E: "spaced" });
  });
});

describe("failure taxonomy", () => {
  test("every code has a stage, a title and a usable remediation", () => {
    for (const code of Object.keys(FAILURES) as FailureCode[]) {
      const spec = FAILURES[code];
      assert.ok(STAGES.includes(spec.stage), `${code} has a real stage`);
      assert.ok(spec.title.length > 8, `${code} has a title`);
      const text = spec.remediation({ runId: "fc_test" });
      assert.ok(text.length > 20, `${code} explains what to do`);
    }
  });

  test("every code that can follow a submission is marked broadcastPossible", () => {
    const mustBeTrue: FailureCode[] = [
      "FC_EXEC_TRANSPORT_LOST",
      "FC_EXEC_IDEMPOTENCY_CONFLICT",
      "FC_EXEC_IDEMPOTENCY_IN_PROGRESS",
      "FC_EXEC_NO_ID",
      "FC_STATUS_UNCONFIRMED",
      "FC_STATUS_UNKNOWN",
      "FC_RECEIPT_NOT_FOUND",
      "FC_RECEIPT_UNVERIFIED",
      "FC_EXEC_FAILED",
      "FC_RESUME_WINDOW_EXPIRED",
    ];
    for (const code of mustBeTrue) {
      assert.equal(FAILURES[code].broadcastPossible, true, `${code} must warn about a possible transaction`);
    }
  });

  test("nothing before the broadcast claims a transaction might exist", () => {
    const mustBeFalse: FailureCode[] = [
      "FC_ENV_MISSING_KEY",
      "FC_ENV_WRONG_KEY_TYPE",
      "FC_AUTH_INVALID",
      "FC_CHAIN_UNSUPPORTED",
      "FC_CANARY_BYTECODE_MISMATCH",
      "FC_SIM_REVERT",
      "FC_SIM_INSUFFICIENT_BALANCE",
    ];
    for (const code of mustBeFalse) {
      assert.equal(FAILURES[code].broadcastPossible, false, `${code} must not imply a transaction`);
    }
  });

  test("the wrong-key-type message names the actual mistake", () => {
    const e = new FlightcheckError("FC_ENV_WRONG_KEY_TYPE");
    assert.match(e.remediation, /wfb_/);
    assert.match(e.remediation, /kh_/);
  });

  test("an unfunded wallet message names the org wallet, not the sign-in wallet", () => {
    const e = new FlightcheckError("FC_SIM_INSUFFICIENT_BALANCE", { wallet: F.ORG_WALLET });
    assert.match(e.remediation, /not the wallet you signed\s*\n?\s*in with/);
  });

  test("a conflict with no original execution id says not to rotate the key", () => {
    const e = new FlightcheckError("FC_EXEC_IDEMPOTENCY_CONFLICT", { runId: "fc_x" });
    assert.match(e.remediation, /rotating it is the one action/);
  });
});

describe("stage ordering", () => {
  test("stages are ordered and comparable", () => {
    assert.ok(isAtLeast("EVENT_VERIFIED", "SIMULATION_PASSED"));
    assert.ok(!isAtLeast("AUTHENTICATED", "RECEIPT_CONFIRMED"));
  });

  test("the two independent stages are the ones that do not trust KeeperHub", () => {
    assert.deepEqual([...INDEPENDENT_STAGES].sort(), ["CANARY_VERIFIED", "EVENT_VERIFIED"]);
  });

  test("EXECUTION_CREATED and BROADCAST_OBSERVED stay distinct", () => {
    // The response-loss failure lands between them, so collapsing them loses the recovery case.
    assert.equal(STAGES.indexOf("BROADCAST_OBSERVED") - STAGES.indexOf("EXECUTION_CREATED"), 1);
  });
});
