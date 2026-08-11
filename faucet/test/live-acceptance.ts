/**
 * Live faucet acceptance test.
 *
 * Runs against the deployed Worker and real Base Sepolia. Nothing here is mocked.
 *
 * The recipient is a throwaway address generated for this run. Its private key is never needed
 * after the address is derived, so it is never printed, stored, or kept: the test only ever reads
 * a balance, which needs the address alone.
 *
 * The properties under test are the ones that separate a faucet from an open wallet: exactly one
 * transaction per logical claim, a replay returning the original rather than sending again, and a
 * cooldown that a fresh request id cannot walk around.
 */

import { randomBytes, createHash } from "node:crypto";

const FAUCET = process.env.FAUCET_URL ?? "https://keeperhub-flightcheck-faucet.timjosh507.workers.dev";
const RPC = "https://sepolia.base.org";
const PAYOUT_WEI = 100_000_000_000_000n;

const log: string[] = [];
function say(line = ""): void {
  log.push(line);
  process.stdout.write(line + "\n");
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result: T };
  return body.result;
}

async function balanceOf(address: string): Promise<bigint> {
  return BigInt(await rpc<string>("eth_getBalance", [address, "latest"]));
}

async function claim(recipient: string, requestId: string, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${FAUCET}/api/faucet/base-sepolia`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipient, requestId, ...extra }),
  });
  return { http: res.status, body: (await res.json()) as Record<string, unknown> };
}

/**
 * A throwaway recipient.
 *
 * Derived from random bytes purely to obtain an address that has never been used. There is no
 * key to protect because nothing will ever be sent from it, and the funds are testnet dust.
 */
function throwawayAddress(): string {
  return "0x" + createHash("sha256").update(randomBytes(32)).digest("hex").slice(0, 40);
}

async function main(): Promise<number> {
  const started = new Date().toISOString();
  const recipient = throwawayAddress();
  const requestId = `flightcheck-faucet-live-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
  const check = (name: string, pass: boolean, detail = "") => {
    checks.push({ name, pass, detail });
    say(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  };

  say();
  say("LIVE FAUCET ACCEPTANCE");
  say("=".repeat(72));
  say(`  faucet     ${FAUCET}`);
  say(`  recipient  ${recipient}  (fresh, never used)`);
  say(`  requestId  ${requestId}`);
  say();

  const status = (await (await fetch(`${FAUCET}/api/faucet/base-sepolia/status`)).json()) as Record<string, string>;
  say(`  treasury   ${status.treasuryAddress}`);
  say(`  balance    ${status.treasuryBalanceWei} wei`);
  say(`  enabled    ${status.enabled}`);
  say();

  say("1. Recipient starts below threshold");
  const before = await balanceOf(recipient);
  check("recipient balance is zero", before === 0n, `${before} wei`);

  say();
  say("2. Faucet request accepted and mined");
  const first = await claim(recipient, requestId);
  check("status is funded", first.body.status === "funded", String(first.body.status));
  const txHash = first.body.transactionHash as string | undefined;
  check("a transaction hash was returned", typeof txHash === "string", txHash ?? "none");
  check("not reported as a replay", first.body.idempotentReplay === false);
  check(
    "amount is exactly the fixed payout",
    first.body.amountWei === PAYOUT_WEI.toString(),
    String(first.body.amountWei),
  );

  say();
  say("3. Receipt verified independently against Base Sepolia");
  const receipt = await rpc<{ status: string; blockNumber: string } | null>(
    "eth_getTransactionReceipt",
    [txHash],
  );
  check("receipt exists", receipt !== null);
  check("receipt status is success", receipt?.status === "0x1", receipt?.status ?? "none");

  say();
  say("4. Recipient balance increased by exactly the payout");
  const after = await balanceOf(recipient);
  check("balance increased by the payout", after - before === PAYOUT_WEI, `${after} wei`);

  say();
  say("5. Replay of the same requestId sends nothing new");
  const replay = await claim(recipient, requestId);
  check("replay reports funded", replay.body.status === "funded", String(replay.body.status));
  check("replay is marked as a replay", replay.body.idempotentReplay === true);
  check(
    "replay returns the original transaction",
    replay.body.transactionHash === txHash,
    String(replay.body.transactionHash),
  );
  const afterReplay = await balanceOf(recipient);
  check("balance unchanged by the replay", afterReplay === after, `${afterReplay} wei`);

  say();
  say("6. A fresh requestId for the same address cannot walk around the cooldown");
  const second = await claim(recipient, `${requestId}-different`);
  check(
    "second request refused",
    second.body.status === "cooldown" || second.body.status === "already_sufficient",
    String(second.body.status),
  );
  const afterSecond = await balanceOf(recipient);
  check("balance unchanged by the second request", afterSecond === after, `${afterSecond} wei`);

  say();
  say("7. Two concurrent claims for one fresh id produce at most one transaction");
  const raceRecipient = throwawayAddress();
  const raceId = `flightcheck-faucet-race-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const [a, b] = await Promise.all([claim(raceRecipient, raceId), claim(raceRecipient, raceId)]);
  const funded = [a, b].filter((r) => r.body.status === "funded");
  const hashes = new Set(funded.map((r) => r.body.transactionHash).filter(Boolean));
  check(
    "at most one distinct transaction across both responses",
    hashes.size <= 1,
    `${hashes.size} distinct hash(es), statuses ${a.body.status}/${b.body.status}`,
  );
  const raceBalance = await balanceOf(raceRecipient);
  check(
    "concurrent claims funded the recipient at most once",
    raceBalance <= PAYOUT_WEI,
    `${raceBalance} wei`,
  );

  say();
  say("8. Caller cannot widen scope");
  const withAmount = await claim(throwawayAddress(), `amt-${Date.now()}-${randomBytes(4).toString("hex")}`, {
    amountWei: "1000000000000000000",
  });
  check("an amount parameter is rejected", withAmount.body.status === "invalid_request");
  const withChain = await claim(throwawayAddress(), `chn-${Date.now()}-${randomBytes(4).toString("hex")}`, {
    chainId: 1,
  });
  check("a chainId parameter is rejected", withChain.body.status === "invalid_request");
  const zero = await claim("0x0000000000000000000000000000000000000000", `z-${Date.now()}-${randomBytes(4).toString("hex")}`);
  check("the zero address is rejected", zero.body.status === "invalid_address");
  const treasurySelf = await claim(status.treasuryAddress ?? "0x0000000000000000000000000000000000000001", `t-${Date.now()}-${randomBytes(4).toString("hex")}`);
  check(
    "the treasury cannot fund itself",
    treasurySelf.body.status === "invalid_address" || treasurySelf.body.status === "already_sufficient",
    String(treasurySelf.body.status),
  );
  const badAddr = await claim("not-an-address", `b-${Date.now()}-${randomBytes(4).toString("hex")}`);
  check("a malformed address is rejected", badAddr.body.status === "invalid_address");

  say();
  const passed = checks.filter((c) => c.pass).length;
  const allPass = passed === checks.length;
  say("=".repeat(72));
  say(`  ${passed}/${checks.length} checks passed`);
  say(allPass ? "  PASS" : "  FAIL");
  say();

  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(new URL("../../evidence/faucet/", import.meta.url), { recursive: true });
  writeFileSync(new URL("../../evidence/faucet/live-acceptance.log", import.meta.url), log.join("\n") + "\n");
  writeFileSync(
    new URL("../../evidence/faucet/live-acceptance.json", import.meta.url),
    JSON.stringify(
      {
        test: "faucet live acceptance",
        note: "Run against the deployed Worker and real Base Sepolia. No mocks.",
        startedAt: started,
        completedAt: new Date().toISOString(),
        faucetUrl: FAUCET,
        treasuryAddress: status.treasuryAddress,
        chainId: 84532,
        fixedPayoutWei: PAYOUT_WEI.toString(),
        recipient,
        requestId,
        transactionHash: txHash ?? null,
        explorerUrl: txHash ? `https://sepolia.basescan.org/tx/${txHash}` : null,
        recipientBalanceBeforeWei: before.toString(),
        recipientBalanceAfterWei: after.toString(),
        checks,
        passed,
        total: checks.length,
        pass: allPass,
      },
      null,
      2,
    ) + "\n",
  );
  say("  evidence written to evidence/faucet/");
  say();
  return allPass ? 0 : 1;
}

main().then((c) => process.exit(c));
