/**
 * The failure taxonomy.
 *
 * Every way a run can stop has a stable code, the stage it stops at, a one-line diagnosis and
 * a remediation the reader can act on without opening the docs. This is the part of Flightcheck
 * that separates it from a health check: the point is not that something failed, it is knowing
 * exactly which link in the chain failed and what to do about it.
 *
 * `broadcastPossible` is the field that matters most. When it is true, a transaction may already
 * be on the wire, so the correct move is to resume the same logical run rather than start a new
 * one. Anything that resumes must never mint a fresh idempotency key.
 */

import type { Stage } from "./stages.ts";

export type FailureCode =
  // configuration, before any network call
  | "FC_ENV_MISSING_KEY"
  | "FC_ENV_WRONG_KEY_TYPE"
  | "FC_ENV_MALFORMED_KEY"
  // authentication
  | "FC_AUTH_INVALID"
  | "FC_AUTH_FORBIDDEN"
  | "FC_AUTH_INSUFFICIENT_SCOPE"
  // wallet
  | "FC_WALLET_UNRESOLVED"
  | "FC_WALLET_NOT_CONFIGURED"
  // chain
  | "FC_CHAIN_UNSUPPORTED"
  | "FC_CHAIN_DISABLED"
  | "FC_CHAIN_NOT_TESTNET"
  // canary
  | "FC_CANARY_NO_CODE"
  | "FC_CANARY_BYTECODE_MISMATCH"
  | "FC_RPC_UNREACHABLE"
  | "FC_RPC_WRONG_CHAIN"
  // simulation
  | "FC_SIM_REVERT"
  | "FC_SIM_INSUFFICIENT_BALANCE"
  | "FC_SIM_REJECTED"
  // execution
  | "FC_EXEC_RATE_LIMITED"
  | "FC_EXEC_SPEND_CAP"
  | "FC_EXEC_IDEMPOTENCY_CONFLICT"
  | "FC_EXEC_IDEMPOTENCY_IN_PROGRESS"
  | "FC_EXEC_TRANSPORT_LOST"
  | "FC_EXEC_FAILED"
  | "FC_EXEC_NO_ID"
  // settlement
  | "FC_STATUS_UNCONFIRMED"
  | "FC_STATUS_UNKNOWN"
  | "FC_RECEIPT_NOT_FOUND"
  | "FC_RECEIPT_REVERTED"
  | "FC_RECEIPT_UNVERIFIED"
  // verification
  | "FC_EVENT_MISSING"
  | "FC_EVENT_WRONG_EMITTER"
  | "FC_EVENT_CHALLENGE_MISMATCH"
  | "FC_EVENT_CHAINID_MISMATCH"
  | "FC_EVENT_SENDER_MISMATCH"
  | "FC_HASH_DISAGREEMENT"
  // resume
  | "FC_RESUME_NOT_FOUND"
  | "FC_RESUME_NOTHING_TO_REPLAY"
  | "FC_RESUME_WINDOW_EXPIRED";

export interface FailureSpec {
  readonly stage: Stage;
  readonly title: string;
  /** True when a transaction may already exist onchain. Resume, never restart. */
  readonly broadcastPossible: boolean;
  readonly remediation: (ctx: Record<string, string | number | undefined>) => string;
}

const RESUME = (ctx: Record<string, string | number | undefined>) =>
  ctx.runId ? `\n  npm run flightcheck -- --resume ${ctx.runId}` : "";

export const FAILURES: Record<FailureCode, FailureSpec> = {
  FC_ENV_MISSING_KEY: {
    stage: "START",
    title: "No KeeperHub API key found",
    broadcastPossible: false,
    remediation: () =>
      "Set KEEPERHUB_API_KEY in .env. Create the key at app.keeperhub.com under\n" +
      "Settings, API Keys, the Organisation tab. Copy .env.example to .env if you have not.",
  },
  FC_ENV_WRONG_KEY_TYPE: {
    stage: "START",
    title: "That is a user key, not an organisation key",
    broadcastPossible: false,
    remediation: () =>
      "KEEPERHUB_API_KEY starts with wfb_, which is a user key for webhook triggers. The REST\n" +
      "execution API needs the organisation key that starts with kh_. The two are not\n" +
      "interchangeable. Settings, API Keys, Organisation tab.",
  },
  FC_ENV_MALFORMED_KEY: {
    stage: "START",
    title: "API key is not in a recognised format",
    broadcastPossible: false,
    remediation: () =>
      "KEEPERHUB_API_KEY should start with kh_. Check for a partial paste, a quoted value or a\n" +
      "trailing newline in .env.",
  },
  FC_AUTH_INVALID: {
    stage: "AUTHENTICATED",
    title: "KeeperHub rejected the API key",
    broadcastPossible: false,
    remediation: () =>
      "GET /api/keys returned 401. The key is wrong, revoked or expired. Issue a fresh\n" +
      "organisation key and update .env.\n" +
      "Note that GET /api/chains answers without a credential, so reaching KeeperHub is not\n" +
      "evidence that your key works.",
  },
  FC_AUTH_FORBIDDEN: {
    stage: "AUTHENTICATED",
    title: "KeeperHub refused the request",
    broadcastPossible: false,
    remediation: () =>
      "403. Either the organisation daily spending cap is exhausted, or the credential lacks\n" +
      "the scope this call needs. Check Settings, then Billing and API Keys.",
  },
  FC_AUTH_INSUFFICIENT_SCOPE: {
    stage: "EXECUTION_PREPARED",
    title: "Credential cannot broadcast",
    broadcastPossible: false,
    remediation: (c) =>
      `Broadcasting needs the ${c.required ?? "mcp:write"} scope; this token has ${c.granted ?? "mcp:read"}.\n` +
      "Simulation works on mcp:read, which is why the earlier stages passed. Reauthorize with\n" +
      "the write scope, or use an organisation API key, which is not scope-limited.",
  },
  FC_WALLET_UNRESOLVED: {
    stage: "WALLET_RESOLVED",
    title: "Could not resolve the organisation wallet",
    broadcastPossible: false,
    remediation: () =>
      "GET /api/user did not return a walletAddress. This is the wallet KeeperHub executes\n" +
      "from, and it is not the address you signed in with. Open app.keeperhub.com and finish\n" +
      "wallet setup.",
  },
  FC_WALLET_NOT_CONFIGURED: {
    stage: "WALLET_RESOLVED",
    title: "No execution wallet configured",
    broadcastPossible: false,
    remediation: () =>
      "KeeperHub returned WALLET_NOT_CONFIGURED (422). The organisation has no execution wallet\n" +
      "yet. Create one in the app before running Flightcheck.",
  },
  FC_CHAIN_UNSUPPORTED: {
    stage: "CHAIN_RESOLVED",
    title: "Chain is not offered by KeeperHub",
    broadcastPossible: false,
    remediation: (c) =>
      `Chain ${c.chainId} is absent from GET /api/chains. Flightcheck v1 targets Base Sepolia\n` +
      "(84532). Remove FLIGHTCHECK_CHAIN_ID from .env to use the default.",
  },
  FC_CHAIN_DISABLED: {
    stage: "CHAIN_RESOLVED",
    title: "Chain is listed but disabled",
    broadcastPossible: false,
    remediation: (c) => `KeeperHub reports isEnabled=false for chain ${c.chainId}. Try again later.`,
  },
  FC_CHAIN_NOT_TESTNET: {
    stage: "CHAIN_RESOLVED",
    title: "Refusing to run against a non-testnet chain",
    broadcastPossible: false,
    remediation: (c) =>
      `Chain ${c.chainId} is not flagged isTestnet. Flightcheck v1 is testnet-only by design and\n` +
      "has no mainnet path.",
  },
  FC_CANARY_NO_CODE: {
    stage: "CANARY_VERIFIED",
    title: "No contract code at the canary address",
    broadcastPossible: false,
    remediation: (c) =>
      `eth_getCode returned empty for ${c.address} on chain ${c.chainId}. Either the RPC is\n` +
      "serving a different chain, or the pinned address is wrong for this network.",
  },
  FC_CANARY_BYTECODE_MISMATCH: {
    stage: "CANARY_VERIFIED",
    title: "Canary bytecode does not match the pinned hash",
    broadcastPossible: false,
    remediation: () =>
      "The code deployed at the canary address is not the code this build expects. Flightcheck\n" +
      "fails closed here and will not ask KeeperHub to call it. Rebuild the contract with\n" +
      "`cd contracts && forge build` and compare, or update to a release whose pin matches.",
  },
  FC_RPC_UNREACHABLE: {
    stage: "CANARY_VERIFIED",
    title: "Independent RPC is unreachable",
    broadcastPossible: false,
    remediation: (c) =>
      `Could not reach ${c.rpc ?? "the configured RPC"}. Flightcheck verifies results against a\n` +
      "node that is not KeeperHub, so it will not proceed without one. Set FLIGHTCHECK_RPC_URL\n" +
      "to any Base Sepolia endpoint.",
  },
  FC_RPC_WRONG_CHAIN: {
    stage: "CANARY_VERIFIED",
    title: "Independent RPC is on the wrong chain",
    broadcastPossible: false,
    remediation: (c) =>
      `The RPC reports chain ${c.actual} but this run targets ${c.expected}. Point\n` +
      "FLIGHTCHECK_RPC_URL at a Base Sepolia node.",
  },
  FC_SIM_REVERT: {
    stage: "SIMULATION_PASSED",
    title: "Simulation says the call would revert",
    broadcastPossible: false,
    remediation: (c) =>
      `KeeperHub decoded: ${c.reason ?? "no reason given"}\n` +
      "Nothing was broadcast. Simulation exists precisely so this costs no gas.",
  },
  FC_SIM_INSUFFICIENT_BALANCE: {
    stage: "SIMULATION_PASSED",
    title: "Execution wallet cannot pay for this transaction",
    broadcastPossible: false,
    remediation: (c) =>
      `Fund ${c.wallet ?? "the org wallet"} on ${c.chainName ?? "this chain"}.\n` +
      `  have      ${c.have ?? "?"}\n  need      ${c.need ?? "?"}\n  shortfall ${c.shortfall ?? "?"}\n` +
      "This is the organisation wallet KeeperHub executes from. It is not the wallet you signed\n" +
      "in with, and funding the sign-in wallet will not help.",
  },
  FC_SIM_REJECTED: {
    stage: "SIMULATION_PASSED",
    title: "KeeperHub rejected the simulation request",
    broadcastPossible: false,
    remediation: (c) => `${c.detail ?? "The request was malformed."} Nothing was broadcast.`,
  },
  FC_EXEC_RATE_LIMITED: {
    stage: "EXECUTION_CREATED",
    title: "Rate limited by KeeperHub",
    broadcastPossible: false,
    remediation: (c) =>
      `Direct execution allows 60 requests per minute per key. Wait ${c.retryAfter ?? "a few"}\n` +
      "seconds and resume the same run so the idempotency key is reused." + RESUME(c),
  },
  FC_EXEC_SPEND_CAP: {
    stage: "EXECUTION_CREATED",
    title: "Daily spending cap exceeded",
    broadcastPossible: false,
    remediation: () => "Raise or reset the organisation daily spending cap in the KeeperHub app.",
  },
  FC_EXEC_IDEMPOTENCY_CONFLICT: {
    stage: "EXECUTION_CREATED",
    title: "Idempotency key already used for a different request body",
    broadcastPossible: true,
    remediation: (c) =>
      "This is the safe answer, not a bug. KeeperHub refused to execute because the body\n" +
      "differs from the one this key first carried, which is what stops a rebuilt retry from\n" +
      "double-spending.\n" +
      (c.originalExecutionId
        ? `The original execution is ${c.originalExecutionId}. Flightcheck will reconcile it.`
        : "No original execution id was returned, so the first attempt either failed at broadcast\n" +
          "or is still in flight. Keep the same key and retry; rotating it is the one action that\n" +
          "can produce a second transaction.") +
      RESUME(c),
  },
  FC_EXEC_IDEMPOTENCY_IN_PROGRESS: {
    stage: "EXECUTION_CREATED",
    title: "An identical request is still running",
    broadcastPossible: true,
    remediation: (c) => "Wait a moment and resume the same run." + RESUME(c),
  },
  FC_EXEC_TRANSPORT_LOST: {
    stage: "BROADCAST_OBSERVED",
    title: "The response was lost after KeeperHub accepted the request",
    broadcastPossible: true,
    remediation: (c) =>
      "A transaction may already exist. Flightcheck persisted the request and its idempotency\n" +
      "key before sending, so resuming replays the identical request and recovers the original\n" +
      "outcome instead of creating a second one." + RESUME(c),
  },
  FC_EXEC_FAILED: {
    stage: "RECEIPT_CONFIRMED",
    title: "KeeperHub reports the execution failed",
    broadcastPossible: true,
    remediation: (c) => `${c.detail ?? "No detail was returned."}` + RESUME(c),
  },
  FC_EXEC_NO_ID: {
    stage: "EXECUTION_CREATED",
    title: "KeeperHub accepted the request but returned no execution id",
    broadcastPossible: true,
    remediation: (c) =>
      "Without an id there is nothing to poll. Resume to replay the same idempotency key, which\n" +
      "returns the stored original response." + RESUME(c),
  },
  FC_STATUS_UNCONFIRMED: {
    stage: "RECEIPT_CONFIRMED",
    title: "Execution is unconfirmed, which is not a failure",
    broadcastPossible: true,
    remediation: (c) =>
      "The transaction was broadcast but its receipt could not be read conclusively yet. This\n" +
      "state is non-terminal. Do not re-run, which would risk a second transaction. Resume the\n" +
      "same run instead." + RESUME(c),
  },
  FC_STATUS_UNKNOWN: {
    stage: "RECEIPT_CONFIRMED",
    title: "KeeperHub returned a status this build does not recognise",
    broadcastPossible: true,
    remediation: (c) =>
      `Status was ${c.status ?? "unset"}. Unknown states are treated as non-terminal and never\n` +
      "as success or failure. Resume to reconcile." + RESUME(c),
  },
  FC_RECEIPT_NOT_FOUND: {
    stage: "RECEIPT_CONFIRMED",
    title: "No receipt found for the transaction yet",
    broadcastPossible: true,
    remediation: (c) =>
      "The independent node has not seen this hash within the polling budget. That is unknown,\n" +
      "not failed: the transaction may still land. Resume in a minute." + RESUME(c),
  },
  FC_RECEIPT_REVERTED: {
    stage: "RECEIPT_CONFIRMED",
    title: "The transaction landed but reverted",
    broadcastPossible: true,
    remediation: (c) =>
      `Receipt status is ${c.status ?? "0x0"}. Gas was spent and no Flightcheck event exists.\n` +
      "This is a real onchain failure and is never reported as success.",
  },
  FC_RECEIPT_UNVERIFIED: {
    stage: "RECEIPT_CONFIRMED",
    title: "KeeperHub could not verify its own receipt",
    broadcastPossible: true,
    remediation: (c) =>
      `receiptStatus is ${c.receiptStatus ?? "unknown"}. not_found and timeout mean verification\n` +
      "ran out of budget rather than that the transaction failed, so the execution may still\n" +
      "settle. Resume rather than re-run." + RESUME(c),
  },
  FC_EVENT_MISSING: {
    stage: "EVENT_VERIFIED",
    title: "The receipt carries no Flightcheck event",
    broadcastPossible: true,
    remediation: () =>
      "The transaction succeeded but did not emit the log this run was built to prove. Something\n" +
      "other than the intended call executed. Not reported as success.",
  },
  FC_EVENT_WRONG_EMITTER: {
    stage: "EVENT_VERIFIED",
    title: "The event came from the wrong contract",
    broadcastPossible: true,
    remediation: (c) =>
      `Expected ${c.expected}, saw ${c.actual}. A matching signature from an unpinned address\n` +
      "proves nothing about the canary.",
  },
  FC_EVENT_CHALLENGE_MISMATCH: {
    stage: "EVENT_VERIFIED",
    title: "The challenge in the event is not the one generated",
    broadcastPossible: true,
    remediation: () =>
      "The per-run challenge exists so a stale or replayed transaction cannot satisfy this run.\n" +
      "It did not survive end to end, so the run is not verified.",
  },
  FC_EVENT_CHAINID_MISMATCH: {
    stage: "EVENT_VERIFIED",
    title: "The event reports a different chain",
    broadcastPossible: true,
    remediation: (c) => `Event says ${c.actual}, this run targets ${c.expected}.`,
  },
  FC_EVENT_SENDER_MISMATCH: {
    stage: "EVENT_VERIFIED",
    title: "The canary saw a caller other than the organisation wallet",
    broadcastPossible: true,
    remediation: (c) =>
      `Expected msg.sender ${c.expected}, saw ${c.actual}.\n` +
      "This assertion is only applied on the sponsored path, where it was measured. See\n" +
      "docs/how-verification-works.md.",
  },
  FC_HASH_DISAGREEMENT: {
    stage: "EVENT_VERIFIED",
    title: "KeeperHub and the public node disagree about the transaction",
    broadcastPossible: true,
    remediation: (c) =>
      `KeeperHub reported ${c.keeperhub}, verification followed ${c.independent}. The two proof\n` +
      "legs must resolve to one transaction or the result means nothing.",
  },
  FC_RESUME_NOT_FOUND: {
    stage: "START",
    title: "No stored run with that id",
    broadcastPossible: false,
    remediation: (c) =>
      `Nothing at .keeperhub/flightcheck/${c.runId ?? "<run-id>"}.json. List stored runs with\n` +
      "`npm run flightcheck -- status`.",
  },
  FC_RESUME_NOTHING_TO_REPLAY: {
    stage: "START",
    title: "That run never sent anything, so there is nothing to resume",
    broadcastPossible: false,
    remediation: (c) =>
      `Run ${c.runId ?? "<run-id>"} stopped before it persisted a request, which means no\n` +
      "broadcast was ever attempted and no transaction can exist for it. Start a fresh run:\n" +
      "  npm run flightcheck -- --execute",
  },
  FC_RESUME_WINDOW_EXPIRED: {
    stage: "START",
    title: "Too old to resume safely",
    broadcastPossible: true,
    remediation: () =>
      "KeeperHub replays a stored response for 24 hours. Past that the same key executes again\n" +
      "silently, so replaying this request could produce a second transaction. Flightcheck\n" +
      "refuses. Check the original run's transaction on the explorer, then start a new run.",
  },
};

export class FlightcheckError extends Error {
  readonly code: FailureCode;
  readonly stage: Stage;
  readonly broadcastPossible: boolean;
  readonly context: Record<string, string | number | undefined>;

  constructor(code: FailureCode, context: Record<string, string | number | undefined> = {}) {
    const spec = FAILURES[code];
    super(spec.title);
    this.name = "FlightcheckError";
    this.code = code;
    this.stage = spec.stage;
    this.broadcastPossible = spec.broadcastPossible;
    this.context = context;
  }

  get title(): string {
    return FAILURES[this.code].title;
  }

  get remediation(): string {
    return FAILURES[this.code].remediation(this.context);
  }
}
