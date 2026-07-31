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

test("doctor distinguishes missing and installed HUD hooks", (context) => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hud-doctor-"));
  context.after(() => fs.rmSync(configHome, { recursive: true }));
  const env = {
    ...process.env,
    CODEX_HOME: configHome,
    TERM_PROGRAM: "Apple_Terminal",
  };

  const before = collectDoctorChecks({ env });
  assert.equal(before.find((check) => check.name === "hooks")?.status, "fail");
  assert.equal(doctorExitCode(before), 2);

  setupHooks({ configHome, entryPath: "/tmp/cli.mjs" });
  const after = collectDoctorChecks({ env });
  assert.equal(after.find((check) => check.name === "hooks")?.status, "ok");
  assert.match(formatDoctorText(after), /Codex HUD Doctor/u);
});
