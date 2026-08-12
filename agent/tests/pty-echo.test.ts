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
 *
 * What it catches, and what it does not. Removing both suppression layers makes it fail with
 * "Echo suppression failed"; removing either one alone does not, because each is sufficient on
 * its own under a pty.fork() terminal and there is no observable difference to assert on. The
 * redundancy exists because the audit caught setRawMode silently failing on macOS with Node 24
 * in a real terminal, not because this test can tell the two layers apart. The mutation matrix
 * is in evidence/probes/pty-echo-mutation.md.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { REPO_ROOT } from "../src/env.ts";

const PROBE = "kh_PTYECHOPROBE_abcdefghijkl";

/*
 * Type only once the program has asked.
 *
 * The first version slept a flat 2.0 seconds and then wrote the key. `setup` makes a live
 * reachability call to KeeperHub before it prompts, so on a slow response the key went in while
 * the terminal's line discipline was still echoing and before `stty -echo` had run. The
 * terminal dutifully echoed it and the test reported a credential leak that had not happened.
 *
 * That is worse than flaky. The property under test is "after the program asks, typing does not
 * echo", and a harness that types early cannot tell a real echo failure from its own race: both
 * look like the probe appearing in the output.
 *
 * So it now waits for the prompt, records where in the stream the probe appeared if it did, and
 * reports the two cases separately. Typing before the prompt is a harness bug and says so.
 */
const HARNESS = `
import os, pty, sys, time, select, json
cmd = sys.argv[1:]
probe = os.environ["FC_PROBE"]
prompt = "organisation key:"
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
    os._exit(1)

out = b""
typed = False
typed_at_offset = None
started = time.time()
deadline = started + 45

while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
    # Only type once the program has actually asked for the key.
    if not typed and prompt.encode() in out:
        typed_at_offset = len(out)
        time.sleep(0.3)
        try:
            os.write(fd, probe.encode() + b"\\r")
        except OSError:
            pass
        typed = True
        deadline = min(deadline, time.time() + 8)

try:
    os.close(fd)
except OSError:
    pass

text = out.decode(errors="replace")
sys.stdout.write(json.dumps({
    "promptSeen": prompt in text,
    "typed": typed,
    "promptOffset": text.find(prompt),
    "probeOffset": text.find(probe),
    "partialOffset": text.find("PTYECHOPROBE"),
    "output": text,
}))
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

        const r = JSON.parse(output) as {
          promptSeen: boolean;
          typed: boolean;
          promptOffset: number;
          probeOffset: number;
          partialOffset: number;
          output: string;
        };

        assert.ok(
          r.promptSeen && r.typed,
          "the prompt was never reached, so this run did not exercise the read path at all",
        );

        /*
         * Position relative to the prompt text is the discriminator, and it has to be the prompt
         * text rather than the offset of the chunk the prompt arrived in. Those differ by however
         * many bytes the read happened to carry past it, which is exactly enough to misclassify a
         * real echo as a harness race. It did, on the first attempt at this.
         *
         *   probe before the prompt -> we typed before the program asked. Says nothing.
         *   probe after the prompt  -> the terminal echoed what was typed at the prompt.
         */
        const firstHit = [r.probeOffset, r.partialOffset].filter((n) => n >= 0).sort((a, b) => a - b)[0];
        if (firstHit !== undefined) {
          assert.fail(
            firstHit < r.promptOffset
              ? `harness raced the program: the probe appears at offset ${firstHit}, before the prompt at ${r.promptOffset}. Nothing was typed at the prompt, so this run says nothing about echo suppression.`
              : `the typed key appeared in terminal output at offset ${firstHit}, after the prompt at ${r.promptOffset}. Echo suppression failed.`,
          );
        }
      } finally {
        if (hadEnv && existsSync(stash)) renameSync(stash, envPath);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
