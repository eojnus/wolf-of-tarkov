# 全城推广 · 阶段 2 · 阶段 3 交付说明

日期：2026-10-29
分支：`feature/city-block-realism`（基线 `dea681b`，工作树含已验收的试点成果，未重置）
工作目录：`C:\Coding\wolf-city-block-realism`

三阶段连续推进完成，未提交、未推送、未合并。

---

## 1. 结论

| 阶段 | 状态 | 一句话 |
| --- | --- | --- |
| 全城推广 | **完成（接入正式场景）** | 新增「站点枚举 + 参数化生成」：基础城区其余三个象限、三个新区条带各自长出街区，共 **16 个街区 / 33 栋临街楼**，全部由存档里的真实布局推导 |
| 阶段 2 建筑美术 | **完成** | 檐口、办公竖向翼板、玻璃比例、雨棚灯槽、基座；五类风格辨识度提升，规则版本 v2 → v3 |
| 阶段 3 三套模板 | **完成（独立入口 + 独立预览页）** | A 住宅庭院 / B 商业混合 / C 科技办公，45×45 完整模板可独立生成；全城推广用的正是同一份生成器 |

三者关系说清楚：**同一套生成器**，输入矩形不同 → 完整模板（45×45，`variant: full`）或裁剪变体（真实可用矩形，`clipped` / `row`）。不存在"预览一套、城里另一套"。

---

## 2. 全城覆盖清单

`planCityBlocks(layout)` 的输出（基础城区 + 三个新区条带，共 16 块）：

| 区域 | 街区 | 变体 | 前宽×进深 | 临街楼 | 树 | 巷道通行 |
| --- | --- | --- | --- | --- | --- | --- |
| 基础 NE（东岗街坊，已验收） | 1（手写试点） | pilot | 22.5×26 | 3 | 11 | 3.0 m ✓ |
| 基础 NW | 1 | clipped | 25×20 | 2 | 2 | 4.5 m ✓ |
| 基础 SW | 1 | clipped | 26×20 | 2 | 2 | 4.0 m ✓ |
| 基础 SE | 1 | clipped | 25×20 | 2 | 2 | 4.5 m ✓ |
| 住房条带 | 4 | 3 clipped + 1 row | 22–23×22–26 | 2 | 3–8 | 4.0 m ✓ |
| 商业条带 | 4 | 3 clipped + 1 row | 21–22×17.5–42 | 2 | 2–6 | 4.5 m ✓ |
| 科技条带 | 4 | 4 clipped | 21–22×21–42 | 2 | 3–8 | 4.5 m ✓ |

- **变体**：`clipped` 12、`row` 2、`pilot` 1；完整模板 3 套走独立入口（见第 4 节）。
- **跳过**：基础城区 12 条、三个条带各若干条，全部带原因（前宽 < 16 m 或可用进深 < 13 m，被业务建筑或路口切断）。示例：
  - `site-road-district-base-ew-north-shallow`：31 m 前沿的可用进深不足 13 m（被业务建筑/路口切断）
  - `site-road-district-base-ns-east-u28`：可用前宽仅 10 m（需 ≥ 16）
- **没有被静默跳过的整片城区**：每条道路的每一侧都逐米扫描，跳过的地方都落了原因。
- 新增街区全部落在**临街**，不占用储备地块（`RESERVE_LAND_PARCELS` 按 1 m 净距避让），不压业务建筑（2 m 净距），不动道路与任何既有坐标。

### 站点怎么找的

`world/blocks/sites.ts`：每条道路每一侧从人行道外沿向内取 1 m 宽的列，
**列可用进深 = 压在这一列上的最近障碍边**；相邻且够深的列合成一段前沿，再按 45 m 切站点。
早期用"整条带减障碍再捡碎片"，会把 25×42 的空地切成 25×15 的碎片，已弃用。

---

## 3. 阶段 2：模块化建筑美术

改动都在既有 `BuildingVisualFactory` 内，没有新建框架。

| 改动 | 位置 | 效果 |
| --- | --- | --- |
| **檐口**（0.3 m 高、外挑 0.1 m） | `facade.ts` `buildShell` | 楼体有收头，不再像被刀切平的盒子；落在女儿墙脚下，不越包络 |
| **办公竖向翼板**（0.18 m，整高贯通） | `facade.ts` + `style.facade.fins` | 连续窗带被切成柱距，远看可区分办公楼与公寓；闭窗面不画 |
| 办公玻璃比例 | `office-10` 参数 | 窗台 0.35→0.30、窗顶 3.10→3.15、窗间墙 0.28→0.22 |
| **雨棚灯槽** | `details.ts` / `assets.ts` | 自发光 0.9→0.35、灯带比雨棚窄 1.8 m：从"发光金板"变成一条灯槽 |
| 规则版本 | `BUILDING_VISUAL_RULES_VERSION` 2 → 3 | 进入指纹，参数改变会触发重建 |

保持不变：`blindFaces` 共墙闭窗（阶段 1 已做）、阳台/入口/屋顶设备、尺寸驱动、稳定种子、
资源加载与释放路径、异步取消与过期结果丢弃。

---

## 4. 阶段 3：三套标准模板

### 调用入口

```ts
import { generateTemplateBlock, TEMPLATE_CATALOG } from './world/blocks/templates';

const { plan, size, family } = generateTemplateBlock({
  familyId: 'residential-courtyard',   // 或 'commercial-mixed' / 'tech-office'
  templateVersion: 1,                  // 必须与族定义一致，否则返回带 skip 的空计划
  center: { x: 0, z: 0 },              // 缺省原点
  front: 'south',                      // 缺省朝南
  seedSuffix: '',                      // 换种子换楼体组合，同种子结果恒定
});
// plan.decor / plan.paving / plan.walls / plan.props / plan.trees
// plan.colliders / plan.walkable / plan.coverage / plan.variant
// 直接交给 CityBlocks.sync() 即可装配
```

输出字段：楼体（id / 风格 / 局部宽深高 / 世界坐标 / 旋转 / 闭窗面 / 声明包络）、
铺装、围墙、家具、树、碰撞盒、步行域、**覆盖率**（前宽/进深/临街栋数/是否庭院/是否巷道/保留要素）、
以及跳过原因。

### 版本语义

`blockFamilyById(id, version)` **必须 id + 版本同时匹配**；不匹配返回 `null`，
调用方按"跳过并记录原因"处理，**绝不回退到最新版**。版本号同时进入种子与块指纹，
因此存档里记录的老版本不会被新几何悄悄替换。

### 三套模板

| 模板 | id@v | 标称 | 退线/楼体进深 | 单元宽 | 高度 | 风格 |
| --- | --- | --- | --- | --- | --- | --- |
| A 住宅庭院 | `residential-courtyard@1` | 45×45 | 5 / 12 | 13-11-15-12 | 12–21 | 住宅、公寓（巷口一栋可做铺面） |
| B 商业混合 | `commercial-mixed@1` | 45×45 | 4 / 12 | 10-14-9-12 | 12–24 | 零售、办公、公寓混合 |
| C 科技办公 | `tech-office@1` | 45×45 | 5 / 13 | 15-12-10-14 | 16–30 | 办公为主 + 街角零售 |

共性：沿街密排成街墙（相邻单元 0 缝共墙、闭窗），中间留 4–4.5 m 巷道通向内部庭院/广场，
庭院远边做绿带收边（住宅 1.2 m 绿篱、商业/科技 0.45 m 种植池），树按面积定密度、逐棵做树冠校验。
科技/商业族通过 `preferNearKinds` 声明"想靠近哪类业务建筑"，生成时把最近的业务建筑记进 `coverage.kept`
作为**功能槽位标注**——只标注，不创建任何业务。

### 独立预览

`/block-template.html`（`?t=a|b|c`、`?view=court|entrance`、`?seed=N`）：
三套并排或单套细看，走的是同一个 `generateTemplateBlock` + `CityBlocks` + `BuildingVisualFactory`。
截图：`shots/p3-templates-all.png`、`p3-template-a/b/c.png`。

---

## 5. 修改文件

**新增**

| 文件 | 作用 |
| --- | --- |
| `src/world/blocks/rect.ts` | 矩形工具（相减、净距、旋转占地、局部立面名） |
| `src/world/blocks/types.ts` | `BlockPlan` 等公共类型（含 `variant` / `coverage`） |
| `src/world/blocks/sites.ts` | 站点枚举（按米列扫描可用进深） |
| `src/world/blocks/generate.ts` | 参数化街区生成器 |
| `src/world/blocks/templates.ts` | 三套模板对外入口 + 目录 |
| `src/dev/template-preview.ts` / `block-template.html` | 模板预览页（不进生产构建） |

**修改**

| 文件 | 改动 |
| --- | --- |
| `src/content/city-blocks.ts` | 新增 `BlockFamilyDef` 与三套族定义、`blockFamilyById`、`defaultFamilyForDistrict` |
| `src/world/blocks/plan.ts` | 拆出类型/几何工具；`planCityBlocks` 增加站点生成与跳过汇总；`PlanOptions` |
| `src/world/blocks/scene.ts` | 路灯不投影、实例网格算包围球并开启视锥剔除 |
| `src/content/building-visuals.ts` | `cornice` / `fins` 字段；办公玻璃比例；规则版本 3 |
| `src/world/buildings/facade.ts` | 檐口 + 翼板 |
| `src/world/buildings/plan.ts` | 解析结果带上 `cornice` / `fins` |
| `src/world/buildings/details.ts` | 雨棚灯槽收窄 |
| `src/world/buildings/assets.ts` | 灯带自发光 0.35 |
| `src/dev/block-prototype.ts` | `?districts=1`（叠加三个新区条带）、`?cam=`、`__diag` |
| `public/assets/...` | 树/路灯减面重打包；`manifest.json`、`SOURCES.md` 同步 |

**资源**：没有引入新资产。既有两件做了减面（都来自 Poly Haven，CC0）：
树 18,003 → **12,660 面**（0.87 → 0.70 MiB）、路灯 30,610 → **6,300 面**（1.10 → 0.55 MiB）。
累计静态资源 13.33 → **12.65 MiB**。

---

## 6. 验证

**构建**：`npm run build`（含 `tsc --noEmit`）通过，1.81 s。

**通行核对**（真实碰撞盒 + 人物直径 0.84 m，两端各跳过 0.6 m 贴立面段）：

| 街区 | 巷道净宽 | 采样 | 碰撞 |
| --- | --- | --- | --- |
| 试点 | 3.00 m | 128 | 0 ✓ |
| 基础 3 块 | 4.0–4.5 m | 各 30 | 0 ✓ |
| 住房/商业/科技 11 块 | 4.0–4.5 m | 27–34 | 0 ✓ |

`row` 变体（2 块）没有巷道，已在覆盖表标注。

**截图**（`shots/`）

| 文件 | 内容 |
| --- | --- |
| `p1-city-wide.png` | 基础城区 + 三新区条带全景 |
| `p1-housing.png` / `p1-commercial.png` / `p1-tech.png` | 三个区域各一张 |
| `p1-block-alley.png` | 生成街区的巷道：铺装连续、两壁闭窗、尽头是庭院绿带 |
| `p3-templates-all.png` / `p3-template-a/b/c.png` | 三套完整模板（外围、巷口、内部） |

**性能**（同机位、业务楼与资产加载完成后；无头 Edge + SwiftShader **软件渲染**，帧耗时不代表真机）

| 场景 | 街区 | draw call | 三角面 | 帧耗时中位数 |
| --- | --- | --- | --- | --- |
| 全城鸟瞰（基础+3 条带） | 无 → 有 | 143 → **634** | 105k → **1.83M** | 184 → 1317 ms |
| 新区街面 | 无 → 有 | 32 → **236** | 27k → **823k** | 128 → 435 ms |
| 三套模板并排（模板页） | — | — | — | — |

优化措施（本轮做的）：树 30→12.6k 面、路灯 30.6→6.3k 面、路灯不投影、实例网格启用视锥剔除、
庭院树按面积定密度。全城鸟瞰的 1.83M 是"整城一帧"的最坏情况；街面视角 823k。

**读档/布局同步**：街区完全由 `planCityBlocks(layout)` 从**当前布局**推导，切换存档或扩张后
`blocks.sync()` 按块指纹增删；被抑制的块只在当前 `World` 会话内生效，不写存档。

---

## 7. 未验证 / 已知问题

1. **没有真机行走**：无头浏览器拿不到 Pointer Lock，移动被 `!pointerLocked` 拦死。
   巷道往返是几何采样证明的，脚感需你验收。
2. **全城鸟瞰 634 draw call**：这是"整城一帧"的最坏值。进一步下降需要把同一街区的多栋楼合并成
   更少的批次，属于改建筑工厂的批处理粒度，本轮没动。
3. **`row` 变体（2 块）没有庭院**：进深 17.5 m 装不下"退线 + 楼体 + 庭院"，按规则退化并标注。
4. 基础城区的 `ns` 两侧只剩 4–10 m 的前宽，全部跳过——这是既有业务建筑贴得很近的真实结果，
   没有用长围墙去凑街墙。
5. 阶段 2 的改进是"看得见的增量"，没有做逐风格 A/B 截图对比；五类风格仍共用同一套立面算法，
   差异来自参数。
6. 未来经济扩张直接调用完整模板**仍未接入**：新区条带继续走 `addDistrict` 的固定模板，
   街区只是在条带内按可用空间生长。要让新区直接用 45×45 完整模块，需要把条带宽度从 60 m
   改成 ≥ 108 m，属于规划口径变更，不在本轮授权内。

## 8. Git 状态

```
 M src/content/building-visuals.ts
 M src/world/buildings/{facade,plan,details,assets}.ts
 M src/world/blocks/plan.ts, src/world/blocks/scene.ts
 M src/dev/block-prototype.ts
 M public/assets/SOURCES.md, public/assets/city-realism/manifest.json
 M public/assets/city-realism/models/{street-tree,street-lamp}.glb
?? src/world/blocks/{rect,types,sites,generate,templates}.ts
?? src/dev/template-preview.ts, block-template.html
（另含阶段 1 未提交的既有改动）
```
