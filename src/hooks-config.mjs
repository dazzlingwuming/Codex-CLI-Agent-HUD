import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HOOK_EVENTS, HOOK_MARKER } from "./constants.mjs";

/**
 * @param {NodeJS.ProcessEnv} env
 */
export function codexHome(env = process.env) {
  return path.resolve(env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex"));
}

/**
 * @param {string} value
 */
export function quoteShellArgument(value) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

/**
 * @param {{entryPath: string, nodePath?: string}} options
 */
export function buildHookCommand({
  entryPath,
  nodePath = process.execPath,
}) {
  return `${HOOK_MARKER}=1 ${quoteShellArgument(nodePath)} ${quoteShellArgument(entryPath)} __hook`;
}

/**
 * @param {{
 *   configHome?: string,
 *   entryPath: string,
 *   nodePath?: string,
 *   now?: Date
 * }} options
 */
export function setupHooks({
  configHome = codexHome(),
  entryPath,
  nodePath = process.execPath,
  now = new Date(),
}) {
  return mutateHooksFile({
    configHome,
    mutate(document) {
      const cleaned = removeHudHandlers(document);
      const command = buildHookCommand({ entryPath, nodePath });
      for (const hookEvent of HOOK_EVENTS) {
        if (!Array.isArray(cleaned.hooks[hookEvent])) {
          cleaned.hooks[hookEvent] = [];
        }
        cleaned.hooks[hookEvent].push(hookGroup(hookEvent, command));
      }
      return cleaned;
    },
    now,
  });
}

/**
 * @param {{configHome?: string, now?: Date}} options
 */
export function uninstallHooks({
  configHome = codexHome(),
  now = new Date(),
} = {}) {
  return mutateHooksFile({
    allowMissing: true,
    configHome,
    mutate: removeHudHandlers,
    now,
  });
}

/**
 * @param {Record<string, any>} document
 */
export function removeHudHandlers(document) {
  const result = structuredClone(document);
  if (!result.hooks || typeof result.hooks !== "object" || Array.isArray(result.hooks)) {
    result.hooks = {};
    return result;
  }

  for (const [eventName, groups] of Object.entries(result.hooks)) {
    if (!Array.isArray(groups)) {
      continue;
    }
    result.hooks[eventName] = groups.flatMap((group) => {
      if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) {
        return [group];
      }
      const hooks = group.hooks.filter(
        (/** @type {unknown} */ handler) => !isHudHandler(handler),
      );
      return hooks.length > 0 ? [{ ...group, hooks }] : [];
    });
  }
  return result;
}

/**
 * @param {unknown} handler
 */
export function isHudHandler(handler) {
  return Boolean(
    handler &&
      typeof handler === "object" &&
      typeof /** @type {Record<string, unknown>} */ (handler).command ===
        "string" &&
      /** @type {Record<string, string>} */ (handler).command.includes(
        `${HOOK_MARKER}=1`,
      ),
  );
}

/**
 * @param {string} eventName
 * @param {string} command
 */
function hookGroup(eventName, command) {
  const matcher = {
    SessionStart: "startup|resume|clear|compact",
    SessionEnd: "other",
    PreCompact: "manual|auto",
    PostCompact: "manual|auto",
  }[eventName];

  return {
    ...(matcher ? { matcher } : {}),
    hooks: [
      {
        command,
        timeout: 1,
        type: "command",
      },
    ],
  };
}

/**
 * @param {{
 *   allowMissing?: boolean,
 *   configHome: string,
 *   mutate(document: Record<string, any>): Record<string, any>,
 *   now: Date
 * }} options
 */
function mutateHooksFile({
  allowMissing = false,
  configHome,
  mutate,
  now,
}) {
  fs.mkdirSync(configHome, { recursive: true, mode: 0o700 });
  const lockPath = path.join(configHome, ".codex-hud-hooks.lock");
  const hooksPath = path.join(configHome, "hooks.json");

  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    throw new Error(
      `Cannot lock ${hooksPath}; another codex-hud setup may be running.`,
      { cause: error },
    );
  }

  try {
    const exists = fs.existsSync(hooksPath);
    if (!exists && allowMissing) {
      return { backupPath: null, changed: false, hooksPath };
    }

    const original = exists ? fs.readFileSync(hooksPath, "utf8") : "";
    /** @type {Record<string, any>} */
    let document = { hooks: {} };
    if (exists) {
      try {
        document = JSON.parse(original);
      } catch (error) {
        throw new Error(
          `${hooksPath} is not valid JSON; no changes were written.`,
          { cause: error },
        );
      }
      if (!document || typeof document !== "object" || Array.isArray(document)) {
        throw new Error(
          `${hooksPath} must contain a JSON object; no changes were written.`,
        );
      }
      if (
        document.hooks !== undefined &&
        (!document.hooks ||
          typeof document.hooks !== "object" ||
          Array.isArray(document.hooks))
      ) {
        throw new Error(
          `${hooksPath} has an invalid "hooks" value; no changes were written.`,
        );
      }
      document.hooks ??= {};
    }

    const updated = `${JSON.stringify(mutate(document), null, 2)}\n`;
    if (updated === original) {
      return { backupPath: null, changed: false, hooksPath };
    }

    const backupPath = exists
      ? `${hooksPath}.codex-hud-backup-${timestamp(now)}`
      : null;
    if (backupPath) {
      fs.copyFileSync(hooksPath, backupPath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backupPath, 0o600);
    }

    const temporary = `${hooksPath}.tmp-${randomUUID()}`;
    try {
      fs.writeFileSync(temporary, updated, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temporary, hooksPath);
      fs.chmodSync(hooksPath, 0o600);
    } finally {
      if (fs.existsSync(temporary)) {
        fs.rmSync(temporary);
      }
    }

    return { backupPath, changed: true, hooksPath };
  } finally {
    fs.rmdirSync(lockPath);
  }
}

/**
 * @param {Date} value
 */
function timestamp(value) {
  return value.toISOString().replace(/[:.]/gu, "-");
}
