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
- 使用方式（历史）：仅取用其中 6 个 GLB 建筑模型，作为 5 栋功能建筑的整栋视觉，
  由已移除的 `applyBuildingModel` 做尺寸归一化后替换灰盒。
  **自建筑视觉接入正式地图后，正式场景不再加载这些整栋 GLB**：外观改由
  `src/world/buildings/` 的模块化工厂按只读规划尺寸生成。文件与来源记录保留，
  旧存档的 `model` / `modelScaleKey` 字段也保留为兼容数据。
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
| Modular Fire Escape（`modular_fire_escape`） | 3D 模型 | Juniix | `city-realism/models/fire-escape-modular.glb` | 住宅/公寓阳台金属栏杆；办公楼、银行、证券中心背面外挂疏散楼梯（平台栏杆 / 楼梯 / 爬梯） |
| Utility Box 01（`utility_box_01`） | 3D 模型（仅几何） | James Ray Cock | `city-realism/models/utility-box.glb` | 屋顶室外机（≥2 层的楼）与入口侧设备箱 |
| Plastered Wall（`plastered_wall`） | PBR 材质 | Amal Kumar | `city-realism/textures/plaster-wall-*.jpg` | 五种风格的主墙面、女儿墙、屋顶、雨棚与市政/商业基座 |
| Rectangular Facade Tiles（`rectangular_facade_tiles`） | PBR 材质 | Charlotte Baglioni | `city-realism/textures/facade-tiles-*.jpg` | 办公/银行/证券标准层外墙板材；市政与商业风格的基座与层间线脚 |

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

## 晴川公寓室内家具（feature/qingchuan-apartment-interior）

本轮为晴川公寓首套约 20㎡ 室内引入四件真实外部家具，全部来自 **Poly Haven**，
全部为 **CC0 1.0**（可复制、修改、再分发与商用，署名非强制）。核查日期：**2026-10-28**。

许可依据：<https://polyhaven.com/license> —— “All assets … are licensed as CC0 …
You can use our assets for any purpose … You can redistribute them”。
四件资产在各自作品页与 Poly Haven API（`https://api.polyhaven.com/info/<id>`）均返回
`license: CC0`，未使用登录、付费或需要额外授权的下载通道。

下载方式：作品页的 **glTF 1K** 包（`https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/<id>/<id>_1k.gltf`
+ 同目录 `.bin` 与 `textures/`）。落地时把 `.gltf` / `.bin` 重命名为 `<id>.gltf` / `<id>.bin`
并同步 `buffers[].uri`，贴图保留原文件名与相对路径；**几何未做减面、未缩放、未改材质**。
注意：这四件是「`.gltf` + `.bin` + `textures/`」的多文件 glTF，**不是单文件 GLB**，
本文档与代码注释中的「glTF」均指这种形态。

| assetId（项目内稳定标识） | Poly Haven 资产 | 作者 | 本地文件 | 用途 |
| --- | --- | --- | --- | --- |
| `polyhaven.old-bed-frame` | [Old Bed Frame](https://polyhaven.com/a/old_bed_frame)（`old_bed_frame`） | Luca B | `models/interiors/qingchuan/old_bed_frame/` | 单人床床架（床头靠北侧隔断） |
| `polyhaven.sofa-01` | [Sofa 01](https://polyhaven.com/a/Sofa_01)（`Sofa_01`） | Kirill Sannikov | `models/interiors/qingchuan/Sofa_01/` | 南窗下紧凑双人沙发（靠南墙、朝北） |
| `polyhaven.wooden-table-02` | [Wooden Table 02](https://polyhaven.com/a/wooden_table_02)（`wooden_table_02`） | Serhii Khromov | `models/interiors/qingchuan/wooden_table_02/` | 东墙书桌/餐桌 |
| `polyhaven.dining-chair-02` | [Dining Chair 02](https://polyhaven.com/a/dining_chair_02)（`dining_chair_02`） | James Ray Cock | `models/interiors/qingchuan/dining_chair_02/` | 书桌配椅（面向东侧桌） |

真实资源统计（由本地 glTF/`accessors` 与文件系统直接统计，非估算）：

| 资产 | 顶点 | 三角面 | 材质 | 贴图 | 原始包围盒（宽 × 高 × 深，米） | 文件体积（KiB） |
| --- | --- | --- | --- | --- | --- | --- |
| Old Bed Frame | 35,560 | 49,990 | 1 | diff / nor_gl / arm，均 1024² | 0.905 × 1.201 × 2.002 | 3,947 |
| Sofa 01 | 2,708 | 4,101 | 1 | diff / nor_gl / arm，均 1024² | 1.571 × 0.796 × 0.658 | 506 |
| Wooden Table 02 | 200 | 196 | 1 | diff / nor_gl / arm，均 1024² | 1.134 × 0.799 × 0.706 | 474 |
| Dining Chair 02 | 12,891 | 22,013 | 1 | diff / nor_gl / arm，均 1024² | 0.434 × 0.975 × 0.576 | 900 |

- 合计 **20 个文件 / 5,965,954 字节（约 5.69 MiB）**；12 张 1024×1024 JPEG，4 个材质。
- 每件模型只有 1 个节点、1 个 mesh、1 个 primitive，材质使用 baseColor + normal + metallicRoughness（ARM 打包，
  运行时只读取 G/B 通道；R 通道未配置 occlusion，未被额外使用）。
- 未引入 4K/8K 贴图、未引入 KTX2/Draco 解码器或任何新依赖；加载沿用项目既有 `GLTFLoader`。
- 四件模型的贴图均随 Poly Haven 1K 包下载，属于同一资产的同一许可，无第三方贴图。

运行方式（`src/content/interior.ts`）：四件家具各自保留稳定 `assetId`、独立 `Object3D`（Group 包裹 glTF scene）、
尺寸/旋转/碰撞包围盒配置；进入住宅时才动态 `import()` 室内模块并按 URL 加载，退出时统一释放
geometry/material/texture，不触碰城市共享资产。

## 替换资源时的注意事项

1. 整栋建筑外观不再由 `config.ts` 的 `model` 字段决定：正式场景一律走
   `src/world/buildings/` 的模块化工厂，替换建筑美术应改 `src/content/building-visuals.ts`
   的风格与素材登记（必要时新增 `public/assets/city-realism/` 下的文件并同步 manifest）。
2. `public/assets/models/*.glb` 保留为历史资源与旧存档兼容数据，不再参与正式渲染。
3. 人物模型仍在 `config.ts` 的 `PLAYER.model.url`，替换后需更新 `scene-scale` 里的人物身高参照说明。
4. 新资源必须登记来源、作者、许可证与署名要求；无清晰许可的素材不得入库。
4. 若新资源许可要求署名，请补充到本文件与游戏内的说明处。

---

---

## 阶段 1（v0.3.x · city-block-realism）新增街景资源

全部来自 **Poly Haven**，许可证 **CC0 1.0**（可商用、可修改、可再分发，署名非强制，仍在此致谢）。
逐件登记见 `city-realism/manifest.json` 的 `street_tree_quiver_tree_01` / `street_lamp_01` /
`asphalt_02` / `concrete_pavement_02` 四项。合计新增 **6.84 MiB**（8 个文件）。

| 资源 | 来源页 | 作者 | 本地文件 | 处理 |
| --- | --- | --- | --- | --- |
| Quiver Tree 01 | https://polyhaven.com/a/quiver_tree_01 | Poly Haven | `models/street-tree.glb`（0.70 MiB，12,660 面） | gltf-transform：weld + simplify(0.05) 从 150,124 面降到 12,660 面；叶片材质 BLEND→OPAQUE；贴图 1K→512 JPEG；单文件 GLB |
| Street Lamp 01 | https://polyhaven.com/a/street_lamp_01 | Poly Haven | `models/street-lamp.glb`（0.55 MiB，6,300 面） | gltf-transform：simplify(0.2) 从 30,610 面降到 6,300 面；灯罩 alpha 贴图保持 PNG；单文件 GLB |
| Asphalt 02 | https://polyhaven.com/a/asphalt_02 | Poly Haven | `textures/asphalt-{diffuse,normal,arm}-1k.jpg`（2.16 MiB） | 1K 原图未重采样；ARM 驱动 roughness/metalness |
| Concrete Pavement 02 | https://polyhaven.com/a/concrete_pavement_02 | Poly Haven | `textures/paving-{diffuse,normal,arm}-1k.jpg`（2.75 MiB） | 同上 |

**如实说明**：

1. 行道树是**箭袋树**（Quiver Tree，沙漠肉质乔木）：归一化到 5.6 m 后**树冠仅 2.44 × 2.00 m**，
   冠形直立偏窄，**不是**阔叶行道树。
   早前用的是冷杉幼树（Fir Sapling），5.6 m 高时冠幅达 **11.8 m**（高度的 2.1 倍），
   必然穿插立面、相邻树冠与巷口视线，故在"仅修复试点树木"的授权范围内换用本资产。
   首选的蓝花楹（`jacaranda_tree`，198 MB）、`tree_small_02`（90 MB，4.65 M 面）在本机
   70 KB/s 的下载条件下不可行，因此选择体积与许可都可控的窄冠树。
2. 叶片材质原本声明 BLEND，但六张贴图全是 JPEG、不带 alpha —— 混合没有收益，
   改为 OPAQUE 后既省透明排序，也能正常投下阴影。
3. 路灯**不带光源**：本阶段不新增 PointLight，夜间亮度仍由既有 `EnvironmentRig` 决定；
   灯头保留原生材质，不额外自发光。
4. 长椅是**程序化几何**（座板 + 两侧支墩），材质复用街景库的素色材质，**不计入外部美术资源**。
   Poly Haven 的 `modular_street_seating` 是零件陈列布局（座板/腿/扶手分散在 x −2.3…+1.0），
   取单一节点只是平板，逐件拼装又不值得，故未采用。
5. 路缘石条、车道虚线、斑马线、围墙、绿篱都是**程序化几何 + 素色材质**，不属于外部资源。
6. 全城推广时对树木与路灯各减面一次（树木 18,003→12,660，路灯 30,610→6,300），
   累计静态资源约 **12.65 MiB**（既有 6.49 + 新增 6.16），仍在 15 MiB 预算之内。
