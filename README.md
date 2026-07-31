# Codex CLI Agent HUD

Codex CLI Agent HUD 在同一个终端窗口底部持续展示当前任务、Todo、完成比例、当前工具和执行阶段。完成一次 `setup` 后，仍然直接输入 `codex`；交互式 Codex 会自动进入 HUD，脚本和非交互子命令继续运行原始 Codex。

它通过 Codex 官方 Hooks 收集状态，通过 `tmux` 为 Codex 原始 TUI 和 HUD 分配独立区域，不修改 Codex 核心代码。

需求来源见 [`doc/初始.md`](doc/初始.md)，目标视觉参考见 [`参考图片/2026-07-31_11-21-37.png`](参考图片/2026-07-31_11-21-37.png)。

## 工作方式

```text
codex
  └─ zsh 交互入口（只路由交互式调用）
       └─ tmux
           ├─ 上方 pane：原始 Codex CLI
           │    └─ 原生状态行：模型 / Context / 目录 / Git / run-state
           └─ 下方 pane：Codex HUD
                └─ Task / Phase / Progress / Current / Todo

Codex Hooks → 脱敏事件 → 状态归约 → HUD Renderer
```

HUD 不解析 Codex 的屏幕输出，也不读取不稳定的 transcript。Todo 和进度只来自 Codex 的 `update_plan`，百分比按 `completed / total` 计算。

## 运行环境

- macOS
- Node.js 20 或更高版本
- Codex CLI 0.146.0 或兼容版本
- tmux

终端兼容目标包括：

- Apple Terminal
- PyCharm / IntelliJ 内置 Terminal
- VS Code 内置 Terminal
- iTerm2、Warp、WezTerm、Alacritty、Kitty 等兼容 xterm 的 macOS 终端

自动测试通过真实 PTY/tmux 验证 pane、鼠标绑定、scrollback、动态 resize 和退出码；并不等同于所有 GUI 终端版本都经过人工验收。JetBrains 终端建议使用 2025.3.2 或更新版本，旧版存在交互式 CLI 同步输出闪烁问题。

其他操作系统在 v0.1 中为 `not verified`。托管型 WebSearch 不经过本地 Tool Hooks，因此运行时只能显示 `Working`，无法显示具体 WebSearch 动作。

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
5. 在 `~/.zshrc` 中幂等添加带边界标记的 `codex()` 交互入口。
6. 修改已有 `.zshrc` 前创建权限为 `0600` 的备份；若发现用户已有 `codex` alias/function，则拒绝覆盖。

安装完成后打开新终端，或在当前 zsh 执行：

```bash
source ~/.zshrc
```

首次安装或 Hook 命令发生变化后，启动 Codex，输入 `/hooks`，核对并信任包含 `CODEX_HUD_HOOK_V1=1` 的 handler，然后退出并重新启动 Codex，使新信任的 Hooks 在新会话中加载。项目不会使用 `--dangerously-bypass-hook-trust`。

## 使用

```text
codex
codex resume [SESSION_ID]
codex fork [SESSION_ID]
codex-hud run -- [Codex 参数]
codex-hud doctor
codex-hud doctor --json
codex-hud setup
codex-hud uninstall
```

示例：

```bash
# 日常用法：在当前目录启动交互式 Codex + HUD
codex

# 交互式参数仍然可直接传递
codex -m gpt-5.6-terra -C /path/to/project

# exec/review/help/version 等非交互调用自动透传给原始 Codex
codex exec "检查当前仓库"
codex --version

# 临时完全绕过 HUD 入口
command codex

# 检查依赖、终端、Hooks feature、shell 入口和安装状态
codex-hud doctor
```

`codex-hud` 和 `codex-hud run -- ...` 仍保留为显式启动与故障排查入口。非 TTY 管道也会自动绕过 HUD，不会把脚本塞进 tmux。

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

HUD 会话还默认传入 Codex 官方的 `--no-alt-screen`，让输出保留在主屏并进入 tmux scrollback。若用户显式传入 `tui.alternate_screen`，则尊重用户配置。

## 鼠标、Todo 与滚动

- 左键点击 HUD 的 Todo 区域或 `(+N more · click)` 可展开；再次点击可收起。
- 展开高度根据 Todo 数量和窗口高度动态计算，始终为上方 Codex 保留至少 10 行。
- 在上方 Codex pane 使用滚轮会进入 tmux copy-mode，并回看当前 HUD 会话的终端输出。
- 在 copy-mode 中继续滚轮浏览，按 `q` 返回 Codex 输入。
- 若需要让外层终端直接处理选区或滚动，可使用对应终端的 tmux bypass 修饰键；常见是按住 `Shift`，具体以终端设置为准。

这里的 scrollback 是本次 HUD/tmux 会话产生的输出，不包含启动 `codex` 之前外层 shell 已有的历史。

## HUD 状态含义

- `Task`：最新 `UserPromptSubmit` 的首个非空行。
- `Progress`：已完成 Todo 数量、总数和整数百分比；没有 plan 时显示 `—`。
- `Current`：当前本地工具、等待审批、压缩 Context、Thinking 或 Ready。
- `Todo`：收起时最多显示 3 项，以 `inProgress` 项为中心；点击后显示当前终端高度可容纳的更多项目。
- `~Planning`、`~Coding`、`~Testing` 等带 `~` 的阶段是根据结构化工具事件推导的，不是 Codex 官方阶段。
- `Completed` 只在非空 Todo 全部完成且收到 `Stop` 后显示。

终端至少需要 50 列、14 行。达到 80 列、22 行时使用 6 行完整 HUD，否则使用 3 行紧凑布局。窗口 resize 或 Todo 展开/收起后 renderer 会自动调整。

为降低输入区闪烁，HUD renderer 首帧清理一次，后续只更新内容发生变化的行；计时显示最多每秒更新一次，不再高频整屏清除或反复隐藏/显示光标。

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

自动测试覆盖 Hooks 合并与卸载、shell 入口与回滚、交互/非交互路由、并发/乱序事件、精确进度、凭据脱敏、中文宽度、差量渲染、tmux scrollback、Todo 展开/收起、pane 生命周期、Codex 参数和退出码透传。

## 故障排查

- `tmux unavailable`：运行 `brew install tmux`。
- `missing HUD lifecycle events`：运行 `codex-hud setup`。
- Codex 提示 Hook 未信任：在 Codex 输入 `/hooks`，核对并信任 HUD handler。
- `Terminal is too small`：把窗口扩大到至少 50×14。
- HUD 显示 `No plan provided`：当前 Codex 回合没有调用 `update_plan`，HUD 不会伪造 Todo。
- WebSearch 时只显示 `Working`：这是当前 Codex Hosted Tool Hook 覆盖范围的已知限制。
- `codex` 没有自动进入 HUD：执行 `codex-hud setup` 后打开新终端，或运行 `source ~/.zshrc`；再用 `type codex` 确认它是 HUD 安装的 function。
- PyCharm 输入区仍高频闪烁：先升级 PyCharm/IntelliJ 平台到 2025.3.2 或更新版本。HUD 已使用差量刷新，但无法从应用层修复旧版 JetBrains Terminal 的同步输出渲染缺陷。
- 滚轮进入 copy-mode 后不能继续输入：按 `q` 退出 copy-mode。

## 卸载与回滚

```bash
codex-hud uninstall
npm uninstall -g --prefix "$HOME/.local" codex-cli-agent-hud
```

`uninstall` 只移除带 `CODEX_HUD_HOOK_V1=1` 的 handler 和带边界标记的 `.zshrc` 入口，保留其他 Hooks 与 shell 内容，并在修改前再次备份。若 tmux 仅为本项目安装，可另行决定是否执行 `brew uninstall tmux`。

官方能力边界可参考 [Codex Hooks](https://learn.chatgpt.com/docs/hooks)、[Codex CLI reference](https://developers.openai.com/codex/cli/reference/) 和 [Codex 配置参考](https://developers.openai.com/codex/config-reference/)。JetBrains 闪烁背景与修复版本见 [IJPL-204106](https://youtrack.jetbrains.com/projects/IJPL/issues/IJPL-204106/Terminal-flickers-when-running-interactive-programs-like-Claude-Code) 和 [IntelliJ IDEA 2025.3.2 release notes](https://blog.jetbrains.com/idea/2026/01/intellij-idea-2025-3-2/)。
