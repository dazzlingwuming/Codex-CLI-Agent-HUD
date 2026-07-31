import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  DEBUG_ENV,
  RUN_DIRECTORY_ENV,
  STATE_ROOT_ENV,
} from "../src/constants.mjs";
import { runHook } from "../src/hook-runner.mjs";
import {
  createRunDirectory,
  readEventFiles,
} from "../src/run-directory.mjs";

test("hook runner writes one normalized event and no model output", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hud-hook-test-"));
  context.after(() => fs.rmSync(root, { recursive: true }));
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, [STATE_ROOT_ENV]: root };
  const runDirectory = createRunDirectory({
    cwd: "/workspace",
    env,
    launchId: "hook",
    startedAtMs: 1_000,
  });
  env[RUN_DIRECTORY_ENV] = runDirectory;

  const exitCode = await runHook({
    env,
    input: Readable.from([
      JSON.stringify({
        cwd: "/workspace",
        hook_event_name: "UserPromptSubmit",
        prompt: "Implement login\nwith tests",
        session_id: "session",
        turn_id: "turn",
      }),
    ]),
  });

  assert.equal(exitCode, 0);
  const files = readEventFiles(runDirectory);
  assert.equal(files.length, 1);
  assert.equal(files[0].event.kind, "turn.prompt");
  assert.equal(files[0].event.data.task, "Implement login");
});

test("hook failures are non-blocking and debug-only", async () => {
  let stderr = "";
  const exitCode = await runHook({
    env: { ...process.env, [DEBUG_ENV]: "1", [RUN_DIRECTORY_ENV]: "/invalid" },
    input: Readable.from(["not-json"]),
    stderr: {
      write(value) {
        stderr += value;
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.match(stderr, /hook degraded/u);
});
