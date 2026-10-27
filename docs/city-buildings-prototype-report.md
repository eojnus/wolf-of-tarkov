# 城市写实化 · 模块化建筑原型交付报告（首轮修正 + 第二轮低楼顶部修正）

分支 `feature/city-modular-buildings` · HEAD `f711af57c271d02f3c05714cd6183ffd04c7f729`（未提交改动）

- **首轮修正**：R1 尺寸输入、R2 声明空间、R3 并发资源、R4 失败重试、R5 取消与预览代次，另含报告更正。
- **第二轮修正**（当前）：只修剩余的 R2 —— 低楼顶部包络。根因是 `roofReserve` 允许被压到女儿墙的 60%，
  而屋顶按完整女儿墙 + 0.12 米压顶生成，压顶还从墙顶再冒 0.06 米。已改为「压顶算在女儿墙总高之内、
  顶部预留与楼层共用同一套标高」，并让低楼按「先减楼层 → 再取消屋顶设备 → 再压薄女儿墙 → 仍不行则拒绝」降级。
  详见第 4 节与 9.3b。

**未接正式地图、未改存档、未改 UI/应用层、未加依赖。**

---

## 0. 结论摘要

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| R1 工厂接受真实规划尺寸 | 已修 | 新增 `world/buildings/plan.ts`：宽/深/高是输入，层数、层高、开间、退让、屋顶占位由它推导 |
| R2 总外观满足声明空间 | 首轮已修平面与高楼竖向；**第二轮补齐低楼顶部** | 7 组尺寸（含 3 组低楼、2 组非预设）全部 `inside = true`，maxY 实测 = 声明值，越界 0 |
| R3 构件级并发去重与归属 | 已修 | 按「模型 + 节点名」共享在途 Promise；并发两栋楼拿到同一份几何（uuid 相同） |
| R4 材质组失败可重试 | 已修 | 注入首次失败 → 第二次成功，attempts = 2，半成品材质就地释放 |
| R5 在途请求与重建失效 | 已修 | `begin()` 返回可取消句柄；取消的楼拒绝、并发的楼正常完成；预览切基线后旧结果不挂载 |
| 报告更正 | 已改 | 8 个生产资源文件、只写有记录的性能数据、撤回「相同三角形数 = 已验证确定性」、重写接入契约 |

---

## 1. 基线与环境（只读核对，与上轮一致）

- 工作目录 `C:\Coding\wolf-city-buildings` / 分支 `feature/city-modular-buildings` / HEAD `f711af5`；
  工作区只有本分支的未提交改动，未执行 reset / clean / commit / merge / push，未进入 main 与 UI 工作树。
- Node v22.22.2 / npm 10.9.7；`node_modules` 由上轮 `npm ci` 按现有 lock 安装，**未改** `package.json` / lock。
- 自动化：隔离目录安装 `puppeteer-core` 驱动本机 Edge（ANGLE / AMD Radeon，D3D11）；一次性脚本跑完即删。

---

## 2. 本轮修改的文件

| 文件 | 本轮变化 |
| --- | --- |
| `src/content/building-visuals.ts` | 由「固定原型」改为「**风格样例**」：层高、开间偏好、窗洞比例、占地退让、阳台/入口/屋顶做法、材质与配色；删除写死的 footprint / storeys |
| `src/world/buildings/plan.ts` | **新增**：`resolveBuildingPlan(规划尺寸 + 风格) → ResolvedPlan`，纯函数，输出主体退让、层数层高、开间、阳台开间、入口尺寸、屋顶占位、材质键与种子；第二轮重写竖向：顶部预留含压顶、楼层精确填满墙顶、低楼按层数优先降级、越界输入抛 `PlanRangeError` |
| `src/world/buildings/facade.ts` | 改为消费 `ResolvedPlan`；立面中心随主体偏移，墙面构件一律在主体范围内 |
| `src/world/buildings/details.ts` | 阳台按开间选真实栏杆型号并等比适配；外挂楼梯改到角部且整体内移；屋顶压顶下沉 0.08 保证顶面不越界；第二轮把女儿墙拆成「墙体（总高 − 压顶）+ 压顶（落在总高之内）」 |
| `src/world/buildings/factory.ts` | 请求改为「尺寸 + 风格」；`begin()` 可取消句柄与代次校验；新增 `envelopeOf / measureWorldBounds / compareBounds / inspectVisual` |
| `src/world/buildings/assets.ts` | 构件按「模型 + 节点名」在途 Promise 共享；材质按真实参数键缓存且失败移除；销毁期间的结果就地释放 |
| `src/world/buildings/types.ts`、`index.ts` | 请求/句柄/包络报告类型与对外入口 |
| `src/dev/building-prototype.ts` | 传入规划尺寸；重建用代次 + 取消；信息层显示层数/开间/包络核对结果；新增阳台近景机位 |
| `public/assets/city-realism/manifest.json` | 文件计数更正为 8（2 GLB + 6 JPEG），体积按实算保持 6.49 MiB |
| `public/assets/SOURCES.md` | 同上更正 |
| `docs/city-buildings-shots/*` | 重拍本轮受影响的视图，删除与现几何不符的旧图；`perf.json` 重写并同时保存 vsync 开/关两组样本 |

未修改：`src/world/scene.ts`、`src/world/world.ts`、`src/ui/**`、`src/app/**`、`src/features/**`、
`src/infrastructure/**`、`src/content/config.ts`、`src/content/districts.ts`、`package.json`/lock、既有模型与图标。

---

## 3. R1：工厂真实接受规划尺寸

**接口**（`world/buildings/plan.ts`）：

```ts
resolveBuildingPlan({
  buildingId, kind, width, depth, height, templateVersion, styleId?
}) => ResolvedPlan
```

`width / depth / height` 就是只读 `LayoutBuilding.size`。`styleId` 只决定**立面语言**（窗洞比例、层高偏好、
阳台/入口/屋顶做法、材质），**不提供尺寸**。省略 `styleId` 时按 `kind` 与高度选一个样例（`defaultStyleFor`）。

解析规则（全部由尺寸推导，没有整楼缩放）：

1. **占地退让**：主体 = 声明空间减去 `frontInset / backInset / sideInset`（各不小于 0.15 m，覆盖基座与压顶外挑）；
   正立面预留供给阳台、雨棚、台阶，背立面预留供给外挂楼梯；两者之和超限时按比例回收，主体不小于 6 m。
2. **层数与层高**：`墙顶 = 声明高度 − 顶部预留`；`标准层数 = round((墙顶 − 首层高) / 目标层高)`，
   层高按可用高度**均分**，实际值落在目标值的 −7%～+7% 区间（实测 2.90 / 2.843 / 3.433）。
3. **开间**：`max(2, round(主体宽 / 偏好开间))`，并夹紧到 2.2～6.5 m；正面/背面用主体宽、两侧用主体进深。
4. **立面比例**：窗台/窗顶随层高夹紧（低层高时不会顶穿楼板）；窗间墙、窗框随开间收敛。
5. **阳台**：深度 `min(风格深度, frontInset − 0.12)`；开间按实际开间数从 `middle / ends / every-other` 派生。
6. **入口**：宽度、高度、雨棚深度、台阶级数全部夹到地面层与前立面预留以内。
7. **屋顶**：设备从 `wallTop` 起算，顶面 ≤ 声明高度；平面尺寸按主体缩小；屋顶余高 < 1.25 m 时不摆室外机。

同一套模块按另一组合法尺寸生成的实测（`perf`/验证脚本输出）：

| 输入尺寸 | 风格 | 层数 | 标准层高 | 正立面开间 | 顶部预留 | 设备 |
| --- | --- | --- | --- | --- | --- | --- |
| 18.84×12×19.4 | 板式住宅 | 6 | 2.90 | 4 | 1.50 | 水箱 1.50 |
| 14.2×13×26.1 | 点式公寓 | 8 | 2.843 | 3 | 2.60 | 机电房 2.60 |
| 20×16×38.5 | 办公楼 | 10 | 3.433 | 5 | 2.80 | 机电房 2.80 |
| 27.5×18×44 | 办公楼 | 11 | 3.640 | 7 | 2.80 | 机电房 2.80 |
| 10×9×9 | 点式公寓 | 2 | 2.800 | 2 | 2.60 | 机电房 2.60 |

**材质缓存与参数的关系**：材质键 `plan.materialKey` 由「墙体贴图 + 次要贴图 + 五个配色 + 亮度」拼成，
缓存按它索引，不再按预设 id 命中；不同参数不会复用同一份材质，相同参数只建一次。

---

## 4. R2：总外观满足声明空间

**做法**：装饰先占位，主体后收缩。

```
声明空间 (W × D × H)
  ├─ 平面：主体 = (W − 2·sideInset) × (D − frontInset − backInset)
  │        frontInset 容纳：阳台挑出 / 雨棚 / 台阶（三者取最大）
  │        backInset  容纳：外挂疏散楼梯（平台 + 楼梯按真实构件深度 1.62 m 预留 1.7 m）
  │        sideInset  容纳：基座 0.05、层间线脚 0.08
  └─ 竖向：顶部预留 roofReserve = max(女儿墙总高（含压顶）, 屋顶设备高度)
           墙顶 wallTop = H − roofReserve
           女儿墙：墙体 = 总高 − 压顶，压顶落在总高之内 → 最高点 = wallTop + 总高 = H
           设备：从 wallTop 起算，顶面 = wallTop + 设备高 ≤ H
           楼层：总高**恰好**填满 wallTop，不再「楼体算完再往上加装饰」
```

**低楼降级顺序**（第二轮新增，不抬高声明高度、不放宽包络、不放宽容差）：

| 步骤 | 触发条件 | 处理 |
| --- | --- | --- |
| ① 层数优先 | 带设备会减少楼层（如 8 m 办公楼：带设备 1 层、不带设备 2 层） | 取消屋顶设备，保留完整女儿墙 |
| ② 薄女儿墙 | 连「1 层 + 完整女儿墙」都放不下 | 女儿墙压到最小可施工高度 0.35 m |
| ③ 明确拒绝 | 连②也放不下（H < 2.4 + 0.35 = 2.75 m） | 抛 `PlanRangeError` 并写明支持区间，不静默扩大尺寸 |
| 输入校验 | 宽/深/高超出 8–80 / 8–60 / 6–120 | 同样抛 `PlanRangeError`，不再 `clamp` 后假装成功 |

**实测（`inspectVisual` = 实际几何世界包围盒 vs 声明空间；第二轮四组为主）**：

| 尺寸 | 说明 | 层数 | maxY 声明 / 实测 | 实测越界 x / y / z |
| --- | --- | --- | --- | --- |
| 13×10×8 | 办公楼低楼（已有建筑尺寸） | 2 | 8.000 / 8.000 | 0 / 0 / 0 |
| 12×10×7 | 办公楼低楼（已有建筑尺寸） | 2 | 7.000 / 7.000 | 0 / 0 / 0 |
| 8×8×6 | 住宅下限尺寸（LIMITS 最小值） | 2 | 6.000 / 6.000 | 0 / 0 / 0 |
| 18.84×12×19.4 | 现有高楼样例（板式住宅） | 6 | 19.400 / 19.400 | 0 / 0 / 0 |
| 14.2×13×26.1 | 点式公寓（首轮） | 8 | 26.100 / 26.100 | 0 / 0 / 0 |
| 20×16×38.5 | 办公楼（首轮） | 10 | 38.500 / 38.500 | 0 / 0 / 0 |
| 27.5×18×44 | 非预设尺寸（首轮） | 11 | 44.000 / 44.000 | 0 / 0 / 0 |

预览页信息层逐行显示「包络内 / 越界 x y z」，可直接在浏览器里复核。

**碰撞与声明空间的关系**：`BuildingVisual.envelope` 就是声明空间的世界 AABB（只由尺寸与朝向决定），
正式接入时把它写进现有 `handle.collider` 即可；`inspectVisual` 用于回归核对，不进入每帧。
不再有「装饰不参与碰撞所以可以越界」的做法。

---

## 5. R3 / R4 / R5：生命周期契约

### R3 构件并发与归属

- 构件缓存键 = `模型 id / 节点名`，**每个构件只有一份在途 Promise 与一份结果**；
  两栋楼并发需要同一段栏杆时共享同一次抽取，不再各自 clone 后互相覆盖。
- 请求的 `names` 与缓存一一对应，不会返回与请求无关的残缺缓存；某个构件缺失/失败会被记录并跳过，
  调用方按 `instances.has()` 做程序化降级。
- 资产库销毁期间返回的构件/贴图/模型结果**就地释放并拒绝**，不会留下无主几何。
- 单栋 `dispose()` 只释放自己的合批几何与实例矩阵（`disposeBuildingGroup`），共享几何/材质/贴图不受影响。

### R4 材质组重试

- `getMaterials(key, style)` 失败时**从缓存移除该 Promise**，并把这次已创建的半成品材质当场 `dispose()`；
  下次调用会重新尝试（无无限重试、不吞错误）。

### R5 在途请求与重建失效

```ts
const handle = factory.begin(request);   // 返回 { result, cancelled, cancel() }
handle.cancel();                         // 只取消这一栋
await handle.result;                     // 取消 → 以 VisualLoadCancelled 拒绝
```

- 令牌（`RequestToken`）只存在内存，**不写入 `LayoutBuilding` / `GameState` / 存档**。
- 每个 `await` 之后都校验「未取消 + 工厂未销毁 + 代次一致」；组装完成后再校验一次，失效则释放本楼几何并拒绝。
- 单栋取消不影响其他楼共享的贴图/模型加载（由资产库去重，不随请求取消）。
- 预览页重建：先 `cancel()` 上一轮句柄，再递增自己的 `buildGeneration`；结果回来时若代次已变，
  不挂载并 `dispose()`，因此「原型加载中切基线」不会把原型挂到基线舞台上。

---

## 6. 真实资产清单与许可（未变，仅更正计数）

全部来自 Poly Haven，**CC0 1.0**（可商用、可修改、可再分发，署名非强制；<https://polyhaven.com/license>）。
机器可读清单 `public/assets/city-realism/manifest.json`，人读版本在 `public/assets/SOURCES.md` 新增章节。

| 资产 | 作者 | 用途 | 本地文件 |
| --- | --- | --- | --- |
| Modular Fire Escape `modular_fire_escape` | Juniix | 住宅阳台金属栏杆（按开间择一型号，等比缩放 0.8–1.2）；办公楼背面外挂疏散楼梯的平台栏杆、楼梯、爬梯 | `models/fire-escape-modular.glb`（2.51 MB，8,086 tri） |
| Utility Box 01 `utility_box_01` | James Ray Cock | 仅几何：屋顶室外机、入口侧贴墙设备箱（材质用项目金属） | `models/utility-box.glb`（0.14 MB，4,404 tri） |
| Plastered Wall `plastered_wall` | Amal Kumar | PBR 材质：住宅/公寓墙面、女儿墙、屋顶；办公楼裙房基座与雨棚 | `textures/plaster-wall-{diffuse,normal,arm}-1k.jpg` |
| Rectangular Facade Tiles `rectangular_facade_tiles` | Charlotte Baglioni | PBR 材质：办公楼标准层外墙板；公寓深色基座与雨棚 | `textures/facade-tiles-{diffuse,normal,arm}-1k.jpg` |

**生产资源 8 个文件**（2 GLB + 6 JPEG），合计 **6,806,323 B = 6.49 MiB**（预算 15 MiB）。
对比上一版报告：文件数由「7」更正为「8」，体积数值不变。
贴图显存估算 **48.24 MiB**（9 张 1024² RGBA + mipmap 链，按 宽×高×4×1.34 计），预算 64 MiB。

---

## 7. Skill 使用记录（与上轮相同，未重复读取）

`MengTo/Skills` @ `a45892d2fdadab75b31fb16abecc02f101b31c43`（2026-10-25）。`raw.githubusercontent.com`
在本机被代理阻断，改用 GitHub Contents API 读取全文；未把技能库复制进仓库。

| 路径 | 应用点 |
| --- | --- |
| `game-development/build-hybrid-game-assets/SKILL.md` | 资产分类（构件/道具用导入网格，立面用程序化）、导入前归一化比例、工厂暴露命名部件与稳定包络 |
| `game-development/optimize-threejs-games/SKILL.md` | 同条件测量（固定机位/视口/DPR/光照）、按材质合批、复测同一路径、测完关闭临时服务 |
| `game-development/build-mobile-threejs-games/SKILL.md` | 质量预算与显存估算；小视口只在需要时检查 |
| `web-design/threejs-towers/SKILL.md` | 构件参数化、按材质合批、米制 UV、按材质数反查「是否漏共享材质」、切换风格时检查几何释放 |

未采用：古建屋顶/裁剪面施工动画/演示 UI；技能的「十个小构件写共享顶点数组」写法（改用 `metricBox` +
`mergeGeometries`）；多浏览器矩阵与长时间压测（项目规则禁止）。

---

## 8. 性能（本轮重测，数据全部有记录）

条件：本机集成显卡 `ANGLE (AMD, AMD Radeon(TM) Graphics, D3D11)`；1280×720、DPR 1、fov 52、
机位 `ground`（三栋同屏）；光照与正式场景一致（Hemisphere 1.15 / Directional 1.5 / Ambient 0.18，无阴影无后处理）。
数据文件：`docs/city-buildings-shots/perf.json`（本次会话内同时保存 vsync 开、关两组样本）。

| 场景 | draw calls | triangles | geometry | textures | p50 | p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 基线（3 盒 + 地面/网格/比例尺） | 8 | 74 | 13 | 0 | 1.4 ms | 2.4 ms |
| 模块化原型（三栋同机位） | 33 | 92,806 | 31 | 9 | 2.6 ms | 3.8 ms |
| **增量（三栋建筑 + 专属装饰）** | **+25** | **+92,732** | +18 | +9 | **+1.2 ms** | **+1.4 ms** |

上面两行是**关闭垂直同步**的样本；开启 vsync 时基线 p50 16.7 / p95 17.1 ms、原型 p50 16.7 / p95 17.0 ms
（都锁在 60 fps 上限处，看不出差异，所以用关闭 vsync 的数据看余量）。

单栋（同一次采样）：板式住宅 9 dc / 25,364 tri；点式公寓 8 dc / 19,740 tri；办公楼 11 dc / 47,664 tri。

预算对照：draw call 25 ≤ 60 ✔；三角形 92,732 ≤ 150k ✔；纹理显存 48.24 MiB ≤ 64 MiB ✔；静态资源 6.49 MiB ≤ 15 MiB ✔。

未做：阶梯式全城压测、多分辨率矩阵、真机移动性能。未发现需要额外条带样本的异常。

---

## 9. 验证记录（区分类型）

### 9.1 源码审查（已做）

- 数据流：`只读尺寸 → resolveBuildingPlan → 模块工厂 + 共享资源 → 视觉对象 + 声明包络`；无业务写入。
- 种子路径：`hashSeed([buildingId, templateVersion, rulesVersion])` + `mulberry32`；
  全流程无 `Math.random`、无时间、无遍历顺序、无 GDP/companyId。
  **说明**：这只证明实现里没有非确定性来源，**不等于**已经验证外观确定性；本轮没有做逐字节比对。
- 生命周期：`begin/cancel/dispose` 三处代次与令牌校验点、构件与材质的在途/失败/销毁分支。

### 9.2 类型检查与生产构建（每轮各一次，均在最终代码上执行）

- `npm run typecheck` → 通过（第二轮修正后重跑一次）；
- `npm run build` → 通过（121 modules，`dist/bundle/index-*.js` 1,262.76 kB / gzip 352.49 kB）。
  预览页不在生产构建入口内（`vite build` 只打包 `index.html`），未改 `vite.config.ts`。

### 9.3 局部实际验证（首轮：一次性脚本，跑完即删，共 4 项 + 1 项参数检查）

> 说明：以下五项属于首轮 R1/R3/R4/R5，本轮**未重跑**（复验已通过，只做源码保持）。

| 检查 | 方法 | 结果 |
| --- | --- | --- |
| 参数不变量 + 包络 | 5 组尺寸解析 + 实际建楼测包围盒 | 5 组「顶部预留闭合、设备不超高、主体不超宽、进深闭合、阳台/雨棚/台阶不超预留、层高 ≥ 2.3」全部通过；5 组 `inside = true`，越界 0 |
| 并发构件归属 | 两次并发 `create` 同一风格不同尺寸 | 两栋楼的实例几何 uuid 相同；资产库构件数 5（4 消防梯构件 + 1 设备箱），实到实例几何 2 份 |
| 材质失败重试 | 注入首次 `loadTextureSet` 失败 | 第一次报错，第二次成功，调用次数 2，无残留材质泄漏报错 |
| 单栋取消 | 两栋并发，取消其一 | 被取消者 `VisualLoadCancelled`，另一栋正常 `resolved` |
| 预览重建失效 | 原型加载中立即切基线 | 4 秒后 `mode = baseline`、`drawCalls = 8`、舞台上没有原型对象（`bounds` 为空），无 console 错误/警告 |

### 9.3b 低楼顶部包络核对（第二轮，一次，四组）

方法：`resolveBuildingPlan` + 真实工厂建楼 + `inspectVisual`（实际几何世界包围盒 vs 声明空间），
脚本一次性运行后删除，未留在仓库。

| 输入 | 说明 | 层数 | 首层 / 标准层 | 女儿墙（含压顶） | 墙顶 | 顶部预留 | 屋顶设备 | maxY 声明 / 实测 | inside |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 13×10×8 | 办公楼低楼（复验给出的失败用例） | 2 | 4.30 / 2.40 | 1.30（压顶 0.12） | 6.70 | 1.30 | 取消 | 8.000 / 8.000 | true |
| 12×10×7 | 办公楼低楼（复验给出的失败用例） | 2 | 3.30 / 2.40 | 1.30（压顶 0.12） | 5.70 | 1.30 | 取消 | 7.000 / 7.000 | true |
| 8×8×6 | 住宅下限（LIMITS 最小值，复验给出的失败用例） | 2 | 2.60 / 2.40 | 1.00（压顶 0.12） | 5.00 | 1.00 | 取消 | 6.000 / 6.000 | true |
| 18.84×12×19.4 | 现有高楼样例 | 6 | 3.40 / 2.90 | 1.00（压顶 0.12） | 17.90 | 1.50 | 水箱 1.50 | 19.400 / 19.400 | true |

四组的 x / y / z 越界均为 **0.0000**，输入尺寸未改动、未放大包络、未放宽 `compareBounds` 的 0.001 m 容差。
修正前后对比：`8×8×6` 由 maxY ≈ 6.46 降到 6.00；`13×10×8` 由 ≈ 8.56 降到 8.00；`12×10×7` 由 ≈ 7.58 降到 7.00。

同一次脚本只做纯函数调用，确认三种展示原型的参数**未变**（因此不重拍整套截图）：
板式住宅 6 层 / 标准层 2.900 / 开间 4 / 预留 1.5（水箱）；点式公寓 8 层 / 2.843 / 开间 3 / 预留 2.6（机电房）；
办公楼 10 层 / 3.433 / 开间 5 / 预留 2.8（机电房）。

### 9.4 视觉核对（首轮一次局部 + 第二轮仅俯视一张）

只重拍受本轮几何改动影响的视图，不重拍未变化的整套：
`01-prototype-ground`（三栋同屏 + 包络结论）、`02-prototype-aerial`、`03-prototype-closeup`、
`05-prototype-balcony`（阳台栏杆近景，用于确认按开间选型后栏杆不再缺失）、`07-prototype-entrance`、
`08-prototype-rear-office`、`04-baseline-ground`（基线对照）。

已删除与现几何不符的旧图：`05-prototype-apartment`、`06-prototype-office`、`09-escape-probe`、
`10-prototype-mobile-390x844`。**小视口（移动端宽度）未复测**，因为相机与 UI 逻辑未改，
但几何变化后旧截图不再代表现状，故不保留。

第二轮只改了女儿墙与压顶的竖向切分（总高不变）和低楼的层数/设备取舍，
三种展示原型的层数、层高、开间、预留与设备全部保持原值。为确认屋顶细节没有被切坏，
**只重拍了 `02-prototype-aerial.png` 这一张**（俯视看女儿墙、压顶、水箱与机电房），
其余截图未动；画面与上一版一致，顶部仍然平齐。

### 9.5 未执行（如实列出）

真机移动端、多浏览器矩阵、自动化游玩、全流程回归、逐字节确定性比对、
房地产/月结/存档回归、全城性能压测。

第二轮按复验要求**未重跑**：并发构件归属、材质失败重试、单栋取消、预览代次、性能采样、
整套截图、经济与房地产回归。

---

## 10. 正式接入的最小方案（按当前真实接口重写）

上一版报告里「把 `world.modelGeneration` 传进工厂即可」「15 行可接入」的说法不成立，现更正如下。

1. **调用点**（`scene.ts` 的 `buildBuilding` 分支，或 `world.ts` 的加载流程）：
   ```ts
   const handle = factory.begin({
     buildingId: building.id,
     styleId: defaultStyleFor(building.kind, building.size.height),
     size: { width: building.size.width, depth: building.size.depth, height: building.size.height },
     kind: building.kind,
     templateVersion: layout.layoutVersion,     // 已存城区模板版本，进种子
     position: building.position,
     rotationY,                                  // 由 facadeAxis 求出的入口朝向
   });
   ```
2. **异步保护**：`world` 在 `syncLayout` / `beginModelLoading` 里对上一轮 `handle.cancel()`，
   并保留现有 `layoutRevision + modelGeneration` 判定（工厂内部的令牌是**它自己那一层**，
   不与 `world` 的代次互换）。两者同时满足才挂载。
3. **挂载**：`visual.group` 加入 `handle.group`；把 `visual.envelope` 写进**现有 `handle.collider` 对象**
   （保持引用不变，交互与摄像机遮挡照旧）；不需要再按模型包围盒反算碰撞，因为包络就是声明空间。
4. **释放**：新增分支 `if (handle.visual) factory.release(handle.visual) else disposeObject(handle.group)`。
   **不能**把工厂产物交给 `scene.disposeObject`（它会 `traverse` 并 dispose 共享材质与贴图）。
   `CitySceneImpl.dispose()` 末尾补 `factory.dispose()`。
5. **旧 GLB 路径并存**：`applyBuildingModel` 与 `content/scene-scale.ts` 仍然服务基础城区既有五栋；
   新工厂只接管「`model === null` 或显式选择模块化风格」的建筑，两者互斥。
6. **行为不变**：不改 `cityLayout`、不改交互 id、不改读档顺序；`SAVE.formatVersion` 仍为 18。

**拟由架构负责人并入文档的条目**（本轮未改三份共享文档）：

- `architecture.md` §1：`world/buildings/` = 「规划尺寸 → 视觉方案 → 视觉对象」的表现层工厂；`plan.ts` 是唯一的尺寸解析入口。
- `architecture.md`（建筑/场景一节）：声明包络 = 规划尺寸；装饰先占位再排布；屋顶设备计入高度；包络写入现有 collider。
- `contracts.md` 新增「建筑视觉契约」：种子 = 建筑 id + 模板版本 + 视觉规则版本；不读写经济切片；
  视觉数量不反推住房套数；`disposeObject` 不适用于共享材质；存档格式不变。
- `decisions.md`：「为什么把原型降级为风格样例」「为什么退让而不是扩大 collider」「为什么对无 IBL 的金属做近似」。

---

## 11. 资源缺口、已知限制、待决策

1. 立面基础（墙、楼板、窗）仍是程序化几何；Poly Haven 的 `modular_urban_apartments_facade`
   （27 万三角面、147 节点、4 套贴图）超出本轮预算，未采用。
2. 预制楼梯构件高 4.0 m，与办公楼 3.6 m 层高靠平台位置吸收 0.4 m 差；若要严格对齐需要可裁切楼梯段。
3. 场景没有 IBL，玻璃与 GLB 金属仍是近似（玻璃低金属度 + 轻微自发光；GLB 金属度 ≤ 0.32）。
4. 层高按可用高度均分，标准层高会偏离目标值最多约 −7%（如公寓 3.05 → 2.843）；若要求严格等于目标层高，
   需要允许顶部出现非整层的设备层，这属于参数取舍，需要架构负责人定口径。
   **低楼（高度刚好够 2 层）时标准层高会压到下限 2.40 米**，这是「顶部空间优先」的必然取舍。
5. 支持区间（超出即抛 `PlanRangeError`，不再静默夹紧）：宽 8–80 m、深 8–60 m、高 6–120 m；
   高度下限再受「至少 1 层（2.4 m）+ 最小女儿墙（0.35 m）= 2.75 m」约束，当前 6 m 下限已高于该值。
6. 低楼会**放弃屋顶设备**（水箱 / 机电房）以保住楼层数；这是有意的取舍，不是漏建。
   若某个低楼必须有设备，需要提高该建筑的声明高度或改用不带设备的风格。
7. 预览页不在生产构建入口，只能 `npm run dev` 访问。
8. 未做逐字节确定性比对；种子路径只做了源码审查。

**待决策**：接入顺序（先住房新区还是连基础城区一起）、是否允许在接入时给 `handle` 增加内存态
`visual`/`visualGeneration` 字段、证据目录是否入库、是否引入 IBL 与 2K 近景贴图（会突破当前显存预算）。

---

## 12. 复现

```bash
cd C:/Coding/wolf-city-buildings
npm ci && npm run typecheck && npm run build
npx vite --port 5183
# http://localhost:5183/building-prototype.html?dpr=1&mode=prototype&view=ground
```
