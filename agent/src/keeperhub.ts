/**
 * KeeperHub REST client.
 *
 * Three behaviours here are not obvious from the endpoint reference and were measured against
 * the live API. Each one is a place where a straightforward client gets the wrong answer.
 *
 * 1. A simulation that would revert answers with HTTP 400 and `wouldRevert: true`. The body is
 *    the diagnostic. A wrapper that treats non-2xx as failure throws away the most useful
 *    output in the entire funnel, so `simulate` reads the field and never the status code.
 *
 * 2. A successful `/contract-call` broadcast returns 202 with `{executionId, status}` and no
 *    `transactionHash`, even when status is already `completed`. The hash only appears on the
 *    status endpoint. Reading it off the broadcast response yields undefined at the exact moment
 *    a caller believes it has succeeded.
 *
 * 3. Error envelopes are not uniform. A 401 is `{"error":"Unauthorized"}` with no detail and no
 *    request id; a 404 carries both. Everything is normalised before it reaches the caller.
 */

import { KEEPERHUB_BASE_URL } from "./config.ts";
import { FlightcheckError } from "./errors.ts";
import type { ExecState, ReceiptLike } from "./execstate.ts";
import { normalizeState } from "./execstate.ts";

export interface ChainInfo {
  readonly chainId: number;
  readonly name: string;
  readonly isEnabled: boolean;
  readonly isTestnet: boolean;
  readonly chainType: string;
  readonly usePrivateMempoolRpc?: boolean;
}

export interface SimulationResult {
  readonly success: boolean;
  readonly status: string;
  readonly from?: string;
  readonly to?: string;
  readonly value?: string;
  readonly gasEstimate?: string;
  readonly wouldRevert?: boolean;
  readonly revertReason?: string;
  readonly code?: string;
  readonly balanceWei?: string;
  readonly requiredWei?: string;
  readonly shortfallWei?: string;
  readonly nativeSymbol?: string;
}

export interface BroadcastResult {
  readonly httpStatus: number;
  readonly executionId?: string;
  readonly status?: string;
  readonly transactionHash?: string;
  readonly transactionLink?: string;
  /** Present only on a replay of a stored response, and always true when present. */
  readonly idempotentReplay?: boolean;
}

export interface ExecutionStatus {
  readonly executionId: string;
  readonly serverStatus: string;
  readonly state: ExecState;
  readonly sponsored?: boolean;
  readonly type?: string;
  readonly transactionHash?: string;
  readonly transactionLink?: string;
  readonly receipts: readonly ReceiptLike[];
  readonly error?: unknown;
  readonly createdAt?: string;
  readonly completedAt?: string;
  /** Seconds to wait before the next poll. 0 means terminal. */
  readonly pollIntervalHint?: number;
  readonly raw: Record<string, unknown>;
}

export interface HttpTrace {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly elapsedMs: number;
  readonly requestId?: string;
}

/** Lets a test discard a real response after the server has accepted the request. */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export class KeeperHubClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly transport: Transport;
  readonly traces: HttpTrace[] = [];

  constructor(apiKey: string, opts: { baseUrl?: string; transport?: Transport } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = opts.baseUrl ?? KEEPERHUB_BASE_URL;
    this.transport = opts.transport ?? ((url, init) => fetch(url, init));
  }

  private async request(
    method: string,
    path: string,
    opts: { body?: string; idempotencyKey?: string } = {},
  ): Promise<{ res: Response; json: Record<string, unknown> | null; text: string }> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (opts.body) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    const started = Date.now();
    const res = await this.transport(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: opts.body,
    });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text);
      json = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      json = null;
    }
    this.traces.push({
      method,
      path,
      status: res.status,
      elapsedMs: Date.now() - started,
      requestId: res.headers.get("x-request-id") ?? undefined,
    });
    return { res, json, text };
  }

  /**
   * Prove the credential works.
   *
   * GET /api/chains answers without a credential, so it reports reachability rather than a
   * working key. This deliberately uses /api/keys, which does not.
   */
  async verifyAuth(): Promise<{ keyCount: number; scope?: string }> {
    const { res, json } = await this.request("GET", "/api/keys");
    if (res.status === 401) throw new FlightcheckError("FC_AUTH_INVALID");
    if (res.status === 403) throw new FlightcheckError("FC_AUTH_FORBIDDEN");
    if (!res.ok) throw new FlightcheckError("FC_AUTH_INVALID");
    const items = Array.isArray(json?.items) ? (json.items as Array<Record<string, unknown>>) : [];
    const scope = items.find((i) => typeof i.scope === "string")?.scope as string | undefined;
    return { keyCount: items.length, scope };
  }

  /** The org wallet KeeperHub executes from. Not the address a user signed in with. */
  async resolveOrgWallet(): Promise<string> {
    const { res, json } = await this.request("GET", "/api/user");
    if (res.status === 401) throw new FlightcheckError("FC_AUTH_INVALID");
    if (res.status === 422) throw new FlightcheckError("FC_WALLET_NOT_CONFIGURED");
    const address = json?.walletAddress;
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new FlightcheckError("FC_WALLET_UNRESOLVED");
    }
    return address.toLowerCase();
  }

  async listChains(): Promise<ChainInfo[]> {
    const { res, text } = await this.request("GET", "/api/chains");
    if (!res.ok) throw new FlightcheckError("FC_CHAIN_UNSUPPORTED", { chainId: "unknown" });
    const parsed = JSON.parse(text) as ChainInfo[];
    return Array.isArray(parsed) ? parsed : [];
  }

  /**
   * Dry run. Never signs, never broadcasts, inserts no audit row.
   *
   * A would-revert answer arrives as HTTP 400 with a decoded reason. That is a successful
   * simulation reporting a failing transaction, so the status code is not the verdict.
   */
  async simulate(body: Record<string, unknown>): Promise<SimulationResult> {
    const { res, json } = await this.request("POST", "/api/execute/contract-call", {
      body: JSON.stringify({ ...body, simulate: true }),
    });

    if (res.status === 401) throw new FlightcheckError("FC_AUTH_INVALID");
    if (res.status === 422) throw new FlightcheckError("FC_WALLET_NOT_CONFIGURED");
    if (res.status === 429) {
      throw new FlightcheckError("FC_EXEC_RATE_LIMITED", {
        retryAfter: res.headers.get("retry-after") ?? undefined,
      });
    }
    if (res.status === 403) {
      const err = String(json?.error ?? "");
      if (err.includes("insufficient_scope")) {
        throw new FlightcheckError("FC_AUTH_INSUFFICIENT_SCOPE", {
          required: json?.required_scope as string,
          granted: json?.granted_scope as string,
        });
      }
      throw new FlightcheckError("FC_EXEC_SPEND_CAP");
    }

    const result = (json ?? {}) as unknown as SimulationResult;

    // Branch on the field, not the status code.
    if (result.wouldRevert === true) {
      if (result.code === "insufficient_balance") {
        throw new FlightcheckError("FC_SIM_INSUFFICIENT_BALANCE", {
          wallet: result.from,
          have: fmtEth(result.balanceWei),
          need: fmtEth(result.requiredWei),
          shortfall: `${fmtEth(result.shortfallWei)} ${result.nativeSymbol ?? ""}`.trim(),
        });
      }
      throw new FlightcheckError("FC_SIM_REVERT", { reason: result.revertReason });
    }

    if (!res.ok || result.success !== true) {
      throw new FlightcheckError("FC_SIM_REJECTED", {
        detail: (json?.error as string) ?? (json?.details as string) ?? `HTTP ${res.status}.`,
      });
    }
    return result;
  }

  /**
   * Broadcast. The caller must have durably persisted the body and key before calling this.
   *
   * A thrown transport error is the dangerous case: the request may have been accepted, so the
   * caller has to treat it as possibly-broadcast rather than as a failure.
   */
  async broadcast(canonicalBody: string, idempotencyKey: string): Promise<BroadcastResult> {
    let res: Response;
    let json: Record<string, unknown> | null;
    try {
      ({ res, json } = await this.request("POST", "/api/execute/contract-call", {
        body: canonicalBody,
        idempotencyKey,
      }));
    } catch {
      throw new FlightcheckError("FC_EXEC_TRANSPORT_LOST");
    }

    if (res.status === 409) {
      const code = String(json?.code ?? json?.error ?? "");
      if (code.includes("in_progress")) {
        throw new FlightcheckError("FC_EXEC_IDEMPOTENCY_IN_PROGRESS");
      }
      throw new FlightcheckError("FC_EXEC_IDEMPOTENCY_CONFLICT", {
        originalExecutionId: (json?.originalExecutionId as string) ?? undefined,
      });
    }
    if (res.status === 401) throw new FlightcheckError("FC_AUTH_INVALID");
    if (res.status === 422) throw new FlightcheckError("FC_WALLET_NOT_CONFIGURED");
    if (res.status === 429) {
      throw new FlightcheckError("FC_EXEC_RATE_LIMITED", {
        retryAfter: res.headers.get("retry-after") ?? undefined,
      });
    }
    if (res.status === 403) {
      const err = String(json?.error ?? "");
      if (err.includes("insufficient_scope")) {
        throw new FlightcheckError("FC_AUTH_INSUFFICIENT_SCOPE", {
          required: json?.required_scope as string,
          granted: json?.granted_scope as string,
        });
      }
      throw new FlightcheckError("FC_EXEC_SPEND_CAP");
    }
    if (!res.ok && res.status !== 202) {
      throw new FlightcheckError("FC_SIM_REJECTED", {
        detail: (json?.error as string) ?? `HTTP ${res.status}.`,
      });
    }

    return {
      httpStatus: res.status,
      executionId: json?.executionId as string | undefined,
      status: json?.status as string | undefined,
      transactionHash: json?.transactionHash as string | undefined,
      transactionLink: json?.transactionLink as string | undefined,
      idempotentReplay: json?.idempotentReplay === true ? true : undefined,
    };
  }

  async getStatus(executionId: string): Promise<ExecutionStatus> {
    const { res, json } = await this.request("GET", `/api/execute/${executionId}/status`);
    if (res.status === 401) throw new FlightcheckError("FC_AUTH_INVALID");
    const raw = (json ?? {}) as Record<string, unknown>;
    const hint = res.headers.get("x-poll-interval-hint");
    return {
      executionId,
      serverStatus: String(raw.status ?? ""),
      state: normalizeState(raw.status),
      sponsored: typeof raw.sponsored === "boolean" ? raw.sponsored : undefined,
      type: raw.type as string | undefined,
      transactionHash: raw.transactionHash as string | undefined,
      transactionLink: raw.transactionLink as string | undefined,
      receipts: Array.isArray(raw.receipts) ? (raw.receipts as ReceiptLike[]) : [],
      error: raw.error ?? undefined,
      createdAt: raw.createdAt as string | undefined,
      completedAt: raw.completedAt as string | undefined,
      pollIntervalHint: hint === null ? undefined : Number(hint),
      raw,
    };
  }
}

function fmtEth(wei: string | undefined): string {
  if (!wei) return "?";
  try {
    const v = BigInt(wei);
    const whole = v / 10n ** 18n;
    const frac = (v % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : `${whole}`;
  } catch {
    return "?";
  }
}
