import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RUN_DIRECTORY_ENV,
  STATE_ROOT_ENV,
} from "../src/constants.mjs";
import { quoteShellArgument } from "../src/hooks-config.mjs";
import {
  createRunDirectory,
  readRunJson,
  removeRunDirectory,
  writeControlAtomic,
  writeEventAtomic,
  writeRunJson,
} from "../src/run-directory.mjs";
import {
  chooseHudHeight,
  chooseHudViewHeight,
  hasAlternateScreenOverride,
  hasStatusLineOverride,
  isolatedTmuxSocketPath,
  todoMouseBinding,
  withHudTuiDefaults,
  withNativeStatusLine,
  withScrollableScreen,
} from "../src/tmux-host.mjs";

test("native status line is injected once and explicit user config wins", () => {
  const injected = withNativeStatusLine(["-m", "gpt-test"]);
  assert.equal(injected[0], "-c");
  assert.match(injected[1], /^tui\.status_line=/u);
  assert.deepEqual(injected.slice(2), ["-m", "gpt-test"]);

  const explicit = ["-c", 'tui.status_line=["model"]', "-m", "gpt-test"];
  assert.equal(hasStatusLineOverride(explicit), true);
  assert.deepEqual(withNativeStatusLine(explicit), explicit);
});

test("HUD keeps terminal scrollback unless the user overrides alternate screen", () => {
  assert.deepEqual(withScrollableScreen(["resume"]), [
    "--no-alt-screen",
    "resume",
  ]);
  assert.deepEqual(
    withScrollableScreen(["--no-alt-screen", "resume"]),
    ["--no-alt-screen", "resume"],
  );
  const explicit = [
    "-c",
    'tui.alternate_screen="always"',
    "resume",
  ];
  assert.equal(hasAlternateScreenOverride(explicit), true);
  assert.deepEqual(withScrollableScreen(explicit), explicit);

  const defaults = withHudTuiDefaults(["resume"]);
  assert.equal(defaults[0], "-c");
  assert.match(defaults[1], /^tui\.status_line=/u);
  assert.equal(
    defaults.filter((value) => value === "--no-alt-screen").length,
    1,
  );
});

test("HUD height follows the verified responsive thresholds", () => {
  assert.equal(chooseHudHeight(30, 120), 6);
  assert.equal(chooseHudHeight(20, 70), 3);
  assert.throws(() => chooseHudHeight(13, 100), /too small/u);
  assert.throws(() => chooseHudHeight(30, 49), /too small/u);
});

test("expanded HUD height shows Todos while preserving Codex input space", () => {
  assert.equal(chooseHudViewHeight(30, 120, 10, false), 6);
  assert.equal(chooseHudViewHeight(30, 120, 10, true), 14);
  assert.equal(chooseHudViewHeight(20, 100, 20, true), 10);
  assert.equal(chooseHudViewHeight(14, 100, 10, true), 3);
});

test("Todo mouse binding toggles only the HUD pane", () => {
  const binding = todoMouseBinding({
    entryPath: "/tmp/Codex HUD/cli.mjs",
    hudPane: "%2",
    nodePath: "/usr/bin/node",
    runDirectory: "/tmp/Codex HUD/run",
  });
  const command = binding.join(" ");

  assert.match(command, /MouseDown1Pane/u);
  assert.match(command, /mouse_pane.*%2/u);
  assert.match(command, /__toggle/u);
  assert.match(command, /select-pane/u);
});

test("isolated tmux socket path follows TMUX_TMPDIR and the current uid", () => {
  const uid =
    typeof process.getuid === "function" ? process.getuid() : 0;
  assert.equal(
    isolatedTmuxSocketPath("codex-hud-launch", {
      TMUX_TMPDIR: "/private/test-tmux",
    }),
    path.join(
      "/private/test-tmux",
      `tmux-${uid}`,
      "codex-hud-launch",
    ),
  );
});

test("detached tmux host preserves Codex exit code and arguments", async (context) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hud-tmux-test-"));
  const root = path.join(base, "state");
  const socket = `codex-hud-test-${process.pid}-${Date.now()}`;
  context.after(() => {
    spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    fs.rmSync(isolatedTmuxSocketPath(socket), { force: true });
    fs.rmSync(base, { recursive: true });
  });

  const fakeCodex = path.join(base, "fake-codex");
  fs.writeFileSync(
    fakeCodex,
    "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CODEX_HUD_RUN_DIR/codex-args.txt\"\nexit 7\n",
    { mode: 0o700 },
  );

  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, [STATE_ROOT_ENV]: root };
  const runDirectory = createRunDirectory({
    cwd: base,
    env,
    launchId: "tmux",
    startedAtMs: Date.now(),
  });
  env[RUN_DIRECTORY_ENV] = runDirectory;
  const entryPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  writeRunJson(
    runDirectory,
    "launch.json",
    {
      codexArgs: ["--test-value", "含 空格"],
      codexBin: fakeCodex,
      cwd: base,
      entryPath,
    },
    env,
  );

  const command = [
    quoteShellArgument(process.execPath),
    quoteShellArgument(entryPath),
    "__inside",
    quoteShellArgument(runDirectory),
  ].join(" ");
  const started = spawnSync(
    "tmux",
    [
      "-L",
      socket,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "hud",
      "-x",
      "100",
      "-y",
      "30",
      "-c",
      base,
      command,
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(started.status, 0, started.stderr);

  const exitRecord = await waitForExitRecord(runDirectory, env);
  assert.equal(exitRecord?.code, 7);
  const args = fs
    .readFileSync(path.join(runDirectory, "codex-args.txt"), "utf8")
    .trim()
    .split("\n");
  assert.equal(args[0], "-c");
  assert.match(args[1], /^tui\.status_line=/u);
  assert.ok(args.includes("--no-alt-screen"));
  assert.deepEqual(args.slice(-2), ["--test-value", "含 空格"]);
  assert.equal(readRunJson(runDirectory, "launch.json", env), null);
  assert.equal(removeRunDirectory(runDirectory, env), true);
});

test("live tmux host enables scrollback and expands Todo controls", async (context) => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-hud-tmux-interaction-"),
  );
  const root = path.join(base, "state");
  const socket = `codex-hud-interaction-${process.pid}-${Date.now()}`;
  context.after(() => {
    spawnSync("tmux", ["-L", socket, "kill-server"], {
      stdio: "ignore",
    });
    fs.rmSync(isolatedTmuxSocketPath(socket), { force: true });
    fs.rmSync(base, { recursive: true });
  });

  const fakeCodex = path.join(base, "fake-codex");
  fs.writeFileSync(
    fakeCodex,
    [
      "#!/bin/sh",
      "index=1",
      "while [ \"$index\" -le 80 ]; do",
      "  printf 'scrollback-line-%s\\n' \"$index\"",
      "  index=$((index + 1))",
      "done",
      "while [ ! -f \"$CODEX_HUD_RUN_DIR/stop\" ]; do",
      "  sleep 0.05",
      "done",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );

  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, [STATE_ROOT_ENV]: root };
  const runDirectory = createRunDirectory({
    cwd: base,
    env,
    launchId: "interaction",
    startedAtMs: Date.now(),
  });
  env[RUN_DIRECTORY_ENV] = runDirectory;
  const entryPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  writeRunJson(
    runDirectory,
    "launch.json",
    {
      codexArgs: [],
      codexBin: fakeCodex,
      cwd: base,
      entryPath,
      ownsTmuxServer: true,
    },
    env,
  );
  writeEventAtomic(
    runDirectory,
    {
      version: 1,
      id: "plan",
      observedAtMs: Date.now(),
      kind: "tool.finish",
      sessionId: "test",
      turnId: "turn",
      data: {
        action: {
          category: "planning",
          detail: "",
          label: "Updating plan",
        },
        planCandidate: Array.from({ length: 10 }, (_, index) => ({
          status: index < 3 ? "completed" : "pending",
          step: `Todo ${index + 1}`,
        })),
        toolName: "update_plan",
        toolUseId: "plan",
      },
    },
    env,
  );

  const command = [
    quoteShellArgument(process.execPath),
    quoteShellArgument(entryPath),
    "__inside",
    quoteShellArgument(runDirectory),
  ].join(" ");
  const started = spawnSync(
    "tmux",
    [
      "-L",
      socket,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "hud",
      "-x",
      "100",
      "-y",
      "30",
      "-c",
      base,
      command,
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(started.status, 0, started.stderr);

  const panes = await waitForPanes(socket, 2);
  const codexPane = panes.find((pane) => pane.title === "Codex");
  const hudPane = panes.find((pane) => pane.title === "Codex HUD");
  assert.ok(codexPane);
  assert.ok(hudPane);
  assert.equal(await waitForPaneHeight(socket, hudPane.id, 6), true);

  assert.equal(
    tmuxText(socket, ["show-options", "-v", "-t", "hud", "mouse"]).trim(),
    "on",
  );
  assert.equal(
    tmuxText(socket, [
      "show-options",
      "-wv",
      "-t",
      codexPane.id,
      "history-limit",
    ]).trim(),
    "100000",
  );
  assert.match(
    tmuxText(socket, ["list-keys", "-T", "root"]),
    /copy-mode/u,
  );
  assert.match(
    tmuxText(socket, ["list-keys", "-T", "root"]),
    /__toggle/u,
  );
  assert.equal(await waitForHistory(socket, codexPane.id), true);

  assert.equal(
    writeControlAtomic(
      runDirectory,
      {
        kind: "todo.toggle",
        observedAtMs: Date.now(),
        version: 1,
      },
      env,
    ),
    true,
  );
  assert.equal(await waitForPaneHeight(socket, hudPane.id, 14), true);
  const expanded = await waitForPaneContent(
    socket,
    hudPane.id,
    /Todo 10/u,
  );
  assert.match(expanded, /Todo 10/u);
  assert.match(expanded, /click to collapse/u);

  assert.equal(
    writeControlAtomic(
      runDirectory,
      {
        kind: "todo.toggle",
        observedAtMs: Date.now() + 1,
        version: 1,
      },
      env,
    ),
    true,
  );
  assert.equal(await waitForPaneHeight(socket, hudPane.id, 6), true);

  fs.writeFileSync(path.join(runDirectory, "stop"), "");
  const exitRecord = await waitForExitRecord(runDirectory, env);
  assert.equal(exitRecord?.code, 0);
  assert.equal(removeRunDirectory(runDirectory, env), true);
});

/**
 * @param {string} runDirectory
 * @param {NodeJS.ProcessEnv} env
 */
async function waitForExitRecord(runDirectory, env) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const record = readRunJson(runDirectory, "exit.json", env);
    if (record) {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

/**
 * @param {string} socket
 * @param {number} count
 */
async function waitForPanes(socket, count) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = spawnSync(
      "tmux",
      [
        "-L",
        socket,
        "list-panes",
        "-t",
        "hud",
        "-F",
        "#{pane_id}\t#{pane_title}\t#{pane_height}",
      ],
      { encoding: "utf8" },
    );
    if (result.status === 0) {
      const panes = result.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [id, title, height] = line.split("\t");
          return { height: Number(height), id, title };
        });
      if (panes.length === count) {
        return panes;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
}

/**
 * @param {string} socket
 * @param {string} pane
 * @param {number} expected
 */
async function waitForPaneHeight(socket, pane, expected) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const height = Number(
      tmuxText(socket, [
        "display-message",
        "-p",
        "-t",
        pane,
        "#{pane_height}",
      ]).trim(),
    );
    if (height === expected) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/**
 * @param {string} socket
 * @param {string} pane
 */
async function waitForHistory(socket, pane) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const size = Number(
      tmuxText(socket, [
        "display-message",
        "-p",
        "-t",
        pane,
        "#{history_size}",
      ]).trim(),
    );
    if (size > 0) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/**
 * @param {string} socket
 * @param {string} pane
 * @param {RegExp} pattern
 */
async function waitForPaneContent(socket, pane, pattern) {
  const deadline = Date.now() + 5_000;
  let content = "";
  while (Date.now() < deadline) {
    content = tmuxText(socket, [
      "capture-pane",
      "-p",
      "-t",
      pane,
    ]);
    if (pattern.test(content)) {
      return content;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return content;
}

/**
 * @param {string} socket
 * @param {string[]} args
 */
function tmuxText(socket, args) {
  const result = spawnSync("tmux", ["-L", socket, ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
