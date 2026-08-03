import stringWidth from "string-width";

export const COPY_ACTION_MIN_WIDTH = 50;
export const COPY_ACTION_LABEL = "复制所选";

/**
 * The renderer shows the action in the first header line. JetBrains can
 * report a click one row lower while synchronizing a frame, so the hit area
 * deliberately includes the first two non-Todo HUD rows. Coordinates are
 * half-open and pane-relative.
 */
const COPY_ACTION_RECTANGLE_ROWS = Object.freeze({
  endRow: 2,
  startRow: 0,
});

/**
 * The copy action is safe only when this HUD owns the isolated tmux server:
 * it never changes a user's existing tmux key tables or clipboard policy.
 *
 * @param {{ownsTmuxServer: boolean}} options
 */
export function supportsCopyActionControls({ ownsTmuxServer }) {
  return ownsTmuxServer === true;
}

/**
 * Build the single visible action and the exact rectangle used for hit
 * testing. The CJK-width-aware text is right aligned inside the HUD header.
 *
 * @param {number} width
 */
export function copyActionLayout(width) {
  if (!Number.isInteger(width) || width < COPY_ACTION_MIN_WIDTH) {
    return null;
  }

  const text = `[${COPY_ACTION_LABEL}]`;
  const actionWidth = stringWidth(text);
  if (actionWidth > width) {
    return null;
  }

  const startColumn = width - actionWidth;
  return {
    endColumn: width,
    rectangle: {
      ...COPY_ACTION_RECTANGLE_ROWS,
      endColumn: width,
      startColumn,
    },
    startColumn,
    text,
  };
}

/**
 * @param {{column: number, row: number, width: number}} options
 */
export function hitTestCopyAction({ column, row, width }) {
  if (!Number.isInteger(column) || !Number.isInteger(row)) {
    return false;
  }
  const layout = copyActionLayout(width);
  if (!layout) {
    return false;
  }
  const rectangle = layout.rectangle;
  return (
    column >= rectangle.startColumn &&
    column < rectangle.endColumn &&
    row >= rectangle.startRow &&
    row < rectangle.endRow
  );
}
