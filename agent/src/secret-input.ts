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

import { execFileSync } from "node:child_process";
import { FlightcheckError } from "./errors.ts";
import { registerSecret } from "./redact.ts";


/**
 * Ask the terminal to stop echoing, then ask it whether it did.
 *
 * `stty -a` prints the flag as the bare word `echo` when echo is on and `-echo` when it is off,
 * alongside unrelated neighbours like `echoe` and `echoctl`, so the token is matched exactly
 * rather than by substring. Returning false here means the caller must refuse to read.
 */
function disableEcho(): boolean {
  try {
    execFileSync("stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] });
  } catch {
    return false;
  }
  return echoIsOff();
}

function echoIsOff(): boolean {
  try {
    const state = execFileSync("stty", ["-a"], {
      stdio: ["inherit", "pipe", "ignore"],
      encoding: "utf8",
    });
    const tokens = state.split(/[\s;]+/);
    if (tokens.includes("-echo")) return true;
    if (tokens.includes("echo")) return false;
    // A terminal that reports neither is one we cannot make a claim about.
    return false;
  } catch {
    return false;
  }
}

function restoreEcho(): void {
  try {
    execFileSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] });
  } catch {
    // Best effort. The process is exiting or the terminal is gone.
  }
}

/**
 * How echo is suppressed and verified.
 *
 * Injectable so a unit test can drive the read loop without a real terminal. Production always
 * uses the `stty` implementation above, and the property that actually matters is proved by a
 * pty test that runs the real CLI, because a mock stream cannot reproduce a terminal's own line
 * discipline echoing input. That gap is precisely what an audit found.
 */
export interface EchoControl {
  disable(): boolean;
  restore(): void;
}

const TERMINAL_ECHO: EchoControl = { disable: disableEcho, restore: restoreEcho };

export interface PromptOptions {
  readonly label: string;
  readonly hint?: string;
  /** Injected in tests. Production always uses the real TTY. */
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly echo?: EchoControl;
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

  const echo = opts.echo ?? TERMINAL_ECHO;

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
      echo.restore();
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

    /*
     * Suppress echo, then verify the terminal actually did it, before reading a single byte.
     *
     * `setRawMode(true)` alone is not enough and its own `isRaw` flag cannot be trusted. An
     * external audit drove this under a real pty on macOS with Node 24 and watched the key
     * print in plaintext directly beneath the line promising it would not, with `isRaw`
     * reporting true the whole time. Reordering the prompt did not fix it either.
     *
     * So the terminal is asked directly, through `stty`, and then asked again what state it is
     * actually in. Echo suppression is the entire security property of this function, so it is
     * measured rather than assumed. If the terminal will not confirm that echo is off, this
     * refuses to read at all: failing closed costs a user one error message, failing open costs
     * them their key.
     */
    if (!echo.disable()) {
      echo.restore();
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        /* nothing further to restore */
      }
      reject(new FlightcheckError("FC_SECRET_ECHO_UNSAFE"));
      return;
    }

    try {
      stdin.setRawMode(true);
    } catch {
      echo.restore();
      reject(new FlightcheckError("FC_SECRET_TTY_REQUIRED"));
      return;
    }

    stdout.write(opts.label);
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
  echo?: EchoControl;
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
      ...(opts.echo ? { echo: opts.echo } : {}),
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
