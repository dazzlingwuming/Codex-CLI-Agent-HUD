import assert from "node:assert/strict";
import test from "node:test";

import {
  findSubcommand,
  shouldUseHudForCodex,
} from "../src/codex-routing.mjs";

const interactiveTty = {
  stdinIsTTY: true,
  stdoutIsTTY: true,
};

test("direct interactive Codex invocations use the HUD", () => {
  assert.equal(shouldUseHudForCodex([], interactiveTty), true);
  assert.equal(
    shouldUseHudForCodex(["explain this repository"], interactiveTty),
    true,
  );
  assert.equal(
    shouldUseHudForCodex(["resume", "--last"], interactiveTty),
    true,
  );
  assert.equal(
    shouldUseHudForCodex(["-m", "gpt-test", "fork"], interactiveTty),
    true,
  );
});

test("noninteractive and informational Codex commands bypass the HUD", () => {
  for (const args of [
    ["exec", "echo ready"],
    ["e", "echo ready"],
    ["a"],
    ["review", "--uncommitted"],
    ["sandbox", "macos", "echo ready"],
    ["doctor"],
    ["--help"],
    ["--version"],
    ["-c", "model_reasoning_effort=high", "exec", "echo ready"],
    ["--enable", "hooks", "--disable", "apps", "exec", "echo ready"],
  ]) {
    assert.equal(
      shouldUseHudForCodex(args, interactiveTty),
      false,
      args.join(" "),
    );
  }
});

test("piped Codex invocations bypass the interactive HUD", () => {
  assert.equal(
    shouldUseHudForCodex([], {
      stdinIsTTY: false,
      stdoutIsTTY: true,
    }),
    false,
  );
  assert.equal(
    shouldUseHudForCodex([], {
      stdinIsTTY: true,
      stdoutIsTTY: false,
    }),
    false,
  );
});

test("subcommand discovery skips global option values", () => {
  assert.equal(
    findSubcommand([
      "-c",
      "key=value",
      "--enable",
      "hooks",
      "-C",
      "/tmp",
      "exec",
    ]),
    "exec",
  );
  assert.equal(findSubcommand(["-m", "gpt-test", "resume"]), "resume");
  assert.equal(findSubcommand(["a prompt beginning with text"]), null);
});
