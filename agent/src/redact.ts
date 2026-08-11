/**
 * Secret containment.
 *
 * Two independent layers, because either alone fails in a way the other catches.
 *
 * Value matching catches the secrets we know about, including partial prefixes, since a masked
 * "kh_AbCd1234..." is still a disclosure. Pattern matching catches secrets nobody registered,
 * which is the realistic failure: someone adds a new credential to .env next month and forgets
 * to tell the redactor about it.
 *
 * Everything the tool prints or writes goes through `scrub`. The test suite asserts that by
 * scanning captured output for both layers, so a regression fails the build rather than
 * shipping.
 */

const MIN_PARTIAL = 8;

let registered: string[] = [];

/** Register a literal secret so it, and any prefix of it, is scrubbed from output. */
export function registerSecret(value: string | undefined | null): void {
  if (!value) return;
  const trimmed = value.trim();
  if (trimmed.length < MIN_PARTIAL) return;
  if (!registered.includes(trimmed)) registered.push(trimmed);
}

export function clearSecrets(): void {
  registered = [];
}

export function registeredCount(): number {
  return registered.length;
}

/**
 * Shapes that are secret-like regardless of whether anyone registered them.
 *
 * The 64-hex rule deliberately does not fire on `0x`-prefixed values. Transaction hashes,
 * block hashes, challenges and bytecode digests are all 0x + 64 hex and are all things we
 * publish on purpose. A bare 64-hex run with no 0x is what a leaked private key or a raw
 * digest of one looks like.
 */
const PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /kh_[A-Za-z0-9_-]{8,}/g, label: "KEEPERHUB_ORG_KEY" },
  { re: /wfb_[A-Za-z0-9_-]{8,}/g, label: "KEEPERHUB_USER_KEY" },
  { re: /(?<![0-9a-fA-Fx])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, label: "RAW_64_HEX" },
  { re: /\b[A-Z0-9]{34}\b/g, label: "EXPLORER_API_KEY" },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/g, label: "GITHUB_TOKEN" },
];

/** Replace every known secret and secret-shaped value in `text`. */
export function scrub(text: string): string {
  let out = text;
  for (const secret of registered) {
    out = replaceAll(out, secret, "<redacted>");
    // A prefix long enough to identify the credential is still a disclosure.
    for (let len = secret.length - 1; len >= MIN_PARTIAL; len--) {
      const prefix = secret.slice(0, len);
      if (!out.includes(prefix)) continue;
      out = replaceAll(out, prefix, "<redacted>");
      break;
    }
  }
  for (const { re, label } of PATTERNS) {
    out = out.replace(re, `<redacted:${label}>`);
  }
  return out;
}

/** Deep-scrub a JSON-serialisable value, keys included. */
export function scrubValue<T>(value: T): T {
  if (typeof value === "string") return scrub(value) as unknown as T;
  if (Array.isArray(value)) return value.map(scrubValue) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[scrub(k)] = scrubValue(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** Report every secret-like hit in `text`. Used by the redaction gate in the test suite. */
export function findLeaks(text: string): Array<{ label: string; sample: string }> {
  const hits: Array<{ label: string; sample: string }> = [];
  for (const secret of registered) {
    if (text.includes(secret)) {
      hits.push({ label: "REGISTERED_SECRET", sample: `<${secret.length} chars>` });
      continue;
    }
    for (let len = secret.length - 1; len >= MIN_PARTIAL; len--) {
      if (text.includes(secret.slice(0, len))) {
        hits.push({ label: "REGISTERED_SECRET_PREFIX", sample: `<${len} char prefix>` });
        break;
      }
    }
  }
  for (const { re, label } of PATTERNS) {
    const m = text.match(new RegExp(re.source, re.flags));
    if (m) hits.push({ label, sample: `<${m.length} match(es)>` });
  }
  return hits;
}

function replaceAll(haystack: string, needle: string, replacement: string): string {
  if (!needle) return haystack;
  return haystack.split(needle).join(replacement);
}

/**
 * Only emit an RPC URL as provenance when it cannot itself be a credential. A keyed
 * provider URL carries the key in the path or query, so anything but a bare origin is dropped.
 */
export function safeRpcOrigin(url: string): string {
  try {
    const u = new URL(url);
    const bare = !u.username && !u.password && !u.search && (u.pathname === "" || u.pathname === "/");
    return bare ? `${u.protocol}//${u.host}` : "redacted";
  } catch {
    return "redacted";
  }
}
