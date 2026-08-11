/**
 * Chain access for the faucet.
 *
 * Signing uses viem rather than a hand-rolled secp256k1 implementation. The Flightcheck CLI
 * writes its own keccak because it only ever *hashes*; this service holds a key and signs with
 * it, and hand-rolling that would be reckless regardless of how well tested it is.
 *
 * The private key is read from the environment exactly once, inside this module, and never
 * returned, logged, stringified or attached to an error. Every function here throws bare codes.
 */

import { createWalletClient, createPublicClient, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { CHAIN_ID, RPC_URLS, RPC_TIMEOUT_MS, RECEIPT_TIMEOUT_MS } from "./config.ts";

export class ChainError extends Error {
  readonly code: "rpc_unavailable" | "send_failed";
  constructor(code: "rpc_unavailable" | "send_failed") {
    // Deliberately no detail. An upstream message could contain the signed payload.
    super(code);
    this.code = code;
    this.name = "ChainError";
  }
}

function publicClient(urlIndex: number) {
  const url = RPC_URLS[urlIndex] ?? RPC_URLS[0]!;
  return createPublicClient({
    chain: baseSepolia,
    transport: http(url, { timeout: RPC_TIMEOUT_MS, retryCount: 0 }),
  });
}

/** Try each configured RPC in turn. All failing is a closed failure, never an assumption. */
async function withRpc<T>(fn: (client: ReturnType<typeof publicClient>) => Promise<T>): Promise<T> {
  let lastFailed = false;
  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      return await fn(publicClient(i));
    } catch {
      lastFailed = true;
    }
  }
  if (lastFailed) throw new ChainError("rpc_unavailable");
  throw new ChainError("rpc_unavailable");
}

export async function getBalance(address: Hex): Promise<bigint> {
  return withRpc((c) => c.getBalance({ address }));
}

export async function assertChain(): Promise<void> {
  const id = await withRpc((c) => c.getChainId());
  if (id !== CHAIN_ID) throw new ChainError("rpc_unavailable");
}

export interface Treasury {
  readonly address: Hex;
  send(to: Hex, amountWei: bigint): Promise<Hex>;
}

/**
 * Build a treasury handle from the secret.
 *
 * The account object stays inside this closure. Callers get an address and a send function, so
 * there is no path by which a caller can serialise the key even by accident.
 */
export function treasuryFrom(privateKey: string): Treasury {
  const key = privateKey.trim();
  const normalised = (key.startsWith("0x") ? key : `0x${key}`) as Hex;
  const account = privateKeyToAccount(normalised);

  return {
    address: account.address,
    async send(to: Hex, amountWei: bigint): Promise<Hex> {
      for (let i = 0; i < RPC_URLS.length; i++) {
        try {
          const wallet = createWalletClient({
            account,
            chain: baseSepolia,
            transport: http(RPC_URLS[i]!, { timeout: RPC_TIMEOUT_MS, retryCount: 0 }),
          });
          return await wallet.sendTransaction({ to, value: amountWei });
        } catch {
          // Swallow deliberately: a viem error can carry the full request including the signed
          // transaction. Only the code escapes this module.
          if (i === RPC_URLS.length - 1) throw new ChainError("send_failed");
        }
      }
      throw new ChainError("send_failed");
    },
  };
}

/**
 * Wait for the receipt. A funded result is never reported on a hash alone, because an accepted
 * hash is not a mined transaction, and this service's only claim is that gas actually arrived.
 */
export async function waitForSuccess(hash: Hex): Promise<{ ok: boolean; blockNumber: bigint }> {
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const receipt = await withRpc((c) => c.getTransactionReceipt({ hash }));
      if (receipt) {
        return { ok: receipt.status === "success", blockNumber: receipt.blockNumber };
      }
    } catch {
      // Not mined yet, or a transient RPC failure. Both mean keep waiting.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new ChainError("send_failed");
}

export function ethToWei(eth: string): bigint {
  return parseEther(eth);
}

export function isAddress(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
