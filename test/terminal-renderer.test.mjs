import assert from "node:assert/strict";
import test from "node:test";
import stringWidth from "string-width";

import {
  renderHud,
  renderRevision,
  selectPlanWindow,
} from "../src/renderer.mjs";
import { createInitialState } from "../src/state.mjs";
import {
  fitDisplay,
  formatDuration,
  truncateDisplay,
} from "../src/terminal.mjs";

test("display fitting respects CJK and emoji width", () => {
  const value = truncateDisplay("任务状态🙂abcdef", 10);
  assert.ok(stringWidth(value) <= 10);
  assert.equal(stringWidth(fitDisplay("中文", 8)), 8);
});

test("durations remain compact below and above one hour", () => {
  assert.equal(formatDuration(65_000), "01:05");
  assert.equal(formatDuration(3_661_000), "1:01:01");
});

test("full HUD renders exact progress and an active-centered Todo window", () => {
  const state = createInitialState({
    cwd: "/workspace",
    launchId: "launch",
    startedAtMs: 0,
  });
  state.task = "实现登录与测试";
  state.phase = "Testing";
  state.currentAction = "Running: npm test";
  state.plan = [
    { step: "Analyze", status: "completed" },
    { step: "Implement", status: "completed" },
    { step: "Test", status: "inProgress" },
    { step: "Review", status: "pending" },
    { step: "Ship", status: "pending" },
  ];
  state.hasPlan = true;

  const frame = renderHud(state, {
    color: false,
    height: 6,
    now: 120_000,
    width: 100,
  });

  assert.equal(frame.length, 6);
  assert.ok(frame.every((line) => stringWidth(line) === 100));
  assert.match(frame[0], /Task: 实现登录与测试/u);
  assert.match(frame[1], /2\/5 40%/u);
  assert.match(frame[2], /npm test/u);
  assert.match(frame.join("\n"), /● Test/u);
  assert.match(frame.join("\n"), /\(\+2 more\)/u);
});

test("compact HUD uses three information lines", () => {
  const state = createInitialState({
    cwd: "/workspace",
    launchId: "launch",
    startedAtMs: 0,
  });
  const frame = renderHud(state, {
    color: false,
    height: 3,
    now: 0,
    width: 60,
  });
  assert.equal(frame.length, 3);
  assert.match(frame[0], /Progress —/u);
  assert.match(frame[1], /Waiting for first prompt/u);
});

test("Todo window stays within plan bounds", () => {
  const plan = [
    { step: "1", status: "completed" },
    { step: "2", status: "completed" },
    { step: "3", status: "completed" },
    { step: "4", status: "pending" },
    { step: "5", status: "pending" },
  ];
  assert.deepEqual(
    selectPlanWindow(plan, 3).items.map((item) => item.step),
    ["3", "4", "5"],
  );
});

test("renderer revision changes only for visible frame inputs", () => {
  const initial = renderRevision({
    eventCount: 2,
    height: 6,
    now: 1_100,
    width: 100,
  });

  assert.equal(
    renderRevision({
      eventCount: 2,
      height: 6,
      now: 1_999,
      width: 100,
    }),
    initial,
  );
  assert.notEqual(
    renderRevision({
      eventCount: 3,
      height: 6,
      now: 1_999,
      width: 100,
    }),
    initial,
  );
  assert.notEqual(
    renderRevision({
      eventCount: 2,
      height: 6,
      now: 2_000,
      width: 100,
    }),
    initial,
  );
  assert.notEqual(
    renderRevision({
      eventCount: 2,
      height: 3,
      now: 1_999,
      width: 79,
    }),
    initial,
  );
});
