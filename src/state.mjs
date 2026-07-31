/**
 * @typedef {import("./events.mjs").PlanItem} PlanItem
 * @typedef {import("./events.mjs").HudEvent} HudEvent
 */

/**
 * @param {{launchId: string, cwd: string, startedAtMs: number}} meta
 */
export function createInitialState(meta) {
  return {
    version: 1,
    launchId: meta.launchId,
    sessionId: /** @type {string | null} */ (null),
    turnId: /** @type {string | null} */ (null),
    cwd: meta.cwd,
    model: /** @type {string | null} */ (null),
    task: /** @type {string | null} */ (null),
    startedAtMs: meta.startedAtMs,
    lastEventAtMs: meta.startedAtMs,
    plan: /** @type {PlanItem[]} */ ([]),
    hasPlan: false,
    activeTools: /** @type {Array<Record<string, any>>} */ ([]),
    pendingPlans: /** @type {Record<string, PlanItem[]>} */ ({}),
    finishedTools: /** @type {Record<string, number>} */ ({}),
    hasEdited: false,
    compacting: false,
    waitingApproval: false,
    runState: "Starting",
    currentAction: "Starting Codex",
    phase: "Planning",
    phaseInferred: true,
    lastCategory: "planning",
  };
}

/**
 * @param {ReturnType<typeof createInitialState>} state
 * @param {HudEvent} event
 */
export function reduceHudState(state, event) {
  const next = structuredClone(state);
  next.lastEventAtMs = Math.max(next.lastEventAtMs, event.observedAtMs);
  next.sessionId = event.sessionId || next.sessionId;
  next.turnId = event.turnId ?? next.turnId;

  switch (event.kind) {
    case "session.start":
      next.cwd = event.data.cwd || next.cwd;
      next.model = event.data.model || next.model;
      if (event.data.source !== "compact") {
        next.runState = "Starting";
        next.currentAction = "Starting Codex";
        next.lastCategory = "planning";
      }
      break;

    case "session.end":
      next.activeTools = [];
      next.runState = "Ended";
      next.currentAction = "Session ended";
      next.phase = next.hasPlan && allPlanItemsCompleted(next.plan)
        ? "Completed"
        : "Ready";
      return next;

    case "turn.prompt":
      next.task = event.data.task || "Untitled task";
      next.plan = [];
      next.hasPlan = false;
      next.activeTools = [];
      next.pendingPlans = {};
      next.finishedTools = {};
      next.hasEdited = false;
      next.compacting = false;
      next.waitingApproval = false;
      next.runState = "Working";
      next.currentAction = "Planning";
      next.lastCategory = "planning";
      break;

    case "tool.start": {
      const id = event.data.toolUseId;
      const finishedAt = next.finishedTools[id];
      if (finishedAt !== undefined && finishedAt >= event.observedAtMs) {
        break;
      }

      next.activeTools = next.activeTools.filter(
        (tool) => tool.toolUseId !== id,
      );
      next.activeTools.push({
        ...event.data.action,
        observedAtMs: event.observedAtMs,
        toolName: event.data.toolName,
        toolUseId: id,
      });
      if (event.data.planCandidate) {
        next.pendingPlans[id] = event.data.planCandidate;
      }
      if (event.data.action.category === "coding") {
        next.hasEdited = true;
      }
      next.lastCategory = event.data.action.category;
      next.waitingApproval = false;
      next.runState = "Working";
      break;
    }

    case "tool.finish": {
      const id = event.data.toolUseId;
      next.activeTools = next.activeTools.filter(
        (tool) => tool.toolUseId !== id,
      );
      next.finishedTools[id] = event.observedAtMs;
      pruneFinishedTools(next.finishedTools);

      const confirmedPlan =
        event.data.planCandidate ?? next.pendingPlans[id] ?? null;
      if (event.data.toolName === "update_plan" && confirmedPlan) {
        next.plan = confirmedPlan;
        next.hasPlan = confirmedPlan.length > 0;
      }
      delete next.pendingPlans[id];
      next.lastCategory = event.data.action.category;
      next.waitingApproval = false;
      next.runState = "Thinking";
      break;
    }

    case "approval.wait":
      next.waitingApproval = true;
      next.runState = "Waiting";
      next.currentAction = formatAction(event.data.action);
      break;

    case "compact.start":
      next.compacting = true;
      next.runState = "Working";
      next.currentAction = "Compacting context";
      break;

    case "compact.finish":
      next.compacting = false;
      next.runState = "Thinking";
      next.currentAction = "Thinking";
      break;

    case "turn.stop":
      next.activeTools = [];
      next.pendingPlans = {};
      next.waitingApproval = false;
      next.compacting = false;
      if (next.hasPlan && allPlanItemsCompleted(next.plan)) {
        next.runState = "Completed";
        next.currentAction = "Completed";
        next.phase = "Completed";
        next.phaseInferred = false;
      } else {
        next.runState = "Ready";
        next.currentAction = "Ready";
        next.phase = "Ready";
        next.phaseInferred = false;
      }
      return next;

    default:
      return state;
  }

  refreshDerivedPresentation(next);
  return next;
}

/**
 * @param {ReturnType<typeof createInitialState>} state
 */
function refreshDerivedPresentation(state) {
  if (state.compacting) {
    state.currentAction = "Compacting context";
    state.phase = "Working";
    state.phaseInferred = true;
    return;
  }

  if (state.waitingApproval) {
    state.phase = categoryPhase(state.lastCategory, state.hasEdited);
    state.phaseInferred = true;
    return;
  }

  const active = latestActiveTool(state.activeTools);
  if (active) {
    state.currentAction = formatAction(active);
    state.phase = categoryPhase(active.category, state.hasEdited);
    state.phaseInferred = true;
    return;
  }

  state.currentAction =
    state.runState === "Thinking"
      ? "Thinking"
      : state.runState === "Starting"
        ? "Starting Codex"
        : state.currentAction;
  state.phase = categoryPhase(state.lastCategory, state.hasEdited);
  state.phaseInferred = true;
}

/**
 * @param {string} category
 * @param {boolean} hasEdited
 */
function categoryPhase(category, hasEdited) {
  switch (category) {
    case "planning":
      return "Planning";
    case "searching":
      return "Searching";
    case "coding":
      return "Coding";
    case "testing":
      return "Testing";
    case "review":
      return hasEdited ? "Review" : "Searching";
    default:
      return "Working";
  }
}

/**
 * @param {Array<Record<string, any>>} activeTools
 */
function latestActiveTool(activeTools) {
  return activeTools.reduce(
    (latest, tool) =>
      latest === null || tool.observedAtMs > latest.observedAtMs
        ? tool
        : latest,
    /** @type {Record<string, any> | null} */ (null),
  );
}

/**
 * @param {{label?: string, detail?: string}} action
 */
export function formatAction(action) {
  const label = action.label || "Working";
  return action.detail ? `${label}: ${action.detail}` : label;
}

/**
 * @param {PlanItem[]} plan
 */
export function planProgress(plan) {
  const total = plan.length;
  const completed = plan.filter((item) => item.status === "completed").length;
  return {
    completed,
    total,
    percent: total === 0 ? null : Math.round((completed / total) * 100),
  };
}

/**
 * @param {PlanItem[]} plan
 */
export function allPlanItemsCompleted(plan) {
  return plan.length > 0 && plan.every((item) => item.status === "completed");
}

/**
 * @param {Record<string, number>} finishedTools
 */
function pruneFinishedTools(finishedTools) {
  const entries = Object.entries(finishedTools);
  if (entries.length <= 100) {
    return;
  }

  entries
    .sort((left, right) => right[1] - left[1])
    .slice(100)
    .forEach(([id]) => delete finishedTools[id]);
}
