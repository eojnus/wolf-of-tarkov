# 无头模型工具

本工具供 Agent 非交互地检查 GLB、glTF、USDZ 资产，生成机器可读报告和截图，并辅助检查游戏角色动作与碰撞。它使用独立 Electron 进程，不启动正式游戏、不访问玩家存档。

## 开始

在项目根目录执行：

```powershell
npm run model-tool:build
node tools/model-tool/cli.mjs capabilities

$projectRoot = (Get-Location).Path
$outRoot = Join-Path (Split-Path -Parent $projectRoot) 'model-tool-out'
$model = Join-Path $projectRoot 'public\assets\models\character\Alina_Ip_Animated.usdz'

# 检查资产：网格、材质、骨骼、动画、尺寸与资源
node tools/model-tool/cli.mjs inspect --input $model --out (Join-Path $outRoot 'inspect')

# 截取资产自带动画的一个时间点
node tools/model-tool/cli.mjs snapshot --input $model --out (Join-Path $outRoot 'asset-shot') --clip _359960820992_TempMotion --time 0.5 --yaw 0

# 检查游戏角色的程序化行走与四个静态朝向
node tools/model-tool/cli.mjs snapshot-game-character --out (Join-Path $outRoot 'character') --action walk --time 0.5 --angles 0,90,180,270

# 检查走路时的连续转向
node tools/model-tool/cli.mjs snapshot-game-character --out (Join-Path $outRoot 'turn') --action walk --time 0.5 --turn-from 0 --turn-to 180 --turn-duration 1 --turn-samples 0,0.25,0.5,0.75,1

# 查看隔离世界中的实际 Rapier 碰撞体
node tools/model-tool/cli.mjs collision-snapshot --scene outdoor --out (Join-Path $outRoot 'collision') --radius 10
```

每条命令支持 `--help`。输入和输出必须是绝对路径；`--out` 必须位于当前项目目录的父目录或其子目录，实际写入仍受运行环境权限约束。每次使用新的输出目录：工具不会覆盖已有产物。输入资产只读；导出派生文件须获得任务授权。

除 `capabilities` 和 `--help` 外，每次命令启动一个独立 Electron 工具进程，遵守用户的启动预算。工具源码更新后重新构建工具渲染页。

## 命令

| 命令 | 用途 | 主要输出 |
| --- | --- | --- |
| `capabilities` | 查看格式和功能状态 | JSON，不启动渲染进程 |
| `inspect` | 检查网格、材质、贴图、骨骼、动画和依赖 | `report.json` |
| `snapshot` | 按片段、时间和朝向截取资产自身姿态 | PNG 和报告 |
| `snapshot-game-character` | 检查实际 `CharacterRig` 的程序化动作、静态朝向或连续转向 | PNG 和报告 |
| `animation-edit` | 对支持的动画片段裁剪或重命名；输出派生 GLB 需显式确认 | 计划报告，可选派生 GLB |
| `retarget` | 报告两套骨架的映射候选和风险 | 仅报告，不生成可播放动作 |
| `collision` | 查看基于初始布局重建的室外碰撞输入 | 总览、近景和报告 |
| `collision-snapshot` | 查看隔离 World 的真实 Rapier Collider；`--self-check` 检查圆角盒和快照只读性 | PNG 和报告 |

静态角色模式使用 `--yaw` 或 `--angles`；连续转向模式必须同时提供 `--turn-from`、`--turn-to`、`--turn-duration` 和 `--turn-samples`，不能与静态朝向参数同时使用。`--time` 在连续模式下表示转向前的动作预热秒数。

## 如何读取结果

标准输出是单个 JSON，进度和日志写入 stderr。查看顶层 `status`、`diagnostics`、`outputs` 和命令对应的 `data`：

- `ok` / 退出码 0：命令完成；不代表所有资产特性、动作手感或性能已验证。
- `partial` / 退出码 6：结果存在，但有关信息不完整或有已知失败。读取诊断与原因，不能把它当作完整通过。
- `error`：任务未完成；根据诊断和退出码排查。`outputs` 只列实际写出的文件。其他退出码：2 参数错误、3 不支持、4 路径或权限错误、5 处理失败。

`inspect` 和 `snapshot` 的 `data.resources` 区分文件声明（`declared`）、本次加载（`runtime`）、失败（`failures`）与未知项；图片数、纹理对象数和材质槽位数并不必然相等。`null` 表示未知，不是 0。检查 `data.resourceIntegrity` 和资源诊断：贴图加载失败时即使生成了 PNG，也只能用于排查，不能证明材质正确。USDZ 未逐项枚举资源，`snapshot` 可能返回 `ok`，仍需看完整性字段。

## 角色朝向和碰撞

静态多朝向为每个 yaw 重置角色、设置朝向并独立重演相同动作时间；不是把同一姿态简单旋转。报告保留骨骼方向向量，并使用相对角色根的完整骨骼四元数比较姿态，包括绕方向轴的扭转。`orientation.consistent` 为 `false` 表示发现超出容差的旋转差异，`null` 表示不足以判断；缺失骨骼不会被当成通过。

连续转向每帧先设置 yaw、再推进真实 `CharacterRig`。采样时间按请求区间比例映射到 1/60 秒的帧，报告同时列出请求时间、实际时间和帧号；极短时长的终点会映射到最后一帧，实际时间可能超过请求时长。重复帧只截图一次。零预热时第 0 帧是初始姿态，第一步仍会接收起跳或落地事件。静态和连续模拟都不能代替游戏实际输入、动作手感或性能验收。

`collision-snapshot` 创建隔离 World，返回真实 Rapier 碰撞体的副本；它不是玩家当前会话，室内使用默认内存家具布局。未支持形状只报告、不用盒子冒充。Collider handle 只在本次运行内有效。截图可能被真实的大型碰撞盒遮挡。

## 格式和限制

- GLB：支持读取、截图和受限的 LINEAR/STEP 动画裁剪；写出是重新序列化，不能保证无损。
- glTF：支持读取和截图；相对依赖必须在模型目录内。外部贴图只验证过本地最小样例，复杂扩展和所有资源组合并未验证。
- USDZ：只读和截图，不支持编辑或写回；资源清单不完整时会明确标注未知。
- CUBICSPLINE、Smooth/Bezier 和未知自定义插值不支持动画编辑；跨模型动作套用和导出未实现。
- 不下载远程资源，不提供任意系统命令，不为了加载模型关闭 Electron 安全隔离。

详细接口和架构见 `docs/model-tool-architecture.md`；功能需求和讨论见 `docs/model-tools.md`。工具能力与当前限制以 `capabilities`、本说明及实际报告共同判断。
