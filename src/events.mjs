import { randomUUID } from "node:crypto";

import { EVENT_VERSION } from "./constants.mjs";
import {
  displayPath,
  extractPatchPaths,
  firstMeaningfulLine,
  redactCommand,
  sanitizeOneLine,
} from "./sanitize.mjs";

const TEST_COMMAND =
  /(?:^|[;&|]\s*|\s)(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|(?:^|\s)(?:pytest|vitest|jest|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test|ruff|eslint|mypy|tsc)\b/iu;
const REVIEW_COMMAND = /(?:^|\s)git\s+(?:diff|status)\b/iu;
const SEARCH_COMMAND =
  /(?:^|[;&|]\s*|\s)(?:rg|grep|find|ls|cat|head|tail)\b|(?:^|\s)sed\s+-n\b|(?:^|\s)git\s+(?:log|show)\b/iu;

/**
 * @typedef {"pending" | "inProgress" | "completed"} PlanStatus
 * @typedef {{step: string, status: PlanStatus}} PlanItem
 * @typedef {"planning" | "searching" | "coding" | "testing" | "review" | "working"} ActionCategory
 * @typedef {{label: string, detail: string, category: ActionCategory}} ToolAction
 * @typedef {{
 *   version: number,
 *   id: string,
 *   observedAtMs: number,
 *   kind: string,
 *   sessionId: string,
 *   turnId: string | null,
 *   data: Record<string, any>
 * }} HudEvent
 */

/**
 * @param {unknown} input
 * @returns {PlanItem[]}
 */
export function normalizePlan(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const raw = /** @type {Record<string, unknown>} */ (item);
      const step = firstMeaningfulLine(raw.step, 180);
      const status = normalizePlanStatus(raw.status);
      return step && status ? { step, status } : null;
    })
    .filter((item) => item !== null);
}

/**
 * @param {unknown} value
 * @returns {PlanStatus | null}
 */
export function normalizePlanStatus(value) {
  switch (value) {
    case "pending":
      return "pending";
    case "in_progress":
    case "inProgress":
      return "inProgress";
    case "completed":
      return "completed";
    default:
      return null;
  }
}

/**
 * @param {string} toolName
 * @param {unknown} input
 * @param {string} cwd
 * @returns {ToolAction}
 */
export function describeTool(toolName, input, cwd) {
  const canonicalName = sanitizeOneLine(toolName, 120) || "unknown";
  const lowerName = canonicalName.toLowerCase();
  const fields =
    input && typeof input === "object"
      ? /** @type {Record<string, unknown>} */ (input)
      : {};

  if (canonicalName === "update_plan") {
    return {
      label: "Updating plan",
      detail: "",
      category: "planning",
    };
  }

  if (canonicalName === "Bash") {
    const command = Array.isArray(fields.command)
      ? fields.command.join(" ")
      : fields.command;
    const detail = redactCommand(command) || "command";
    const category = TEST_COMMAND.test(detail)
      ? "testing"
      : REVIEW_COMMAND.test(detail)
        ? "review"
        : SEARCH_COMMAND.test(detail)
          ? "searching"
          : "working";
    return { label: "Running", detail, category };
  }

  if (
    lowerName === "apply_patch" ||
    lowerName === "edit" ||
    lowerName === "write" ||
    lowerName.includes("filechange")
  ) {
    const paths = extractPatchPaths(fields.command, cwd);
    const fallback = firstKnownField(fields, ["path", "file_path", "filePath"]);
    const detail =
      paths.join(", ") || displayPath(fallback, cwd) || "workspace files";
    return { label: "Editing", detail, category: "coding" };
  }

  if (
    lowerName.includes("test") ||
    lowerName.includes("lint") ||
    lowerName.includes("typecheck")
  ) {
    return {
      label: "Testing",
      detail: toolDetail(fields, cwd) || canonicalName,
      category: "testing",
    };
  }

  if (
    lowerName.includes("read") ||
    lowerName.includes("view") ||
    lowerName.includes("list")
  ) {
    return {
      label: "Reading",
      detail: toolDetail(fields, cwd) || canonicalName,
      category: "searching",
    };
  }

  if (
    lowerName.includes("search") ||
    lowerName.includes("find") ||
    lowerName.includes("grep")
  ) {
    return {
      label: "Searching",
      detail: toolDetail(fields, cwd) || canonicalName,
      category: "searching",
    };
  }

  return {
    label: "Using",
    detail: canonicalName,
    category: "working",
  };
}

/**
 * @param {Record<string, unknown>} fields
 * @param {string} cwd
 */
function toolDetail(fields, cwd) {
  const pathValue = firstKnownField(fields, [
    "path",
    "file_path",
    "filePath",
    "ref_id",
  ]);
  if (pathValue) {
    return displayPath(pathValue, cwd);
  }

  return sanitizeOneLine(
    firstKnownField(fields, ["query", "pattern", "q"]),
    140,
  );
}

/**
 * @param {Record<string, unknown>} fields
 * @param {string[]} keys
 */
function firstKnownField(fields, keys) {
  for (const key of keys) {
    if (typeof fields[key] === "string") {
      return fields[key];
    }
  }
  return "";
}

/**
 * @param {unknown} input
 * @param {{now?: () => number, id?: () => string}} options
 * @returns {HudEvent | null}
 */
export function normalizeHookInput(
  input,
  { now = Date.now, id = randomUUID } = {},
) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const raw = /** @type {Record<string, any>} */ (input);
  const hookName = sanitizeOneLine(
    raw.hook_event_name ?? raw.hookEventName,
    80,
  );
  const sessionId = sanitizeOneLine(raw.session_id, 160);
  if (!hookName || !sessionId) {
    return null;
  }

  const observedAtMs = now();
  const turnId = sanitizeOneLine(raw.turn_id, 160) || null;
  const cwd = sanitizeOneLine(raw.cwd, 1_000);
  const common = {
    version: EVENT_VERSION,
    id: id(),
    observedAtMs,
    sessionId,
    turnId,
  };

  switch (hookName) {
    case "SessionStart":
      return event(common, "session.start", {
        cwd,
        model: sanitizeOneLine(raw.model, 120),
        source: sanitizeOneLine(raw.source, 40),
      });
    case "SessionEnd":
      return event(common, "session.end", {
        reason: sanitizeOneLine(raw.reason, 80),
      });
    case "UserPromptSubmit":
      return event(common, "turn.prompt", {
        task: firstMeaningfulLine(raw.prompt, 160),
      });
    case "PreToolUse":
      return toolEvent(common, "tool.start", raw, cwd);
    case "PostToolUse":
      return toolEvent(common, "tool.finish", raw, cwd);
    case "PermissionRequest": {
      const action = describeTool(raw.tool_name, raw.tool_input, cwd);
      return event(common, "approval.wait", {
        action,
        toolName: sanitizeOneLine(raw.tool_name, 120),
      });
    }
    case "PreCompact":
      return event(common, "compact.start", {
        trigger: sanitizeOneLine(raw.trigger, 40),
      });
    case "PostCompact":
      return event(common, "compact.finish", {
        trigger: sanitizeOneLine(raw.trigger, 40),
      });
    case "Stop":
      return event(common, "turn.stop", {});
    default:
      return null;
  }
}

/**
 * @param {Omit<HudEvent, "kind" | "data">} common
 * @param {string} kind
 * @param {Record<string, any>} data
 * @returns {HudEvent}
 */
function event(common, kind, data) {
  return { ...common, kind, data };
}

/**
 * @param {Omit<HudEvent, "kind" | "data">} common
 * @param {string} kind
 * @param {Record<string, any>} raw
 * @param {string} cwd
 */
function toolEvent(common, kind, raw, cwd) {
  const toolName = sanitizeOneLine(raw.tool_name, 120);
  const toolUseId = sanitizeOneLine(raw.tool_use_id, 160);
  if (!toolName || !toolUseId) {
    return null;
  }

  const toolInput =
    raw.tool_input && typeof raw.tool_input === "object"
      ? raw.tool_input
      : {};
  const action = describeTool(toolName, toolInput, cwd);
  const planCandidate =
    toolName === "update_plan" ? normalizePlan(toolInput.plan) : null;

  return event(common, kind, {
    action,
    planCandidate,
    toolName,
    toolUseId,
  });
}
