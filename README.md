# Codex CLI Agent HUD

Codex CLI Agent HUD 在同一个终端窗口底部持续展示当前任务、Todo、完成比例、当前工具和执行阶段。它通过 Codex 官方 Hooks 收集状态，通过 `tmux` 为 Codex 原始 TUI 和 HUD 分配独立区域，不修改 Codex 核心代码。

需求来源见 [`doc/初始.md`](doc/初始.md)，目标视觉参考见 [`参考图片/2026-07-31_11-21-37.png`](参考图片/2026-07-31_11-21-37.png)。

## 工作方式

```text
codex-hud
  └─ tmux
      ├─ 上方 pane：原始 Codex CLI
      │    └─ 原生状态行：模型 / Context / 目录 / Git / run-state
      └─ 下方 pane：Codex HUD
           └─ Task / Phase / Progress / Current / Todo

Codex Hooks → 脱敏事件 → 状态归约 → HUD Renderer
```

HUD 不解析 Codex 的屏幕输出，也不读取不稳定的 transcript。Todo 和进度只来自 Codex 的 `update_plan`，百分比按 `completed / total` 计算。

## 运行环境

- macOS / Apple Terminal（v0.1 已验证环境）
- Node.js 20 或更高版本
- Codex CLI 0.146.0 或兼容版本
- tmux

其他操作系统和终端在 v0.1 中均为 `not verified`。托管型 WebSearch 不经过本地 Tool Hooks，因此运行时只能显示 `Working`，无法显示具体 WebSearch 动作。

## 安装

在本仓库执行：

```bash
brew install tmux
npm install
npm run check
npm install -g --prefix "$HOME/.local" .
codex-hud setup
```

`$HOME/.local/bin` 需要位于 `PATH`。若选择其他 npm 全局 prefix，安装和卸载时应始终使用同一个 prefix。

`setup` 会：

1. 读取并验证 `~/.codex/hooks.json`。
2. 创建权限为 `0600` 的时间戳备份。
3. 保留所有既有 Hooks。
4. 幂等添加 Codex HUD lifecycle handlers。

首次安装或 Hook 命令发生变化后，启动 Codex，输入 `/hooks`，核对并信任包含 `CODEX_HUD_HOOK_V1=1` 的 handler，然后退出并重新启动 Codex，使新信任的 Hooks 在新会话中加载。项目不会使用 `--dangerously-bypass-hook-trust`。

## 使用

```text
codex-hud
codex-hud run -- [Codex 参数]
codex-hud doctor
codex-hud doctor --json
codex-hud setup
codex-hud uninstall
```

示例：

```bash
# 在当前目录启动
codex-hud

# 原样传递模型、目录或其他 Codex 参数
codex-hud run -- -m gpt-5.6-terra -C /path/to/project

# 检查依赖、终端、Hooks feature 和安装状态
codex-hud doctor
```

除非用户显式传入自己的 `tui.status_line`，包装器会为本次 Codex 会话注入：

```toml
[
  "model-with-reasoning",
  "context-remaining",
  "current-dir",
  "git-branch",
  "run-state"
]
```

这项覆盖只对当前包装会话有效，不修改全局 `config.toml`。

## HUD 状态含义

- `Task`：最新 `UserPromptSubmit` 的首个非空行。
- `Progress`：已完成 Todo 数量、总数和整数百分比；没有 plan 时显示 `—`。
- `Current`：当前本地工具、等待审批、压缩 Context、Thinking 或 Ready。
- `Todo`：最多显示 3 项，以 `inProgress` 项为中心。
- `~Planning`、`~Coding`、`~Testing` 等带 `~` 的阶段是根据结构化工具事件推导的，不是 Codex 官方阶段。
- `Completed` 只在非空 Todo 全部完成且收到 `Stop` 后显示。

终端至少需要 50 列、14 行。达到 80 列、22 行时使用 6 行完整 HUD，否则使用 3 行紧凑布局。窗口 resize 后 renderer 会自动重绘。

## 数据边界

HUD 只保留当前会话显示所需的脱敏摘要：

- 不保存工具返回值、文件内容、完整 transcript 或模型推理。
- 命令中的常见 token、password、secret、authorization 和 cookie 参数会被脱敏。
- 每次 Hook 写入一个权限为 `0600` 的原子事件文件，避免并发覆盖。
- 运行目录权限为 `0700`，正常退出立即删除；启动时清理超过 24 小时的有效 HUD 残留目录。
- 不调用云端服务，也不上传 HUD 状态。

Hook 采集失败不会阻止 Codex 或改变工具调用；只会使 HUD 显示降级。

## 验证

```bash
npm run check
npm audit --omit=dev
npm pack --dry-run
codex-hud doctor
```

自动测试覆盖 Hooks 合并与卸载、并发/乱序事件、精确进度、凭据脱敏、中文宽度、tmux pane 生命周期、Codex 参数和退出码透传。

## 故障排查

- `tmux unavailable`：运行 `brew install tmux`。
- `missing HUD lifecycle events`：运行 `codex-hud setup`。
- Codex 提示 Hook 未信任：在 Codex 输入 `/hooks`，核对并信任 HUD handler。
- `Terminal is too small`：把窗口扩大到至少 50×14。
- HUD 显示 `No plan provided`：当前 Codex 回合没有调用 `update_plan`，HUD 不会伪造 Todo。
- WebSearch 时只显示 `Working`：这是当前 Codex Hosted Tool Hook 覆盖范围的已知限制。

## 卸载与回滚

```bash
codex-hud uninstall
npm uninstall -g --prefix "$HOME/.local" codex-cli-agent-hud
```

`uninstall` 只移除带 `CODEX_HUD_HOOK_V1=1` 的 handler，保留其他 Hooks，并在修改前再次备份。若 tmux 仅为本项目安装，可另行决定是否执行 `brew uninstall tmux`。

官方能力边界可参考 [Codex Hooks](https://learn.chatgpt.com/docs/hooks) 和 [Codex 配置参考](https://developers.openai.com/codex/config-reference/)。
