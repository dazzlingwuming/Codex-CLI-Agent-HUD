import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SHELL_MARKER_START =
  "# >>> Codex HUD interactive entry >>>";
export const SHELL_MARKER_END =
  "# <<< Codex HUD interactive entry <<<";

const SHELL_BLOCK = `${SHELL_MARKER_START}
codex() {
  command codex-hud __codex -- "$@"
}
${SHELL_MARKER_END}`;

/**
 * @param {NodeJS.ProcessEnv} env
 */
export function shellRcPath(env = process.env) {
  return path.join(env.HOME || os.homedir(), ".zshrc");
}

/**
 * @param {{rcPath?: string, now?: Date}} options
 */
export function setupShellIntegration({
  rcPath = shellRcPath(),
  now = new Date(),
} = {}) {
  return mutateShellFile({
    mutate(original) {
      const cleaned = removeShellIntegration(original);
      if (
        /^(?:\s*alias\s+codex=|\s*(?:function\s+)?codex\s*\(\))/mu.test(
          cleaned,
        )
      ) {
        throw new Error(
          `${rcPath} already defines codex outside the Codex HUD block; no changes were written.`,
        );
      }
      return `${cleaned}${cleaned ? "\n" : ""}${SHELL_BLOCK}\n`;
    },
    now,
    rcPath,
  });
}

/**
 * @param {{rcPath?: string, now?: Date}} options
 */
export function uninstallShellIntegration({
  rcPath = shellRcPath(),
  now = new Date(),
} = {}) {
  return mutateShellFile({
    allowMissing: true,
    mutate: removeShellIntegration,
    now,
    rcPath,
  });
}

/**
 * @param {string} content
 */
export function hasShellIntegration(content) {
  return (
    content.includes(SHELL_MARKER_START) &&
    content.includes(SHELL_MARKER_END)
  );
}

/**
 * @param {string} content
 */
export function removeShellIntegration(content) {
  const start = content.indexOf(SHELL_MARKER_START);
  const end = content.indexOf(SHELL_MARKER_END);
  if (start < 0 && end < 0) {
    return content;
  }
  if (start < 0 || end < start) {
    throw new Error(
      "The Codex HUD shell integration markers are incomplete; no changes were written.",
    );
  }
  const secondStart = content.indexOf(
    SHELL_MARKER_START,
    start + SHELL_MARKER_START.length,
  );
  if (secondStart >= 0) {
    throw new Error(
      "Multiple Codex HUD shell integration blocks were found; no changes were written.",
    );
  }

  let removalStart = start;
  if (removalStart > 0 && content[removalStart - 1] === "\n") {
    removalStart -= 1;
  }
  const markerEnd = end + SHELL_MARKER_END.length;
  const removalEnd =
    content[markerEnd] === "\n" ? markerEnd + 1 : markerEnd;
  return content.slice(0, removalStart) + content.slice(removalEnd);
}

/**
 * @param {{
 *   allowMissing?: boolean,
 *   mutate(content: string): string,
 *   now: Date,
 *   rcPath: string
 * }} options
 */
function mutateShellFile({
  allowMissing = false,
  mutate,
  now,
  rcPath,
}) {
  const exists = fs.existsSync(rcPath);
  if (!exists && allowMissing) {
    return { backupPath: null, changed: false, rcPath };
  }
  if (exists && !fs.statSync(rcPath).isFile()) {
    throw new Error(`${rcPath} is not a regular file; no changes were written.`);
  }

  const original = exists ? fs.readFileSync(rcPath, "utf8") : "";
  const updated = mutate(original);
  if (updated === original) {
    return { backupPath: null, changed: false, rcPath };
  }

  const backupPath = exists
    ? `${rcPath}.codex-hud-backup-${timestamp(now)}`
    : null;
  if (backupPath) {
    fs.copyFileSync(rcPath, backupPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupPath, 0o600);
  }

  const mode = exists ? fs.statSync(rcPath).mode & 0o777 : 0o644;
  const temporary = `${rcPath}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, updated, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
    fs.renameSync(temporary, rcPath);
    fs.chmodSync(rcPath, mode);
  } finally {
    if (fs.existsSync(temporary)) {
      fs.rmSync(temporary);
    }
  }

  return { backupPath, changed: true, rcPath };
}

/**
 * @param {Date} value
 */
function timestamp(value) {
  return value.toISOString().replace(/[:.]/gu, "-");
}
