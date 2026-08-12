/**
 * The Flightcheck state machine.
 *
 * Runs the stages in order, stopping at the first one that cannot be satisfied. Two stages are
 * answered by a public node rather than by KeeperHub, and a run is only `verified` when every
 * independent invariant holds. KeeperHub reporting `completed` is one leg of the proof and is
 * never the verdict on its own.
 */

import { BASE_SEPOLIA, CANARY_ABI, deploymentFor, type CanaryDeployment } from "./config.ts";
import { FlightcheckError } from "./errors.ts";
import { KeeperHubClient, type ExecutionStatus, type SimulationResult, type Transport } from "./keeperhub.ts";
import {
  Rpc,
  decodeFlightcheckEvent,
  findForeignFlightcheckLog,
  hashRuntimeBytecode,
  isEmptyCode,
  sleep,
  type DecodedFlightcheckEvent,
  type RpcReceipt,
} from "./rpc.ts";
import {
  buildCanonicalBody,
  deriveIdempotencyKey,
  hashBody,
  newChallenge,
  newRunId,
  RunStore,
  type RunRecord,
} from "./runstore.ts";
import { isTerminal, normalizeReceiptStatus, reconcileState, type ExecState } from "./execstate.ts";
import type { Stage } from "./stages.ts";

export interface RunOptions {
  readonly apiKey: string;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly stateDir: string;
  readonly execute: boolean;
  readonly resumeRunId?: string;
  readonly transport?: Transport;
  readonly baseUrl?: string;
  readonly onStage?: (stage: Stage, detail?: string) => void;
  readonly onNote?: (note: string) => void;
  /** Bounds the settle wait so a hung run reports UNCONFIRMED instead of blocking forever. */
  readonly maxPolls?: number;
  readonly receiptAttempts?: number;
  readonly receiptIntervalMs?: number;
}

export interface RunResult {
  readonly outcome: "verified" | "simulated" | "stopped" | "unconfirmed";
  readonly record: RunRecord;
  readonly deployment: CanaryDeployment;
  readonly stageReached: Stage;
  readonly orgWallet: string | null;
  readonly simulation: SimulationResult | null;
  readonly status: ExecutionStatus | null;
  readonly normalizedState: ExecState | null;
  readonly receipt: RpcReceipt | null;
  readonly event: DecodedFlightcheckEvent | null;
  readonly sponsored: boolean | null;
  readonly senderMatchesOrgWallet: boolean | null;
  readonly error: FlightcheckError | null;
  readonly timings: Record<string, number>;
  readonly observedBytecodeHash: string | null;
  readonly pollCount: number;
}

export async function runFlightcheck(opts: RunOptions): Promise<RunResult> {
  const timings: Record<string, number> = {};
  /*
   * Times an operation, and tags every request it makes with its name.
   *
   * The tag is the operation rather than the last completed stage, because those are different
   * answers to the question a support reader is asking. The simulate call happens while the run
   * has only reached CANARY_VERIFIED, so tagging by stage would label it with the step before
   * the one that produced it. `simulate` says what the request was for.
   */
  const mark = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    kh.stage = name;
    try {
      return await fn();
    } finally {
      timings[name] = Date.now() - t;
    }
  };

  const deployment = deploymentFor(opts.chainId) ?? BASE_SEPOLIA;
  const store = new RunStore(opts.stateDir);
  const kh = new KeeperHubClient(opts.apiKey, {
    baseUrl: opts.baseUrl,
    transport: opts.transport,
    runId: opts.resumeRunId ?? undefined,
  });
  const rpc = new Rpc(opts.rpcUrl);

  let stage: Stage = "START";
  let orgWallet: string | null = null;
  let simulation: SimulationResult | null = null;
  let status: ExecutionStatus | null = null;
  let normalized: ExecState | null = null;
  let receipt: RpcReceipt | null = null;
  let event: DecodedFlightcheckEvent | null = null;
  let observedHash: string | null = null;
  let pollCount = 0;

  const resuming = Boolean(opts.resumeRunId);
  let record: RunRecord;

  if (opts.resumeRunId) {
    record = store.load(opts.resumeRunId);
    // A record with no idempotency key never reached the point of sending anything, so there is
    // nothing to replay and nothing could have been broadcast.
    if (!record.idempotencyKey) {
      throw new FlightcheckError("FC_RESUME_NOTHING_TO_REPLAY", { runId: record.runId });
    }
    store.assertResumable(record);
    opts.onNote?.(`Resuming ${record.runId}. Replaying the persisted request and idempotency key.`);
  } else {
    // Placeholder until EXECUTION_PREPARED fills it in. Nothing is sent before then.
    record = {
      runId: newRunId(),
      challenge: newChallenge(),
      chainId: deployment.chainId,
      canaryAddress: deployment.address,
      expectedRuntimeBytecodeHash: deployment.expectedRuntimeBytecodeHash,
      intendedOperation: `${deployment.functionName}(bytes32)`,
      canonicalRequestBody: "",
      canonicalRequestBodyHash: "",
      idempotencyKey: "",
      orgWallet: null,
      organizationKeyPrefix: null,
      createdAt: new Date().toISOString(),
      executionId: null,
      transactionHash: null,
      stageReached: "START",
      attempts: 0,
      replayed: false,
      conflicts: 0,
    };
  }

  // The client tags every request with the run and the stage that caused it, so a support
  // capsule can say which step a KeeperHub request id belongs to. The record exists by now for
  // both a fresh run and a resume.
  kh.runId = record.runId;
  kh.stage = "start";

  const advance = (next: Stage, detail?: string) => {
    stage = next;
    record.stageReached = next;
    opts.onStage?.(next, detail);
  };

  const finish = (
    outcome: RunResult["outcome"],
    error: FlightcheckError | null = null,
  ): RunResult => {
    // Correlation ids are diagnostics, not secrets, and they are most useful when the run failed.
    record.httpTrace = kh.traces.map((tr) => ({
      stage: tr.stage ?? "unknown",
      method: tr.method,
      path: tr.path,
      status: tr.status,
      elapsedMs: tr.elapsedMs,
      sentRequestId: tr.sentRequestId ?? null,
      serverRequestId: tr.requestId ?? null,
      serverRequestIdSource: tr.requestIdSource ?? null,
    }));
    // Persist the final stage so `status` describes where the run actually ended rather than
    // wherever it happened to be at the last mid-run save.
    //
    // A run that stopped is saved even if it never reached the point of persisting a request,
    // because that is precisely the run someone needs help with: `support <run-id>` has nothing
    // to read otherwise, and "it failed at authentication" is the most common first-run report
    // there is. A clean preflight sent nothing and still leaves no record behind.
    if (record.idempotencyKey || error !== null) {
      try {
        store.save(record);
      } catch {
        // A failure to record the outcome must not change the outcome.
      }
    }
    return buildResult(outcome, error);
  };

  const buildResult = (
    outcome: RunResult["outcome"],
    error: FlightcheckError | null = null,
  ): RunResult => ({
    outcome,
    record,
    deployment,
    stageReached: stage,
    orgWallet,
    simulation,
    status,
    normalizedState: normalized,
    receipt,
    event,
    sponsored: status?.sponsored ?? null,
    senderMatchesOrgWallet:
      event && orgWallet ? event.sender.toLowerCase() === orgWallet.toLowerCase() : null,
    error,
    timings,
    observedBytecodeHash: observedHash,
    pollCount,
  });

  try {
    // 1. AUTHENTICATED. /api/chains answers without a credential, so it cannot prove this.
    const auth = await mark("authenticate", () => kh.verifyAuth());
    advance("AUTHENTICATED", auth.scope ? `scope ${auth.scope}` : undefined);

    // 2. WALLET_RESOLVED. The execution wallet, which is not the sign-in wallet.
    orgWallet = await mark("resolveWallet", () => kh.resolveOrgWallet());
    record = { ...record, orgWallet };
    advance("WALLET_RESOLVED", orgWallet);

    // 3. CHAIN_RESOLVED.
    await mark("resolveChain", async () => {
      const chains = await kh.listChains();
      const chain = chains.find((c) => c.chainId === deployment.chainId);
      if (!chain) throw new FlightcheckError("FC_CHAIN_UNSUPPORTED", { chainId: deployment.chainId });
      if (!chain.isEnabled) throw new FlightcheckError("FC_CHAIN_DISABLED", { chainId: deployment.chainId });
      if (!chain.isTestnet) throw new FlightcheckError("FC_CHAIN_NOT_TESTNET", { chainId: deployment.chainId });
    });
    advance("CHAIN_RESOLVED", `${deployment.chainName} (${deployment.chainId})`);

    // 4. CANARY_VERIFIED. Independent of KeeperHub. Fails closed.
    await mark("verifyCanary", async () => {
      await rpc.assertChain(deployment.chainId);
      const code = await rpc.getCode(deployment.address);
      if (isEmptyCode(code)) {
        throw new FlightcheckError("FC_CANARY_NO_CODE", {
          address: deployment.address,
          chainId: deployment.chainId,
        });
      }
      observedHash = hashRuntimeBytecode(code);
      if (observedHash.toLowerCase() !== deployment.expectedRuntimeBytecodeHash.toLowerCase()) {
        throw new FlightcheckError("FC_CANARY_BYTECODE_MISMATCH", {
          expected: deployment.expectedRuntimeBytecodeHash,
          actual: observedHash,
        });
      }
    });
    advance("CANARY_VERIFIED", observedHash ?? undefined);

    // The exact bytes for both simulation and broadcast, so what was inspected is what is sent.
    const functionArgs = JSON.stringify([record.challenge]);
    const canonicalBody = buildCanonicalBody({
      contractAddress: deployment.address,
      chainId: deployment.chainId,
      functionName: deployment.functionName,
      functionArgs,
      abi: JSON.stringify(CANARY_ABI),
    });

    // 5. SIMULATION_PASSED. Skipped on resume: a transaction may already exist, and the point
    //    of resuming is to find out, not to re-inspect a call that has possibly already run.
    if (!resuming) {
      simulation = await mark("simulate", () => kh.simulate(JSON.parse(canonicalBody)));
      advance("SIMULATION_PASSED", simulation.gasEstimate ? `gas ${simulation.gasEstimate}` : undefined);
    } else {
      advance("SIMULATION_PASSED", "skipped on resume");
    }

    if (!opts.execute && !resuming) {
      return finish("simulated");
    }

    // 6. EXECUTION_PREPARED. Persist and fsync BEFORE anything is sent.
    if (!resuming) {
      record = {
        ...record,
        canonicalRequestBody: canonicalBody,
        canonicalRequestBodyHash: hashBody(canonicalBody),
        idempotencyKey: deriveIdempotencyKey({
          runId: record.runId,
          chainId: deployment.chainId,
          contractAddress: deployment.address,
          functionName: deployment.functionName,
          functionArgs,
          value: "0",
        }),
      };
      store.save(record);
    }
    advance("EXECUTION_PREPARED", record.idempotencyKey.slice(0, 16) + "…");

    // 7. EXECUTION_CREATED.
    record.attempts += 1;
    store.save(record);

    let broadcastError: FlightcheckError | null = null;
    try {
      const result = await mark("execute", () =>
        kh.broadcast(record.canonicalRequestBody, record.idempotencyKey),
      );
      if (result.idempotentReplay) {
        record.replayed = true;
        opts.onNote?.(
          "KeeperHub replayed the stored response for this idempotency key. This outcome already " +
            "happened; no second transaction was created.",
        );
      }
      if (result.executionId) {
        record.executionId = result.executionId;
        store.save(record);
      }
      if (result.transactionHash) record.transactionHash = result.transactionHash;
      if (!result.executionId) throw new FlightcheckError("FC_EXEC_NO_ID", { runId: record.runId });
    } catch (err) {
      const fe = err as FlightcheckError;
      // A conflict that names the original execution is an answer, not a dead end.
      if (fe.code === "FC_EXEC_IDEMPOTENCY_CONFLICT") {
        record.conflicts += 1;
        const original = fe.context.originalExecutionId as string | undefined;
        if (original) {
          record.executionId = original;
          store.save(record);
          opts.onNote?.(
            "Idempotency conflict resolved: KeeperHub named the original execution, so this run " +
              "reconciles that instead of broadcasting again.",
          );
        } else {
          throw withRunId(fe, record.runId);
        }
      } else if (fe.code === "FC_EXEC_TRANSPORT_LOST" && record.executionId) {
        opts.onNote?.("Response lost, but an execution id is already on disk. Reconciling it.");
      } else if (fe.code === "FC_EXEC_TRANSPORT_LOST" && !record.executionId) {
        // Nothing observed. The persisted key is the only way back to the original outcome.
        opts.onNote?.(
          "The response was lost and no execution id was ever seen. Replaying the persisted " +
            "idempotency key to recover the original outcome.",
        );
        try {
          const replay = await kh.broadcast(record.canonicalRequestBody, record.idempotencyKey);
          if (replay.idempotentReplay) record.replayed = true;
          if (replay.executionId) {
            record.executionId = replay.executionId;
            store.save(record);
          } else {
            throw withRunId(fe, record.runId);
          }
        } catch (replayErr) {
          // The replay failed too, so the process ends holding only the persisted record.
          // That is the case --resume exists for, and the message has to say so by run id.
          throw withRunId(
            replayErr instanceof FlightcheckError ? replayErr : fe,
            record.runId,
          );
        }
      } else {
        throw withRunId(fe, record.runId);
      }
      broadcastError = fe;
    }

    if (!record.executionId) {
      throw withRunId(broadcastError ?? new FlightcheckError("FC_EXEC_NO_ID"), record.runId);
    }
    advance("EXECUTION_CREATED", record.executionId);

    // 8. BROADCAST_OBSERVED. The 202 carries no transactionHash for /contract-call even when
    //    status is already completed, so the hash comes from the status endpoint.
    const settle = await mark("settle", () =>
      pollUntilTerminal(kh, record.executionId!, {
        maxPolls: opts.maxPolls ?? 40,
        onPoll: () => {
          pollCount += 1;
        },
      }),
    );
    status = settle;
    normalized = reconcileState(settle.state, settle.receipts);

    if (settle.transactionHash) {
      record.transactionHash = settle.transactionHash;
      store.save(record);
    }
    if (!record.transactionHash) {
      if (normalized === "UNCONFIRMED" || normalized === "UNKNOWN") {
        return finish(
          "unconfirmed",
          withRunId(
            new FlightcheckError(
              normalized === "UNCONFIRMED" ? "FC_STATUS_UNCONFIRMED" : "FC_STATUS_UNKNOWN",
              { status: settle.serverStatus },
            ),
            record.runId,
          ),
        );
      }
      throw withRunId(
        new FlightcheckError("FC_EXEC_FAILED", { detail: describeError(settle.error) }),
        record.runId,
      );
    }
    advance("BROADCAST_OBSERVED", record.transactionHash);

    // 9. RECEIPT_CONFIRMED.
    if (normalized === "FAILED") {
      throw withRunId(
        new FlightcheckError("FC_EXEC_FAILED", { detail: describeError(settle.error) }),
        record.runId,
      );
    }
    if (normalized === "UNCONFIRMED" || normalized === "UNKNOWN") {
      return finish(
        "unconfirmed",
        withRunId(
          new FlightcheckError(
            normalized === "UNCONFIRMED" ? "FC_STATUS_UNCONFIRMED" : "FC_STATUS_UNKNOWN",
            { status: settle.serverStatus },
          ),
          record.runId,
        ),
      );
    }

    const badReceipt = settle.receipts.find(
      (r) => r.verified !== true || normalizeReceiptStatus(r.receiptStatus) !== "success",
    );
    if (badReceipt) {
      throw withRunId(
        new FlightcheckError("FC_RECEIPT_UNVERIFIED", {
          receiptStatus: String(badReceipt.receiptStatus ?? "unknown"),
        }),
        record.runId,
      );
    }

    // The independent leg. KeeperHub's own receipt check does not count here.
    receipt = await mark("verifyReceipt", () =>
      rpc.waitForReceipt(record.transactionHash!, {
        attempts: opts.receiptAttempts ?? 20,
        intervalMs: opts.receiptIntervalMs ?? 2000,
      }),
    );
    if (!receipt) {
      return finish(
        "unconfirmed",
        withRunId(new FlightcheckError("FC_RECEIPT_NOT_FOUND"), record.runId),
      );
    }
    if (receipt.status !== "0x1") {
      throw withRunId(new FlightcheckError("FC_RECEIPT_REVERTED", { status: receipt.status }), record.runId);
    }
    if (receipt.transactionHash.toLowerCase() !== record.transactionHash.toLowerCase()) {
      throw withRunId(
        new FlightcheckError("FC_HASH_DISAGREEMENT", {
          keeperhub: record.transactionHash,
          independent: receipt.transactionHash,
        }),
        record.runId,
      );
    }
    advance("RECEIPT_CONFIRMED", `block ${parseInt(receipt.blockNumber, 16)}`);

    // 10. EVENT_VERIFIED. The whole point of the run.
    await mark("verifyEvent", async () => {
      event = decodeFlightcheckEvent(receipt!, deployment.address, deployment.eventTopic0);
      if (!event) {
        const foreign = findForeignFlightcheckLog(receipt!, deployment.eventTopic0);
        if (foreign) {
          throw new FlightcheckError("FC_EVENT_WRONG_EMITTER", {
            expected: deployment.address.toLowerCase(),
            actual: foreign.address.toLowerCase(),
          });
        }
        throw new FlightcheckError("FC_EVENT_MISSING");
      }
      if (event.challenge.toLowerCase() !== record.challenge.toLowerCase()) {
        throw new FlightcheckError("FC_EVENT_CHALLENGE_MISMATCH");
      }
      if (event.chainId !== deployment.chainId) {
        throw new FlightcheckError("FC_EVENT_CHAINID_MISMATCH", {
          expected: deployment.chainId,
          actual: event.chainId,
        });
      }
      /*
       * The sender assertion runs whenever the org wallet is known, and fails closed.
       *
       * An earlier version gated this on `status.sponsored === true`. That was wrong, and an
       * external audit demonstrated why: `sponsored` is supplied by KeeperHub, so omitting one
       * optional boolean from a JSON response skipped the only check binding the onchain event
       * to the organisation's identity. A run reached PROOF_WRITTEN with an event sender of
       * 0xdeadbeef and a capsule reading allLegsAgree: true.
       *
       * A check that the party being verified can switch off is not a check. Under sponsorship
       * the paying EOA and the top-level callee are both KeeperHub infrastructure while
       * msg.sender at the canary is still the org wallet, which is measured. If a legitimate
       * execution path ever produces a different sender, this fails loudly and we investigate,
       * which is the correct direction to be wrong in.
       */
      if (orgWallet && event.sender.toLowerCase() !== orgWallet.toLowerCase()) {
        throw new FlightcheckError("FC_EVENT_SENDER_MISMATCH", {
          expected: orgWallet,
          actual: event.sender,
          sponsored: String(status?.sponsored ?? "not reported"),
        });
      }
    });
    advance("EVENT_VERIFIED", event ? (event as DecodedFlightcheckEvent).challenge : undefined);

    advance("PROOF_WRITTEN");
    return finish("verified");
  } catch (err) {
    if (err instanceof FlightcheckError) {
      return finish("stopped", err);
    }
    throw err;
  }
}

/** Poll honouring X-Poll-Interval-Hint. A hint of 0 means terminal. */
async function pollUntilTerminal(
  kh: KeeperHubClient,
  executionId: string,
  opts: { maxPolls: number; onPoll?: (n: number) => void },
): Promise<ExecutionStatus> {
  let last: ExecutionStatus | null = null;
  for (let i = 0; i < opts.maxPolls; i++) {
    opts.onPoll?.(i);
    last = await kh.getStatus(executionId);
    const reconciled = reconcileState(last.state, last.receipts);
    if (last.pollIntervalHint === 0 || isTerminal(reconciled)) return last;
    const waitSeconds = Number.isFinite(last.pollIntervalHint) ? last.pollIntervalHint! : 2;
    await sleep(Math.max(1, waitSeconds) * 1000);
  }
  return last!;
}

function withRunId(err: FlightcheckError, runId: string): FlightcheckError {
  const next = new FlightcheckError(err.code, { ...err.context, runId });
  return next;
}

function describeError(err: unknown): string {
  if (!err) return "No detail was returned.";
  if (typeof err === "string") return err;
  return JSON.stringify(err);
}
