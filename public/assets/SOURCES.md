# 美术资源来源与许可

场景资源以程序化几何体为主（道路、地面、树木、建筑标签），另有 Kenney 建筑模型与
Quaternius 角色模型；界面图标自 v0.3.4 起使用 Lucide。每一类资源都在下方登记作者、
来源链接、许可证与实际用途。

## Kenney · City Kit Commercial 2.1

- 来源页面：https://kenney.nl/assets/city-kit-commercial
- 作者：Kenney（www.kenney.nl）
- 许可：Creative Commons Zero v1.0 Universal（CC0 1.0）
  - 许可全文：https://creativecommons.org/publicdomain/zero/1.0/
  - 本地留存：`LICENSE-kenney-city-kit.txt`
- 核查结论：许可明确允许个人、教育与商业用途，允许修改、用于游戏并随构建产物分发；
  署名非强制要求（仍在此致谢）。用于本项目不存在授权疑问。
- 使用方式：仅取用其中 6 个 GLB 建筑模型，作为 5 栋功能建筑的视觉表现，
  在 `src/world/scene.ts#applyBuildingModel` 中做尺寸归一化后替换灰盒。
  模型仅为表现层，业务规则不依赖模型文件或节点名称。

### 实际纳入的文件

| 文件 | 用途 |
| --- | --- |
| `assets/models/low-detail-building-a.glb` | 晴川公寓（住宅） |
| `assets/models/building-a.glb` | 塔科夫银行 |
| `assets/models/building-skyscraper-a.glb` | 塔科夫实业大厦（公司） |
| `assets/models/building-c.glb` | 塔科夫证券中心 |
| `assets/models/low-detail-building-wide-a.glb` | 市民服务中心（未开放） |
| `assets/models/building-f.glb` | 备用，当前未引用 |
| `assets/models/Textures/colormap.png` | 上述 GLB 共用的外部调色板纹理 |

体积合计约 400 KB（GLB 约 390 KB + 纹理 11 KB），未使用压缩纹理，未引入额外依赖。

## Casual_Male · 玩家角色（v0.2.1 替换）

- 原始资产：**Quaternius — Ultimate Animated Characters**（CC0 1.0）
- 作者：Quaternius（https://quaternius.com）
- 获取途径：Cinevva 免费 CC0 角色库
  - 资源页：https://app.cinevva.com/game-assets/free-3d-character-models
  - 直链：https://cdn.cinevva.com/assets/packs/quaternius/ultimate-animated-characters/Casual_Male.glb
  - 该库声明（原文）："Every model here is CC0, hosted by us, and downloads as a single GLB
    straight from the card. No account, no signup, no attribution required."
- 许可：**CC0 1.0**（可复制、修改、分发、商用；署名非强制，仍在此致谢）
- 本地许可说明：`models/character/LICENSE-Casual_Male.md`
- 文件：`models/character/Casual_Male.glb`（1.67 MB，单文件、无外部纹理依赖、材质颜色）
- 动画（17 个）：Death / Defeat / **Idle** / Jump / PickUp / Punch / RecieveHit / Roll / Run /
  Run_Carry / Shoot_OneHanded / SitDown / StandUp / SwordSlash / Victory / **Walk** / Walk_Carry
- 本项目使用：Idle（待机）与 Walk（行走），按权重交叉淡化过渡，播放速率按实际移动速度缩放。
- 说明：这是**现代便装的人类角色**，有独立的待机与行走片段，不是用跑步动画替代行走。
  替换其他 glTF 只需修改 `src/content/config.ts#PLAYER.model`，业务逻辑不依赖模型文件名或节点名。
- 已移除：v0.1/v0.2 曾使用的 `RobotExpressive.glb`（机器人外观），已从仓库删除。

## Lucide · 界面图标（v0.3.4 引入）

- 项目仓库：https://github.com/lucide-icons/lucide
- 图标包：`lucide-static@0.469.0`（按需取用单个 SVG，未引入整包依赖与运行时脚本）
- 作者：Lucide Contributors
- 许可：**ISC License**
  - 许可全文：https://github.com/lucide-icons/lucide/blob/main/LICENSE
  - 本地留存：`icons/lucide/LICENSE-lucide.txt`（与上游同版本）
- 核查结论：ISC 允许使用、修改、再分发与商用，要求在副本中保留版权与许可声明；
  已在每个 SVG 文件头部保留 `@license lucide-static v0.469.0 - ISC` 注释，并在此登记。
- 用途：导航、资金、工作、公司、股票、城市、操作与状态图标。
- 修改情况：**未改动图形几何**。只在使用处统一了呈现方式——24×24 视框、
  `stroke="currentColor"`、`stroke-width` 1.75、圆角端点，按尺寸缩放；
  图形数据内联在 `src/ui/icons.ts`，便于跟随文字颜色，不额外发起网络请求。
- 体积：29 个 SVG，合计约 12 KB（未压缩），逐个确认界面实际使用后才保留。

### 实际纳入的文件

`public/assets/icons/lucide/*.svg` 共 29 个单图标文件，以及 `LICENSE-lucide.txt`。
这些文件同时作为许可与来源凭证保留在仓库内；运行时使用内联副本，不读取该目录。

## 字体：未引入 Web 字体（说明取舍）

- 候选：Noto Sans SC（SIL Open Font License 1.1）。
- 实测取舍：完整中文字重体积过大（单个字重按上游 woff2 计约数 MB 级；多字重或多个
  子集文件会进一步放大），而本轮可用工具链内没有可靠的子集化步骤，引入后会明显拖慢
  首屏并让构建产物膨胀。因此**本轮没有引入字体文件**，界面使用系统中文字体栈：
  `Segoe UI → PingFang SC → Microsoft YaHei → Noto Sans SC（本地已安装时）→
  Source Han Sans SC → system-ui`。
- 后果与说明：排版效果随操作系统略有差异（Windows 走微软雅黑，macOS 走苹方），
  但不会在运行时依赖 Google Fonts 等网络服务。

## Kenney UI Pack：未采用（说明取舍）

- 官方页面：https://kenney.nl/assets/ui-pack
- 许可：CC0 1.0（可自由使用）。
- 未纳入的原因：该包以厚描边、斜面高光与饱和渐变为主要视觉语言，与本轮确定的
  「雾白／浅灰蓝、细边框、柔和圆角」方向冲突。逐件挑几个图标会破坏统一视觉重量，
  而统一图标已由 Lucide 覆盖，因此只使用 Lucide，不为了用素材而混入第二套图标风格。

## 未采用的方案

- OpenGameArt / itch.io 中部分现代城市资源包风格不统一、单包体积较大，
  与「紧凑十字街区」的首版范围不匹配，未纳入。
- 未使用任何许可证不清晰的资源；「可免费下载」不等于允许使用，已逐一核对许可。

## v0.7 便利店：程序化几何（无新增外部资源）

本轮新增的「晴川便利店」**没有下载或使用外部模型/贴图**，全部由 Three.js 内置几何与
CanvasTexture 在 `src/world/scene.ts` 中程序化生成：

- 几何：Box / Plane / Cylinder 等基础体（墙体、玻璃、货架、商品盒、收银台、雨棚、招牌板），
  约 1.9k 三角形、约 10 个材质，无阴影、后处理或新依赖。
- 招牌：CanvasTexture 运行时绘制店名与「24H」角标，不包含任何现实品牌标识。
- 许可以及来源：仅使用 Three.js（MIT）自带能力，无第三方美术授权或署名义务。

未采用外部资源的核查结论（如实记录）：

- 检索到的免费便利店模型多为低模/风格化或带现实品牌标识（如 Alfamart/Indomaret 门店），
  与「写实现代便利店 + 无品牌」的目标不符，许可与署名条件也无法在单店 15 MB 预算内可靠确认；
- 部分站点（如 Meshy 免费模型页）的再分发与游戏内使用条款不明确，按项目规则一律不采用；
- 因此本轮选择程序化建模：比例可控、许可零风险、加载失败风险低。若后续找到许可明确、
  比例匹配、无品牌标识的 GLB，可按下方「替换资源时的注意事项」接入并在此登记。
- 既有 Kenney/Quaternius 资源的原始包围盒实测与等比缩放结果见 `docs/scene-scale.md`；
  本轮未新增或替换任何外部模型/贴图。

## 城市写实化：模块化建筑原型（feature/city-modular-buildings）

本轮为「六层住宅 / 八层现代公寓 / 十层商业办公楼」三种模块化建筑原型引入了第一批写实
外部资源，全部来自 **Poly Haven**，全部为 **CC0 1.0**（可商用、可修改、可再分发，署名非强制）。
机器可读清单：`assets/city-realism/manifest.json`（机器可读，含体积、三角面、贴图规格与优化步骤）。

许可依据：<https://polyhaven.com/license> — "All assets … are licensed as CC0 …
You can use our assets for any purpose … You can redistribute them"。

| 资源 | 类型 | 作者 | 本地文件 | 用途 |
| --- | --- | --- | --- | --- |
| Modular Fire Escape（`modular_fire_escape`） | 3D 模型 | Juniix | `city-realism/models/fire-escape-modular.glb` | 住宅阳台金属栏杆；办公楼背面外挂疏散楼梯（平台栏杆 / 楼梯 / 爬梯） |
| Utility Box 01（`utility_box_01`） | 3D 模型（仅几何） | James Ray Cock | `city-realism/models/utility-box.glb` | 屋顶室外机与入口侧设备箱 |
| Plastered Wall（`plastered_wall`） | PBR 材质 | Amal Kumar | `city-realism/textures/plaster-wall-*.jpg` | 住宅/公寓主墙面、女儿墙、裙房基座 |
| Rectangular Facade Tiles（`rectangular_facade_tiles`） | PBR 材质 | Charlotte Baglioni | `city-realism/textures/facade-tiles-*.jpg` | 办公楼标准层外墙板材、公寓深色基座 |

资源页与下载地址：

- 模型页 <https://polyhaven.com/a/modular_fire_escape>、<https://polyhaven.com/a/utility_box_01>；
  下载使用 1K glTF 包（`https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/<id>/<id>_1k.gltf` + 同目录 `.bin` 与 `textures/`）。
- 贴图页 <https://polyhaven.com/a/plastered_wall>、<https://polyhaven.com/a/rectangular_facade_tiles>；
  下载使用 1K JPEG（diffuse / nor_gl / arm 三个通道）。

处理与优化（详见 manifest）：

1. 消防梯只保留实际使用的 4 个构件节点与 01 号 PBR 套（6 张贴图 → 3 张），三角面 11322 → 8086，
   原始 4.81 MB → 2.51 MB 单文件 GLB（几何与原贴图内嵌）。
2. 设备箱只保留几何（1.97 MB → 0.14 MB），材质改用项目内金属框架材质，
   **未使用该资产的贴图**，因此不把它计入 PBR 材质来源。
3. 两套立面贴图均为原始 1K JPEG，未重采样；ARM 打包图同时驱动粗糙度（G）与金属度（B），
   省掉独立 rough/metal 两张图。
4. 场景没有环境贴图（IBL），运行时对 GLB 材质做「金属度 ≤ 0.32、粗糙度 ≥ 0.45」的近似，
   否则接近纯金属的材质会渲染成黑色。该近似不修改资源文件。
5. 生产静态资源合计 **6.49 MiB**（8 个文件 = 2 个 GLB + 6 张 1K JPEG），低于本轮 15 MiB 预算；贴图显存估算
   **48.24 MiB**（9 张 1024² RGBA + mipmap 链，按 宽×高×4×1.34 计），低于 64 MiB 预算。

未采用：`modular_urban_apartments_facade`（27 万三角面、147 个节点、4 套贴图）与
`street_lamp_01`（3 万三角面、4 张贴图）在本轮预算内性价比不足；`painted_concrete`
（绿色油漆混凝土）与 `concrete_tile_facade`（过深肋板）与「浅色现代立面」目标不符，已替换。

## 替换资源时的注意事项

1. 把新的 `.glb` 放进 `public/assets/models/`。
2. 修改 `src/content/config.ts` 中对应建筑的 `model` 字段（相对 `public` 的路径）。
3. 无需改动任何业务规则；加载失败会自动回退到灰盒表现。
4. 若新资源许可要求署名，请补充到本文件与游戏内的说明处。
