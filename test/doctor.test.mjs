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

test("doctor marks persistent tmux selection and explicit copy as manual GUI verification", () => {
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
  const appleTerminal = apple.find((check) => check.name === "terminal");
  assert.equal(appleTerminal?.status, "warn");
  assert.match(appleTerminal?.detail || "", /manual GUI verification required/u);
  assert.match(appleTerminal?.detail || "", /persistent tmux selection/u);
  assert.match(appleTerminal?.detail || "", /explicit copy action/u);
  assert.match(appleTerminal?.recovery || "", /\[复制所选\]/u);
  assert.match(appleTerminal?.recovery || "", /Enter/u);
  assert.doesNotMatch(appleTerminal?.detail || "", /PyCharm-only/u);

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
  const vscodeTerminal = vscode.find((check) => check.name === "terminal");
  assert.equal(vscodeTerminal?.status, "warn");
  assert.match(vscodeTerminal?.detail || "", /manual GUI verification required/u);
  assert.match(vscodeTerminal?.detail || "", /persistent tmux selection/u);
  assert.match(vscodeTerminal?.detail || "", /explicit copy action/u);
  assert.match(vscodeTerminal?.recovery || "", /\[复制所选\]/u);
  assert.match(vscodeTerminal?.recovery || "", /Enter/u);

  const unknown = collectDoctorChecks({
    env: {
      ...process.env,
      __CFBundleIdentifier: "",
      TERMINAL_EMULATOR: "",
      TERM_PROGRAM: "not-a-known-terminal",
      TERM: "dumb",
    },
    stdin,
    stdout,
  });
  const unknownTerminal = unknown.find((check) => check.name === "terminal");
  assert.equal(unknownTerminal?.status, "warn");
  assert.match(unknownTerminal?.detail || "", /manual GUI verification required/u);
  assert.match(unknownTerminal?.detail || "", /persistent tmux selection/u);
  assert.match(unknownTerminal?.detail || "", /explicit copy action/u);
  assert.match(
    unknownTerminal?.recovery || "",
    /persistent selection and explicit copy/u,
  );

  const jetbrains = collectDoctorChecks({
    env: {
      ...process.env,
      __CFBundleIdentifier: "",
      TERMINAL_EMULATOR: "JetBrains-JediTerm",
      TERM_PROGRAM: "",
    },
    stdin,
    stdout,
  });
  const terminal = jetbrains.find((check) => check.name === "terminal");
  assert.equal(terminal?.status, "warn");
  assert.match(terminal?.detail || "", /2025\.3\.2/u);
  assert.match(terminal?.detail || "", /manual GUI verification required/u);
  assert.match(terminal?.detail || "", /persistent tmux selection/u);
  assert.match(terminal?.detail || "", /explicit copy action/u);
  assert.match(terminal?.recovery || "", /Mouse reporting on/u);
  assert.match(terminal?.recovery || "", /Copy to clipboard on selection off/u);
  assert.match(terminal?.recovery || "", /\[复制所选\]/u);
  assert.match(terminal?.recovery || "", /Enter/u);
  assert.match(terminal?.recovery || "", /tmux highlight/u);
  assert.match(terminal?.recovery || "", /cannot read or change IDE settings/u);
  assert.doesNotMatch(terminal?.detail || "", /copy mode/u);
  assert.doesNotMatch(terminal?.recovery || "", /copy mode/u);
  assert.match(formatDoctorText(jetbrains), /manual GUI verification required/u);
});
