# Codex CLI Agent HUD

Codex CLI Agent HUD 在同一个终端窗口底部持续展示当前任务、Todo、完成比例、当前工具和执行阶段。它通过 Codex 官方 Hooks 收集状态，通过 `tmux` 为 Codex 原始 TUI 和 HUD 分配独立区域，不修改 Codex 核心代码。

> 当前状态：v0.1 正在实现。需求来源见 [`doc/初始.md`](doc/初始.md)，目标视觉参考见 [`参考图片/2026-07-31_11-21-37.png`](参考图片/2026-07-31_11-21-37.png)。

## v0.1 目标

- 保留 Codex 原始交互、审批和快捷键。
- 原生状态行显示模型、Context、目录、Git 和运行状态。
- 自定义 HUD 显示当前任务、精确 Todo 进度、当前动作、推导阶段和会话时长。
- 通过用户级 Hooks 从任意项目目录启动。
- 不读取不稳定的 transcript，不预测任务完成度。

## 运行环境

- macOS / Apple Terminal
- Node.js 20 或更高版本
- Codex CLI 0.146.0 或兼容版本
- tmux

其他操作系统和终端在 v0.1 中均为 `not verified`。

## 计划中的命令

```text
codex-hud
codex-hud run -- [Codex 参数]
codex-hud setup
codex-hud doctor
codex-hud doctor --json
codex-hud uninstall
```

完整安装、信任 Hooks、验收和回滚说明会随实现补充。

## 数据边界

HUD 只保留当前会话显示所需的脱敏摘要，不保存工具返回值、文件内容、完整 transcript 或模型推理。运行状态位于权限受限的临时目录，并在会话结束时清理。
