/**
 * The echo test that can actually fail.
 *
 * A mock stdin cannot reproduce this bug. The leak is the *terminal's* line discipline echoing
 * input, which happens outside the process entirely, so a `PassThrough` will always report a
 * clean stream no matter how broken the suppression is. An external audit found exactly that: the
 * unit test passed while the real CLI printed the key in plaintext under a kernel pty.
 *
 * So this spawns the real CLI under a real pty, types a recognisable fake key, and asserts the
 * bytes never come back. It needs `python3` for `pty.fork`, which ships on macOS and every Linux
 * distribution we care about, and skips rather than fails where that is unavailable.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { REPO_ROOT } from "../src/env.ts";

const PROBE = "kh_PTYECHOPROBE_abcdefghijkl";

const HARNESS = `
import os, pty, sys, time, select
cmd = sys.argv[1:]
feed = os.environ["FC_PROBE"].encode() + b"\\r"
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
    os._exit(1)
out = b""
time.sleep(2.0)
try:
    os.write(fd, feed)
except OSError:
    pass
deadline = time.time() + 6
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.4)
    if r:
        try:
            chunk = os.read(fd, 4096)
            if not chunk:
                break
            out += chunk
        except OSError:
            break
try:
    os.close(fd)
except OSError:
    pass
sys.stdout.write(out.decode(errors="replace"))
`;

function havePython(): boolean {
  const r = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" });
  return r.status === 0;
}

describe("credential echo, under a real terminal", () => {
  test(
    "the typed key never reaches the terminal",
    { skip: havePython() ? false : "python3 with the pty module is required" },
    () => {
      const dir = mkdtempSync(resolve(tmpdir(), "fc-pty-"));
      const harness = resolve(dir, "harness.py");
      writeFileSync(harness, HARNESS);

      // The prompt only appears when no environment key is configured, so .env is moved aside
      // for the duration and restored afterwards.
      const envPath = resolve(REPO_ROOT, ".env");
      const stash = resolve(REPO_ROOT, ".env.pty-test-stash");
      const hadEnv = existsSync(envPath);
      if (hadEnv) renameSync(envPath, stash);

      try {
        const output = execFileSync(
          "python3",
          [
            harness,
            process.execPath,
            "--experimental-strip-types",
            "--no-warnings",
            resolve(REPO_ROOT, "agent", "src", "cli.ts"),
            "setup",
          ],
          {
            encoding: "utf8",
            cwd: REPO_ROOT,
            env: { ...process.env, FC_PROBE: PROBE, KEEPERHUB_API_KEY: "" },
            timeout: 60_000,
          },
        );

        assert.ok(
          output.includes("KeeperHub organisation key:"),
          "the prompt should have been reached; if not, this test is not exercising the read path",
        );
        assert.ok(
          !output.includes(PROBE),
          "the typed key must never appear in terminal output",
        );
        assert.ok(
          !output.includes("PTYECHOPROBE"),
          "not even part of the typed key may appear in terminal output",
        );
      } finally {
        if (hadEnv && existsSync(stash)) renameSync(stash, envPath);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
