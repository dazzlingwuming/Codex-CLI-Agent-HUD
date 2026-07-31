import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HOOK_EVENTS, HOOK_MARKER } from "../src/constants.mjs";
import {
  buildHookCommand,
  setupHooks,
  uninstallHooks,
} from "../src/hooks-config.mjs";

test("setup is additive, backed up, and idempotent", (context) => {
  const configHome = temporaryDirectory(context);
  const hooksPath = path.join(configHome, "hooks.json");
  const original = {
    description: "Keep me",
    hooks: {
      Stop: [
        {
          hooks: [
            {
              command: "node existing-hook.mjs",
              timeout: 45,
              type: "command",
            },
          ],
        },
      ],
    },
  };
  fs.writeFileSync(hooksPath, `${JSON.stringify(original, null, 2)}\n`);

  const first = setupHooks({
    configHome,
    entryPath: "/tmp/Codex HUD/cli's.mjs",
    nodePath: "/usr/local/bin/node",
    now: new Date("2026-07-31T00:00:00.000Z"),
  });

  assert.equal(first.changed, true);
  assert.ok(first.backupPath);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(first.backupPath, "utf8")),
    original,
  );

  const installed = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  assert.equal(installed.description, "Keep me");
  assert.equal(installed.hooks.Stop[0].hooks[0].command, "node existing-hook.mjs");
  for (const eventName of HOOK_EVENTS) {
    const handlers = installed.hooks[eventName].flatMap(
      (/** @type {Record<string, any>} */ group) => group.hooks ?? [],
    );
    assert.equal(
      handlers.filter((/** @type {Record<string, any>} */ handler) =>
        handler.command?.includes(`${HOOK_MARKER}=1`),
      ).length,
      1,
    );
  }

  const second = setupHooks({
    configHome,
    entryPath: "/tmp/Codex HUD/cli's.mjs",
    nodePath: "/usr/local/bin/node",
    now: new Date("2026-07-31T00:00:01.000Z"),
  });
  assert.equal(second.changed, false);
  assert.equal(second.backupPath, null);
});

test("uninstall removes only HUD-owned handlers", (context) => {
  const configHome = temporaryDirectory(context);
  setupHooks({
    configHome,
    entryPath: "/tmp/cli.mjs",
    now: new Date("2026-07-31T00:00:00.000Z"),
  });

  const hooksPath = path.join(configHome, "hooks.json");
  const document = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  document.hooks.Stop.unshift({
    hooks: [{ command: "keep-this", type: "command" }],
  });
  fs.writeFileSync(hooksPath, `${JSON.stringify(document, null, 2)}\n`);

  const result = uninstallHooks({
    configHome,
    now: new Date("2026-07-31T00:00:02.000Z"),
  });
  assert.equal(result.changed, true);

  const remaining = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  assert.equal(remaining.hooks.Stop[0].hooks[0].command, "keep-this");
  assert.doesNotMatch(JSON.stringify(remaining), new RegExp(HOOK_MARKER));
});

test("invalid existing JSON is never overwritten", (context) => {
  const configHome = temporaryDirectory(context);
  const hooksPath = path.join(configHome, "hooks.json");
  fs.writeFileSync(hooksPath, "{ invalid");

  assert.throws(
    () =>
      setupHooks({
        configHome,
        entryPath: "/tmp/cli.mjs",
      }),
    /not valid JSON/u,
  );
  assert.equal(fs.readFileSync(hooksPath, "utf8"), "{ invalid");
});

test("hook command safely quotes paths with spaces and apostrophes", () => {
  const command = buildHookCommand({
    entryPath: "/tmp/Codex HUD/cli's.mjs",
    nodePath: "/usr/local/bin/node",
  });
  assert.match(command, new RegExp(`^${HOOK_MARKER}=1`));
  assert.match(command, /cli'"'"'s\.mjs/u);
});

/**
 * @param {import("node:test").TestContext} context
 */
function temporaryDirectory(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hud-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true }));
  return directory;
}
