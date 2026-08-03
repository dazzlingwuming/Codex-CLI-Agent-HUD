# PyCharm 双模式复制与终端滚动修复计划

## 目标与最终行为

- 完成一次 `codex-hud setup` 后，用户仍然直接执行 `codex`，自动进入 HUD。
- PyCharm 终端底部显示 `[复制模式]` 和 `[HUD 模式]` 两个可点击按钮，默认进入 HUD 模式。
- 复制模式禁止 tmux 再创建第二层鼠标选区，只保留 PyCharm 原生选区。
- 松开鼠标后选区继续保留；剪贴板不会自动变化，只有按 `⌘C` 才复制。
- 向上查看历史记录后，拖选、松开和再次单击都不跳回底部；只有按 `q` 才退出历史模式。
- 保留现有动画抑制、同步帧和差量刷新，运行过程中不得重新出现高频闪烁。

核心原则：复制模式不是代替 PyCharm 的复制功能，而是关闭 tmux 的第二套选区。只有一个选区坐标系统时，动态位置偏移才可能消失。

## 接口与实现改动

### 模式状态和点击协议

内部模式固定为：

```text
hud | copy
```

新增原子控制事件：

```json
{
  "version": 1,
  "kind": "interaction.mode.set",
  "mode": "hud",
  "observedAtMs": 0
}
```

- 使用显式 `set`，不使用 `toggle`；重复点击当前模式是幂等操作。
- HUD 每次启动都从 `hud` 开始，不跨会话持久化。
- 非法、过期或未来版本事件安全忽略。
- 增加隐藏命令 `__hud-click`，接收 tmux 的鼠标行列、HUD 宽度和 pane 信息。
- 渲染和点击判断共用同一套按钮矩形计算，并按终端显示宽度处理中文字符。
- 模式切换先应用 tmux 策略，再写控制事件；失败时回滚并报告降级。
- 点击模式按钮不触发 Todo；其他 HUD 区域保留现有 Todo 展开与收起行为。

### tmux 鼠标策略

新策略只安装到 HUD 自己创建的隔离 tmux server，避免修改用户已有 server 的全局键表。

HUD 模式：

- 保持 `mouse on` 并保留顶部 Codex pane 的正常鼠标交互。
- 在 `copy-mode` 和 `copy-mode-vi` 中，按下清除旧选区但保持位置，拖动开始选择，松开执行 `stop-selection`。
- 双击和三击选择单词或整行后停止选择，不复制、不退出。
- 滚轮不变，`q` 明确退出历史模式。

复制模式：

- 仍保持 `mouse on`，确保底部两个按钮始终可点击。
- 顶部 pane 的单击只选择 pane，单击、拖动、松开、双击和三击均不触发 tmux 选区。
- 已进入历史模式时同样禁止第二层选区，但滚轮和 `q` 继续有效。
- 鼠标路径禁止调用 `copy-pipe`、`copy-selection`、`cancel`、`pbcopy` 或 OSC52。
- 隔离 server 关闭 tmux 自动写系统剪贴板的能力。

### 兼容性与生命周期

- 双按钮仅在 JetBrains/PyCharm 终端且本次 HUD 拥有隔离 tmux server 时启用。
- Apple Terminal、VS Code 和其他终端继续显示 HUD，并获得历史位置修复，但不显示 PyCharm 复制按钮。
- 在用户已有 tmux 中启动时隐藏复制按钮，避免 server 全局键表影响其他会话。
- 准确保存并恢复嵌套 tmux 的 `mouse`、`status`、`history-limit`、`remain-on-exit`、pane 标题和原始鼠标绑定。
- 区分本地设置与继承设置；继承项使用 unset 恢复，不能写空字符串覆盖。
- 从首次修改 tmux 状态之前进入 `try/finally`；恢复失败报告降级，但不覆盖 Codex 原始退出码。
- `doctor` 只报告 JetBrains 检测和人工验证要求，不声称已自动确认 IDE 设置。

## 验证与验收

自动测试覆盖：

- 模式默认值、显式切换、重复点击、非法事件和能力门控。
- 完整、紧凑和窄布局，中文显示宽度及按钮绘制/点击区域一致性。
- 模式按钮与 Todo 点击互不干扰。
- HUD 模式松开后仍在历史位置，下一次单击只清除选区。
- 复制模式的选择类鼠标事件不触发 tmux，滚轮和 `q` 正常。
- 所有鼠标路径不自动复制或退出。
- Codex 非零退出、HUD pane 异常和模式失败时正确清理或恢复。
- 自动启动、静态动画、同步帧和差异重绘不回归。

集成后执行：

```bash
npm run check
npm audit --omit=dev
npm pack --dry-run
codex-hud doctor
codex-hud doctor --json
```

PyCharm 2025.3.6 Reworked Terminal 人工验收：

1. 直接执行 `codex`，HUD 自动出现且默认为 HUD 模式。
2. Codex 运行中和停止后都无高频闪烁。
3. Todo 可以点击展开和收起。
4. 进入复制模式后两个模式按钮仍可点击。
5. 拖选包含中文、英文、自动换行和多行的唯一文本，实际高亮与鼠标位置一致。
6. 松开后高亮不消失，系统剪贴板仍保持哨兵内容。
7. 按 `⌘C` 后只复制选中文字，且不打断 Codex。
8. 滚动到早期记录后拖选、松开、再单击，视口不跳到底部。
9. 按 `q` 后才退出历史模式。
10. 切回 HUD 模式后，Todo、滚轮和原有交互恢复。

如果 PyCharm 仍产生双层选区、松开即丢失选区或 `⌘C` 中断 Codex，复制模式标记为 `degraded / not verified`，不得宣传为已完成；历史跳底修复可独立保留。

## 子 Agent 与 Git 执行安排

- 集成分支为 `feat/pycharm-copy-and-scrollback`。
- 子 Agent 统一使用 `gpt-5.6-terra`、`max`，不使用 sol。
- 先提交模式常量、能力判断和按钮坐标共享契约。
- 三个短生命周期分支并行执行：
  - `agent/tmux-scrollback`：tmux 鼠标策略、历史位置、生命周期恢复及测试。
  - `agent/hud-copy-ui`：HUD 按钮、点击命中、控制状态、渲染及测试。
  - `agent/docs-doctor`：doctor、README、兼容说明及测试。
- 主 Agent 独占 CLI 接线和最终集成，避免共享入口冲突。
- 每个独立任务验证后 commit 并 push；主 Agent 按共享契约、tmux、HUD、文档顺序集成。
- 本轮只提交和推送分支，不自动 merge、部署、关闭 Issue 或删除远端分支。

## 假设与边界

- 当前版本继续只支持 macOS。
- 用户要的是自主选择后按 `⌘C` 复制，绝不采用松开鼠标自动复制。
- PyCharm 双按钮优先于所有终端统一提供按钮。
- Apple Terminal 和 VS Code 只承诺 HUD 与历史滚动不回归，不在本次宣称完成原生复制适配。
- 不覆盖用户显式传入的 Codex TUI 配置。
- 不重新加入初始任务文档或未获确认的参考素材。
