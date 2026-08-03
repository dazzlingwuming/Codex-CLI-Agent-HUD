import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { STATE_ROOT_ENV } from "../src/constants.mjs";
import { copyActionLayout } from "../src/copy-action.mjs";
import { handleHudClick } from "../src/hud-click.mjs";
import {
  createRunDirectory,
  readControlFiles,
} from "../src/run-directory.mjs";

test("copy action invokes copySelection once without writing a Todo control", (context) => {
  const fixture = hudFixture(context, true);
  const layout = copyActionLayout(80);
  assert.ok(layout);
  /** @type {Array<[string, NodeJS.ProcessEnv]>} */
  const calls = [];

  const exitCode = handleHudClick({
    ...fixture.click,
    mouseX: layout.rectangle.startColumn,
    mouseY: 1,
    copySelection: (codexPane, env) => {
      calls.push([codexPane, env]);
      return true;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [[fixture.click.codexPane, fixture.click.env]]);
  assert.deepEqual(readControlFiles(fixture.runDirectory), []);
});

test("copy action reports no selection with a nonzero exit and no Todo control", (context) => {
  const fixture = hudFixture(context, true);
  const layout = copyActionLayout(80);
  assert.ok(layout);
  let calls = 0;

  const exitCode = handleHudClick({
    ...fixture.click,
    mouseX: layout.rectangle.endColumn - 1,
    copySelection: () => {
      calls += 1;
      return false;
    },
  });

  assert.equal(exitCode, 2);
  assert.equal(calls, 1);
  assert.deepEqual(readControlFiles(fixture.runDirectory), []);
});

test("copy action degrades safely when its tmux operation throws", (context) => {
  const fixture = hudFixture(context, true);
  const layout = copyActionLayout(80);
  assert.ok(layout);

  const exitCode = handleHudClick({
    ...fixture.click,
    mouseX: layout.rectangle.startColumn,
    copySelection: () => {
      throw new Error("selection is unavailable");
    },
  });

  assert.equal(exitCode, 2);
  assert.deepEqual(readControlFiles(fixture.runDirectory), []);
});

test("non-action HUD clicks retain Todo toggle behavior", (context) => {
  const fixture = hudFixture(context, true);
  let copyCalls = 0;

  const exitCode = handleHudClick({
    ...fixture.click,
    mouseX: 0,
    mouseY: 2,
    now: 3_000,
    copySelection: () => {
      copyCalls += 1;
      return true;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(copyCalls, 0);
  assert.equal(
    readControlFiles(fixture.runDirectory)[0].control.kind,
    "todo.toggle",
  );
});

test("copy action is withheld without the explicit capability", (context) => {
  const fixture = hudFixture(context, false);
  const layout = copyActionLayout(80);
  assert.ok(layout);
  let copyCalls = 0;

  const exitCode = handleHudClick({
    ...fixture.click,
    mouseX: layout.rectangle.startColumn,
    copySelection: () => {
      copyCalls += 1;
      return true;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(copyCalls, 0);
  assert.equal(
    readControlFiles(fixture.runDirectory)[0].control.kind,
    "todo.toggle",
  );
});

test("copy action is withheld outside a HUD-owned tmux server", (context) => {
  const fixture = hudFixture(context, true);
  const layout = copyActionLayout(80);
  assert.ok(layout);
  let copyCalls = 0;

  const exitCode = handleHudClick({
    ...fixture.click,
    mouseX: layout.rectangle.startColumn,
    readMeta: () => ({
      copyActionControls: true,
      ownsTmuxServer: false,
    }),
    copySelection: () => {
      copyCalls += 1;
      return true;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(copyCalls, 0);
  assert.equal(
    readControlFiles(fixture.runDirectory)[0].control.kind,
    "todo.toggle",
  );
});

test("invalid coordinates, Codex panes, and run directories fail without side effects", (context) => {
  const fixture = hudFixture(context, true);
  let copyCalls = 0;
  const copySelection = () => {
    copyCalls += 1;
    return true;
  };

  assert.equal(
    handleHudClick({
      ...fixture.click,
      mouseX: "not-a-number",
      copySelection,
    }),
    2,
  );
  assert.equal(
    handleHudClick({
      ...fixture.click,
      codexPane: "",
      copySelection,
    }),
    2,
  );
  assert.equal(
    handleHudClick({
      ...fixture.click,
      runDirectory: path.join(fixture.root, "missing"),
      copySelection,
    }),
    2,
  );
  assert.equal(copyCalls, 0);
  assert.deepEqual(readControlFiles(fixture.runDirectory), []);
});

/**
 * @param {import("node:test").TestContext} context
 * @param {boolean} copyActionControls
 */
function hudFixture(context, copyActionControls) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hud-click-test-"));
  context.after(() => fs.rmSync(base, { recursive: true }));
  const root = path.join(base, "state");
  const env = { ...process.env, [STATE_ROOT_ENV]: root };
  const runDirectory = createRunDirectory({
    copyActionControls,
    cwd: "/workspace",
    env,
    launchId: `click-${copyActionControls}`,
    ownsTmuxServer: true,
    startedAtMs: 1_000,
  });
  return {
    click: {
      codexPane: "%1",
      env,
      mouseX: 0,
      mouseY: 0,
      paneWidth: 80,
      runDirectory,
    },
    root,
    runDirectory,
  };
}
