/**
 * Bootstrap, gas-policy and faucet-client tests.
 *
 * The gas-policy cases are the important ones. Each asserts a refusal, and each refusal exists
 * because the alternative is either a wasted faucet payout or, in the ambiguous cases, a second
 * onchain transaction.
 *
 * These are fixture and unit tests. The live faucet behaviour is proved separately in
 * `evidence/faucet/live-acceptance.json`, and the KeeperHub insufficient-balance condition is
 * driven from a captured response shape rather than reproduced against the live API.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { evaluateFaucetEligibility, mayStartNewLogicalRun, faucetRequestId } from "../src/gaspolicy.ts";
import { buildRequestBody, FaucetClient, describeFaucetResult, FAUCET_PAYOUT_WEI } from "../src/faucet-client.ts";
import { assertNoSecretInArgv, hasInteractiveTty, acquireKeeperHubKey } from "../src/secret-input.ts";
import { FlightcheckError } from "../src/errors.ts";
import { registerSecret, clearSecrets, findLeaks } from "../src/redact.ts";
import { BASE_SEPOLIA } from "../src/config.ts";
import type { RunResult } from "../src/machine.ts";
import * as F from "./fixtures.ts";

const ORG = F.ORG_WALLET;

/** Minimal RunResult shaped for the policy under test. */
function runResult(over: Partial<RunResult> & { errorCode?: string; broadcastPossible?: boolean } = {}): RunResult {
  const error =
    over.errorCode === undefined
      ? null
      : Object.assign(new FlightcheckError(over.errorCode as never, {}), {
          broadcastPossible: over.broadcastPossible ?? false,
        });
  return {
    outcome: "stopped",
    record: {
      runId: "fc_11111111-1111-4111-8111-111111111111",
      challenge: "0x" + "11".repeat(32),
      chainId: 84532,
      canaryAddress: BASE_SEPOLIA.address,
      expectedRuntimeBytecodeHash: BASE_SEPOLIA.expectedRuntimeBytecodeHash,
      intendedOperation: "ping(bytes32)",
      canonicalRequestBody: "{}",
      canonicalRequestBodyHash: "sha256:x",
      idempotencyKey: "",
      orgWallet: ORG,
      organizationKeyPrefix: null,
      createdAt: new Date().toISOString(),
      executionId: null,
      transactionHash: null,
      stageReached: "SIMULATION_PASSED",
      attempts: 0,
      replayed: false,
      conflicts: 0,
      ...(over.record ?? {}),
    },
    deployment: BASE_SEPOLIA,
    stageReached: "SIMULATION_PASSED",
    orgWallet: ORG,
    simulation: null,
    status: null,
    normalizedState: null,
    receipt: null,
    event: null,
    sponsored: null,
    senderMatchesOrgWallet: null,
    error,
    timings: {},
    observedBytecodeHash: BASE_SEPOLIA.expectedRuntimeBytecodeHash,
    pollCount: 0,
    ...over,
  } as RunResult;
}

const NEEDS_GAS = { errorCode: "FC_SIM_INSUFFICIENT_BALANCE", broadcastPossible: false } as const;
const OPTS = { payoutWei: FAUCET_PAYOUT_WEI, recipientBalanceWei: 0n };

describe("gas policy: when the faucet may fire", () => {
  test("a conclusive pre-broadcast insufficient balance is eligible", () => {
    const d = evaluateFaucetEligibility(runResult(NEEDS_GAS), OPTS);
    assert.equal(d.eligible, true);
    assert.equal(d.eligible && d.recipient, ORG);
  });

  test("a zero balance alone is NOT a reason to fund", () => {
    // The canonical run landed a transaction from a wallet holding zero ETH, because the write
    // was sponsored. Funding on balance alone would solve a problem that usually is not there.
    const verified = runResult({ outcome: "verified", errorCode: undefined });
    const d = evaluateFaucetEligibility(verified, { ...OPTS, recipientBalanceWei: 0n });
    assert.equal(d.eligible, false);
    assert.equal(d.eligible === false && d.code, "sponsored_success");
  });

  test("a sponsored success never triggers the faucet", () => {
    const d = evaluateFaucetEligibility(runResult({ outcome: "verified", errorCode: undefined }), OPTS);
    assert.equal(d.eligible, false);
    assert.match(d.eligible === false ? d.reason : "", /sponsored|succeeded/i);
  });
});

describe("gas policy: every refusal that prevents a duplicate transaction", () => {
  test("unconfirmed cannot fund", () => {
    const d = evaluateFaucetEligibility(runResult({ outcome: "unconfirmed", errorCode: "FC_STATUS_UNCONFIRMED", broadcastPossible: true }), OPTS);
    assert.equal(d.eligible, false);
    assert.equal(d.eligible === false && d.code, "broadcast_possible");
  });

  test("a response loss cannot fund", () => {
    const d = evaluateFaucetEligibility(
      runResult({ errorCode: "FC_EXEC_TRANSPORT_LOST", broadcastPossible: true }),
      OPTS,
    );
    assert.equal(d.eligible, false);
    assert.equal(d.eligible === false && d.code, "broadcast_possible");
  });

  test("an existing execution id cannot fund, even on an insufficient-balance code", () => {
    const d = evaluateFaucetEligibility(
      runResult({ ...NEEDS_GAS, record: { executionId: "exec_123" } as never }),
      OPTS,
    );
    assert.equal(d.eligible, false);
    assert.equal(d.eligible === false && d.code, "execution_exists");
  });

  test("an observed transaction hash cannot fund", () => {
    const d = evaluateFaucetEligibility(
      runResult({ ...NEEDS_GAS, record: { transactionHash: "0x" + "ab".repeat(32) } as never }),
      OPTS,
    );
    assert.equal(d.eligible, false);
    assert.equal(d.eligible === false && d.code, "execution_exists");
  });

  test("a failed receipt cannot fund", () => {
    const d = evaluateFaucetEligibility(runResult({ errorCode: "FC_RECEIPT_REVERTED", broadcastPossible: true }), OPTS);
    assert.equal(d.eligible, false);
  });

  test("a wrong canary cannot fund", () => {
    const d = evaluateFaucetEligibility(runResult({ errorCode: "FC_CANARY_BYTECODE_MISMATCH" }), OPTS);
    assert.equal(d.eligible, false);
    assert.equal(d.eligible === false && d.code, "not_a_gas_problem");
  });

  test("an unverified canary cannot fund even on the right error code", () => {
    const d = evaluateFaucetEligibility(runResult({ ...NEEDS_GAS, observedBytecodeHash: "0xdeadbeef" }), OPTS);
    assert.equal(d.eligible, false);
    assert.equal(d.eligible === false && d.code, "canary_unverified");
  });

  test("a non-Base-Sepolia chain cannot fund", () => {
    const d = evaluateFaucetEligibility(
      runResult({ ...NEEDS_GAS, deployment: { ...BASE_SEPOLIA, chainId: 11155111 } as never }),
      OPTS,
    );
    assert.equal(d.eligible, false);
    assert.equal(d.eligible === false && d.code, "wrong_chain");
  });

  test("no resolved org wallet cannot fund", () => {
    const d = evaluateFaucetEligibility(runResult({ ...NEEDS_GAS, orgWallet: null }), OPTS);
    assert.equal(d.eligible, false);
    assert.equal(d.eligible === false && d.code, "no_org_wallet");
  });

  test("a wallet that already holds the payout is not funded again", () => {
    const d = evaluateFaucetEligibility(runResult(NEEDS_GAS), {
      ...OPTS,
      recipientBalanceWei: FAUCET_PAYOUT_WEI,
    });
    assert.equal(d.eligible, false);
    assert.equal(d.eligible === false && d.code, "already_funded");
  });

  test("every non-gas failure code is refused", () => {
    for (const code of [
      "FC_AUTH_INVALID",
      "FC_WALLET_UNRESOLVED",
      "FC_CHAIN_UNSUPPORTED",
      "FC_SIM_REVERT",
      "FC_EXEC_RATE_LIMITED",
      "FC_EVENT_CHALLENGE_MISMATCH",
    ]) {
      const d = evaluateFaucetEligibility(runResult({ errorCode: code }), OPTS);
      assert.equal(d.eligible, false, `${code} must not be fundable`);
    }
  });
});

describe("a new idempotency key is only correct after a proven pre-broadcast failure", () => {
  test("allowed when nothing could have been sent", () => {
    assert.equal(mayStartNewLogicalRun(runResult(NEEDS_GAS)), true);
  });

  test("refused when a transaction may exist", () => {
    assert.equal(
      mayStartNewLogicalRun(runResult({ errorCode: "FC_EXEC_TRANSPORT_LOST", broadcastPossible: true })),
      false,
    );
    assert.equal(
      mayStartNewLogicalRun(runResult({ ...NEEDS_GAS, record: { executionId: "e1" } as never })),
      false,
    );
    assert.equal(mayStartNewLogicalRun(runResult({ outcome: "unconfirmed" })), false);
    assert.equal(mayStartNewLogicalRun(runResult({ outcome: "verified", errorCode: undefined })), false);
  });

  test("the derived request id is deterministic and carries no secret", () => {
    const a = faucetRequestId("fc_abc-123", ORG);
    assert.equal(a, faucetRequestId("fc_abc-123", ORG));
    assert.match(a, /^[A-Za-z0-9._:-]{8,128}$/);
  });
});

describe("faucet client: the privacy boundary", () => {
  test("the request body carries only a recipient, a request id and a version", () => {
    const body = JSON.parse(buildRequestBody(ORG, "flightcheck-faucet-x-1234"));
    assert.deepEqual(Object.keys(body).sort(), ["flightcheckVersion", "recipient", "requestId"]);
  });

  test("no byte of a registered KeeperHub key reaches the faucet request", async () => {
    clearSecrets();
    const fakeKey = "kh_LIVE_LOOKING_KEY_abcdefghijklmnop";
    registerSecret(fakeKey);

    let captured: { url: string; init: RequestInit } | null = null;
    const client = new FaucetClient({
      baseUrl: "https://faucet.test.invalid",
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        captured = { url: String(url), init: init ?? {} };
        return new Response(JSON.stringify({ status: "funded", chainId: 84532 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    await client.request(ORG, "flightcheck-faucet-test-1234");

    assert.ok(captured);
    const c = captured as unknown as { url: string; init: RequestInit };
    // Everything on the wire: url, headers and body.
    const wire = c.url + JSON.stringify(c.init.headers ?? {}) + String(c.init.body ?? "");
    assert.ok(!wire.includes(fakeKey), "the key must not appear anywhere in the request");
    assert.ok(!wire.toLowerCase().includes("authorization"), "there must be no Authorization header");
    assert.deepEqual(findLeaks(wire), [], "no secret-shaped value may reach the faucet");
    clearSecrets();
  });

  test("every faucet status maps to a clear proceed decision", () => {
    for (const s of ["funded", "already_sufficient"] as const) {
      assert.equal(describeFaucetResult({ status: s, chainId: 84532 }).proceed, true);
    }
    for (const s of ["cooldown", "rate_limited", "treasury_low", "disabled", "invalid_address", "invalid_request", "rpc_unavailable", "send_failed"] as const) {
      const d = describeFaucetResult({ status: s, chainId: 84532 });
      assert.equal(d.proceed, false, `${s} must not proceed`);
      assert.ok(d.text.length > 10, `${s} must explain itself`);
    }
  });

  test("an unreachable faucet is a clean failure, not a crash", async () => {
    const client = new FaucetClient({
      baseUrl: "https://faucet.test.invalid",
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    await assert.rejects(
      () => client.request(ORG, "flightcheck-faucet-test-1234"),
      (e: FlightcheckError) => e.code === "FC_FAUCET_UNAVAILABLE",
    );
  });
});

describe("credential boundary", () => {
  test("a key on argv is refused in every shape", () => {
    for (const argv of [
      ["--key", "kh_abc"],
      ["--api-key=kh_abc"],
      ["kh_abcdefghijklmnop"],
      ["--token", "x"],
      ["wfb_abcdefghijklmnop"],
    ]) {
      assert.throws(
        () => assertNoSecretInArgv(argv),
        (e: FlightcheckError) => e.code === "FC_SECRET_IN_ARGV",
        `argv ${JSON.stringify(argv)} must be refused`,
      );
    }
  });

  test("ordinary flags are unaffected", () => {
    assert.doesNotThrow(() => assertNoSecretInArgv(["setup", "--execute", "--json", "--yes"]));
  });

  test("a non-TTY stream is not treated as interactive", () => {
    const pipe = new PassThrough() as unknown as NodeJS.ReadStream;
    assert.equal(hasInteractiveTty(pipe), false);
  });

  test("no TTY and no environment key fails closed rather than reading a pipe", async () => {
    await assert.rejects(
      () => acquireKeeperHubKey({ envValue: undefined, interactive: false }),
      (e: FlightcheckError) => e.code === "FC_SECRET_TTY_REQUIRED",
    );
  });

  test("the environment path still works for CI", async () => {
    clearSecrets();
    const got = await acquireKeeperHubKey({ envValue: "kh_ci_key_abcdefghijkl", interactive: false });
    assert.equal(got.source, "environment");
    assert.equal(got.key, "kh_ci_key_abcdefghijkl");
    clearSecrets();
  });

  test("an unfilled placeholder is treated as absent, not as a key", async () => {
    await assert.rejects(
      () => acquireKeeperHubKey({ envValue: "kh_...", interactive: false }),
      (e: FlightcheckError) => e.code === "FC_SECRET_TTY_REQUIRED",
    );
  });

  test("an interactively supplied key is registered with the redactor immediately", async () => {
    clearSecrets();
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode() {},
      isRaw: false,
    }) as unknown as NodeJS.ReadStream;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;

    const promise = acquireKeeperHubKey({ interactive: true, stdin, stdout });
    setTimeout(() => (stdin as unknown as PassThrough).write("kh_TYPED_SECRET_abcdefgh\r"), 10);
    const got = await promise;

    assert.equal(got.source, "interactive");
    // Registered means any later output carrying it is scrubbed.
    assert.ok(findLeaks("leak " + got.key).length > 0);
    clearSecrets();
  });

  test("the hidden prompt echoes nothing", async () => {
    clearSecrets();
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, isRaw: false }) as unknown as NodeJS.ReadStream;
    const out = new PassThrough();
    const chunks: string[] = [];
    out.on("data", (c) => chunks.push(String(c)));

    const promise = acquireKeeperHubKey({
      interactive: true,
      stdin,
      stdout: out as unknown as NodeJS.WriteStream,
    });
    setTimeout(() => (stdin as unknown as PassThrough).write("kh_NEVER_ECHOED_abcdefgh\r"), 10);
    await promise;

    const printed = chunks.join("");
    assert.ok(!printed.includes("kh_NEVER_ECHOED"), "the key must never reach the terminal");
    assert.ok(!printed.includes("NEVER_ECHOED"), "not even partially");
    clearSecrets();
  });
});
