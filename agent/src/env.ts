/**
 * Environment loading and credential shape checks.
 *
 * The key-type check runs before any network call because a wfb_ user key produces a bare 401
 * from KeeperHub, which reads to a newcomer as "my key is wrong" rather than "this is the wrong
 * kind of key". The two systems are documented as not interchangeable, and mixing them up is
 * one of the sharpest first-run traps. Naming it costs one string comparison.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlightcheckError } from "./errors.ts";
import { registerSecret } from "./redact.ts";
import { BASE_SEPOLIA } from "./config.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Variables whose values must never reach output. Registered with the redactor on load. */
const SECRET_VARS = [
  "KEEPERHUB_API_KEY",
  "DEPLOYER_PRIVATE_KEY",
  "ETHERSCAN_API_KEY",
  "GITHUB_TOKEN",
  "CLOUDFLARE_API_TOKEN",
] as const;

export interface Env {
  readonly apiKey: string;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly stateDir: string;
  readonly evidenceDir: string;
}

/** Parse a .env file. Deliberately minimal: no interpolation, no export syntax, no dependency. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Load .env into process.env without overwriting anything already set. */
export function loadDotenv(root: string = REPO_ROOT): void {
  const path = resolve(root, ".env");
  if (!existsSync(path)) return;
  for (const [k, v] of Object.entries(parseDotenv(readFileSync(path, "utf8")))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

/** Hand every known credential to the redactor before anything can print. */
export function registerEnvSecrets(): void {
  for (const name of SECRET_VARS) registerSecret(process.env[name]);
}

export type KeyKind = "organisation" | "user" | "unknown" | "absent";

export function classifyKey(raw: string | undefined): KeyKind {
  const key = raw?.trim();
  if (!key || key === "kh_..." || key === "kh_your_api_key") return "absent";
  if (key.startsWith("kh_")) return "organisation";
  if (key.startsWith("wfb_")) return "user";
  return "unknown";
}

/**
 * Where run records live.
 *
 * Overridable because the default sits inside the checkout, and a checkout can be read-only, or
 * shared between two KeeperHub organisations that should not see each other's runs.
 */
export function stateDirFor(root: string = REPO_ROOT): string {
  const override = process.env.FLIGHTCHECK_STATE_DIR?.trim();
  return override ? resolve(override) : resolve(root, ".keeperhub", "flightcheck");
}

export function loadEnv(root: string = REPO_ROOT): Env {
  loadDotenv(root);
  registerEnvSecrets();

  const raw = process.env.KEEPERHUB_API_KEY;
  switch (classifyKey(raw)) {
    case "absent":
      throw new FlightcheckError("FC_ENV_MISSING_KEY");
    case "user":
      throw new FlightcheckError("FC_ENV_WRONG_KEY_TYPE");
    case "unknown":
      throw new FlightcheckError("FC_ENV_MALFORMED_KEY");
  }

  const chainId = Number(process.env.FLIGHTCHECK_CHAIN_ID ?? BASE_SEPOLIA.chainId);
  const rpcUrl = (process.env.FLIGHTCHECK_RPC_URL ?? BASE_SEPOLIA.defaultRpcUrl).trim();

  return {
    apiKey: raw!.trim(),
    chainId: Number.isFinite(chainId) ? chainId : BASE_SEPOLIA.chainId,
    rpcUrl,
    stateDir: stateDirFor(root),
    evidenceDir: resolve(root, "evidence", "runs"),
  };
}
