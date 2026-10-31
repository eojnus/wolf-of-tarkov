# 无头模型工具架构与接口草案

状态：架构设计（2026-10-31），实施现状见 §4.1；命令参数、实测结果与限制以 `tools/model-tool/README.md` 为准。与 `model-tools.md` 的讨论冲突时，本文件只对工具实施接口负责；实际游戏行为仍以现行架构和契约为准。各阶段状态和可运行示例必须由实施者在验证后更新，不能将目标当成现有能力。

## 1. 目标和非目标

目标：让不同 Agent 非交互地发现能力、检查 GLB/glTF 与 USDZ、获得可读/机器报告和复现截图；逐步支持受控动作处理、跨角色动作映射、比例校准及真实碰撞可视化。支持能力须按文件格式和具体操作分别实测并报告。

不开发玩家内编辑器、任意系统命令、云服务、战斗系统或第二套游戏物理；不保证所有 USDZ 可无损编辑，不对任意人物承诺一键重定向，不靠截图声称动作或性能通过。

## 2. 执行与依赖边界

```text
Agent → CLI（参数/路径/报告）→ 单任务 runner
                              → 隔离的 Electron 渲染器 → Three.js 加载/检查/截图
                                                        → 按需调用游戏角色/碰撞适配
                              → 受控输出目录
```

使用项目已有 Electron、Vite、Three.js 优先验证可行性，不引入新框架；Node CLI 用 `.mjs`，Three.js 与现有游戏接入部分用 TypeScript。工具进程必须与实际游戏完全隔离：独立临时用户数据、禁止复用/结束游戏进程、不使用单实例锁、不读写生产存档。执行完清理由工具创建的进程和临时文件；绝不清理用户已有目录。后台渲染算一次渲染运行，实际游戏启动与截图分别计数并遵守任务预算。

渲染器维持 sandbox、contextIsolation、nodeIntegration=false、webSecurity=true；默认离线、无任意 IPC/Node 暴露。通过受限虚拟资源来源仅映射明确允许的输入文件及其相对依赖，拒绝路径穿越、软链接越界和远程 URL；若某模型引用外部资源，列出缺失/拒绝项。工具页面 CSP 为 Rapier 的 WASM 编译单独允许 `'wasm-unsafe-eval'`；`connect-src` 除自身协议与 `data:` 外只额外允许 `blob:`，用途是 GLB 内嵌图片（`GLTFLoader` 生成 blob URL，`ImageBitmapLoader` 用 `fetch` 读取）。没有 `unsafe-eval`、`*` 或 HTTP/HTTPS 白名单；该例外不进入正式游戏页面。工具本身不进入玩家安装包，禁止向玩家页面暴露工具权限。渲染服务只绑定回环地址与临时端口，不能连接或终止现有 Vite/Electron 服务；如所选实现不能安全满足要求，暂停并报告。

## 3. 功能分层

- **原始资产模式**：加载指定模型，报告真实数据、动画片段并按片段采样截图；不得把结果称作游戏程序化动作。
- **游戏角色模式**：通过 `adapters/game-character.ts` 复用真实 `CharacterRig` 状态更新与参数；当前 `loadCharacterRig` 固定读取 `PLAYER.model`，不保证可直接加载任意角色。若必须抽离加载/注入配置，先提交最小改动方案，不能复制一套假游戏动作冒充一致。
- **游戏碰撞模式**：适配真实场景/Rapier 数据。无法读取真实碰撞时返回 `UNSUPPORTED`，绝不将可视包围盒称为碰撞。设计独立工作包，先不调整物理规则。
- **派生资产模式**：修改预先声明的副本并写新文件；格式不支持时明确失败。USDZ 读取、渲染、裁剪导出分别核验，不假设无损写回。

## 4. Agent 命令契约（目标，不是当前可运行命令）

统一入口目标为 `node tools/model-tool/cli.mjs`；`--help` 和 `capabilities` 不启动渲染进程。必须支持 Windows 带空格/中文路径；参数交给进程 API 数组，不拼 shell 字符串。每条命令的 `--help` 包含用途、格式、最小例子、输出及副作用。标准输出只输出一个完整 JSON 对象，进度和日志走 stderr；大报告可写入 `--out` 指定目录，stdout 返回报告路径。所有路径要求绝对路径，工作目录不改变解释。

| 命令 | 输入 | 成功输出 | 阶段 |
| --- | --- | --- | --- |
| `capabilities` | 无 | 按格式逐项列出已实现/受限/不支持及运行要求 | 1 |
| `inspect --input <file> --out <dir>` | 模型，限定依赖目录为模型目录 | `report.json`；网格、三角面、材质/纹理、骨架、动作、依赖、坐标与警告 | 1 |
| `snapshot --input <file> --out <dir> [--clip <name>] [--time <seconds>] [--yaw <degrees>]` | 资产模式的指定片段与朝向 | PNG 和含相机、时间、朝向、来源、渲染环境的 `report.json` | 1 |
| `snapshot-game-character --out <dir> [--action] [--angles|--yaw]` | 当前游戏角色及语义动作；每个 yaw 独立重演 | 使用真实游戏角色控制路径的截图和说明 | 2 |
| `snapshot-game-character --turn-from/--turn-to/--turn-duration/--turn-samples` | 同一角色与动作的连续转向采样 | 按帧推进的截图（`turn-<index>`）、时间/帧/角度与静态重演对照 | 2 |
| `calibrate --input <file> --out <dir> ...` | 明确尺寸与朝向目标 | 只读建议/对比图，不自动改游戏配置 | 2 |
| `animation-edit` | 明确源文件、片段、区间、输出格式与路径 | 先计划后写派生资产；不覆盖原件；仅 LINEAR/STEP，CUBICSPLINE 明确拒绝 | 3 |
| `retarget` | 源/目标骨架及显式映射、输出 | 当前只报告映射和风险，不生成可播放目标动作；动作导出未实现 | 3 |
| `collision` | 可明确复现的实际游戏场景 | 初始布局重建的室外碰撞输入，不是运行中 Rapier 完整快照 | 4 |
| `collision-snapshot --scene outdoor\|indoor --out <dir>` | 隔离工具 World 的真实 PhysicsRuntime/Rapier Collider | JSON 快照 + 总览/近景 PNG；不连接玩家会话 | 4 |
| `collision-snapshot --self-check --out <dir>` | 隔离 PhysicsRuntime + 真实 Rapier RoundCuboid（不加载游戏场景） | 快照/绘制自检 JSON + 一张 PNG；不改变正式物理 | 4 |

后续命令参数由对应工作包在实现前写入本文并经架构审查；不能宣称已存在。源模型采用物理时间秒数；多朝向校验需 0/90/180/270 度，**每个朝向必须重置并按该朝向重新执行 rig.update**，不能先模拟一次再整体旋转姿态；连续转向是独立模式（每帧先设朝向再 update），不能与静态 `--angles` 混为一谈，保留轴约定及证据。对未明确的轴、镜像或不支持的变换不做静默修正。

### 4.1 实施现状（2026-10-31，2026-11-01 两轮增补）

A/B/C/D 四个工作包的代码与类型检查已完成，但**不表示全部验收通过**；当前命令用法和限制见 `tools/model-tool/README.md`。与本节目标的差异，按实测如实标注：

- 2026-11-01（第一轮）：GLB 内嵌贴图加载失败定位为工具页 CSP `connect-src` 缺少 `blob:`，补上后对 60 张内嵌图片的模型实测 60/60 成功、截图材质完整。资源状态改为按「声明/成功/失败/未知」记账；缺失外部贴图的 `snapshot` 负例实测返回 `partial`；CLI 的 `outputs` 只在报告真实写完后包含 `report.json`。
- 2026-11-01（第二轮）：静态多朝向改为「每个 yaw 独立 reset → 设朝向 → updateMatrixWorld → 逐步 rig.update」，两轮重演用于测量/截图并互相核对（0°/90°/180°/270° 实测一致，局部方向不随 yaw 变化、世界方向随 yaw 旋转）。新增连续转向模式（四个 `--turn-*` 成组、与 `--yaw/--angles` 互斥、1/60 s 固定步长、线性数值方向、采样映射到帧并去重、同 yaw/同步数静态重演对照）。`.gltf` 的声明数量改由加载后的 JSON 提供（`inspect` 与 `snapshot` 共用）。CSP 诊断在提交前等待一个宏任务并在 `error` 结果中保留。`--self-check` 用真实 `captureDebugSnapshot()` 验证 RoundCuboid 读取/绘制、快照副本隔离与“capture 期间不 step”。软件渲染分支实测 SwiftShader。
- 后续修正：骨骼一致性比较相对角色根的完整四元数，保留方向向量用于展示；存在不可判断骨骼且没有已知不一致时整体返回 `null`。零预热转向的首个动作步仍使用 `firstStep`。采样按请求区间比例映射到量化帧，终点到达目标 yaw，并同时报告实际时间。
- `inspect` / `snapshot` 走同一个隔离 Electron 渲染进程；`inspect` 不创建 WebGL 上下文（`metadata.rendererBackend` 为 null 即证明没建），但仍计入一次进程运行。
- `snapshot` 只采样资产内片段；`snapshot-game-character` 才是真实 `CharacterRig` 程序化路径（B）。两者不得互相替代说明。
- `animation-edit` 对 USDZ 直接返回 `USDZ_WRITE_UNSUPPORTED`（exit 3）；只支持 LINEAR/STEP。GLTFLoader 的 CUBICSPLINE 使用自定义 interpolant，遇到即返回 `CUBICSPLINE_UNSUPPORTED`（exit 3），不生成派生 GLB；Smooth/Bezier/未知自定义插值返回 `INTERPOLATION_UNSUPPORTED`，不退化为线性。GLB 派生导出必须 `--write-glb` + `--confirm-write` 同时给出，且是重新序列化而非无损编辑。
- `retarget` 只出映射报告：精确同名映射与「归一化猜测（需确认）」两类，未匹配项逐条列出，`exportSupported: false`；Casual_Male → Alina 实测 mapped=0，没有为 `n*` 骨骼编造匹配。动作套用/可播放导出未实现。
- `collision` 用初始布局重建室外碰撞输入（`createBaseLayout()` + `planCityBlocks` + `withGround`），不是运行中 Rapier 世界的完整快照；不含会话内街区抑制、室内结构/家具或运行时变化，差异逐条写在报告 `parity` 中。12 m 出生点近景保留；未来方向是把近景范围变为显式参数、保留总览并把参数写入报告，本轮不实现。
- `collision-snapshot` 在隔离工具进程单独创建 `World`，读取实际 `PhysicsRuntime` 的 Rapier Collider；不连接现有游戏、不读存档，不是玩家当前会话。`PhysicsRuntime.captureDebugSnapshot()` 只读取当前 Collider 副本，不 step/创建/修改物理对象；`World.capturePhysicsDebugSnapshot()` 附加场景/就绪/revision，未就绪明确抛错。绘制只支持 cuboid、round-cuboid（按 border radius 的真实圆角盒）和 capsule；其他形状只报告并警告，不用盒子冒充，报告用 `renderedAs` 区分。室外 52 Collider、室内 31 Collider 为历史实测；RoundCuboid 分支本轮由 `--self-check` 实测（外尺寸与 Rapier 半尺寸 + border radius 一致、截图圆角可见）。旧 `collision` 仍保留为规划输入视图，两者不混用。
- `--self-check` 在隔离 `PhysicsRuntime` 中加入 RoundCuboid，仅用于验证快照/绘制与副本隔离；私有 world 访问只存在于该自检代码，不向游戏公开可写 World。
- `--out` 的持久输出限制在当前项目目录的父目录（该目录或其合法子目录），由工具位置推导；不同 worktree 对应不同路径，实际写入还受执行环境权限约束。创建前校验最近已存在父目录真实路径、创建后复验；输入可以读取此范围外的绝对路径。
- 已有独立构建脚本：`npm run model-tool:build`（`vite build --config tools/model-tool/vite.config.mjs`）。

## 5. 结果与错误契约

所有命令统一结果 envelope，字段固定为：`schemaVersion`（初版 `1`）、`command`、`status`（`ok`/`partial`/`error`）、`inputs`、`outputs`、`diagnostics`、`metadata`、`data`。顶层 `status` 只描述命令/报告结果：`ok` = 任务完成且本次没有已知会使结果不完整的资源失败；`partial`（exit 6）= 主体结果可用但资源不完整或无法确认；`error` = 没有可用结果。具体看 `data.resourceIntegrity.status`（`complete`/`incomplete`/`unknown`）、`data.resourceIntegrity.materialRisk`（截图可否作为材质证据）与 `data.mappingUsability.status`。

- **`outputs` 只列真实写出的文件**：截图/派生资产由主进程以 `wx` 落盘；`report.json` 在 CLI 成功写入后才追加。`error` 不写报告，也不把不存在的报告路径放进 `outputs`；报告写入失败按 `error` 返回（`REPORT_WRITE_FAILED`），不伪称成功。报告的 `sha256` 恒为 `null`（不能自哈希）。
- **资源账本**（`inspect`/`snapshot` 的 `data.resources`）：`declared`（文件声明；GLB 由 CLI 只读 JSON chunk，`.gltf` 由加载后的 JSON，USDZ 为 `unavailable`）、`runtime`（本次请求/失败/贴图对象/带图纹理/槽位引用）、`failures`（按类别聚合，保留 `count`/`attempted`/样例）、`notAttemptedImages`、`unknown`、`materialRisk`、`countsNotes`。图片、纹理对象、材质槽位不是一一对应；临时 `blob:` 不是稳定资源路径；`null` 表示未知而不是 0。
- **`snapshot-game-character` 报告**：静态模式 `data.mode="angles"`，每个 angle 记录 `yaw`、`file`、`outputPath`、`box`、`boneDirections` 与两轮重演偏差 `replay`；`data.simulation` 说明 `yawSetBeforeUpdate` / `resetPerYaw` / `passes`。转向模式 `data.mode="turn"`，`data.turn` 记录起止 yaw、时长、总帧数、预热、插值规则、采样（请求时间/实际时间/帧号/yaw/文件/重复关系/静态重演对照）与 `duplicates`。两种模式都说明“不是游戏实际输入、不能证明手感或性能”。
- **`collision-snapshot --self-check` 报告**：`snapshotKind="physics-runtime-selfcheck"`，记录 RoundCuboid 的 `shape`/`halfExtents`/`radius`/`renderedAs`、期望与实测外尺寸、三次快照的副本隔离检查、capture 期间的 `step` 调用数与 `partialReasons`。
- **降级规则**：贴图/缓冲/模型请求失败、声明 bufferView 越界、声明与运行时对不上 → `incomplete`/`partial`；只读提示与参数夹取不降级；USDZ 没有清单时 `unknown`，`snapshot` 仍为 `ok` 但报告写明未验证。`animation-edit` 在加载失败时拒绝写出派生 GLB（`EXPORT_RESOURCE_INCOMPLETE`，exit 5）。
- **诊断**：同类失败聚合成一条 `DEPENDENCY_LOAD_FAILED`（`details` 含 `category`/`count`/`attempted`/样例），不逐条刷屏也不丢数量；CSP 拦截额外报 `CSP_BLOCKED`（`directives`/`blockedUriSamples`）。`securitypolicyviolation` 是异步派发：渲染页在提交结果前等一个宏任务再收集，并在 `error` 结果中保留已观察到的拦截。无结果用空数组或 null 并解释原因，不得把未知值写成零或通过。
- **截图报告**包含源文件 SHA-256、片段、秒数、相机、朝向、视口、Three.js/Electron、渲染后端、`resources` 与 `resourceIntegrity`；无法确认 GPU 信息时标为未知。
- **内部请求字段**（CLI → 渲染页，非 stdout 契约）：`declaredResources` 携带 GLB 声明摘要；`lib/contract.mjs` 校验其形状。新增字段属工具内部协议，不影响 envelope 的 `schemaVersion`。
- 退出码：0 表示命令完整成功；2 表示参数错误；3 表示格式或操作不支持；4 表示输入/输出或权限错误；5 表示处理/渲染失败；6 表示结果不完整（partial）。需要脚本兼容时按退出码和 JSON 同时判断；禁止捕获错误后返回成功。

## 6. 文件安全与结果

输入默认只读。`--out` 必须显式指定且位于当前项目目录的父目录内；比较规范化真实路径并处理 `..`、盘符、符号链接/junction，创建前校验最近已存在父目录，创建后复验。执行环境可能进一步限制可写范围。不覆盖输入或已有文件，已有结果应报错，不提供隐式覆盖。相对依赖不允许越过模型所在目录；不下载网络资源。报告中的路径不要包含未授权个人数据或存档内容。执行失败清理本次生成的临时文件，保留可诊断报告，不删除已有用户内容。导出/修改必须有明确用户任务授权；先给出修改计划及预期输出后再写派生文件；不得修改游戏配置、源资产或存档。

## 7. 能力限制与四方向防护

坐标显式区分模型、角色、骨骼与世界空间，记录前向、向上及单位；父级矩阵同步更新。对镜像、非均匀缩放、未知骨架绑定/轴向报告，不自动猜测。四方向相对姿态检查需同片段/时间及可复现相机；动态转向单独采样，截图/数值仅辅助诊断，不自动宣称自然。

## 8. 文档维护

`model-tools.md` 保存用户讨论和需求；本文件保存当前架构和命令契约；`tools/model-tool/README.md` 保存 Agent 调用方法及现有限制；`AGENTS.md` 提供模型任务入口。不得把“已实现”写成“已验证”。
