# Codex CLI Agent HUD

让 Codex CLI 在运行过程中始终拥有一个可见、可交互的底部状态面板。

完成一次安装后，日常使用方式仍然是直接输入 `codex`。交互式会话会自动进入 HUD，脚本、管道和非交互子命令则继续调用原始 Codex CLI。

HUD 持续展示当前任务、运行阶段、完成比例、正在执行的动作和 Todo，不需要修改 Codex 源码，也不会解析不稳定的终端画面。

## 运行效果

### 自动显示在 Codex 下方

![Codex CLI 自动进入底部 HUD](参考图片/img.png)

### 实时任务、进度与当前动作

![Codex HUD 展示实时任务、进度与 Todo](参考图片/img_1.png)

### 点击展开完整 Todo

![Codex HUD 展开 Todo 列表](参考图片/img_2.png)

### PyCharm Terminal 完整运行效果

![Codex HUD 在 PyCharm Terminal 中运行](参考图片/img_3.png)

## 核心能力

- **直接运行 `codex`**：安装后的交互入口自动启动 HUD，不需要记忆另一条启动命令。
- **始终位于终端底部**：Codex 保持在上方，HUD 使用独立区域持续显示状态。
- **真实计划进度**：Todo 和百分比来自 Codex 的 `update_plan`，不会根据文本猜测进度。
- **可点击 Todo**：收起时保留关键步骤，点击后展开完整列表，再次点击即可收起。
- **稳定滚动与持久选区**：仅在 HUD 自己创建的隔离 tmux 中，鼠标滚轮可回看当前 Codex 会话输出；按住左键滚动或松开后继续滚动，都不会自动清除 tmux 选区、退出历史或跳回底部。
- **明确复制动作**：隔离 HUD 会话提供 `[复制所选]`；只有点击它，或在选择/历史模式按 `Enter`，才会把 tmux 当前选区写入 macOS 剪贴板，拖选和松开鼠标绝不自动复制。
- **兼顾嵌入式终端**：针对 JetBrains Terminal 的运行中闪烁启用动画抑制和同步帧输出。
- **低侵入、可回滚**：Hooks 和 shell 入口都带有明确归属标记，卸载时只删除本项目写入的内容。
- **本地与脱敏**：不上传运行状态，不保存完整 transcript、工具输出或模型推理。

## 实现方式

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

Codex 官方 Hooks 提供结构化生命周期事件，`tmux` 为原始 Codex TUI 和 HUD 分配独立区域。HUD 不解析屏幕输出，也不读取不稳定的 transcript；进度按 `completed / total` 精确计算。

## 运行环境

- macOS
- Node.js 20 或更高版本
- Codex CLI 0.146.0 或兼容版本
- tmux

终端兼容目标包括：

- Apple Terminal（直接启动的隔离 HUD 会话提供安全历史、持久 tmux 选区和明确复制动作）
- PyCharm / IntelliJ 内置 Terminal（同上；IDE 原生选区需按下方步骤人工验收）
- VS Code 内置 Terminal（直接启动的隔离 HUD 会话提供安全历史、持久 tmux 选区和明确复制动作）
- iTerm2、Warp、WezTerm、Alacritty、Kitty 等兼容 xterm 的 macOS 终端

自动测试通过真实 PTY/tmux 验证 pane、鼠标绑定、scrollback、动态 resize 和退出码；并不等同于所有 GUI 终端版本都经过人工验收。JetBrains 终端建议使用 2025.3.2 或更新版本，旧版存在交互式 CLI 同步输出闪烁问题；持久选区与明确复制仍需要完成下方的手工验收。

其他操作系统在 v0.1 中为 `not verified`。托管型 WebSearch 不经过本地 Tool Hooks，因此运行时只能显示 `Working`，无法显示具体 WebSearch 动作。

## 安装

克隆仓库并执行：

```bash
git clone git@github.com:dazzlingwuming/Codex-CLI-Agent-HUD.git
cd Codex-CLI-Agent-HUD
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

```bash
# 日常使用：自动进入 Codex + HUD
codex

# 恢复或分叉 Codex 会话
codex resume [SESSION_ID]
codex fork [SESSION_ID]

# 显式启动、检查和维护
codex-hud run -- [Codex 参数]
codex-hud doctor
codex-hud doctor --json
codex-hud setup
codex-hud uninstall

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

HUD 会话还默认传入 Codex 官方的 `--no-alt-screen`，让输出保留在主屏并进入 tmux scrollback；同时注入 `tui.animations=false`，关闭运行中的 status、spinner 和 shimmer 动画，避免嵌入式终端高频重绘。JetBrains Terminal 2025.3.2+ 会额外启用 tmux synchronized output，把剩余流式更新作为完整帧提交。若用户显式传入 `tui.alternate_screen` 或 `tui.animations`，则尊重用户配置。

## 鼠标、Todo 与滚动

### 所有 HUD 会话

- 左键点击 HUD 的 Todo 区域或 `(+N more · click)` 可展开；再次点击可收起。
- 展开高度根据 Todo 数量和窗口高度动态计算，始终为上方 Codex 保留至少 10 行。

### HUD 自有 isolated tmux：持久选区与明确复制

直接执行 `codex`，且由 HUD 自己创建隔离 tmux server 时，上方 Codex pane 使用 tmux 的选区和 scrollback；HUD 右侧会显示一个 `[复制所选]` 动作。该按钮不是模式切换，也不会改变 Todo 交互。

- 滚轮会进入 copy-mode 并回看本次 HUD 会话的终端输出。按住左键拖选时滚轮，或已经松开左键、保留高亮后再滚轮，tmux 当前选区和历史位置都应继续保留。
- `MouseDragEnd` 只停止选择，不复制、不退出历史，也不跳回最新输出。`q` 是退出 copy-mode / 历史并回到 Codex 输入的明确动作。
- 只有在已经存在 tmux 选区时，点击 `[复制所选]`，或在选择/历史模式按 `Enter`，才调用 macOS 剪贴板。拖选、松手、滚轮、单击 Todo 和普通 HUD 重绘都不会写入剪贴板。
- 若 IDE 吞掉 HUD 上的鼠标点击，请在选择/历史模式按 `Enter` 作为可靠的复制入口；不要依赖松手自动复制。
- 这里的 scrollback 只包含本次 HUD/tmux 会话产生的输出，不包含启动 `codex` 前外层 shell 的历史。

PyCharm / IntelliJ 在启用 Mouse reporting 时，可能暂时绘制一层 IDE 原生选区；它可能在滚轮或重绘后消失。这不是 HUD 保存的选区，也不是复制成功的依据。以 tmux 保留的文本高亮为准；自动测试不能验证 IDE 的这层 GUI 绘制。

### 用户已有 tmux server

若在用户已有 tmux server 中启动，HUD 不修改该 server 的 `copy-mode` / `copy-mode-vi` key tables，也不显示 `[复制所选]`。拖选、松开、滚动、复制和退出历史完全遵从用户自己的 tmux 配置。若该配置在 copy-mode 中拦截 HUD 点击，先按 `q` 退出历史模式再点击 Todo。

若需要让外层终端直接处理选区或滚动，可使用该终端配置的 tmux bypass 修饰键；常见是按住 `Shift`，具体以终端设置为准。

### PyCharm / IntelliJ 手工验收

在 `Settings | Tools | Terminal` 中打开 **Mouse reporting**，并关闭 **Copy to clipboard on selection**，避免 IDE 在松手时自行污染剪贴板。`codex-hud doctor` 只能提示验收要求，不能读取或修改 IDE 设置。

1. 在 PyCharm 内直接执行 `codex`（不要先进入用户 tmux），确认 HUD 自动出现、Todo 可展开/收起，且只出现一个 `[复制所选]` 动作，不再有“HUD 模式 / 复制模式”切换。
2. 用非敏感、包含中英文、自动换行和多行的唯一文本拖选，确认 tmux 高亮与鼠标位置一致；IDE 若出现又消失的额外原生高亮，不把它当作验收依据。
3. 左键保持按下时滚轮上、下滚动，确认 tmux 选区没有消失，视口没有跳回底部，剪贴板仍保留预先写入的哨兵文本。
4. 松开左键后保留 tmux 高亮，再滚轮上、下滚动；确认选区和历史位置仍保留，且没有自动复制或退出。
5. 点击 `[复制所选]`，确认只有此时剪贴板变为选中文本，Codex 未被中断。若按钮被 IDE 吞掉，在选择/历史模式按 `Enter` 重复验证；两条明确动作都应可用。
6. 按 `q` 后才退出历史模式并回到 Codex 输入；再确认 Todo 点击和运行中的差量刷新没有引入高频闪烁。
7. 另在用户已有 tmux server 中启动一次，确认不显示复制动作、也没有改写用户自己的选择和复制键表。

如果 tmux 高亮在任一滚动场景中丢失、拖选或松开自动复制、明确复制动作中断 Codex、视口跳底，或按钮与 `Enter` 都不可用，应标记为 `degraded / not verified`，不要把该 GUI 终端视为已验收。

## HUD 状态含义

- `Task`：最新 `UserPromptSubmit` 的首个非空行。
- `Progress`：已完成 Todo 数量、总数和整数百分比；没有 plan 时显示 `—`。
- `Current`：当前本地工具、等待审批、压缩 Context、Thinking 或 Ready。
- `Todo`：收起时最多显示 3 项，以 `inProgress` 项为中心；点击后显示当前终端高度可容纳的更多项目。
- `~Planning`、`~Coding`、`~Testing` 等带 `~` 的阶段是根据结构化工具事件推导的，不是 Codex 官方阶段。
- `Completed` 只在非空 Todo 全部完成且收到 `Stop` 后显示。

终端至少需要 50 列、14 行。达到 80 列、22 行时使用 6 行完整 HUD，否则使用 3 行紧凑布局。窗口 resize 或 Todo 展开/收起后 renderer 会自动调整。

为降低输入区闪烁，HUD renderer 首帧清理一次，后续只更新内容发生变化的行；计时显示最多每秒更新一次，不再高频整屏清除或反复隐藏/显示光标。HUD 包装的 Codex 也默认关闭运行中动画。

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

真实 GUI 终端的字体、主题、原生选区和滚动行为仍可能受终端自身配置影响；持久 tmux 选区与明确复制动作必须按上方手工验收执行，自动测试不能代替它。

## 故障排查

- `tmux unavailable`：运行 `brew install tmux`。
- `missing HUD lifecycle events`：运行 `codex-hud setup`。
- Codex 提示 Hook 未信任：在 Codex 输入 `/hooks`，核对并信任 HUD handler。
- `Terminal is too small`：把窗口扩大到至少 50×14。
- HUD 显示 `No plan provided`：当前 Codex 回合没有调用 `update_plan`，HUD 不会伪造 Todo。
- WebSearch 时只显示 `Working`：这是当前 Codex Hosted Tool Hook 覆盖范围的已知限制。
- `codex` 没有自动进入 HUD：执行 `codex-hud setup` 后打开新终端，或运行 `source ~/.zshrc`；再用 `type codex` 确认它是 HUD 安装的 function。
- PyCharm 输入区仍高频闪烁：确认已经退出旧会话并重新执行 `codex`，再检查真实启动参数是否包含 `tui.animations=false`，且 tmux client features 包含 `sync`；同时升级 PyCharm/IntelliJ 平台到 2025.3.2 或更新版本。HUD 已关闭 Codex 运行中动画、启用同步帧并使用差量刷新，但无法从应用层修复旧版 JetBrains Terminal 的同步输出渲染缺陷。
- `[复制所选]` 没有出现：确认是直接执行 `codex`，让 HUD 自己创建隔离 tmux；在用户已有 tmux server 中会刻意隐藏，以免改写用户的选择和复制键表。
- PyCharm 松手后仍自动复制：检查 **Mouse reporting** 已开启、**Copy to clipboard on selection** 已关闭。HUD 的设计只允许点击 `[复制所选]` 或选择/历史模式的 `Enter` 写入剪贴板；doctor 不能替你读取或修改 IDE 设置。
- PyCharm 原生高亮在滚轮后消失：这是 IDE 层可能发生的临时绘制，不等于 tmux 选区已经丢失。检查 tmux 高亮是否仍存在；若 tmux 高亮也消失，按上方手工验收记录为 `degraded / not verified`。
- HUD 自己创建的隔离 tmux 中，滚轮进入 copy-mode 后不能继续输入：按 `q` 退出 copy-mode；拖选、松开或滚轮不应自动退出、自动复制或跳回底部。若仍发生，按手工验收记录为 `degraded / not verified`。
- 用户已有 tmux server 中的拖选、松开、单击和退出历史行为由其 `copy-mode` / `copy-mode-vi` key tables 决定；请按自己的 tmux 配置检查或调整。

## 卸载与回滚

```bash
codex-hud uninstall
npm uninstall -g --prefix "$HOME/.local" codex-cli-agent-hud
```

`uninstall` 只移除带 `CODEX_HUD_HOOK_V1=1` 的 handler 和带边界标记的 `.zshrc` 入口，保留其他 Hooks 与 shell 内容，并在修改前再次备份。若 tmux 仅为本项目安装，可另行决定是否执行 `brew uninstall tmux`。

官方能力边界可参考 [Codex Hooks](https://learn.chatgpt.com/docs/hooks)、[Codex CLI reference](https://developers.openai.com/codex/cli/reference/) 和 [Codex 配置参考](https://developers.openai.com/codex/config-reference/)。JetBrains 闪烁背景与修复版本见 [IJPL-204106](https://youtrack.jetbrains.com/projects/IJPL/issues/IJPL-204106/Terminal-flickers-when-running-interactive-programs-like-Claude-Code) 和 [IntelliJ IDEA 2025.3.2 release notes](https://blog.jetbrains.com/idea/2026/01/intellij-idea-2025-3-2/)。
