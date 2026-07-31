import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  RUN_DIRECTORY_MAGIC,
  STATE_ROOT_ENV,
} from "./constants.mjs";

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * @param {NodeJS.ProcessEnv} env
 */
export function stateRoot(env = process.env) {
  if (env[STATE_ROOT_ENV]) {
    return path.resolve(env[STATE_ROOT_ENV]);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `codex-hud-${uid}`);
}

/**
 * @param {{cwd: string, launchId?: string, startedAtMs?: number, env?: NodeJS.ProcessEnv}} options
 */
export function createRunDirectory({
  cwd,
  launchId = randomUUID(),
  startedAtMs = Date.now(),
  env = process.env,
}) {
  const root = stateRoot(env);
  ensurePrivateDirectory(root);
  cleanupStaleRuns({ env, now: startedAtMs });

  const runDirectory = path.join(root, `run-${launchId}`);
  fs.mkdirSync(runDirectory, { mode: 0o700 });
  fs.mkdirSync(path.join(runDirectory, "events"), { mode: 0o700 });
  writeJsonAtomic(path.join(runDirectory, "meta.json"), {
    cwd,
    launchId,
    magic: RUN_DIRECTORY_MAGIC,
    startedAtMs,
  });
  return runDirectory;
}

/**
 * @param {string} runDirectory
 * @param {NodeJS.ProcessEnv} env
 */
export function validateRunDirectory(runDirectory, env = process.env) {
  try {
    if (!path.isAbsolute(runDirectory)) {
      return false;
    }

    const root = fs.realpathSync(stateRoot(env));
    const candidate = fs.realpathSync(runDirectory);
    const relative = path.relative(root, candidate);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return false;
    }

    const stat = fs.statSync(candidate);
    if (!stat.isDirectory()) {
      return false;
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      return false;
    }

    const meta = readJson(path.join(candidate, "meta.json"));
    return (
      meta !== null &&
      meta.magic === RUN_DIRECTORY_MAGIC &&
      fs.statSync(path.join(candidate, "events")).isDirectory()
    );
  } catch {
    return false;
  }
}

/**
 * @param {string} runDirectory
 * @param {Record<string, any>} event
 * @param {NodeJS.ProcessEnv} env
 */
export function writeEventAtomic(
  runDirectory,
  event,
  env = process.env,
) {
  if (!validateRunDirectory(runDirectory, env)) {
    return false;
  }

  const eventsDirectory = path.join(runDirectory, "events");
  const name = `${String(event.observedAtMs).padStart(16, "0")}-${process.pid}-${event.id}.json`;
  writeJsonAtomic(path.join(eventsDirectory, name), event);
  return true;
}

/**
 * @param {string} runDirectory
 * @returns {Array<{name: string, event: Record<string, any>}>}
 */
export function readEventFiles(runDirectory) {
  const eventsDirectory = path.join(runDirectory, "events");
  return fs
    .readdirSync(eventsDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      const event = readJson(path.join(eventsDirectory, name));
      return event ? [{ name, event }] : [];
    });
}

/**
 * @param {{env?: NodeJS.ProcessEnv, now?: number, maxAgeMs?: number}} options
 */
export function cleanupStaleRuns({
  env = process.env,
  now = Date.now(),
  maxAgeMs = DAY_MS,
} = {}) {
  const root = stateRoot(env);
  if (!fs.existsSync(root)) {
    return 0;
  }

  let removed = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("run-")) {
      continue;
    }

    const candidate = path.join(root, entry.name);
    try {
      const stat = fs.statSync(candidate);
      if (
        now - stat.mtimeMs > maxAgeMs &&
        validateRunDirectory(candidate, env)
      ) {
        fs.rmSync(candidate, { recursive: true });
        removed += 1;
      }
    } catch {
      // A concurrent process may already have removed the directory.
    }
  }
  return removed;
}

/**
 * @param {string} runDirectory
 * @param {NodeJS.ProcessEnv} env
 */
export function removeRunDirectory(runDirectory, env = process.env) {
  if (!validateRunDirectory(runDirectory, env)) {
    return false;
  }
  fs.rmSync(runDirectory, { recursive: true });
  return true;
}

/**
 * @param {string} directory
 */
function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

/**
 * @param {string} destination
 * @param {unknown} value
 */
function writeJsonAtomic(destination, value) {
  const temporary = `${destination}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } finally {
    if (fs.existsSync(temporary)) {
      fs.rmSync(temporary);
    }
  }
}

/**
 * @param {string} filename
 * @returns {Record<string, any> | null}
 */
function readJson(filename) {
  try {
    const value = JSON.parse(fs.readFileSync(filename, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}
