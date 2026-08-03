import {
  hitTestCopyAction,
} from "./copy-action.mjs";
import {
  readRunMeta,
  validateRunDirectory,
  writeControlAtomic,
} from "./run-directory.mjs";

/**
 * Route one tmux HUD click to an explicit copy action or the existing Todo
 * control. tmux's mouse_x and mouse_y formats are already zero-based
 * coordinates relative to the mouse pane.
 *
 * @param {{
 *   runDirectory: string,
 *   codexPane: string,
 *   mouseX: string | number,
 *   mouseY: string | number,
 *   paneWidth: string | number,
 *   env?: NodeJS.ProcessEnv,
 *   now?: number,
 *   copySelection?: (codexPane: string, env: NodeJS.ProcessEnv) => boolean,
 *   validate?: typeof validateRunDirectory,
 *   readMeta?: typeof readRunMeta,
 *   writeControl?: typeof writeControlAtomic,
 * }} options
 */
export function handleHudClick({
  runDirectory,
  codexPane,
  mouseX,
  mouseY,
  paneWidth,
  env = process.env,
  now = Date.now(),
  copySelection,
  validate = validateRunDirectory,
  readMeta = readRunMeta,
  writeControl = writeControlAtomic,
}) {
  if (
    typeof codexPane !== "string" ||
    codexPane.length === 0 ||
    !validate(runDirectory, env)
  ) {
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
    meta?.copyActionControls === true &&
    meta?.ownsTmuxServer === true
  ) {
    const requestedCopy = hitTestCopyAction({
      column,
      row,
      width,
    });

    if (requestedCopy) {
      if (typeof copySelection !== "function") {
        return 2;
      }
      try {
        return copySelection(codexPane, env) === true ? 0 : 2;
      } catch {
        return 2;
      }
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
