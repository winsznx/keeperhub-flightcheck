/**
 * D1-backed claim reservation and rate accounting.
 *
 * D1 was chosen over KV because this needs a genuine atomic reservation. KV is eventually
 * consistent, so a read-then-write "has this recipient claimed?" check loses under concurrency
 * and a faucet that loses that race sends twice. Here both the request-id replay guard and the
 * per-recipient cooldown are primary-key inserts, and the database decides the winner.
 */

import { RECIPIENT_COOLDOWN_MS, IP_WINDOW_MS } from "./config.ts";

export interface ClaimRow {
  request_id: string;
  recipient: string;
  amount_wei: string;
  status: "reserved" | "funded" | "failed";
  tx_hash: string | null;
  error_code: string | null;
  created_at: number;
  completed_at: number | null;
}

export type ReserveResult =
  | { kind: "reserved" }
  | { kind: "replay"; claim: ClaimRow }
  | { kind: "cooldown"; until: number };

export class Store {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async getClaim(requestId: string): Promise<ClaimRow | null> {
    return this.db
      .prepare("SELECT * FROM claims WHERE request_id = ?")
      .bind(requestId)
      .first<ClaimRow>();
  }

  /**
   * Take the claim atomically, or report why not.
   *
   * Order matters. The request-id row goes first so a replay is recognised even when the
   * recipient is inside its cooldown, which is the case a naive implementation gets wrong: it
   * reports `cooldown` for a retry of the very request that caused the cooldown.
   */
  async reserve(
    requestId: string,
    recipient: string,
    amountWei: bigint,
    now: number,
  ): Promise<ReserveResult> {
    const inserted = await this.db
      .prepare(
        `INSERT INTO claims (request_id, recipient, amount_wei, status, created_at)
         VALUES (?, ?, ?, 'reserved', ?)
         ON CONFLICT(request_id) DO NOTHING`,
      )
      .bind(requestId, recipient, amountWei.toString(), now)
      .run();

    if (inserted.meta.changes === 0) {
      const existing = await this.getClaim(requestId);
      if (existing) return { kind: "replay", claim: existing };
      // Vanishingly unlikely, but treat an unreadable conflict as a refusal rather than a send.
      return { kind: "cooldown", until: now + RECIPIENT_COOLDOWN_MS };
    }

    const bucket = Math.floor(now / RECIPIENT_COOLDOWN_MS);
    const lock = await this.db
      .prepare(
        `INSERT INTO recipient_window (recipient, window_bucket, request_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(recipient, window_bucket) DO NOTHING`,
      )
      .bind(recipient, bucket, requestId, now)
      .run();

    if (lock.meta.changes === 0) {
      // Another request already holds this recipient's window. Release our claim row so the
      // request id stays usable once the cooldown expires.
      await this.db.prepare("DELETE FROM claims WHERE request_id = ? AND status = 'reserved'")
        .bind(requestId)
        .run();
      return { kind: "cooldown", until: (bucket + 1) * RECIPIENT_COOLDOWN_MS };
    }

    return { kind: "reserved" };
  }

  async markFunded(requestId: string, txHash: string, now: number): Promise<void> {
    await this.db
      .prepare(
        "UPDATE claims SET status = 'funded', tx_hash = ?, completed_at = ? WHERE request_id = ?",
      )
      .bind(txHash, now, requestId)
      .run();
  }

  /**
   * A failed send stays failed under this request id.
   *
   * Deleting the row instead would let a caller retry the same id after a send that may in fact
   * have reached the network, which is the ambiguity this whole service is supposed to avoid.
   * The recipient window is released so a *new* request id can try later.
   */
  async markFailed(requestId: string, code: string, now: number): Promise<void> {
    await this.db
      .prepare(
        "UPDATE claims SET status = 'failed', error_code = ?, completed_at = ? WHERE request_id = ?",
      )
      .bind(code, now, requestId)
      .run();
    await this.db.prepare("DELETE FROM recipient_window WHERE request_id = ?")
      .bind(requestId)
      .run();
  }

  /** Increment a window counter and report whether it is now over the limit. */
  async bumpAndCheck(
    bucket: string,
    now: number,
    windowMs: number,
    maxCount: number,
    weiToAdd: bigint,
    maxWei: bigint | null,
  ): Promise<{ allowed: boolean; count: number }> {
    const windowStart = Math.floor(now / windowMs) * windowMs;
    await this.db
      .prepare(
        `INSERT INTO rate_buckets (bucket, count, wei_total, window_start)
         VALUES (?, 0, '0', ?)
         ON CONFLICT(bucket) DO UPDATE SET
           count = CASE WHEN rate_buckets.window_start < ? THEN 0 ELSE rate_buckets.count END,
           wei_total = CASE WHEN rate_buckets.window_start < ? THEN '0' ELSE rate_buckets.wei_total END,
           window_start = CASE WHEN rate_buckets.window_start < ? THEN ? ELSE rate_buckets.window_start END`,
      )
      .bind(bucket, windowStart, windowStart, windowStart, windowStart, windowStart)
      .run();

    const row = await this.db
      .prepare("SELECT count, wei_total FROM rate_buckets WHERE bucket = ?")
      .bind(bucket)
      .first<{ count: number; wei_total: string }>();

    const count = (row?.count ?? 0) + 1;
    const weiTotal = BigInt(row?.wei_total ?? "0") + weiToAdd;

    if (count > maxCount || (maxWei !== null && weiTotal > maxWei)) {
      return { allowed: false, count };
    }

    await this.db
      .prepare("UPDATE rate_buckets SET count = ?, wei_total = ? WHERE bucket = ?")
      .bind(count, weiTotal.toString(), bucket)
      .run();
    return { allowed: true, count };
  }

  async stats(now: number): Promise<{ claimsToday: number; weiToday: string }> {
    const dayStart = now - 24 * 60 * 60 * 1000;
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(CAST(amount_wei AS INTEGER)), 0) AS w FROM claims WHERE status = 'funded' AND created_at >= ?",
      )
      .bind(dayStart)
      .first<{ n: number; w: number }>();
    return { claimsToday: row?.n ?? 0, weiToday: String(row?.w ?? 0) };
  }
}

/** Window key for an IP-derived bucket. The caller passes an HMAC, never a raw address. */
export function ipBucketKey(ipHmac: string, now: number): string {
  return `ip:${ipHmac}:${Math.floor(now / IP_WINDOW_MS)}`;
}

export function globalBucketKey(now: number): string {
  return `global:${Math.floor(now / (24 * 60 * 60 * 1000))}`;
}
