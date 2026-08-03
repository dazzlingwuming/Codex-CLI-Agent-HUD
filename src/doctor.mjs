import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { HOOK_EVENTS, HOOK_MARKER } from "./constants.mjs";
import { codexHome } from "./hooks-config.mjs";
import {
  hasShellIntegration,
  shellRcPath,
} from "./shell-integration.mjs";

/**
 * @typedef {{
 *   name: string,
 *   status: "ok" | "warn" | "fail",
 *   detail: string,
 *   recovery?: string
 * }} DoctorCheck
 */

/**
 * @param {{env?: NodeJS.ProcessEnv, stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream}} options
 */
export function collectDoctorChecks({
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
} = {}) {
  /** @type {DoctorCheck[]} */
  const checks = [];
  checks.push({
    name: "platform",
    status: process.platform === "darwin" ? "ok" : "fail",
    detail: `${process.platform} ${process.arch}`,
    recovery: "Codex HUD v0.1 currently requires macOS.",
  });
  checks.push(commandCheck("codex", ["--version"], "Install or repair Codex CLI."));
  checks.push(
    commandCheck(
      "codex-hud",
      ["--version"],
      "Install it with: npm install -g .",
    ),
  );
  checks.push(
    commandCheck("tmux", ["-V"], "Install it with: brew install tmux"),
  );
  checks.push({
    name: "node",
    status: Number(process.versions.node.split(".")[0]) >= 20 ? "ok" : "fail",
    detail: `Node ${process.versions.node}`,
    recovery: "Install Node.js 20 or newer.",
  });

  checks.push(terminalCheck(env));
  checks.push({
    name: "tty",
    status: stdin.isTTY && stdout.isTTY ? "ok" : "warn",
    detail: stdin.isTTY && stdout.isTTY ? "interactive" : "not interactive",
    recovery: "Run codex-hud from an interactive terminal.",
  });
  checks.push(hooksFeatureCheck());
  checks.push(hooksCheck(env));
  checks.push(shellIntegrationCheck(env));
  return checks;
}

/**
 * @param {DoctorCheck[]} checks
 */
export function formatDoctorText(checks) {
  const marker = { fail: "XX", ok: "ok", warn: "!!" };
  const lines = ["Codex HUD Doctor", ""];
  for (const check of checks) {
    lines.push(`[${marker[check.status]}] ${check.name.padEnd(10)} ${check.detail}`);
    if (check.status !== "ok" && check.recovery) {
      lines.push(`     recovery: ${check.recovery}`);
    }
  }
  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  lines.push("", `${checks.length - failures - warnings} ok | ${warnings} warn | ${failures} fail`);
  return `${lines.join("\n")}\n`;
}

/**
 * @param {DoctorCheck[]} checks
 */
export function doctorExitCode(checks) {
  return checks.some((check) => check.status === "fail") ? 2 : 0;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} recovery
 * @returns {DoctorCheck}
 */
function commandCheck(command, args, recovery) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return {
      name: command,
      status: "fail",
      detail: result.error?.message || result.stderr.trim() || "unavailable",
      recovery,
    };
  }
  return {
    name: command,
    status: "ok",
    detail: (result.stdout || result.stderr).trim().split(/\r?\n/u)[0],
  };
}

/**
 * @returns {DoctorCheck}
 */
function hooksFeatureCheck() {
  const result = spawnSync("codex", ["features", "list"], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return {
      name: "hook flag",
      status: "fail",
      detail: result.error?.message || result.stderr.trim() || "unavailable",
      recovery: "Enable Codex Hooks in ~/.codex/config.toml.",
    };
  }
  const enabled = result.stdout
    .split(/\r?\n/u)
    .some((line) => /^hooks\s+\S+\s+true\s*$/u.test(line));
  return enabled
    ? {
        name: "hook flag",
        status: "ok",
        detail: "Codex lifecycle hooks enabled",
      }
    : {
        name: "hook flag",
        status: "fail",
        detail: "Codex lifecycle hooks disabled",
        recovery: "Set [features] hooks = true in ~/.codex/config.toml.",
      };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {DoctorCheck}
 */
function hooksCheck(env) {
  const hooksPath = path.join(codexHome(env), "hooks.json");
  try {
    const document = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
    const missing = HOOK_EVENTS.filter((eventName) => {
      const groups = document.hooks?.[eventName];
      return !(
        Array.isArray(groups) &&
        groups.some(
          (group) =>
            Array.isArray(group?.hooks) &&
            group.hooks.some(
              (/** @type {Record<string, any>} */ handler) =>
                typeof handler?.command === "string" &&
                handler.command.includes(`${HOOK_MARKER}=1`),
            ),
        )
      );
    });
    return missing.length === 0
      ? {
          name: "hooks",
          status: "ok",
          detail: `${HOOK_EVENTS.length} HUD lifecycle events installed`,
        }
      : {
          name: "hooks",
          status: "fail",
          detail: `missing: ${missing.join(", ")}`,
          recovery: "Run: codex-hud setup",
        };
  } catch (error) {
    return {
      name: "hooks",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      recovery: "Run: codex-hud setup",
    };
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {DoctorCheck}
 */
function terminalCheck(env) {
  const identity = [
    env.TERM_PROGRAM,
    env.TERMINAL_EMULATOR,
    env.__CFBundleIdentifier,
    env.TERM,
  ]
    .filter(Boolean)
    .join(" ");
  const normalized = identity.toLowerCase();

  if (isJetBrainsTerminal(env)) {
    return {
      name: "terminal",
      status: "warn",
      detail: `${identity || "JetBrains terminal"} (manual GUI verification required: persistent tmux selection and explicit copy action; use IDE 2025.3.2+)`,
      recovery:
        "Turn Mouse reporting on and Copy to clipboard on selection off. In a HUD-owned isolated tmux session, verify that the tmux highlight survives wheel scrolling and that [复制所选] or Enter in selection/history mode copies only on demand. JetBrains native selection may be transient; tmux highlight is the source of truth. Doctor cannot read or change IDE settings.",
    };
  }
  if (
    /apple_terminal|com\.apple\.terminal|vscode|iterm|warp|wezterm|alacritty|kitty|xterm|screen|tmux/u.test(
      normalized,
    )
  ) {
    return {
      name: "terminal",
      status: "warn",
      detail: `${identity || "xterm-compatible terminal"} (manual GUI verification required: persistent tmux selection and explicit copy action)`,
      recovery:
        "In a HUD-owned isolated tmux session, verify selection while holding the mouse button and scrolling, selection after release and scrolling, and explicit copy through [复制所选] or Enter in selection/history mode.",
    };
  }
  return {
    name: "terminal",
    status: "warn",
    detail: `${identity || "unknown terminal"} (manual GUI verification required: persistent tmux selection and explicit copy action)`,
    recovery:
      "Use an xterm-compatible macOS terminal; in a HUD-owned isolated tmux session, manually verify persistent selection and explicit copy before relying on mouse controls.",
  };
}

/**
 * Keep doctor independent from the optional HUD control renderer: diagnostics
 * still need to identify JetBrains-specific manual settings even if controls
 * are unavailable in a particular terminal.
 *
 * @param {NodeJS.ProcessEnv} env
 */
function isJetBrainsTerminal(env) {
  return /jetbrains|jediterm|pycharm|intellij/u.test(
    [env.TERM_PROGRAM, env.TERMINAL_EMULATOR, env.__CFBundleIdentifier]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
  );
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {DoctorCheck}
 */
function shellIntegrationCheck(env) {
  const rcPath = shellRcPath(env);
  try {
    const content = fs.readFileSync(rcPath, "utf8");
    return hasShellIntegration(content)
      ? {
          name: "shell",
          status: "ok",
          detail: `interactive codex entry installed in ${rcPath}`,
        }
      : {
          name: "shell",
          status: "fail",
          detail: `interactive codex entry missing from ${rcPath}`,
          recovery: "Run: codex-hud setup",
        };
  } catch (error) {
    return {
      name: "shell",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      recovery: "Run: codex-hud setup",
    };
  }
}
