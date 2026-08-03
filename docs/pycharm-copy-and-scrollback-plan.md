# 持久 tmux 选区与明确复制计划

> 本文替代原先的“PyCharm 双模式复制”方案。旧方案试图在 PyCharm 原生选区和 tmux 选区之间切换；实际运行证明两个坐标系统会互相干扰，因此不再保留模式切换。

## 已确认的问题模型

- 在 HUD 模式中，tmux 和 JetBrains Terminal 都可能响应一次拖选，造成两层高亮。
- JetBrains 的原生高亮会随滚轮或终端重绘消失；它不是可靠的持久选区。
- “复制模式”按钮偶发被 IDE 吞掉，且用户在 HUD 模式下仍可复制，说明双模式既不稳定也没有清晰边界。
- 已用 tmux 3.7b 验证：由 tmux 管理的选区可以在按住左键滚轮，以及松开左键后继续滚轮时保留。因此修复应让 tmux 成为唯一受支持的选区状态。

## 目标行为

完成一次 `codex-hud setup` 后，用户仍然直接执行 `codex`，自动进入 HUD。HUD 自己创建隔离 tmux server 时：

1. 上方 Codex pane 的文本拖选由 tmux 持久管理；鼠标位置与 tmux 高亮必须一致。
2. 左键按住时滚轮、松开左键后滚轮，均不清除 tmux 选区，不退出历史，也不跳回底部。
3. HUD 只显示一个 `[复制所选]` 动作，不再显示“HUD 模式 / 复制模式”。
4. 仅点击 `[复制所选]`，或在选择/历史模式按 `Enter`，才会调用 macOS clipboard；拖选、松手、滚轮、Todo 点击和刷新不得自动复制。
5. `q` 是退出 copy-mode / 历史并返回 Codex 输入的明确动作。
6. IDE 原生选区可能短暂叠加或消失；验收只以 tmux 高亮为准。若 HUD 按钮被 IDE 吞掉，`Enter` 是可靠备用入口。
7. 用户已有 tmux server 的 key tables 与选择行为不修改；该场景不显示复制动作。

## 共享接口与实现边界

### 能力门控与 HUD UI

- 运行元数据使用 `copyActionControls`，只在 `ownsTmuxServer === true` 的 HUD 自有 isolated tmux 会话启用。
- 渲染器与点击命中计算共用一个 `[复制所选]` 的 CJK 宽度安全矩形；窄终端下安全隐藏，不能与 Todo 点击区域重叠。
- HUD 点击协议从模式设置改为明确复制动作；点击 Todo 仍只展开或收起 Todo。
- 点击动作应先确认当前 tmux 选区存在，再显式调用 macOS clipboard。无选区、非法坐标、过期控制事件或按钮不可用时必须安全忽略，绝不写入剪贴板。
- `Enter` 绑定为复制动作的备用入口；它只在选择/历史模式生效，不改变普通 Codex 输入的 Enter。

### tmux 行为

- HUD 自有 isolated server 维持 `mouse on`，但选择、滚动和复制均由 tmux 统一处理。
- `MouseDown1Pane`、`MouseDrag1Pane`、`MouseDragEnd1Pane`、双击和三击只管理 tmux 选区；`MouseDragEnd` 使用停止选择，不调用自动复制、`cancel`、`pbcopy`、OSC52 或 `copy-pipe`。
- 滚轮进入并停留在 copy-mode；鼠标选择路径和 HUD 重绘不能把视口拉回底部。
- `[复制所选]` 与选择/历史模式的 `Enter` 是仅有的 macOS clipboard 写入入口。复制动作本身不应成为隐式退出历史的替代；退出由 `q` 负责。
- 隔离 server 关闭 tmux 自动写系统剪贴板的能力，避免无意复制。
- 在嵌套/用户已有 tmux 中不安装或改写 `copy-mode` / `copy-mode-vi` key tables，也不注入复制按钮。

### GUI 与文档边界

- JetBrains 的 Mouse reporting 仍需开启，且 **Copy to clipboard on selection** 需关闭，防止 IDE 在松手时自动写剪贴板。
- HUD 无法读取或控制 IDE 的原生选区；它的暂时消失不是 tmux 选区是否存在的可靠信号。
- `doctor` 只报告“持久 tmux 选区 / 明确复制需要人工 GUI 验收”，不声称已经验证 PyCharm 设置或 GUI 行为。
- README 不承诺自动 GUI 验收；明确列出按住左键滚轮、松开后滚轮、按钮复制、`Enter` 备用、Todo 与防闪烁的验收步骤。

## 自动验证与人工验收

自动测试覆盖：

- 单一复制动作的渲染、命中、能力门控、窄屏隐藏和 Todo 点击隔离。
- 复制动作只在 HUD 自有 isolated tmux 生效；用户已有 tmux 不改 key tables。
- tmux 选区在开始选择、停止选择、按住滚轮和松开后滚轮均保留；滚轮与 `q` 行为不回归。
- 鼠标路径没有自动 copy / cancel / clipboard 调用；只有按钮动作和 copy-mode 的 `Enter` 可触发显式复制。
- Codex 非零退出、HUD pane 异常和 tmux 清理不覆盖原始退出码，动画抑制与差量重绘不回归。

集成后执行：

```bash
npm run check
npm audit --omit=dev
npm pack --dry-run
codex-hud doctor
codex-hud doctor --json
```

真实 GUI 验收必须在 PyCharm / IntelliJ 中完成：

1. 直接运行 `codex`，确认 HUD 自动出现、Todo 可点击、没有“HUD 模式 / 复制模式”按钮。
2. 拖选中英文、多行、自动换行的非敏感文本，以 tmux 高亮而非 IDE 临时高亮作为判断依据。
3. 左键按住时上下滚轮，确认选区、视口和剪贴板哨兵都保持不变。
4. 松开后再次上下滚轮，确认选区与历史位置仍保留，未自动复制或退出。
5. 点击 `[复制所选]`，确认此时才写入剪贴板且 Codex 不被中断；若 IDE 吞掉按钮，在选择/历史模式按 `Enter` 重复验证。
6. 按 `q` 后才退出历史模式；重复 Todo 展开/收起和运行中防闪烁检查。
7. 在用户已有 tmux server 中重复启动，确认不显示复制动作、不改变其 key tables。

自动测试通过不等于 GUI 已验收。任一项出现 tmux 选区丢失、自动复制、视口跳底、Codex 被中断或按钮和 `Enter` 都不可用时，结论必须写为 `degraded / not verified`。

## Git 与素材边界

- 本轮在功能分支完成独立、可验证的小提交并推送；不自动 merge、部署或关闭 Issue。
- 保留用户提供的四张参考截图；不重新加入或发布 `doc/初始.md`，也不把本计划文档打包进 npm 发布物。
