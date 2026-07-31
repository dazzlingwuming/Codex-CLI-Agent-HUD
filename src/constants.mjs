export const APP_ID = "codex-hud";
export const APP_NAME = "Codex HUD";
export const EVENT_VERSION = 1;
export const RUN_DIRECTORY_ENV = "CODEX_HUD_RUN_DIR";
export const STATE_ROOT_ENV = "CODEX_HUD_STATE_ROOT";
export const DEBUG_ENV = "CODEX_HUD_DEBUG";
export const HOOK_MARKER = "CODEX_HUD_HOOK_V1";
export const RUN_DIRECTORY_MAGIC = "codex-hud-run-v1";

export const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "PreCompact",
  "PostCompact",
  "Stop",
];

export const NATIVE_STATUS_LINE = [
  "model-with-reasoning",
  "context-remaining",
  "current-dir",
  "git-branch",
  "run-state",
];
