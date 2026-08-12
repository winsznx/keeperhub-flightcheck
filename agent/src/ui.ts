/**
 * Terminal output.
 *
 * Every write goes through the redactor. That is belt and braces given the capsule is already
 * built from an explicit field list, but console output is where a stray error object or a
 * debug line would leak a key, so the scrub happens at the boundary rather than at each call.
 */

import { scrub } from "./redact.ts";
import { STAGE_LABEL, STAGES, INDEPENDENT_STAGES, stageIndex, type Stage } from "./stages.ts";

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

const c = {
  dim: (s: string) => (useColor ? `[2m${s}[0m` : s),
  bold: (s: string) => (useColor ? `[1m${s}[0m` : s),
  green: (s: string) => (useColor ? `[32m${s}[0m` : s),
  red: (s: string) => (useColor ? `[31m${s}[0m` : s),
  yellow: (s: string) => (useColor ? `[33m${s}[0m` : s),
  cyan: (s: string) => (useColor ? `[36m${s}[0m` : s),
};

export function out(line = ""): void {
  process.stdout.write(scrub(line) + "\n");
}

export function errOut(line = ""): void {
  process.stderr.write(scrub(line) + "\n");
}

export function header(mode: "simulate" | "execute" | "resume"): void {
  out();
  out(c.bold("KeeperHub Flightcheck"));
  const subtitle =
    mode === "simulate"
      ? "preflight only, nothing will be broadcast"
      : mode === "resume"
        ? "resuming a persisted run, replaying the same idempotency key"
        : "will broadcast one zero-value call to the pinned canary";
  out(c.dim(subtitle));
  out();
}

export function stageOk(stage: Stage, detail?: string): void {
  const independent = INDEPENDENT_STAGES.has(stage);
  const label = STAGE_LABEL[stage];
  const suffix = detail ? c.dim("  " + detail) : "";
  const marker = independent ? c.cyan("✓") : c.green("✓");
  out(`  ${marker} ${label}${suffix}`);
}

export function note(text: string): void {
  out();
  for (const line of wrap(text, 76)) out(c.yellow("  ! ") + line);
  out();
}

/** Show which stages never ran, so a stop reads as a position in a sequence. */
export function stageStopped(reached: Stage, failedAt: Stage): void {
  const failedIdx = stageIndex(failedAt);
  const reachedIdx = stageIndex(reached);
  const idx = Math.max(failedIdx, reachedIdx === failedIdx ? failedIdx : reachedIdx + 1);
  out(`  ${c.red("✗")} ${STAGE_LABEL[STAGES[idx] ?? failedAt]}`);
  for (const s of STAGES.slice(idx + 1)) {
    out(c.dim(`    · ${STAGE_LABEL[s]}`));
  }
}

export function failure(opts: {
  code: string;
  title: string;
  remediation: string;
  broadcastPossible: boolean;
}): void {
  out();
  out(c.red(c.bold(opts.title)));
  out(c.dim(opts.code));
  out();
  for (const line of opts.remediation.split("\n")) out("  " + line);
  if (opts.broadcastPossible) {
    out();
    out(
      c.yellow(
        "  A transaction may already exist. Resume this run rather than starting a new one:\n" +
          "  a new run means a new idempotency key, which is what creates a second transaction.",
      ),
    );
  }
  out();
}

export function verified(opts: {
  txHash: string;
  txLink: string;
  executionId: string;
  chainId: number;
  challenge: string;
  sender: string;
  sponsored: boolean | null;
  blockNumber: number;
  proofPaths: readonly string[];
  totalMs: number;
}): void {
  out();
  out(c.green(c.bold("  Verified. KeeperHub executed onchain from this environment.")));
  out();
  out(`  execution   ${opts.executionId}`);
  out(`  transaction ${opts.txHash}`);
  out(`  block       ${opts.blockNumber} on chain ${opts.chainId}`);
  out(`  challenge   ${opts.challenge}`);
  out(`  msg.sender  ${opts.sender}`);
  if (opts.sponsored !== null) {
    out(`  sponsored   ${opts.sponsored}`);
  }
  out();
  out(c.dim("  Three independent legs agreed:"));
  out(c.dim("    KeeperHub reported the execution completed and verified its own receipt"));
  out(c.dim("    A public Base Sepolia node returned a successful receipt for that hash"));
  out(c.dim("    The decoded Flightcheck event carries this run's challenge and chain id"));
  out();
  out(`  ${opts.txLink}`);
  for (const p of opts.proofPaths) out(c.dim(`  proof ${p}`));
  out(c.dim(`  ${(opts.totalMs / 1000).toFixed(1)}s total`));
  out();
}

export function simulated(opts: { gasEstimate: string | null; from: string | null }): void {
  out();
  out(c.bold("  Preflight passed. Nothing was broadcast."));
  out();
  if (opts.from) out(`  execution wallet ${opts.from}`);
  if (opts.gasEstimate) out(`  gas estimate     ${opts.gasEstimate}`);
  out();
  out("  Re-run with --execute to broadcast the test transaction:");
  out(c.cyan("    npm run flightcheck -- --execute"));
  out();
  out(
    c.dim(
      "  Simulation proves the call would not revert. It does not prove the execution path can\n" +
        "  fund, broadcast, settle and verify. That is what --execute measures.",
    ),
  );
  out();
}

export function unconfirmed(opts: { runId: string; txHash: string | null; reason: string }): void {
  out();
  out(c.yellow(c.bold("  Unconfirmed. This is not a failure.")));
  out();
  out("  " + opts.reason);
  if (opts.txHash) out(`\n  transaction ${opts.txHash}`);
  out();
  out("  Resume the same run rather than starting a new one:");
  out(c.cyan(`    npm run flightcheck -- --resume ${opts.runId}`));
  out();
}

export function support(opts: {
  path: string;
  executionId: string | null;
  stageReached: string;
  failureCode: string | null;
  requestIds: ReadonlyArray<{ stage: string; ids: readonly string[] }>;
  transactionHash: string | null;
}): void {
  out();
  out(c.bold("  Support capsule written"));
  out(`  ${opts.path}`);
  out();
  out(c.green("  Safe to attach to a KeeperHub support ticket."));
  out();
  out(c.dim("  Execution"));
  out(`    ${opts.executionId ?? "none observed"}`);
  out();
  out(c.dim("  Last confirmed stage"));
  out(`    ${opts.stageReached}`);
  if (opts.failureCode) {
    out();
    out(c.dim("  Stopped with"));
    out(`    ${opts.failureCode}`);
  }
  if (opts.transactionHash) {
    out();
    out(c.dim("  Transaction"));
    out(`    ${opts.transactionHash}`);
  }
  out();
  out(c.dim("  KeeperHub request IDs"));
  if (opts.requestIds.length) {
    const width = Math.max(...opts.requestIds.map((g) => g.stage.length));
    for (const group of opts.requestIds) {
      // Retries share an operation, so every id is listed rather than only the first. Which
      // attempt failed is usually the question.
      for (const [i, id] of group.ids.entries()) {
        out(`    ${(i === 0 ? group.stage : "").padEnd(width)}  ${id}`);
      }
    }
  } else {
    out(c.dim("    none recorded, so this run either made no KeeperHub request or predates"));
    out(c.dim("    request correlation. Re-run to get ids a maintainer can look up."));
  }
  out();
  out(c.dim("  Secrets included"));
  out("    none");
  out();
  out(
    c.dim(
      "  Nothing was uploaded. There is no telemetry in this tool and no submission endpoint.\n" +
        "  Attach the file yourself, or don't.",
    ),
  );
  out();
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const word of paragraph.split(" ")) {
      if ((current + " " + word).trim().length > width) {
        lines.push(current.trim());
        current = word;
      } else {
        current += " " + word;
      }
    }
    if (current.trim()) lines.push(current.trim());
  }
  return lines;
}
