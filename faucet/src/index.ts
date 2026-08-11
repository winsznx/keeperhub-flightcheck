/**
 * Flightcheck Base Sepolia gas faucet.
 *
 * Exists for one job: unblock a KeeperHub organisation wallet that has conclusively been proven,
 * before any broadcast, to lack gas for a Flightcheck canary call. It is not a general-purpose
 * faucet, and everything about the interface is shaped to keep it from becoming one.
 *
 * A caller supplies a recipient and a request id. Nothing else. No chain, no amount, no RPC.
 *
 * The service never receives a KeeperHub credential of any kind, and has no field in which one
 * could be sent.
 */

import {
  CHAIN_ID,
  PAYOUT_WEI,
  SUFFICIENT_BALANCE_WEI,
  MIN_TREASURY_RESERVE_WEI,
  IP_MAX_CLAIMS,
  IP_WINDOW_MS,
  GLOBAL_MAX_CLAIMS_PER_DAY,
  GLOBAL_MAX_WEI_PER_DAY,
  EXPLORER_TX,
  FAUCET_VERSION,
  httpStatusFor,
  type FaucetStatus,
} from "./config.ts";
import { Store, ipBucketKey, globalBucketKey } from "./store.ts";
import {
  ChainError,
  getBalance,
  isAddress,
  treasuryFrom,
  waitForSuccess,
  ZERO_ADDRESS,
  type Treasury,
} from "./chain.ts";

export interface Env {
  DB: D1Database;
  FLIGHTCHECK_FAUCET_PRIVATE_KEY: string;
  RATE_LIMIT_SECRET?: string;
  FAUCET_ENABLED?: string;
}

interface FaucetResponse {
  status: FaucetStatus;
  chainId: number;
  recipient?: string;
  amountWei?: string;
  transactionHash?: string;
  explorerUrl?: string;
  idempotentReplay?: boolean;
  retryAfterSeconds?: number;
  message?: string;
  faucetVersion: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function reply(body: FaucetResponse, status?: number): Response {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status: status ?? httpStatusFor(body.status),
    headers: JSON_HEADERS,
  });
}

function fail(status: FaucetStatus, message?: string, extra: Partial<FaucetResponse> = {}): Response {
  return reply({ status, chainId: CHAIN_ID, faucetVersion: FAUCET_VERSION, message, ...extra });
}

/**
 * Hash the client IP with a server-only secret.
 *
 * Raw addresses are never stored. Without the secret the digest is still not reversible in
 * practice for IPv4, so the secret is what makes the bucket key genuinely opaque.
 */
async function ipHmac(ip: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip));
  return [...new Uint8Array(sig)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    if (url.pathname === "/api/faucet/base-sepolia/status" && request.method === "GET") {
      return handleStatus(env);
    }

    if (url.pathname === "/api/faucet/base-sepolia" && request.method === "POST") {
      try {
        return await handleClaim(request, env);
      } catch (err) {
        // Nothing from an exception reaches the caller. A viem error can carry the signed
        // transaction, and an unhandled shape could carry anything at all.
        const code = err instanceof ChainError ? err.code : "send_failed";
        return fail(code, "The faucet could not complete this request.");
      }
    }

    return fail("invalid_request", "Unknown route. See /api/faucet/base-sepolia/status.");
  },
};

async function handleStatus(env: Env): Promise<Response> {
  const enabled = env.FAUCET_ENABLED !== "false";
  let treasury: Treasury | null = null;
  let balance: bigint | null = null;
  try {
    treasury = treasuryFrom(env.FLIGHTCHECK_FAUCET_PRIVATE_KEY);
    balance = await getBalance(treasury.address);
  } catch {
    balance = null;
  }

  const store = new Store(env.DB);
  const stats = await store.stats(Date.now()).catch(() => ({ claimsToday: 0, weiToday: "0" }));

  return new Response(
    JSON.stringify(
      {
        service: "keeperhub-flightcheck-faucet",
        faucetVersion: FAUCET_VERSION,
        enabled,
        chainId: CHAIN_ID,
        chainName: "Base Sepolia",
        testnetOnly: true,
        purpose:
          "Gas fallback for KeeperHub Flightcheck onboarding. Not a general-purpose faucet.",
        treasuryAddress: treasury?.address ?? null,
        treasuryBalanceWei: balance?.toString() ?? null,
        treasuryFunded: balance !== null && balance > MIN_TREASURY_RESERVE_WEI,
        fixedPayoutWei: PAYOUT_WEI.toString(),
        callerSelectableAmount: false,
        callerSelectableChain: false,
        limits: {
          recipientCooldownHours: 24,
          ipClaimsPerHour: IP_MAX_CLAIMS,
          globalClaimsPerDay: GLOBAL_MAX_CLAIMS_PER_DAY,
          globalWeiPerDay: GLOBAL_MAX_WEI_PER_DAY.toString(),
          minTreasuryReserveWei: MIN_TREASURY_RESERVE_WEI.toString(),
        },
        claimsLast24h: stats.claimsToday,
      },
      null,
      2,
    ) + "\n",
    { headers: JSON_HEADERS },
  );
}

async function handleClaim(request: Request, env: Env): Promise<Response> {
  const now = Date.now();

  if (env.FAUCET_ENABLED === "false") {
    return fail("disabled", "The faucet is temporarily disabled.");
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail("invalid_request", "Body must be JSON.");
  }

  // Reject any attempt to widen scope, loudly, rather than ignoring it. A caller who thinks they
  // set an amount should be told they cannot, not silently given the default.
  for (const forbidden of ["amount", "amountWei", "value", "chainId", "chain", "rpcUrl", "rpc"]) {
    if (forbidden in body) {
      return fail(
        "invalid_request",
        `This faucet takes no ${forbidden}. The amount and chain are fixed by the service.`,
      );
    }
  }

  const recipient = body.recipient;
  const requestId = body.requestId;

  if (!isAddress(recipient)) {
    return fail("invalid_address", "recipient must be a 0x-prefixed 20-byte address.");
  }
  if (recipient.toLowerCase() === ZERO_ADDRESS) {
    return fail("invalid_address", "The zero address cannot receive funds.");
  }
  if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) {
    return fail(
      "invalid_request",
      "requestId must be 8 to 128 characters of A-Z a-z 0-9 . _ : and -",
    );
  }

  let treasury: Treasury;
  try {
    treasury = treasuryFrom(env.FLIGHTCHECK_FAUCET_PRIVATE_KEY);
  } catch {
    return fail("disabled", "The faucet treasury is not configured.");
  }

  if (recipient.toLowerCase() === treasury.address.toLowerCase()) {
    return fail("invalid_address", "The treasury cannot fund itself.");
  }

  const store = new Store(env.DB);

  // A replay is answered before any limit is consulted, so retrying a request that already
  // succeeded returns the original transaction rather than a cooldown or a rate limit.
  const existing = await store.getClaim(requestId);
  if (existing && existing.status === "funded" && existing.tx_hash) {
    if (existing.recipient.toLowerCase() !== recipient.toLowerCase()) {
      return fail("invalid_request", "That requestId was used with a different recipient.");
    }
    return reply({
      status: "funded",
      chainId: CHAIN_ID,
      recipient: existing.recipient,
      amountWei: existing.amount_wei,
      transactionHash: existing.tx_hash,
      explorerUrl: EXPLORER_TX + existing.tx_hash,
      idempotentReplay: true,
      faucetVersion: FAUCET_VERSION,
    });
  }

  // Already has gas. Nothing to do, and saying so is not a failure.
  let recipientBalance: bigint;
  try {
    recipientBalance = await getBalance(recipient);
  } catch {
    return fail("rpc_unavailable", "Could not read the recipient balance.");
  }
  if (recipientBalance >= SUFFICIENT_BALANCE_WEI) {
    return reply({
      status: "already_sufficient",
      chainId: CHAIN_ID,
      recipient,
      amountWei: "0",
      faucetVersion: FAUCET_VERSION,
      message: "The recipient already holds enough gas for a Flightcheck run.",
    });
  }

  let treasuryBalance: bigint;
  try {
    treasuryBalance = await getBalance(treasury.address);
  } catch {
    return fail("rpc_unavailable", "Could not read the treasury balance.");
  }
  if (treasuryBalance < MIN_TREASURY_RESERVE_WEI + PAYOUT_WEI) {
    return fail("treasury_low", "The faucet treasury is below its reserve.");
  }

  const secret = env.RATE_LIMIT_SECRET ?? "flightcheck-faucet-default-rate-secret";
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const ipKey = ipBucketKey(await ipHmac(ip, secret), now);

  const perIp = await store.bumpAndCheck(ipKey, now, IP_WINDOW_MS, IP_MAX_CLAIMS, 0n, null);
  if (!perIp.allowed) {
    return fail("rate_limited", "Too many faucet requests from this network. Try again later.", {
      retryAfterSeconds: Math.ceil(IP_WINDOW_MS / 1000),
    });
  }

  const perDay = await store.bumpAndCheck(
    globalBucketKey(now),
    now,
    24 * 60 * 60 * 1000,
    GLOBAL_MAX_CLAIMS_PER_DAY,
    PAYOUT_WEI,
    GLOBAL_MAX_WEI_PER_DAY,
  );
  if (!perDay.allowed) {
    return fail("rate_limited", "The faucet has reached its daily cap. Try again tomorrow.", {
      retryAfterSeconds: 3600,
    });
  }

  // Reserve atomically BEFORE anything is signed. Everything above this line is a read.
  const reservation = await store.reserve(requestId, recipient.toLowerCase(), PAYOUT_WEI, now);

  if (reservation.kind === "cooldown") {
    return fail("cooldown", "This address has already been funded recently.", {
      recipient,
      retryAfterSeconds: Math.max(1, Math.ceil((reservation.until - now) / 1000)),
    });
  }

  if (reservation.kind === "replay") {
    const c = reservation.claim;
    if (c.status === "funded" && c.tx_hash) {
      return reply({
        status: "funded",
        chainId: CHAIN_ID,
        recipient: c.recipient,
        amountWei: c.amount_wei,
        transactionHash: c.tx_hash,
        explorerUrl: EXPLORER_TX + c.tx_hash,
        idempotentReplay: true,
        faucetVersion: FAUCET_VERSION,
      });
    }
    if (c.status === "failed") {
      return fail("send_failed", "That request previously failed. Use a new requestId.", {
        idempotentReplay: true,
      });
    }
    // Still reserved: another request holds it. Never send a second transaction for one id.
    return fail("rate_limited", "That request is already in flight.", {
      idempotentReplay: true,
      retryAfterSeconds: 15,
    });
  }

  let hash: string;
  try {
    hash = await treasury.send(recipient, PAYOUT_WEI);
  } catch (err) {
    const code = err instanceof ChainError ? err.code : "send_failed";
    await store.markFailed(requestId, code, Date.now());
    return fail(code, "The faucet could not send the transaction.");
  }

  // A hash is not a mined transaction. `funded` is only reported after a successful receipt.
  try {
    const receipt = await waitForSuccess(hash as `0x${string}`);
    if (!receipt.ok) {
      await store.markFailed(requestId, "reverted", Date.now());
      return fail("send_failed", "The faucet transaction did not succeed.");
    }
  } catch {
    // The transaction may still land, so the claim stays consumed rather than being freed for a
    // retry that could produce a second transfer.
    await store.markFailed(requestId, "receipt_timeout", Date.now());
    return fail("send_failed", "The faucet transaction was sent but could not be confirmed.", {
      transactionHash: hash,
      explorerUrl: EXPLORER_TX + hash,
    });
  }

  await store.markFunded(requestId, hash, Date.now());

  return reply({
    status: "funded",
    chainId: CHAIN_ID,
    recipient,
    amountWei: PAYOUT_WEI.toString(),
    transactionHash: hash,
    explorerUrl: EXPLORER_TX + hash,
    idempotentReplay: false,
    faucetVersion: FAUCET_VERSION,
  });
}
