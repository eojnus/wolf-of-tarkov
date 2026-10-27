# 环境系统交付报告（阶段 B）

- 分支：`feature/environment-system`（基点 `main` 的 `7e07d29`）。
- 交付状态：工作区修改，**未提交、未推送、未合并**；`main` 保持 `7e07d29`。
- 存档版本：**19**（v18 → v19，新增 `environment` 切片）。
- 本报告补充阶段 B 的实际执行记录；不代填任何未实际发生的 Skill 使用或测试记录。

## 1. 实际文件

新增（6 个源文件）：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `src/features/environment/index.ts` | 352 | 天气切片、调度求解、昼夜/天气纯采样（无 Three.js / DOM / 存储） |
| `src/app/environment.ts` | 39 | 表现用分钟与天气切片推送给 world |
| `src/world/environment/index.ts` | 129 | 环境控制器：质量档、雾、生命周期 |
| `src/world/environment/sky.ts` | 197 | 渐变穹顶、星空、太阳光晕 |
| `src/world/environment/sun.ts` | 120 | 唯一太阳方向光、半球光、环境光、阴影预算 |
| `src/world/environment/rain.ts` | 171 | 跟随相机的有界雨体积（一次分配，draw range 表达密度） |

修改（9 个源文件）：`content/config.ts`（`ENVIRONMENT` 唯一参数表，+334 行）、
`world/scene.ts`（移交固定灯光/天空/雾，新增 `applySolidShadowFlags` 与 `fogBase`）、
`world/world.ts`（环境生命周期与 `updateEnvironment`）、`world/character.ts`（人物投影）、
`app/state.ts`（组装切片）、`app/timeAdvance.ts`（+4 行，1 分钟段调用 `advanceEnvironment`）、
`app/game.ts`（+15 行，每帧推送与读档/新档对齐）、`infrastructure/save-migrations.ts`（v18→v19）、
`infrastructure/save-validation.ts`（`validateEnvironment`）。

修改（3 个文档）：`docs/architecture.md`（第 16 节）、`docs/contracts.md`（第二十八节）、
`docs/decisions.md`（D87/D88）。
新增文档：本文件。

`src/core/` 零改动；`GameState` 只新增 `environment` 一个切片。

## 2. 存档与迁移

- 只保存不能由游戏时间推导的字段：`weather`、`previousWeather`、`changedAtMinute`、
  `endsAtMinute`、`randomState`。
- 太阳方向、天空颜色、雾距离、环境光不保存，由「时间 + 天气」推导。
- 旧档在迁移时刻初始化为晴天并重排下一次调度（由配置种子与时长范围确定，可复现）；
  不重放历史天气、不追补过渡、不改动其它字段。v5 → … → v19 迁移链完整保留。
- 校验：天气种类合法、`changedAtMinute ≤ totalMinute`、`endsAtMinute > totalMinute`、
  `randomState` 为非负整数。

## 3. 已运行的检查（次数与结果）

| 检查 | 次数 | 结果 |
| --- | --- | --- |
| `tsc --noEmit`（阶段 B 开发期间） | 3 | 通过 |
| `npm run build`（`tsc --noEmit && vite build`） | 3 | 通过；128 modules，JS 1,286.36 kB / gzip 360.30 kB；>500 kB chunk 为既有警告，未拆分 |
| `tsc --noEmit`（E1 修正后） | 1 | 通过 |
| 纯计算局部验证（太阳轨迹/调度） | 1 | 通过 |
| E1 定点验证（雨停→恢复、暂停稳态） | 1 | 修正后通过 |

**修正后未重跑生产构建**：本次改动只调整 `rain.ts` 的停雨/恢复分支，没有新增依赖或导出，
构建脚本前半段（类型检查）已单独跑过。

## 4. 局部验证（可复现的最小范围）

1. **太阳与调度（阶段 B）**：把 `features/environment` 单独编译到仓库外的临时目录执行一次性脚本，
   确认 08:00 太阳在东偏南（高度角 25.7°）、14:00 转西南（48.7°）、20:00 落到地平线下且直接光 0、
   星空满值；7 天跳时与逐分钟推进结果完全一致、调度时刻落在目标分钟之后；同一分钟重复推进幂等；
   过渡进度在 0 / 45 / 90 分钟分别为 0 / 0.5 / 1。脚本与目录已删除。
2. **迁移夹具（验收阶段）**：初始 v19 状态可校验；删除 `environment` 构成 v18 形状后迁移可校验；
   除环境字段外内容相同、输入未被写入。该夹具不是用户真实存档，也不是全迁移链回归。
3. **E1 定点（本次修正）**：直接实例化 `RainField('low')`，只调用 `update`：

   | 阶段 | visible | drawRange.count | 坐标上传次数 |
   | --- | --- | --- | --- |
   | 初始 | false | 0 | 0 |
   | 首次雨 | true | 1120 | 1 |
   | 无雨 | false | 0 | 1 |
   | 再次同量雨 | true | **1120** | 2 |
   | 半雨量 | true | 560 | 3 |
   | 回到满雨量 | true | 1120 | 4 |

   暂停两帧与无雨两帧的上传增量均为 0；`geometry.attributes.position` 实例未替换（缓冲未重建）。
   修正只改 `rain.ts` 的停雨分支：停雨时把缓存数量与实际绘制范围一起归零，恢复时重新设置
   drawRange 并补写一次坐标；暂停不推进、不上传的行为保持不变。

## 5. 未运行项目与限制

- 未运行：浏览器视觉验收、阴影瑕疵（痤疮/悬浮/裁切）观察、移动端与多浏览器、帧率测量、
  存档 UI 往返、长期天气分布统计、经济/房地产全流程、`scripts/smoke.ts`。
- 已知限制：无天气文字提示或设置界面；雨只在相机附近的有界体积内；阴影只覆盖玩家附近有界区域，
  远处建筑不参与投影；阴影质量档在启动时确定，运行中不切换；人物脚下的贴地圆片保留
  （夜间无太阳投影时兜底），白天可能与投影叠加；`dev/building-prototype` 独立预览页仍用自己的灯光。
- 未实现（越界范围）：月光投影、路灯、雷电雷声、雪、积水与湿地反射、音频、季节、天气对经济/生存的影响。

## 6. 合并时的集成限制（本次未执行）

建筑分支移除了旧 `applyBuildingModel` 并新增 `attachBuildingVisual`，当前环境阴影标记尚未覆盖该路径。
正式合并时需：让新模块化楼体与实例构件参加统一阴影，保留透明材质与招牌贴花的排除规则；
同时解开 `scene` / `world` / 文档的双分支改动，不能因单分支构建通过就判定组合通过。
本次不执行合并，也不恢复旧整栋 GLB 成功路径。
