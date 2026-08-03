import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  spawn,
  spawnSync,
} from "node:child_process";

import {
  CODEX_BINARY_ENV,
  NATIVE_STATUS_LINE,
  RUN_DIRECTORY_ENV,
} from "./constants.mjs";
import { quoteShellArgument } from "./hooks-config.mjs";
import {
  consumeRunJson,
  createRunDirectory,
  readRunJson,
  removeRunDirectory,
  writeRunJson,
} from "./run-directory.mjs";
import {
  DEFAULT_INTERACTION_MODE,
  isInteractionMode,
  supportsSelectionControls,
} from "./interaction-mode.mjs";

const HUD_INTERACTION_MODE_OPTION = "@codex_hud_interaction_mode";
const COPY_MODE_TABLES = Object.freeze(["copy-mode", "copy-mode-vi"]);

/**
 * @param {string[]} args
 */
export function withNativeStatusLine(args) {
  if (hasStatusLineOverride(args)) {
    return [...args];
  }
  return [
    "-c",
    `tui.status_line=${JSON.stringify(NATIVE_STATUS_LINE)}`,
    ...args,
  ];
}

/**
 * @param {string[]} args
 */
export function hasStatusLineOverride(args) {
  return args.some(
    (value, index) =>
      value.startsWith("tui.status_line=") ||
      value.startsWith("--config=tui.status_line=") ||
      ((value === "-c" || value === "--config") &&
        args[index + 1]?.startsWith("tui.status_line=")),
  );
}

/**
 * Keep Codex on the primary screen so tmux and the outer terminal can retain
 * scrollback. An explicit user alternate-screen setting always wins.
 *
 * @param {string[]} args
 */
export function withScrollableScreen(args) {
  if (hasAlternateScreenOverride(args)) {
    return [...args];
  }
  return ["--no-alt-screen", ...args];
}

/**
 * Disable Codex's active status/spinner/shimmer animations inside HUD
 * sessions. These high-frequency updates can make terminal multiplexers
 * visibly flicker in embedded terminal emulators.
 *
 * @param {string[]} args
 */
export function withStaticAnimations(args) {
  if (hasAnimationsOverride(args)) {
    return [...args];
  }
  return ["-c", "tui.animations=false", ...args];
}

/**
 * @param {string[]} args
 */
export function hasAnimationsOverride(args) {
  return args.some(
    (value, index) =>
      value.startsWith("tui.animations=") ||
      value.startsWith("--config=tui.animations=") ||
      ((value === "-c" || value === "--config") &&
        args[index + 1]?.startsWith("tui.animations=")),
  );
}

/**
 * @param {string[]} args
 */
export function hasAlternateScreenOverride(args) {
  return args.some(
    (value, index) =>
      value === "--no-alt-screen" ||
      value.startsWith("tui.alternate_screen=") ||
      value.startsWith("--config=tui.alternate_screen=") ||
      ((value === "-c" || value === "--config") &&
        args[index + 1]?.startsWith("tui.alternate_screen=")),
  );
}

/**
 * @param {string[]} args
 */
export function withHudTuiDefaults(args) {
  return withNativeStatusLine(
    withScrollableScreen(withStaticAnimations(args)),
  );
}

/**
 * @param {number} rows
 * @param {number} columns
 */
export function chooseHudHeight(rows, columns) {
  if (rows < 14 || columns < 50) {
    throw new Error(
      "Terminal is too small for Codex HUD; use at least 50 columns and 14 rows.",
    );
  }
  return rows >= 22 && columns >= 80 ? 6 : 3;
}

/**
 * @param {number} rows
 * @param {number} columns
 * @param {number} planLength
 * @param {boolean} expanded
 */
export function chooseHudViewHeight(
  rows,
  columns,
  planLength,
  expanded,
) {
  const collapsedHeight = chooseHudHeight(rows, columns);
  if (!expanded) {
    return collapsedHeight;
  }

  const maximumHeight = Math.max(collapsedHeight, rows - 10);
  if (maximumHeight < 6) {
    return collapsedHeight;
  }
  const requestedHeight = Math.max(6, 4 + Math.max(1, planLength));
  return Math.min(requestedHeight, maximumHeight);
}

/**
 * @param {{
 *   codexArgs: string[],
 *   cwd?: string,
 *   entryPath: string,
 *   env?: NodeJS.ProcessEnv,
 *   stdin?: NodeJS.ReadStream,
 *   stdout?: NodeJS.WriteStream,
 *   stderr?: NodeJS.WriteStream
 * }} options
 */
export async function runHud({
  codexArgs,
  cwd = process.cwd(),
  entryPath,
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Codex HUD requires an interactive TTY.");
  }
  if (process.platform !== "darwin") {
    throw new Error("Codex HUD v0.1 supports macOS only.");
  }

  const launchId = randomUUID();
  const ownsTmuxServer = !(env.TMUX && env.TMUX_PANE);
  const selectionControls = supportsSelectionControls({
    env,
    ownsTmuxServer,
  });
  const runDirectoryOptions = {
    cwd,
    env,
    launchId,
    ownsTmuxServer,
    selectionControls,
  };
  const runDirectory = createRunDirectory(runDirectoryOptions);
  const launch = {
    codexArgs,
    codexBin: env[CODEX_BINARY_ENV] || "codex",
    cwd,
    entryPath: path.resolve(entryPath),
    launchId,
    ownsTmuxServer,
  };
  writeRunJson(runDirectory, "launch.json", launch, env);

  try {
    if (env.TMUX && env.TMUX_PANE) {
      return await runInsideTmux({
        env: { ...env, [RUN_DIRECTORY_ENV]: runDirectory },
        runDirectory,
        stderr,
      });
    }
    return launchIsolatedTmux({
      entryPath: launch.entryPath,
      env,
      runDirectory,
      stderr,
    });
  } finally {
    removeRunDirectory(runDirectory, env);
  }
}

/**
 * @param {{
 *   entryPath: string,
 *   env: NodeJS.ProcessEnv,
 *   runDirectory: string,
 *   stderr: {write(value: string): unknown}
 * }} options
 */
function launchIsolatedTmux({
  entryPath,
  env,
  runDirectory,
  stderr,
}) {
  const meta = readRunJson(runDirectory, "launch.json", env);
  const launchId =
    typeof meta?.launchId === "string"
      ? meta.launchId
      : path.basename(runDirectory).replace(/^run-/u, "");
  const launchCwd =
    typeof meta?.cwd === "string" ? meta.cwd : process.cwd();
  const socketName = `codex-hud-${launchId.slice(0, 12)}`;
  const command = [
    quoteShellArgument(process.execPath),
    quoteShellArgument(entryPath),
    "__inside",
    quoteShellArgument(runDirectory),
  ].join(" ");
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = {
    ...env,
    [RUN_DIRECTORY_ENV]: runDirectory,
  };
  delete childEnv.TMUX;
  delete childEnv.TMUX_PANE;

  const result = (() => {
    try {
      return spawnSync(
        "tmux",
        [
          "-L",
          socketName,
          ...tmuxClientFeatureArgs(childEnv),
          "-f",
          "/dev/null",
          "start-server",
          ";",
          "set-option",
          "-g",
          "status",
          "off",
          ";",
          "set-option",
          "-g",
          "default-terminal",
          "tmux-256color",
          ";",
          "set-option",
          "-g",
          "history-limit",
          "100000",
          ";",
          "set-option",
          "-g",
          "mouse",
          "on",
          ";",
          "set-option",
          "-g",
          "set-clipboard",
          "off",
          ";",
          "set-option",
          "-g",
          "copy-command",
          "",
          ";",
          "new-session",
          "-s",
          "hud",
          "-c",
          escapeTmuxFormat(launchCwd),
          command,
        ],
        {
          encoding: "utf8",
          env: childEnv,
          stdio: "inherit",
        },
      );
    } finally {
      cleanupIsolatedTmux(socketName, childEnv);
    }
  })();

  const exitRecord = readRunJson(runDirectory, "exit.json", env);
  if (typeof exitRecord?.code === "number") {
    return exitRecord.code;
  }
  if (result.error) {
    stderr.write(`codex-hud: tmux failed: ${result.error.message}\n`);
    return 2;
  }
  return typeof result.status === "number" ? result.status : 2;
}

/**
 * JetBrains Terminal 2025.3.2+ supports synchronized output, but presents
 * itself as a generic xterm terminal that tmux cannot identify automatically.
 * Advertise only the missing client feature for this isolated HUD client.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function tmuxClientFeatureArgs(env = process.env) {
  const identity = [
    env.TERM_PROGRAM,
    env.TERMINAL_EMULATOR,
    env.__CFBundleIdentifier,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /jetbrains|jediterm|pycharm|intellij/u.test(identity)
    ? ["-T", "sync"]
    : [];
}

/**
 * Read the HUD interaction mode stored locally on a tmux session.
 * Missing or malformed values are deliberately treated as the safe HUD
 * default rather than being exposed to event handlers.
 *
 * @param {string} sessionId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {"hud" | "copy"}
 */
export function readHudInteractionMode(sessionId, env = process.env) {
  const value = tmuxOutput(
    [
      "show-options",
      "-qv",
      "-t",
      sessionId,
      HUD_INTERACTION_MODE_OPTION,
    ],
    env,
  ).trim();
  return isInteractionMode(value) ? value : DEFAULT_INTERACTION_MODE;
}

/**
 * Set the HUD interaction mode locally on a tmux session. Mouse support is
 * intentionally kept enabled in both modes because HUD controls remain
 * clickable in copy mode.
 *
 * @param {string} sessionId
 * @param {unknown} mode
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {"hud" | "copy"}
 */
export function setHudInteractionMode(
  sessionId,
  mode,
  env = process.env,
) {
  if (!isInteractionMode(mode)) {
    throw new Error(`Invalid HUD interaction mode: ${String(mode)}`);
  }
  tmuxChecked(["set-option", "-t", sessionId, "mouse", "on"], env);
  tmuxChecked(
    ["set-option", "-t", sessionId, HUD_INTERACTION_MODE_OPTION, mode],
    env,
  );
  return mode;
}

/**
 * Resolve the path tmux uses for a named `-L` socket.
 *
 * @param {string} socketName
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isolatedTmuxSocketPath(
  socketName,
  env = process.env,
) {
  const uid =
    typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join(
    env.TMUX_TMPDIR || "/tmp",
    `tmux-${uid}`,
    socketName,
  );
}

/**
 * Resize the renderer pane to the collapsed or expanded Todo layout.
 *
 * @param {{
 *   expanded: boolean,
 *   planLength: number,
 *   env?: NodeJS.ProcessEnv
 * }} options
 */
export function resizeHudPane({
  expanded,
  planLength,
  env = process.env,
}) {
  if (!env.TMUX_PANE) {
    return null;
  }

  const [rows, columns, currentHeight] = tmuxOutput(
    [
      "display-message",
      "-p",
      "-t",
      env.TMUX_PANE,
      "#{window_height} #{window_width} #{pane_height}",
    ],
    env,
  )
    .trim()
    .split(/\s+/u)
    .map(Number);
  const targetHeight = chooseHudViewHeight(
    rows,
    columns,
    planLength,
    expanded,
  );
  if (currentHeight !== targetHeight) {
    tmuxChecked(
      [
        "resize-pane",
        "-t",
        env.TMUX_PANE,
        "-y",
        String(targetHeight),
      ],
      env,
    );
  }
  return targetHeight;
}

/**
 * Stop only this launch's isolated server and remove its stale socket.
 *
 * @param {string} socketName
 * @param {NodeJS.ProcessEnv} env
 */
function cleanupIsolatedTmux(socketName, env) {
  spawnSync("tmux", ["-N", "-L", socketName, "kill-server"], {
    env,
    stdio: "ignore",
  });

  const socketPath = isolatedTmuxSocketPath(socketName, env);
  try {
    if (fs.lstatSync(socketPath).isSocket()) {
      fs.unlinkSync(socketPath);
    }
  } catch {
    // The server normally removes its own socket; cleanup is best-effort.
  }
}

/**
 * Runs inside the top tmux pane. This is exported for the hidden CLI command
 * and focused integration tests.
 *
 * @param {{
 *   runDirectory: string,
 *   env?: NodeJS.ProcessEnv,
 *   stderr?: {write(value: string): unknown}
 * }} options
 */
export async function runInsideTmux({
  runDirectory,
  env = process.env,
  stderr = process.stderr,
}) {
  const launch = consumeRunJson(runDirectory, "launch.json", env);
  if (
    !launch ||
    !Array.isArray(launch.codexArgs) ||
    typeof launch.codexBin !== "string" ||
    typeof launch.cwd !== "string" ||
    typeof launch.entryPath !== "string" ||
    typeof launch.ownsTmuxServer !== "boolean"
  ) {
    throw new Error("Codex HUD launch manifest is invalid.");
  }
  if (!env.TMUX_PANE) {
    throw new Error("The HUD host is not running inside a tmux pane.");
  }

  const dimensions = tmuxOutput(
    ["display-message", "-p", "-t", env.TMUX_PANE, "#{window_height} #{window_width}"],
    env,
  )
    .trim()
    .split(/\s+/u)
    .map(Number);
  const [rows, columns] = dimensions;
  const hudHeight = chooseHudHeight(rows, columns);
  const sessionId = tmuxOutput(
    ["display-message", "-p", "-t", env.TMUX_PANE, "#{session_id}"],
    env,
  ).trim();
  const ownsTmuxServer = launch.ownsTmuxServer;
  const interactionSnapshot =
    !ownsTmuxServer
      ? snapshotTmuxInteraction(sessionId, env.TMUX_PANE, env)
      : null;
  /** @type {string | null} */
  let hudPane = null;
  let exitCode = 2;
  try {
    tmuxChecked(["set-option", "-t", sessionId, "status", "off"], env);
    tmuxChecked(["set-option", "-t", sessionId, "mouse", "on"], env);
    tmuxChecked(
      [
        "set-option",
        "-w",
        "-t",
        env.TMUX_PANE,
        "history-limit",
        "100000",
      ],
      env,
    );
    tmuxChecked(
      ["set-option", "-w", "-t", env.TMUX_PANE, "remain-on-exit", "off"],
      env,
    );
    tmuxChecked(
      ["select-pane", "-t", env.TMUX_PANE, "-T", "Codex"],
      env,
    );
    if (ownsTmuxServer) {
      setHudInteractionMode(sessionId, DEFAULT_INTERACTION_MODE, env);
    }

    const rendererCommand = [
      quoteShellArgument(process.execPath),
      quoteShellArgument(launch.entryPath),
      "__render",
      quoteShellArgument(runDirectory),
    ].join(" ");
    hudPane = tmuxOutput(
      [
        "split-window",
        "-v",
        "-l",
        String(hudHeight),
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        env.TMUX_PANE,
        "-c",
        escapeTmuxFormat(launch.cwd),
        rendererCommand,
      ],
      env,
    ).trim();
    tmuxChecked(["select-pane", "-t", hudPane, "-T", "Codex HUD"], env);
    tmuxChecked(
      todoMouseBinding({
        codexPane: env.TMUX_PANE,
        entryPath: launch.entryPath,
        hudPane,
        runDirectory,
        usesInteractionModes: ownsTmuxServer,
      }),
      env,
    );
    if (ownsTmuxServer) {
      for (const binding of hudMouseBindings({
        codexPane: env.TMUX_PANE,
        entryPath: launch.entryPath,
        hudPane,
        runDirectory,
      })) {
        tmuxChecked(binding, env);
      }
    }
    tmuxChecked(["select-pane", "-t", env.TMUX_PANE], env);

    exitCode = await runCodexChild({
      args: withHudTuiDefaults(
        launch.codexArgs.filter((value) => typeof value === "string"),
      ),
      codexBin: launch.codexBin,
      cwd: launch.cwd,
      env: { ...env, [RUN_DIRECTORY_ENV]: runDirectory },
      stderr,
    });
    return exitCode;
  } finally {
    if (hudPane) {
      spawnSync("tmux", ["kill-pane", "-t", hudPane], {
        env,
        stdio: "ignore",
      });
    }
    if (interactionSnapshot) {
      try {
        restoreTmuxInteraction(
          interactionSnapshot,
          sessionId,
          env.TMUX_PANE,
          env,
        );
      } catch (error) {
        stderr.write(
          `codex-hud: tmux interaction restore degraded: ${errorMessage(error)}\n`,
        );
      }
    }
    writeRunJson(runDirectory, "exit.json", { code: exitCode }, env);
  }
}

/**
 * @param {{
 *   codexPane: string,
 *   entryPath: string,
 *   hudPane: string,
 *   runDirectory: string,
 *   usesInteractionModes: boolean,
 *   nodePath?: string
 * }} options
 */
export function todoMouseBinding({
  codexPane,
  entryPath,
  hudPane,
  runDirectory,
  usesInteractionModes,
  nodePath = process.execPath,
}) {
  const clickCommand = hudClickCommand({
    entryPath,
    nodePath,
    runDirectory,
  });
  const defaultMouseDown = "select-pane -t = \\; send-keys -M";
  const nonHudMouseDown = usesInteractionModes
    ? `if-shell -F ${copyModeMouseCondition(codexPane)} "select-pane -t =" "${defaultMouseDown}"`
    : defaultMouseDown;
  return [
    "bind-key",
    "-T",
    "root",
    "MouseDown1Pane",
    "if-shell",
    "-F",
    `#{==:#{mouse_pane},${hudPane}}`,
    hudClickHandler(clickCommand),
    nonHudMouseDown,
  ];
}

/**
 * Build the mouse policy for a HUD-owned tmux server. The session user option
 * is evaluated by tmux at event time, so switching modes needs no key-table
 * rewrite and mouse support can remain enabled for HUD controls.
 *
 * @param {{
 *   codexPane: string,
 *   entryPath: string,
 *   hudPane: string,
 *   runDirectory: string,
 *   nodePath?: string
 * }} options
 */
export function hudMouseBindings({
  codexPane,
  entryPath,
  hudPane,
  runDirectory,
  nodePath = process.execPath,
}) {
  const copyModeCondition = copyModeMouseCondition(codexPane);
  const clickHandler = hudClickHandler(
    hudClickCommand({ entryPath, nodePath, runDirectory }),
  );
  const bindings = [
    mouseEventBinding({
      fallback: `if-shell -F ${copyModeCondition} "select-pane -t =" 'if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" "send-keys -M" "copy-mode -M"'`,
      hudCommand: noOpMouseCommand(),
      hudPane,
      key: "MouseDrag1Pane",
      table: "root",
    }),
    rootWordSelectionBinding({
      codexPane,
      hudPane,
      key: "DoubleClick1Pane",
      selection: "select-word",
    }),
    rootWordSelectionBinding({
      codexPane,
      hudPane,
      key: "TripleClick1Pane",
      selection: "select-line",
    }),
  ];

  for (const table of COPY_MODE_TABLES) {
    bindings.push(
      copyModeMouseBinding({
        table,
        codexPane,
        clickHandler,
        hudPane,
        key: "MouseDown1Pane",
        hudCommand: "select-pane -t = \\; send-keys -X clear-selection",
      }),
      copyModeMouseBinding({
        table,
        codexPane,
        clickHandler,
        hudPane,
        key: "MouseDrag1Pane",
        hudCommand: "select-pane -t = \\; send-keys -X begin-selection",
      }),
      copyModeMouseBinding({
        table,
        codexPane,
        clickHandler,
        hudPane,
        key: "MouseDragEnd1Pane",
        hudCommand: "send-keys -X stop-selection",
      }),
      copyModeMouseBinding({
        table,
        codexPane,
        clickHandler,
        hudPane,
        key: "DoubleClick1Pane",
        hudCommand:
          "select-pane -t = \\; send-keys -X select-word \\; send-keys -X stop-selection",
      }),
      copyModeMouseBinding({
        table,
        codexPane,
        clickHandler,
        hudPane,
        key: "TripleClick1Pane",
        hudCommand:
          "select-pane -t = \\; send-keys -X select-line \\; send-keys -X stop-selection",
      }),
    );
  }
  return bindings;
}

/**
 * @param {{
 *   codexPane: string,
 *   hudPane: string,
 *   key: string,
 *   selection: "select-line" | "select-word"
 * }} options
 */
function rootWordSelectionBinding({ codexPane, hudPane, key, selection }) {
  return mouseEventBinding({
    fallback: `if-shell -F ${copyModeMouseCondition(codexPane)} "select-pane -t =" "select-pane -t = \\; if-shell -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' 'send-keys -M' 'copy-mode -H \\; send-keys -X ${selection} \\; send-keys -X stop-selection'"`,
    hudCommand: noOpMouseCommand(),
    hudPane,
    key,
    table: "root",
  });
}

/**
 * @param {{
 *   table: string,
 *   codexPane: string,
 *   clickHandler: string,
 *   hudPane: string,
 *   key: string,
 *   hudCommand: string
 * }} options
 */
function copyModeMouseBinding({
  table,
  codexPane,
  clickHandler,
  hudPane,
  key,
  hudCommand,
}) {
  return mouseEventBinding({
    fallback: `if-shell -F ${copyModeMouseCondition(codexPane)} "select-pane -t =" "${hudCommand}"`,
    hudCommand:
      key === "MouseDown1Pane" ? clickHandler : noOpMouseCommand(),
    hudPane,
    key,
    table,
  });
}

/**
 * @param {{
 *   fallback: string,
 *   hudCommand: string,
 *   hudPane: string,
 *   key: string,
 *   table: string
 * }} options
 */
function mouseEventBinding({ fallback, hudCommand, hudPane, key, table }) {
  return [
    "bind-key",
    "-T",
    table,
    key,
    "if-shell",
    "-F",
    hudMouseCondition(hudPane),
    hudCommand,
    fallback,
  ];
}

/**
 * @param {{entryPath: string, nodePath: string, runDirectory: string}} options
 */
function hudClickCommand({ entryPath, nodePath, runDirectory }) {
  return [
    quoteTmuxShellArgument(nodePath),
    quoteTmuxShellArgument(entryPath),
    "__hud-click",
    quoteTmuxShellArgument(runDirectory),
    quoteShellArgument("#{session_id}"),
    quoteShellArgument("#{mouse_x}"),
    quoteShellArgument("#{mouse_y}"),
    quoteShellArgument("#{pane_width}"),
  ].join(" ");
}

/**
 * tmux expands formats before invoking run-shell and does not honor shell
 * quoting while doing so. Doubling a literal hash protects static paths while
 * the separately supplied mouse formats remain intentionally expandable.
 *
 * @param {string} value
 */
function quoteTmuxShellArgument(value) {
  return quoteShellArgument(escapeTmuxFormat(value));
}

/** @param {string} value */
function escapeTmuxFormat(value) {
  return value.replaceAll("#", "##");
}

/**
 * @param {string} clickCommand
 */
function hudClickHandler(clickCommand) {
  return `run-shell -t = ${quoteShellArgument(clickCommand)}`;
}

function noOpMouseCommand() {
  return 'display-message -d 0 ""';
}

/**
 * @param {string} hudPane
 */
function hudMouseCondition(hudPane) {
  return `#{==:#{mouse_pane},${hudPane}}`;
}

/**
 * @param {string} codexPane
 */
function copyModeMouseCondition(codexPane) {
  return `#{&&:#{==:#{mouse_pane},${codexPane}},#{==:#{${HUD_INTERACTION_MODE_OPTION}},copy}}`;
}

/**
 * @param {{
 *   args: string[],
 *   codexBin: string,
 *   cwd: string,
 *   env: NodeJS.ProcessEnv,
 *   stderr: {write(value: string): unknown}
 * }} options
 */
async function runCodexChild({
  args,
  codexBin,
  cwd,
  env,
  stderr,
}) {
  return new Promise((resolve) => {
    const child = spawn(codexBin, args, {
      cwd,
      env,
      stdio: "inherit",
    });
    let settled = false;

    /** @param {NodeJS.Signals} signal */
    const forward = (signal) => {
      if (!child.killed) {
        child.kill(signal);
      }
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    /** @param {number} code */
    const finish = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      resolve(code);
    };

    child.once("error", (error) => {
      stderr.write(`codex-hud: cannot start Codex: ${error.message}\n`);
      finish(127);
    });
    child.once("exit", (code, signal) => {
      const signalCode = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
      finish(typeof code === "number" ? code : signalCode);
    });
  });
}

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
function tmuxOutput(args, env) {
  const result = spawnSync("tmux", args, {
    encoding: "utf8",
    env,
  });
  if (result.status !== 0) {
    throw new Error(
      `tmux ${args[0]} failed: ${(result.stderr || result.error?.message || "unknown error").trim()}`,
    );
  }
  return result.stdout;
}

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
function tmuxChecked(args, env) {
  tmuxOutput(args, env);
}

/**
 * @param {string} sessionId
 * @param {string} paneId
 * @param {NodeJS.ProcessEnv} env
 */
function snapshotTmuxInteraction(sessionId, paneId, env) {
  return {
    historyLimit: tmuxLocalOption(
      ["-w"],
      paneId,
      "history-limit",
      env,
    ),
    mouse: tmuxLocalOption([], sessionId, "mouse", env),
    paneTitle: tmuxOutput(
      ["display-message", "-p", "-t", paneId, "#{pane_title}"],
      env,
    ).replace(/\r?\n$/u, ""),
    remainOnExit: tmuxLocalOption(
      ["-w"],
      paneId,
      "remain-on-exit",
      env,
    ),
    status: tmuxLocalOption([], sessionId, "status", env),
    mouseBinding: tmuxKeyBinding(
      "root",
      "MouseDown1Pane",
      env,
    ),
  };
}

/**
 * @param {{
 *   historyLimit: string | null,
 *   mouse: string | null,
 *   mouseBinding: string | null,
 *   paneTitle: string,
 *   remainOnExit: string | null,
 *   status: string | null
 * }} snapshot
 * @param {string} sessionId
 * @param {string} paneId
 * @param {NodeJS.ProcessEnv} env
 */
function restoreTmuxInteraction(
  snapshot,
  sessionId,
  paneId,
  env,
) {
  /** @type {string[]} */
  const errors = [];
  /**
   * @param {string} label
   * @param {() => void} action
   */
  const restore = (label, action) => {
    try {
      action();
    } catch (error) {
      errors.push(`${label}: ${errorMessage(error)}`);
    }
  };

  restore("status", () => {
    restoreTmuxLocalOption([], sessionId, "status", snapshot.status, env);
  });
  restore("mouse", () => {
    restoreTmuxLocalOption([], sessionId, "mouse", snapshot.mouse, env);
  });
  restore("history-limit", () => {
    restoreTmuxLocalOption(
      ["-w"],
      paneId,
      "history-limit",
      snapshot.historyLimit,
      env,
    );
  });
  restore("remain-on-exit", () => {
    restoreTmuxLocalOption(
      ["-w"],
      paneId,
      "remain-on-exit",
      snapshot.remainOnExit,
      env,
    );
  });
  restore("pane title", () => {
    tmuxChecked(["select-pane", "-t", paneId, "-T", snapshot.paneTitle], env);
  });
  restore("root MouseDown1Pane binding", () => {
    restoreTmuxKeyBinding("root", "MouseDown1Pane", snapshot.mouseBinding, env);
  });

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

/**
 * Read a target-local tmux option. An empty result means the target inherited
 * its value, which must be restored with `set-option -u` rather than an empty
 * local override.
 *
 * @param {string[]} scopeArgs
 * @param {string} target
 * @param {string} option
 * @param {NodeJS.ProcessEnv} env
 */
function tmuxLocalOption(scopeArgs, target, option, env) {
  const value = tmuxOutput(
    ["show-options", "-qv", ...scopeArgs, "-t", target, option],
    env,
  ).trim();
  return value === "" ? null : value;
}

/**
 * @param {string[]} scopeArgs
 * @param {string} target
 * @param {string} option
 * @param {string | null} value
 * @param {NodeJS.ProcessEnv} env
 */
function restoreTmuxLocalOption(scopeArgs, target, option, value, env) {
  if (value === null) {
    tmuxChecked(
      ["set-option", "-u", ...scopeArgs, "-t", target, option],
      env,
    );
    return;
  }
  tmuxChecked(
    ["set-option", ...scopeArgs, "-t", target, option, value],
    env,
  );
}

/**
 * @param {string} table
 * @param {string} key
 * @param {string | null} binding
 * @param {NodeJS.ProcessEnv} env
 */
function restoreTmuxKeyBinding(table, key, binding, env) {
  tmuxChecked(["unbind-key", "-q", "-T", table, key], env);
  if (!binding) {
    return;
  }

  const restored = spawnSync("tmux", ["source-file", "-"], {
    encoding: "utf8",
    env,
    input: `${binding}\n`,
  });
  if (restored.status !== 0) {
    throw new Error(
      `tmux ${table} ${key} binding restore failed: ${(restored.stderr || restored.error?.message || "unknown error").trim()}`,
    );
  }
}

/**
 * @param {string} table
 * @param {string} key
 * @param {NodeJS.ProcessEnv} env
 */
function tmuxKeyBinding(table, key, env) {
  return (
    tmuxOutput(["list-keys", "-T", table], env)
      .split(/\r?\n/u)
      .find((line) => line.trim().split(/\s+/u).includes(key)) ?? null
  );
}

/**
 * @param {unknown} error
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
