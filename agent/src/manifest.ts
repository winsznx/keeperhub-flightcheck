/**
 * Generates the evidence manifest and the failure-code reference.
 *
 * Both are derived rather than hand-written. The manifest is the single source the proof site
 * reads, so a metric can never be true in one place and stale in another, and the failure
 * reference is generated from the taxonomy so it cannot drift from the code that produces it.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./env.ts";
import { BASE_SEPOLIA, TOOL_VERSION, PROOF_SCHEMA } from "./config.ts";
import { FAILURES, type FailureCode } from "./errors.ts";
import { STAGES, STAGE_LABEL, INDEPENDENT_STAGES } from "./stages.ts";

interface CapsuleLike {
  runId: string;
  outcome: string;
  createdAt: string;
  completedAt: string;
  challenge: string;
  transaction: { hash: string; link: string } | null;
  simulation: Record<string, unknown> | null;
  idempotency: { replayed?: boolean } | null;
  execution: { id: string; sponsored: boolean | null; normalizedState: string } | null;
  keeperhubReceipt: { blockNumber: number; gasUsed: string } | null;
  independentVerification: Record<string, unknown> | null;
  agreement: Record<string, boolean>;
  timingsMs: Record<string, number>;
  canary: Record<string, unknown>;
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function main(): void {
  const runsDir = resolve(REPO_ROOT, "evidence", "runs");
  const capsules: CapsuleLike[] = existsSync(runsDir)
    ? readdirSync(runsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => readJson<CapsuleLike>(resolve(runsDir, f)))
        .filter((c): c is CapsuleLike => c !== null)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    : [];

  const verified = capsules.filter((c) => c.outcome === "verified");
  const canonical = verified[0] ?? null;

  const recovery = readJson<Record<string, unknown>>(
    resolve(REPO_ROOT, "evidence", "recovery", "fault-injection.json"),
  );
  const build = readJson<Record<string, unknown>>(resolve(REPO_ROOT, "evidence", "canary-build.json"));
  const benchmark = readJson<Record<string, unknown>>(
    resolve(REPO_ROOT, "evidence", "benchmark", "benchmark.json"),
  );

  /*
   * Only count runs that actually did the whole thing.
   *
   * A resumed run skips simulation and re-reads a transaction that is already mined, so its
   * total is not an end-to-end figure. An audit found a 5.6s "fastest run" that was a replay
   * sitting next to genuine cold runs.
   */
  const endToEnd = verified.filter(
    (c) => c.idempotency?.replayed !== true && c.simulation !== null,
  );
  const durations = endToEnd
    .map((c) => c.timingsMs?.total)
    .filter((n): n is number => typeof n === "number" && n > 0);

  const manifest = {
    schema: "keeperhub-flightcheck/manifest/v1",
    generatedAt: new Date().toISOString(),
    toolVersion: TOOL_VERSION,
    proofSchema: PROOF_SCHEMA,

    canary: {
      address: BASE_SEPOLIA.address,
      chainId: BASE_SEPOLIA.chainId,
      chainName: BASE_SEPOLIA.chainName,
      abiVersion: BASE_SEPOLIA.abiVersion,
      expectedRuntimeBytecodeHash: BASE_SEPOLIA.expectedRuntimeBytecodeHash,
      eventSignature: BASE_SEPOLIA.eventSignature,
      eventTopic0: BASE_SEPOLIA.eventTopic0,
      explorer: `https://sepolia.basescan.org/address/${BASE_SEPOLIA.address.toLowerCase()}`,
      sourceVerified: (build?.deployment as Record<string, unknown> | undefined)?.sourceVerified ?? null,
      deployTxHash: (build?.deployment as Record<string, unknown> | undefined)?.txHash ?? null,
      runtimeBytecodeBytes: build?.runtimeBytecodeBytes ?? null,
      reproducibleBuild: (build?.reproducible as Record<string, unknown> | undefined)?.verified ?? null,
    },

    canonicalRun: canonical
      ? {
          runId: canonical.runId,
          transactionHash: canonical.transaction?.hash ?? null,
          transactionLink: canonical.transaction?.link ?? null,
          executionId: canonical.execution?.id ?? null,
          blockNumber: canonical.keeperhubReceipt?.blockNumber ?? null,
          gasUsed: canonical.keeperhubReceipt?.gasUsed ?? null,
          challenge: canonical.challenge,
          sponsored: canonical.execution?.sponsored ?? null,
          eventSender:
            ((canonical.independentVerification?.event as Record<string, unknown> | undefined)
              ?.sender as string) ?? null,
          transactionFrom: (canonical.independentVerification?.transactionFrom as string) ?? null,
          transactionTo: (canonical.independentVerification?.transactionTo as string) ?? null,
          senderAssertion: (canonical.independentVerification?.senderAssertion as string) ?? null,
          agreement: canonical.agreement,
          totalMs: canonical.timingsMs?.total ?? null,
          completedAt: canonical.completedAt,
        }
      : null,

    runs: {
      total: capsules.length,
      verified: verified.length,
      endToEndRuns: endToEnd.length,
      fastestEndToEndMs: durations.length ? Math.min(...durations) : null,
      slowestEndToEndMs: durations.length ? Math.max(...durations) : null,
      timingNote:
        "Timings cover cold end-to-end runs only. Resumed runs are excluded: they skip simulation and re-read an already-mined transaction, so their totals are not comparable.",
      all: verified.map((c) => ({
        runId: c.runId,
        transactionHash: c.transaction?.hash ?? null,
        executionId: c.execution?.id ?? null,
        totalMs: c.timingsMs?.total ?? null,
        completedAt: c.completedAt,
      })),
    },

    recovery: recovery
      ? {
          scenario: recovery.scenario,
          pass: recovery.pass,
          broadcastRequestsSent:
            (recovery.firstInvocation as Record<string, unknown> | undefined)?.broadcastRequestsSent ?? null,
          transactionsOnchain:
            (recovery.onchainProof as Record<string, unknown> | undefined)?.matchingLogCount ?? null,
          idempotentReplay:
            (recovery.recovery as Record<string, unknown> | undefined)?.idempotentReplay ?? null,
          transactionHash:
            (recovery.recovery as Record<string, unknown> | undefined)?.transactionHash ?? null,
          method: (recovery.onchainProof as Record<string, unknown> | undefined)?.method ?? null,
        }
      : null,

    benchmark: benchmark ?? null,

    bootstrap: {
      command: "npm run flightcheck -- setup --execute",
      requiresEnvFile: false,
      credentialSource: "hidden interactive TTY prompt, or KEEPERHUB_API_KEY for CI",
      credentialPersisted: false,
      credentialAcceptedOnArgv: false,
      failsClosedWithoutTty: true,
      gasPolicy: "KeeperHub first. A zero balance never triggers funding on its own.",
    },

    faucet: readJson<Record<string, unknown>>(
      resolve(REPO_ROOT, "evidence", "faucet", "live-acceptance.json"),
    ),

    stateMachine: STAGES.map((s) => ({
      stage: s,
      label: STAGE_LABEL[s],
      independentOfKeeperHub: INDEPENDENT_STAGES.has(s),
    })),

    failureCodes: Object.keys(FAILURES).length,

    tests: readTestTotals(),
  };

  writeFileSync(
    resolve(REPO_ROOT, "evidence", "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  writeFileSync(resolve(REPO_ROOT, "docs", "failure-codes.md"), renderFailureDoc());

  process.stdout.write(
    `manifest: ${verified.length} verified run(s), canonical ${manifest.canonicalRun?.transactionHash ?? "none"}\n` +
      `failure reference: ${Object.keys(FAILURES).length} codes\n`,
  );
}

/** Read the recorded test totals if a run has been captured, rather than asserting a number. */
function readTestTotals(): Record<string, unknown> | null {
  const path = resolve(REPO_ROOT, "evidence", "test-run.json");
  const data = readJson<Record<string, unknown>>(path);
  if (!data) return null;
  return { ...data, capturedFrom: "npm test", file: "evidence/test-run.json" };
}

function renderFailureDoc(): string {
  const byStage = new Map<string, FailureCode[]>();
  for (const code of Object.keys(FAILURES) as FailureCode[]) {
    const stage = FAILURES[code].stage;
    byStage.set(stage, [...(byStage.get(stage) ?? []), code]);
  }

  const lines: string[] = [
    "# Failure codes",
    "",
    "Generated from `agent/src/errors.ts` by `npm run evidence`. Do not edit by hand.",
    "",
    "Every way a Flightcheck run can stop, the stage it stops at, and whether a transaction may",
    "already exist when it does.",
    "",
    "`broadcast possible` is the column that matters. When it is yes, the correct response is to",
    "resume the same run rather than start a new one, because a new run derives a new idempotency",
    "key and a new key is what creates a second transaction.",
    "",
  ];

  for (const stage of STAGES) {
    const codes = byStage.get(stage);
    if (!codes?.length) continue;
    lines.push(`## ${stage}`, "", `${STAGE_LABEL[stage]}.`, "");
    lines.push("| code | means | broadcast possible |", "|---|---|---|");
    for (const code of codes) {
      lines.push(`| \`${code}\` | ${FAILURES[code].title} | ${FAILURES[code].broadcastPossible ? "**yes**" : "no"} |`);
    }
    lines.push("");
    for (const code of codes) {
      const remediation = FAILURES[code]
        .remediation({ runId: "<run-id>", chainId: 84532, address: BASE_SEPOLIA.address })
        .split("\n")
        .map((l) => "> " + l)
        .join("\n");
      lines.push(`### \`${code}\``, "", `**${FAILURES[code].title}**`, "", remediation, "");
    }
  }

  lines.push(
    "## Exit codes",
    "",
    "| code | meaning |",
    "|---|---|",
    "| 0 | verified, or a preflight that passed without broadcasting |",
    "| 1 | stopped at a stage, with a diagnosis |",
    "| 2 | unconfirmed, which is neither success nor failure |",
    "| 3 | an unexpected error, which is a bug in Flightcheck |",
    "",
  );
  return lines.join("\n");
}

main();
