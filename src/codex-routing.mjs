import { spawn } from "node:child_process";

const INTERACTIVE_SUBCOMMANDS = new Set(["fork", "resume"]);
const PASSTHROUGH_SUBCOMMANDS = new Set([
  "a",
  "app",
  "app-server",
  "apply",
  "archive",
  "cloud",
  "completion",
  "debug",
  "delete",
  "doctor",
  "e",
  "exec",
  "exec-server",
  "features",
  "help",
  "login",
  "logout",
  "mcp",
  "mcp-server",
  "plugin",
  "remote-control",
  "review",
  "sandbox",
  "unarchive",
  "update",
]);
const OPTIONS_WITH_VALUE = new Set([
  "--add-dir",
  "--ask-for-approval",
  "--cd",
  "--config",
  "--disable",
  "--enable",
  "--image",
  "--local-provider",
  "--model",
  "--profile",
  "--remote",
  "--remote-auth-token-env",
  "--sandbox",
  "-C",
  "-a",
  "-c",
  "-i",
  "-m",
  "-p",
  "-s",
]);

/**
 * Decide whether a direct `codex` invocation should open the interactive HUD.
 *
 * @param {string[]} args
 * @param {{stdinIsTTY?: boolean, stdoutIsTTY?: boolean}} options
 */
export function shouldUseHudForCodex(
  args,
  {
    stdinIsTTY = Boolean(process.stdin.isTTY),
    stdoutIsTTY = Boolean(process.stdout.isTTY),
  } = {},
) {
  if (!stdinIsTTY || !stdoutIsTTY) {
    return false;
  }
  if (
    args.some((value) =>
      ["--help", "--version", "-h", "-V"].includes(value),
    )
  ) {
    return false;
  }

  const subcommand = findSubcommand(args);
  if (subcommand && PASSTHROUGH_SUBCOMMANDS.has(subcommand)) {
    return false;
  }
  return subcommand === null || INTERACTIVE_SUBCOMMANDS.has(subcommand);
}

/**
 * @param {string[]} args
 */
export function findSubcommand(args) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--") {
      return null;
    }
    if (OPTIONS_WITH_VALUE.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("-")) {
      continue;
    }
    if (
      INTERACTIVE_SUBCOMMANDS.has(value) ||
      PASSTHROUGH_SUBCOMMANDS.has(value)
    ) {
      return value;
    }
    return null;
  }
  return null;
}

/**
 * @param {string[]} args
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   stderr?: {write(value: string): unknown}
 * }} options
 */
export function runOriginalCodex(
  args,
  {
    env = process.env,
    cwd = process.cwd(),
    stderr = process.stderr,
  } = {},
) {
  return new Promise((resolve) => {
    const child = spawn("codex", args, {
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
      stderr.write(`codex-hud: cannot start original Codex: ${error.message}\n`);
      finish(127);
    });
    child.once("exit", (code, signal) => {
      const signalCode =
        signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
      finish(typeof code === "number" ? code : signalCode);
    });
  });
}
