import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RUN_DIRECTORY_ENV,
  STATE_ROOT_ENV,
} from "../src/constants.mjs";
import { quoteShellArgument } from "../src/hooks-config.mjs";
import {
  createRunDirectory,
  readRunJson,
  removeRunDirectory,
  writeRunJson,
} from "../src/run-directory.mjs";
import {
  chooseHudHeight,
  hasStatusLineOverride,
  isolatedTmuxSocketPath,
  withNativeStatusLine,
} from "../src/tmux-host.mjs";

test("native status line is injected once and explicit user config wins", () => {
  const injected = withNativeStatusLine(["-m", "gpt-test"]);
  assert.equal(injected[0], "-c");
  assert.match(injected[1], /^tui\.status_line=/u);
  assert.deepEqual(injected.slice(2), ["-m", "gpt-test"]);

  const explicit = ["-c", 'tui.status_line=["model"]', "-m", "gpt-test"];
  assert.equal(hasStatusLineOverride(explicit), true);
  assert.deepEqual(withNativeStatusLine(explicit), explicit);
});

test("HUD height follows the verified responsive thresholds", () => {
  assert.equal(chooseHudHeight(30, 120), 6);
  assert.equal(chooseHudHeight(20, 70), 3);
  assert.throws(() => chooseHudHeight(13, 100), /too small/u);
  assert.throws(() => chooseHudHeight(30, 49), /too small/u);
});

test("isolated tmux socket path follows TMUX_TMPDIR and the current uid", () => {
  const uid =
    typeof process.getuid === "function" ? process.getuid() : 0;
  assert.equal(
    isolatedTmuxSocketPath("codex-hud-launch", {
      TMUX_TMPDIR: "/private/test-tmux",
    }),
    path.join(
      "/private/test-tmux",
      `tmux-${uid}`,
      "codex-hud-launch",
    ),
  );
});

test("detached tmux host preserves Codex exit code and arguments", async (context) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hud-tmux-test-"));
  const root = path.join(base, "state");
  const socket = `codex-hud-test-${process.pid}-${Date.now()}`;
  context.after(() => {
    spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    fs.rmSync(isolatedTmuxSocketPath(socket), { force: true });
    fs.rmSync(base, { recursive: true });
  });

  const fakeCodex = path.join(base, "fake-codex");
  fs.writeFileSync(
    fakeCodex,
    "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CODEX_HUD_RUN_DIR/codex-args.txt\"\nexit 7\n",
    { mode: 0o700 },
  );

  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, [STATE_ROOT_ENV]: root };
  const runDirectory = createRunDirectory({
    cwd: base,
    env,
    launchId: "tmux",
    startedAtMs: Date.now(),
  });
  env[RUN_DIRECTORY_ENV] = runDirectory;
  const entryPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  writeRunJson(
    runDirectory,
    "launch.json",
    {
      codexArgs: ["--test-value", "含 空格"],
      codexBin: fakeCodex,
      cwd: base,
      entryPath,
    },
    env,
  );

  const command = [
    quoteShellArgument(process.execPath),
    quoteShellArgument(entryPath),
    "__inside",
    quoteShellArgument(runDirectory),
  ].join(" ");
  const started = spawnSync(
    "tmux",
    [
      "-L",
      socket,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "hud",
      "-x",
      "100",
      "-y",
      "30",
      "-c",
      base,
      command,
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(started.status, 0, started.stderr);

  const exitRecord = await waitForExitRecord(runDirectory, env);
  assert.equal(exitRecord?.code, 7);
  const args = fs
    .readFileSync(path.join(runDirectory, "codex-args.txt"), "utf8")
    .trim()
    .split("\n");
  assert.equal(args[0], "-c");
  assert.match(args[1], /^tui\.status_line=/u);
  assert.deepEqual(args.slice(-2), ["--test-value", "含 空格"]);
  assert.equal(readRunJson(runDirectory, "launch.json", env), null);
  assert.equal(removeRunDirectory(runDirectory, env), true);
});

/**
 * @param {string} runDirectory
 * @param {NodeJS.ProcessEnv} env
 */
async function waitForExitRecord(runDirectory, env) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const record = readRunJson(runDirectory, "exit.json", env);
    if (record) {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}
