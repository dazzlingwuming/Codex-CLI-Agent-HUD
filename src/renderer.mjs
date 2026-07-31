import {
  readEventFiles,
  readRunMeta,
  validateRunDirectory,
} from "./run-directory.mjs";
import {
  createInitialState,
  planProgress,
  reduceHudState,
} from "./state.mjs";
import {
  fitDisplay,
  formatDuration,
} from "./terminal.mjs";

const ANSI = {
  boldCyan: "\u001b[1;36m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  reset: "\u001b[0m",
  yellow: "\u001b[33m",
};

/**
 * @param {ReturnType<typeof createInitialState>} state
 * @param {{width: number, height: number, color?: boolean, now?: number}} options
 */
export function renderHud(
  state,
  {
    width,
    height,
    color = true,
    now = Date.now(),
  },
) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const full = safeHeight >= 6 && safeWidth >= 80;
  const lines = full
    ? renderFull(state, safeWidth, now)
    : renderCompact(state, safeWidth, now);

  while (lines.length < safeHeight) {
    lines.push("");
  }

  return lines
    .slice(0, safeHeight)
    .map((line) => colorize(fitDisplay(line, safeWidth), color));
}

/**
 * @param {ReturnType<typeof createInitialState>} state
 * @param {number} width
 * @param {number} now
 */
function renderFull(state, width, now) {
  const progress = progressText(state.plan);
  const phase = `${state.phaseInferred ? "~" : ""}${state.phase}`;
  const duration = formatDuration(now - state.startedAtMs);
  const task = state.task ?? "Waiting for first prompt";
  const plan = selectPlanWindow(state.plan, 3);
  const planLines =
    plan.items.length === 0
      ? ["Todo     — No plan provided"]
      : plan.items.map((item, index) => {
          const label = index === 0 ? "Todo    " : "        ";
          const suffix =
            index === plan.items.length - 1 && plan.hidden > 0
              ? `  (+${plan.hidden} more)`
              : "";
          return `${label} ${planSymbol(item.status)} ${item.step}${suffix}`;
        });

  while (planLines.length < 3) {
    planLines.push("");
  }

  return [
    `Codex HUD  Task: ${task}`,
    `Status     ${phase} · ${progress} · ${duration}`,
    `Current    ${state.currentAction}`,
    ...planLines,
  ].map((line) => fitDisplay(line, width));
}

/**
 * @param {ReturnType<typeof createInitialState>} state
 * @param {number} width
 * @param {number} now
 */
function renderCompact(state, width, now) {
  const phase = `${state.phaseInferred ? "~" : ""}${state.phase}`;
  const duration = formatDuration(now - state.startedAtMs);
  return [
    `HUD · ${phase} · ${progressText(state.plan)} · ${duration}`,
    `Task: ${state.task ?? "Waiting for first prompt"}`,
    `Current: ${state.currentAction}`,
  ].map((line) => fitDisplay(line, width));
}

/**
 * @param {Array<{step: string, status: string}>} plan
 */
function progressText(plan) {
  const progress = planProgress(
    /** @type {Array<{step: string, status: "pending" | "inProgress" | "completed"}>} */ (
      plan
    ),
  );
  return progress.percent === null
    ? "Progress —"
    : `${progress.completed}/${progress.total} ${progress.percent}%`;
}

/**
 * @param {Array<{step: string, status: string}>} plan
 * @param {number} limit
 */
export function selectPlanWindow(plan, limit) {
  if (plan.length <= limit) {
    return { hidden: 0, items: plan };
  }

  let focus = plan.findIndex((item) => item.status === "inProgress");
  if (focus < 0) {
    focus = plan.findIndex((item) => item.status === "pending");
  }
  if (focus < 0) {
    focus = plan.length - 1;
  }

  const start = Math.min(
    Math.max(0, focus - 1),
    Math.max(0, plan.length - limit),
  );
  return {
    hidden: plan.length - limit,
    items: plan.slice(start, start + limit),
  };
}

/**
 * @param {string} status
 */
function planSymbol(status) {
  switch (status) {
    case "completed":
      return "✓";
    case "inProgress":
      return "●";
    default:
      return "○";
  }
}

/**
 * @param {string} line
 * @param {boolean} enabled
 */
function colorize(line, enabled) {
  if (!enabled) {
    return line;
  }

  let output = line
    .replace(/^Codex HUD/u, `${ANSI.boldCyan}Codex HUD${ANSI.reset}`)
    .replace(/^HUD/u, `${ANSI.boldCyan}HUD${ANSI.reset}`)
    .replace(
      /^(Status|Current|Todo)(\s+)/u,
      `${ANSI.dim}$1${ANSI.reset}$2`,
    )
    .replace(/^(\s*)✓/u, `$1${ANSI.green}✓${ANSI.reset}`)
    .replace(/^(\s*)●/u, `$1${ANSI.yellow}●${ANSI.reset}`);
  if (!output.endsWith(ANSI.reset)) {
    output += ANSI.reset;
  }
  return output;
}

/**
 * @param {string} runDirectory
 * @param {ReturnType<typeof createInitialState>} state
 * @param {Set<string>} seen
 */
export function replayNewEvents(runDirectory, state, seen) {
  let next = state;
  for (const { name, event } of readEventFiles(runDirectory)) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    if (
      event.version !== 1 ||
      typeof event.kind !== "string" ||
      typeof event.observedAtMs !== "number"
    ) {
      continue;
    }
    try {
      next = reduceHudState(
        next,
        /** @type {import("./events.mjs").HudEvent} */ (event),
      );
    } catch {
      // Malformed or future-version events degrade only the HUD.
    }
  }
  return next;
}

/**
 * @param {{
 *   runDirectory: string,
 *   env?: NodeJS.ProcessEnv,
 *   stdout?: NodeJS.WriteStream,
 *   intervalMs?: number
 * }} options
 */
export async function runRenderer({
  runDirectory,
  env = process.env,
  stdout = process.stdout,
  intervalMs = 100,
}) {
  if (!validateRunDirectory(runDirectory, env)) {
    throw new Error("HUD run directory is invalid or no longer available.");
  }
  const meta = readRunMeta(runDirectory);
  if (
    !meta ||
    typeof meta.launchId !== "string" ||
    typeof meta.cwd !== "string" ||
    typeof meta.startedAtMs !== "number"
  ) {
    throw new Error("HUD run metadata is invalid.");
  }

  let state = createInitialState({
    cwd: meta.cwd,
    launchId: meta.launchId,
    startedAtMs: meta.startedAtMs,
  });
  const seen = new Set();
  let stopped = false;
  let rendering = false;

  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);

  stdout.write("\u001b[?25l\u001b[2J");
  try {
    while (!stopped) {
      if (!rendering) {
        rendering = true;
        state = replayNewEvents(runDirectory, state, seen);
        const frame = renderHud(state, {
          color: env.NO_COLOR === undefined,
          height: stdout.rows || 3,
          width: stdout.columns || 80,
        });
        stdout.write(`\u001b[H${frame.join("\r\n")}\u001b[J`);
        rendering = false;
      }
      await delay(intervalMs);
    }
  } finally {
    stdout.write("\u001b[?25h");
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGHUP", stop);
  }
  return 0;
}

/**
 * @param {number} milliseconds
 */
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
