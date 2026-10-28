# 晴川公寓首套室内与基础家具 — 交付报告

日期：2026-10-28（香港时间）
分支：`feature/qingchuan-apartment-interior`
状态：实现完成，构建通过，等待 GPT Work 审查与用户确认；**未合并 main**。

本报告只描述本次实际交付。策划原文的个人生活与城市玩法 §1–3、§6 由用户提供给 GPT Work；本 Agent 仅按 `docs/qingchuan-apartment-task.md` 实施，未自行扩写玩法范围，也不把本报告当作最终验收结论。

## 1. Git 与提交

| 项目 | 值 |
| --- | --- |
| 唯一开发目录 | `C:\Coding\wolf-qingchuan-apartment-interior` |
| 分支 | `feature/qingchuan-apartment-interior` |
| 开发基点 | `dea681b74d8fed03551b8f731fb4827354f354c6` |
| 上一阶段提交 | `ec9e14b`（任务书）、`f9987a5`（阶段一技能授权） |
| 本任务实现提交 | `32a2886f23c1b53e234a2c47d6c218017271b06c` `feat: add Qingchuan apartment interior with real furniture` |
| 报告提交 | 本文件与截图单独提交，见交付消息中的 `git log` |
| main | 未合并、未 rebase、未推送 |

实现提交相对上一阶段 `f9987a5`：**33 files changed, 2,030 insertions(+), 28 deletions(-)**（不含本报告与截图）。四件模型、代码与三份文档在同一提交内，便于整体审查；卫浴门净宽与床品配色的最终微调已 amend 进该提交。

## 2. 修改文件

| 层 | 文件 | 变更 | 职责 |
| --- | --- | --- | --- |
| 配置 | `src/content/interior.ts` | 新增 119 行 | 房间尺寸、洞口、家具摆位/footprint、出生与离开点、相机、碰撞半径、资产清单 |
| 表现 | `src/world/interiors/qingchuan.ts` | 新增 587 行 | 壳体、玄关、卫浴、厨房、软装、四类 GLTF、室内碰撞/遮挡、`dispose` |
| 会话 | `src/world/world.ts` | +298 / −16 | `outdoor → loading → indoor`、场景挂载、相机切换、存档快照、代次与释放 |
| 协调 | `src/app/game.ts` | +108 / −5 | 入口权限复核、加载锁、F 进出、读档/新游戏失效、提示 |
| 移动 | `src/world/player.ts` | +7 / −5 | `edgeMargin` 与 `collisionRadius` 可选参数，默认值不变 |
| UI | `src/ui/estate-panel.ts` | +13 | 住宅现场页「进入个人住宅」按钮（`data-action="enter-home"`） |
| 视图 | `src/app/real-estate-view.ts` | +7 | `canEnterResidence` 只读字段 |
| UI | `src/ui/panels.ts` | +5 | 入口接线 |
| UI | `src/ui/hud.ts` | +8 / −2 | 提示动词 `verb`，门口显示「离开」 |
| 资产 | `public/assets/models/interiors/qingchuan/**` | 新增 20 文件 | 四件 Poly Haven 1K glTF + bin + 贴图 |
| 文档 | `public/assets/SOURCES.md` | +40 | 四件模型许可与真实统计台账 |
| 文档 | `docs/architecture.md` | +66 | §17 室内会话、碰撞与资源 |
| 文档 | `docs/contracts.md` | +73 | §二十九 室内会话契约 |
| 文档 | `docs/decisions.md` | +47 | D91–D94 |

未改动 `core/`、`features/`、`timeAdvance`、月结、房地产成交/产权、`SAVE.formatVersion`（仍为 19）、迁移链、城市模板与楼体工厂。

## 3. 布局尺寸与通道

房间外壳 **3.3 m（X）× 6.2 m（Z）× 2.55 m（Y）**，墙厚 0.08 m，名义占地约 20.5 ㎡、墙内净面积约 19.0 ㎡。X 向右、Z 向南；北侧入户、南侧窗。

| 区域 | 范围 | 内容 |
| --- | --- | --- |
| 玄关 | z 0.08–0.9 | 东侧鞋柜（0.42 × 0.86 × 0.7，碰撞高 0.9） |
| 卫浴 | x 0–1.5，z 0.9–2.4 | 淋浴（玻璃隔断）、马桶、洗手台；推拉门全开贴北段墙，不做门动画 |
| 走廊 | x 1.54–2.66，z 0.9–2.4 | 净宽 **1.12 m** |
| 厨房 | x 2.66–3.22，z 0.9–2.4 | 冰箱位、下柜/台面、水槽、双灶、油烟机、吊柜 |
| 卧室兼起居 | z 2.4–6.2 | 单人床、书桌、椅、紧凑沙发、绿植、床头柜、地毯 |

洞口（只用于壳体与提示，不参与业务判定）：

| 洞口 | 尺寸 | 说明 |
| --- | --- | --- |
| 入户门 | x 1.26–2.06（0.8 m），高 2.1 | 视觉门洞；离开由门口 F 触发，不要求人物穿门 |
| 南窗 | x 0.7–2.6，y 0.5–2.1 | 双层窗框 + 简化都市背景，不二次渲染城市 |
| 卫浴门 | z 1.35–2.3（**0.95 m**），高 2.05 | 推拉门宽 0.42 全开贴北侧墙段；门洞净宽按 0.95 m |

家具摆位（尺寸为实测原始包围盒，未缩放）：

| 家具 | assetId | 位置 (x, z) | rotationY | footprint 宽 × 深 |
| --- | --- | --- | --- | --- |
| 单人床 | `polyhaven.old-bed-frame` | (0.5075, 4.14) | 0 | 0.905 × 2.0 |
| 紧凑沙发 | `polyhaven.sofa-01` | (2.42, 5.79) | π | 1.571 × 0.658 |
| 书桌 | `polyhaven.wooden-table-02` | (2.907, 3.35) | π/2 | 0.706 × 1.134 |
| 椅子 | `polyhaven.dining-chair-02` | (2.2, 3.35) | π/2 | 0.576 × 0.434 |

关键净宽：

- 走廊 **1.12 m**（卫浴墙内面 x 1.54 到厨房柜 x 2.66）。
- 床东缘 x 0.96 到椅西缘 x 1.912，**0.95 m**；人物碰撞半径 0.3 m 时可通行，左右各余约 0.17 m。
- 卫浴门 **0.95 m**；入户门 0.8 m 仅作视觉/出口，不承担日常通行。
- 人物边界余量室内取 `PLAYER.radius = 0.42`，碰撞半径取 `INTERIOR.player.collisionRadius = 0.3`；室外默认仍是 0.42 / 1.5，未全局缩小人物。

出入与镜头：

| 参数 | 值 |
| --- | --- |
| 出生点 | (2.1, 2.2)，面向 +Z（室内）；距离开触发圈约 1.5 m |
| 离开触发 | 门口 (1.66, 0.72)，半径 0.62 m |
| FOV / 近远 | 52° / 0.05 / 40 |
| 跟随距离 | 默认 2.8 m，滚轮 1.4–4.2 m |
| 俯仰 | 默认 0.3，范围 −0.08–1.0 |
| 遮挡 | 命中面前 0.14 m，硬下限 0.35 m；Y 夹在 0.3–2.43 m |
| 贴墙 | 距离 < 1.5 m 隐藏人物，离开后恢复 |

进入第一帧相机位于人物背后（`spawnYaw = π`），北墙会把镜头压到约 2 m，人物显得较大；向前走一步即恢复到 2.8 m。这是 20 ㎡房间 + 近距第三人称的取舍，不是穿墙。

## 4. 进入、退出与权限

- 唯一入口是原住宅 F 菜单里的「进入个人住宅」按钮；原菜单、休息与房地产栏目全部保留。
- 点击时 `Game.enterResidence()` 重新核对：住宅面板仍打开、World 在室外且没有切换中、附近建筑 `interactionId === 'home'` 且 `id === 'home'`、`freeResidenceOf()` 返回 `kind === 'home'` 且 `id === 'home-001'`、`buildingId === 'home'`。
- 不以 `owner.kind === 'player'`、净资产或房价判断居住权；进入不产生交易、扣费、房租或资产登记。
- 加载完成、提交切换前，`World.enterInterior(validate?)` 再调用一次 app 校验；返回 false 时释放场景、回到室外并返回失败原因。
- 加载中保持室外画面，锁人物移动与重复进入，**不暂停经济**。
- 室内按 F：只有 `canExitInterior()`（门口半径内）才离开；其它位置提示「走到门口再按 F 离开住宅」。
- 退出恢复进入前的室外位置、朝向、相机与人物可见性；不重建 Game、Store、Player、renderer 或角色。

## 5. 存档与返回

- 进入前记录当前室外 `WorldSaveData`（人物、相机、revision）。
- `loading/indoor` 期间 `getSaveData()` 一律返回该快照，手动保存、自动保存与导出都落在楼外。
- 不新增 `world.location/residenceId`；不改 `SAVE.formatVersion = 19`、`WorldSaveData` 结构或迁移链；不改产权、资金、背包。
- 读档与 `startNewGame()` 在 `store.replace` 之前调用 `world.cancelInterior()` 并清 `interiorLoading`；`World.restore()` / `resetToSpawn()` / `dispose()` 也会再失效一次。
- 室内不推进时间、不触发月结/休息/睡眠；经济仍由原 RAF 的 `advanceGameTime` 按自然时间推进，因此进出前后余额不会被人为冻结。

## 6. 资源生命周期

- 室内模块只在点击进入后 `await import('./interiors/qingchuan')`；启动、靠近与打开菜单都不预加载。
- 四件 GLB 全部成功后才原子切换；任一失败时释放半成品并抛出，World 回到 `outdoor`、清空回归快照，app 提示失败并允许重试。**不用方块或占位几何顶替。**
- 室内使用独立 `THREE.Scene`；`render()` 在室内只渲染该场景，不渲染城市，也不调用 `environment.followCamera()`。城市 GPU 资源保持驻留，退出无需重建。
- 退出/取消时遍历室内场景，用 `Set` 去重释放 geometry / material / texture；灯光只移除。不触碰 `player.group`、城市楼体工厂或 renderer。
- `interiorGeneration` 标记会话代次；读档、新游戏、取消与销毁都会递增，迟到的加载结果在 `enterInterior` 内就地释放。
- `isCollisionReady()` 在室内恒为 `true`，城市后台楼体加载不会锁住室内移动。

## 7. 四类模型与许可

全部来自 **Poly Haven**，**CC0 1.0**，2026-10-28 核查。详细台账（作品页、作者、下载路径、贴图、许可原文链接、处理方式）在 [`public/assets/SOURCES.md`](../public/assets/SOURCES.md) 的「晴川公寓室内家具」一节。

| assetId | 模型 | 作者 | 顶点 | 三角面 | 材质 | 贴图 | 体积（KiB） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `polyhaven.old-bed-frame` | Old Bed Frame | Luca B | 35,560 | 49,990 | 1 | 3 × 1024² | 3,947 |
| `polyhaven.sofa-01` | Sofa 01 | Kirill Sannikov | 2,708 | 4,101 | 1 | 3 × 1024² | 506 |
| `polyhaven.wooden-table-02` | Wooden Table 02 | Serhii Khromov | 200 | 196 | 1 | 3 × 1024² | 474 |
| `polyhaven.dining-chair-02` | Dining Chair 02 | James Ray Cock | 12,891 | 22,013 | 1 | 3 × 1024² | 900 |

- 合计 **20 个文件 / 5,965,954 字节（5.69 MiB）**；12 张 1024×1024 JPEG，4 个材质。
- glTF 1K 包原样使用；仅把 `.gltf` / `.bin` 重命名为稳定 id 并同步 `buffers[].uri`，**未减面、未缩放、未改材质**，贴图保留相对路径。
- 每件模型 1 节点 / 1 mesh / 1 primitive；baseColor + normal + metallicRoughness（ARM）。
- 未引入 4K/8K、KTX2/Draco 或新依赖；沿用既有 `GLTFLoader`。
- 朝向按顶点实测（床头/靠背在模型 −Z）决定旋转：床 0、沙发 π、桌/椅 π/2，不靠缩略图目测。
- 床头软包、被/枕/床尾毯是室内表现层的补充软装，不冒充家具模型；四类家具本身全部是上述真实 GLB。

## 8. 验证结果

### 8.1 构建与类型检查

`npm run build`（内含 `tsc --noEmit`）最终一次通过：

```
140 modules transformed.
dist/index.html                        1.12 kB │ gzip:   0.56 kB
dist/bundle/index-DeNzgaF-.css        34.41 kB │ gzip:   7.25 kB
dist/bundle/qingchuan-yEK6qxRs.js      9.27 kB │ gzip:   3.78 kB
dist/bundle/index-DhG3KyH0.js      1,333.61 kB │ gzip: 375.64 kB
built in 615ms
```

Vite 仍提示主包超过 500 kB，这是本轮之前就存在的大包警告，不是本次引入；室内模块被拆成独立的 9.27 kB 按需 chunk。

### 8.2 运行检查（headless）

用 Edge headless + SwiftShader（1280×800）加载临时预览入口，直接驱动 `World`：等待城市碰撞就绪、`enterInterior()`、`player.restore()` 到指定站位、渲染后截图；退出用例调用 `World.exitInterior()` 后再次截图。临时预览文件已删除，未进入提交。

截图（`docs/qingchuan-apartment-shots/`）：

| 图 | 站位 | 画面 |
| --- | --- | --- |
| [spawn.png](qingchuan-apartment-shots/spawn.png) | (2.1, 2.2) 面向 +Z | 入户第一帧，左侧厨房/灶台，右侧玄关与卫浴墙，尽头南窗 |
| [corridor.png](qingchuan-apartment-shots/corridor.png) | (2.05, 2.7) | 走廊向南，厨房台面、桌椅、窗与绿植 |
| [living.png](qingchuan-apartment-shots/living.png) | (1.7, 3.9) | 起居区中段，桌/椅/沙发，镜头被近墙部分遮挡 |
| [south-window.png](qingchuan-apartment-shots/south-window.png) | (1.6, 5.1) 面向北 | 回望南窗、沙发与床，可见真实模型与软装 |
| [exit-outdoor.png](qingchuan-apartment-shots/exit-outdoor.png) | 同门口站位后退出 | 调用 `exitInterior()` 后的室外画面 |

各用例状态行：

- spawn / corridor / living / south：`indoor=true canExit=false collision=true distance=2.80`
- 退出用例：`exit=true indoor=false collision=true`

说明：`distance` 是滚轮目标距离，不代表被墙压缩后的实际镜头距离；spawn 与 living 的近墙压缩见第 3 节。

### 8.3 静态审查要点

- 进入只移动 `player.group`，不替换 Store / Game / renderer；退出恢复进入前快照。
- 读档、新游戏、`dispose` 的失效顺序在 `store.replace` 之前，迟到回调按代次丢弃并释放。
- 室内 `getSaveData()` 返回室外快照；`formatVersion`、产权、资金、背包无改动。
- 室内不调用时间推进；`syncLayout()` 在室内不刷新附近建筑、不移动相机。
- 室内碰撞与相机遮挡分表；天花板/门洞封口只进遮挡，不封死移动。
- 构建产物中四件模型不进入主 chunk，仅由 `qingchuan` 动态模块引用。

### 8.4 未运行项（如实说明）

- **未在完整 Game UI 中实际点击**「进入个人住宅」完成一次真实鼠标操作；headless 直接调用 `World.enterInterior()`，入口权限复核与按钮接线只做了代码审查。
- **未做真实读档往返**（室内保存 → 回主菜单 → 读档 → 确认楼外、余额/背包/产权不变）；只审查了调用顺序与快照返回路径。
- 未用真实键鼠完成玄关→厨房→起居室→门口的完整巡走与鼠标锁定残留检查；截图使用代码设置站位。
- 未在真实网络面板确认「进入前不请求家具、退出后 GPU 资源释放」；仅有代码路径与构建产物证据，未做压力或内存测试。
- 未故意制造 GLB 404 复现失败回退，也未在加载中触发读档；失败路径仅静态审查。
- 未做多浏览器/移动端矩阵、性能基准或长时模拟。

## 9. 留给用户的检查

1. 原 F 住宅菜单、休息与房地产入口是否保留；进入按钮只在合法现场可用。
2. 点击进入 → 走到门口按 F 离开 → 再次进入；出生/回归点是否安全，鼠标锁定与输入是否无残留。
3. 玄关 → 厨房过道 → 起居室 → 门口巡走一次，检查隔断、卫浴、床/沙发/桌椅、南窗与灯光，以及 1.12 m 走廊和 0.95 m 床椅通道的手感。
4. 室内手动保存后读档，确认回到楼外、最新余额/背包/住宅权利保留；经济随自然时间变化属正常。
5. 观察进入时是否请求四件 GLB、离开后是否停止渲染/持有室内资源（可用 DevTools Network / Memory 粗看）。
6. 如条件允许，临时改错一个模型 URL 或在加载中读档，确认不会用占位方块顶替、也不会被迟到回调拉回旧房间。

## 10. 未完成与已知限制

- 本轮不做家具编辑、交易、库存、布局存档、多套住宅、装修消费、生活互动（床/卫浴/厨房均无功能）、天气街区重排或无关重构。
- 室内地点不持久化：室内保存后读档回楼外，是 D91 的明确取舍，不是缺陷。
- 进入第一帧镜头被北墙压缩，人物较大；向前走即恢复。没有第一人称模式，也没有镜头淡化后期。
- 床模型 49,990 三角面，是四件中最重的一件；进入需等待四个 GLB 加载，失败整次回退。
- 窗外是低成本简化都市背景，不二次渲染城市；入户门 0.8 m 仅视觉/出口，不承担通行。
- 室内截图状态行是临时预览页的调试文字，不在正式游戏中出现。
- 本报告不宣称已通过 GPT Work 最终验收。

## 11. `threejs` Skill 来源说明

- 实际读取与使用的技能：`threejs`，本地路径
  `C:\Users\Eojnus\.config\opencode\skills\threejs\SKILL.md`（同目录含 `REFERENCES.md` 与 `demo/`）。
- 适用条目：场景/相机/renderer 结构、`GLTFLoader` 资产加载、材质与灯光、SPA 资源释放（`geometry/material/texture.dispose()`）、尺寸与 DPR 约束。本次用于核对 GLTF 接入、独立场景与退出释放，不用于生成项目业务代码。
- 发布来源：公开仓库 **MengTo/Skills** 的 `agent-skills/web-design/threejs/` 存在同名技能，commit
  `a45892d2fdadab75b31fb16abecc02f101b31c43` 的页面可核实；本地副本的正文与该文件高度对应。
- **但本地没有安装 manifest、下载记录或版本标记，且本地副本存在少量换行与弯引号损坏**，无法证明它就是本次从该仓库安装的副本。因此：
  - 技能**发布来源**记为：MengTo/Skills（公开仓库，可核实存在）；
  - 技能**本地安装渠道**记为：**来源未核实**；
  - 不声称由 MengTo 本人安装或背书，也不把「同名」当作安装证据。

## 12. 结论

首套室内、四类真实家具、进出与存档隔离、按需加载与释放均已落地，构建通过，headless 进入/退出与截图已覆盖主要视觉路径。完整 UI 点击、读档往返、失败回退与真实巡走仍需用户在真实游戏中确认；本报告不代替 GPT Work 的架构审查与最终验收。
