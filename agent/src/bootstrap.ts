/**
 * Flightcheck Bootstrap.
 *
 * The first-run path. Takes someone with a KeeperHub account and no local configuration to a
 * verified onchain transaction, without asking them to create or edit a file.
 *
 * The order is deliberate and is the safety property: KeeperHub is always tried first, and gas is
 * only ever discussed after KeeperHub has said, conclusively and before any broadcast, that the
 * sender cannot pay. The canonical run landed a transaction from a wallet holding zero ETH
 * because the write was sponsored, so pre-funding on a zero balance would be answering a question
 * nobody asked.
 */

import { createInterface } from "node:readline/promises";
import { BASE_SEPOLIA, KEEPERHUB_BASE_URL } from "./config.ts";
import { FlightcheckError } from "./errors.ts";
import { acquireKeeperHubKey, hasInteractiveTty } from "./secret-input.ts";
import { classifyKey } from "./env.ts";
import { runFlightcheck, type RunResult } from "./machine.ts";
import { RunStore } from "./runstore.ts";
import { evaluateFaucetEligibility, faucetRequestId, mayStartNewLogicalRun } from "./gaspolicy.ts";
import { FaucetClient, describeFaucetResult, FAUCET_PAYOUT_WEI, type FaucetResult } from "./faucet-client.ts";
import { Rpc } from "./rpc.ts";
import * as ui from "./ui.ts";

export interface BootstrapOptions {
  readonly execute: boolean;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly stateDir: string;
  readonly envKey?: string;
  readonly assumeYes: boolean;
  readonly faucetBaseUrl?: string;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
}

export interface BootstrapOutcome {
  readonly result: RunResult;
  readonly keySource: "environment" | "interactive";
  readonly faucet: FaucetResult | null;
  readonly faucetDeclinedReason: string | null;
  readonly retriedAfterFunding: boolean;
}

const MIN_NODE_MAJOR = 22;

export async function runBootstrap(opts: BootstrapOptions): Promise<BootstrapOutcome> {
  const stdout = opts.stdout ?? process.stdout;

  ui.out();
  ui.out("Flightcheck Bootstrap");
  ui.out();

  // 1. Runtime. Native TypeScript execution is what removes the install step.
  const major = Number(process.versions.node.split(".")[0] ?? 0);
  if (major < MIN_NODE_MAJOR) {
    ui.out(`  ✗ Node ${process.versions.node} is too old, ${MIN_NODE_MAJOR}.18 or newer is needed`);
    throw new FlightcheckError("FC_ENV_MISSING_KEY");
  }
  ui.out(`  ✓ Node runtime supported  ${process.versions.node}`);

  // 2. Reachability, before asking for a credential. No point collecting a key to hit a wall.
  try {
    const res = await fetch(`${KEEPERHUB_BASE_URL}/api/chains`, { method: "GET" });
    if (!res.ok) throw new Error("unreachable");
    ui.out("  ✓ KeeperHub API reachable");
  } catch {
    ui.out("  ✗ KeeperHub API unreachable");
    throw new FlightcheckError("FC_AUTH_INVALID");
  }

  // 3. Credential. Environment for CI, otherwise a hidden prompt on a real TTY.
  const interactive = hasInteractiveTty(opts.stdin ?? process.stdin);
  const envClass = classifyKey(opts.envKey);

  if (envClass === "user") throw new FlightcheckError("FC_ENV_WRONG_KEY_TYPE");

  if (envClass === "absent") {
    ui.out();
    ui.out("  ! KeeperHub organisation credential required");
    ui.out();
    ui.out("    KeeperHub → Settings → API Keys → Organisation");
    ui.out();
    ui.out("    The key is read from this terminal directly. It is not echoed, not written to");
    ui.out("    .env, not stored in run state, and not included in any proof or faucet request.");
    ui.out("    It lives in this process only and disappears when it exits.");
    ui.out();
  }

  const { key, source } = await acquireKeeperHubKey({
    envValue: opts.envKey,
    interactive,
    stdin: opts.stdin,
    stdout,
  });

  const kind = classifyKey(key);
  if (kind === "user") throw new FlightcheckError("FC_ENV_WRONG_KEY_TYPE");
  if (kind !== "organisation") throw new FlightcheckError("FC_ENV_MALFORMED_KEY");

  ui.out(
    source === "environment"
      ? "  ✓ Organisation key read from the environment"
      : "  ✓ Organisation key accepted, held in memory only",
  );

  // 4. The existing state machine, unchanged. Bootstrap adds a path to it, not a variant of it.
  const runOpts: Parameters<typeof runFlightcheck>[0] = {
    apiKey: key,
    chainId: opts.chainId,
    rpcUrl: opts.rpcUrl,
    stateDir: opts.stateDir,
    execute: opts.execute,
    onStage: (stage, detail) => ui.stageOk(stage, detail),
    onNote: (n) => ui.note(n),
  };

  let result = await runFlightcheck(runOpts);

  // 5. Gas, only now, and only if KeeperHub actually said it could not pay.
  let faucet: FaucetResult | null = null;
  let declined: string | null = null;
  let retried = false;

  const rpc = new Rpc(opts.rpcUrl);
  let recipientBalance: bigint | null = null;
  if (result.orgWallet) {
    recipientBalance = await readBalance(rpc, result.orgWallet);
  }

  const decision = evaluateFaucetEligibility(result, {
    payoutWei: FAUCET_PAYOUT_WEI,
    recipientBalanceWei: recipientBalance,
  });

  if (result.outcome !== "verified" && result.outcome !== "simulated") {
    ui.out();
    ui.out("  Gas readiness");
    if (recipientBalance !== null) {
      ui.out(`    Organisation wallet balance: ${formatEth(recipientBalance)} ETH`);
    }
    ui.out(`    ${decision.eligible ? "Gas is the blocker." : decision.reason}`);
  }

  if (decision.eligible && opts.execute) {
    const proceed = opts.assumeYes
      ? true
      : await confirm(
          `\n  Request ${formatEth(FAUCET_PAYOUT_WEI)} Base Sepolia test ETH for ${decision.recipient}? [Y/n] `,
          opts,
        );

    if (!proceed) {
      declined = "The user declined the gas fallback.";
      ui.out("  Skipped. Fund the wallet from any Base Sepolia faucet and re-run.");
    } else {
      const client = new FaucetClient({ baseUrl: opts.faucetBaseUrl });
      const requestId = faucetRequestId(result.record.runId, decision.recipient);
      faucet = await client.request(decision.recipient, requestId);
      // Recorded against the run that needed the gas, so `support` can answer "did the faucet
      // fire, and what did it do" from disk alone. The retry below is a different logical run
      // and correctly reports no faucet involvement of its own.
      persistFaucetAttempt(opts.stateDir, result, faucet, requestId, decision.recipient);
      const described = describeFaucetResult(faucet);
      ui.out(`  ${described.proceed ? "✓" : "✗"} ${described.text}`);

      if (described.proceed) {
        // Confirm independently rather than trusting the faucet's own report.
        const after = await readBalance(rpc, decision.recipient);
        if (after !== null) ui.out(`  ✓ Balance confirmed independently: ${formatEth(after)} ETH`);

        /*
         * A new logical run, with a new idempotency key.
         *
         * Correct here and only here: the previous attempt stopped at a conclusively
         * pre-broadcast failure with no execution id and no transaction hash, so it is a
         * completed logical failure and there is no earlier transaction a new key could
         * duplicate. Any ambiguous failure would take the resume path instead.
         */
        if (mayStartNewLogicalRun(result)) {
          ui.out();
          ui.out("  Retrying with a new logical run, because the previous attempt provably never");
          ui.out("  broadcast. An ambiguous failure would resume the old run instead.");
          ui.out();
          retried = true;
          result = await runFlightcheck(runOpts);
        }
      }
    }
  } else if (!decision.eligible && result.outcome === "stopped") {
    declined = decision.reason;
  }

  return { result, keySource: source, faucet, faucetDeclinedReason: declined, retriedAfterFunding: retried };
}

/** Best effort. A failure to record what the faucet did must not change what the faucet did. */
function persistFaucetAttempt(
  stateDir: string,
  result: RunResult,
  faucet: FaucetResult,
  requestId: string,
  recipient: string,
): void {
  try {
    const store = new RunStore(stateDir);
    const record = store.exists(result.record.runId)
      ? store.load(result.record.runId)
      : result.record;
    record.faucet = {
      requestId,
      recipient,
      status: faucet.status,
      transactionHash: faucet.transactionHash ?? null,
      idempotentReplay: faucet.idempotentReplay === true,
      at: new Date().toISOString(),
    };
    store.save(record);
  } catch {
    // Diagnostics are not worth failing a funding step over.
  }
}

async function readBalance(rpc: Rpc, address: string): Promise<bigint | null> {
  try {
    return BigInt(await rpc.call<string>("eth_getBalance", [address, "latest"]));
  } catch {
    return null;
  }
}

async function confirm(question: string, opts: BootstrapOptions): Promise<boolean> {
  const stdin = opts.stdin ?? process.stdin;
  if (!hasInteractiveTty(stdin)) return false;
  const rl = createInterface({ input: stdin, output: opts.stdout ?? process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export function formatEth(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export const BOOTSTRAP_CHAIN = BASE_SEPOLIA;
