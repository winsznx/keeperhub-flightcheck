/**
 * Client for the Flightcheck Base Sepolia gas fallback.
 *
 * The privacy boundary is the whole design. The faucet is a separate service on separate
 * infrastructure, so it gets the two public values it needs to do its job and nothing else:
 * a recipient address and a request id. There is no field in the request for a credential,
 * and no code path here that could put one there.
 *
 * `buildRequestBody` is exported so a test can assert, byte for byte, that a registered
 * KeeperHub key appears nowhere in an outbound request.
 */

import { FlightcheckError } from "./errors.ts";
import { TOOL_VERSION } from "./config.ts";

export const FAUCET_URL = "https://keeperhub-flightcheck-faucet.timjosh507.workers.dev";
export const FAUCET_PAYOUT_WEI = 100_000_000_000_000n; // 0.0001 ETH, fixed by the service

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

export interface FaucetResult {
  readonly status: FaucetStatus;
  readonly chainId: number;
  readonly recipient?: string;
  readonly amountWei?: string;
  readonly transactionHash?: string;
  readonly explorerUrl?: string;
  readonly idempotentReplay?: boolean;
  readonly retryAfterSeconds?: number;
  readonly message?: string;
}

/**
 * Exactly what goes on the wire.
 *
 * Two public fields plus a version string. No headers beyond content-type, so there is not even
 * an Authorization header for a credential to be attached to by mistake.
 */
export function buildRequestBody(recipient: string, requestId: string): string {
  return JSON.stringify({
    recipient,
    requestId,
    flightcheckVersion: TOOL_VERSION,
  });
}

export interface FaucetClientOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class FaucetClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: FaucetClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? FAUCET_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 90_000;
  }

  async status(): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/faucet/base-sepolia/status`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new FlightcheckError("FC_FAUCET_UNAVAILABLE");
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * Request the fixed payout.
   *
   * Deliberately no amount parameter, mirroring the server. There is nothing for a caller of
   * this client to turn up either.
   */
  async request(recipient: string, requestId: string): Promise<FaucetResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/faucet/base-sepolia`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: buildRequestBody(recipient, requestId),
        signal: controller.signal,
      });
      const body = (await res.json()) as FaucetResult;
      if (!body || typeof body.status !== "string") {
        throw new FlightcheckError("FC_FAUCET_UNAVAILABLE");
      }
      return body;
    } catch (err) {
      if (err instanceof FlightcheckError) throw err;
      throw new FlightcheckError("FC_FAUCET_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Human-readable outcome, and whether the run may now continue. */
export function describeFaucetResult(r: FaucetResult): { proceed: boolean; text: string } {
  switch (r.status) {
    case "funded":
      return {
        proceed: true,
        text: r.idempotentReplay
          ? `Already funded by an earlier identical request. ${r.transactionHash}`
          : `Funded. ${r.transactionHash}`,
      };
    case "already_sufficient":
      return {
        proceed: true,
        text: "The wallet already holds enough gas, so nothing was sent.",
      };
    case "cooldown":
      return {
        proceed: false,
        text:
          "This address was funded recently and is inside the faucet's cooldown. " +
          (r.retryAfterSeconds ? `Try again in about ${Math.ceil(r.retryAfterSeconds / 60)} minutes.` : ""),
      };
    case "rate_limited":
      return { proceed: false, text: "The faucet is rate limiting this request. Try again shortly." };
    case "treasury_low":
      return { proceed: false, text: "The faucet treasury is below its reserve. Use a public Base Sepolia faucet." };
    case "disabled":
      return { proceed: false, text: "The faucet is currently disabled." };
    case "invalid_address":
    case "invalid_request":
      return { proceed: false, text: `The faucet rejected the request: ${r.message ?? r.status}` };
    case "rpc_unavailable":
    case "send_failed":
      return { proceed: false, text: "The faucet could not complete the transfer. Nothing was assumed." };
  }
}
