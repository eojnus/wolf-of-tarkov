# 阶段 1 验收后三项修复 · 交付说明

工作目录 `C:\Coding\wolf-city-block-realism`，分支 `feature/city-block-realism`。
全城推广、阶段 2 美术、阶段 3 模板的成果全部保留，本轮只做三项针对性修改。

**未提交、未推送、未合并。**

---

## 0. 一句话结论

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 一、完整方形围合模板 | 已实现 | 三套模板各 **12 栋 / 4 个端口 / 21×21 庭院 / 4 条巷道**，包络严格落在 45×45 内 |
| 二、共墙夹缝 | 已消除 | 全城 16 块 + 3 套模板：共墙 **28 对，可见夹缝 0 处，最大 0 m** |
| 三、会话抑制隔离 | 已隔离 | 真实 `CityBlocks`：抑制后普通同步不复活，新会话后恢复 4/4 块 |

构建：`npm run build`（含 `tsc --noEmit`）通过，1.69 s / 145 modules。

本轮按你的要求**没有启动程序**（无浏览器、无 dev server、无截图重拍）。几何与会话的核对是用 esbuild 把**项目源码**打成 node 模块后直接调用真实函数得到的，不是项目外复刻的算术。

---

## 一、完整方形围合模板

### 实现

`generate.ts` 拆成两条互不干扰的路径：

- `generatePerimeterBlock()` → `variant: 'full'`，要求四侧街墙 + 四端口 + 庭院 + 巷道同时成立；
- `generateBlock()` → `variant: 'clipped' | 'row'`，继续服务真实受限空间（已验收的全城推广不受影响）。

两者共用同一个 `finalize()`（家具、树、碰撞、步行域、指纹），所以不存在"预览一套、城里另一套"。

### 几何口径（净用地，不含外围道路）

| 参数 | 值 | 依据 |
| --- | --- | --- |
| 净用地 | 45 × 45 m | 不含道路与人行道 |
| 建筑带进深 | 12 m | 封顶值。带深 13 时东西带长度只剩 19 m，扣 4.5 m 巷道后每半段 7.25 m，排不下 8 m 楼体；12 是"能围合 + 每半段 ≥8 m + 庭院 ≥21 m"的唯一交集 |
| 内部庭院 | 21 × 21 m | 45 − 2×12 |
| 巷道 | 4.0 / 4.5 m | 每侧居中，从街面直通庭院 |
| 转角分配 | 只分配一次 | 南北带横跨全长（含四个转角），东西带缩到 `[z0+12−1.5, z1−12+1.5]`，两端向南北带**搭接 1.5 m** 做实体重叠，避免转角错台 |

`perimeterSpecOf()` 在做任何排布之前先校验三条硬门槛（带深 ≥ 工厂下限 8、庭院 ≥ 族要求、每侧可排前宽 ≥ 2×8），任一条不满足就返回原因，不会生成一个"伪 full"。

### 输出（真实 `generateTemplateBlock` 实测）

| 模板 | 楼栋 | 端口 | 巷道净宽 | 庭院 | 共墙对 | 可见夹缝 | 包络 bbox |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A 住宅庭院 | 12 | 4（四边各 1） | 4.0 m | 21×21 | 12 | **0** | −22.5…22.5 |
| B 商业混合 | 12 | 4 | 4.5 m | 21×21 | 12 | **0** | −22.5…22.5 |
| C 科技办公 | 12 | 4 | 4.5 m | 21×21 | 12 | **0** | −22.5…22.5 |

- `blockInsideRect(plan, 45×45)` 三套全部 `true` —— 楼体、铺装、围墙、树、家具都落在净用地内。
- 每个端口的 `alleyId` 都能在 `paving` 里查到（端口↔巷道一一对应）。
- 四侧计数任一为 0 → 直接 `skip`，不会被标成 `full`。

### 端口数据

```ts
interface BlockPortal {
  id: string;        // `${blockId}-portal-${side}`
  side: 'north' | 'south' | 'east' | 'west';
  center: { x, z };  // 落在净用地边界上
  width: number;     // 巷道净宽
  outward: { x, z }; // 朝外单位向量
  kind: 'alley';
  alleyId: string;   // 对应内部巷道
}
```

### 隔街拼接（外围道路仍由调用方生成）

```
STREET_CORRIDOR = CITY.sidewalkWidth × 2 + CITY.roadWidth = 3 + 12 + 3 = 18 m
相邻模板中心距   = 45 + 18 = 63 m
```

实测：A 中心在原点时东端口 `x = 22.5`；B 中心在 `x = 63` 时西端口 `x = 40.5`；**间距 18.0 m，z 偏差 0**。人行道与车行道走廊正好接上，端口隔街对齐。

`STREET_CORRIDOR` 已作为对外常量导出，预览页的落位间距也从硬编码 62 改成 `nominalSize + STREET_CORRIDOR`（63），避免预览与实际口径再次漂移。

### 版本语义

`blockFamilyById(id, version)` 必须 id + version 同时命中；不命中返回 `null`，`generateTemplateBlock` 返回带 `skip` 的空计划：

```
v99 → skip=["街区族 residential-courtyard@99 不存在或版本不匹配"]  decor=0
目录 → residential-courtyard@1, commercial-mixed@1, tech-office@1
```

**不回落到最新版。**

### 朝向

`front` 只影响风格轮换起点，不影响包络。实测同中心转 90°：包络四值完全一致，风格分配不同（`south` 楼体 front 覆盖 north/south/east/west，`east` 覆盖 south/east/west/north），端口数 4/4。

---

## 二、生成街区的共墙夹缝

### 根因

原实现（一阶段）边找配对边扩展包络：前面的配对把包络撑开之后，后面的配对就不再"恰好接触"，于是一部分接缝被漏掉 —— 这就是你量到的 0.70 m。

### 修复：三段式

1. **两阶段**：先在**未修改**的包络上把所有 `(a, b, side)` 找全（`gap ≈ 0` 且接触长度 > 0.5 m），再统一施加扩展。隔着巷道的两栋（间隙 = 巷宽）永远不判共墙。
2. **同边只扩一次**：同一栋楼在一条边上可能同时贴两栋邻居（转角处），取所需退让量的**最大值**而不是叠加，否则主体会被顶过共墙线 0.35 m，转角反而出现新错台。
3. **转角补缝**：垂直相交的两条带，即便各自按退让量扩展，主体在另一轴仍可能错开（实测办公族 1.03 m）。按主体实测间隙补，两轮至收敛，每边各长一半，单次上限 2.5 m。

扩展只发生在**包络相切**的面。巷道两侧楼体间隙 = 巷宽 ≠ 0，不判共墙，因此巷道净宽不被压缩；扩展方向朝邻居，不朝庭院、不朝街道、不朝业务建筑。

### 实测（真实实现，全城 16 块 + 3 套模板）

```
三套模板：每套 12 对共墙，可见夹缝 0，最大 0 m
全城 16 块：共墙 16 对，可见夹缝 0 处，最大 0 m，最小巷道净宽 3.0 m
```

- 最小巷道 3.0 m 出自东岗试点（手写模板），生成街区为 4.0–4.5 m。
- 扣人物直径 0.84 m 后，最小人物中心可移动宽度 **2.16 m**。
- 逐块明细里 `共墙 1 对 / 可见夹缝 0` 是生成街区（街墙多为 2 栋），`pilot` 是 1 对。

### 四朝向统一

`toDecor()` 一处决定一切：`alongX` 决定局部宽深是否交换，`rotationY = rotationForFront(front)`，`blindFaces` 由 `localFaceOfWorldSide(side, front)` 换算。四个朝向走同一张表，没有为某个方向单独打补丁。

### 未覆盖（如实说明）

**装饰构件级**（基座、檐口、层间线脚、女儿墙、屋顶设备箱）没有逐件量测穿插。共墙两侧都是实体盒子，各构件都在声明包络内生成，主体贴合即墙面贴合、不会留细槽；但我没有做逐构件的数值核对，也没有目视确认。

---

## 三、不同存档 / 新游戏的抑制隔离

### 改动

| 位置 | 改动 |
| --- | --- |
| `blocks/scene.ts` | 新增 `beginDisplaySession()` → `suppressed.clear()` |
| `world/world.ts` | 新增 `beginDisplaySession()` → 清街区抑制 + `layoutFingerprintValue = ''` |
| `world/world.ts` | `resetToSpawn()` 末尾补一次 `resolveSceneryConflict()` |
| `app/game.ts` | `applySnapshot`（读档）与 `startNewGame`（新游戏）各调用一次 |

关键点：**只清集合不够**。`syncLayout` 首行是 `if (fingerprint === this.layoutFingerprintValue) return;`，读同一份布局会被提前返回拦住，抑制过的街区永远回不来。所以同时把指纹置空 —— 它正常值是非空字符串，置空后必不相等，紧接着的同步一定真正执行。

反向约束也守住了：普通 `syncLayout`、公司绑定刷新、城区扩张**都不调用** `beginDisplaySession`，玩家仍站在冲突位置时障碍不会被重新建回来。

`resetToSpawn` 里补的那次 `resolveSceneryConflict()` 是同一套逻辑：最小推出 → 三重校验（完整碰撞集/边界/规划步行域）→ 不通过就抑制该块，绝不传送到未经验证的位置。

### 实测（node 内跑真实 `CityBlocks`，scene/factory/library 用替身，不加载任何资源）

```
总计划 4 块
1 初始同步               块数 4  抑制记录 []
2 抑制 block-base-east-gate  块数 3  抑制记录 [block-base-east-gate]
3 普通同步（应保持）        块数 3  抑制记录 [block-base-east-gate]
4 再普通同步（应保持）      块数 3  抑制记录 [block-base-east-gate]
5 新会话后（未同步）        块数 3  抑制记录 []
6 新会话 + 同步（应恢复）    块数 4  抑制记录 []
```

第 3、4 步证明普通同步不复活；第 6 步证明换会话后恢复。抑制状态不写存档、不改存档版本。

---

## 四、修改文件

**本轮（三项修复）**

| 文件 | 改动 |
| --- | --- |
| `src/world/blocks/generate.ts` | 新增 `generatePerimeterBlock` / `perimeterSpecOf` / `blockInsideRect`；`applyPartyJoints` 重写为两阶段 + 同边取最大 + 转角补缝；`unitWidths` 修正交错逻辑；树位边距随庭院尺度收缩；浅庭院不放绿边 |
| `src/world/blocks/types.ts` | 新增 `BlockPortal`；`BlockPlan` 增 `portals` / `perimeter`；`BlockCoverage` 增 `perimeter` / `portals` |
| `src/world/blocks/templates.ts` | 切到 `generatePerimeterBlock`；导出 `STREET_CORRIDOR`；补拼接示例 |
| `src/world/blocks/plan.ts` | 试点计划补 `portals: []` / `perimeter: false` |
| `src/world/blocks/scene.ts` | 新增 `beginDisplaySession()`；整理 `suppress` 注释 |
| `src/world/world.ts` | 新增 `beginDisplaySession()`；`resetToSpawn` 补冲突检查；跳过日志去重 |
| `src/app/game.ts` | 两个入口各调一次 `beginDisplaySession()`（+4 行） |
| `src/dev/template-preview.ts` | `view=top/alley` 视角；落位间距改用 `STREET_CORRIDOR` |

**此前已交付、本轮未再改**：`src/world/blocks/{rect,sites}.ts`、`src/world/scenery/assets.ts`、`src/world/scene.ts`、`src/world/buildings/*`、`src/content/{city-blocks,city-scenery,config,building-visuals}.ts`、`public/assets/**`、`block-prototype.html`、`block-template.html`、`src/dev/block-prototype.ts`。

---

## 五、验证记录

| 项 | 方式 | 结果 |
| --- | --- | --- |
| 生产构建 | `npm run build`（含 `tsc --noEmit`） | 通过，1.69 s，145 modules，bundle 1,362.66 kB / gzip 386.12 kB |
| 三套模板围合 | `tools/geo-audit.mjs`（esbuild 打包真实源码，node 直调） | 各 12 栋 / 4 端口 / 4 巷 / 21×21 庭院 / bbox 在 45×45 内 |
| 端口数据 | 同上 | 4 个端口，四边各 1，`alleyId` 均可解析到铺装 |
| 朝向 | 同上 | 转 90° 包络一致、风格不同、端口 4/4 |
| 隔街拼接 | 同上 | 走廊 18 m，中心距 63，端口间距 18.0，z 偏差 0 |
| 版本拒绝 | 同上 | v99 → skip + 原因，decor=0 |
| 同输入稳定 | 同上 | 两次生成 key 相同、decor 逐字段相同 |
| 共墙夹缝 | 同上（按真实立面退让量还原主体面） | 28 对共墙，可见夹缝 0，最大 0 m |
| 巷道净宽 | 同上 | 最小 3.0（试点），生成街区 4.0–4.5，余量 2.16 m |
| 会话抑制 | `tools/session-audit.mjs`（真实 `CityBlocks`） | 4→3→3→3→3→**4**，见上表 |
| 截图 | **未重拍** | 见"已知问题 1" |
| 实机行走 | **未执行** | 按你的要求本轮不启动程序 |
| 性能 | **未复测** | 同上 |

复现命令（都不启动游戏）：

```bash
cd C:\Coding\wolf-city-block-realism
npx esbuild .tmp-entry.ts --bundle --format=esm --platform=node --outfile=tools/.bundle.mjs
node tools/geo-audit.mjs
node tools/session-audit.mjs
```

两个 `.mjs` 在工作区 `tools/` 下，不进仓库。esbuild 由 `npx` 临时执行，**未写入 `package.json`，未改锁文件**。

---

## 六、已知问题

1. **截图与当前代码不完全一致。** `shots/p3-a-top.png`、`p3-a-alley.png`、`p3-c-corner.png` 拍摄时围合结构已是 bandDepth=12，但共墙逻辑还是"一阶段"版，此后又改了风格分配与转角搭接。要看最终画面需重拍一次。
2. **转角搭接未目视确认。** 东西带向南北带搭接 1.5 m 是两栋实体重叠（有意为之，不是"各生成一栋重叠楼"），转角处南北带楼体的侧墙会比东排街面线突出约 1.65 m 形成错台。数值上无缝，观感需要你确认。
3. **装饰构件级穿插未逐件核对**（基座、檐口、线脚、女儿墙）。共墙两侧主体已贴合，构件都在包络内生成，但没有逐件量测。
4. **`row` 变体仍无庭院**（可用进深不足），全城 1 处：`stage-2-ns-west-34`，进深装不下，已按裁剪变体标注。
5. **全城 41 条站点被跳过**，原因均为「前宽 < 16 m」或「可用进深 < 13 m」（被业务建筑、路口、储备地块切断），带原因记录，没有整片城区静默消失。
6. **未来经济扩张仍未接入完整模板**：新区条带仍走 `addDistrict` 的 60×110 固定模板，街区在条带内生长；要让新区直接用 45×45 模块，需把条带净宽提到 ≥108 m，属规划口径变更，未做。
7. **外围道路未生成**：模板只给端口（中心/宽度/朝外方向），道路仍由 `scene.ts` 的路网生成，按现有道路坐标不动。

---

## 七、Git 状态

```
分支 feature/city-block-realism，无提交、无推送、无合并
14 个已跟踪文件修改（+807 / −156）
新增：block-prototype.html、block-template.html、
      8 个资源文件（树木 glb、路灯 glb、沥青 3 张、铺装 3 张）、
      src/content/{city-blocks,city-scenery}.ts、
      src/dev/{block-prototype,template-preview}.ts、
      src/world/blocks/（7 个文件，2,717 行）、
      src/world/scenery/
```

工作区另有 `tools/*.mjs` 与 `shots/` 等核对材料，均在项目之外（工作区目录），不在仓库内。
