import assert from "node:assert/strict";
import test from "node:test";
import stringWidth from "string-width";

import {
  DEFAULT_INTERACTION_MODE,
  hitTestModeButton,
  isInteractionModeControl,
  isJetBrainsTerminal,
  modeButtonLayout,
  supportsSelectionControls,
} from "../src/interaction-mode.mjs";

test("interaction mode defaults to HUD", () => {
  assert.equal(DEFAULT_INTERACTION_MODE, "hud");
});

test("JetBrains detection accepts known terminal identities", () => {
  assert.equal(
    isJetBrainsTerminal({ TERMINAL_EMULATOR: "JetBrains-JediTerm" }),
    true,
  );
  assert.equal(isJetBrainsTerminal({ TERM_PROGRAM: "Apple_Terminal" }), false);
});

test("selection controls require JetBrains and an owned tmux server", () => {
  const env = { TERMINAL_EMULATOR: "JetBrains-JediTerm" };
  assert.equal(supportsSelectionControls({ env, ownsTmuxServer: true }), true);
  assert.equal(supportsSelectionControls({ env, ownsTmuxServer: false }), false);
  assert.equal(
    supportsSelectionControls({
      env: { TERM_PROGRAM: "vscode" },
      ownsTmuxServer: true,
    }),
    false,
  );
});

test("mode buttons are CJK-safe and right aligned", () => {
  const layout = modeButtonLayout(80, "hud");
  assert.ok(layout);
  assert.equal(layout.endColumn, 80);
  assert.equal(layout.startColumn + stringWidth(layout.text), 80);
  assert.match(layout.text, /○ 复制模式/u);
  assert.match(layout.text, /● HUD 模式/u);
});

test("mode hit testing uses the same half-open rectangles as rendering", () => {
  const layout = modeButtonLayout(80, "hud");
  assert.ok(layout);
  const [copy, hud] = layout.buttons;

  assert.equal(
    hitTestModeButton({
      column: copy.startColumn,
      mode: "hud",
      row: 0,
      width: 80,
    }),
    "copy",
  );
  assert.equal(
    hitTestModeButton({
      column: copy.endColumn,
      mode: "hud",
      row: 0,
      width: 80,
    }),
    null,
  );
  assert.equal(
    hitTestModeButton({
      column: hud.endColumn - 1,
      mode: "hud",
      row: 0,
      width: 80,
    }),
    "hud",
  );
  assert.equal(
    hitTestModeButton({
      column: hud.startColumn,
      mode: "hud",
      row: 1,
      width: 80,
    }),
    null,
  );
});

test("mode buttons are withheld below the supported terminal width", () => {
  assert.equal(modeButtonLayout(49, "hud"), null);
});

test("interaction controls require an explicit valid mode", () => {
  assert.equal(
    isInteractionModeControl({
      kind: "interaction.mode.set",
      mode: "copy",
      observedAtMs: 1,
      version: 1,
    }),
    true,
  );
  assert.equal(
    isInteractionModeControl({
      kind: "interaction.mode.set",
      mode: "other",
      observedAtMs: 1,
      version: 1,
    }),
    false,
  );
  assert.equal(
    isInteractionModeControl({
      kind: "interaction.mode.toggle",
      mode: "copy",
      observedAtMs: 1,
      version: 1,
    }),
    false,
  );
});
