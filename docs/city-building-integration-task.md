# 正式地图建筑美术与模块化拼装落地任务书

日期：2026-10-27。架构负责人：本对话中的 Codex；实现负责人：接手本任务的外部 AI。
用户已授权：现有建筑、已建新区、今后扩张新建的建筑全部使用新美术。
你负责按以下架构实现代码、资源整合和交付；不要另起一套建筑系统，不要重新设计经济系统。

## 1. 项目地址、分支与基线

- 主仓库：`C:\Coding\塔科夫之狼V0.3.4`
- 远程：`https://github.com/eojnus/wolf-of-tarkov.git`
- **你的唯一开发目录**：`C:\Coding\wolf-city-integration`
- **已创建并检出的专用分支**：`feature/city-building-integration`
- 代码基线：本地 main `7e07d29`（包含房地产 v18、已合并 UI 菜单重组、建筑原型）。
- 本任务书作为专用分支上的准备提交；开始前核对实际 HEAD、分支和工作区。
- 本地 main 领先 origin/main；**不可按远程 main 重新建分支或覆盖本地成果**。
- 旧原型目录 `C:\Coding\wolf-city-buildings` 仅供必要时只读对照，不在那里继续开发。
- 不进入其他任务工作树写文件，不切换/合并 main，不 push，不 reset/clean/强制覆盖。
- 可以将本任务相关代码与交付报告提交到专用分支；架构负责人负责最终审查与合并。
  不提交 node_modules、dist、缓存、下载中间文件或一次性验证脚本。

## 2. 开始前必读与授权优先级

依次读本工作树的：

1. `AGENTS.md`
2. `docs/architecture.md`、`docs/contracts.md`、`docs/decisions.md`
3. `docs/local-integration-report.md`
4. `docs/city-buildings-prototype-report.md`，重点是尺寸、包络、资源归属、取消、已知限制
5. `docs/ui-menu-reorganization-report.md`（保护已验收 UI 与现场入口）
6. `public/assets/SOURCES.md`、`public/assets/city-realism/manifest.json`
7. `src/world/scene.ts`、`src/world/world.ts`、`src/world/buildings/**`、`src/content/building-visuals.ts`
8. `src/features/city-layout/index.ts`、`src/content/districts.ts`、`src/content/config.ts`、`src/content/scene-scale.ts`

旧报告与架构文档的「本轮仅独立原型、未接地图」描述的是已交付状态。
**本任务书及用户本次授权明确扩大范围，正式地图接入本身无需再次申请确认。**
本任务书授权下述表现层内部接口扩展（handle 的内存字段、取消/挂载/释放辅助、视觉适配器）。
不授权改存档版本、业务公共接口、经济规则或引入框架；确实必须跨这些边界时报告具体阻塞与最小方案。

## 3. 必须达成的最终结果

玩家正常打开正式游戏 `index.html` 即看到新美术，不能要求进入 building-prototype.html 或开隐藏开关。
覆盖基础城区的住宅、银行、办公楼、证券中心、市政厅、便利店，以及科技/商业/住房新区的全部建筑。
既有 v18 存档中的已完成新区与后续新交付新区也必须走同一条新视觉路径。
同一栋楼不同时展示旧整栋 GLB、旧程序化外观与新模块化楼体。
旧占位只允许在加载中或明确失败时降级；正常成功路径不能悄悄回到旧美术。
新资源必须实际参与正式场景的贴图、材质与适用构件；不能只导入不挂载、只改配色或只改预览。

不扩展街道/地形/植被系统，不做整城重规划，不改 UI 菜单，不引入新业务建筑。
保持各设施标签、用途和 F 入口辨识；商店保留品牌/招牌等必要辨识，不必保留旧楼壳。

## 4. 首席架构师确定的架构

### 4.1 唯一数据流与权威

`只读 CityLayoutView + 所属城区模板版本`
→ `world 层的建筑视觉适配器`
→ `resolveBuildingPlan`
→ `BuildingVisualFactory.begin`
→ `scene 挂载 BuildingVisual + 原位更新 collider`

- cityLayout 的位置、尺寸、入口、id、districtId、interactionId、shopId、companyId、available 是原权威。
- 视觉库绝不写回 cityLayout，不读写 realEstate/housing/finance，不用窗数、楼层数推算住房套数。
- 不修改房地产成交、挂牌高水位、预留、月结、建设交付、人口、GDP 或选举逻辑。
- SAVE.formatVersion 保持 18；不存工厂、令牌、材质、视觉模式或加载结果，不做存档迁移。
- 旧存档的 model/modelScaleKey 原值可保留作为兼容数据。运行时新视觉策略优先于旧 model；
  不能通过改旧存档或清空持久化 model 来完成替换。

### 4.2 视觉适配器与风格配置

新增一个小型 world 层适配文件（建议 `src/world/buildings/layout-adapter.ts`），只投影只读输入。
视觉风格映射与参数放 `src/content/building-visuals.ts`；不要在 scene/world 里散落建筑业务类别判定和尺寸常量。

- home 按规划高度选住宅/公寓；office、bank、securities 采用办公/公共服务类模块。
- government、shop 必须有显式的公共建筑/商业低楼风格映射，可复用已有模块和新贴图，
  保留设施辨识。不得落入 defaultStyleFor 的默认住宅分支后声称已完成全部替换。
- 基础六类与三种新区都走模块化工厂；不得只接 `model === null` 或只接某种 home。
- 宽深高来自实际存档布局，不能照搬预览三栋楼的 SLOTS 尺寸或固定层数。
- 种子 = 稳定建筑 id + **所属 district 的已存 templateVersion** + 视觉规则版本。
  从只读布局 districts 按 districtId 取版本；不要以会变化的 layout.revision 当种子，
  也不要把全城 layoutVersion 误作每个城区的模板版本。匹配异常须明确诊断，不能随机补种子。
- 异步失效的布局 revision 与外观种子的模板版本是两种用途，保持分开。
- 影响几何的风格/规则版本、规划尺寸、朝向和模板版本纳入内存视觉指纹。
  新区招商改变 companyId 等业务字段时，复用未变的楼体，只更新标签/交互数据。

### 4.3 朝向、尺寸与碰撞

工厂的局部正面是 +Z；逻辑 size.width/depth 分别是世界 X/Z 尺寸。
复用 facadeAxis 的入口主轴规则，+Z→0，-Z→π，+X→π/2，-X→-π/2。
**绕 Y 转 90° 时，传给工厂的局部 width/depth 必须交换**，保证旋转后的世界包络仍等于原规划占地。
不要直接把世界 width/depth 加旋转传入后扩大占地；位置和旋转只应用一次，避免父子节点重复变换。

- 工厂产物已经含世界位置/朝向；按现有 group 结构约定挂载，明确哪一层持有变换。
- `visual.envelope` 赋值到现有 `handle.collider` 的六个字段，**保持 collider 对象引用不变**。
- 声明包络不得由装饰包围盒反推扩大。装饰、雨棚、台阶、屋顶设备都应收在规划范围内。
- 入口与交互点保持，门面朝向入口；不能把现有可站立的 F 点包进碰撞盒。
- 路面、引导区域、标签与新建筑外观分别管理，防止隐藏 placeholder 时一起丢掉必要标签或交互提示。
- 保留现有读档顺序：同步布局 → 恢复原 pose → 当前布局最终碰撞成功/明确降级就绪 →
  仅实际非法时一次最小推出。加载中锁移动/F，不暂停经济模拟。

### 4.4 必须处理的现有输入缺口

`content/districts.ts` 的住房新区包含 **10×8×5 m** 的住宅，而原型 plan.ts 高度下限目前为 6 m。
这是正常业务输入，不能让它永远失败、灰盒降级，不能把地图高度偷偷改成 6 m。
在纯表现层支持真实 5 m 低楼：减少楼层、取消设备、压缩必要细部，保持合理门高与原声明高度。
同步更新支持区间、范围错误文案与文档；算法变化按视觉规则版本纪律处理。
同时静态枚举配置与存档兼容输入路径，核对宽深交换后仍合法。不要为假想未来尺寸做通用框架。
旧存档若确有不支持尺寸，必须明确记录诊断与稳定降级，不能卡住碰撞就绪或谎报全部覆盖。

### 4.5 生命周期与异步编排

**World 持有一个 BuildingVisualFactory**，同一 World 的所有楼共享资产；不每栋新建工厂。
World 负责请求、取消与就绪计数；scene 负责 handle、标签、挂载、碰撞写入和单栋释放。
BuildingHandle 可增加仅内存字段：当前 visual、必要的视觉指纹/状态；不写进 LayoutBuilding。

- 在 syncLayout 改变场景实例前取消上一轮在途请求；已完成且指纹不变的视觉继续保留。
- 替换 beginModelLoading 的「没有 model 就跳过」判断，让所有目标建筑进入新工厂路径。
  旧整栋 GLB 加载与新模块请求互斥；新路径覆盖后旧整栋 GLB 不再作为成功路径加载。
- 每次异步返回检查 disposed、World modelGeneration、layoutRevision、handle 仍为当前实例、视觉指纹。
  工厂内部令牌/代次不能替代上述 World 检查。
- 过期成功结果必须 dispose；过期请求的 finally 不得扣当前代次 pending 数或触发新代次就绪。
  当前代次无论成功还是明确失败都要正确结算一次计数，不能永久“正在初始化”。
- 同 id 换尺寸、删除后重建、连续读档、加载中扩张、World 销毁的分支都要静态走查。
  不因加载一栋新楼重新加载整城已完成楼体。

### 4.6 释放责任必须闭合

- 单栋 visual.dispose / factory.release 只释放本楼合批几何与实例；资产库持有共享几何/材质/贴图。
- 建立 scene 内统一的 releaseBuildingHandle 辅助：先释放并摘除 visual，再释放独有占位/标签等。
  删除、替换、最终场景 dispose 全部走同一条路径。
- **不能只改删除分支**：当前 `CitySceneImpl.dispose()` 最后会 `disposeObject(this.scene)`，
  必须保证此时共享 visual 已释放并从树中摘除，否则会遍历释放其他楼共享的材质与贴图。
- World.dispose 先标记失效并取消在途，再释放场景楼体，最后销毁工厂共享资产和 renderer。
- 加载中销毁、迟到模型/贴图、失败重试同样不得遗留无主资源或重新挂回已销毁场景。
- 保留 prototype 页复用同一工厂；不写一套“正式地图专用的重复造楼算法”。

## 5. 文件与改动边界

主要允许：

- `src/world/scene.ts`、`src/world/world.ts`
- `src/world/buildings/**`
- `src/content/building-visuals.ts`
- 必要的 `src/dev/building-prototype.ts` 适配（仅为兼容工厂变化）
- `docs/architecture.md`、`docs/contracts.md`、`docs/decisions.md`、`docs/scene-scale.md`
- 新交付报告 `docs/city-building-integration-report.md`
- 确有必要的新资源及 SOURCES/manifest（优先复用已有资源，不为接入盲目增加资产或依赖）

本次不应修改：core、features 业务实现、app 经济/时间/房地产/存档编排、infrastructure、UI 菜单与样式。
不改 content/config.ts 或 districts.ts 的布局几何/交互/业务配置来迁就视觉。
不删原资源兼容路径或人物资源；不改 SAVE 版本，不引入依赖，不将原型加入正式游戏导航。
不需要升级依赖或“顺便重构”无关文件。确有边界外必要性先给出具体问题和最小建议。

## 6. 实施顺序

1. 只读核对 Git/约定/全部实际尺寸与 kind；列明基础六类和新区类型到风格的映射。
2. 完成低楼支持、纯视觉适配器、朝向与尺寸投影。
3. 完成 handle 挂载/碰撞/释放，再替换 World 加载调度，保护取消与读档就绪。
4. 静态审查业务字段与存档完全未变，正常路径实际使用新资源。
5. 同步现行架构文档：将「尚未接入」改为实际完成状态，保留历史报告作为历史，
   scene-scale 明确旧整栋 GLB 参照与当前模块化路径的区别，人物比例约定仍有效。
6. 做第 7 节规定的最小检查，提交真实结果与明确限制。

## 7. 测试纪律：非必要不测试、必要时最小范围

严格执行 AGENTS.md；不先跑基线全套，不扩建 scripts/smoke.ts，不搭建测试体系。
不做自动化游玩、长期模拟、经济/房地产全流程回归、多浏览器矩阵或整城性能压测。
确定性、资源归属、pending 计数、读档顺序优先代码审查。

最终代码只执行一次 `npm run build`：既有命令已包含 `tsc --noEmit && vite build`，
因此类型检查一次、生产构建一次；**不要先 typecheck 再 build 重复类型检查**。
仅失败后修复并重跑失败相关检查；已有依赖可直接复用，没有依赖才按 lock 安装，不改 lock。

本次交付目的就是正式地图外观改变，因此一次最小的正式页面视觉核对有必要：

- 一个浏览器会话，正常游戏入口查看基础城区，确认六类建筑走新外观、标签/F 入口保留；
  查看加载/控制台错误与实际新资源引用即可，不做真实业务交易。
- 同一会话用只读布局投影/一次性内存夹具直接呈现科技、商业、住房新区代表布局，
  包含 5 m 低楼与 X/Z 不同朝向。走正式 World.syncLayout 路径，不长时间等选举扩张，
  不改业务状态、不篡改正式存档、不留下调试入口。夹具只用于局部检查，运行后移除。
- 最多保留基础城区与扩张区各一张有说明的实际截图；不要重复拍原型证据全套。
  浏览器核对可在构建后以生产预览进行，确认产物里资产 URL 可加载。

若存在取消/释放/旋转包络的具体疑点，只做针对该疑点的最小局部验证；记录理由与结果。
不要重跑前一轮已完成的全部 R1–R5 验证，也不要仅因“更放心”追加测试。
工具不可用时如实说明，禁止把静态推断或预览页截图写成正式地图已实际验收。

## 8. 交付与验收门槛

提交 `docs/city-building-integration-report.md`，明确：

- 基线、分支、实际改动文件、提交号；无关修改如何保留。
- 基础六类、三种新区的实际映射和成功路径；旧 model 非空与新区 model 为 null 都已覆盖。
- 新资源在正式游戏中的引用/挂载位置，不能只给独立原型页截图。
- 5 m 低楼、90° 宽深交换、入口与 collider 引用保持的实现说明。
- 各资源的所有者、单栋/整场释放顺序、取消/过期与 pending 计数的静态审查结果。
- 房地产 v18/建设交付/存档/UI 未改的差异审查依据。
- 类型检查和构建的实际命令与结果；真实执行的局部验证，未执行项与用户待验收项分开写。
- 降级/已知限制和资源体积；没有实测就不声称性能、全流程或浏览器体验已通过。
- 停止临时服务，移除一次性脚本/夹具；不提交构建产物。

完成标准：正常游戏及现有 v18 布局全部走新视觉，今后新区自然复用同一路径；
房地产与建设逻辑保持；类型检查/构建通过；实际验证范围有据可查。
**只让独立预览工作、只替换新增楼、只替换住宅、只修改路径而未挂载，都不算完成。**

不要自行合并或推送。交付后由首席架构师按本任务书复核，再决定合入本地 main。
