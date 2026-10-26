# Casual_Male · 玩家角色

## 来源与许可

- 原始资产：**Quaternius — Ultimate Animated Characters**（CC0 1.0）
- 作者：Quaternius（https://quaternius.com）
- 获取途径：Cinevva 免费 CC0 角色库
  - 资源页：https://app.cinevva.com/game-assets/free-3d-character-models
  - 直链：https://cdn.cinevva.com/assets/packs/quaternius/ultimate-animated-characters/Casual_Male.glb
- 该库对资源的声明（原文）：
  > Every model below is a single CC0 character you can download as a GLB right here,
  > and many arrive already rigged and animated. … Every model here is CC0, hosted by us,
  > and downloads as a single GLB straight from the card. No account, no signup, no attribution required.
- 许可：**CC0 1.0 Universal**
  https://creativecommons.org/publicdomain/zero/1.0/
- 核查结论：CC0 允许复制、修改、分发与商业使用，署名非强制（仍在此致谢）。

## 文件

- `Casual_Male.glb`，1.67 MB，单文件 GLB，**无外部纹理依赖**（使用材质颜色）
- 6 个网格 / 6 个蒙皮 / 6 个材质

## 动画（17 个）

`Death`、`Defeat`、`Idle`、`Jump`、`PickUp`、`Punch`、`RecieveHit`、`Roll`、`Run`、
`Run_Carry`、`Shoot_OneHanded`、`SitDown`、`StandUp`、`SwordSlash`、`Victory`、`Walk`、`Walk_Carry`

本项目使用其中两个：**Idle**（待机）与 **Walk**（行走），按权重交叉淡化过渡。

## 替换方式

改 `src/content/config.ts#PLAYER.model` 的 `url` / `idleClip` / `walkClip` 即可。
业务逻辑不依赖模型文件名、节点名或动画名；加载失败会回退到占位模型并打印错误。
