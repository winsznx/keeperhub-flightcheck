/**
 * The independent verification leg.
 *
 * This module never talks to KeeperHub. It asks a public Ethereum node the two questions that
 * make a Flightcheck result mean something: is the code at the canary address the code we
 * pinned, and did the transaction actually emit the log we expect.
 *
 * Decoding is done by hand against the raw log rather than with an ABI library. The event has
 * two indexed 32-byte topics and one uint256 in data, so the whole decoder is three slices, and
 * a tool that holds an API key is better off with no runtime dependencies at all.
 */

import { createHash } from "node:crypto";
import { FlightcheckError } from "./errors.ts";

export interface RpcLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

export interface RpcReceipt {
  readonly status: string;
  readonly blockNumber: string;
  readonly from: string;
  readonly to: string | null;
  readonly gasUsed: string;
  readonly logs: readonly RpcLog[];
  readonly transactionHash: string;
}

export interface DecodedFlightcheckEvent {
  readonly emitter: string;
  readonly topic0: string;
  readonly sender: string;
  readonly challenge: string;
  readonly chainId: number;
}

export class Rpc {
  readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(url: string, fetchImpl: typeof fetch = fetch) {
    this.url = url;
    this.fetchImpl = fetchImpl;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    } catch {
      throw new FlightcheckError("FC_RPC_UNREACHABLE", { rpc: this.url });
    }
    if (!res.ok) throw new FlightcheckError("FC_RPC_UNREACHABLE", { rpc: this.url });
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new FlightcheckError("FC_RPC_UNREACHABLE", { rpc: this.url });
    return body.result as T;
  }

  async chainId(): Promise<number> {
    return parseInt(await this.call<string>("eth_chainId", []), 16);
  }

  /** Assert the node is serving the chain this run targets before trusting anything it says. */
  async assertChain(expected: number): Promise<void> {
    const actual = await this.chainId();
    if (actual !== expected) {
      throw new FlightcheckError("FC_RPC_WRONG_CHAIN", { actual, expected });
    }
  }

  async getCode(address: string): Promise<string> {
    return this.call<string>("eth_getCode", [address, "latest"]);
  }

  async getReceipt(txHash: string): Promise<RpcReceipt | null> {
    return this.call<RpcReceipt | null>("eth_getTransactionReceipt", [txHash]);
  }

  /** Poll for a receipt. Returning null means unknown, which is never the same as failed. */
  async waitForReceipt(
    txHash: string,
    opts: { attempts?: number; intervalMs?: number; onAttempt?: (n: number) => void } = {},
  ): Promise<RpcReceipt | null> {
    const attempts = opts.attempts ?? 20;
    const intervalMs = opts.intervalMs ?? 2000;
    for (let i = 0; i < attempts; i++) {
      opts.onAttempt?.(i);
      const receipt = await this.getReceipt(txHash);
      if (receipt) return receipt;
      if (i < attempts - 1) await sleep(intervalMs);
    }
    return null;
  }
}

/** keccak256 of the runtime bytecode, matching what `cast keccak` and Solidity produce. */
export function hashRuntimeBytecode(code: string): string {
  return "0x" + keccak256(hexToBytes(code)).toString("hex");
}

export function isEmptyCode(code: string): boolean {
  return !code || code === "0x" || code === "0x0";
}

/**
 * Pull the Flightcheck event out of a receipt.
 *
 * Both the signature topic and the emitting address must match. Matching on signature alone
 * would let any contract that happens to emit the same shape satisfy the check, which is the
 * kind of hole that makes a verifier decorative.
 */
export function decodeFlightcheckEvent(
  receipt: RpcReceipt,
  expectedEmitter: string,
  topic0: string,
): DecodedFlightcheckEvent | null {
  const log = receipt.logs.find(
    (l) =>
      l.topics[0]?.toLowerCase() === topic0.toLowerCase() &&
      l.address.toLowerCase() === expectedEmitter.toLowerCase(),
  );
  if (!log || log.topics.length < 3) return null;
  return {
    emitter: log.address.toLowerCase(),
    topic0: log.topics[0]!.toLowerCase(),
    sender: ("0x" + log.topics[1]!.slice(26)).toLowerCase(),
    challenge: log.topics[2]!.toLowerCase(),
    chainId: parseInt(log.data, 16),
  };
}

/** A log with the right signature from the wrong address. Used to explain a mismatch precisely. */
export function findForeignFlightcheckLog(receipt: RpcReceipt, topic0: string): RpcLog | undefined {
  return receipt.logs.find((l) => l.topics[0]?.toLowerCase() === topic0.toLowerCase());
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hexToBytes(hex: string): Buffer {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Buffer.from(clean, "hex");
}

/*
 * keccak256, the original Keccak padding rather than the NIST SHA-3 variant.
 *
 * Node ships sha3-256, which is a different function and would produce a hash that never
 * matches the chain. Rather than add a dependency to a tool that handles an API key, this is
 * the reference permutation. It is exercised against known vectors and against the real
 * deployed canary in the test suite.
 */
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];
const MASK = (1n << 64n) - 1n;

function rotl(x: bigint, n: number): bigint {
  const s = BigInt(n % 64);
  return ((x << s) | (x >> (64n - s))) & MASK;
}

function keccakF(state: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    const c = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) {
      c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    }
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 25; y += 5) state[x + y] = state[x + y]! ^ d;
    }
    const b = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y]!, ROT[x + 5 * y]!);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y] = b[x + 5 * y]! ^ (~b[((x + 1) % 5) + 5 * y]! & b[((x + 2) % 5) + 5 * y]!) & MASK;
      }
    }
    state[0] = state[0]! ^ RC[round]!;
  }
}

export function keccak256(input: Buffer): Buffer {
  const rate = 136;
  const padded = Buffer.alloc(Math.ceil((input.length + 1) / rate) * rate);
  input.copy(padded);
  padded[input.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) | 0x80;

  const state = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      state[i] = state[i]! ^ padded.readBigUInt64LE(offset + i * 8);
    }
    keccakF(state);
  }

  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(state[i]!, i * 8);
  return out;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
