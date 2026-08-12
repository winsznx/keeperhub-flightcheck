/**
 * The proof capsule.
 *
 * A machine-readable record of what happened, written so a third party can re-verify the claim
 * without trusting this tool or KeeperHub. Everything in it is either measured during the run
 * or pinned in the build; nothing is pre-seeded.
 *
 * The exclusion rules are enforced rather than intended. The capsule is built from an explicit
 * field list, run through the redactor before serialisation, and the test suite scans the
 * result for secret-shaped values.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROOF_SCHEMA, TOOL_VERSION } from "./config.ts";
import { safeRpcOrigin, scrubValue } from "./redact.ts";
import { normalizeReceiptStatus } from "./execstate.ts";
import type { RunResult } from "./machine.ts";

export interface ProofCapsule {
  readonly schema: string;
  readonly toolVersion: string;
  readonly runId: string;
  readonly outcome: string;
  readonly stageReached: string;
  readonly stoppedAt: string | null;
  readonly failureCode: string | null;
  readonly createdAt: string;
  readonly completedAt: string;
  readonly chain: Record<string, unknown>;
  readonly wallet: Record<string, unknown>;
  readonly canary: Record<string, unknown>;
  readonly challenge: string;
  readonly idempotency: Record<string, unknown>;
  readonly simulation: Record<string, unknown> | null;
  readonly execution: Record<string, unknown> | null;
  readonly transaction: Record<string, unknown> | null;
  readonly keeperhubReceipt: Record<string, unknown> | null;
  readonly independentVerification: Record<string, unknown> | null;
  readonly agreement: Record<string, unknown>;
  readonly timingsMs: Record<string, number>;
}

export function buildCapsule(result: RunResult, rpcUrl: string): ProofCapsule {
  const { record, deployment, event, receipt, status, simulation } = result;

  const keeperhubHash = record.transactionHash?.toLowerCase() ?? null;
  const independentHash = receipt?.transactionHash?.toLowerCase() ?? null;

  const challengeMatches =
    event !== null && event.challenge.toLowerCase() === record.challenge.toLowerCase();
  const chainIdMatches = event !== null && event.chainId === deployment.chainId;
  const emittedByPinnedCanary =
    event !== null && event.emitter.toLowerCase() === deployment.address.toLowerCase();

  const capsule: ProofCapsule = {
    schema: PROOF_SCHEMA,
    toolVersion: TOOL_VERSION,
    runId: record.runId,
    outcome: result.outcome,
    stageReached: result.stageReached,
    stoppedAt: result.error ? result.error.stage : null,
    failureCode: result.error ? result.error.code : null,
    createdAt: record.createdAt,
    completedAt: new Date().toISOString(),

    chain: {
      chainId: deployment.chainId,
      name: deployment.chainName,
      isTestnet: true,
    },

    wallet: {
      orgWallet: result.orgWallet,
      signerMode: "eoa",
      note: "The organisation wallet KeeperHub executes from, resolved from GET /api/user. It is not the address a user signs in with.",
    },

    canary: {
      address: deployment.address,
      abiVersion: deployment.abiVersion,
      expectedRuntimeBytecodeHash: deployment.expectedRuntimeBytecodeHash,
      observedRuntimeBytecodeHash: result.observedBytecodeHash,
      match:
        result.observedBytecodeHash !== null &&
        result.observedBytecodeHash.toLowerCase() ===
          deployment.expectedRuntimeBytecodeHash.toLowerCase(),
      eventSignature: deployment.eventSignature,
      eventTopic0: deployment.eventTopic0,
    },

    challenge: record.challenge,

    idempotency: {
      key: record.idempotencyKey || null,
      requestBodyHash: record.canonicalRequestBodyHash || null,
      replayed: record.replayed,
      attempts: record.attempts,
      conflicts: record.conflicts,
      persistedBeforeSend: Boolean(record.idempotencyKey),
    },

    simulation: simulation
      ? {
          passed: simulation.success === true,
          wouldRevert: simulation.wouldRevert ?? false,
          from: simulation.from ?? null,
          to: simulation.to ?? null,
          gasEstimate: simulation.gasEstimate ?? null,
        }
      : null,

    execution: status
      ? {
          id: status.executionId,
          serverStatus: status.serverStatus,
          normalizedState: result.normalizedState,
          sponsored: status.sponsored ?? null,
          type: status.type ?? null,
          pollCount: result.pollCount,
          terminal: result.normalizedState === "COMPLETED" || result.normalizedState === "FAILED",
          transactionHashInPostBody: false,
        }
      : null,

    transaction: record.transactionHash
      ? {
          hash: record.transactionHash,
          link: deployment.explorerTxBase + record.transactionHash,
        }
      : null,

    keeperhubReceipt: status?.receipts?.[0]
      ? {
          verified: status.receipts[0].verified === true,
          receiptStatus: normalizeReceiptStatus(status.receipts[0].receiptStatus),
          blockNumber: status.receipts[0].blockNumber ?? null,
          gasUsed: status.receipts[0].gasUsed ?? null,
        }
      : null,

    independentVerification: receipt
      ? {
          rpcOrigin: safeRpcOrigin(rpcUrl),
          rpcChainId: deployment.chainId,
          receiptStatusHex: receipt.status,
          blockNumber: parseInt(receipt.blockNumber, 16),
          transactionFrom: receipt.from?.toLowerCase() ?? null,
          transactionTo: receipt.to?.toLowerCase() ?? null,
          event: event
            ? {
                emitter: event.emitter,
                topic0: event.topic0,
                sender: event.sender,
                challenge: event.challenge,
                chainId: event.chainId,
              }
            : null,
          challengeMatches,
          chainIdMatches,
          emittedByPinnedCanary,
          senderAssertion:
            result.senderMatchesOrgWallet === null
              ? "org-wallet-unknown-not-asserted"
              : result.senderMatchesOrgWallet
                ? "asserted-and-matched"
                : "asserted-and-failed",
          sponsoredReportedByKeeperHub: status?.sponsored ?? null,
          senderMatchesOrgWallet: result.senderMatchesOrgWallet,
          note: "Verified by transaction hash, then receipt, then decoded log, never from wallet state. Under sponsorship the org wallet's native balance does not change, and its nonce is not a reliable detector either: a wallet whose EIP-7702 delegation is not yet installed consumes one nonce on its first sponsored execution, while later executions from an already-delegated wallet consume none.",
        }
      : null,

    agreement: {
      keeperhubReportsCompleted: result.normalizedState === "COMPLETED",
      publicTransactionLanded: receipt?.status === "0x1",
      // The sender is part of what makes the event ours rather than merely well-formed, so it
      // belongs in the agreement rather than beside it.
      independentEventMatches:
        challengeMatches &&
        chainIdMatches &&
        emittedByPinnedCanary &&
        result.senderMatchesOrgWallet === true,
      sameTransactionHash:
        keeperhubHash !== null && independentHash !== null && keeperhubHash === independentHash,
      allLegsAgree: result.outcome === "verified",
    },

    timingsMs: { ...result.timings, total: sum(result.timings) },
  };

  return scrubValue(capsule);
}

export function writeCapsule(capsule: ProofCapsule, dirs: readonly string[]): string[] {
  const written: string[] = [];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    const path = resolve(dir, `${capsule.runId}.json`);
    writeFileSync(path, JSON.stringify(capsule, null, 2) + "\n");
    written.push(path);
  }
  return written;
}

function sum(values: Record<string, number>): number {
  return Object.values(values).reduce((a, b) => a + b, 0);
}
