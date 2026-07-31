import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { STATE_ROOT_ENV } from "../src/constants.mjs";
import {
  cleanupStaleRuns,
  createRunDirectory,
  readEventFiles,
  removeRunDirectory,
  validateRunDirectory,
  writeEventAtomic,
} from "../src/run-directory.mjs";

test("run directories and event files are private and scoped", (context) => {
  const fixture = temporaryRoot(context);
  const env = { ...process.env, [STATE_ROOT_ENV]: fixture.root };
  const runDirectory = createRunDirectory({
    cwd: "/workspace",
    env,
    launchId: "launch",
    startedAtMs: 1_000,
  });

  assert.equal(validateRunDirectory(runDirectory, env), true);
  assert.equal(fs.statSync(runDirectory).mode & 0o777, 0o700);
  assert.equal(
    writeEventAtomic(
      runDirectory,
      { id: "event", kind: "turn.stop", observedAtMs: 2_000 },
      env,
    ),
    true,
  );
  const files = readEventFiles(runDirectory);
  assert.equal(files.length, 1);
  assert.equal(files[0].event.kind, "turn.stop");
  assert.equal(
    fs.statSync(path.join(runDirectory, "events", files[0].name)).mode & 0o777,
    0o600,
  );

  assert.equal(
    writeEventAtomic(
      fixture.outside,
      { id: "bad", observedAtMs: 2_000 },
      env,
    ),
    false,
  );
  assert.equal(removeRunDirectory(runDirectory, env), true);
  assert.equal(fs.existsSync(runDirectory), false);
});

test("stale cleanup removes only validated HUD run directories", (context) => {
  const fixture = temporaryRoot(context);
  const env = { ...process.env, [STATE_ROOT_ENV]: fixture.root };
  const runDirectory = createRunDirectory({
    cwd: "/workspace",
    env,
    launchId: "stale",
    startedAtMs: 1_000,
  });
  fs.utimesSync(runDirectory, new Date(0), new Date(0));
  const unrelated = path.join(fixture.root, "do-not-delete");
  fs.mkdirSync(unrelated);

  assert.equal(
    cleanupStaleRuns({ env, maxAgeMs: 1_000, now: 10_000 }),
    1,
  );
  assert.equal(fs.existsSync(runDirectory), false);
  assert.equal(fs.existsSync(unrelated), true);
});

/**
 * @param {import("node:test").TestContext} context
 */
function temporaryRoot(context) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hud-root-test-"));
  const root = path.join(base, "state");
  const outside = path.join(base, "outside");
  fs.mkdirSync(outside);
  context.after(() => fs.rmSync(base, { recursive: true }));
  return { outside, root };
}
