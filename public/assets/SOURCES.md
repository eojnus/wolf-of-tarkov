# 美术资源来源与许可

本项目首版只使用一套外部资源，其余为程序化几何体（道路、地面、树木、建筑标签）。

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

## 替换资源时的注意事项

1. 把新的 `.glb` 放进 `public/assets/models/`。
2. 修改 `src/content/config.ts` 中对应建筑的 `model` 字段（相对 `public` 的路径）。
3. 无需改动任何业务规则；加载失败会自动回退到灰盒表现。
4. 若新资源许可要求署名，请补充到本文件与游戏内的说明处。
