import assert from "node:assert/strict";
import test from "node:test";
import stringWidth from "string-width";

import {
  COPY_ACTION_LABEL,
  copyActionLayout,
  hitTestCopyAction,
  supportsCopyActionControls,
} from "../src/copy-action.mjs";

test("copy action controls require a HUD-owned tmux server", () => {
  assert.equal(supportsCopyActionControls({ ownsTmuxServer: true }), true);
  assert.equal(supportsCopyActionControls({ ownsTmuxServer: false }), false);
});

test("copy action is CJK-safe and right aligned", () => {
  const layout = copyActionLayout(80);
  assert.ok(layout);
  assert.equal(layout.endColumn, 80);
  assert.equal(layout.startColumn + stringWidth(layout.text), 80);
  assert.equal(layout.text, `[${COPY_ACTION_LABEL}]`);
  assert.deepEqual(layout.rectangle, {
    endColumn: 80,
    endRow: 2,
    startColumn: layout.startColumn,
    startRow: 0,
  });
});

test("copy action hit test shares the displayed rectangle and tolerates one row drift", () => {
  const layout = copyActionLayout(80);
  assert.ok(layout);
  const { rectangle } = layout;

  assert.equal(
    hitTestCopyAction({
      column: rectangle.startColumn,
      row: rectangle.startRow,
      width: 80,
    }),
    true,
  );
  assert.equal(
    hitTestCopyAction({
      column: rectangle.endColumn - 1,
      row: rectangle.endRow - 1,
      width: 80,
    }),
    true,
  );
  assert.equal(
    hitTestCopyAction({
      column: rectangle.endColumn,
      row: rectangle.startRow,
      width: 80,
    }),
    false,
  );
  assert.equal(
    hitTestCopyAction({
      column: rectangle.startColumn - 1,
      row: rectangle.startRow,
      width: 80,
    }),
    false,
  );
  assert.equal(
    hitTestCopyAction({
      column: rectangle.startColumn,
      row: rectangle.endRow,
      width: 80,
    }),
    false,
  );
});

test("copy action is withheld below the supported terminal width", () => {
  assert.equal(copyActionLayout(49), null);
  assert.equal(
    hitTestCopyAction({ column: 40, row: 0, width: 49 }),
    false,
  );
});
