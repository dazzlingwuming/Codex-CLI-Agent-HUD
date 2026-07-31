import assert from "node:assert/strict";
import test from "node:test";

import {
  displayPath,
  extractPatchPaths,
  firstMeaningfulLine,
  redactCommand,
} from "../src/sanitize.mjs";

test("command summaries redact common credential forms", () => {
  const command =
    "API_TOKEN=abc curl --password hunter2 -H 'Authorization: Bearer secret' https://user:pass@example.com";
  const redacted = redactCommand(command);

  assert.doesNotMatch(redacted, /abc|hunter2|Bearer secret|user:pass/u);
  assert.match(redacted, /API_TOKEN=<redacted>/u);
  assert.match(redacted, /--password=<redacted>/u);
  assert.match(redacted, /Bearer <redacted>/u);
});

test("task summaries use only the first meaningful line", () => {
  assert.equal(
    firstMeaningfulLine("\n  实现用户登录功能\n不要修改部署配置"),
    "实现用户登录功能",
  );
});

test("paths inside cwd remain relative and outside paths hide parents", () => {
  assert.equal(displayPath("/workspace/src/app.mjs", "/workspace"), "src/app.mjs");
  assert.equal(displayPath("/Users/alex/private.txt", "/workspace"), "…/private.txt");
});

test("patch summaries extract at most two changed paths", () => {
  const patch = `*** Begin Patch
*** Update File: src/a.mjs
*** Add File: src/b.mjs
*** Delete File: src/c.mjs
*** End Patch`;

  assert.deepEqual(extractPatchPaths(patch, "/workspace"), [
    "src/a.mjs",
    "src/b.mjs",
  ]);
});
