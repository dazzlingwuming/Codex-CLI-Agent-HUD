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
  const runDirectory = createRunDirectory({ cwd, env, launchId });
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
          "new-session",
          "-s",
          "hud",
          "-c",
          launchCwd,
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
    typeof launch.entryPath !== "string"
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
  const interactionSnapshot =
    launch.ownsTmuxServer === false
      ? snapshotTmuxInteraction(sessionId, env.TMUX_PANE, env)
      : null;

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
  tmuxChecked(["set-option", "-t", sessionId, "remain-on-exit", "off"], env);
  tmuxChecked(["select-pane", "-t", env.TMUX_PANE, "-T", "Codex"], env);

  const rendererCommand = [
    quoteShellArgument(process.execPath),
    quoteShellArgument(launch.entryPath),
    "__render",
    quoteShellArgument(runDirectory),
  ].join(" ");
  const hudPane = tmuxOutput(
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
      launch.cwd,
      rendererCommand,
    ],
    env,
  ).trim();
  tmuxChecked(["select-pane", "-t", hudPane, "-T", "Codex HUD"], env);
  tmuxChecked(
    todoMouseBinding({
      entryPath: launch.entryPath,
      hudPane,
      runDirectory,
    }),
    env,
  );
  tmuxChecked(["select-pane", "-t", env.TMUX_PANE], env);

  let exitCode = 2;
  try {
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
    spawnSync("tmux", ["kill-pane", "-t", hudPane], {
      env,
      stdio: "ignore",
    });
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
 *   entryPath: string,
 *   hudPane: string,
 *   runDirectory: string,
 *   nodePath?: string
 * }} options
 */
export function todoMouseBinding({
  entryPath,
  hudPane,
  runDirectory,
  nodePath = process.execPath,
}) {
  const toggleCommand = [
    quoteShellArgument(nodePath),
    quoteShellArgument(entryPath),
    "__toggle",
    quoteShellArgument(runDirectory),
  ].join(" ");
  return [
    "bind-key",
    "-T",
    "root",
    "MouseDown1Pane",
    "if-shell",
    "-F",
    `#{==:#{mouse_pane},${hudPane}}`,
    `run-shell ${quoteShellArgument(toggleCommand)}`,
    "select-pane -t = \\; send-keys -M",
  ];
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
    historyLimit: tmuxOutput(
      ["show-options", "-wv", "-t", paneId, "history-limit"],
      env,
    ).trim(),
    mouse: tmuxOutput(
      ["show-options", "-v", "-t", sessionId, "mouse"],
      env,
    ).trim(),
    mouseBinding: tmuxKeyBinding(
      "root",
      "MouseDown1Pane",
      env,
    ),
  };
}

/**
 * @param {{historyLimit: string, mouse: string, mouseBinding: string | null}} snapshot
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
  tmuxChecked(
    ["set-option", "-t", sessionId, "mouse", snapshot.mouse],
    env,
  );
  tmuxChecked(
    [
      "set-option",
      "-w",
      "-t",
      paneId,
      "history-limit",
      snapshot.historyLimit,
    ],
    env,
  );
  tmuxChecked(
    ["unbind-key", "-T", "root", "MouseDown1Pane"],
    env,
  );
  if (snapshot.mouseBinding) {
    const restored = spawnSync("tmux", ["source-file", "-"], {
      encoding: "utf8",
      env,
      input: snapshot.mouseBinding,
    });
    if (restored.status !== 0) {
      throw new Error(
        `tmux mouse binding restore failed: ${(restored.stderr || restored.error?.message || "unknown error").trim()}`,
      );
    }
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
