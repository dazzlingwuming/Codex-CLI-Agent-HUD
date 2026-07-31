import path from "node:path";

const ANSI_ESCAPE =
  // eslint-disable-next-line no-control-regex
  /\u001B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/gu;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const SENSITIVE_ASSIGNMENT =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|AUTH|COOKIE|PRIVATE_KEY)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/giu;
const SENSITIVE_FLAG =
  /(--?(?:api[-_]?key|token|password|passwd|secret|authorization|cookie|private[-_]?key))(?:=|\s+)("[^"]*"|'[^']*'|[^\s]+)/giu;

/**
 * @param {unknown} value
 * @param {number} maxCharacters
 */
export function sanitizeOneLine(value, maxCharacters = 160) {
  const text = String(value ?? "")
    .replace(ANSI_ESCAPE, "")
    .replace(CONTROL_CHARACTER, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return truncateCharacters(text, maxCharacters);
}

/**
 * @param {unknown} value
 * @param {number} maxCharacters
 */
export function firstMeaningfulLine(value, maxCharacters = 160) {
  const line = String(value ?? "")
    .split(/\r?\n/u)
    .map((candidate) => sanitizeOneLine(candidate, maxCharacters))
    .find(Boolean);

  return line ?? "";
}

/**
 * @param {string} value
 * @param {number} maxCharacters
 */
export function truncateCharacters(value, maxCharacters) {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) {
    return value;
  }
  if (maxCharacters <= 1) {
    return "…".slice(0, maxCharacters);
  }
  return `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

/**
 * Best-effort display redaction. The original command is never written to HUD
 * state; only this bounded summary is retained.
 *
 * @param {unknown} value
 * @param {number} maxCharacters
 */
export function redactCommand(value, maxCharacters = 160) {
  return truncateCharacters(
    sanitizeOneLine(value, 2_000)
      .replace(SENSITIVE_ASSIGNMENT, "$1=<redacted>")
      .replace(SENSITIVE_FLAG, "$1=<redacted>")
      .replace(/\bBearer\s+[^\s]+/giu, "Bearer <redacted>")
      .replace(
        /([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+):[^@\s]+@/giu,
        "$1:<redacted>@",
      ),
    maxCharacters,
  );
}

/**
 * @param {unknown} value
 * @param {string} cwd
 */
export function displayPath(value, cwd) {
  const candidate = sanitizeOneLine(value, 500);
  if (!candidate) {
    return "";
  }

  const absolute = path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(cwd, candidate);
  const relative = path.relative(cwd, absolute);

  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  ) {
    return relative || ".";
  }

  return `…/${path.basename(absolute)}`;
}

/**
 * @param {unknown} command
 * @param {string} cwd
 */
export function extractPatchPaths(command, cwd) {
  /** @type {string[]} */
  const paths = [];
  const pattern = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu;
  const text = String(command ?? "");
  let match;

  while ((match = pattern.exec(text)) !== null && paths.length < 2) {
    const candidate = displayPath(match[1], cwd);
    if (candidate && !paths.includes(candidate)) {
      paths.push(candidate);
    }
  }

  return paths;
}
