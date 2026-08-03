import {
  readControlFiles,
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
  copyActionLayout,
} from "./copy-action.mjs";
import {
  fitDisplay,
  formatDuration,
} from "./terminal.mjs";
import { resizeHudPane } from "./tmux-host.mjs";

const ANSI = {
  boldCyan: "\u001b[1;36m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  reset: "\u001b[0m",
  yellow: "\u001b[33m",
};

/**
 * @typedef {{
 *   expanded: boolean,
 *   copyActionControls: boolean,
 * }} HudControls
 */

/**
 * @param {{
 *   expanded?: boolean,
 *   copyActionControls?: boolean,
 * }} [options]
 * @returns {HudControls}
 */
export function createHudControls({
  expanded = false,
  copyActionControls = false,
} = {}) {
  return {
    expanded: expanded === true,
    copyActionControls: copyActionControls === true,
  };
}

/**
 * @param {unknown} control
 */
function isTodoToggleControl(control) {
  if (!control || typeof control !== "object") {
    return false;
  }
  const candidate = /** @type {Record<string, unknown>} */ (control);
  return (
    candidate.version === 1 &&
    candidate.kind === "todo.toggle" &&
    typeof candidate.observedAtMs === "number" &&
    Number.isFinite(candidate.observedAtMs)
  );
}

/**
 * @param {HudControls} controls
 * @param {unknown} control
 * @returns {HudControls}
 */
export function reduceHudControls(controls, control) {
  if (isTodoToggleControl(control)) {
    return { ...controls, expanded: !controls.expanded };
  }
  return controls;
}

/**
 * @param {ReturnType<typeof createInitialState>} state
 * @param {{
 *   width: number,
 *   height: number,
 *   color?: boolean,
 *   expanded?: boolean,
 *   now?: number,
 *   copyActionControls?: boolean,
 * }} options
 */
export function renderHud(
  state,
  {
    width,
    height,
    color = true,
    expanded = false,
    now = Date.now(),
    copyActionControls = false,
  },
) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const controls = createHudControls({
    expanded,
    copyActionControls,
  });
  const full =
    safeHeight >= 6 && safeWidth >= (controls.expanded ? 50 : 80);
  const lines = full
    ? renderFull(state, safeWidth, safeHeight, now, controls)
    : renderCompact(state, safeWidth, now, controls);

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
 * @param {number} height
 * @param {number} now
 * @param {HudControls} controls
 */
function renderFull(state, width, height, now, controls) {
  const progress = progressText(state.plan);
  const phase = `${state.phaseInferred ? "~" : ""}${state.phase}`;
  const duration = formatDuration(now - state.startedAtMs);
  const task = state.task ?? "Waiting for first prompt";
  const planLimit = controls.expanded ? Math.max(1, height - 4) : 3;
  const plan = selectPlanWindow(state.plan, planLimit);
  const planLines =
    plan.items.length === 0
      ? ["Todo     — No plan provided"]
      : plan.items.map((item, index) => {
          const label = index === 0 ? "Todo    " : "        ";
          const suffix =
            !controls.expanded &&
            index === plan.items.length - 1 &&
            plan.hidden > 0
              ? `  (+${plan.hidden} more · click)`
              : "";
          return `${label} ${planSymbol(item.status)} ${item.step}${suffix}`;
        });

  if (!controls.expanded) {
    while (planLines.length < 3) {
      planLines.push("");
    }
  }

  const lines = [
    renderHeader(
      `Codex HUD  Task: ${task}`,
      width,
      controls,
    ),
    `Status     ${phase} · ${progress} · ${duration}`,
    `Current    ${state.currentAction}`,
    ...planLines,
  ];
  if (controls.expanded) {
    lines.push(
      plan.hidden > 0
        ? `         ▲ click to collapse · ${plan.hidden} hidden by terminal height`
        : "         ▲ click to collapse",
    );
  }
  return lines.map((line) => fitDisplay(line, width));
}

/**
 * @param {ReturnType<typeof createInitialState>} state
 * @param {number} width
 * @param {number} now
 * @param {HudControls} controls
 */
function renderCompact(state, width, now, controls) {
  const phase = `${state.phaseInferred ? "~" : ""}${state.phase}`;
  const duration = formatDuration(now - state.startedAtMs);
  return [
    renderHeader(
      `HUD · ${phase} · ${progressText(state.plan)} · ${duration}`,
      width,
      controls,
    ),
    `Task: ${state.task ?? "Waiting for first prompt"}`,
    `Current: ${state.currentAction}`,
  ].map((line) => fitDisplay(line, width));
}

/**
 * Keep the action's visible layout and click geometry in the shared
 * copy-action contract. The left header uses only the remaining display
 * columns, so CJK task text cannot overlap the right-aligned controls.
 *
 * @param {string} left
 * @param {number} width
 * @param {HudControls} controls
 */
function renderHeader(left, width, controls) {
  const layout = controls.copyActionControls
    ? copyActionLayout(width)
    : null;
  return layout
    ? `${fitDisplay(left, layout.startColumn)}${layout.text}`
    : left;
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
 * @param {string} runDirectory
 * @param {Set<string>} seen
 * @param {HudControls} controls
 */
export function replayNewControls(
  runDirectory,
  seen,
  controls = createHudControls(),
) {
  let next = controls;
  for (const { name, control } of readControlFiles(runDirectory)) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    next = reduceHudControls(next, control);
  }
  return next;
}

/**
 * Build the smallest revision key that can change the visible HUD.
 *
 * Event files are still polled more frequently than once per second, while the
 * elapsed-time display advances only on whole-second boundaries.
 *
 * @param {{
 *   eventCount: number,
 *   controlCount?: number,
 *   expanded?: boolean,
 *   height: number,
 *   now: number,
 *   copyActionControls?: boolean,
 *   width: number,
 * }} input
 */
export function renderRevision({
  eventCount,
  controlCount = 0,
  expanded = false,
  width,
  height,
  now,
  copyActionControls = false,
}) {
  const base = `${eventCount}:${controlCount}:${expanded}:${width}:${height}:${Math.floor(now / 1_000)}`;
  return copyActionControls === true && copyActionLayout(width)
    ? `${base}:copy-action`
    : base;
}

/**
 * Render only lines whose final display content changed.
 *
 * @param {string[] | undefined} previous
 * @param {string[]} next
 */
export function diffFrame(previous, next) {
  return next
    .flatMap((line, index) =>
      previous?.[index] === line
        ? []
        : [`\u001b[${index + 1};1H\u001b[2K${line}`],
    )
    .join("");
}

/**
 * @param {{
 *   runDirectory: string,
 *   env?: NodeJS.ProcessEnv,
 *   copyActionControls?: boolean,
 *   stdout?: NodeJS.WriteStream,
 *   intervalMs?: number,
 *   resize?: typeof resizeHudPane
 * }} options
 */
export async function runRenderer({
  runDirectory,
  env = process.env,
  copyActionControls = false,
  stdout = process.stdout,
  intervalMs = 100,
  resize = resizeHudPane,
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
  const seenControls = new Set();
  const seenEvents = new Set();
  let controls = createHudControls({
    copyActionControls,
  });
  let previousFrame;
  let previousLayoutRevision;
  let stopped = false;
  let previousRevision;

  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);

  stdout.write("\u001b[2J");
  try {
    while (!stopped) {
      state = replayNewEvents(runDirectory, state, seenEvents);
      controls = replayNewControls(
        runDirectory,
        seenControls,
        controls,
      );

      const layoutRevision = `${controls.expanded}:${state.plan.length}`;
      if (layoutRevision !== previousLayoutRevision) {
        try {
          resize({
            env,
            expanded: controls.expanded,
            planLength: state.plan.length,
          });
        } catch {
          // A resize failure degrades expansion without stopping the HUD.
        }
        previousLayoutRevision = layoutRevision;
      }

      const now = Date.now();
      const height = stdout.rows || 3;
      const width = stdout.columns || 80;
      const revision = renderRevision({
        controlCount: seenControls.size,
        eventCount: seenEvents.size,
        expanded: controls.expanded,
        height,
        now,
        copyActionControls: controls.copyActionControls,
        width,
      });

      if (revision !== previousRevision) {
        const frame = renderHud(state, {
          color: env.NO_COLOR === undefined,
          expanded: controls.expanded,
          height,
          now,
          copyActionControls: controls.copyActionControls,
          width,
        });
        const output = diffFrame(previousFrame, frame);
        if (output) {
          stdout.write(output);
        }
        previousFrame = frame;
        previousRevision = revision;
      }
      await delay(intervalMs);
    }
  } finally {
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
