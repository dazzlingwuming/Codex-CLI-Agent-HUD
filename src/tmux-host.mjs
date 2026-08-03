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

const COPY_MODE_TABLES = Object.freeze(["copy-mode", "copy-mode-vi"]);
const COPY_MODE_WHEEL_LINES = 5;
const HUD_SELECTION_BUFFER_PREFIX = "codex-hud-selection";
const MACOS_COPY_COMMAND = "/usr/bin/pbcopy";
const TMUX_PANE_ID = /^%[0-9]+$/u;

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
  const runDirectoryOptions = {
    cwd,
    copyActionControls: ownsTmuxServer,
    env,
    launchId,
    ownsTmuxServer,
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
 *   nodePath?: string
 * }} options
 */
export function todoMouseBinding({
  codexPane,
  entryPath,
  hudPane,
  runDirectory,
  nodePath = process.execPath,
}) {
  const clickCommand = hudClickCommand({
    codexPane,
    entryPath,
    nodePath,
    runDirectory,
  });
  return [
    "bind-key",
    "-T",
    "root",
    "MouseDown1Pane",
    "if-shell",
    "-F",
    `#{==:#{mouse_pane},${hudPane}}`,
    hudClickHandler(clickCommand),
    "select-pane -t =",
  ];
}

/**
 * Build the mouse policy for a HUD-owned tmux server. The root bindings force
 * the Codex pane into tmux copy-mode before application mouse reporting can
 * consume a drag. Copy-mode bindings keep selection and history stable until
 * the user explicitly exits with q or copies with Enter.
 *
 * @param {{
 *   codexPane: string,
 *   copyCommand?: string,
 *   entryPath: string,
 *   hudPane: string,
 *   runDirectory: string,
 *   nodePath?: string
 * }} options
 */
export function hudMouseBindings({
  codexPane,
  copyCommand = MACOS_COPY_COMMAND,
  entryPath,
  hudPane,
  runDirectory,
  nodePath = process.execPath,
}) {
  const clickHandler = hudClickHandler(
    hudClickCommand({
      codexPane,
      entryPath,
      nodePath,
      runDirectory,
    }),
  );
  const bindings = [
    mouseEventBinding({
      fallback: isolatedCodexMouseCommand("copy-mode -M"),
      hudCommand: noOpMouseCommand(),
      hudPane,
      key: "MouseDrag1Pane",
      table: "root",
    }),
    rootWordSelectionBinding({
      hudPane,
      key: "DoubleClick1Pane",
      selection: "select-word",
    }),
    rootWordSelectionBinding({
      hudPane,
      key: "TripleClick1Pane",
      selection: "select-line",
    }),
    rootWheelBinding({
      hudPane,
      key: "WheelUpPane",
      scroll: "scroll-up",
    }),
    rootWheelBinding({
      hudPane,
      key: "WheelDownPane",
      scroll: "scroll-down",
    }),
  ];

  for (const table of COPY_MODE_TABLES) {
    bindings.push(
      copyModeMouseBinding({
        table,
        clickHandler,
        hudPane,
        key: "MouseDown1Pane",
        codexCommand: "send-keys -X clear-selection",
      }),
      copyModeMouseBinding({
        table,
        clickHandler,
        hudPane,
        key: "MouseDrag1Pane",
        codexCommand: "send-keys -X begin-selection",
      }),
      copyModeMouseBinding({
        table,
        clickHandler,
        hudPane,
        key: "MouseDragEnd1Pane",
        codexCommand: "send-keys -X stop-selection",
      }),
      copyModeMouseBinding({
        table,
        clickHandler,
        hudPane,
        key: "DoubleClick1Pane",
        codexCommand:
          "send-keys -X select-word ; send-keys -X stop-selection",
      }),
      copyModeMouseBinding({
        table,
        clickHandler,
        hudPane,
        key: "TripleClick1Pane",
        codexCommand:
          "send-keys -X select-line ; send-keys -X stop-selection",
      }),
      copyModeMouseBinding({
        table,
        clickHandler,
        hudPane,
        key: "WheelUpPane",
        codexCommand: "send-keys -X -N 5 scroll-up",
      }),
      copyModeMouseBinding({
        table,
        clickHandler,
        hudPane,
        key: "WheelDownPane",
        codexCommand: boundedCopyModeScrollDownCommand(),
      }),
      ["bind-key", "-T", table, "q", "send-keys", "-X", "cancel"],
      copyModeEnterBinding(table, copyCommand),
    );
  }
  return bindings;
}

/**
 * tmux's copy-mode `scroll-down` command cancels copy-mode when it is invoked
 * at the bottom boundary. Cancelling also destroys the active selection. A
 * wheel tick therefore uses the ordinary five-line move only while more than
 * five lines remain. Near the boundary, `history-bottom` reaches position zero
 * without leaving copy-mode or clearing the selection.
 */
function boundedCopyModeScrollDownCommand() {
  return [
    "if-shell",
    "-F",
    `"#{e|>:#{scroll_position},${COPY_MODE_WHEEL_LINES}}"`,
    `"send-keys -X -N ${COPY_MODE_WHEEL_LINES} scroll-down"`,
    '"send-keys -X history-bottom"',
  ].join(" ");
}

/**
 * Guard the keyboard copy path as well as the UI action: tmux otherwise lets
 * `copy-pipe-no-clear` run with an empty selection after merely entering
 * history, which would overwrite the system clipboard with empty text.
 *
 * @param {string} table
 * @param {string} copyCommand
 */
function copyModeEnterBinding(table, copyCommand) {
  const copyAction = [
    "send-keys",
    "-X",
    "copy-pipe-no-clear",
    "-CP",
    quoteNestedTmuxShellArgument(copyCommand),
  ].join(" ");
  return [
    "bind-key",
    "-T",
    table,
    "Enter",
    "if-shell",
    "-F",
    "#{==:#{selection_present},1}",
    copyAction,
    noOpMouseCommand(),
  ];
}

/**
 * @param {{
 *   hudPane: string,
 *   key: string,
 *   selection: "select-line" | "select-word"
 * }} options
 */
function rootWordSelectionBinding({ hudPane, key, selection }) {
  return mouseEventBinding({
    fallback: isolatedCodexMouseCommand(
      `copy-mode -H ; send-keys -X ${selection} ; send-keys -X stop-selection`,
    ),
    hudCommand: noOpMouseCommand(),
    hudPane,
    key,
    table: "root",
  });
}

/**
 * @param {{
 *   hudPane: string,
 *   key: string,
 *   scroll: "scroll-down" | "scroll-up"
 * }} options
 */
function rootWheelBinding({ hudPane, key, scroll }) {
  return mouseEventBinding({
    fallback: isolatedCodexMouseCommand(
      `copy-mode -e ; send-keys -X -N 5 ${scroll}`,
    ),
    hudCommand: noOpMouseCommand(),
    hudPane,
    key,
    table: "root",
  });
}

/**
 * @param {{
 *   table: string,
 *   clickHandler: string,
 *   hudPane: string,
 *   key: string,
 *   codexCommand: string
 * }} options
 */
function copyModeMouseBinding({
  table,
  clickHandler,
  hudPane,
  key,
  codexCommand,
}) {
  return mouseEventBinding({
    fallback: isolatedCodexMouseCommand(codexCommand),
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
 * Copy the active tmux selection without exiting copy-mode or clearing its
 * visible highlight. The target pane must resolve inside the exact tmux server
 * described by the caller's TMUX environment; this prevents a HUD click from
 * addressing an arbitrary server or pane.
 *
 * `copyCommand` is intentionally private to callers of this module: runtime
 * calls use the fixed macOS pbcopy binary, while focused PTY tests inject a
 * fixture command so they never touch the user's real clipboard.
 *
 * @param {string} codexPane
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{copyCommand?: string}} [options]
 * @returns {boolean}
 */
export function copyHudSelection(
  codexPane,
  env = process.env,
  { copyCommand = MACOS_COPY_COMMAND } = {},
) {
  if (!TMUX_PANE_ID.test(codexPane) || typeof copyCommand !== "string" || copyCommand === "") {
    return false;
  }

  let selectionBuffer = null;
  let bufferCreated = false;
  try {
    if (!isCurrentTmuxPane(codexPane, env)) {
      return false;
    }
    const [inMode, paneMode, selectionPresent] = tmuxOutput(
      [
        "display-message",
        "-p",
        "-t",
        codexPane,
        "#{pane_in_mode}\t#{pane_mode}\t#{selection_present}",
      ],
      env,
    )
      .trim()
      .split("\t");
    if (
      inMode !== "1" ||
      paneMode !== "copy-mode" ||
      selectionPresent !== "1"
    ) {
      return false;
    }

    const selectionBufferPrefix = `${HUD_SELECTION_BUFFER_PREFIX}-${randomUUID()}`;
    tmuxChecked(
      [
        "send-keys",
        "-t",
        codexPane,
        "-X",
        "copy-selection-no-clear",
        "-C",
        selectionBufferPrefix,
      ],
      env,
    );
    selectionBuffer = tmuxSelectionBufferName(selectionBufferPrefix, env);
    if (!selectionBuffer) {
      throw new Error("tmux did not create the HUD selection buffer.");
    }
    bufferCreated = true;
    const selection = tmuxOutput(
      ["show-buffer", "-b", selectionBuffer],
      env,
    );
    const copied = spawnSync(copyCommand, [], {
      encoding: "utf8",
      env,
      input: selection,
    });
    return copied.status === 0 && !copied.error;
  } catch {
    return false;
  } finally {
    if (bufferCreated && selectionBuffer) {
      deleteHudSelectionBuffer(selectionBuffer, env);
    }
  }
}

/**
 * @param {{entryPath: string, nodePath: string, runDirectory: string, codexPane: string}} options
 */
function hudClickCommand({ codexPane, entryPath, nodePath, runDirectory }) {
  return [
    quoteTmuxShellArgument(nodePath),
    quoteTmuxShellArgument(entryPath),
    "__hud-click",
    quoteTmuxShellArgument(runDirectory),
    quoteShellArgument(codexPane),
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

/**
 * Enter reaches the pipe command through an if-shell action. The key binding
 * parser consumes one shell layer before copy-pipe invokes its command, so the
 * command needs two shell-quoting layers. A single literal-hash escape keeps
 * static command paths from being treated as tmux formats.
 *
 * @param {string} value
 */
function quoteNestedTmuxShellArgument(value) {
  return quoteShellArgument(quoteShellArgument(escapeTmuxFormat(value)));
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
 * hudMouseBindings are installed only on a HUD-owned isolated server, which
 * contains exactly the Codex and HUD panes. Once the HUD branch is ruled out,
 * addressing the current pane directly avoids evaluating a second mouse
 * format after tmux has dispatched the event.
 *
 * @param {string} command
 */
function isolatedCodexMouseCommand(command) {
  return `select-pane -t = ; ${command}`;
}

/**
 * @param {string} codexPane
 * @param {NodeJS.ProcessEnv} env
 */
function isCurrentTmuxPane(codexPane, env) {
  const currentServer = tmuxServerIdentity(env.TMUX);
  if (!currentServer) {
    return false;
  }
  const paneServer = tmuxOutput(
    ["display-message", "-p", "-t", codexPane, "#{socket_path},#{pid}"],
    env,
  ).trim();
  return paneServer === currentServer;
}

/** @param {string | undefined} value */
function tmuxServerIdentity(value) {
  if (typeof value !== "string") {
    return null;
  }
  const finalComma = value.lastIndexOf(",");
  const penultimateComma = value.lastIndexOf(",", finalComma - 1);
  if (finalComma < 1 || penultimateComma < 1) {
    return null;
  }
  const pid = value.slice(penultimateComma + 1, finalComma);
  const client = value.slice(finalComma + 1);
  if (!/^\d+$/u.test(pid) || client === "") {
    return null;
  }
  return value.slice(0, finalComma);
}

/**
 * @param {string} bufferName
 * @param {NodeJS.ProcessEnv} env
 */
function deleteHudSelectionBuffer(bufferName, env) {
  spawnSync(
    "tmux",
    ["delete-buffer", "-b", bufferName],
    {
      env,
      stdio: "ignore",
    },
  );
}

/**
 * tmux treats the copy command's buffer argument as a prefix and appends a
 * numeric suffix. Each HUD action gets a UUID prefix, so this lookup cannot
 * select a buffer owned by a different action or by the user.
 *
 * @param {string} prefix
 * @param {NodeJS.ProcessEnv} env
 */
function tmuxSelectionBufferName(prefix, env) {
  return (
    tmuxOutput(["list-buffers", "-F", "#{buffer_name}"], env)
      .split(/\r?\n/u)
      .find((bufferName) => bufferName.startsWith(prefix)) ?? null
  );
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
