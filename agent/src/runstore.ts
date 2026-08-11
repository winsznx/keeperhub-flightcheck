/**
 * Durable run state, and the idempotency identity derived from it.
 *
 * This module exists because of one measured property of the API: a write is answered in the
 * same HTTP response that performs it, and there is no list-executions endpoint. If that
 * response is lost, an execution id was never observed and cannot be looked up. The only thing
 * that can still find the original outcome is the idempotency key, replayed with a
 * value-identical body inside KeeperHub's 24-hour window.
 *
 * So the record below is written and fsynced BEFORE the request goes out. Persisting after the
 * response would protect exactly nothing, because the case worth protecting against is not
 * receiving one.
 *
 * The key is derived rather than random for the same reason. A random key held only in memory
 * dies with the process. Deriving it from the run's own identity means it can be recomputed on
 * a machine that lost its state directory.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, openSync, fsyncSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { sha256Hex } from "./rpc.ts";
import { FlightcheckError } from "./errors.ts";
import { IDEMPOTENCY_REPLAY_WINDOW_MS } from "./config.ts";
import type { Stage } from "./stages.ts";

export interface RunRecord {
  readonly runId: string;
  readonly challenge: string;
  readonly chainId: number;
  readonly canaryAddress: string;
  readonly expectedRuntimeBytecodeHash: string;
  readonly intendedOperation: string;
  readonly canonicalRequestBody: string;
  readonly canonicalRequestBodyHash: string;
  readonly idempotencyKey: string;
  readonly orgWallet: string | null;
  readonly organizationKeyPrefix: string | null;
  readonly createdAt: string;
  executionId: string | null;
  transactionHash: string | null;
  stageReached: Stage;
  attempts: number;
  replayed: boolean;
  conflicts: number;
}

/**
 * The canonical work string.
 *
 * KeeperHub publishes a derivation recipe for /transfer only, over
 * `taskId|chainId|recipientAddress|amount|tokenAddress`. Those fields describe a transfer and
 * none of them determine the effect of a contract call, so this is our field list for
 * /contract-call: the fields that actually decide what happens onchain. The gap is recorded as
 * an upstream doc candidate.
 *
 * Separator is a single U+007C with no surrounding whitespace, addresses are lowercased, the
 * chain id is decimal with no leading zeros, and the digest is SHA-256 as lowercase hex, all
 * matching KeeperHub's stated rules for the transfer case.
 */
export function deriveIdempotencyKey(parts: {
  runId: string;
  chainId: number;
  contractAddress: string;
  functionName: string;
  functionArgs: string;
  value: string;
}): string {
  const work = [
    encodePart(parts.runId),
    String(parts.chainId),
    parts.contractAddress.toLowerCase(),
    encodePart(parts.functionName),
    encodePart(parts.functionArgs),
    parts.value,
  ].join("|");
  return sha256Hex(work);
}

/** Percent-encode the separator so two different intents cannot join to the same string. */
function encodePart(v: string): string {
  return v.trim().replace(/%/g, "%25").replace(/\|/g, "%7C");
}

export function newChallenge(): string {
  return "0x" + randomBytes(32).toString("hex");
}

export function newRunId(): string {
  return "fc_" + randomUUID();
}

export class RunStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(this.dir, { recursive: true });
  }

  private pathFor(runId: string): string {
    if (!/^fc_[0-9a-f-]{36}$/.test(runId)) {
      throw new FlightcheckError("FC_RESUME_NOT_FOUND", { runId });
    }
    return resolve(this.dir, `${runId}.json`);
  }

  /**
   * Write and fsync. The fsync is the point: an ordinary write can sit in the page cache, and
   * a machine that dies between the write and the POST would come back with no record of a
   * request that may already have executed.
   */
  save(record: RunRecord): void {
    const path = this.pathFor(record.runId);
    writeFileSync(path, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  load(runId: string): RunRecord {
    const path = this.pathFor(runId);
    if (!existsSync(path)) throw new FlightcheckError("FC_RESUME_NOT_FOUND", { runId });
    return JSON.parse(readFileSync(path, "utf8")) as RunRecord;
  }

  exists(runId: string): boolean {
    try {
      return existsSync(this.pathFor(runId));
    } catch {
      return false;
    }
  }

  list(): RunRecord[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(resolve(this.dir, f), "utf8")) as RunRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is RunRecord => r !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Refuse to resume a run whose replay window has closed.
   *
   * Past 24 hours KeeperHub has discarded the stored response, and the same key executes again
   * silently. Replaying then would produce a second transaction, which is the exact outcome
   * this whole mechanism exists to prevent. Failing closed is the only safe answer.
   */
  assertResumable(record: RunRecord, now: number = Date.now()): void {
    const age = now - Date.parse(record.createdAt);
    if (Number.isFinite(age) && age > IDEMPOTENCY_REPLAY_WINDOW_MS) {
      throw new FlightcheckError("FC_RESUME_WINDOW_EXPIRED", { runId: record.runId });
    }
  }
}

/**
 * Build the canonical request body.
 *
 * Key order is fixed because the bytes are hashed and persisted, and a resume has to reproduce
 * them exactly. KeeperHub hashes the body after parsing, so formatting alone would not cause a
 * conflict, but a caller that cannot reproduce its own request cannot reason about what it sent.
 */
export function buildCanonicalBody(parts: {
  contractAddress: string;
  chainId: number;
  functionName: string;
  functionArgs: string;
  abi: string;
}): string {
  return JSON.stringify({
    contractAddress: parts.contractAddress,
    chainId: parts.chainId,
    functionName: parts.functionName,
    functionArgs: parts.functionArgs,
    abi: parts.abi,
  });
}

export function hashBody(body: string): string {
  return "sha256:" + sha256Hex(body);
}
