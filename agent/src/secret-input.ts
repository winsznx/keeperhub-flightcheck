/**
 * Hidden credential entry.
 *
 * The point of this module is a boundary, not a UI nicety. An AI coding agent can tell a human
 * to run `flightcheck setup`, but the human types the KeeperHub key into Flightcheck's own TTY,
 * not into the agent's context. Nothing the agent can read ever contains the key.
 *
 * That only holds if the key never lands anywhere durable, so it is read into a string, used for
 * the process lifetime, and never written to `.env`, run state, a capsule, argv, a log, or an
 * outbound request other than the KeeperHub Authorization header itself.
 *
 * When there is no private TTY, this fails closed rather than falling back to a visible read.
 * A piped or agent-driven stdin is exactly the case where a key would leak, so it is refused.
 */

import { FlightcheckError } from "./errors.ts";
import { registerSecret } from "./redact.ts";

export interface PromptOptions {
  readonly label: string;
  readonly hint?: string;
  /** Injected in tests. Production always uses the real TTY. */
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
}

/**
 * True when stdin is a real interactive terminal.
 *
 * A pipe, a heredoc, a file redirect and an agent-controlled stdin all report false, which is
 * the distinction that matters: any of those means something other than a human at a keyboard
 * is supplying the bytes.
 */
export function hasInteractiveTty(stdin: NodeJS.ReadStream = process.stdin): boolean {
  return Boolean(stdin.isTTY) && typeof stdin.setRawMode === "function";
}

/**
 * Read a secret with no echo.
 *
 * Raw mode is used rather than readline so that not a single character reaches the terminal, and
 * so a paste of the whole key does not appear in scrollback. The stream is restored on every
 * exit path, including Ctrl-C, because leaving a terminal in raw mode is its own hazard.
 */
export function promptSecret(opts: PromptOptions): Promise<string> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  if (!hasInteractiveTty(stdin)) {
    return Promise.reject(new FlightcheckError("FC_SECRET_TTY_REQUIRED"));
  }

  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    const wasRaw = stdin.isRaw === true;

    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        // Restoring the mode is best effort; failing to must not mask the original outcome.
      }
      stdin.pause();
    };

    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        switch (byte) {
          case 0x03: // Ctrl-C
            cleanup();
            stdout.write("\n");
            reject(new FlightcheckError("FC_SECRET_CANCELLED"));
            return;
          case 0x04: // Ctrl-D
            if (buffer.length === 0) {
              cleanup();
              stdout.write("\n");
              reject(new FlightcheckError("FC_SECRET_CANCELLED"));
              return;
            }
            break;
          case 0x0d: // Enter
          case 0x0a:
            cleanup();
            stdout.write("\n");
            resolve(buffer);
            return;
          case 0x7f: // Backspace
          case 0x08:
            buffer = buffer.slice(0, -1);
            break;
          default:
            // Ignore other control characters so an escape sequence cannot enter the buffer.
            if (byte >= 0x20) buffer += String.fromCharCode(byte);
        }
      }
    };

    stdout.write(opts.label);
    try {
      stdin.setRawMode(true);
    } catch {
      reject(new FlightcheckError("FC_SECRET_TTY_REQUIRED"));
      return;
    }
    stdin.resume();
    stdin.on("data", onData);
  });
}

/**
 * Obtain the KeeperHub organisation key for this process.
 *
 * Environment first, so CI and advanced users are unaffected. Otherwise an interactive prompt.
 * Never argv: a key on the command line lands in the process table, shell history and any
 * `ps` output, and there is no way to take that back.
 */
export async function acquireKeeperHubKey(opts: {
  envValue?: string;
  interactive: boolean;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  onNote?: (text: string) => void;
}): Promise<{ key: string; source: "environment" | "interactive" }> {
  const fromEnv = opts.envValue?.trim();
  if (fromEnv && fromEnv !== "kh_..." && fromEnv !== "kh_your_api_key") {
    registerSecret(fromEnv);
    return { key: fromEnv, source: "environment" };
  }

  if (!opts.interactive) {
    throw new FlightcheckError("FC_SECRET_TTY_REQUIRED");
  }

  const key = (
    await promptSecret({
      label: "  KeeperHub organisation key: ",
      stdin: opts.stdin,
      stdout: opts.stdout,
    })
  ).trim();

  // Registered immediately so that even a crash between here and the first request cannot print
  // it through an error path.
  registerSecret(key);
  return { key, source: "interactive" };
}

/** Guard against a key ever being passed where the whole world can read it. */
export function assertNoSecretInArgv(argv: readonly string[]): void {
  for (const arg of argv) {
    if (/^(--key|--api-key|--keeperhub-key|--token)(=|$)/.test(arg) || /^(kh|wfb)_/.test(arg)) {
      throw new FlightcheckError("FC_SECRET_IN_ARGV");
    }
  }
}
