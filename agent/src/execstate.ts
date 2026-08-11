/**
 * Normalizing KeeperHub execution status.
 *
 * KeeperHub's Direct Execution reference documents four values: pending, running, completed,
 * failed. The Zero to a Verified Onchain Transaction guide documents a fifth, `unconfirmed`,
 * and describes it as non-terminal. The two pages disagree, so this module treats the
 * documented set as a lower bound and maps anything it does not recognise to UNKNOWN.
 *
 * The consequence of getting this wrong is not cosmetic. A client that funnels an unrecognised
 * status into a `default: fail` branch reports a false failure for a transaction that is still
 * settling, and a client that responds to that by re-sending can put a second transaction
 * onchain. Both UNCONFIRMED and UNKNOWN are therefore non-terminal, and neither ever triggers a
 * fresh logical execution.
 */

export type ExecState =
  | "PENDING"
  | "RUNNING"
  | "UNCONFIRMED"
  | "COMPLETED"
  | "FAILED"
  | "UNKNOWN";

const DOCUMENTED: Record<string, ExecState> = {
  pending: "PENDING",
  running: "RUNNING",
  unconfirmed: "UNCONFIRMED",
  completed: "COMPLETED",
  failed: "FAILED",
};

export function normalizeState(raw: unknown): ExecState {
  if (typeof raw !== "string") return "UNKNOWN";
  return DOCUMENTED[raw.trim().toLowerCase()] ?? "UNKNOWN";
}

/** Only COMPLETED and FAILED end the poll loop. Everything else keeps waiting. */
export function isTerminal(state: ExecState): boolean {
  return state === "COMPLETED" || state === "FAILED";
}

/**
 * States where a transaction may already exist onchain.
 *
 * PENDING is the only state that is safely pre-broadcast, and even then only because
 * KeeperHub has not started work. Everything from RUNNING onward is treated as "assume a
 * transaction might exist", which is what keeps recovery from minting a new idempotency key.
 */
export function mayHaveBroadcast(state: ExecState): boolean {
  return state !== "PENDING";
}

/**
 * Receipt verification outcomes, as returned in `receipts[].receiptStatus`.
 *
 * `not_found` and `timeout` mean verification could not reach a definitive answer inside its
 * budget. KeeperHub fails the execution closed when it sees them, and its own documentation
 * notes that such an execution may describe a transaction that later lands. So an execution
 * marked FAILED whose receipts carry only those two values is downgraded here to UNCONFIRMED.
 * Failing closed is right; reporting a definite failure is not.
 */
export type ReceiptStatus =
  | "success"
  | "reverted"
  | "safe_inner_failure"
  | "not_found"
  | "timeout"
  | "unrecognised";

const RECEIPT_STATUSES: ReadonlySet<string> = new Set([
  "success",
  "reverted",
  "safe_inner_failure",
  "not_found",
  "timeout",
]);

export function normalizeReceiptStatus(raw: unknown): ReceiptStatus {
  if (typeof raw !== "string") return "unrecognised";
  const v = raw.trim().toLowerCase();
  return (RECEIPT_STATUSES.has(v) ? v : "unrecognised") as ReceiptStatus;
}

export function isInconclusive(status: ReceiptStatus): boolean {
  return status === "not_found" || status === "timeout" || status === "unrecognised";
}

export interface ReceiptLike {
  readonly verified?: unknown;
  readonly receiptStatus?: unknown;
  readonly hash?: unknown;
  readonly blockNumber?: unknown;
  readonly gasUsed?: unknown;
}

/**
 * Apply the downgrade rule. Returns the state a caller should act on, which may differ from
 * what the server said.
 */
export function reconcileState(serverState: ExecState, receipts: readonly ReceiptLike[]): ExecState {
  if (serverState !== "FAILED" || receipts.length === 0) return serverState;
  const statuses = receipts.map((r) => normalizeReceiptStatus(r.receiptStatus));
  const allInconclusive = statuses.every(isInconclusive);
  return allInconclusive ? "UNCONFIRMED" : "FAILED";
}
