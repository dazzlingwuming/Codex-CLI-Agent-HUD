#!/usr/bin/env node

import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  collectDoctorChecks,
  doctorExitCode,
  formatDoctorText,
} from "./doctor.mjs";
import {
  runOriginalCodex,
  shouldUseHudForCodex,
} from "./codex-routing.mjs";
import { runHook } from "./hook-runner.mjs";
import {
  codexHome,
  setupHooks,
  uninstallHooks,
} from "./hooks-config.mjs";
import { runRenderer } from "./renderer.mjs";
import {
  cleanupStaleRuns,
  writeControlAtomic,
  writeRunJson,
} from "./run-directory.mjs";
import {
  setupShellIntegration,
  uninstallShellIntegration,
} from "./shell-integration.mjs";
import {
  runHud,
  runInsideTmux,
} from "./tmux-host.mjs";

export const VERSION = "0.1.0";

export function helpText() {
  return `Codex CLI Agent HUD ${VERSION}

Usage:
  codex                    Start interactive Codex with HUD after setup
  codex-hud
  codex-hud run -- [codex options]
  codex-hud setup
  codex-hud doctor [--json]
  codex-hud uninstall

Options:
  -h, --help       Show this help
  -V, --version    Show the version
`;
}

/**
 * @param {string[]} argv
 * @param {{stdout: {write(value: string): unknown}, stderr: {write(value: string): unknown}}} io
 */
export async function runCli(
  argv,
  io = { stdout: process.stdout, stderr: process.stderr },
) {
  const [command] = argv;
  if (command === "--help" || command === "-h") {
    io.stdout.write(helpText());
    return 0;
  }

  if (command === "--version" || command === "-V") {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (command === "__hook") {
    return runHook();
  }

  if (command === "__toggle") {
    const runDirectory = argv[1];
    if (!runDirectory) {
      return 2;
    }
    return writeControlAtomic(runDirectory, {
      kind: "todo.toggle",
      observedAtMs: Date.now(),
      version: 1,
    })
      ? 0
      : 2;
  }

  if (command === "__codex") {
    const codexArgs = forwardedArguments(argv.slice(1));
    if (!shouldUseHudForCodex(codexArgs)) {
      return runOriginalCodex(codexArgs, { stderr: io.stderr });
    }
    return runHudSafely(codexArgs, io);
  }

  if (command === "__render") {
    const runDirectory = argv[1];
    if (!runDirectory) {
      return 2;
    }
    try {
      return await runRenderer({ runDirectory });
    } catch (error) {
      io.stderr.write(`codex-hud renderer degraded: ${errorMessage(error)}\n`);
      return 2;
    }
  }

  if (command === "__inside") {
    const runDirectory = argv[1];
    if (!runDirectory) {
      return 2;
    }
    try {
      return await runInsideTmux({ runDirectory, stderr: io.stderr });
    } catch (error) {
      writeRunJson(runDirectory, "exit.json", { code: 2 });
      io.stderr.write(`codex-hud host failed: ${errorMessage(error)}\n`);
      return 2;
    }
  }

  if (command === "setup") {
    try {
      const hooksResult = setupHooks({
        configHome: codexHome(),
        entryPath: fileURLToPath(import.meta.url),
      });
      const shellResult = setupShellIntegration();
      io.stdout.write(
        hooksResult.changed
          ? `Installed Codex HUD hooks in ${hooksResult.hooksPath}.\n`
          : `Codex HUD hooks are already current in ${hooksResult.hooksPath}.\n`,
      );
      if (hooksResult.backupPath) {
        io.stdout.write(`Hooks backup: ${hooksResult.backupPath}\n`);
      }
      io.stdout.write(
        shellResult.changed
          ? `Installed the interactive codex entry in ${shellResult.rcPath}.\n`
          : `The interactive codex entry is already current in ${shellResult.rcPath}.\n`,
      );
      if (shellResult.backupPath) {
        io.stdout.write(`Shell backup: ${shellResult.backupPath}\n`);
      }
      const removedRuns = cleanupStaleRuns();
      if (removedRuns > 0) {
        io.stdout.write(`Removed ${removedRuns} stale HUD run directories.\n`);
      }
      io.stdout.write(
        "Open a new terminal (or source ~/.zshrc), run codex, then use /hooks to trust the HUD handlers once.\n",
      );
      return 0;
    } catch (error) {
      io.stderr.write(`codex-hud setup failed: ${errorMessage(error)}\n`);
      return 2;
    }
  }

  if (command === "uninstall") {
    try {
      const shellResult = uninstallShellIntegration();
      const hooksResult = uninstallHooks({ configHome: codexHome() });
      io.stdout.write(
        hooksResult.changed
          ? `Removed Codex HUD hooks from ${hooksResult.hooksPath}.\n`
          : `No Codex HUD hooks were found in ${hooksResult.hooksPath}.\n`,
      );
      if (hooksResult.backupPath) {
        io.stdout.write(`Hooks backup: ${hooksResult.backupPath}\n`);
      }
      io.stdout.write(
        shellResult.changed
          ? `Removed the interactive codex entry from ${shellResult.rcPath}.\n`
          : `No interactive codex entry was found in ${shellResult.rcPath}.\n`,
      );
      if (shellResult.backupPath) {
        io.stdout.write(`Shell backup: ${shellResult.backupPath}\n`);
      }
      io.stdout.write(
        "To remove the command too, run npm uninstall -g codex-cli-agent-hud with the same --prefix used during installation.\n",
      );
      return 0;
    } catch (error) {
      io.stderr.write(`codex-hud uninstall failed: ${errorMessage(error)}\n`);
      return 2;
    }
  }

  if (command === "doctor") {
    const checks = collectDoctorChecks();
    if (argv[1] === "--json") {
      io.stdout.write(`${JSON.stringify({ checks }, null, 2)}\n`);
    } else {
      io.stdout.write(formatDoctorText(checks));
    }
    return doctorExitCode(checks);
  }

  const codexArgs =
    command === "run"
      ? forwardedArguments(argv.slice(1))
      : forwardedArguments(argv);
  return runHudSafely(codexArgs, io);
}

/**
 * @param {string[]} codexArgs
 * @param {{stdout: {write(value: string): unknown}, stderr: {write(value: string): unknown}}} io
 */
async function runHudSafely(codexArgs, io) {
  try {
    return await runHud({
      codexArgs,
      entryPath: fileURLToPath(import.meta.url),
      stderr: /** @type {NodeJS.WriteStream} */ (io.stderr),
      stdout: /** @type {NodeJS.WriteStream} */ (io.stdout),
    });
  } catch (error) {
    io.stderr.write(`codex-hud: ${errorMessage(error)}\n`);
    return 2;
  }
}

/**
 * @param {string[]} values
 */
export function forwardedArguments(values) {
  return values[0] === "--" ? values.slice(1) : values;
}

/**
 * @param {unknown} error
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

const entrypointPath =
  process.argv[1] === undefined
    ? null
    : fs.realpathSync.native(process.argv[1]);
const isEntrypoint =
  entrypointPath !== null &&
  import.meta.url === pathToFileURL(entrypointPath).href;

if (isEntrypoint) {
  process.exitCode = await runCli(process.argv.slice(2));
}
