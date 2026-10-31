# 无头模型工具（model-tool）

状态：A/B/C/D 的代码已实现（2026-10-31），2026-11-01 修复了 GLB 内嵌贴图加载与资源状态判定；**不代表全部验收通过**，实际通过、部分通过和未验证按第 3、4、8、9 节逐项区分。`retarget` 当前只验证骨骼映射报告，不生成可播放动作；`animation-edit` 的 CUBICSPLINE 尚不支持。

先读这三条再调用：

- `ok` = 任务完成，且本次加载没有已知会使结果不完整的资源失败；`partial` = 报告/截图可用但资源不完整或无法确认；`error` = 没有可用结果。退出码 `0/6/其他` 与之对应。
- 贴图加载失败时 `snapshot` 仍会写出 PNG 供排查，但返回 `partial`，**该 PNG 不能作为材质正确的证据**。
- 资源统计看 `data.resources`：`declared`（文件声明）、`runtime`（本次实际请求/成功/失败）、`failures`（失败聚合）、`unknown`（无法确认）。`null` 表示未知，不是 0。

架构与命令契约见 `docs/model-tool-architecture.md`，需求讨论见 `docs/model-tools.md`，分工见 `docs/model-tool-work-packages.md`。

## 1. 它是什么

给 Agent 用的非交互工具：一条命令读模型、出结构化报告或渲染一张可复现的 PNG。它复用游戏自己的 Three.js（`three@0.186.1`）与真实 `CharacterRig`，但**完全独立于游戏进程**：独立 Electron 实例、独立 `userData`、不读玩家存档、不结束任何已有进程。

不支持：玩家内编辑器、任意系统命令、下载远程资源、USDZ 写回、任意角色互套动作。

## 2. 快速开始

```powershell
# 在项目根目录执行；持久输出根为项目目录的父目录。
$projectRoot = (Get-Location).Path
$outRoot = Join-Path (Split-Path -Parent $projectRoot) 'model-tool-out'

# 一次性构建工具渲染页（产物在 tools/model-tool/.build，已被 .gitignore 忽略）
npm run model-tool:build

# 能力清单：不启动渲染进程
node tools/model-tool/cli.mjs capabilities

# 只读检查（USDZ / GLB 都走这条）
node tools/model-tool/cli.mjs inspect `
  --input (Join-Path $projectRoot 'public\assets\models\character\Alina_Ip_Animated.usdz') `
  --out (Join-Path $outRoot 'alina-inspect')

# 资产片段截图
node tools/model-tool/cli.mjs snapshot `
  --input (Join-Path $projectRoot 'public\assets\models\character\Alina_Ip_Animated.usdz') `
  --out (Join-Path $outRoot 'alina-shot') `
  --clip _359960820992_TempMotion --time 0.5 --yaw 0

# 真实游戏角色（程序化动作，不是资产片段）
node tools/model-tool/cli.mjs snapshot-game-character `
  --out (Join-Path $outRoot 'char') --action walk --angles 0,90,180,270

# 隔离 World 的真实 Rapier 碰撞体（不是玩家当前会话）
node tools/model-tool/cli.mjs collision-snapshot `
  --scene outdoor `
  --out (Join-Path $outRoot 'collision-snapshot') `
  --radius 10
```

每条命令都支持 `--help`，输出用途、参数、最小例子、产物与副作用。

## 3. 命令

| 命令 | 作用 | 主要参数 | 产物 |
| --- | --- | --- | --- |
| `capabilities` | 静态能力矩阵（不启动进程） | — | stdout JSON |
| `inspect` | 只读检查：网格、三角面、材质、贴图、骨骼、片段、依赖、包围盒 | `--input --out` | `report.json` |
| `snapshot` | 采样资产内片段某一时刻，固定相机出一张图 | `--input --out [--clip] [--time] [--yaw] [--width] [--height]` | `snapshot-<clip>-<yaw>deg.png` + `report.json` |
| `snapshot-game-character` | 真实 `CharacterRig` 驱动语义动作，带比例参照与多朝向诊断 | `--out [--action] [--time] [--yaw] [--angles] [--scale-reference]` | `character-<action>-<yaw>deg.png…` + `report.json` |
| `animation-edit` | 按秒裁剪、重命名片段；仅 LINEAR/STEP，CUBICSPLINE 明确拒绝；GLB 需显式确认才导出 | `--input --out --clip [--rename] [--start] [--end] [--write-glb] [--confirm-write]` | `report.json`，确认后另加派生 `.glb` |
| `retarget` | 两套骨架的映射候选、未匹配项、绑定姿态、比例、根运动；**只出映射报告，不导出动画** | `--source --target --out [--map]` | `report.json` |
| `collision` | 真实碰撞输入（布局 + 街区规划）绘制胶囊与静态盒 | `--out [--focus x,z]` | `collision-overview.png`、`collision-spawn.png`（`--focus` 另加一张）+ `report.json` |
| `collision-snapshot` | 隔离 World 中真实 `PhysicsRuntime/Rapier` Collider 快照；不是玩家会话 | `--scene outdoor\|indoor --out [--focus x,z] [--radius] [--width] [--height]` | `runtime-collision-overview.png`、`runtime-collision-closeup.png` + `report.json` |

所有路径必须是绝对路径；`--out` 必须位于当前项目目录的父目录内（父目录本身或其子目录）。工具从自身位置推导此范围，不同 worktree 的路径可能不同；实际写入仍受执行环境权限约束。输入模型可以读取此范围外的绝对路径，但不会在该输入目录写输出。参数按数组传给子进程，不拼 shell，空格与中文路径均可。

### 结果状态与可用性

- **命令结果**看顶层 `status`：`ok`（exit 0）表示任务完成且本次加载没有已知的资源失败；`partial`（exit 6）表示报告/截图已生成，但存在贴图或依赖加载失败、声明与运行时对不上、或资源无法确认；`error` 表示没有可用结果（不写 `report.json`，`outputs` 只列真实写出的文件）。
- **`inspect`**：`data.resourceIntegrity.status` 为 `complete` / `incomplete` / `unknown`。GLB 的声明数量来自只读解析 JSON chunk（`data.resources.declared.source = "glb-json"`）；`.gltf` 来自 JSON 与同目录依赖检查；USDZ 无清单，按 `unknown` 处理。缺失贴图、外部依赖、bufferView 越界、空几何都不会被写成“全部正常”。
- **`snapshot`**：贴图/资源加载失败或声明与运行时对不上时返回 `partial`；截图照常写出，报告 `data.resourceIntegrity.materialRisk` 为 `known` / `possible`，并明确“截图不能作为材质正确的证据”。USDZ 无清单时为 `unknown`，状态仍为 `ok`，但报告写明未逐项验证。
- **`animation-edit`**：加载阶段有资源请求失败时，只出计划不落盘；若同时给出 `--write-glb --confirm-write`，则拒绝导出（`EXPORT_RESOURCE_INCOMPLETE`，exit 5），避免产出丢失贴图/几何的派生资产。
- **`retarget`** 只做骨架映射，不产出资产，因此贴图缺失不影响其结论；零匹配返回 `NO_BONE_MATCHES`、`data.mappingUsability.status = "unusable"`。名称精确匹配与归一化候选只是线索，不是骨架兼容证明。
- 只读提示（`USDZ_READ_ONLY`、`AXES_UNDECLARED`）和参数夹取（如 `--time` 超出片段时长）不会单独把结果降级为 `partial`；只有影响任务结果完整性的失败才降级。
- **Agent 应采取的动作**：`ok` → 可以使用报告/截图，但仍不得据此宣称动作自然、性能达标或游戏内一致；`partial` → 先读 `data.resourceIntegrity.reasons` 与 `data.resources.failures/unknown`，不要把截图当材质证据，也不要从 `null` 推断“模型没有贴图”，修复资源后重跑；`error` → 没有报告，按 `diagnostics[].details` 与退出码排查，不要引用 `--out` 下的任何文件。

### collision-snapshot 报告

`data` 至少包含 `snapshotKind: "isolated-game-runtime"`、`scene`、`source: "PhysicsRuntime/Rapier"`、`collisionReady`、`layoutRevision`、`colliderCounts`、`colliders[]`、`character`、`bounds`、`camera`、`screenshots`、`unknownShapes`、`defaultMemoryFurniture`、`limitations`。每个 Collider 记录 `handle`、`role`、`shape`、世界 `position`/`rotation`，以及适用的 `halfExtents`/`radius`/`halfHeight`（不适用为 null）；`renderedAs` 记录实际绘制方式（`box` / `rounded-box` / `capsule` / null）。RoundCuboid 使用 `RoundedBoxGeometry` 按 border radius 绘制，不能当作普通盒。报告同时记录工具/Three.js/Rapier 版本、截图尺寸、焦点、近景半径，并明确“不是现有玩家会话的实时快照”。

## 4. 结果契约

stdout 只有一个 JSON envelope（`schemaVersion: 1`），日志走 stderr：

```json
{
  "schemaVersion": 1,
  "command": "inspect",
  "status": "ok",
  "inputs": { "input": "C:\\...\\Alina_Ip_Animated.usdz", "inputSha256": "9EE6...", "outDir": "C:\\tmp\\mt\\alina-inspect" },
  "outputs": [
    { "path": "C:\\tmp\\mt\\alina-inspect\\report.json", "type": "report", "sha256": null }
  ],
  "diagnostics": [
    { "code": "USDZ_READ_ONLY", "severity": "info", "message": "USDZ 仅用于读取与截图；本轮没有无损写回证明，导出能力未实现。" },
    { "code": "AXES_UNDECLARED", "severity": "info", "message": "资产未声明 up/forward 轴；工具不猜测坐标系，相关字段为 null" }
  ],
  "metadata": { "tool": "model-tool", "toolVersion": "0.1.0", "three": "186", "electron": "45.2.1", "rendererRuns": 1 },
  "data": { "format": "usdz", "geometry": { "meshes": 19, "triangles": 137650 }, "skeleton": { "bones": 101 }, "animations": { "count": 1 } }
}
```

- 退出码：`0` 成功、`2` 参数、`3` 不支持、`4` 输入/输出/权限、`5` 处理失败、`6` 结果不完整（partial）。
- **状态分层（重要）**：顶层 `status` 只表示命令/报告结果：`ok` = 报告生成且本次加载没有已知会使结果不完整的资源失败；`partial` = 报告已生成，但资源完整性或映射可用性不足/未知（exit 6）；`error` = 没有可用结果。具体业务判断看 `data.resourceIntegrity.status`（资源）与 `data.mappingUsability.status`（骨骼映射）。`partial` 不是动作可用或资源完整的证明。
- **`outputs` 只列实际写出的文件**：`report.json` 在本进程成功落盘后才追加；`error` 不写报告，也不把不存在的报告路径写进 `outputs`。报告写入失败时整体按 `error` 返回并给出 `REPORT_WRITE_FAILED`，不会声称成功。
- 截图的 `sha256` 来自主进程写文件时的实际字节；`report` 的 `sha256` 恒为 `null`（无法在自身内容里写入自身摘要）。
- `inspect` 的 `data.resources` 是资源账本：

  | 字段 | 含义 |
  | --- | --- |
  | `declared.source` | `glb-json` / `gltf-json` / `unavailable`；GLB 只读头 + JSON chunk，不复制模型字节 |
  | `declared.images` / `textures` / `materials` | 文件 JSON 里各数组长度；一张图片可被多个纹理、多个材质槽位引用，**不一一对应** |
  | `declared.invalidBufferViews` | 内嵌图片的 bufferView 越界/缺失数量（GLB，已校验 BIN 边界） |
  | `runtime.loadAttempts` / `loadFailures` | 本次经 `LoadingManager` 走完的请求数与失败数 |
  | `runtime.textureLoadAttempts` / `textureLoadFailures` | 按 URL 可识别类型归类的去重贴图/图片请求与失败数；未知类型不计入贴图 |
  | `runtime.textureObjects` / `texturesWithImage` | 材质实际引用的不同 `THREE.Texture` 数，以及其中真正带图片数据的数量 |
  | `runtime.materialTextureSlots` | 材质贴图槽位引用次数（同一纹理会重复计数） |
  | `failures[]` | 按类别（`model`/`texture`/`buffer`/`other`）聚合的失败：`count`、`attempted`、`samples` |
  | `notAttemptedImages` | 声明了但没有出现在加载请求中的图片数（可能未被材质引用） |
  | `materialRisk` | `none` / `possible` / `known` / `unknown`，快照是否可作为材质证据 |
  | `unknown` | 无法确认项的说明；`null` 表示未知，不是 0 |

  多张图片可以共用同一纹理对象，临时 `blob:` URL 每次运行都不同，不能当作稳定资源路径；失败样例无法可靠回指到图片索引（`unknown`）。`data:image/...` 按图片分类，`data:application/octet-stream` 和 `data:application/gltf-buffer` 按缓冲区分类，无法识别的 `data:` 类型归为 `other`；内联失败样例省略数据内容。URL 分类并不保证识别所有自定义资源类型。
- `inspect.data.textures` 为兼容保留，等于 `data.resources.runtime.textureObjects`（材质引用的不同 Texture 对象数），**不是**文件声明的图片数。
- 多次同类加载失败会聚合成**一条** `DEPENDENCY_LOAD_FAILED` 诊断，`details` 保留 `category`、`count`、`attempted` 与最多 8 个样例 URL；不会逐条刷屏，也不会静默丢弃数量。
- CSP 拦截会额外产生 `CSP_BLOCKED`（`details.directives`），用于区分“资源不存在/损坏”和“被工具页面策略拒绝”。
- `retarget` 的 `mappingUsability.status` 取 `unusable` / `unknown` / `manual-review-required`；名称匹配本身不等于骨架兼容。
- `inspect` 的 `resourceIntegrity.status` 取 `complete` / `incomplete` / `unknown`；缺失/外部/无法枚举的依赖不得写成“全部正常”。
- 未知值写 `null` 并给诊断，不写 `0` 冒充；`null` 不能推断成“模型没有贴图/没有资源”。
- 已存在的 `report.json` 会让命令在**启动渲染进程之前**失败（exit 4）。

## 5. 能力矩阵

| 格式 | 读取 | 截图 | 动作处理 | 写回 |
| --- | --- | --- | --- | --- |
| `.glb` | 实测（含 60 张内嵌 PNG/JPEG 贴图与 105 骨骼模型） | 实测（贴图正确显示） | 实测（裁剪/重命名/导出；仅 LINEAR/STEP，CUBICSPLINE 拒绝） | 实测：重新序列化 GLB，需 `--confirm-write`；加载有资源失败时拒绝导出 |
| `.gltf` + `.bin` + 贴图目录 | 实测（含中文路径、缺贴图诊断） | 已实现 | 已实现（仅 LINEAR/STEP，CUBICSPLINE 拒绝） | 已实现（导出 GLB） |
| `.usdz`（内嵌二进制 USDC） | 实测 | 实测（真实 GPU） | 明确不支持 | **明确不支持**，无无损写回证明 |

「已实现」= 代码与类型检查通过、但本轮没有单独实跑；「实测」= 见第 8 节运行记录。USDZ 的资源声明数量未枚举，报告为 `unknown`；外部贴图（`.gltf` 引用同目录图片）只有缺失路径的实测，完整加载未单独验证。

## 6. 安全与数据路径

- 渲染进程：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true`，preload 只暴露两个通道（提交结果、写输出目录内的新文件）。
- 资源访问：只注册一个 `modeltool://` 协议。`app` 主机映射 `.build` 与 `public/assets`；`input` 主机映射**模型所在目录**。逐段拒绝 `..`、盘符、空段，再 `realpath` 校验，越界返回 404。
- 网络：页面 CSP `default-src 'none'`，`connect-src` 只含自身协议、`data:` 与 `blob:`；工具不发任何网络请求，不下载依赖。
  `blob:` 是给 GLB 内嵌图片用的：`GLTFLoader` 把 bufferView 图片转成 `blob:` URL，再用 `ImageBitmapLoader` 通过 `fetch` 读取；`connect-src` 缺少 `blob:` 会让全部内嵌贴图加载失败（2026-11-01 实测）。
- CSP 对 `script-src` 增加 `'wasm-unsafe-eval'`：Rapier 0.21 在渲染页初始化 WASM；不接受其他脚本来源。该例外只用于工具页面，不进入正式游戏页面。
- 输出：`--out` 必须位于当前项目目录的父目录内；在创建目录前校验最近已存在父目录的真实路径，创建后再次校验；拒绝 `..`、该范围外路径、符号链接/junction 越界。执行环境可能进一步限制可写范围。`report.json` 已存在即失败；单个产物已存在即拒绝覆盖；写文件走 `flag: 'wx'`。
- 隔离：进程独立 `userData`（临时目录），无单实例锁；超时只按自身 PID 树终止；临时目录用完即删。
- 不读取、不写入游戏存档与玩家目录。`collision-snapshot` 只新增 `PhysicsRuntime`/`World` 的只读快照方法与独立 World 实例；不修改物理计算、业务规则或存档。正式安装包不暴露工具入口。

## 7. 实现结构

```text
tools/model-tool/
  cli.mjs              参数、路径校验、envelope、退出码
  lib/schema.mjs       envelope + 诊断 + 退出码（唯一来源）
  lib/paths.mjs        绝对路径、真实路径、禁越界、禁覆盖
  lib/glb.mjs          只读 GLB 头 + JSON chunk，得到声明资源（不读 BIN、不复制模型）
  lib/contract.mjs     CLI ↔ 主进程 ↔ 渲染页的形状校验
  lib/runner.mjs       一次性 Electron 子进程、超时、清理
  runner/main.cjs      协议白名单、隐藏窗口、写文件、收结果
  runner/preload.cjs   2 条窄通道
  renderer/api.ts      任务共享类型 + 相机/统计工具
  renderer/resources.ts 资源账本：声明/成功/失败/未知、失败聚合、materialRisk
  renderer/load.ts     GLB/glTF/USDZ 加载与失败计数
  renderer/inspect.ts  只读检查
  renderer/render.ts   资产片段截图
  renderer/animation.ts 裁剪/重命名/GLB 导出（C）
  renderer/retarget.ts  骨架映射报告（C）
  adapters/game-character.ts 真实 CharacterRig + 比例参照（B）
  adapters/game-collision.ts 真实碰撞输入可视化（D）
  adapters/runtime-collision.ts 隔离 World 的真实 Rapier Collider 快照（D）
  vite.config.mjs      独立构建到 .build/
  tsconfig.json        工具独立类型检查
```

工具不进入游戏产物：`vite.config.mjs` 单独构建，`dist/` 与安装包不含 `tools/`。

## 8. 本机运行记录（11 次历史渲染记录 + 2026-11-01 的 3 次贴图修复运行；0 次游戏启动）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `inspect` Alina USDZ | 19 网格 / 137,650 三角面 / 101 骨骼 / 1 片段 / 35 贴图，5.7 s |
| 2 | `inspect` Casual_Male.glb | 6 网格 / 6,492 三角面 / 23 骨骼 / 17 片段，0.38 s |
| 3 | `snapshot` Alina 片段 t=0.5 s | RTX 5070 / ANGLE D3D11，PNG 真实成像 |
| 4 | `snapshot-game-character walk` 0°/90° | 真实 rig，身高 1.78 m，脚底 −0.0015 m，朝向一致 |
| 5 | `collision` | 51 盒（6 建筑 + 44 街区 + 1 地面），胶囊 0.42/1.78 |
| 6 | `animation-edit` Walk 0.2–0.8 s | 1.25 s → 0.6 s，69 轨保留、138 端点补帧，导出 GLB 511,676 B（glTF v2，1 条 0.6 s 动画） |
| 7 | `inspect` 中文路径 + 缺贴图 gltf | 路径正常，`MISSING_DEPENDENCY` 指向 `textures/dining_chair_02_nor_gl_1k.jpg` |
| 8 | `collision`（可读性修正后） | 51 盒 / 无退化盒，总览 10 m 网格 + 出生点 12 m 近景，胶囊按真实 0.42×1.78 绘制 |
| 9 | `retarget` Casual_Male.glb → Alina_Ip_Animated.usdz | 23 源骨骼 / 101 目标骨骼；映射 0、源未匹配 23、目标未匹配 101（含全部 `n*`），未编造匹配；比例 1.8794 m → 0.6005 m（ratio 0.3195）警告；仅报告，`exportSupported: false`，0.76 s |
| 10 | `collision-snapshot --scene outdoor` | 52 Collider（52 快照 / 52 运行时；51 static + 1 character）；人物 capsule radius 0.42、halfHeight 0.47、height 1.78、foot (0,0,6)、grounded true；bounds ±55、edgeMargin 1.5、layoutRevision 0；1280×800；两张 PNG + report.json |
| 11 | `collision-snapshot --scene indoor` | 31 Collider（31 快照 / 31 运行时；30 static + 1 character）；人物 capsule radius 0.30、halfHeight 0.59、height 1.78、foot (2.1,0,2.2)、grounded true；bounds x 0.08–3.22 / z 0.08–6.12、edgeMargin 0.42、layoutRevision 0；默认内存家具布局；两张 PNG + report.json |

> 第 1/2/7 次 `inspect` 生成于资源完整性状态修复之前；修复后 USDZ 的资源数量为 `unknown`、缺贴图 glTF 为 `incomplete`（partial/exit 6）。2026-11-01 起 GLB 会只读解析 JSON chunk，资源可核对且无失败时为 `complete`；USDZ 仍为 `unknown`。

> 第 9 次报告生成于状态修复之前，原文顶层为 `status: ok`（旧行为）。本轮没有启动 Electron 重新生成；修复后的代码会在零匹配时返回 `partial`、`NO_BONE_MATCHES`、`mappingUsability.status=unusable`，此路径已做静态检查，未重新实跑。

> `collision-snapshot` 的第一次进程因工具 CSP `script-src 'self'` 阻止 Rapier WASM 编译而失败（exit 5）；补上 `'wasm-unsafe-eval'` 后第二次室外进程成功。第 10 次室外报告生成于 RoundCuboid 绘制修正之前，Collider 数据仍有效但没有 `renderedAs` 字段；第 11 次室内进程在修正后成功，包含 `renderedAs`。按追加预算没有再启动第四次。快照来自隔离 World，不是玩家当前会话。

### 2026-11-01：GLB 内嵌贴图修复（3 次渲染进程，0 次游戏启动）

| # | 命令 | 结果 |
| --- | --- | --- |
| A | `inspect` apet.glb（计数修正前） | exit 6 / partial。贴图已全部加载成功（60 个带图纹理），但 `LoadingManager.onStart` 只记录到主文件请求，账本误报“60 张声明图片未尝试加载”。该次输出已删除：它有会计数错误，不能作为证据。 |
| B | `inspect` apet.glb | exit 0 / **ok**。声明 60 图片（47 PNG + 13 JPEG）/60 纹理/25 材质；请求 61（1 模型 + 60 贴图），失败 0；`textureObjects=60`、`texturesWithImage=60`、`materialTextureSlots=85`；105 骨骼、1 片段；1.47 s |
| C | `snapshot` apet.glb `--clip Calibration --time 1 --yaw 0` | exit 0 / **ok**。800×1000 PNG（124,340 B，sha256 `C197FF79…D0AEFC`）；角色贴图可见（红格衬衫、破洞牛仔裤、红鞋）；60 贴图全部带图；7.68 s |

- 根因证据链：历史失败 URL 全是 `blob:`；three r186 的 `GLTFLoader` 用 `ImageBitmapLoader`（`fetch`）读取 bufferView 图片，`fetch` 受 `connect-src` 约束；当时 `connect-src` 只有 `'self' modeltool: data:`。两次运行之间唯一涉及的加载路径改动是补上 `blob:`，失败数 60 → 0、带图纹理 0 → 60、截图从全灰变为完整材质。历史运行没有 CSP 监听器，因此没有留下 Chromium 的拒绝文本；本次新增的 `CSP_BLOCKED` 诊断用于以后直接记录 `violatedDirective`。
- 静态图片结构检查（不启动渲染进程）：60 张图片的 PNG chunk 链完整走到 IEND、13 张 JPEG 以 EOI 结束，没有截断；因此剩余失败不能用手头样例解释为“图片本身损坏”。
- 后续使用独立 glTF 缺失贴图样例实跑 `snapshot`：返回 `partial` / exit 6，报告指出贴图失败，截图仅用于排查。该样例还包含 `data:application/octet-stream` 缓冲区；修正分类后贴图请求为 1、失败为 1，外部图片诊断不再附带无关的 blob 提示。

不消耗渲染进程的验证：`capabilities`、5 条 `--help`、相对路径 exit 2、未知命令 exit 2、不支持扩展名 exit 3、输出碰撞 exit 4、输入缺失 exit 4。

CUBICSPLINE 局部验证：使用内嵌 CUBICSPLINE sampler 的最小 glTF 执行 `animation-edit`，返回 `status: error`、`CUBICSPLINE_UNSUPPORTED`、exit 3；输出目录没有派生 GLB。该命令只加载模型并检测，不创建 WebGL 帧；不计入上述截图渲染记录。

路径边界局部验证（不启动渲染）：在 game2 内临时目录确认授权根与子目录可创建；工作区外路径、`..` 越界在创建前返回 `OUT_OUTSIDE_WORKSPACE`；指向工作区外的 junction 被拒绝且未创建目标；已有文件写入返回 `OUTPUT_EXISTS` 且内容不变。测试目录已清理，保留第 9 次 retarget、第 10 次室外与第 11 次室内的正式输出目录。

## 9. 已知限制与未验证项

限制：

- `snapshot` 只采样资产内片段；**不能**预览或证明游戏内程序化 walk/run/jump。B 包的命令才是真实 `CharacterRig` 路径。
- `animation-edit` 只支持 LINEAR / STEP 轨道。GLTFLoader 的 CUBICSPLINE 使用自定义 interpolant，当前没有正确裁剪实现，遇到即返回 `CUBICSPLINE_UNSUPPORTED`（exit 3），不生成派生 GLB；Smooth/Bezier/未知自定义插值同样拒绝，不会退化为线性。
- 导出的 GLB 是重新序列化，不保证与源文件逐字节或所有扩展无损；材质/扩展的损失风险由报告与限制说明承担。
- USDZ 只读：材质由 three 的 `USDComposer` 还原，与 Sketchfab 或游戏内观感可能不同，报告只声称「Three.js 内一致」。
- 单张截图不能证明动作自然、性能达标或物理正确。
- `collision` 是**按初始布局重建**的室外碰撞输入，不是运行中 Rapier 世界的完整快照：不含会话内街区抑制、室内结构、家具或运行时变化。近景固定以出生点为中心、12 m 半径取景，胶囊约占画面高度 7%；后续方向是把近景范围变成显式参数、保留总览，并把参数写进报告以保证截图可复现，本轮不实现该参数。
- `collision-snapshot` 才是运行时快照：在隔离工具进程中独立创建 World，读取实际 Rapier Collider；不连接现有游戏、不读取存档，**不是玩家当前游戏会话**。室内快照使用默认内存家具布局，不是玩家存档布置。未知/未支持形状只列报告并警告，不绘制替代盒子；RoundCuboid 用 `RoundedBoxGeometry` 按 border radius 绘制，不按普通盒处理；Collider handle 不是跨运行稳定 ID。本轮室外与室内均已跑。
- `retarget` 当前只生成骨骼映射报告（候选、未匹配、不确定项），不生成可播放的目标动作；不会为 Alina 的 `n*` 骨骼编造自动匹配。自动映射仅「同名精确匹配」与「归一化猜测（需确认）」，不猜几何。动作套用未完成。零匹配为 `unusable`，关键骨骼未匹配/未知必须人工处理。
- `inspect` 的 `resourceIntegrity` 只描述本次实际能检查的资源：缺失/失败为 `incomplete`，外部/未枚举依赖为 `unknown`；这两类都返回 `partial`（exit 6），不得简写成“全部正常”。GLB 会只读解析 JSON chunk 得到声明数量（不读 BIN、不复制模型字节）；JSON chunk 解析失败时退回 `unavailable` 而不是猜数字。`.gltf` 的 bufferView 边界仍未校验（`unknown`），USDZ 不枚举资源（`unknown`）。

未验证（实现完成、本轮未实跑）：

- `retarget` 的动作导出/可播放动作套用：当前根本没有实现，只有映射报告（第 9 次运行已验证报告）。`n*` 目标骨骼不会被自动编造匹配。
- `animation-edit` 的 `EXPORT_RESOURCE_INCOMPLETE` 拒绝路径（加载失败时拒绝写派生 GLB）只有代码审查。
- `.gltf` 的 `snapshot` 已在缺失外部贴图样例实跑；完整外部贴图尚未验证。`snapshot` 不解析 `.gltf` JSON，声明数量在快照报告里为 `unknown`。
- `.gltf` 引用同目录外部贴图的**成功**加载：只验证过缺失路径（第 7 次），完整外部贴图未实测。
- `blob:`/`data:` 之外的图片加载失败原因分类（例如解码失败）没有单独样例；`CSP_BLOCKED` 诊断在修复后没有再次触发，缺少一次“被拦截”的实跑记录。
- 坏文件（非 GLB 字节流）的实际错误文案；扩展名与路径类错误已验证。
- `collision-snapshot` 室内场景：已跑（第三次进程）；默认内存家具布局的实际碰撞体、进入流程和清理通过。RoundCuboid 的真实圆角绘制只做了代码/构建检查，当前室外/室内样例没有 round-cuboid，未获得视觉样例。
- `collision-snapshot` 的“返回快照是副本、不推进物理”目前只有代码审查；没有再启动 Electron 做重复调用验证。
- `MODEL_TOOL_SOFTWARE_GL=1`（SwiftShader 回退分支）。
- 连续转向过程；`snapshot-game-character` 只做了 0°/90° 两个静态朝向。
- CUBICSPLINE 之外的 Smooth/Bezier 轨道只做了代码级拒绝路径检查，未逐一构造样例渲染；它们同样不属于支持范围。

## 10. 维护

- 改动 CLI 参数或结果字段时同步更新本文件与 `docs/model-tool-architecture.md` §4/§5。
- 资源账本（`data.resources`）口径变更必须同时改文档：`declared` 与 `runtime` 不是一个数字，`null` 不是 0。
- 新增格式支持前先证明「读取 / 截图 / 处理 / 写回」四项各自的真实状态，不得只测一项就宣称整格式可用。
- 构建命令统一使用 `npm run model-tool:build`；不要依赖临时 `npx` 命令。
- 降级规则按「是否影响结果完整性」判断：只读提示、时间夹取不降级；贴图/缓冲加载失败、声明与运行时对不上要降级为 `partial`。
