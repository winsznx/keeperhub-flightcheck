#!/usr/bin/env node
/**
 * Flightcheck CLI.
 *
 * Default is simulate-only. Broadcasting requires --execute, and even then the only thing that
 * can be called is the pinned canary with zero value on a testnet.
 */

import { loadEnv, REPO_ROOT } from "./env.ts";
import { FlightcheckError } from "./errors.ts";
import { runFlightcheck } from "./machine.ts";
import { buildCapsule, writeCapsule } from "./proof.ts";
import { RunStore } from "./runstore.ts";
import { BASE_SEPOLIA, TOOL_VERSION } from "./config.ts";
import { resolve } from "node:path";
import * as ui from "./ui.ts";
import { runBootstrap } from "./bootstrap.ts";
import { assertNoSecretInArgv } from "./secret-input.ts";
import { loadDotenv, registerEnvSecrets, REPO_ROOT as ROOT } from "./env.ts";
import { resolve as resolvePath } from "node:path";

/**
 * Keep evidence/manifest.json in step with the capsules on disk.
 *
 * The README points readers at the manifest as the summary of every verified run, so leaving it
 * to a separate command means the published summary silently omits the run the user just did.
 */
async function refreshManifest(): Promise<void> {
  try {
    await import("./manifest.ts");
  } catch {
    // Regenerating the summary is a convenience; failing it must not fail a verified run.
  }
}

interface Args {
  readonly execute: boolean;
  readonly resume?: string;
  readonly command: "run" | "setup" | "status" | "help" | "version";
  readonly assumeYes: boolean;
  readonly statusRunId?: string;
  readonly json: boolean;
}

const KNOWN_FLAGS = new Set(["--execute", "--resume", "--json", "--help", "-h", "--version", "-v", "--yes", "-y"]);

class UsageError extends Error {}

/**
 * Reject anything unrecognised rather than falling through to a preflight.
 *
 * Silently accepting `--exec` and running a no-op preflight is the worst available behaviour:
 * the user believes they broadcast, the exit code says success, and nothing happened.
 */
function parseArgs(argv: readonly string[]): Args {
  const args = argv.slice(2);
  // Before anything else. A credential on argv is already exposed to every process on the
  // machine, so the only useful response is to refuse and say so.
  assertNoSecretInArgv(args);
  const json = args.includes("--json");
  const assumeYes = args.includes("--yes") || args.includes("-y");
  if (args.includes("--help") || args.includes("-h")) {
    return { execute: false, command: "help", json, assumeYes };
  }
  if (args.includes("--version") || args.includes("-v")) {
    return { execute: false, command: "version", json, assumeYes };
  }
  if (args[0] === "setup") {
    const rest = args.slice(1).filter((a) => a.startsWith("-"));
    for (const a of rest) {
      if (!KNOWN_FLAGS.has(a)) throw new UsageError(`Unknown flag: ${a}`);
    }
    return { execute: args.includes("--execute"), command: "setup", json, assumeYes };
  }

  if (args[0] === "status") {
    const rest = args.slice(2).filter((a) => a !== "--json");
    if (rest.length) throw new UsageError(`Unexpected argument: ${rest[0]}`);
    return { execute: false, command: "status", statusRunId: args[1], json, assumeYes };
  }

  const resumeIdx = args.indexOf("--resume");
  let resume: string | undefined;
  if (resumeIdx >= 0) {
    resume = args[resumeIdx + 1];
    if (!resume || resume.startsWith("-")) {
      throw new UsageError(
        "--resume needs a run id.\n\n" +
          "  npm run flightcheck -- --resume <run-id>\n\n" +
          "List persisted runs with:\n\n  npm run flightcheck -- status",
      );
    }
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (resumeIdx >= 0 && i === resumeIdx + 1) continue;
    if (a.startsWith("-") && !KNOWN_FLAGS.has(a)) {
      const hint = a === "--exec" || a === "--execute=true" ? "\n\nDid you mean --execute?" : "";
      throw new UsageError(`Unknown flag: ${a}${hint}\n\nRun with --help to see every flag.`);
    }
    if (!a.startsWith("-") && !(resumeIdx >= 0 && i === resumeIdx + 1)) {
      throw new UsageError(`Unexpected argument: ${a}\n\nRun with --help to see every flag.`);
    }
  }

  return { execute: args.includes("--execute"), resume, command: "run", json, assumeYes };
}

const HELP = `
KeeperHub Flightcheck ${TOOL_VERSION}

  Proves that KeeperHub can execute, settle and verify a real transaction from this
  environment, and stops at the exact stage that fails if it cannot.

Usage
  npm run flightcheck -- setup --execute   guided first run, no .env needed
  npm run flightcheck                      preflight only, broadcasts nothing
  npm run flightcheck -- --execute         broadcast one zero-value call to the canary
  npm run flightcheck -- --resume <run-id> recover a run whose response was lost
  npm run flightcheck -- status [run-id]   inspect persisted runs

Flags
  --yes       skip the gas-fallback confirmation prompt
  --json      machine-readable result on stdout
  --version   print version and the pinned canary
  --help      this text

Credentials
  setup reads the KeeperHub organisation key from an interactive terminal. It is never
  echoed, never written to disk, and never sent anywhere except KeeperHub itself. Keys are
  not accepted on the command line. For CI, set KEEPERHUB_API_KEY in the environment.

Safety
  Simulate-only by default. Testnet only. Only the pinned canary contract, only a
  zero-value call, never arbitrary calldata. Resuming replays the persisted request with
  the same idempotency key, so an interrupted run cannot become a second transaction.

Canary
  ${BASE_SEPOLIA.address} on ${BASE_SEPOLIA.chainName} (${BASE_SEPOLIA.chainId})
`;

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    if (err instanceof UsageError) {
      ui.errOut("\n" + err.message + "\n");
      return 64;
    }
    throw err;
  }

  if (args.command === "help") {
    ui.out(HELP);
    return 0;
  }
  if (args.command === "version") {
    ui.out(`flightcheck ${TOOL_VERSION}`);
    ui.out(`canary      ${BASE_SEPOLIA.address}`);
    ui.out(`chain       ${BASE_SEPOLIA.chainName} (${BASE_SEPOLIA.chainId})`);
    ui.out(`bytecode    ${BASE_SEPOLIA.expectedRuntimeBytecodeHash}`);
    return 0;
  }

  if (args.command === "setup") {
    // Deliberately does not call loadEnv(), which throws when no key is configured. Bootstrap
    // exists precisely for the case where nothing is configured yet.
    loadDotenv();
    registerEnvSecrets();
    const outcome = await runBootstrap({
      execute: args.execute,
      chainId: Number(process.env.FLIGHTCHECK_CHAIN_ID ?? BASE_SEPOLIA.chainId),
      rpcUrl: (process.env.FLIGHTCHECK_RPC_URL ?? BASE_SEPOLIA.defaultRpcUrl).trim(),
      stateDir: resolvePath(ROOT, ".keeperhub", "flightcheck"),
      envKey: process.env.KEEPERHUB_API_KEY,
      assumeYes: args.assumeYes,
    });

    const r = outcome.result;
    if (r.outcome !== "simulated") {
      const capsule = buildCapsule(r, (process.env.FLIGHTCHECK_RPC_URL ?? BASE_SEPOLIA.defaultRpcUrl).trim());
      const proofsDir = resolvePath(ROOT, ".keeperhub", "flightcheck", "proofs");
      const targets =
        r.outcome === "verified" ? [proofsDir, resolvePath(ROOT, "evidence", "runs")] : [proofsDir];
      const written = writeCapsule(capsule, targets);
      if (r.outcome === "verified") {
        await refreshManifest();
        ui.verified({
          txHash: r.record.transactionHash!,
          txLink: r.deployment.explorerTxBase + r.record.transactionHash,
          executionId: r.record.executionId!,
          chainId: r.deployment.chainId,
          challenge: r.record.challenge,
          sender: r.event!.sender,
          sponsored: r.sponsored,
          blockNumber: parseInt(r.receipt!.blockNumber, 16),
          proofPaths: written,
          totalMs: Object.values(r.timings).reduce((a, b) => a + b, 0),
        });
        return 0;
      }
    }

    if (r.outcome === "simulated") {
      ui.simulated({
        gasEstimate: r.simulation?.gasEstimate ?? null,
        from: r.simulation?.from ?? null,
      });
      return 0;
    }
    if (r.outcome === "unconfirmed") {
      ui.unconfirmed({
        runId: r.record.runId,
        txHash: r.record.transactionHash,
        reason: r.error?.remediation ?? "The execution has not reached a terminal state.",
      });
      return 2;
    }
    const err = r.error!;
    ui.stageStopped(r.stageReached, err.stage);
    ui.failure({
      code: err.code,
      title: err.title,
      remediation: err.remediation,
      broadcastPossible: err.broadcastPossible,
    });
    return 1;
  }

  const env = loadEnv();

  if (args.command === "status") {
    const store = new RunStore(env.stateDir);
    if (args.statusRunId) {
      const record = store.load(args.statusRunId);
      ui.out(JSON.stringify(record, null, 2));
      return 0;
    }
    const runs = store.list();
    if (runs.length === 0) {
      ui.out("No persisted runs.");
      return 0;
    }
    ui.out();
    for (const r of runs) {
      ui.out(`  ${r.runId}`);
      ui.out(`    stage ${r.stageReached}  attempts ${r.attempts}  replayed ${r.replayed}`);
      ui.out(`    tx    ${r.transactionHash ?? "none observed"}`);
      ui.out(`    exec  ${r.executionId ?? "none observed"}`);
      ui.out();
    }
    return 0;
  }

  const mode = args.resume ? "resume" : args.execute ? "execute" : "simulate";
  if (!args.json) ui.header(mode);

  const result = await runFlightcheck({
    apiKey: env.apiKey,
    chainId: env.chainId,
    rpcUrl: env.rpcUrl,
    stateDir: env.stateDir,
    execute: args.execute,
    resumeRunId: args.resume,
    onStage: args.json ? undefined : (stage, detail) => ui.stageOk(stage, detail),
    onNote: args.json ? undefined : (n) => ui.note(n),
  });

  // A capsule is written whenever a broadcast was attempted, successful or not. A stopped run
  // is evidence too, and the failure code belongs in the record.
  let proofPaths: string[] = [];
  if (result.outcome !== "simulated") {
    const capsule = buildCapsule(result, env.rpcUrl);
    // The capsule goes beside the run record, never over it. They share a run id, and writing
    // the proof to the same filename destroyed the record needed to resume, which turned a
    // successful run into one that `status` reported as never having happened.
    const proofsDir = resolve(env.stateDir, "proofs");
    const targets =
      result.outcome === "verified"
        ? [proofsDir, resolve(REPO_ROOT, "evidence", "runs")]
        : [proofsDir];
    proofPaths = writeCapsule(capsule, targets);
    if (result.outcome === "verified") await refreshManifest();
    if (args.json) {
      process.stdout.write(JSON.stringify(capsule, null, 2) + "\n");
      return result.outcome === "verified" ? 0 : 1;
    }
  } else if (args.json) {
    // A preflight has no capsule, but --json must still carry everything the human output
    // showed, otherwise the machine-readable mode is strictly worse than reading the terminal.
    process.stdout.write(
      JSON.stringify(
        {
          schema: "keeperhub-flightcheck/preflight/v1",
          outcome: "simulated",
          runId: result.record.runId,
          stageReached: result.stageReached,
          broadcast: false,
          chain: {
            chainId: result.deployment.chainId,
            name: result.deployment.chainName,
            isTestnet: true,
          },
          wallet: { orgWallet: result.orgWallet, signerMode: "eoa" },
          canary: {
            address: result.deployment.address,
            expectedRuntimeBytecodeHash: result.deployment.expectedRuntimeBytecodeHash,
            observedRuntimeBytecodeHash: result.observedBytecodeHash,
            match:
              result.observedBytecodeHash?.toLowerCase() ===
              result.deployment.expectedRuntimeBytecodeHash.toLowerCase(),
          },
          challenge: result.record.challenge,
          simulation: result.simulation
            ? {
                passed: result.simulation.success === true,
                wouldRevert: result.simulation.wouldRevert ?? false,
                from: result.simulation.from ?? null,
                to: result.simulation.to ?? null,
                gasEstimate: result.simulation.gasEstimate ?? null,
              }
            : null,
          note: "Simulation proves the call would not revert. It does not prove the execution path can fund, broadcast, settle and verify. Re-run with --execute for that.",
          timingsMs: result.timings,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  switch (result.outcome) {
    case "simulated":
      ui.simulated({
        gasEstimate: result.simulation?.gasEstimate ?? null,
        from: result.simulation?.from ?? null,
      });
      return 0;

    case "verified":
      ui.verified({
        txHash: result.record.transactionHash!,
        txLink: result.deployment.explorerTxBase + result.record.transactionHash,
        executionId: result.record.executionId!,
        chainId: result.deployment.chainId,
        challenge: result.record.challenge,
        sender: result.event!.sender,
        sponsored: result.sponsored,
        blockNumber: parseInt(result.receipt!.blockNumber, 16),
        proofPaths,
        totalMs: Object.values(result.timings).reduce((a, b) => a + b, 0),
      });
      return 0;

    case "unconfirmed":
      ui.unconfirmed({
        runId: result.record.runId,
        txHash: result.record.transactionHash,
        reason: result.error?.remediation ?? "The execution has not reached a terminal state.",
      });
      return 2;

    case "stopped": {
      const err = result.error!;
      ui.stageStopped(result.stageReached, err.stage);
      ui.failure({
        code: err.code,
        title: err.title,
        remediation: err.remediation,
        broadcastPossible: err.broadcastPossible,
      });
      return 1;
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof FlightcheckError) {
      ui.failure({
        code: err.code,
        title: err.title,
        remediation: err.remediation,
        broadcastPossible: err.broadcastPossible,
      });
      process.exit(1);
    }
    // Never print a raw error object: it can carry request configuration including headers.
    ui.errOut("\nUnexpected error: " + (err instanceof Error ? err.message : String(err)));
    ui.errOut("This is a bug in Flightcheck. Nothing was assumed about onchain state.\n");
    process.exit(3);
  });
