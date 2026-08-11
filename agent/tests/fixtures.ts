/**
 * Response shapes captured from the live KeeperHub API and Base Sepolia during real runs.
 *
 * These are fixtures for parser and state-machine tests. They are not live reproductions, and
 * nothing that uses them may be described as one. Their value is that they are real shapes
 * rather than invented ones: every field name, casing and quirk below was observed, including
 * the ones that contradict the published reference.
 */

export const REAL_STATUS_COMPLETED = {
  executionId: "exnn6k0y1ojnnvb8sa1fu",
  status: "completed",
  type: "contract-call",
  transactionHash: "0xb4098917d12030a249e9376217d765b715362c744dd23e9b03e0213253d452dc",
  transactionLink:
    "https://sepolia.basescan.org/tx/0xb4098917d12030a249e9376217d765b715362c744dd23e9b03e0213253d452dc",
  sponsored: true,
  receipts: [
    {
      hash: "0xb4098917d12030a249e9376217d765b715362c744dd23e9b03e0213253d452dc",
      chainId: 84532,
      gasUsed: "85465",
      verified: true,
      verifiedAt: "2026-08-11T11:34:42.858Z",
      blockNumber: 45339897,
      receiptStatus: "success",
    },
  ],
  // Observed: the field is named for wei but carries gas units, byte-equal to receipts[0].gasUsed.
  gasUsedWei: "85465",
  gasPriceWei: "6000000",
  estimatedCostUsd: null,
  retryCount: 0,
  network: "84532",
  error: null,
  createdAt: "2026-08-11T11:34:40.079Z",
  completedAt: "2026-08-11T11:34:42.919Z",
} as const;

/**
 * The broadcast response for /contract-call.
 *
 * Status is already `completed` and there is no transactionHash. The endpoint reference shows
 * all four fields on a 202 for /transfer; /contract-call returns two. A client that reads the
 * hash here gets undefined at the moment it believes it succeeded.
 */
export const REAL_BROADCAST_202 = {
  executionId: "exnn6k0y1ojnnvb8sa1fu",
  status: "completed",
} as const;

export const REAL_SIMULATION_OK = {
  success: true,
  status: "simulated",
  from: "0xfd35ae935de7be93ffd585d6627268d833ed834c",
  to: "0x2A6FC8182Bf9928Ef7517dA980dC79e8107c555A",
  value: "0",
  gasEstimate: "23929",
  simulatedReturnValue: null,
  wouldRevert: false,
} as const;

/** Documented shape: a would-revert simulation answers with HTTP 400 and this body. */
export const DOC_SIMULATION_REVERT = {
  success: false,
  status: "simulated",
  from: "0xfd35ae935de7be93ffd585d6627268d833ed834c",
  to: "0x2A6FC8182Bf9928Ef7517dA980dC79e8107c555A",
  value: "0",
  wouldRevert: true,
  revertReason: "Error(ERC20: transfer amount exceeds balance)",
  error: "Error(ERC20: transfer amount exceeds balance)",
} as const;

export const DOC_SIMULATION_UNDERFUNDED = {
  success: false,
  status: "simulated",
  from: "0xfd35ae935de7be93ffd585d6627268d833ed834c",
  to: "0x2A6FC8182Bf9928Ef7517dA980dC79e8107c555A",
  value: "1000000000000000000",
  wouldRevert: true,
  revertReason:
    "Insufficient ETH balance. Have: 0.25, Need: 1.0. Fund 0xfd35... with at least 0.75 ETH on this chain and retry.",
  error: "Insufficient ETH balance.",
  code: "insufficient_balance",
  balanceWei: "250000000000000000",
  requiredWei: "1000000000000000000",
  shortfallWei: "750000000000000000",
  nativeSymbol: "ETH",
} as const;

/** Documented but absent from the endpoint reference's Status Values list. */
export const DOC_STATUS_UNCONFIRMED = {
  executionId: "direct_unconfirmed",
  status: "unconfirmed",
  type: "contract-call",
  transactionHash: "0x" + "ab".repeat(32),
  sponsored: false,
  receipts: [
    {
      hash: "0x" + "ab".repeat(32),
      chainId: 84532,
      verified: false,
      receiptStatus: "not_found",
    },
  ],
  error: null,
} as const;

/** A failed execution whose receipts are merely inconclusive. Downgrades to UNCONFIRMED. */
export const DOC_STATUS_FAILED_TIMEOUT = {
  executionId: "direct_timeout",
  status: "failed",
  receipts: [
    { hash: "0x" + "cd".repeat(32), chainId: 84532, verified: false, receiptStatus: "timeout" },
  ],
  error: null,
} as const;

/** A genuinely failed execution: the transaction landed and reverted. */
export const DOC_STATUS_FAILED_REVERTED = {
  executionId: "direct_reverted",
  status: "failed",
  receipts: [
    { hash: "0x" + "ef".repeat(32), chainId: 84532, verified: true, receiptStatus: "reverted" },
  ],
  error: "execution reverted",
} as const;

export const IDEMPOTENCY_CONFLICT = {
  error: "idempotency_conflict",
  code: "idempotency_conflict",
  originalExecutionId: "exnn6k0y1ojnnvb8sa1fu",
} as const;

export const IDEMPOTENCY_CONFLICT_NULL_ORIGINAL = {
  error: "idempotency_conflict",
  code: "idempotency_conflict",
  originalExecutionId: null,
} as const;

export const IDEMPOTENCY_IN_PROGRESS = {
  error: "idempotency_in_progress",
  code: "idempotency_in_progress",
} as const;

export const REPLAYED_RESPONSE = {
  executionId: "exnn6k0y1ojnnvb8sa1fu",
  status: "completed",
  idempotentReplay: true,
} as const;

export const INSUFFICIENT_SCOPE = {
  error: "insufficient_scope",
  message: "This endpoint requires the `mcp:write` OAuth scope. The current token has `mcp:read`.",
  required_scope: "mcp:write",
  granted_scope: "mcp:read",
} as const;

/** Observed: a 401 carries no detail and no request id, while a 404 carries both. */
export const UNAUTHORIZED = { error: "Unauthorized" } as const;
export const NOT_FOUND = {
  error: "not_found",
  detail: "Route GET /api/executions not found",
  request_id: "759d7d0c-f5f6-4960-88bd-0c3907a0d3bb",
} as const;

export const CANARY = "0x2A6FC8182Bf9928Ef7517dA980dC79e8107c555A";
export const TOPIC0 = "0x4947ef22330e8e81cdedf82c33d366e9c942511f5edf79140686b33af9de7f33";
export const ORG_WALLET = "0xfd35ae935de7be93ffd585d6627268d833ed834c";

/** A real receipt from the Phase 1 transaction, trimmed to what the verifier reads. */
export function realReceipt(overrides: Record<string, unknown> = {}) {
  return {
    transactionHash: "0xb4098917d12030a249e9376217d765b715362c744dd23e9b03e0213253d452dc",
    status: "0x1",
    blockNumber: "0x2b3ae79",
    // The relayer paid, not the org wallet. The top-level callee is a router, not the canary.
    from: "0xdcf4bac4bd805948168ff63483bc493894a29613",
    to: "0x5af5194b4b0909eb978e3cf1e25333852277f07d",
    gasUsed: "0x14dd9",
    logs: [
      {
        address: CANARY,
        topics: [
          TOPIC0,
          "0x000000000000000000000000" + ORG_WALLET.slice(2),
          "0x61b3cc48dd907bdfff36b62bf6b7faddc5adcaede477797ca0a035114a3fb4e2",
        ],
        data: "0x0000000000000000000000000000000000000000000000000000000000014a34",
      },
    ],
    ...overrides,
  };
}
