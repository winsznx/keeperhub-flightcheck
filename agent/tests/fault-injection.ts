/**
 * The acceptance test: lose the broadcast response, recover, prove exactly one transaction.
 *
 * This is not a mock. KeeperHub really receives the request, really executes it, and really
 * puts a transaction on Base Sepolia. What is injected is a client-side failure: the transport
 * performs the real HTTP call, reads and discards the real response, then throws. That models
 * the case the whole design exists for, a process that never learns the outcome of work it
 * already caused.
 *
 * The immediate in-process replay is failed too, so the run genuinely ends with nothing on hand
 * but the persisted record. Recovery then happens in a second, independent invocation.
 *
 * "Exactly one transaction" is proved from the chain, not from our own bookkeeping: the
 * challenge is unique to this run and is an indexed event topic, so counting logs for that
 * topic counts the transactions that executed it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv, REPO_ROOT } from "../src/env.ts";
import { runFlightcheck } from "../src/machine.ts";
import { buildCapsule } from "../src/proof.ts";
import { BASE_SEPOLIA } from "../src/config.ts";
import { Rpc } from "../src/rpc.ts";
import type { Transport } from "../src/keeperhub.ts";

const log: string[] = [];
function say(line = ""): void {
  log.push(line);
  process.stdout.write(line + "\n");
}

/**
 * Perform the real request, then destroy the client's knowledge of it.
 *
 * `failuresRemaining` covers the broadcast and the immediate in-process replay, so the process
 * exits without an execution id and recovery has to come from the persisted record.
 */
function lossyTransport(state: { broadcastsSeen: number; failuresRemaining: number }): Transport {
  return async (url, init) => {
    const isBroadcast =
      init.method === "POST" &&
      typeof url === "string" &&
      url.includes("/api/execute/contract-call") &&
      !String(init.body ?? "").includes('"simulate":true');

    const res = await fetch(url, init);

    if (isBroadcast) {
      state.broadcastsSeen += 1;
      // Drain the body so the server-side work is definitely complete before we drop it.
      await res.clone().text();
      if (state.failuresRemaining > 0) {
        state.failuresRemaining -= 1;
        say(
          `      [fault] broadcast #${state.broadcastsSeen} reached KeeperHub and was answered. ` +
            `Discarding the response and failing the client.`,
        );
        throw new Error("simulated connectivity loss after the server accepted the request");
      }
    }
    return res;
  };
}

async function main(): Promise<number> {
  const env = loadEnv();
  const rpc = new Rpc(env.rpcUrl);
  const started = new Date().toISOString();
  const baselineBlock = Math.max(0, (await currentBlock(rpc)) - 5);

  say();
  say("FAULT INJECTION: post-submit response loss");
  say("=".repeat(72));
  say();
  say("Phase A. Broadcast for real, then lose the response.");
  say();

  const state = { broadcastsSeen: 0, failuresRemaining: 2 };
  const first = await runFlightcheck({
    apiKey: env.apiKey,
    chainId: env.chainId,
    rpcUrl: env.rpcUrl,
    stateDir: env.stateDir,
    execute: true,
    transport: lossyTransport(state),
    onStage: (s, d) => say(`      ${s}${d ? "  " + d : ""}`),
    onNote: (n) => say(`      [note] ${n.split("\n")[0]}`),
  });

  const runId = first.record.runId;
  say();
  say(`  run id            ${runId}`);
  say(`  outcome           ${first.outcome}`);
  say(`  failure code      ${first.error?.code ?? "none"}`);
  say(`  execution id seen ${first.record.executionId ?? "NONE"}`);
  say(`  tx hash seen      ${first.record.transactionHash ?? "NONE"}`);
  say(`  challenge         ${first.record.challenge}`);
  say(`  idempotency key   ${first.record.idempotencyKey.slice(0, 24)}…`);
  say(`  broadcasts sent   ${state.broadcastsSeen}`);
  say();

  if (first.outcome !== "stopped") {
    say("  UNEXPECTED: the run did not stop. The fault did not take effect.");
    return 1;
  }

  // What the chain already knows, before recovery. The transaction exists; we just cannot see it.
  const preLogs = await countChallengeLogs(rpc, first.record.challenge, baselineBlock);
  say(`  logs onchain for this challenge, before recovery: ${preLogs.count}`);
  say();
  say("  The client has no execution id and no transaction hash. There is no");
  say("  list-executions endpoint to search. The only route back to this work is the");
  say("  idempotency key that was persisted before the request was sent.");
  say();

  say("Phase B. Resume the same run.");
  say();

  const second = await runFlightcheck({
    apiKey: env.apiKey,
    chainId: env.chainId,
    rpcUrl: env.rpcUrl,
    stateDir: env.stateDir,
    execute: true,
    resumeRunId: runId,
    onStage: (s, d) => say(`      ${s}${d ? "  " + d : ""}`),
    onNote: (n) => say(`      [note] ${n.split("\n")[0]}`),
  });

  say();
  say(`  outcome           ${second.outcome}`);
  say(`  replayed          ${second.record.replayed}`);
  say(`  execution id      ${second.record.executionId ?? "NONE"}`);
  say(`  tx hash           ${second.record.transactionHash ?? "NONE"}`);
  say(`  sponsored         ${second.sponsored}`);
  say();

  say("Phase C. Count what actually reached the chain.");
  say();

  const postLogs = await countChallengeLogs(rpc, first.record.challenge, baselineBlock);
  say(`  eth_getLogs on the canary, filtered to this run's challenge topic`);
  say(`    address  ${BASE_SEPOLIA.address}`);
  say(`    topic0   ${BASE_SEPOLIA.eventTopic0}`);
  say(`    topic2   ${first.record.challenge}`);
  say(`    matches  ${postLogs.count}`);
  for (const tx of postLogs.txHashes) say(`      ${tx}`);
  say();

  const exactlyOne = postLogs.count === 1;
  const verified = second.outcome === "verified";
  const sameTx = postLogs.txHashes[0]?.toLowerCase() === second.record.transactionHash?.toLowerCase();

  say("Result");
  say("-".repeat(72));
  say(`  first invocation stopped without an execution id     ${first.record.executionId === null}`);
  say(`  broadcast requests actually sent to KeeperHub        ${state.broadcastsSeen}`);
  say(`  recovery replayed the stored response                ${second.record.replayed}`);
  say(`  resumed run reached verified                         ${verified}`);
  say(`  transactions onchain carrying this challenge         ${postLogs.count}`);
  say(`  recovered hash is that transaction                   ${sameTx}`);
  say();
  const pass = exactlyOne && verified && sameTx;
  say(pass ? "  PASS. Two broadcast attempts, one transaction." : "  FAIL.");
  say();

  const dir = resolve(REPO_ROOT, "evidence", "recovery");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, "fault-injection.log"),
    log.join("\n") + "\n",
  );
  writeFileSync(
    resolve(dir, "fault-injection.json"),
    JSON.stringify(
      {
        scenario: "post-submit response loss, recovered by idempotency-key replay",
        startedAt: started,
        completedAt: new Date().toISOString(),
        runId,
        challenge: first.record.challenge,
        idempotencyKey: first.record.idempotencyKey,
        canonicalRequestBodyHash: first.record.canonicalRequestBodyHash,
        firstInvocation: {
          outcome: first.outcome,
          failureCode: first.error?.code ?? null,
          executionIdObserved: first.record.executionId,
          transactionHashObserved: first.record.transactionHash,
          broadcastRequestsSent: state.broadcastsSeen,
        },
        recovery: {
          outcome: second.outcome,
          idempotentReplay: second.record.replayed,
          executionId: second.record.executionId,
          transactionHash: second.record.transactionHash,
          sponsored: second.sponsored,
        },
        onchainProof: {
          method: "eth_getLogs filtered by canary address and the run's unique challenge topic",
          address: BASE_SEPOLIA.address,
          topic0: BASE_SEPOLIA.eventTopic0,
          challengeTopic: first.record.challenge,
          searchedFromBlock: baselineBlock,
        matchingLogCount: postLogs.count,
          transactionHashes: postLogs.txHashes,
        },
        pass,
        capsule: second.outcome === "verified" ? buildCapsule(second, env.rpcUrl) : null,
      },
      null,
      2,
    ) + "\n",
  );
  say(`  evidence written to evidence/recovery/`);
  say();

  return pass ? 0 : 1;
}

/**
 * Count the transactions that carried this run's challenge.
 *
 * The challenge is 32 random bytes generated for this run alone and is an indexed topic, so a
 * log filter on it is an exact count of the transactions that executed this logical work. The
 * range is bounded to the blocks around the run because public nodes reject an unbounded scan,
 * and it starts before the first broadcast so nothing can hide behind the window.
 */
async function countChallengeLogs(
  rpc: Rpc,
  challenge: string,
  fromBlock: number,
): Promise<{ count: number; txHashes: string[]; fromBlock: number }> {
  const logs = await rpc.call<Array<{ transactionHash: string }>>("eth_getLogs", [
    {
      address: BASE_SEPOLIA.address,
      topics: [BASE_SEPOLIA.eventTopic0, null, challenge],
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "latest",
    },
  ]);
  return { count: logs.length, txHashes: logs.map((l) => l.transactionHash), fromBlock };
}

async function currentBlock(rpc: Rpc): Promise<number> {
  return parseInt(await rpc.call<string>("eth_blockNumber", []), 16);
}

main().then((code) => process.exit(code));
