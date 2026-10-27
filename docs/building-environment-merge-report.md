# 建筑接入与环境系统合并记录

日期：2026-10-28（Asia/Hong_Kong）。本轮按用户授权提交、合并并准备将本地 main 推送至 origin/main。

## 提交与顺序

- 起点：本地 main 7e07d29；远程 main 只读核对及 fetch 后均为 f711af5。
- 已验收建筑分支 feature/city-building-integration：HEAD 7f7f47a（实现 7dd1be8，修正 7b17f3f）。
- 环境分支 feature/environment-system 的已验收工作区逐项暂存并提交为 b55f249。
- 先将建筑分支合入 main，合并提交 29d6d94；再合入环境分支，本报告随最终环境合并提交保存。
- 本轮不推送独立 feature 引用；main 包含两分支历史，也包含此前尚未推送的 UI/原型合并。

## 冲突与耦合处理

实际冲突共 4 个文件：src/world/scene.ts、docs/architecture.md、docs/contracts.md、docs/decisions.md。
world.ts 自动合并后另做静态核对，不因无冲突标记就视为集成完成。

1. scene 保留 BuildingVisualFactory 的显式注入、attach/detach/release、标签独立更新与原位 collider。
   不恢复旧 applyBuildingModel、facadeAxis 或旧整栋 GLB 成功路径。
2. EnvironmentRig 唯一管理太阳、天空、雾；scene 移除固定光源，只维护随城区规模变化的 fogBase。
   world 构造和 syncLayout 都把 fogBase 传给环境，不重建环境或整个城市。
3. attachBuildingVisual 挂载时只调用一次 applySolidShadowFlags，覆盖合批网格和 InstancedMesh。
   透明玻璃不投影，招牌贴面显式设置 userData.shadowCaster=false；该标记仅为内存渲染元数据。
   不通过材质名或资源路径猜测，不修改共享材质，也不让工厂依赖天气/经济。
4. World 销毁顺序：失效并取消请求 → 人物/环境 → 场景楼体 → 工厂共享资产 → renderer。
   过期保护、pending 计数、标签释放与单栋/共享资源归属继续保留。
5. 文档保留正式地图接入与环境两套有效约定；D87 保留建筑决策，环境决策顺延为 D88/D89，
   D90 记录集成。当前存档为 v19（环境切片），房地产 v18 规则和原迁移链保留。
   阴影回滞文案按实际代码修正为低于 0.03 停更、回到 0.06 恢复，未修改太阳算法。

## 保护范围核对

- 相对环境提交 b55f249，app、infrastructure、config 和 features 没有额外差异。
- 相对本轮基点 7e07d29，core、ui、finance/real-estate/housing 业务、房地产命令/视图/月结、
  城市建设交付、布局与房地产参数、package/lock 无差异。
- 不新增依赖、业务耦合、存档字段或额外格式升级；v19 变更来自已授权并验收的环境分支。
- 逐项暂存，未提交 node_modules、dist、缓存或临时脚本；其余任务工作树不修改。
- 未执行 reset、clean、强制覆盖或强推。

## 本轮实际验证

### 最小衔接验证（一次，无浏览器/GPU）

使用真实 BuildingVisualFactory、场景挂载/释放及 EnvironmentRig，资产加载用内存材质替代、
Canvas 使用空上下文；另加一个实例化网格核对新挂载规则。没有网络资产请求或游戏模拟。

- 场景自身不创建太阳，接入 EnvironmentRig 后恰好一盏太阳。
- 实体与实例构件投影；透明玻璃及实际工厂创建的招牌贴面不投影，仍接收阴影。
- 挂载前后 collider 为同一对象。
- 释放一栋楼后共享材质未被释放，另一栋仍计入 live；最终工厂 live=0。
- 结果全部通过。脚本从标准输入执行，没有留在仓库。

### 类型检查与生产构建（最终组合源码一次）

npm run build = tsc --noEmit && vite build：类型检查一次、生产构建一次，退出成功。
137 modules；JS 1,322.10 kB（gzip 372.24 kB）；CSS 34.41 kB（gzip 7.25 kB）。
仅有大于 500 kB 的 chunk 提示，未扩大任务去拆包。
暂存 whitespace 与冲突标记检查通过。

### 未执行

浏览器整体画面与阴影瑕疵验收、真实用户存档 UI 往返、全流程游玩、经济回归、长期天气模拟、
移动端、多浏览器与性能压测；不以构建或内存验证代替这些体验结论。

## 发布边界

本报告随本地合并提交保存。实际推送是否成功及远程提交号，以随后 git push 与远程核对结果为准。
