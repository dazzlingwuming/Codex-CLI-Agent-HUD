import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  hasShellIntegration,
  setupShellIntegration,
  uninstallShellIntegration,
} from "../src/shell-integration.mjs";

test("shell setup is idempotent and uninstall restores an absent zshrc", (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-hud-shell-"),
  );
  const rcPath = path.join(directory, ".zshrc");
  context.after(() => fs.rmSync(directory, { recursive: true }));

  const installed = setupShellIntegration({ rcPath });
  assert.equal(installed.changed, true);
  assert.equal(installed.backupPath, null);
  assert.equal(hasShellIntegration(fs.readFileSync(rcPath, "utf8")), true);
  assert.equal(fs.statSync(rcPath).mode & 0o777, 0o644);

  const repeated = setupShellIntegration({ rcPath });
  assert.equal(repeated.changed, false);

  const removed = uninstallShellIntegration({ rcPath });
  assert.equal(removed.changed, true);
  assert.equal(fs.readFileSync(rcPath, "utf8"), "");
});

test("shell uninstall restores existing content and writes private backups", (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-hud-shell-existing-"),
  );
  const rcPath = path.join(directory, ".zshrc");
  const original = "export PATH=\"$HOME/.local/bin:$PATH\"\n";
  context.after(() => fs.rmSync(directory, { recursive: true }));
  fs.writeFileSync(rcPath, original, { mode: 0o640 });

  const installed = setupShellIntegration({
    now: new Date("2026-07-31T00:00:00.000Z"),
    rcPath,
  });
  assert.ok(installed.backupPath);
  assert.equal(fs.statSync(installed.backupPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(rcPath).mode & 0o777, 0o640);

  uninstallShellIntegration({
    now: new Date("2026-07-31T00:00:01.000Z"),
    rcPath,
  });
  assert.equal(fs.readFileSync(rcPath, "utf8"), original);
});

test("shell setup refuses conflicting or incomplete codex definitions", (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-hud-shell-conflict-"),
  );
  context.after(() => fs.rmSync(directory, { recursive: true }));

  for (const [name, original] of [
    ["alias", "alias codex='codex --profile work'\n"],
    ["function", "codex() { command codex \"$@\"; }\n"],
    ["marker", "# >>> Codex HUD interactive entry >>>\n"],
  ]) {
    const rcPath = path.join(directory, `.zshrc-${name}`);
    fs.writeFileSync(rcPath, original);
    assert.throws(() => setupShellIntegration({ rcPath }), /no changes/u);
    assert.equal(fs.readFileSync(rcPath, "utf8"), original);
  }
});
