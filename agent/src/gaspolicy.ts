/**
 * When the gas fallback is allowed to fire.
 *
 * The canonical Flightcheck run put a transaction on chain from an organisation wallet holding
 * exactly zero ETH, because KeeperHub sponsored it. So a zero balance is not evidence that gas is
 * the problem, and pre-funding on a zero balance would be solving a problem that usually is not
 * there.
 *
 * KeeperHub is tried first, always. The faucet becomes eligible only when KeeperHub itself has
 * said, conclusively and before any broadcast, that the sender cannot pay.
 *
 * The dangerous case this module exists to prevent: treating an ambiguous failure as a funding
 * problem. If a response was lost, or an execution is unconfirmed, or an execution id exists
 * whose outcome is unresolved, then a transaction may already be on the wire. Funding a wallet
 * and starting a new logical run in that state is how a duplicate transaction gets created. Every
 * one of those paths is a hard refusal here.
 */

import { BASE_SEPOLIA } from "./config.ts";
import type { FailureCode } from "./errors.ts";
import type { RunResult } from "./machine.ts";

export type FaucetDecision =
  | { eligible: true; recipient: string; reason: string }
  | { eligible: false; reason: string; code: FaucetIneligibleCode };

export type FaucetIneligibleCode =
  | "sponsored_success"
  | "not_a_gas_problem"
  | "wrong_chain"
  | "broadcast_possible"
  | "execution_exists"
  | "no_org_wallet"
  | "already_funded"
  | "canary_unverified";

/**
 * Decide from a completed run whether funding is a safe next step.
 *
 * Deliberately takes the whole `RunResult` rather than a failure code. The code alone cannot
 * answer "did an execution id appear", and that question is the difference between a run that
 * definitely did not broadcast and one that might have.
 */
export function evaluateFaucetEligibility(
  result: RunResult,
  opts: { payoutWei: bigint; recipientBalanceWei: bigint | null },
): FaucetDecision {
  // 1. A verified run needs nothing. This is the common case on a sponsored organisation.
  if (result.outcome === "verified") {
    return {
      eligible: false,
      code: "sponsored_success",
      reason:
        "The execution succeeded. KeeperHub covered the gas, so no funding is needed. " +
        "A zero balance is not a problem when the write is sponsored.",
    };
  }

  // 2. Anything unresolved is off limits, whatever the balance looks like.
  if (result.outcome === "unconfirmed") {
    return {
      eligible: false,
      code: "broadcast_possible",
      reason:
        "The execution is unconfirmed, so a transaction may already exist. Resume the run " +
        "instead. Funding here could turn one logical operation into two transactions.",
    };
  }

  const error = result.error;
  if (!error) {
    return {
      eligible: false,
      code: "not_a_gas_problem",
      reason: "The run did not stop with a diagnosable failure.",
    };
  }

  /*
   * 3. Possibly-broadcast is checked before anything else about the failure.
   *
   * Deliberately ahead of the code check. For a transport loss the safety-critical fact is that
   * a transaction may already exist, and reporting "that is not a gas problem" would be true but
   * would bury the reason that actually matters. Any failure the taxonomy classifies as
   * possibly-broadcast is refused on those grounds and told to reconcile.
   */
  if (error.broadcastPossible) {
    return {
      eligible: false,
      code: "broadcast_possible",
      reason:
        `${error.code} is classified as possibly-broadcast, so a transaction may already exist. ` +
        "Reconcile the existing run before considering funding; funding and restarting here is " +
        "how one logical operation becomes two transactions.",
    };
  }

  // 4. Only one failure code means "the sender cannot pay, and nothing was sent".
  const GAS_BLOCKED: FailureCode = "FC_SIM_INSUFFICIENT_BALANCE";
  if (error.code !== GAS_BLOCKED) {
    return {
      eligible: false,
      code: "not_a_gas_problem",
      reason: `The run stopped at ${error.code}, which is not an insufficient-balance condition. Funding would not fix it.`,
    };
  }

  // 5. An execution id means KeeperHub accepted work. Never fund past that.
  if (result.record.executionId !== null) {
    return {
      eligible: false,
      code: "execution_exists",
      reason:
        `Execution ${result.record.executionId} exists, so its outcome must be reconciled ` +
        "before any new logical run. Resume rather than fund.",
    };
  }
  if (result.record.transactionHash !== null) {
    return {
      eligible: false,
      code: "execution_exists",
      reason: "A transaction hash was already observed for this run. Verify it rather than fund.",
    };
  }

  // 6. Base Sepolia only. The faucet is pinned to one chain and so is this decision.
  if (result.deployment.chainId !== BASE_SEPOLIA.chainId) {
    return {
      eligible: false,
      code: "wrong_chain",
      reason: `The gas fallback covers Base Sepolia (${BASE_SEPOLIA.chainId}) only, not chain ${result.deployment.chainId}.`,
    };
  }

  // 7. The canary must have been verified, or we do not know what we were calling.
  if (
    result.observedBytecodeHash === null ||
    result.observedBytecodeHash.toLowerCase() !==
      result.deployment.expectedRuntimeBytecodeHash.toLowerCase()
  ) {
    return {
      eligible: false,
      code: "canary_unverified",
      reason: "The canary bytecode was not verified on this run, so nothing should be funded.",
    };
  }

  // 8. Recipient is exactly the resolved organisation wallet. Never an address from anywhere else.
  const recipient = result.orgWallet;
  if (!recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    return {
      eligible: false,
      code: "no_org_wallet",
      reason: "No organisation wallet was resolved, so there is no address to fund.",
    };
  }

  // 9. Already has gas. Then insufficient_balance was about something else.
  if (opts.recipientBalanceWei !== null && opts.recipientBalanceWei >= opts.payoutWei) {
    return {
      eligible: false,
      code: "already_funded",
      reason:
        "The organisation wallet already holds at least the faucet payout, so gas is not the " +
        "blocker here.",
    };
  }

  return {
    eligible: true,
    recipient,
    reason:
      "KeeperHub reported a conclusive insufficient-balance condition before any broadcast, no " +
      "execution was created, and the wallet is below the payout threshold.",
  };
}

/**
 * A run that stopped at a conclusively pre-broadcast failure is a completed logical failure.
 *
 * That is the only circumstance in which a fresh idempotency key is correct. The key names the
 * work, and this is genuinely new work: the previous attempt provably did not reach the network,
 * so there is no earlier transaction for a new key to duplicate.
 *
 * For everything else, resume wins and the key is reused. Getting this backwards is precisely
 * how a retry becomes a second transaction.
 */
export function mayStartNewLogicalRun(result: RunResult): boolean {
  return (
    result.outcome === "stopped" &&
    result.error !== null &&
    !result.error.broadcastPossible &&
    result.record.executionId === null &&
    result.record.transactionHash === null
  );
}

/** Deterministic, non-secret request id derived from the run that justified the request. */
export function faucetRequestId(runId: string, recipient: string): string {
  return `flightcheck-faucet-${runId.replace(/^fc_/, "")}-${recipient.slice(2, 10).toLowerCase()}`;
}
