import assert from "node:assert/strict";
import test from "node:test";

import { VERSION, helpText, runCli } from "../src/cli.mjs";

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
