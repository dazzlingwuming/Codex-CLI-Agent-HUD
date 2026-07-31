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
 * @param {ReturnType<typeof createInitialState>} state
 * @param {{width: number, height: number, color?: boolean, expanded?: boolean, now?: number}} options
 */
export function renderHud(
  state,
  {
    width,
    height,
    color = true,
    expanded = false,
    now = Date.now(),
  },
) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const full =
    safeHeight >= 6 && safeWidth >= (expanded ? 50 : 80);
  const lines = full
    ? renderFull(state, safeWidth, safeHeight, now, expanded)
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
 * @param {number} height
 * @param {number} now
 * @param {boolean} expanded
 */
function renderFull(state, width, height, now, expanded) {
  const progress = progressText(state.plan);
  const phase = `${state.phaseInferred ? "~" : ""}${state.phase}`;
  const duration = formatDuration(now - state.startedAtMs);
  const task = state.task ?? "Waiting for first prompt";
  const planLimit = expanded ? Math.max(1, height - 4) : 3;
  const plan = selectPlanWindow(state.plan, planLimit);
  const planLines =
    plan.items.length === 0
      ? ["Todo     — No plan provided"]
      : plan.items.map((item, index) => {
          const label = index === 0 ? "Todo    " : "        ";
          const suffix =
            !expanded &&
            index === plan.items.length - 1 &&
            plan.hidden > 0
              ? `  (+${plan.hidden} more · click)`
              : "";
          return `${label} ${planSymbol(item.status)} ${item.step}${suffix}`;
        });

  if (!expanded) {
    while (planLines.length < 3) {
      planLines.push("");
    }
  }

  const lines = [
    `Codex HUD  Task: ${task}`,
    `Status     ${phase} · ${progress} · ${duration}`,
    `Current    ${state.currentAction}`,
    ...planLines,
  ];
  if (expanded) {
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
 * @param {string} runDirectory
 * @param {Set<string>} seen
 * @param {boolean} expanded
 */
export function replayNewControls(runDirectory, seen, expanded) {
  let next = expanded;
  for (const { name, control } of readControlFiles(runDirectory)) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    if (
      control.version === 1 &&
      control.kind === "todo.toggle" &&
      typeof control.observedAtMs === "number"
    ) {
      next = !next;
    }
  }
  return next;
}

/**
 * Build the smallest revision key that can change the visible HUD.
 *
 * Event files are still polled more frequently than once per second, while the
 * elapsed-time display advances only on whole-second boundaries.
 *
 * @param {{eventCount: number, controlCount?: number, expanded?: boolean, width: number, height: number, now: number}} input
 */
export function renderRevision({
  eventCount,
  controlCount = 0,
  expanded = false,
  width,
  height,
  now,
}) {
  return `${eventCount}:${controlCount}:${expanded}:${width}:${height}:${Math.floor(now / 1_000)}`;
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
 *   stdout?: NodeJS.WriteStream,
 *   intervalMs?: number,
 *   resize?: typeof resizeHudPane
 * }} options
 */
export async function runRenderer({
  runDirectory,
  env = process.env,
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
  let expanded = false;
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
      expanded = replayNewControls(
        runDirectory,
        seenControls,
        expanded,
      );

      const layoutRevision = `${expanded}:${state.plan.length}`;
      if (layoutRevision !== previousLayoutRevision) {
        try {
          resize({
            env,
            expanded,
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
        expanded,
        height,
        now,
        width,
      });

      if (revision !== previousRevision) {
        const frame = renderHud(state, {
          color: env.NO_COLOR === undefined,
          expanded,
          height,
          now,
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
