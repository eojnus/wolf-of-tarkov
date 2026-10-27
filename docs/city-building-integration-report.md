# 正式地图建筑美术接入 · 交付报告

分支 `feature/city-building-integration` · 工作目录 `C:\Coding\wolf-city-integration`
基线 `7e07d29`（本地 main，含房地产 v18、UI 菜单重组、建筑原型）→ 任务书提交 `dc61c09`
→ 本次实现提交 `7dd1be8` → 验收 P2 修正提交 `7b17f3f`（未 push、未合并、未动 main）。

**结论：正式地图（基础六类 + 三个新区）全部走模块化楼体；旧整栋 GLB 退出成功路径；
房地产 v18、存档格式、业务公共接口与 UI 均未改动。**

---

## 1. 基线与改动范围

- 开工前核对：`git status` 干净、`git branch --show-current` = `feature/city-building-integration`、
  HEAD = `dc61c09`（任务书）。未切 main、未合并、未 reset/clean、未 push、未进入其他工作树。
- 依赖：`npm ci` 按现有 `package-lock.json` 安装（Node v22.22.2 / npm 10.9.7），未改 `package.json` 与 lock。
- 改动文件（全部在任务书允许范围内，`git status` 可复核）：

| 文件 | 改动 |
| --- | --- |
| `src/content/building-visuals.ts` | 新增 `civic-4`（市政）、`retail-3`（商业沿街）；`defaultStyleFor` 改为六类显式映射；`BUILDING_VISUAL_RULES_VERSION` 1 → 2 |
| `src/world/buildings/layout-adapter.ts` | **新增**：只读布局 → 视觉请求（入口朝向、90° 宽深交换、城区模板版本、视觉指纹） |
| `src/world/buildings/plan.ts` | 高度下限 6 → 5 m；单层建筑取消屋顶设备；错误文案随支持区间更新 |
| `src/world/buildings/details.ts` | 新增门头招牌（底板并入合批、贴面自有材质），位置取雨棚上沿→首层窗台线 |
| `src/world/buildings/facade.ts` | 橱窗带上下沿收成一处常量，供橱窗与招牌共用 |
| `src/world/buildings/factory.ts` | 生成招牌并计入 stats；招牌材质/贴图随本楼释放；90° 整数倍包络取整避免浮点尾巴 |
| `src/world/buildings/types.ts` | 请求新增可选的 `signLabel`（商店招牌文字） |
| `src/world/buildings/index.ts` | 导出适配器与朝向函数 |
| `src/world/scene.ts` | handle 新增内存字段（visual/key/state）；新增 `attachBuildingVisual` / `detachBuildingVisual` / `releaseBuildingHandle`；删除旧 `applyBuildingModel`；场景持有工厂并在 `dispose` 时先逐栋释放 |
| `src/world/world.ts` | 持有唯一工厂；`beginVisualLoading` / `loadBuildingVisual` / `isStaleVisual` / `settleVisualLoad` / `keepPlaceholder` / `cancelVisualRequests` / `visualReport`；删除 GLTFLoader 与旧模型加载 |
| `docs/architecture.md`、`docs/contracts.md`、`docs/decisions.md`、`docs/scene-scale.md` | 把「尚未接入」改为实际完成状态；保留历史测量与 D86 作为历史；新增 D87 |
| `public/assets/SOURCES.md`、`public/assets/city-realism/manifest.json` | 用途说明与「旧整栋 GLB 已退出渲染」的更正；**未新增任何美术资源** |
| `docs/city-buildings-shots/09-integration-base-city.png`、`10-integration-expansion-lowrise.png` | 两张有说明的实际截图（见第 7 节） |
| `docs/city-building-integration-report.md` | 本报告 |

- **未改**：`src/core/**`、`src/features/**`、`src/app/**`、`src/infrastructure/**`、`src/ui/**`、
  `src/content/config.ts`、`src/content/districts.ts`、`src/content/scene-scale.ts`、存档版本、依赖。
  开工时工作区无无关改动，因此不存在需要保留的第三方修改。`node_modules` 与 `dist` 均未提交。

## 2. 设施 → 风格映射与成功路径

| kind | 风格 | 实际覆盖 |
| --- | --- | --- |
| `home`（< 20 m） | `residential-6` 板式住宅 | 晴川公寓、晴川住宅 A/B/C 座、社区服务用房（5 m 单层） |
| `home`（≥ 20 m） | `apartment-8` 点式公寓 | 当前配置中无此类，保留给未来高层住宅 |
| `bank` / `office` / `securities` | `office-10` 商业办公楼 | 塔科夫银行、实业大厦、证券中心、科技研发中心、科创服务中心、孵化器、就业服务中心 |
| `government` | `civic-4` 市政公共建筑 | 塔科夫管理式民主政府（此前会落入住宅默认分支，现已显式映射） |
| `shop` | `retail-3` 商业沿街楼 | 晴川便利店、商业新区分店、商业街铺（含门头招牌） |

- **旧 model 非空与新区 model 为 null 两条路径都覆盖**：请求只由 `只读布局 + 城区模板版本` 产生，
  与 `LayoutBuilding.model` 无关；基础城区（`model` 非空）与新区（`null`）走同一段代码。
- 正常成功路径：`begin → 视觉对象 → attachBuildingVisual`（隐藏占位、写碰撞、抬标签）。
  旧整栋 GLB 与旧程序化外观都**不再是成功路径**：`world` 不再创建 `GLTFLoader`，也没有任何
  「按模型包围盒反算碰撞」的调用（`applyBuildingModel` 已删除）。
- 生产构建产物的实跑证据见第 7 节：页面只请求 `assets/city-realism/` 下的 6 张 1K 贴图、
  2 个模块化 GLB 与人物模型，**没有任何 `/assets/models/building-*.glb` 请求**。

## 3. 尺寸、朝向与碰撞

### 3.1 5 m 低楼

住房新区的「社区服务用房」是真实的 `10×8×5 m` 输入。处理方式（纯表现层）：

- `LIMITS.height` 下限 6 → 5 m，错误文案与文档同步更新；**地图高度没有改**。
- 单层建筑（含 5 m）不再摆放屋顶设备：水箱/机电房是「上楼」才有的构造，否则会把唯一楼层压到 2.4 m 下限。
- 实测（夹具输出）：`district-housing-0-community` → 1 层、首层 4.0 m、女儿墙 1.0 m（含压顶 0.12）、
  屋顶设备无、入口门高 **2.6 m**、顶部闭合 `wallTop + roofReserve − height = 0`。
- 实际几何仍在声明包络内：`inspectVisual` → `inside = true`；y 方向原始残差仅
  `5.96e-9 m`（浮点累加噪声，远小于 `compareBounds` 的 0.001 m 容差），x/z 为 0。

### 3.2 90° 朝向与宽深交换

- 朝向按既有入口主轴规则：`+Z→0`、`-Z→π`、`+X→π/2`、`-X→-π/2`（`layout-adapter.entranceRotationY`，
  scene 的占位外观与门朝向共用同一个 `entranceAxis`，不再有第二套判定）。
- 旋转 ±90° 时传给工厂的局部宽深交换：`localWidth = size.depth`、`localDepth = size.width`。
  16 栋实测全部满足「旋转后的世界包络 == 原规划占地」（`envelopeMatchesPlan = true`），
  例如 `bank 13×10×8` 旋转 −90° 后包络仍为 `x 14.50…27.50 / z −24.00…−14.00`。
- 非直角朝向仍取保守外接 AABB；90° 整数倍时 `cos/sin` 在 1e-9 内视作 0，
  避免 6e-17 的浮点尾巴让碰撞盒比规划大出最后一纳米。

### 3.3 碰撞与入口

- `visual.envelope` 的六个字段原地写入**现有** `handle.collider`（对象引用不变，
  `this.colliders` 数组、交互距离、摄像机射线遮挡、读档推出全部继续用同一份数据）。
- 包络只由「规划尺寸 + 朝向」决定，不用装饰包围盒反推；装饰、雨棚、台阶、屋顶设备、招牌
  都在规划范围内（招牌挑出 0.14 m，远小于 `frontInset`）。
- 入口（F 点）与标签保留：16 栋里有 15 栋的入口点在碰撞盒**外侧** 0.2–0.7 m，
  均在 `interactionDistance`（2–2.5 m）内；`district-commercial-2-employment` 的入口点
  落在自身占地内 0.3 m —— 这是 `districts.ts` 既有配置（`entranceOffset.x = 6.2 > width/2 − 0.3`），
  在接入前同理（新区碰撞一直等于配置 AABB）。按任务书不修改 `districts.ts` 几何，
  且 F 交互按「碰撞面到人物的表面距离」判定，贴墙站立时距离为 0，交互照旧可用。
- 标签高度取 `envelope.maxY + 2.6`，随楼体高度自适应。

## 4. 生命周期与资源归属（静态审查结果）

### 4.1 唯一数据流

```
CityLayoutView（只读）+ 所属城区 templateVersion
  → layout-adapter.projectBuildingVisualRequest（风格 / 朝向 / 局部宽深 / 指纹）
  → factory.begin → resolveBuildingPlan → 合批几何 + 共享构件
  → scene.attachBuildingVisual（挂载、隐藏占位、collider 原位写入、标签抬高）
```

`layout-adapter` 只读、只产出新对象；`plan` 纯函数；工厂不接触布局与业务切片。
`cityLayout` 的位置/尺寸/入口/id/districtId/interactionId/shopId/companyId/available 全程只读。

### 4.2 种子与指纹

- 种子 = `建筑 id + 所属城区已存 templateVersion + BUILDING_VISUAL_RULES_VERSION(=2)`。
  模板版本从 `layout.districts` 按 `districtId` 取，**不用** `layout.revision`，也不把全城
  `layoutVersion` 当每个城区的模板版本。匹配失败时明确诊断并保持占位，不随机补种子。
- 内存视觉指纹 = 风格 + 规划宽深高 + 位置 + 朝向 + 模板版本 + 规则版本 + 招牌文字。
  业务字段（`companyId`/`shopId`/`interactionId`/`available`）不在其中：
  新区招商只更新 `handle.building` 与交互数据，**不重建未变的楼体**（夹具实测：非法输入替换
  `home` 后其余 5 栋 `live` 计数与资产计数完全不变）。

### 4.3 取消、过期与 pending

- `syncLayout` 顺序：**取消上一轮在途** → `city.syncLayout` 改实例 → `beginVisualLoading` 重新请求；
  已完成且指纹不变的楼体原样保留。
- 异步返回后四项检查：`visualGeneration`、`layoutRevision`、`handle` 仍为 `this.handles` 里的同一实例、
  重算指纹等于请求指纹。过期成功结果**立即 `visual.dispose()`**，不挂载。
- `settleVisualLoad(generation)` 只在「未销毁且代次等于当前代次」时扣减一次；
  过期代次的 `finally` 既不扣当前 pending 也不触发新代次就绪。
  当前代次无论成功、明确失败还是被取消，都恰好结算一次 → 不会永久「正在初始化」。
- 工厂内部令牌/代次只解决「单栋取消」，不与 World 代次互换（`isStaleVisual` 才是世界级判定）。
- `World.dispose`：标记失效 → 取消在途 → 释放场景楼体 → 销毁工厂共享资产 → renderer。

### 4.4 资源所有者与释放顺序

| 资源 | 所有者 | 释放者 |
| --- | --- | --- |
| 贴图、GLB 模板、构件几何、共享材质 | `VisualAssetLibrary`（唯一工厂持有） | `factory.dispose()`（World 销毁时最后一步） |
| 单栋合批几何、实例矩阵、门头招牌材质与贴图 | 该栋 `BuildingVisual` | `visual.dispose()`（= `factory.release`） |
| 占位几何、门前广场、标签 CanvasTexture | `BuildingHandle` | `releaseBuildingHandle` 里的 `disposeObject(handle.group)` |
| 场景地面、道路、树木、人物 | `CitySceneImpl.scene` | `CitySceneImpl.dispose()` 末尾 |

释放路径只有一条：`releaseBuildingHandle`（删除、替换、整场销毁共用）——
先 `factory.release(visual)`（只释放本楼几何并 `removeFromParent`），再 `disposeObject(handle.group)`。
`CitySceneImpl.dispose()` 先逐栋释放、再 `disposeObject(this.scene)`，
因此通用遍历不会碰到别栋共享的材质/贴图。这条正是任务书点名的「不能只改删除分支」。

## 5. 业务与存档未改的审查依据

- `git status --short` 只列出第 1 节的允许文件；`src/core`、`src/features`、`src/app`、
  `src/infrastructure`、`src/ui`、`src/content/config.ts`、`src/content/districts.ts` 零改动。
- `SAVE.formatVersion` 仍为 **18**，未加字段、未写迁移；工厂、令牌、材质、视觉模式、视觉指纹
  一律只存在内存（`BuildingHandle` 的新字段不进 `LayoutBuilding`）。
- `LayoutBuilding.model` / `modelScaleKey` 保留原值，旧存档照常读取；替换只发生在渲染层，
  不靠改存档或清空持久化字段。
- 房地产/建设/人口/选举代码未被触碰，`interactionId`、`shopId`、`companyId`、`available`
  全部原样透传，`refreshNearbyBuilding` 的判定条件未改。

## 6. 类型检查与构建

| 命令 | 结果 |
| --- | --- |
| `npm run build`（最终代码；内含 `tsc --noEmit && vite build`） | 通过：131 modules transformed，`dist/index.html` 1.12 kB、`dist/bundle/index-*.css` 34.41 kB、`dist/bundle/index-*.js` 1,302.74 kB（gzip 366.00 kB） |

如实说明执行次数：开发期用 `npx tsc --noEmit` 迭代（首轮 1 处「未使用导入」已修，之后清零）；
最终代码上 `npm run build` 因为要读取完整输出而重复执行了两次，两次结果一致（`dist` 内容相同）。
除这两次外没有跑基线全套、没有 typecheck 与 build 交叉重复验证。
构建产物体积变化：模块数 121 → 131、JS 1,262.76 kB → 1,302.74 kB（+40 kB，
来自适配器、调度与两种新风格；**未新增任何美术资源**）。

## 7. 实际执行的局部验证

工具：隔离目录安装 `puppeteer-core` 驱动本机 Edge（`--use-angle=swiftshader`，headless），
一次性夹具 `verify-city.html` + `src/dev/verify-city.ts`，**跑完即删**（未提交、未进生产构建）。

### 7.1 生产构建 · 正常游戏入口（一个浏览器会话）

打开发布产物（`vite preview`，1279×720、DPR 1）→ 点「开始新游戏」→ 截图 `09-integration-base-city.png`。

- 画面：晴川公寓（板式住宅，含金属栏杆阳台）与塔科夫管理式民主政府（市政风格）均为新楼体，
  两者标签「晴川公寓 / 住宅 · 休息与住房费用」「塔科夫管理式民主政府 / 人口 · 政治 · 选举与赞助」正常显示。
- 资源请求（实际抓到）：`assets/models/character/Casual_Male.glb` +
  `assets/city-realism/textures/plaster-wall-{diffuse,normal,arm}-1k.jpg` +
  `assets/city-realism/textures/facade-tiles-{diffuse,normal,arm}-1k.jpg` +
  `assets/city-realism/models/{fire-escape-modular,utility-box}.glb`。
  **旧整栋 GLB 请求数 = 0**（未请求 `low-detail-building-a` / `building-a` / `building-skyscraper-a` /
  `building-c` / `low-detail-building-wide-a`，也未请求 `models/Textures/colormap.png`）。
- 控制台：无 pageerror、无 `[world]`/`[buildings]` 警告；唯一 404 是 `favicon.ico`
  （仓库本来就没有图标文件，与本次改动无关）。

### 7.2 夹具 · 正式 `World.syncLayout` 路径（同一核对轮次）

夹具用 `createBaseLayout()` + `addDistrict()` 只构造**只读布局**（不写 GameState、不碰存档），
再调正式 `world.syncLayout()` / `world.whenCollisionReady()` / `world.visualReport()`；
取景只用世界自己的 `restore()` 放人。核对方式：本机 Edge 无头（SwiftShader）逐页面驱动，
正式入口与夹具在同一轮核对中完成（同一台机器、同一份构建产物 / 同一份源码，未做多浏览器矩阵）。
三种专项跑法结果：

| 跑法 | 结果 |
| --- | --- |
| `stage=expand`（住房第 0 条带 + 科技 + 商业，共 16 栋；**前 6 栋即基础城区六类**） | `ready=16, pending=0, placeholder=[]`；资产计数 `textures=6, models=2, pieces=5`（全城共享，不随楼数增长） |
| `stage=fail`（同 id 把 home 改成 4 m 高） | `ready=5`、`placeholder=["home"]`、`collisionReady=true`；诊断 `home［home 11×4×10 m，district-base］：[buildings] 建筑高度 = 4 米超出支持区间 5～120 米`；其余 5 栋未重建 |
| `stage=dispose`（加载 30 ms 后立即销毁 World） | 无异常；销毁后 `live=0, pending=0, textures=0, models=0, pieces=0`（共享资产已释放，迟到贴图就地丢弃） |

`stage=expand` 的 16 栋逐栋核对（截图 `10-integration-expansion-lowrise.png`）：

| 建筑 | kind | 规划 宽×深×高 | 朝向 | 风格 | 层数 | F 面距/交互距离 | 包络==占地 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| home | home | 11×10×12 | +90° | residential-6 | 4 | 0.3 / 2 | ✔ |
| bank | bank | 13×10×8 | −90° | office-10 | 2 | 0.3 / 2 | ✔ |
| office | office | 13×11×16 | +90° | office-10 | 4 | 0.3 / 2 | ✔ |
| securities | securities | 11×10×9 | −90° | office-10 | 2 | 0.3 / 2 | ✔ |
| government | government | 20×10×9 | 0° | civic-4 | 2 | 0.3 / 2 | ✔ |
| convenience | shop | 16×12×6.4 | 180° | retail-3 | 2 | 0.2 / 2.5 | ✔ |
| housing-0-block-a/b | home | 12×10×14 | 180° | residential-6 | 4 | 0.7 / 2 | ✔ |
| housing-0-block-c | home | 12×10×11 | 180° | residential-6 | 3 | 0.7 / 2 | ✔ |
| **housing-0-community** | home | **10×8×5** | 180° | residential-6 | **1** | 0.7 / 2 | ✔（几何残差 6e-9 m） |
| tech-1-lab | office | 14×12×10 | 180° | office-10 | 2 | 0.7 / 2 | ✔ |
| tech-1-hub | office | 12×10×9 | **−90°** | office-10 | 2 | 0.2 / 2 | ✔（几何残差 4.8e-8 m） |
| tech-1-incubator | office | 12×10×7 | 180° | office-10 | 2 | 0.7 / 2 | ✔ |
| commercial-2-store | shop | 16×12×6.4 | 180° | retail-3 | 2 | 0.7 / 2.5 | ✔ |
| commercial-2-employment | office | 13×11×16 | +90° | office-10 | 4 | **−1**（入口点在占地内 0.3 m，既有配置） | ✔ |
| commercial-2-arcade | shop | 14×10×6 | 180° | retail-3 | 2 | 0.7 / 2 | ✔ |

宽深交换合法性（静态枚举）：基础城区 4 栋与新区 2 栋为 ±X 朝向，交换后局部尺寸分别为
`home 10×11`、`bank 10×13`、`office 11×13`、`securities 10×11`、`tech-hub 10×12`、
`employment 11×13`，全部落在支持区间（宽 8–80 / 深 8–60）内；其余 10 栋为 ±Z 朝向不交换。

## 8. 降级、已知限制与未验证项

**降级口径**

1. 加载中：显示原占位外观（便利店占位含旧内景），碰撞已是规划 AABB，人物移动与 F 锁定。
2. 明确失败（尺寸越界、城区模板版本缺失、贴图/材质加载失败）：保留占位、写入诊断列表并
   `console.warn`，碰撞仍按规划 AABB 就绪，不卡读档。当前 16 栋配置**没有**触发任何降级
   （夹具用「把 home 改成 4 m 高」的合成输入单独验证了这条路径）。
3. 过期/取消：结果就地释放，既不挂载也不降级。

**已知限制**

1. 场景仍无 IBL；玻璃与外部模型金属沿用旧的表现近似（金属度 ≤ 0.32、粗糙度 ≥ 0.45）。
2. `district-commercial-2-employment` 的入口点落在自身占地内 0.3 m（`districts.ts` 既有配置，
   本次按要求未改；F 交互仍可用）。若要修，需在 `districts.ts` 把 `entranceOffset.x` 调到
   ≥ 6.8，属于几何/交互配置变更，不在本任务授权内。
3. 单层楼（含 5 m 楼）没有屋顶水箱/机电房，这是有意的取舍，不是漏建。
4. 5 m 楼的首层层高 4.0 m 由「顶部空间优先」推导而来，视觉上偏公共建筑；如需压低需改该建筑的
   声明高度或新增专用风格。
5. `content/scene-scale.ts` 与 `applyBuildingModel` 的旧路径已退出渲染：前者保留为只读测量数据，
   后者已删除。`public/assets/models/*.glb` 仍随仓库分发（历史与旧存档兼容）。
6. 视觉规则版本升到 2，种子随之变化：正式地图与预览页的外观相对上一轮会整体变化一次（之后稳定）。

**未执行（如实列出）**

- 未做逐字节外观确定性比对（仍只有源码审查：种子路径无 `Math.random`、无时间、无遍历顺序）。
- 未做自动化游玩、经济/房地产全流程回归、长时间模拟、多浏览器矩阵、整城性能压测；
  上一轮的 `perf.json` 未重测（新增两种风格与门头招牌会改变 draw call/三角面，缺实测数据，故不声称性能结论）。
- 未在真机移动端、未在非 Edge 浏览器验收。
- 未跑「读档 A → 立刻读档 B」的真实存档流程（该分支只有代码审查：取消 → 代次 → revision →
  实例 → 指纹五道检查；夹具用 `syncLayout` 连续切换布局覆盖了同一段取消/过期逻辑）。

**留给用户验收**

- 用真实 v18 存档读档，确认已有新区与后续新交付新区都用新外观、F 入口与面板照旧。
- 走进各设施确认门头朝向、招牌辨识与「贴墙即可 F」的手感。
- 观察首屏加载时长与帧率是否可接受（本机未测）。

## 9. 证据文件

| 文件 | 说明 |
| --- | --- |
| `docs/city-buildings-shots/09-integration-base-city.png` | 生产构建 + 正常游戏入口：晴川公寓（板式住宅、金属栏杆阳台）与市政厅（市政风格）为新楼体，标签正常 |
| `docs/city-buildings-shots/10-integration-expansion-lowrise.png` | 夹具经正式 `World.syncLayout`：住房新区 5 m 社区服务用房（单层、无屋顶设备）+ 14 m 住宅 + 科技新区办公楼风格（含 −90° 朝向的科创服务中心） |

## 9. 验收反馈的 P2 修正（2026-10-28）

本轮验收（HEAD `42f184e`）判定主体接入成立，提出两项 P2。修正只动同步判定与场景复用判定，
未改布局、存档、媒体资源、种子口径与业务切片。

### 9.1 B1 · 布局总指纹漏掉城区模板版本

- 位置：`src/world/world.ts#layoutFingerprint`。
- 问题：内层 `visualFingerprint` 含模板版本，但外层结构指纹不含 `districts` 与
  `building.districtId`；一份「几何、revision 相同、只有城区模板版本不同」的布局会在
  `syncLayout` 的提前返回处被丢掉，继续显示旧种子的楼体。
- 修正：结构指纹加入 `district.id + district.templateVersion` 序列，以及每栋楼的 `districtId`。
  种子仍只来自「建筑 id + 所属城区模板版本 + 规则版本」，与 `layout.revision` 保持分离。
- 复核（正式 `World.syncLayout` 路径，一次性夹具，跑完删除）：

| 步骤 | 期望 | 实测 |
| --- | --- | --- |
| 基础布局就绪 | 6 栋 ready | `ready=6, pending=0` |
| 只把 `district-base.templateVersion` 1→2 后同步 | 必须检出并重新请求 | **`ready=0, pending=6`**（修正前会是 `ready=6, pending=0`） |
| 等就绪 | 6 栋 ready | `ready=6, pending=0` |
| 同内容再同步一次 | 幂等、不重建 | `ready=6, pending=0`（无 detach、无重新请求） |

### 9.2 B2 · 可用状态进入场景几何 key，导致整栋重建

- 位置：`src/world/scene.ts#buildingVisualKey` → 拆成 `buildingGeometryKey` 与 `buildingLabelKey`。
- 问题：场景 key 含 `available` / `name` / `subtitle`，会在适配器的视觉指纹生效之前先释放
  handle 与 visual，业务字段变化因此没能复用楼体。
- 修正：
  - 几何键 = 位置、尺寸、入口、kind、占位配色、旧模型字段 + **商店名称**（门头招牌文字）；
  - 标签键 = 名称、副标题、可用性；变化时就地换一张标签精灵，并释放旧精灵的材质与画布贴图；
  - `handle`、`visual`、`collider` 三者引用保持不变，标签位置沿用当前世界位置
    （不会把「抬到 `envelope.maxY + 2.6`」改回去）。
- 复核（`buildCityScene` + 真实工厂产物 + 真实 `attachBuildingVisual`，一次性夹具，跑完删除）：

| 场景 | 断言 | 实测 |
| --- | --- | --- |
| 只切换 `available` | handle / collider / visual 引用不变、visual 仍挂载、标签换新且位置不变、旧标签贴图被释放 | 全部 `true` |
| 非商店改名（`home` → 「晴川公寓（改名）」） | 保留 handle 与 visual，只换标签 | `sameHandle/sameVisual/labelReplaced/nameUpdated` 全 `true` |
| 商店改名（招牌文字变化） | handle 重建、旧 visual 摘下由 World 重新请求（新招牌） | `handleReplaced=true, visualDropped=true` |
| 只改 `companyId`（招商） | 保留 handle 与 visual | `sameHandle/sameVisual/companyUpdated` 全 `true` |

### 9.3 修正后的构建与冒烟

- `npm run build`：通过（131 modules，`dist/bundle/index-*.js` 1,303.15 kB / gzip 366.17 kB）。
- 生产构建启动冒烟（一次页面加载，不重跑几何/并发/取消验证）：进入游戏正常、无 pageerror、
  旧整栋 GLB 请求仍为 0、city-realism 资源正常加载；唯一 404 仍是 `favicon.ico`。
- 未重跑：整套几何/包络、并发构件归属、取消/过期、加载中销毁、性能与多浏览器项。

## 10. 提交

- 分支 `feature/city-building-integration`，提交 `7dd1be8`（父提交 `dc61c09`）；
  验收后的 P2 修正为 `7b17f3f`（父提交 `42f184e`，见第 9 节）。
- 提交内容：第 1 节列出的源码/文档/资源说明与两张截图；`node_modules`、`dist`、一次性夹具脚本、
  临时服务与下载中间文件均未提交（`.gitignore` 覆盖前两者，夹具文件已删除）。
- 未做：push、合并到 main、改动其他工作树。

## 11. 复现

```bash
cd C:/Coding/wolf-city-integration
npm ci
npm run build          # tsc --noEmit && vite build（本次只跑一次）
npx vite preview --port 4173    # http://localhost:4173/ → 开始新游戏
```

一次性夹具已删除（`verify-city.html`、`src/dev/verify-city.ts`），未提交；临时服务已停止。
