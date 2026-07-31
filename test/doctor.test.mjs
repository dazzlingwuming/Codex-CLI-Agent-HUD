import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectDoctorChecks,
  doctorExitCode,
  formatDoctorText,
} from "../src/doctor.mjs";
import { setupHooks } from "../src/hooks-config.mjs";
import { setupShellIntegration } from "../src/shell-integration.mjs";

test("doctor distinguishes missing and installed HUD hooks", (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hud-doctor-"));
  const configHome = path.join(home, ".codex");
  context.after(() => fs.rmSync(home, { recursive: true }));
  const env = {
    ...process.env,
    CODEX_HOME: configHome,
    HOME: home,
    TERM_PROGRAM: "Apple_Terminal",
  };

  const before = collectDoctorChecks({ env });
  assert.equal(before.find((check) => check.name === "hooks")?.status, "fail");
  assert.equal(before.find((check) => check.name === "shell")?.status, "fail");
  assert.equal(doctorExitCode(before), 2);

  setupHooks({ configHome, entryPath: "/tmp/cli.mjs" });
  setupShellIntegration({ rcPath: path.join(home, ".zshrc") });
  const after = collectDoctorChecks({ env });
  assert.equal(after.find((check) => check.name === "hooks")?.status, "ok");
  assert.equal(after.find((check) => check.name === "shell")?.status, "ok");
  assert.match(formatDoctorText(after), /Codex HUD Doctor/u);
});

test("doctor recognizes common terminal families and flags old JetBrains risk", () => {
  const stdin = /** @type {NodeJS.ReadStream} */ (
    /** @type {unknown} */ ({ isTTY: true })
  );
  const stdout = /** @type {NodeJS.WriteStream} */ (
    /** @type {unknown} */ ({ isTTY: true })
  );
  const apple = collectDoctorChecks({
    env: {
      ...process.env,
      __CFBundleIdentifier: "",
      TERMINAL_EMULATOR: "",
      TERM_PROGRAM: "Apple_Terminal",
    },
    stdin,
    stdout,
  });
  assert.equal(apple.find((check) => check.name === "terminal")?.status, "ok");

  const vscode = collectDoctorChecks({
    env: {
      ...process.env,
      __CFBundleIdentifier: "",
      TERMINAL_EMULATOR: "",
      TERM_PROGRAM: "vscode",
    },
    stdin,
    stdout,
  });
  assert.equal(vscode.find((check) => check.name === "terminal")?.status, "ok");

  const jetbrains = collectDoctorChecks({
    env: {
      ...process.env,
      TERMINAL_EMULATOR: "JetBrains-JediTerm",
      TERM_PROGRAM: "",
    },
    stdin,
    stdout,
  });
  const terminal = jetbrains.find((check) => check.name === "terminal");
  assert.equal(terminal?.status, "warn");
  assert.match(terminal?.detail || "", /2025\.3\.2/u);
});
