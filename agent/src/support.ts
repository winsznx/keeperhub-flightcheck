/**
 * The support capsule.
 *
 * A failed first run usually reaches a maintainer as "it didn't work" plus a screenshot, because
 * the person reporting it has no way to tell which parts of their terminal are safe to paste.
 * This turns the same run into a file they can attach without reading it first.
 *
 * It is built from KeeperHub's own correlation ids rather than a second observability protocol.
 * Every request Flightcheck sends carries an `x-request-id` derived from the run id, the stage
 * and an attempt counter, and whatever KeeperHub echoes back is persisted with the run. So the
 * capsule can say "simulation, attempt 1, HTTP 400, request id X" and a maintainer can look up
 * exactly that request.
 *
 * Two properties make it safe to hand over. It is assembled from an explicit field list, so a
 * value has to be named here to appear at all, and the finished object goes through the same
 * scrubber the proof capsule uses. The writer then refuses to emit a file that still trips the
 * leak detector, so the failure mode is an error rather than a disclosure.
 *
 * Nothing here touches the network. It reads a persisted run, optionally the proof capsule
 * beside it, and writes one file. That is deliberate: the run being diagnosed may be days old,
 * the credential may be gone, and the machine may be offline.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { TOOL_VERSION, PROOF_SCHEMA, BASE_SEPOLIA, deploymentFor } from "./config.ts";
import { scrubValue, findLeaks } from "./redact.ts";
import { FAILURES, type FailureCode } from "./errors.ts";
import type { RunRecord } from "./runstore.ts";

export const SUPPORT_SCHEMA = "keeperhub-flightcheck/support/v1";

export interface SupportCapsule {
  readonly schema: string;
  readonly generatedAt: string;
  readonly flightcheckVersion: string;
  readonly gitCommit: string | null;
  readonly proofSchema: string;
  readonly run: Record<string, unknown>;
  readonly failure: Record<string, unknown> | null;
  readonly chain: Record<string, unknown>;
  readonly wallet: Record<string, unknown>;
  readonly keeperhub: Record<string, unknown>;
  readonly onchain: Record<string, unknown>;
  readonly faucet: Record<string, unknown>;
  readonly requests: ReadonlyArray<Record<string, unknown>>;
  readonly timingsMs: Record<string, number> | null;
  readonly secretsIncluded: string;
  readonly excluded: readonly string[];
  readonly howToUse: string;
}

/**
 * What is deliberately absent, stated in the artifact itself.
 *
 * A reader deciding whether to attach this to a ticket should not have to take the tool's word
 * for it, and a maintainer receiving it should know what they are not being given.
 */
const EXCLUDED = [
  "KEEPERHUB_API_KEY",
  "Authorization header",
  "cookies",
  "private keys",
  "Cloudflare secrets",
  "RPC credentials",
  "raw environment",
  "raw process argv",
  "complete request headers",
  "faucet rate-limit identity",
  "IP address",
  "wallet signing secrets",
] as const;

export interface BuildOptions {
  /** Where run state lives. Used to find the proof capsule beside the record. */
  readonly stateDir: string;
  readonly repoRoot?: string;
  /** Pass explicitly to make the result reproducible; otherwise read from disk. */
  readonly capsule?: Record<string, unknown> | null;
  readonly gitCommit?: string | null;
  readonly now?: Date;
}

export function buildSupportCapsule(record: RunRecord, opts: BuildOptions): SupportCapsule {
  const capsule =
    opts.capsule !== undefined ? opts.capsule : readProofCapsule(opts, record.runId);

  const failureCode = (capsule?.failureCode as FailureCode | null) ?? null;
  const spec = failureCode && FAILURES[failureCode] ? FAILURES[failureCode] : null;

  const exec = section(capsule, "execution");
  const canary = section(capsule, "canary");
  const khReceipt = section(capsule, "keeperhubReceipt");
  const independent = section(capsule, "independentVerification");
  const deployment = deploymentFor(record.chainId) ?? BASE_SEPOLIA;

  const out: SupportCapsule = {
    schema: SUPPORT_SCHEMA,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    flightcheckVersion: TOOL_VERSION,
    gitCommit: opts.gitCommit !== undefined ? opts.gitCommit : readGitCommit(opts.repoRoot),
    proofSchema: PROOF_SCHEMA,

    run: {
      runId: record.runId,
      createdAt: record.createdAt,
      stageReached: record.stageReached,
      outcome: (capsule?.outcome as string) ?? null,
      attempts: record.attempts,
      idempotentReplay: record.replayed,
      idempotencyConflicts: record.conflicts,
      // The key is itself a digest over public request parts, but it is also the one value that
      // can replay a stored response, so only a digest of it travels.
      idempotencyKeyHash: record.idempotencyKey ? publicDigest(record.idempotencyKey) : null,
      idempotencyKeyHashAlgorithm: "sha256",
      canonicalRequestBodyHash: normaliseDigest(record.canonicalRequestBodyHash),
      // Per-run random with no relationship to any credential, and already public: it is an
      // argument of the call and appears in the emitted event.
      challenge: record.challenge,
      intendedOperation: record.intendedOperation,
    },

    failure: spec
      ? {
          code: failureCode,
          title: spec.title,
          stage: spec.stage,
          broadcastPossible: spec.broadcastPossible,
          remediation: spec.remediation({ runId: record.runId }),
        }
      : null,

    chain: {
      chainId: record.chainId,
      name: deployment.chainName,
      canaryAddress: record.canaryAddress,
      expectedRuntimeBytecodeHash: record.expectedRuntimeBytecodeHash,
      observedRuntimeBytecodeHash: (canary?.observedRuntimeBytecodeHash as string) ?? null,
      bytecodeMatch: (canary?.match as boolean) ?? null,
    },

    wallet: {
      organisationWallet: record.orgWallet,
      note: "The wallet KeeperHub executes from, resolved from GET /api/user. Public address only.",
    },

    keeperhub: {
      executionId: record.executionId,
      serverStatus: (exec?.serverStatus as string) ?? null,
      normalizedState: (exec?.normalizedState as string) ?? null,
      sponsored: (exec?.sponsored as boolean | null) ?? null,
      type: (exec?.type as string | null) ?? null,
      pollCount: (exec?.pollCount as number | null) ?? null,
      transactionHashInPostBody: (exec?.transactionHashInPostBody as boolean | null) ?? null,
    },

    onchain: {
      transactionHash: record.transactionHash,
      explorerUrl: record.transactionHash
        ? deployment.explorerTxBase + record.transactionHash
        : null,
      receiptStatus: (khReceipt?.receiptStatus as string) ?? null,
      receiptVerifiedByKeeperHub: (khReceipt?.verified as boolean) ?? null,
      blockNumber:
        (khReceipt?.blockNumber as number | null) ??
        (independent?.blockNumber as number | null) ??
        null,
      expectedEventFound: independent ? independent.emittedByPinnedCanary === true : null,
      challengeMatches: independent ? independent.challengeMatches === true : null,
      senderMatchesOrgWallet: independent
        ? ((independent.senderMatchesOrgWallet as boolean | null) ?? null)
        : null,
    },

    faucet: record.faucet
      ? {
          used: true,
          status: record.faucet.status,
          recipient: record.faucet.recipient,
          transactionHash: record.faucet.transactionHash,
          idempotentReplay: record.faucet.idempotentReplay,
          requestId: record.faucet.requestId,
          at: record.faucet.at,
        }
      : {
          used: false,
          note: "The gas fallback is only reachable after KeeperHub reports, before any broadcast, that the sender cannot pay. A sponsored run never gets there.",
        },

    requests: (record.httpTrace ?? []).map((tr) => ({
      stage: tr.stage,
      method: tr.method,
      path: tr.path,
      httpStatus: tr.status,
      elapsedMs: tr.elapsedMs,
      sentRequestId: tr.sentRequestId,
      serverRequestId: tr.serverRequestId,
      serverRequestIdSource: tr.serverRequestIdSource ?? null,
    })),

    timingsMs: (capsule?.timingsMs as Record<string, number> | undefined) ?? null,

    secretsIncluded: "none",
    excluded: [...EXCLUDED],
    howToUse:
      "Safe to attach to a KeeperHub support ticket. Quote the ids under `requests` when you " +
      "do. `sentRequestId` is the X-Request-Id Flightcheck sent; `serverRequestId` is a " +
      "server-side id for the same request, and `serverRequestIdSource` says where it came " +
      "from, since a successful KeeperHub response currently carries no request id of its own " +
      "and cf-ray is what remains. Nothing was uploaded anywhere. The file is yours.",
  };

  // Second boundary. The field list above should already make a leak impossible, which is
  // exactly why this needs to run: a scrubber nobody exercises is a scrubber nobody has tested.
  return scrubValue(out);
}

export function writeSupportCapsule(
  capsule: SupportCapsule,
  dir: string,
): { path: string; bytes: number } {
  const serialised = JSON.stringify(capsule, null, 2) + "\n";

  // Refuse to write rather than write something unsafe. This runs before the file exists, so a
  // capsule that trips the detector never reaches disk at all.
  const leaks = findLeaks(serialised);
  if (leaks.length > 0) {
    throw new Error(
      `refusing to write a support capsule: ${leaks.length} secret-shaped value(s) survived ` +
        `redaction (${leaks.map((l) => l.label).join(", ")})`,
    );
  }

  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `flightcheck-support-${String(capsule.run.runId)}.json`);
  writeFileSync(path, serialised);
  return { path, bytes: Buffer.byteLength(serialised) };
}

/** Request ids grouped by stage, in the order the requests were made. For terminal output. */
export function requestIdsByStage(
  capsule: SupportCapsule,
): Array<{ stage: string; ids: string[] }> {
  const groups = new Map<string, string[]>();
  for (const r of capsule.requests) {
    const stage = String(r.stage ?? "unknown");
    const id = r.sentRequestId;
    if (typeof id !== "string") continue;
    const list = groups.get(stage) ?? [];
    list.push(id);
    groups.set(stage, list);
  }
  return [...groups.entries()].map(([stage, ids]) => ({ stage, ids }));
}

function section(
  capsule: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  const value = capsule?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The proof capsule for this run, if one was written.
 *
 * Optional by design. A run that stopped before broadcasting has a record and no capsule, and
 * that run still deserves a support artifact.
 */
function readProofCapsule(opts: BuildOptions, runId: string): Record<string, unknown> | null {
  const candidates = [resolve(opts.stateDir, "proofs", `${runId}.json`)];
  if (opts.repoRoot) candidates.push(resolve(opts.repoRoot, "evidence", "runs", `${runId}.json`));

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (parsed?.schema === PROOF_SCHEMA) return parsed;
    } catch {
      // A malformed capsule is not a reason to deny someone a support artifact.
    }
  }
  return null;
}

/**
 * The commit this build came from, read straight out of .git.
 *
 * Deliberately not `git rev-parse`: this command runs no subprocesses, so there is no argv, no
 * environment inheritance and nothing to go wrong on a machine where git is missing.
 */
export function readGitCommit(repoRoot?: string): string | null {
  if (!repoRoot) return null;
  try {
    const head = readFileSync(resolve(repoRoot, ".git", "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = head.startsWith("ref:") ? head.slice(4).trim() : null;
    if (!ref) return null;
    const direct = resolve(repoRoot, ".git", ref);
    if (existsSync(direct)) {
      const sha = readFileSync(direct, "utf8").trim();
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    }
    const packed = resolve(repoRoot, ".git", "packed-refs");
    if (!existsSync(packed)) return null;
    for (const line of readFileSync(packed, "utf8").split("\n")) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && sha && /^[0-9a-f]{40}$/.test(sha)) return sha;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Digests are emitted 0x-prefixed on purpose.
 *
 * The redactor treats a bare 64-hex run as secret-shaped, because that is what a leaked private
 * key looks like, and exempts the 0x form because transaction hashes, challenges and bytecode
 * digests are all published deliberately. A digest written `sha256:<hex>` is eaten by that rule
 * and reaches the reader as `<redacted:RAW_64_HEX>`, which is a correlation value destroyed for
 * no benefit. These digests are derived entirely from public request parts, so the 0x form is
 * both accurate and the one that survives.
 */
function publicDigest(value: string): string {
  return "0x" + createHash("sha256").update(value, "utf8").digest("hex");
}

/** Accept the stored `sha256:<hex>` form and re-emit it in the form the redactor allows. */
function normaliseDigest(stored: string | undefined): string | null {
  if (!stored) return null;
  const hex = stored.replace(/^sha256:/, "").replace(/^0x/, "");
  return /^[0-9a-f]{64}$/i.test(hex) ? "0x" + hex.toLowerCase() : null;
}
