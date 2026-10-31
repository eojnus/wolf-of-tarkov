# 无头模型工具实施工作包

状态：架构师预分工；A/B/C/D 的代码已于 2026-10-31 完成实施，但**不代表全部验收通过**；实际能力、参数、已验证/未验证与 11 次成功渲染记录见 `tools/model-tool/README.md`。当前 `retarget` 只有骨骼映射报告，没有可播放动作导出；`animation-edit` 明确拒绝 CUBICSPLINE。`collision-snapshot` 的室外与室内均已跑；RoundCuboid 绘制只有代码/构建检查。用户已授权架构与骨架，**不意味着已授权实施者立即执行全部工作包**。未经用户明确交给外部 Agent，不开始编码。禁止同时让多个实施者修改同一文件或共享配置。

## 全局约束

先阅读 `AGENTS.md`、`docs/model-tools.md`、`docs/model-tool-architecture.md` 和本文件。保护已有桌面/Alina 未提交改动；不改 Core、业务规则、物理参数或存档，不发送消息、不合并、不推送。采用现有依赖优先；新增框架或广泛更改公共接口先报告。遵守非必要不测试原则：一次 typecheck + 生产构建；有具体风险才做局部验证；运行/无头渲染的次数按用户对当前任务的明确授权执行，三次游戏启动限制不自动授权额外截图进程。不得终止已有游戏、触碰生产用户数据。

状态汇报必须区分命令结果与业务可用性：顶层 `ok/partial/error` 只描述报告结果；`inspect` 的资源完整性看 `data.resourceIntegrity.status`，`retarget` 的映射可用性看 `data.mappingUsability.status`。零匹配、关键骨骼未匹配/未知、依赖缺失或无法枚举都不能写成“全部正常”。

## A：发现、资产检查、受控渲染（先实施）

- 文件：`tools/model-tool/cli.mjs`、`lib/{contract,paths,runner}.mjs`、`renderer/{index.html,main,load,inspect,render}.ts`、`tools/model-tool/README.md`；必要时只修改 package 脚本及本工具独立构建配置。不得实现 B–D 的占位功能。
- 实现 `capabilities`、`inspect`、`snapshot` 和帮助，遵循架构文档的输入、结果和安全约束；报告能力矩阵，USDZ 和 glTF/GLB 分开列真实情况。
- Alina USDZ 与现有 GLB 为候选样例；只在明确的渲染预算下执行最小验证，记录每个进程。检查中文路径、输入输出碰撞、缺贴图、无动画、坏文件与错误诊断；不访问生产游戏用户目录或远程资源。
- 不得声明 `snapshot` 可预览 Alina 游戏程序化动作，它只采样资产内片段。先交实际结果、已知限制与复现方式给架构师审查。

## B：游戏角色与比例（A 审查后）

- 文件：`adapters/game-character.ts`、`renderer/transform.ts`，按需修改 A 文件及现有角色代码的最小接口；公共接口或现有游戏抽离先提交方案。
- 真实游戏 `CharacterRig` 预览语义动作，提供比例参照和多朝向诊断。不能把 USDZ 自带展示动作当作游戏中程序化 walk/run/jump。
- 检查不同朝向的角色局部结果，未知坐标系/镜像不能静默猜测；不修改物理或场景比例。输出引用、参数和限制。

## C：动画处理与跨模型套用（B 审查后）

- 文件：`renderer/animation.ts`、`renderer/retarget.ts`，必要时扩展已有命令与报告；修改前先提出格式支持矩阵和派生资产计划。
- 优先实现能够确证的裁剪、重命名、映射预览；骨架映射与重定向须报告未匹配项、绑定姿态、比例和根运动。存在歧义时停下要求显式输入，不承诺任意文件互相兼容。
- `animation-edit` 只接受 LINEAR/STEP；CUBICSPLINE 使用自定义 interpolant，当前没有正确裁剪实现，必须返回 `CUBICSPLINE_UNSUPPORTED`（exit 3）且不生成派生 GLB；不得静默转线性。其他无法证明正确的插值同样明确拒绝。
- `retarget` 当前只输出骨骼映射报告（候选、未匹配、不确定），不编造 `n*` 骨骼匹配，不生成可播放目标动作；动作套用属于未实现能力，不能写成已验收。
- 无 USDZ 无损写回证明前禁止声称支持；必须保留源文件、作者、许可和派生关系。不引入 Mixamo 或未授权素材。

## D：真实碰撞诊断（单独审查后）

- 文件：`adapters/game-collision.ts`，必要时以最小只读接口复用现有 Rapier 场景信息；变更物理公共边界先审查。
- 仅展示真实场景中的胶囊和碰撞盒；不可将模型包围盒伪称碰撞。说明场景初始化与数据来源；不改变物理或游戏存档。
- 当前 collision 是基于初始布局重建的室外碰撞输入，不是运行中 Rapier 世界的完整快照；不含所有室内/会话变化。12 m 出生点近景可保留，胶囊偏小作为已知限制；近景显式参数本轮不实现，后续需保留总览并把参数写入报告。
- `collision-snapshot` 在隔离工具 World 中读取真实 PhysicsRuntime/Rapier Collider；必须明确它不是玩家会话、室内是默认内存家具布局。本轮室外与室内实测通过；RoundCuboid 用真实圆角几何，当前样例没有 round-cuboid，绘制分支未获视觉样例。

## 每包交付

实际文件、接口、依赖版本、命令及 JSON 示例、支持/不支持矩阵、安全与数据路径、各项实际验证和运行次数、问题及未验证项。更新快速开始与相关架构文档；在完成可用能力前不提供假命令或假成功。不要把预建空壳当成已交付功能。
