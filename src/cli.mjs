#!/usr/bin/env node

import { pathToFileURL } from "node:url";

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
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout.write(helpText());
    return 0;
  }

  if (argv.includes("--version") || argv.includes("-V")) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }

  io.stderr.write(
    "codex-hud: implementation is not complete yet; run with --help for the planned interface.\n",
  );
  return 2;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  process.exitCode = await runCli(process.argv.slice(2));
}
