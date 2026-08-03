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
import { modeButtonLayout } from "../src/interaction-mode.mjs";
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

test("selection controls reserve a CJK-safe right-aligned header across widths", () => {
  const state = createInitialState({
    cwd: "/workspace",
    launchId: "launch",
    startedAtMs: 0,
  });
  state.phase = "验证中文";
  state.task = "实现复制模式与中文任务标题";

  for (const { height, width } of [
    { height: 3, width: 50 },
    { height: 3, width: 60 },
    { height: 6, width: 80 },
    { height: 6, width: 100 },
  ]) {
    const frame = renderHud(state, {
      color: false,
      height,
      interactionMode: "copy",
      now: 0,
      selectionControls: true,
      width,
    });
    const layout = modeButtonLayout(width, "copy");

    assert.ok(layout);
    assert.equal(frame.length, height);
    assert.ok(frame.every((line) => stringWidth(line) === width));
    assert.ok(frame[0].endsWith(layout.text));
    assert.match(frame[0], /● 复制模式/u);
    assert.match(frame[0], /○ HUD 模式/u);
    assert.match(
      frame[0],
      height === 3 ? /验证中文/u : /实现复制模式/u,
    );
  }
});

test("full and compact headers show the active interaction mode", () => {
  const state = createInitialState({
    cwd: "/workspace",
    launchId: "launch",
    startedAtMs: 0,
  });

  const full = renderHud(state, {
    color: false,
    height: 6,
    interactionMode: "hud",
    now: 0,
    selectionControls: true,
    width: 100,
  });
  const compact = renderHud(state, {
    color: false,
    height: 3,
    interactionMode: "copy",
    now: 0,
    selectionControls: true,
    width: 60,
  });

  assert.match(full[0], /○ 复制模式/u);
  assert.match(full[0], /● HUD 模式/u);
  assert.match(compact[0], /● 复制模式/u);
  assert.match(compact[0], /○ HUD 模式/u);
});

test("selection controls stay hidden without the capability", () => {
  const state = createInitialState({
    cwd: "/workspace",
    launchId: "launch",
    startedAtMs: 0,
  });
  state.task = "保持非 JetBrains 输出";

  const defaultFrame = renderHud(state, {
    color: false,
    height: 6,
    now: 0,
    width: 100,
  });
  const hiddenControlsFrame = renderHud(state, {
    color: false,
    height: 6,
    interactionMode: "copy",
    now: 0,
    selectionControls: false,
    width: 100,
  });

  assert.deepEqual(hiddenControlsFrame, defaultFrame);
  assert.doesNotMatch(hiddenControlsFrame.join("\n"), /复制模式|HUD 模式/u);
});

test("control reducer preserves Todo expansion and gates explicit modes", () => {
  const todoToggle = {
    kind: "todo.toggle",
    observedAtMs: 1,
    version: 1,
  };
  const copyMode = {
    kind: "interaction.mode.set",
    mode: "copy",
    observedAtMs: 2,
    version: 1,
  };
  const controls = createHudControls({ selectionControls: true });
  const expanded = reduceHudControls(controls, todoToggle);
  const copy = reduceHudControls(expanded, copyMode);

  assert.deepEqual(expanded, {
    expanded: true,
    interactionMode: "hud",
    selectionControls: true,
  });
  assert.deepEqual(copy, {
    expanded: true,
    interactionMode: "copy",
    selectionControls: true,
  });
  assert.equal(reduceHudControls(copy, copyMode), copy);
  assert.deepEqual(reduceHudControls(copy, todoToggle), {
    expanded: false,
    interactionMode: "copy",
    selectionControls: true,
  });

  for (const invalidControl of [
    { ...copyMode, mode: "other" },
    { ...copyMode, observedAtMs: Number.NaN },
    { ...copyMode, version: 2 },
  ]) {
    assert.equal(reduceHudControls(copy, invalidControl), copy);
  }

  const unavailable = createHudControls({ selectionControls: false });
  assert.equal(reduceHudControls(unavailable, copyMode), unavailable);
  assert.deepEqual(reduceHudControls(unavailable, todoToggle), {
    expanded: true,
    interactionMode: "hud",
    selectionControls: false,
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

  assert.equal(
    renderRevision({
      eventCount: 2,
      height: 6,
      interactionMode: "copy",
      now: 1_999,
      width: 100,
    }),
    initial,
  );

  const hudControls = renderRevision({
    eventCount: 2,
    height: 6,
    interactionMode: "hud",
    now: 1_999,
    selectionControls: true,
    width: 100,
  });
  assert.notEqual(hudControls, initial);
  assert.notEqual(
    renderRevision({
      eventCount: 2,
      height: 6,
      interactionMode: "copy",
      now: 1_999,
      selectionControls: true,
      width: 100,
    }),
    hudControls,
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
