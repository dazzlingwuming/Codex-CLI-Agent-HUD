import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
  hasAnimationsOverride,
  hasStatusLineOverride,
  hudMouseBindings,
  isolatedTmuxSocketPath,
  readHudInteractionMode,
  setHudInteractionMode,
  tmuxClientFeatureArgs,
  todoMouseBinding,
  withHudTuiDefaults,
  withNativeStatusLine,
  withScrollableScreen,
  withStaticAnimations,
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

test("HUD disables active Codex animations unless the user overrides them", () => {
  assert.deepEqual(withStaticAnimations(["resume"]), [
    "-c",
    "tui.animations=false",
    "resume",
  ]);

  const explicit = ["-c", "tui.animations=true", "resume"];
  assert.equal(hasAnimationsOverride(explicit), true);
  assert.deepEqual(withStaticAnimations(explicit), explicit);
  assert.equal(
    hasAnimationsOverride([
      "--config=tui.animations=false",
      "resume",
    ]),
    true,
  );

  const defaults = withHudTuiDefaults(["resume"]);
  assert.equal(
    defaults.filter((value) => value === "tui.animations=false")
      .length,
    1,
  );
});

test("JetBrains HUD clients advertise synchronized output to tmux", () => {
  assert.deepEqual(
    tmuxClientFeatureArgs({
      TERMINAL_EMULATOR: "JetBrains-JediTerm",
    }),
    ["-T", "sync"],
  );
  assert.deepEqual(
    tmuxClientFeatureArgs({
      __CFBundleIdentifier: "com.jetbrains.pycharm",
    }),
    ["-T", "sync"],
  );
  assert.deepEqual(
    tmuxClientFeatureArgs({ TERM_PROGRAM: "Apple_Terminal" }),
    [],
  );
  assert.deepEqual(
    tmuxClientFeatureArgs({ TERM_PROGRAM: "vscode" }),
    [],
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
    codexPane: "%1",
    entryPath: "/tmp/Codex HUD/cli.mjs",
    hudPane: "%2",
    nodePath: "/usr/bin/node",
    runDirectory: "/tmp/Codex HUD/run",
    usesInteractionModes: true,
  });
  const command = binding.join(" ");

  assert.match(command, /MouseDown1Pane/u);
  assert.match(command, /mouse_pane.*%2/u);
  assert.match(command, /__hud-click/u);
  assert.match(command, /#\{session_id\}/u);
  assert.match(command, /#\{mouse_x\}/u);
  assert.match(command, /#\{mouse_y\}/u);
  assert.match(command, /#\{pane_width\}/u);
  assert.doesNotMatch(command, /pane_left|pane_top|__toggle/u);
  assert.match(command, /@codex_hud_interaction_mode/u);
  assert.match(command, /select-pane/u);
});

test("HUD mouse bindings retain scrollback selection without automatic copy", () => {
  const bindings = hudMouseBindings({
    codexPane: "%1",
    entryPath: "/tmp/Codex HUD/cli.mjs",
    hudPane: "%2",
    nodePath: "/usr/bin/node",
    runDirectory: "/tmp/Codex HUD/run",
  });
  const source = bindings.map((binding) => binding.join(" ")).join("\n");

  for (const table of ["copy-mode", "copy-mode-vi"]) {
    const tableBindings = bindings.filter(
      (binding) => binding[2] === table,
    );
    assert.equal(tableBindings.length, 5);
    assert.match(
      tableBindings.find((binding) => binding[3] === "MouseDown1Pane")?.join(" ") ?? "",
      /clear-selection/u,
    );
    assert.match(
      tableBindings.find((binding) => binding[3] === "MouseDragEnd1Pane")?.join(" ") ?? "",
      /stop-selection/u,
    );
    assert.match(
      tableBindings.find((binding) => binding[3] === "DoubleClick1Pane")?.join(" ") ?? "",
      /select-word.*stop-selection/u,
    );
    assert.match(
      tableBindings.find((binding) => binding[3] === "TripleClick1Pane")?.join(" ") ?? "",
      /select-line.*stop-selection/u,
    );
    assert.match(
      tableBindings.find((binding) => binding[3] === "MouseDown1Pane")?.join(" ") ?? "",
      /__hud-click/u,
    );
  }

  assert.match(source, /@codex_hud_interaction_mode/u);
  assert.doesNotMatch(
    source,
    /copy-pipe|copy-selection|cancel|pbcopy|OSC52/u,
  );
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
  assert.ok(args.includes("tui.animations=false"));
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
  const serverEnv = tmuxEnvironment(socket, codexPane.id, env);
  assert.equal(readHudInteractionMode("$0", serverEnv), "hud");
  assert.equal(setHudInteractionMode("$0", "copy", serverEnv), "copy");
  assert.equal(readHudInteractionMode("$0", serverEnv), "copy");
  assert.equal(
    tmuxText(socket, ["show-options", "-v", "-t", "hud", "mouse"]).trim(),
    "on",
  );
  assert.throws(
    () => setHudInteractionMode("$0", "invalid", serverEnv),
    /Invalid HUD interaction mode/u,
  );
  assert.equal(setHudInteractionMode("$0", "hud", serverEnv), "hud");

  assert.match(
    tmuxText(socket, ["list-keys", "-T", "root"]),
    /copy-mode/u,
  );
  assert.match(
    tmuxText(socket, ["list-keys", "-T", "root"]),
    /__hud-click/u,
  );
  for (const table of ["copy-mode", "copy-mode-vi"]) {
    const tableBindings = tmuxText(socket, ["list-keys", "-T", table]);
    assert.match(tableBindings, /MouseDown1Pane.*clear-selection/u);
    assert.match(tableBindings, /MouseDragEnd1Pane.*stop-selection/u);
    assert.match(tableBindings, /DoubleClick1Pane.*select-word.*stop-selection/u);
    assert.match(tableBindings, /TripleClick1Pane.*select-line.*stop-selection/u);
    assert.doesNotMatch(
      tableBindings.match(/^.*(?:MouseDown1Pane|MouseDrag1Pane|MouseDragEnd1Pane|DoubleClick1Pane|TripleClick1Pane).*$/gmu)?.join("\n") ?? "",
      /copy-pipe|copy-selection|cancel|pbcopy|OSC52/u,
    );
    assert.match(tableBindings, /^.*q\s+send-keys -X cancel$/mu);
  }
  assert.equal(await waitForHistory(socket, codexPane.id), true);

  tmuxText(socket, ["set-buffer", "clipboard-sentinel"]);
  tmuxText(socket, ["copy-mode", "-e", "-t", codexPane.id]);
  tmuxText(socket, ["send-keys", "-t", codexPane.id, "-X", "history-top"]);
  const historical = paneCopyState(socket, codexPane.id);
  assert.equal(historical.inMode, "1");
  assert.notEqual(historical.scrollPosition, "0");

  tmuxText(socket, ["send-keys", "-t", codexPane.id, "-X", "begin-selection"]);
  tmuxText(socket, ["send-keys", "-t", codexPane.id, "-X", "cursor-down"]);
  tmuxText(socket, ["send-keys", "-t", codexPane.id, "-X", "stop-selection"]);
  const stoppedSelection = paneCopyState(socket, codexPane.id);
  assert.equal(stoppedSelection.inMode, "1");
  assert.equal(stoppedSelection.scrollPosition, historical.scrollPosition);
  assert.equal(stoppedSelection.selectionPresent, "1");
  assert.equal(tmuxText(socket, ["show-buffer"]).trim(), "clipboard-sentinel");

  tmuxText(socket, ["send-keys", "-t", codexPane.id, "-X", "clear-selection"]);
  const clearedSelection = paneCopyState(socket, codexPane.id);
  assert.equal(clearedSelection.inMode, "1");
  assert.equal(clearedSelection.scrollPosition, historical.scrollPosition);
  assert.equal(clearedSelection.selectionPresent, "0");
  tmuxText(socket, ["send-keys", "-t", codexPane.id, "-X", "cancel"]);
  assert.equal(paneCopyState(socket, codexPane.id).inMode, "0");

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

test("nested tmux restores local and inherited interaction state", async (context) => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-hud-tmux-nested-"),
  );
  const root = path.join(base, "state");
  const socket = `codex-hud-nested-${process.pid}-${Date.now()}`;
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
      "outer",
      "-x",
      "100",
      "-y",
      "30",
      "-c",
      base,
      "sleep 60",
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(started.status, 0, started.stderr);

  const outerPane = tmuxText(socket, [
    "list-panes",
    "-t",
    "outer",
    "-F",
    "#{pane_id}",
  ]).trim();
  tmuxText(socket, ["set-option", "-g", "mouse", "off"]);
  tmuxText(socket, ["set-option", "-g", "remain-on-exit", "on"]);
  tmuxText(socket, ["set-option", "-t", "outer", "status", "3"]);
  tmuxText(socket, [
    "set-option",
    "-w",
    "-t",
    outerPane,
    "history-limit",
    "777",
  ]);
  tmuxText(socket, ["select-pane", "-t", outerPane, "-T", "Outer pane"]);
  tmuxText(socket, [
    "bind-key",
    "-T",
    "root",
    "MouseDown1Pane",
    "display-message",
    "nested-original",
  ]);
  const originalMouseBinding = tmuxKeyLine(
    socket,
    "root",
    "MouseDown1Pane",
  );
  const originalCopyMode = tmuxText(socket, ["list-keys", "-T", "copy-mode"]);
  const originalCopyModeVi = tmuxText(socket, [
    "list-keys",
    "-T",
    "copy-mode-vi",
  ]);

  const runDirectory = createRunDirectory({
    cwd: base,
    env,
    launchId: "nested",
    startedAtMs: Date.now(),
  });
  const entryPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  writeRunJson(
    runDirectory,
    "launch.json",
    {
      codexArgs: [],
      codexBin: fakeCodex,
      cwd: base,
      entryPath,
      ownsTmuxServer: false,
    },
    env,
  );
  const command = [
    quoteShellArgument(process.execPath),
    quoteShellArgument(entryPath),
    "__inside",
    quoteShellArgument(runDirectory),
  ].join(" ");
  const respawned = spawnSync(
    "tmux",
    [
      "-L",
      socket,
      "respawn-pane",
      "-k",
      "-t",
      outerPane,
      "-c",
      base,
      command,
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(respawned.status, 0, respawned.stderr);

  const panes = await waitForPanes(socket, 2, "outer");
  const codexPane = panes.find((pane) => pane.title === "Codex");
  assert.ok(codexPane);
  assert.equal(
    tmuxText(socket, ["show-options", "-qv", "-t", "outer", "status"]).trim(),
    "off",
  );
  assert.equal(
    tmuxText(socket, ["show-options", "-qv", "-t", "outer", "mouse"]).trim(),
    "on",
  );
  assert.equal(
    tmuxText(socket, [
      "show-options",
      "-qv",
      "-w",
      "-t",
      outerPane,
      "history-limit",
    ]).trim(),
    "100000",
  );
  assert.equal(
    tmuxText(socket, [
      "show-options",
      "-qv",
      "-w",
      "-t",
      outerPane,
      "remain-on-exit",
    ]).trim(),
    "off",
  );
  assert.equal(
    tmuxText(socket, [
      "display-message",
      "-p",
      "-t",
      outerPane,
      "#{pane_title}",
    ]).trim(),
    "Codex",
  );
  assert.match(
    tmuxKeyLine(socket, "root", "MouseDown1Pane") ?? "",
    /__hud-click/u,
  );
  assert.equal(
    tmuxText(socket, [
      "show-options",
      "-qv",
      "-t",
      "outer",
      "@codex_hud_interaction_mode",
    ]).trim(),
    "",
  );
  assert.equal(tmuxText(socket, ["list-keys", "-T", "copy-mode"]), originalCopyMode);
  assert.equal(
    tmuxText(socket, ["list-keys", "-T", "copy-mode-vi"]),
    originalCopyModeVi,
  );

  fs.writeFileSync(path.join(runDirectory, "stop"), "");
  const exitRecord = await waitForExitRecord(runDirectory, env);
  assert.equal(exitRecord?.code, 0);

  assert.equal(
    tmuxText(socket, ["show-options", "-qv", "-t", "outer", "status"]).trim(),
    "3",
  );
  assert.equal(
    tmuxText(socket, ["show-options", "-qv", "-t", "outer", "mouse"]).trim(),
    "",
  );
  assert.match(
    tmuxText(socket, ["show-options", "-A", "-t", "outer", "mouse"]),
    /^mouse\* off$/mu,
  );
  assert.equal(
    tmuxText(socket, [
      "show-options",
      "-qv",
      "-w",
      "-t",
      outerPane,
      "history-limit",
    ]).trim(),
    "777",
  );
  assert.equal(
    tmuxText(socket, [
      "show-options",
      "-qv",
      "-w",
      "-t",
      outerPane,
      "remain-on-exit",
    ]).trim(),
    "",
  );
  assert.match(
    tmuxText(socket, [
      "show-options",
      "-A",
      "-w",
      "-t",
      outerPane,
      "remain-on-exit",
    ]),
    /^remain-on-exit\* on$/mu,
  );
  assert.equal(
    tmuxText(socket, [
      "display-message",
      "-p",
      "-t",
      outerPane,
      "#{pane_title}",
    ]).trim(),
    "Outer pane",
  );
  assert.equal(
    tmuxKeyLine(socket, "root", "MouseDown1Pane"),
    originalMouseBinding,
  );
  assert.equal(tmuxText(socket, ["list-keys", "-T", "copy-mode"]), originalCopyMode);
  assert.equal(
    tmuxText(socket, ["list-keys", "-T", "copy-mode-vi"]),
    originalCopyModeVi,
  );
  assert.equal(removeRunDirectory(runDirectory, env), true);
});

test("a HUD click still routes while the top pane is in copy mode", async (context) => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-hud-tmux-mouse-route-"),
  );
  const root = path.join(base, "state");
  const socket = `codex-hud-mouse-route-${process.pid}-${Date.now()}`;
  context.after(() => {
    spawnSync("tmux", ["-L", socket, "kill-server"], {
      stdio: "ignore",
    });
    fs.rmSync(isolatedTmuxSocketPath(socket), { force: true });
    fs.rmSync(base, { recursive: true });
  });

  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, [STATE_ROOT_ENV]: root };
  const runDirectory = createRunDirectory({
    cwd: base,
    env,
    launchId: "mouse-route",
    startedAtMs: Date.now(),
  });
  const recorderPath = path.join(base, "hud-click-recorder.mjs");
  fs.writeFileSync(
    recorderPath,
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      "const [command, runDirectory, sessionId, mouseX, mouseY, paneWidth] = process.argv.slice(2);",
      'if (command === "__hud-click") {',
      "  fs.writeFileSync(path.join(runDirectory, \"controls\", \"hud-click.json\"), JSON.stringify({ sessionId, mouseX, mouseY, paneWidth }));",
      "}",
      "",
    ].join("\n"),
  );

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
      "route",
      "-x",
      "100",
      "-y",
      "30",
      "-c",
      base,
      "index=1; while [ \"$index\" -le 80 ]; do printf 'route-line-%s\\n' \"$index\"; index=$((index + 1)); done; sleep 60",
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(started.status, 0, started.stderr);
  const codexPane = tmuxText(socket, [
    "list-panes",
    "-t",
    "route",
    "-F",
    "#{pane_id}",
  ]).trim();
  const hudPane = tmuxText(socket, [
    "split-window",
    "-v",
    "-l",
    "6",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-t",
    codexPane,
    "sleep 60",
  ]).trim();
  tmuxText(socket, ["set-option", "-t", "route", "status", "off"]);
  tmuxText(socket, ["set-option", "-t", "route", "mouse", "on"]);
  tmuxText(socket, [
    "set-option",
    "-t",
    "route",
    "@codex_hud_interaction_mode",
    "copy",
  ]);
  const bindingOptions = {
    codexPane,
    entryPath: recorderPath,
    hudPane,
    nodePath: process.execPath,
    runDirectory,
  };
  tmuxText(
    socket,
    todoMouseBinding({ ...bindingOptions, usesInteractionModes: true }),
  );
  for (const binding of hudMouseBindings(bindingOptions)) {
    tmuxText(socket, binding);
  }
  tmuxText(socket, ["select-pane", "-t", codexPane]);
  assert.equal(await waitForHistory(socket, codexPane), true);
  tmuxText(socket, ["copy-mode", "-e", "-t", codexPane]);
  tmuxText(socket, ["send-keys", "-t", codexPane, "-X", "history-top"]);
  const historical = paneCopyState(socket, codexPane);
  assert.equal(historical.inMode, "1");
  const [paneLeft, paneTop] = tmuxText(socket, [
    "display-message",
    "-p",
    "-t",
    hudPane,
    "#{pane_left}\t#{pane_top}",
  ])
    .trim()
    .split("\t")
    .map(Number);

  await clickTmuxPane({
    column: paneLeft + 1,
    row: paneTop + 1,
    session: "route",
    socket,
  });
  const clickPath = path.join(runDirectory, "controls", "hud-click.json");
  assert.equal(await waitForFile(clickPath), true);
  const click = JSON.parse(fs.readFileSync(clickPath, "utf8"));
  assert.equal(click.sessionId, "$0");
  assert.equal(click.mouseX, "0");
  assert.equal(click.mouseY, "0");
  assert.equal(click.paneWidth, "100");
  const afterClick = paneCopyState(socket, codexPane);
  assert.equal(afterClick.inMode, "1");
  assert.equal(afterClick.scrollPosition, historical.scrollPosition);
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
 * @param {{column: number, row: number, session: string, socket: string}} options
 */
async function clickTmuxPane({ column, row, session, socket }) {
  const script = [
    "set timeout 5",
    'set env(TERM) "xterm-256color"',
    "spawn -noecho sh",
    'send -- "stty rows 30 columns 100\\r"',
    "expect -re {[$#] }",
    `send -- "exec tmux -L ${socket} attach-session -t ${session}\\r"`,
    "after 400",
    `send -- "\\033\\[<0;${column};${row}M"`,
    "after 100",
    `send -- "\\033\\[<3;${column};${row}m"`,
    "after 400",
    'send -- "\\002d"',
    "expect eof",
  ].join("\n");
  await new Promise((resolve, reject) => {
    const child = spawn("expect", ["-c", script], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(new Error(`expect tmux click failed: ${stderr.trim()}`));
    });
  });
}

/**
 * @param {string} filePath
 */
async function waitForFile(filePath) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/**
 * @param {string} socket
 * @param {number} count
 * @param {string} [session]
 */
async function waitForPanes(socket, count, session = "hud") {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = spawnSync(
      "tmux",
      [
        "-L",
        socket,
        "list-panes",
        "-t",
        session,
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

/**
 * @param {string} socket
 * @param {string} table
 * @param {string} key
 */
function tmuxKeyLine(socket, table, key) {
  return (
    tmuxText(socket, ["list-keys", "-T", table])
      .split(/\r?\n/u)
      .find((line) => line.trim().split(/\s+/u).includes(key)) ?? null
  );
}

/**
 * @param {string} socket
 * @param {string} pane
 * @param {NodeJS.ProcessEnv} env
 */
function tmuxEnvironment(socket, pane, env) {
  const tmux = tmuxText(socket, [
    "display-message",
    "-p",
    "-t",
    pane,
    "#{socket_path},#{pid},#{pane_id}",
  ]).trim();
  return { ...env, TMUX: tmux, TMUX_PANE: pane };
}

/**
 * @param {string} socket
 * @param {string} pane
 */
function paneCopyState(socket, pane) {
  const [inMode, scrollPosition, selectionPresent] = tmuxText(socket, [
    "display-message",
    "-p",
    "-t",
    pane,
    "#{pane_in_mode}\t#{scroll_position}\t#{selection_present}",
  ])
    .trim()
    .split("\t");
  return { inMode, scrollPosition, selectionPresent };
}
