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
  copyHudSelection,
  hasAlternateScreenOverride,
  hasAnimationsOverride,
  hasStatusLineOverride,
  hudMouseBindings,
  isolatedTmuxSocketPath,
  runInsideTmux,
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
  });
  const command = binding.join(" ");

  assert.match(command, /MouseDown1Pane/u);
  assert.match(command, /mouse_pane.*%2/u);
  assert.match(command, /__hud-click/u);
  assert.match(command, /__hud-click.*%1.*#\{mouse_x\}/u);
  assert.match(command, /#\{mouse_x\}/u);
  assert.match(command, /#\{mouse_y\}/u);
  assert.match(command, /#\{pane_width\}/u);
  assert.doesNotMatch(
    command,
    /pane_left|pane_top|__toggle|#\{session_id\}|@codex_hud_interaction_mode/u,
  );
  assert.match(command, /MouseDown1Pane.*select-pane -t =/u);
  assert.doesNotMatch(command, /MouseDown1Pane.*copy-mode -M/u);
});

test("HUD mouse bindings own selection, scrollback, and explicit copy only", () => {
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
    assert.equal(tableBindings.length, 9);
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
    assert.match(
      tableBindings.find((binding) => binding[3] === "WheelUpPane")?.join(" ") ?? "",
      /scroll-up/u,
    );
    assert.match(
      tableBindings.find((binding) => binding[3] === "WheelDownPane")?.join(" ") ?? "",
      /scroll-down/u,
    );
    assert.match(
      tableBindings.find((binding) => binding[3] === "q")?.join(" ") ?? "",
      /send-keys -X cancel/u,
    );
    const enter = tableBindings.find((binding) => binding[3] === "Enter")?.join(" ") ?? "";
    assert.match(enter, /selection_present/u);
    assert.match(enter, /selection_present.*copy-pipe-no-clear -CP.*\/usr\/bin\/pbcopy/u);
  }

  assert.match(source, /copy-mode -M/u);
  assert.match(source, /copy-mode -e.*scroll-up/u);
  assert.doesNotMatch(source, /@codex_hud_interaction_mode/u);
  assert.doesNotMatch(
    source,
    /copy-pipe-and-cancel|copy-selection-and-cancel|OSC52/u,
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

test("tmux host requires an explicit boolean ownership manifest", async (context) => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-hud-tmux-ownership-"),
  );
  context.after(() => fs.rmSync(base, { recursive: true }));
  const env = {
    ...process.env,
    [STATE_ROOT_ENV]: path.join(base, "state"),
    TMUX_PANE: "%1",
  };

  for (const [index, ownsTmuxServer] of [undefined, "true"].entries()) {
    const runDirectory = createRunDirectory({
      cwd: base,
      env,
      launchId: `ownership-${index}`,
      startedAtMs: Date.now(),
    });
    writeRunJson(
      runDirectory,
      "launch.json",
      {
        codexArgs: [],
        codexBin: "codex",
        cwd: base,
        entryPath: "/tmp/cli.mjs",
        ...(ownsTmuxServer === undefined ? {} : { ownsTmuxServer }),
      },
      env,
    );

    await assert.rejects(
      runInsideTmux({ env, runDirectory }),
      /launch manifest is invalid/u,
    );
    assert.equal(removeRunDirectory(runDirectory, env), true);
  }
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
      ownsTmuxServer: true,
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
      base.replaceAll("#", "##"),
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
    path.join(os.tmpdir(), "codex-hud-#{pane_id}-interaction-"),
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
    copyActionControls: true,
    env,
    launchId: "interaction",
    ownsTmuxServer: true,
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
      base.replaceAll("#", "##"),
      command,
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(started.status, 0, started.stderr);

  const panes = await waitForPanes(socket, 2);
  const codexPane = panes.find((pane) => pane.title === "Codex");
  const hudPane = panes.find((pane) => pane.title === "Codex HUD");
  assert.ok(
    codexPane,
    `missing Codex pane; exit=${JSON.stringify(readRunJson(runDirectory, "exit.json", env))}`,
  );
  assert.ok(hudPane);
  assert.equal(await waitForPaneHeight(socket, hudPane.id, 6), true);
  const hudContent = await waitForPaneContent(
    socket,
    hudPane.id,
    /\[复制所选\]/u,
  );
  assert.match(hudContent, /Codex HUD/u);
  assert.equal(hudContent.match(/\[复制所选\]/gu)?.length, 1);

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
  const rootBindings = tmuxText(socket, ["list-keys", "-T", "root"]);
  assert.match(rootBindings, /MouseDown1Pane.*select-pane -t =/u);
  assert.doesNotMatch(rootBindings, /MouseDown1Pane.*copy-mode -M/u);
  assert.match(rootBindings, /MouseDrag1Pane.*copy-mode -M/u);
  assert.match(rootBindings, /WheelUpPane.*copy-mode -e.*scroll-up/u);
  assert.match(rootBindings, /__hud-click/u);
  assert.doesNotMatch(rootBindings, /@codex_hud_interaction_mode/u);
  for (const table of ["copy-mode", "copy-mode-vi"]) {
    assert.equal(
      await waitForKeyBinding(
        socket,
        table,
        "Enter",
        /selection_present.*copy-pipe-no-clear/u,
      ),
      true,
    );
    const tableBindings = tmuxText(socket, ["list-keys", "-T", table]);
    assert.match(tableBindings, /MouseDown1Pane.*clear-selection/u);
    assert.match(tableBindings, /MouseDragEnd1Pane.*stop-selection/u);
    assert.match(tableBindings, /DoubleClick1Pane.*select-word.*stop-selection/u);
    assert.match(tableBindings, /TripleClick1Pane.*select-line.*stop-selection/u);
    assert.match(tableBindings, /WheelUpPane.*scroll-up/u);
    assert.match(tableBindings, /WheelDownPane.*scroll-down/u);
    assert.match(
      tableBindings,
      /Enter.*selection_present.*copy-pipe-no-clear -CP.*\/usr\/bin\/pbcopy/u,
    );
    assert.doesNotMatch(
      tableBindings.match(/^.*(?:MouseDown1Pane|MouseDrag1Pane|MouseDragEnd1Pane|DoubleClick1Pane|TripleClick1Pane|Wheel(?:Up|Down)Pane).*$/gmu)?.join("\n") ?? "",
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

test("HUD-owned tmux keeps selection through scroll and copies only explicitly", async (context) => {
  const base = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "codex-hud-#{pane_id}-#(printf x)-persistent-selection-",
    ),
  );
  const root = path.join(base, "state");
  const socket = `codex-hud-persistent-selection-${process.pid}-${Date.now()}`;
  context.after(() => {
    spawnSync("tmux", ["-L", socket, "kill-server"], {
      stdio: "ignore",
    });
    fs.rmSync(isolatedTmuxSocketPath(socket), { force: true });
    fs.rmSync(base, { recursive: true });
  });

  const copiedPath = path.join(base, "copied-selection.txt");
  const copyFixture = path.join(base, "copy-selection-fixture");
  fs.writeFileSync(
    copyFixture,
    ["#!/bin/sh", `/bin/cat > ${quoteShellArgument(copiedPath)}`, ""].join("\n"),
    { mode: 0o700 },
  );
  const clickCapture = path.join(base, "hud-click.txt");
  const clickFixture = path.join(base, "hud-click.mjs");
  fs.writeFileSync(
    clickFixture,
    [
      'import fs from "node:fs";',
      `fs.writeFileSync(${JSON.stringify(clickCapture)}, process.argv.slice(2).join("\\t"));`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, [STATE_ROOT_ENV]: root };
  const runDirectory = createRunDirectory({
    cwd: base,
    copyActionControls: true,
    env,
    launchId: "persistent-selection",
    ownsTmuxServer: true,
    startedAtMs: Date.now(),
  });

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
      "persistent",
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
    "persistent",
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
  tmuxText(socket, ["set-option", "-t", "persistent", "status", "off"]);
  tmuxText(socket, ["set-option", "-t", "persistent", "mouse", "on"]);
  const bindingOptions = {
    codexPane,
    copyCommand: copyFixture,
    entryPath: clickFixture,
    hudPane,
    nodePath: process.execPath,
    runDirectory,
  };
  tmuxText(socket, todoMouseBinding(bindingOptions));
  for (const binding of hudMouseBindings(bindingOptions)) {
    tmuxText(socket, binding);
  }
  tmuxText(socket, ["select-pane", "-t", codexPane]);
  assert.equal(await waitForHistory(socket, codexPane), true);
  const [paneLeft, paneTop, paneHeight] = tmuxText(socket, [
    "display-message",
    "-p",
    "-t",
    codexPane,
    "#{pane_left}\t#{pane_top}\t#{pane_height}",
  ])
    .trim()
    .split("\t")
    .map(Number);

  const column = paneLeft + 8;
  const row = paneTop + 2;
  const dragRow = Math.min(paneTop + 6, paneTop + paneHeight - 2);

  await sendTmuxMouseEvents({
    events: [
      { code: 0, column, row, suffix: "M" },
      { code: 0, column, row, suffix: "m" },
    ],
    session: "persistent",
    socket,
  });
  const plainClick = paneCopyState(socket, codexPane);
  assert.equal(plainClick.inMode, "0");
  assert.equal(plainClick.selectionPresent, "0");

  await sendTmuxMouseEvents({
    events: [
      { code: 0, column, row, suffix: "M" },
      { code: 32, column, row: row + 1, suffix: "M" },
      { code: 32, column, row: dragRow, suffix: "M" },
      { code: 0, column, row: dragRow, suffix: "m" },
    ],
    session: "persistent",
    socket,
  });
  const mouseSelection = paneCopyState(socket, codexPane);
  assert.equal(
    mouseSelection.inMode,
    "1",
    JSON.stringify({
      codexPane,
      hudPane,
      mouseSelection,
      paneHeight,
      paneLeft,
      paneTop,
      row,
      rootDrag: tmuxKeyLine(socket, "root", "MouseDrag1Pane"),
    }),
  );
  assert.equal(mouseSelection.selectionPresent, "1");
  tmuxText(socket, ["send-keys", "-t", codexPane, "q"]);
  assert.equal(paneCopyState(socket, codexPane).inMode, "0");

  tmuxText(socket, ["copy-mode", "-e", "-t", codexPane]);
  tmuxText(socket, ["send-keys", "-t", codexPane, "-X", "-N", "20", "scroll-up"]);
  const beforeSelection = paneCopyState(socket, codexPane);
  assert.equal(beforeSelection.inMode, "1");
  assert.notEqual(beforeSelection.scrollPosition, "0");
  assert.equal(beforeSelection.selectionPresent, "0");
  tmuxText(socket, ["send-keys", "-t", codexPane, "Enter"]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(copiedPath), false);
  const serverEnv = tmuxEnvironment(socket, codexPane, env);
  assert.equal(
    copyHudSelection(codexPane, serverEnv, { copyCommand: copyFixture }),
    false,
  );
  assert.equal(copyHudSelection("not-a-pane", serverEnv), false);
  assert.equal(fs.existsSync(copiedPath), false);

  tmuxText(socket, ["send-keys", "-t", codexPane, "-X", "begin-selection"]);
  tmuxText(socket, ["send-keys", "-t", codexPane, "-X", "cursor-down"]);
  const selecting = paneCopyState(socket, codexPane);
  assert.equal(selecting.inMode, "1");
  assert.equal(selecting.selectionPresent, "1");

  await sendTmuxMouseEvents({
    events: [{ code: 64, column, row, suffix: "M" }],
    session: "persistent",
    socket,
  });
  const heldWheel = paneCopyState(socket, codexPane);
  assert.equal(heldWheel.inMode, "1");
  assert.equal(heldWheel.selectionPresent, "1");
  assert.notEqual(heldWheel.scrollPosition, "0");

  tmuxText(socket, ["send-keys", "-t", codexPane, "-X", "stop-selection"]);
  const stoppedSelection = paneCopyState(socket, codexPane);
  assert.equal(stoppedSelection.selectionPresent, "1");
  await sendTmuxMouseEvents({
    events: [{ code: 65, column, row, suffix: "M" }],
    session: "persistent",
    socket,
  });
  const stoppedWheel = paneCopyState(socket, codexPane);
  assert.equal(stoppedWheel.inMode, "1");
  assert.equal(stoppedWheel.selectionPresent, "1");
  assert.notEqual(stoppedWheel.scrollPosition, "0");

  tmuxText(socket, [
    "send-keys",
    "-t",
    codexPane,
    "-X",
    "copy-selection-no-clear",
    "-C",
    "expected-selection",
  ]);
  const expectedBuffer = tmuxBufferName(socket, "expected-selection");
  assert.ok(expectedBuffer);
  const expectedSelection = tmuxText(socket, [
    "show-buffer",
    "-b",
    expectedBuffer,
  ]);
  tmuxText(socket, ["delete-buffer", "-b", expectedBuffer]);

  const fixtureProbe = spawnSync(copyFixture, [], {
    encoding: "utf8",
    env: serverEnv,
    input: "fixture-probe",
  });
  assert.equal(
    fixtureProbe.status,
    0,
    fixtureProbe.error?.message ?? "copy fixture execution failed",
  );
  fs.truncateSync(copiedPath, 0);
  const beforeExplicitCopy = paneCopyState(socket, codexPane);
  assert.equal(
    copyHudSelection(codexPane, serverEnv, { copyCommand: copyFixture }),
    true,
    JSON.stringify({
      serverEnv: serverEnv.TMUX,
      state: tmuxText(socket, [
        "display-message",
        "-p",
        "-t",
        codexPane,
        "#{pane_in_mode}\t#{pane_mode}\t#{selection_present}\t#{socket_path},#{pid}",
      ]).trim(),
    }),
  );
  assert.equal(await waitForFileText(copiedPath), expectedSelection);
  assert.deepEqual(paneCopyState(socket, codexPane), beforeExplicitCopy);
  assert.doesNotMatch(
    tmuxText(socket, ["list-buffers", "-F", "#{buffer_name}"]),
    /codex-hud-selection-/u,
  );

  fs.truncateSync(copiedPath, 0);
  tmuxText(socket, ["send-keys", "-t", codexPane, "Enter"]);
  assert.equal(
    await waitForFileText(copiedPath),
    expectedSelection,
    JSON.stringify({
      enter: tmuxKeyLine(socket, "copy-mode", "Enter"),
      messages: tmuxText(socket, ["show-messages"]),
      state: paneCopyState(socket, codexPane),
    }),
  );
  assert.deepEqual(paneCopyState(socket, codexPane), beforeExplicitCopy);

  const [hudLeft, hudTop] = tmuxText(socket, [
    "display-message",
    "-p",
    "-t",
    hudPane,
    "#{pane_left}\t#{pane_top}",
  ])
    .trim()
    .split("\t")
    .map(Number);
  await sendTmuxMouseEvents({
    events: [
      { code: 0, column: hudLeft + 2, row: hudTop + 1, suffix: "M" },
      { code: 0, column: hudLeft + 2, row: hudTop + 1, suffix: "m" },
    ],
    session: "persistent",
    socket,
  });
  assert.match(await waitForFileText(clickCapture), /^__hud-click\t/u);
  assert.deepEqual(paneCopyState(socket, codexPane), beforeExplicitCopy);

  tmuxText(socket, ["send-keys", "-t", codexPane, "q"]);
  assert.equal(paneCopyState(socket, codexPane).inMode, "0");
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
 * Send real SGR mouse reports through an attached xterm client. This exercises
 * tmux's root/copy-mode mouse dispatch instead of merely invoking the bound
 * copy-mode commands directly.
 *
 * @param {{
 *   events: Array<{code: number, column: number, row: number, suffix: "M" | "m"}>,
 *   session: string,
 *   socket: string
 * }} options
 */
async function sendTmuxMouseEvents({ events, session, socket }) {
  for (const event of events) {
    if (
      !Number.isInteger(event.code) ||
      !Number.isInteger(event.column) ||
      !Number.isInteger(event.row) ||
      event.column < 1 ||
      event.row < 1 ||
      (event.suffix !== "M" && event.suffix !== "m")
    ) {
      throw new Error("invalid tmux mouse fixture event");
    }
  }
  const script = [
    "set timeout 5",
    'set env(TERM) "xterm-256color"',
    "spawn -noecho sh",
    'send -- "stty rows 30 columns 100\\r"',
    "expect -re {[$#] }",
    `send -- "exec tmux -L ${socket} attach-session -t ${session}\\r"`,
    "after 400",
    ...events.flatMap((event) => [
      `send -- "\\033\\[<${event.code};${event.column};${event.row}${event.suffix}"`,
      "after 250",
    ]),
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
      reject(new Error(`expect tmux mouse fixture failed: ${stderr.trim()}`));
    });
  });
}

/**
 * @param {string} filePath
 */
async function waitForFileText(filePath) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(filePath, "utf8");
      if (text.length > 0) {
        return text;
      }
    } catch {
      // The fixture command is asynchronous from tmux's point of view.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf8")
    : "";
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
 * The HUD pane renderer and tmux key installation start back-to-back. Wait for
 * the final key in each table so this integration test observes the completed
 * host setup rather than a partially installed binding set.
 *
 * @param {string} socket
 * @param {string} table
 * @param {string} key
 * @param {RegExp} pattern
 */
async function waitForKeyBinding(socket, table, key, pattern) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const binding = tmuxKeyLine(socket, table, key) ?? "";
    if (pattern.test(binding)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
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
 * @param {string} prefix
 */
function tmuxBufferName(socket, prefix) {
  return (
    tmuxText(socket, ["list-buffers", "-F", "#{buffer_name}"])
      .split(/\r?\n/u)
      .find((name) => name.startsWith(prefix)) ?? null
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
    "#{socket_path},#{pid},0",
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
  return {
    inMode,
    scrollPosition,
    selectionPresent: selectionPresent || "0",
  };
}
