import {
  DEBUG_ENV,
  RUN_DIRECTORY_ENV,
} from "./constants.mjs";
import { normalizeHookInput } from "./events.mjs";
import { writeEventAtomic } from "./run-directory.mjs";

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;

/**
 * @param {NodeJS.ReadableStream} stream
 */
export async function readHookInput(stream = process.stdin) {
  let value = "";
  for await (const chunk of stream) {
    value += String(chunk);
    if (Buffer.byteLength(value, "utf8") > MAX_HOOK_INPUT_BYTES) {
      throw new Error("Hook input exceeds 1 MiB.");
    }
  }
  return JSON.parse(value);
}

/**
 * Hooks must never steer or block Codex. Failures are debug-only and the
 * process always returns success.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   input?: NodeJS.ReadableStream,
 *   stderr?: {write(value: string): unknown}
 * }} options
 */
export async function runHook({
  env = process.env,
  input = process.stdin,
  stderr = process.stderr,
} = {}) {
  const runDirectory = env[RUN_DIRECTORY_ENV];
  if (!runDirectory) {
    return 0;
  }

  try {
    const raw = await readHookInput(input);
    const event = normalizeHookInput(raw);
    if (event) {
      writeEventAtomic(runDirectory, event, env);
    }
  } catch (error) {
    if (env[DEBUG_ENV] === "1") {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(`codex-hud hook degraded: ${message}\n`);
    }
  }
  return 0;
}
