import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  VERSION,
  forwardedArguments,
  helpText,
  runCli,
} from "../src/cli.mjs";

function memoryIo() {
  const output = { stdout: "", stderr: "" };
  return {
    output,
    io: {
      stdout: {
        /** @param {string} value */
        write(value) {
          output.stdout += value;
          return true;
        },
      },
      stderr: {
        /** @param {string} value */
        write(value) {
          output.stderr += value;
          return true;
        },
      },
    },
  };
}

test("help documents the stable command surface", async () => {
  const { io, output } = memoryIo();
  const exitCode = await runCli(["--help"], io);

  assert.equal(exitCode, 0);
  assert.match(output.stdout, /codex-hud setup/);
  assert.match(output.stdout, /codex-hud doctor/);
  assert.equal(output.stderr, "");
});

test("version output matches the package version", async () => {
  const { io, output } = memoryIo();
  const exitCode = await runCli(["--version"], io);

  assert.equal(exitCode, 0);
  assert.equal(output.stdout, `${VERSION}\n`);
  assert.match(helpText(), new RegExp(VERSION.replaceAll(".", "\\.")));
});

test("the public delimiter is removed before forwarding Codex arguments", () => {
  assert.deepEqual(forwardedArguments(["--", "-m", "gpt-test"]), [
    "-m",
    "gpt-test",
  ]);
  assert.deepEqual(forwardedArguments(["-m", "gpt-test"]), [
    "-m",
    "gpt-test",
  ]);
});

test("CLI executes when launched through an npm-style symlink", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hud-bin-"));
  context.after(() => fs.rmSync(directory, { recursive: true }));
  const source = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const link = path.join(directory, "codex-hud");
  fs.symlinkSync(source, link);

  const result = spawnSync(link, ["--version"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${VERSION}\n`);
});
