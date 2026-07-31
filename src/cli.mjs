#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from "node:url";

import { runHook } from "./hook-runner.mjs";
import {
  codexHome,
  setupHooks,
  uninstallHooks,
} from "./hooks-config.mjs";

export const VERSION = "0.1.0";

export function helpText() {
  return `Codex CLI Agent HUD ${VERSION}

Usage:
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

  if (command === "setup") {
    try {
      const result = setupHooks({
        configHome: codexHome(),
        entryPath: fileURLToPath(import.meta.url),
      });
      io.stdout.write(
        result.changed
          ? `Installed Codex HUD hooks in ${result.hooksPath}.\n`
          : `Codex HUD hooks are already current in ${result.hooksPath}.\n`,
      );
      if (result.backupPath) {
        io.stdout.write(`Backup: ${result.backupPath}\n`);
      }
      io.stdout.write(
        "Open Codex, run /hooks, and trust the Codex HUD hook definition once.\n",
      );
      return 0;
    } catch (error) {
      io.stderr.write(`codex-hud setup failed: ${errorMessage(error)}\n`);
      return 2;
    }
  }

  if (command === "uninstall") {
    try {
      const result = uninstallHooks({ configHome: codexHome() });
      io.stdout.write(
        result.changed
          ? `Removed Codex HUD hooks from ${result.hooksPath}.\n`
          : `No Codex HUD hooks were found in ${result.hooksPath}.\n`,
      );
      if (result.backupPath) {
        io.stdout.write(`Backup: ${result.backupPath}\n`);
      }
      io.stdout.write(
        "To remove the command too, run: npm uninstall -g codex-cli-agent-hud\n",
      );
      return 0;
    } catch (error) {
      io.stderr.write(`codex-hud uninstall failed: ${errorMessage(error)}\n`);
      return 2;
    }
  }

  io.stderr.write(
    "codex-hud: implementation is not complete yet; run with --help for the planned interface.\n",
  );
  return 2;
}

/**
 * @param {unknown} error
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  process.exitCode = await runCli(process.argv.slice(2));
}
