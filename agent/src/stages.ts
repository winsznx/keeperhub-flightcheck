/**
 * The stages of a Flightcheck run, in order.
 *
 * Two of these are answered by a public node rather than by KeeperHub: CANARY_VERIFIED asks
 * whether the contract at the pinned address is the one we audited, and EVENT_VERIFIED asks
 * whether the log actually landed. Those are the legs that make the result independent.
 *
 * EXECUTION_CREATED and BROADCAST_OBSERVED stay separate even though one HTTP response often
 * satisfies both, because the failure that matters, a response lost after the server accepted
 * the request, lands exactly between them, and a resume has to know which side it is on.
 */

export const STAGES = [
  "START",
  "AUTHENTICATED",
  "WALLET_RESOLVED",
  "CHAIN_RESOLVED",
  "CANARY_VERIFIED",
  "SIMULATION_PASSED",
  "EXECUTION_PREPARED",
  "EXECUTION_CREATED",
  "BROADCAST_OBSERVED",
  "RECEIPT_CONFIRMED",
  "EVENT_VERIFIED",
  "PROOF_WRITTEN",
] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  START: "Run started",
  AUTHENTICATED: "Authenticated",
  WALLET_RESOLVED: "Organisation wallet resolved",
  CHAIN_RESOLVED: "Chain available",
  CANARY_VERIFIED: "Canary bytecode verified",
  SIMULATION_PASSED: "Simulation passed",
  EXECUTION_PREPARED: "Request persisted",
  EXECUTION_CREATED: "Execution created",
  BROADCAST_OBSERVED: "Transaction observed",
  RECEIPT_CONFIRMED: "Receipt confirmed",
  EVENT_VERIFIED: "Flightcheck event verified",
  PROOF_WRITTEN: "Proof written",
};

/** Stages proven without asking KeeperHub anything. */
export const INDEPENDENT_STAGES: ReadonlySet<Stage> = new Set<Stage>([
  "CANARY_VERIFIED",
  "EVENT_VERIFIED",
]);

export function stageIndex(stage: Stage): number {
  return STAGES.indexOf(stage);
}

export function isAtLeast(reached: Stage, required: Stage): boolean {
  return stageIndex(reached) >= stageIndex(required);
}
