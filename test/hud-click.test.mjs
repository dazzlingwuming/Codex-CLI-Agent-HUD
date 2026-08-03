import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { STATE_ROOT_ENV } from "../src/constants.mjs";
import { handleHudClick } from "../src/hud-click.mjs";
import { modeButtonLayout } from "../src/interaction-mode.mjs";
import {
  createRunDirectory,
  readControlFiles,
} from "../src/run-directory.mjs";

test("PyCharm mode buttons set an explicit mode and persist one control", (context) => {
  const fixture = hudFixture(context, true);
  /** @type {"hud" | "copy"} */
  let currentMode = "hud";
  const layout = modeButtonLayout(80, currentMode);
  assert.ok(layout);
  const copy = layout.buttons.find((button) => button.mode === "copy");
  assert.ok(copy);

  const exitCode = handleHudClick({
    ...fixture.click,
    mouseX: 5 + copy.startColumn,
    now: 2_000,
    readMode: () => currentMode,
    setMode: (_sessionId, mode) => {
      currentMode = mode;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(currentMode, "copy");
  assert.deepEqual(
    readControlFiles(fixture.runDirectory).map(({ control }) => control),
    [
      {
        kind: "interaction.mode.set",
        mode: "copy",
        observedAtMs: 2_000,
        version: 1,
      },
    ],
  );
});

test("clicking the active mode is idempotent", (context) => {
  const fixture = hudFixture(context, true);
  const layout = modeButtonLayout(80, "hud");
  assert.ok(layout);
  const hud = layout.buttons.find((button) => button.mode === "hud");
  assert.ok(hud);
  let setCalls = 0;

  const exitCode = handleHudClick({
    ...fixture.click,
    mouseX: 5 + hud.startColumn,
    readMode: () => "hud",
    setMode: () => {
      setCalls += 1;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(setCalls, 0);
  assert.deepEqual(readControlFiles(fixture.runDirectory), []);
});

test("non-button HUD clicks retain Todo toggle behavior", (context) => {
  const fixture = hudFixture(context, true);
  const exitCode = handleHudClick({
    ...fixture.click,
    mouseX: 5,
    mouseY: 11,
    now: 3_000,
    readMode: () => "hud",
    setMode: () => {},
  });

  assert.equal(exitCode, 0);
  assert.equal(
    readControlFiles(fixture.runDirectory)[0].control.kind,
    "todo.toggle",
  );
});

test("terminals without selection controls cannot activate copy mode", (context) => {
  const fixture = hudFixture(context, false);
  const layout = modeButtonLayout(80, "hud");
  assert.ok(layout);
  const copy = layout.buttons.find((button) => button.mode === "copy");
  assert.ok(copy);
  let setCalls = 0;

  const exitCode = handleHudClick({
    ...fixture.click,
    mouseX: 5 + copy.startColumn,
    readMode: () => "hud",
    setMode: () => {
      setCalls += 1;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(setCalls, 0);
  assert.equal(
    readControlFiles(fixture.runDirectory)[0].control.kind,
    "todo.toggle",
  );
});

test("a failed control write rolls tmux back to the previous mode", (context) => {
  const fixture = hudFixture(context, true);
  const layout = modeButtonLayout(80, "hud");
  assert.ok(layout);
  const copy = layout.buttons.find((button) => button.mode === "copy");
  assert.ok(copy);
  /** @type {string[]} */
  const modes = [];

  const exitCode = handleHudClick({
    ...fixture.click,
    mouseX: 5 + copy.startColumn,
    readMode: () => "hud",
    setMode: (_sessionId, mode) => modes.push(mode),
    writeControl: () => false,
  });

  assert.equal(exitCode, 2);
  assert.deepEqual(modes, ["copy", "hud"]);
});

test("invalid coordinates and run directories fail without side effects", (context) => {
  const fixture = hudFixture(context, true);
  let setCalls = 0;
  assert.equal(
    handleHudClick({
      ...fixture.click,
      mouseX: "not-a-number",
      readMode: () => "hud",
      setMode: () => {
        setCalls += 1;
      },
    }),
    2,
  );
  assert.equal(
    handleHudClick({
      ...fixture.click,
      runDirectory: path.join(fixture.root, "missing"),
      readMode: () => "hud",
      setMode: () => {
        setCalls += 1;
      },
    }),
    2,
  );
  assert.equal(setCalls, 0);
  assert.deepEqual(readControlFiles(fixture.runDirectory), []);
});

/**
 * @param {import("node:test").TestContext} context
 * @param {boolean} selectionControls
 */
function hudFixture(context, selectionControls) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hud-click-test-"));
  context.after(() => fs.rmSync(base, { recursive: true }));
  const root = path.join(base, "state");
  const env = { ...process.env, [STATE_ROOT_ENV]: root };
  const runDirectory = createRunDirectory({
    cwd: "/workspace",
    env,
    launchId: `click-${selectionControls}`,
    ownsTmuxServer: true,
    selectionControls,
    startedAtMs: 1_000,
  });
  return {
    click: {
      env,
      mouseX: 5,
      mouseY: 10,
      paneLeft: 5,
      paneTop: 10,
      paneWidth: 80,
      runDirectory,
      sessionId: "$1",
    },
    root,
    runDirectory,
  };
}
