import assert from "node:assert/strict";
import test from "node:test";
import stringWidth from "string-width";

import {
  createHudControls,
  diffFrame,
  reduceHudControls,
  renderHud,
  renderRevision,
  selectPlanWindow,
} from "../src/renderer.mjs";
import { copyActionLayout } from "../src/copy-action.mjs";
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
  assert.match(frame.join("\n"), /\(\+2 more · click\)/u);
});

test("expanded HUD shows every Todo and a clickable collapse affordance", () => {
  const state = createInitialState({
    cwd: "/workspace",
    launchId: "launch",
    startedAtMs: 0,
  });
  state.plan = Array.from({ length: 5 }, (_, index) => ({
    status: index < 2 ? "completed" : "pending",
    step: `Todo ${index + 1}`,
  }));
  state.hasPlan = true;

  const frame = renderHud(state, {
    color: false,
    expanded: true,
    height: 9,
    now: 0,
    width: 100,
  });

  assert.equal(frame.length, 9);
  assert.match(frame.join("\n"), /Todo 1/u);
  assert.match(frame.join("\n"), /Todo 5/u);
  assert.match(frame[8], /click to collapse/u);
  assert.doesNotMatch(frame.join("\n"), /\+\d+ more/u);
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

test("copy action reserves a CJK-safe right-aligned header across widths", () => {
  const state = createInitialState({
    cwd: "/workspace",
    launchId: "launch",
    startedAtMs: 0,
  });
  state.phase = "验证中文";
  state.task = "实现复制所选按钮与中文任务标题";

  for (const { height, width } of [
    { height: 3, width: 50 },
    { height: 3, width: 60 },
    { height: 6, width: 80 },
    { height: 6, width: 100 },
  ]) {
    const frame = renderHud(state, {
      color: false,
      height,
      now: 0,
      copyActionControls: true,
      width,
    });
    const layout = copyActionLayout(width);

    assert.ok(layout);
    assert.equal(frame.length, height);
    assert.ok(frame.every((line) => stringWidth(line) === width));
    assert.ok(frame[0].endsWith(layout.text));
    assert.match(frame[0], /\[复制所选\]/u);
    assert.match(
      frame[0],
      height === 3 ? /验证中文/u : /实现复制所选/u,
    );
  }
});

test("full and compact headers show the single copy action", () => {
  const state = createInitialState({
    cwd: "/workspace",
    launchId: "launch",
    startedAtMs: 0,
  });

  const full = renderHud(state, {
    color: false,
    height: 6,
    now: 0,
    copyActionControls: true,
    width: 100,
  });
  const compact = renderHud(state, {
    color: false,
    height: 3,
    now: 0,
    copyActionControls: true,
    width: 60,
  });

  assert.match(full[0], /\[复制所选\]/u);
  assert.match(compact[0], /\[复制所选\]/u);
});

test("copy action stays hidden without the capability", () => {
  const state = createInitialState({
    cwd: "/workspace",
    launchId: "launch",
    startedAtMs: 0,
  });
  state.task = "保持跨终端输出";

  const defaultFrame = renderHud(state, {
    color: false,
    height: 6,
    now: 0,
    width: 100,
  });
  const hiddenControlsFrame = renderHud(state, {
    color: false,
    height: 6,
    now: 0,
    copyActionControls: false,
    width: 100,
  });

  assert.deepEqual(hiddenControlsFrame, defaultFrame);
  assert.doesNotMatch(hiddenControlsFrame.join("\n"), /复制所选/u);
});

test("control reducer preserves Todo expansion and ignores unrelated controls", () => {
  const todoToggle = {
    kind: "todo.toggle",
    observedAtMs: 1,
    version: 1,
  };
  const unrelatedControl = {
    kind: "future.control",
    observedAtMs: 2,
    version: 1,
  };
  const controls = createHudControls({ copyActionControls: true });
  const expanded = reduceHudControls(controls, todoToggle);

  assert.deepEqual(expanded, {
    expanded: true,
    copyActionControls: true,
  });
  assert.equal(reduceHudControls(expanded, unrelatedControl), expanded);
  assert.deepEqual(reduceHudControls(expanded, todoToggle), {
    expanded: false,
    copyActionControls: true,
  });

  const unavailable = createHudControls({ copyActionControls: false });
  assert.equal(reduceHudControls(unavailable, unrelatedControl), unavailable);
  assert.deepEqual(reduceHudControls(unavailable, todoToggle), {
    expanded: true,
    copyActionControls: false,
  });
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
      controlCount: 1,
      eventCount: 2,
      expanded: true,
      height: 3,
      now: 1_999,
      width: 79,
    }),
    initial,
  );

  const copyActionControls = renderRevision({
    eventCount: 2,
    height: 6,
    now: 1_999,
    copyActionControls: true,
    width: 100,
  });
  assert.notEqual(copyActionControls, initial);
  assert.equal(
    renderRevision({
      eventCount: 2,
      height: 6,
      now: 1_999,
      copyActionControls: true,
      width: 100,
    }),
    copyActionControls,
  );
  assert.equal(
    renderRevision({
      eventCount: 2,
      height: 6,
      now: 1_999,
      copyActionControls: true,
      width: 49,
    }),
    renderRevision({
      eventCount: 2,
      height: 6,
      now: 1_999,
      width: 49,
    }),
  );
});

test("frame diff rewrites only changed lines without cursor visibility toggles", () => {
  const output = diffFrame(
    ["first", "before", "third"],
    ["first", "after", "third"],
  );

  assert.equal(output, "\u001b[2;1H\u001b[2Kafter");
  assert.doesNotMatch(output, /\?25[lh]/u);
  assert.doesNotMatch(output, /\[2J/u);
});
