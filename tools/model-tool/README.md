# 无头模型工具（架构骨架）

状态：仅文件职责占位，尚无实现或可用命令。实现以 `docs/model-tool-architecture.md` 与 `docs/model-tool-work-packages.md` 为准；讨论历史见 `docs/model-tools.md`。不要将这些文件直接提交为已可用工具。

文件边界：`cli.mjs` 命令入口；`lib/` 负责协议、路径和调度；`renderer/` 负责隔离渲染与 Three.js 模型工作；`adapters/` 负责现有游戏特定功能。预建文件只含说明，实施者必须按阶段填充，未实现能力不得伪装成功。
