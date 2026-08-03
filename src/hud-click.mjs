import {
  DEFAULT_INTERACTION_MODE,
  hitTestModeButton,
  isInteractionMode,
} from "./interaction-mode.mjs";
import {
  readRunMeta,
  validateRunDirectory,
  writeControlAtomic,
} from "./run-directory.mjs";

/**
 * Route one tmux HUD click to either an explicit interaction mode or the
 * existing Todo control. tmux's mouse_x and mouse_y formats are already
 * zero-based coordinates relative to the mouse pane.
 *
 * @param {{
 *   runDirectory: string,
 *   sessionId: string,
 *   mouseX: string | number,
 *   mouseY: string | number,
 *   paneWidth: string | number,
 *   env?: NodeJS.ProcessEnv,
 *   now?: number,
 *   readMode: (sessionId: string, env: NodeJS.ProcessEnv) => unknown,
 *   setMode: (sessionId: string, mode: "hud" | "copy", env: NodeJS.ProcessEnv) => unknown,
 *   validate?: typeof validateRunDirectory,
 *   readMeta?: typeof readRunMeta,
 *   writeControl?: typeof writeControlAtomic,
 * }} options
 */
export function handleHudClick({
  runDirectory,
  sessionId,
  mouseX,
  mouseY,
  paneWidth,
  env = process.env,
  now = Date.now(),
  readMode,
  setMode,
  validate = validateRunDirectory,
  readMeta = readRunMeta,
  writeControl = writeControlAtomic,
}) {
  if (!sessionId || !validate(runDirectory, env)) {
    return 2;
  }

  const coordinates = [mouseX, mouseY, paneWidth].map(integerValue);
  if (coordinates.some((value) => value === null)) {
    return 2;
  }
  const [column, row, width] =
    /** @type {number[]} */ (coordinates);
  if (width <= 0 || column < 0 || column >= width || row < 0) {
    return 2;
  }

  const meta = readMeta(runDirectory);
  if (
    meta?.selectionControls === true &&
    meta?.ownsTmuxServer === true
  ) {
    const observedMode = readMode(sessionId, env);
    const currentMode = isInteractionMode(observedMode)
      ? observedMode
      : DEFAULT_INTERACTION_MODE;
    const requestedMode = hitTestModeButton({
      column,
      mode: currentMode,
      row,
      width,
    });

    if (requestedMode) {
      if (requestedMode === currentMode) {
        return 0;
      }
      try {
        setMode(sessionId, requestedMode, env);
      } catch {
        return 2;
      }
      if (
        writeControl(
          runDirectory,
          {
            kind: "interaction.mode.set",
            mode: requestedMode,
            observedAtMs: now,
            version: 1,
          },
          env,
        )
      ) {
        return 0;
      }
      try {
        setMode(sessionId, currentMode, env);
      } catch {
        // The caller reports failure; cleanup of the isolated server remains
        // the final recovery boundary if a rollback also fails.
      }
      return 2;
    }
  }

  return writeControl(
    runDirectory,
    {
      kind: "todo.toggle",
      observedAtMs: now,
      version: 1,
    },
    env,
  )
    ? 0
    : 2;
}

/** @param {string | number} value */
function integerValue(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) ? number : null;
}
