/**
 * Faucet policy. Every limit here is a hard constant, not a caller-supplied parameter.
 *
 * The endpoint takes a recipient and a request id. It does not take a chain, an amount, an RPC
 * URL, or anything else that would let a caller widen what the treasury can do. That is the whole
 * design: the only degree of freedom a caller has is *who* receives a fixed, tiny payout on one
 * testnet.
 */

/** Base Sepolia. Pinned, never read from a request. */
export const CHAIN_ID = 84532;

/**
 * 0.0001 ETH.
 *
 * A verified Flightcheck canary call used 85,465 gas at 0.006 gwei, so this covers roughly four
 * orders of magnitude more than one execution needs at observed Base Sepolia prices. It is sized
 * for onboarding gas and nothing else. The treasury holding more is not a reason to send more.
 */
export const PAYOUT_WEI = 100_000_000_000_000n;

/** A recipient at or above this already has gas and is sent nothing. */
export const SUFFICIENT_BALANCE_WEI = PAYOUT_WEI;

/** One payout per recipient per window. Enforced atomically, not by a read-then-write. */
export const RECIPIENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Per-caller ceiling. The key is an HMAC of the IP, never the IP itself. */
export const IP_MAX_CLAIMS = 5;
export const IP_WINDOW_MS = 60 * 60 * 1000;

/** Global ceilings, so a distributed caller cannot drain the treasury either. */
export const GLOBAL_MAX_CLAIMS_PER_DAY = 200;
export const GLOBAL_MAX_WEI_PER_DAY = 20_000_000_000_000_000n; // 0.02 ETH

/** Refuse to send below this, so the treasury can never be fully drained. */
export const MIN_TREASURY_RESERVE_WEI = 10_000_000_000_000_000n; // 0.01 ETH

/** Bounded so a hung RPC fails closed rather than holding a reservation open. */
export const RPC_TIMEOUT_MS = 10_000;
export const RECEIPT_TIMEOUT_MS = 60_000;
export const RECEIPT_POLL_MS = 2_000;

export const RPC_URLS = [
  "https://sepolia.base.org",
  "https://base-sepolia-rpc.publicnode.com",
] as const;

export const EXPLORER_TX = "https://sepolia.basescan.org/tx/";

export const FAUCET_VERSION = "1.0.0";

export type FaucetStatus =
  | "funded"
  | "already_sufficient"
  | "cooldown"
  | "rate_limited"
  | "treasury_low"
  | "disabled"
  | "invalid_address"
  | "invalid_request"
  | "rpc_unavailable"
  | "send_failed";

/** Statuses a caller can fix by waiting or by doing nothing. */
export const NON_ERROR_STATUSES: ReadonlySet<FaucetStatus> = new Set<FaucetStatus>([
  "funded",
  "already_sufficient",
]);

export function httpStatusFor(status: FaucetStatus): number {
  switch (status) {
    case "funded":
    case "already_sufficient":
      return 200;
    case "cooldown":
    case "rate_limited":
      return 429;
    case "invalid_address":
    case "invalid_request":
      return 400;
    case "disabled":
      return 503;
    case "treasury_low":
    case "rpc_unavailable":
    case "send_failed":
      return 503;
  }
}
