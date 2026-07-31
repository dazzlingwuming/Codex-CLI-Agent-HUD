import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeHookInput,
  normalizePlan,
} from "../src/events.mjs";
import {
  createInitialState,
  planProgress,
  reduceHudState,
} from "../src/state.mjs";

const deterministic = {
  id: () => "event-1",
  now: () => 1_000,
};

test("plan statuses normalize Codex tool and app-server spellings", () => {
  assert.deepEqual(
    normalizePlan([
      { step: "Analyze", status: "completed" },
      { step: "Code", status: "in_progress" },
      { step: "Test", status: "inProgress" },
      { step: "Ship", status: "pending" },
      { step: "", status: "pending" },
    ]),
    [
      { step: "Analyze", status: "completed" },
      { step: "Code", status: "inProgress" },
      { step: "Test", status: "inProgress" },
      { step: "Ship", status: "pending" },
    ],
  );
});

test("progress is exact and absent for a missing plan", () => {
  assert.deepEqual(planProgress([]), {
    completed: 0,
    percent: null,
    total: 0,
  });
  assert.deepEqual(
    planProgress([
      { step: "One", status: "completed" },
      { step: "Two", status: "pending" },
      { step: "Three", status: "pending" },
    ]),
    { completed: 1, percent: 33, total: 3 },
  );
});

test("a plan is committed only when PostToolUse arrives", () => {
  let state = createInitialState({
    cwd: "/workspace",
    launchId: "launch",
    startedAtMs: 0,
  });
  state = reduce(
    state,
    {
      cwd: "/workspace",
      hook_event_name: "UserPromptSubmit",
      prompt: "Implement login",
      session_id: "session",
      turn_id: "turn",
    },
    100,
  );
  state = reduce(
    state,
    {
      cwd: "/workspace",
      hook_event_name: "PreToolUse",
      session_id: "session",
      tool_input: {
        plan: [
          { step: "Analyze", status: "completed" },
          { step: "Code", status: "in_progress" },
        ],
      },
      tool_name: "update_plan",
      tool_use_id: "plan-tool",
      turn_id: "turn",
    },
    200,
  );

  assert.equal(state.hasPlan, false);
  assert.equal(state.currentAction, "Updating plan");

  state = reduce(
    state,
    {
      cwd: "/workspace",
      hook_event_name: "PostToolUse",
      session_id: "session",
      tool_input: {
        plan: [
          { step: "Analyze", status: "completed" },
          { step: "Code", status: "in_progress" },
        ],
      },
      tool_name: "update_plan",
      tool_use_id: "plan-tool",
      tool_response: "Plan updated",
      turn_id: "turn",
    },
    300,
  );

  assert.equal(state.hasPlan, true);
  assert.deepEqual(planProgress(state.plan), {
    completed: 1,
    percent: 50,
    total: 2,
  });
  assert.equal(state.phase, "Planning");
});

test("parallel tools retain the newest active action", () => {
  let state = createInitialState({
    cwd: "/workspace",
    launchId: "launch",
    startedAtMs: 0,
  });
  state = reduce(state, toolHook("PreToolUse", "read-1", "mcp__fs__read_file"), 100);
  state = reduce(state, toolHook("PreToolUse", "test-1", "Bash", "npm test"), 200);
  assert.equal(state.phase, "Testing");
  assert.match(state.currentAction, /npm test/u);

  state = reduce(state, toolHook("PostToolUse", "test-1", "Bash", "npm test"), 300);
  assert.equal(state.phase, "Searching");
  assert.match(state.currentAction, /Reading/u);
});

test("an older start event cannot resurrect an already finished tool", () => {
  let state = createInitialState({
    cwd: "/workspace",
    launchId: "launch",
    startedAtMs: 0,
  });
  state = reduce(state, toolHook("PostToolUse", "tool-1", "Bash", "ls"), 300);
  state = reduce(state, toolHook("PreToolUse", "tool-1", "Bash", "ls"), 200);
  assert.equal(state.activeTools.length, 0);
});

test("Stop reports Completed only for a non-empty completed plan", () => {
  const initial = createInitialState({
    cwd: "/workspace",
    launchId: "launch",
    startedAtMs: 0,
  });
  const emptyStopped = reduce(
    initial,
    {
      cwd: "/workspace",
      hook_event_name: "Stop",
      session_id: "session",
      turn_id: "turn",
    },
    100,
  );
  assert.equal(emptyStopped.phase, "Ready");

  const complete = structuredClone(initial);
  complete.plan = [{ step: "Done", status: "completed" }];
  complete.hasPlan = true;
  const completeStopped = reduce(
    complete,
    {
      cwd: "/workspace",
      hook_event_name: "Stop",
      session_id: "session",
      turn_id: "turn",
    },
    100,
  );
  assert.equal(completeStopped.phase, "Completed");
  assert.equal(completeStopped.phaseInferred, false);
});

/**
 * @param {ReturnType<typeof createInitialState>} state
 * @param {Record<string, unknown>} hook
 * @param {number} time
 */
function reduce(state, hook, time) {
  const event = normalizeHookInput(hook, {
    id: () => `event-${time}`,
    now: () => time,
  });
  assert.ok(event);
  return reduceHudState(state, event);
}

/**
 * @param {string} event
 * @param {string} id
 * @param {string} tool
 * @param {string} [command]
 */
function toolHook(event, id, tool, command) {
  return {
    cwd: "/workspace",
    hook_event_name: event,
    session_id: "session",
    tool_input: command ? { command } : { path: "src/app.mjs" },
    tool_name: tool,
    tool_response: "ok",
    tool_use_id: id,
    turn_id: "turn",
  };
}

test("hook normalization rejects incomplete records", () => {
  assert.equal(normalizeHookInput({}, deterministic), null);
});
