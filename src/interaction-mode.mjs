import stringWidth from "string-width";

export const DEFAULT_INTERACTION_MODE = "hud";
export const INTERACTION_MODES = Object.freeze(["hud", "copy"]);
export const MODE_BUTTON_MIN_WIDTH = 50;

/** @type {ReadonlyArray<{label: string, mode: "hud" | "copy"}>} */
const MODE_BUTTONS = Object.freeze([
  { label: "复制模式", mode: "copy" },
  { label: "HUD 模式", mode: "hud" },
]);

/**
 * @param {unknown} value
 * @returns {value is "hud" | "copy"}
 */
export function isInteractionMode(value) {
  return INTERACTION_MODES.includes(/** @type {"hud" | "copy"} */ (value));
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isJetBrainsTerminal(env = process.env) {
  const identity = [
    env.TERM_PROGRAM,
    env.TERMINAL_EMULATOR,
    env.__CFBundleIdentifier,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /jetbrains|jediterm|pycharm|intellij/u.test(identity);
}

/**
 * PyCharm selection controls are deliberately limited to HUD-owned tmux
 * servers because tmux key tables are server-global.
 *
 * @param {{env?: NodeJS.ProcessEnv, ownsTmuxServer: boolean}} options
 */
export function supportsSelectionControls({
  env = process.env,
  ownsTmuxServer,
}) {
  return ownsTmuxServer === true && isJetBrainsTerminal(env);
}

/**
 * @param {number} width
 * @param {"hud" | "copy"} mode
 */
export function modeButtonLayout(width, mode) {
  if (
    !Number.isInteger(width) ||
    width < MODE_BUTTON_MIN_WIDTH ||
    !isInteractionMode(mode)
  ) {
    return null;
  }

  const tokens = MODE_BUTTONS.map((button) => ({
    ...button,
    text: `[${button.mode === mode ? "●" : "○"} ${button.label}]`,
  }));
  const text = tokens.map((button) => button.text).join(" ");
  const textWidth = stringWidth(text);
  if (textWidth > width) {
    return null;
  }

  const startColumn = width - textWidth;
  let column = startColumn;
  const buttons = tokens.map((button, index) => {
    const buttonWidth = stringWidth(button.text);
    const rectangle = {
      endColumn: column + buttonWidth,
      mode: button.mode,
      startColumn: column,
    };
    column += buttonWidth + (index === tokens.length - 1 ? 0 : 1);
    return rectangle;
  });

  return {
    buttons,
    endColumn: width,
    startColumn,
    text,
  };
}

/**
 * Resolve a zero-based pane-relative mouse coordinate to an explicit mode.
 *
 * @param {{column: number, mode: "hud" | "copy", row: number, width: number}} options
 * @returns {"hud" | "copy" | null}
 */
export function hitTestModeButton({ column, mode, row, width }) {
  if (!Number.isInteger(column) || !Number.isInteger(row) || row !== 0) {
    return null;
  }
  const layout = modeButtonLayout(width, mode);
  if (!layout) {
    return null;
  }
  return (
    layout.buttons.find(
      (button) =>
        column >= button.startColumn && column < button.endColumn,
    )?.mode ?? null
  );
}

/**
 * @param {unknown} control
 * @returns {control is {version: 1, kind: "interaction.mode.set", mode: "hud" | "copy", observedAtMs: number}}
 */
export function isInteractionModeControl(control) {
  if (!control || typeof control !== "object") {
    return false;
  }
  const candidate = /** @type {Record<string, unknown>} */ (control);
  return (
    candidate.version === 1 &&
    candidate.kind === "interaction.mode.set" &&
    isInteractionMode(candidate.mode) &&
    typeof candidate.observedAtMs === "number" &&
    Number.isFinite(candidate.observedAtMs)
  );
}
