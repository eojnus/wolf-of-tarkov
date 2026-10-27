# 架构说明（当前实现）

本文只描述**现在**的结构与规则。历史变更的理由在 `decisions.md`，具体接口约束在 `contracts.md`。
规则变了就直接改这里，不再按「某一轮修复」追加章节。

## 1. 分层与目录

```
core/          业务无关的基础能力
  clock.ts     时间推进（唯一实现：advanceClock）
  calendar.ts  日历换算、日序号
  store.ts     GameStore：一次提交整体成功或整体失败
  readonly.ts  DeepReadonly / asReadonly / cloneForWrite（纯类型 + 两个边界函数）
  money.ts errors.ts

content/       数值与文案配置（不写规则逻辑）
  config.ts    城市/品牌/时间/行情节奏/存档版本
  business.ts  企业与产品市场参数、AI 公司配置
  capital.ts   股权、融资、估值、宣传、流动性、做市愿售、产品—股价联动参数
  population.ts 人口增长、阶层流动、经营与证券冲击参数
  government.ts 候选人、政策效果、选举与赞助参数
  politics.ts  3 收入 × 4 利益 = 12 交叉政治群体、满意度基线、提前选举参数
  city-economy.ts 游戏 GDP、连续指数、建设门槛、招商与长期统计边界
  districts.ts 固定城区模板（几何、道路、地块、建筑与模板版本）

features/      业务模型与纯计算（只认识自己的切片）
  finance      唯一资金入口：账户、流水、预留、划转
  equity       股份与所有权不变量：股权簿、发行、转让、库存股
  financing    融资申请、报价、有效期、轮次状态（不扣款、不发行）
  governance   提案、表决、CEO 任免规则
  stock        行情、K 线、持仓成本、成交记录、终止标记、愿售比例
  enterprise   企业身份、状态、应付、报表
  technology   科技积累、研发、产品属性、代际、日销量窗口
  talent       科研高管候选与任职
  market       销量估算（加权品质 Q）
  promotion    宣传预算、成败与衰减
  investors    投资者画像与出价意愿
  population    城市经济人口：阶层人数、增长锚点、月度流动与显示取整
  politics      12 交叉群体满意度、边际统计、提前选举监测（不保存第二份权威人口）
  elections     竞选状态机、候选人资源、赞助单据、支持率、票数与独立抽签
  government    政府机构、职位、负责人、任职记录与任期政策效果快照
  city-statistics 经营产出登记、基础 GDP、连续全市场指数窗（纯计算）
  city-development 建设门槛、阶段预留、项目与永久建设历史（不建 Three.js 对象）
  city-layout  逻辑地图：边界、道路、地块、建筑与稳定标识（无 Three.js / DOM / 结算）
  real-estate  产权、入住、挂牌、AI 土地报价与成交记录（不保存余额）
  housing      收入群组的家庭数、居住分配、购房意愿与住房压力（不保存余额与人口权威）
  banking / employment / living / loan / business-ai

app/           跨模块协调：命令、模拟、查询、视图
  state.ts               完整状态结构、只读视图类型、派生查询
  timeAdvance.ts         唯一时间推进入口 advanceGameTime
  commands.ts            个人侧命令（存取款、贷款、股票交易、速度）
  business.ts            企业经营命令
  business-settlement.ts 销售/费用/工资/月报/清算/AI 经营决策
  capital.ts             资本命令（权限、通知、自动保存）
  capital-operations.ts  玩家与 AI 共用的资本写操作
  capital-simulation.ts  时间驱动的资本模拟（报价回应、提案、AI 资本决策）
  capital-query.ts       资本只读查询与预览
  securities-settlement.ts 估值锚、行情推进、交易执行、分红、产品发布冲击
  securities-view.ts / business-view.ts / personal-view.ts / view.ts  只读视图
  policy.ts              当前任期政策效果快照的唯一读取口径
  population-simulation.ts 自然增长编排、经营观察（J/I/P）与月度阶层结算
  population-market.ts   证券市场 → 人口系统的适配层（调整后月回报）
  politics-simulation.ts 满意度月结、提前选举监测与保护期协调
  government.ts          政府命令（竞选赞助：权限、幂等、原子扣款）
  government-simulation.ts 竞选开启、日度资源使用、到期选举、真实任期与建设判断触发
  government-view.ts     政府面板的全部只读视图
  city-statistics.ts     销售纯投影、真实产出登记、G0 估算、月界统计固化
  city-stock-index.ts    证券权威数据 → 连续指数（独立观察窗口）
  city-development.ts    选举后建设判断、项目完成落地、招商槽位挑选
  city-enterprises.ts    运行时真实 AI 招商与创建（严禁走开局种子路径）
  city-view.ts           城市经济面板的只读视图
  residence.ts           永久居住权与月度应缴报价的唯一口径
  real-estate.ts         房地产播种、付款与产权转移的唯一写入入口
  real-estate-commands.ts 房地产玩家命令（买入、挂牌、撤销、接受/拒绝报价）
  real-estate-view.ts    住房与土地面板的只读视图
  housing-simulation.ts  住房月结：收入/消费、需求、匹配成交、AI 投资与指标固化

infrastructure/ 存档
  storage.ts        入口：槽位读写、快照、导入导出、读档编排
  save-types.ts     公共类型（不依赖任何实现）
  save-database.ts  IndexedDB 原始读写（不理解玩法）
  save-migrations.ts v1 → v16 迁移链、受控旧数据修复、读档兼容规范化
  save-validation.ts 字段与跨切片一致性校验

ui/            只渲染只读视图并提交命令；不持有经济数据
  game-window.ts       统一浮动窗口（拖动、放大/恢复、分类导航、层级与夹紧）
  panels.ts            分类路由：五类入口、现场办理门禁、局部刷新与图形重绘
  personal-panel.ts    个人生活/企业经营/持仓的栏目内容、草稿与原地比对
  government-panel.ts  城市事务七个栏目、人口/产业环形图与趋势、赞助草稿只在内存
  life-panels.ts       银行、就业、住宅与系统菜单的只读渲染
  population-pie.ts    原生 SVG 环形图（悬停外移、图例联动、键盘可达、就地更新）
  stock-chart.ts       K 线绘制与交互（十字线、坐标轴、缩放平移、最新价标记）
  导航与窗口的现行行为以以上表现层模块实现为准
world/         Three.js 场景、角色与控制
```

## 2. 状态切片与权威来源

`GameState`（`app/state.ts`）把以下切片组装成一份完整、可序列化的状态：

```
clock · finance · living · loan · employment · population · politics · elections ·
government · enterprises · technology · talent · businessAi · equity · securities ·
financing · governance · promotion · cityStatistics · cityLayout · cityDevelopment ·
realEstate · housing · settings · world · reports · settlement
```

| 数据 | 权威来源 | 说明 |
| --- | --- | --- |
| 股份所有权 | `equity.books[*].holdings` | 谁持有多少股只看股权簿；`totalShares = Σ持股 + 库存股` |
| 持仓成本 / 已实现盈亏 / 成交笔数 | `securities.holdings[*]` | 股数是**兼容副本**，必须与股权簿 `player` 持股一致，读档会核对 |
| 游戏速度 | `clock.speed` | `settings.speed` 只是兼容镜像：读档时用合法时钟对齐它，反向不成立 |
| 资金 | `finance` | 个人、企业、投资者、做市账户都在这一份里 |
| 资金承诺 | `finance.reservations` | key = `主体::单据`，例如 `investor:inv-xingye::quote-…` |
| 行情与历史 | `securities.markets[*]` | 定时节点与即时价格事件写进同一份 `history` / K 线 |
| 日销量样本 | `technology…products[*].dailySales` | 只由统一销售结算在日界写入 |
| 城市总人口 | `population.classes`（低/中/高之和） | 不另存一份总数；自然增长与阶层流动都写这三项 |
| 政治群体人数 | `population.classes` → `features/politics.groupSizes` | 12 个交叉群体人数只派生；政治切片只存满意度与监测计数 |
| 游戏 GDP | `cityStatistics`（base + output + index） | 不建 GDP 财务账户；股票只通过 S(t) 一条路径进入 GDP |
| 累计经营产出 | `cityStatistics.output` | 只由真实销售结算登记；不从流水/市值/报表反推 |
| 全市场连续指数 | `cityStatistics.index` | 独立于人口市场窗口；月底链式固化，不回到 100 |
| 逻辑城区 | `cityLayout` | 存档保存边界/道路/地块/建筑；不写 Three.js 对象 |
| 建设阶段 | `cityDevelopment` | 永久防重复靠单调任期高水位与阶段预留位图，不依赖 24 条政府历史 |
| 竞选资源 | `elections.candidates[*]` | 基础 + 赞助 − 已使用；未使用部分届末失效，不结转 |
| 当选与政策 | `government.currentHolder` / 任期 `effects` 快照 | 政策只从当选任期快照推导，不接受外部写入 |

同一个事实只允许有一个权威；重复字段（持仓股数、速度镜像）只在同一次提交里同步，
读档时核对，不做静默覆盖。

## 3. 读写边界

- `GameStore.state` 与订阅回调给的是 `DeepReadonly<GameState>`（别名 `ReadonlyGameState`）。
  对象、数组、字典都被类型收紧，`push / splice / 赋值` 在编译期失败。**没有**运行时冻结或 Proxy。
- 写入只有两个入口：`store.run(draft => …)`（草稿是深克隆，抛错即丢弃）与初始化/迁移（构造新状态）。
- 查询函数接收 `ReadonlyGameState` 或其切片的只读视图；需要返回对象时用重载保持方向：
  传入可写状态得到可写结果，传入只读状态得到只读结果（`marketOf`、`bookOfCompany`、`managedCompany` 等）。
- **读取不创建**：`ensureTechCompany` / `holdingOf` 只允许出现在草稿、初始化与迁移里；
  查询路径用 `techViewOf`；玩家持仓统一用 `playerHoldingOf`，其中股数转读 `equity`，
  成本、已实现盈亏与成交笔数仍读 `securities`。这些查询都不补建、不写入正式状态。

## 4. 资本模块的四种职责

| 文件 | 职责 | 不做什么 |
| --- | --- | --- |
| `capital.ts` | `CapitalCommands`：玩家命令、管理权/股东权校验、通知与自动保存 | 不实现共享写操作 |
| `capital-operations.ts` | 接受融资报价、执行回购、预留与释放辅助、`operationId` | 不碰 DOM、不发通知、不自己 `store.run` |
| `capital-simulation.ts` | 融资回应、报价过期与预留释放、到期提案、外部股东提案、AI 资本决策 | 不依赖玩家命令入口 |
| `capital-query.ts` | 融资展示、上市条件、控制权摘要、宣传摘要、投资者可用资金、回购预览、任命限制 | 不写状态、不依赖命令或模拟 |

依赖方向：`capital → operations + simulation + query`；`simulation → operations + query`；
`query → features + securities-settlement`。视图只读 `capital-query`，时间推进只调 `capital-simulation`。

## 5. 资金与预留

- 一切余额修改都经 `features/finance`。
- `transferFunds`：从 `investor` / `market` 主体扣款时，支出上限是**余额 − 该主体全部预留**；
  个人与企业账户保持原有支付语义。
- `transferReservedFunds`：受预留支持的划转，必须给 `reservationRef`，只消费该单据的预留；
  划款、流水与预留消费在同一次提交内完成。不能借用别的单据，也没有「跳过预留检查」的开关。
- `releaseFunds(state, owner, id, amount, ref)` 只释放 `ref`；不存在或不足时不补扣其他单据。
  主体整体释放必须显式调用 `releaseAllFor`。
- 接受融资报价只走 `transferReservedFunds`；同轮其他报价各自释放自己的预留。

## 6. 时间推进顺序

`advanceGameTime` 按分钟分段，段内顺序固定：

```
a 个人工资 / 个人利息 / 企业工资与费用应计 → 人口自然增长（按游戏时间）→ 生存消耗
b 行情节点（定时）+ 资本节点（报价回应、报价过期、宣传衰减）
c 日界：销售结算 → 费用付款 → 日销量样本 → 应付付款 → 危机检查
  （非月界时同刻处理：竞选资源按日使用 → 到期提案 → 外部股东提案）
d 到期建设项目完成（按分钟；到点即完成，不等待模型下载）
e 竞选开启与到期选举（按分钟检查；投票时刻 08:00 不是日界）
  —— 非月界时排在同时刻 AI 决策之前：新任期政策要作用于之后的经营决策
f 贷款到期    g 研发完成
h AI 资本决策 → AI 经营决策（日界；新区招商在这一步之后按游戏日重试）
i 汇总关键事件，决定是否停止本次跳时
```

月界（`onMonthEnd`）内部顺序固定，**月界分钟不在 onElapsed 提前执行选举检查**：

```
1 个人月结 → 企业工资付款 → 月报固化并切换当月累计（旧月销售与费用在这里结清）
2 到期旧建设项目先完成
3 固化本月经营产出统计与全市场指数窗口（旧窗口先固化再重建，不丢涨跌）
4 人口月结（经营观察 + 市场回报 → 阶层流动）
4.5 住房月结（家庭数同步 → 收入/消费入账 → 需求 → 匹配成交 → 指标固化）
5 12 群体满意度更新（引用第 4 步同一份真实经济摘要 + 第 4.5 步住房压力）
6 提前选举条件检查（保护期/连续月计数/每任期一次）
7 到期选举、真实新任期与属性切换（零票重选不建任期）
8 本任期唯一一次建设判断（只读已结算正式 GDP）
9 新月份观察窗口开启（经营产出月份滚动 + 指数新窗口 + 人口市场窗口）
10 月界同日界时补竞选资源使用、治理检查与 AI 决策
```

日界用 `dateAtMinute(...).minuteOfDay === 0` 判断，日序号用 `daySerialAtMinute`；
不得用「累计分钟 ÷ 1440」。提案检查在同一个日界只执行一次，月界时排在月结之后。

## 7. 产品 → 股价的唯一通路

```
app/business.releaseProduct ─┐
                             ├→ securities-settlement.applyProductReleaseImpact（一次性、幂等）
app/business-settlement(AI) ─┘
business-settlement.processDayBoundary
  └→ recordDailySalesOfLatestProduct（只记录覆盖完整游戏日的区间）
       ↓
securities-settlement.fairPriceOf = 合理价值 × 销量因子 ÷ 有效股份
       ↓
features/stock.advanceMarket（同一份行情与 K 线）
```

- 发布冲击用等权平均 **A**（`averageAttributeOf`），销量模型用加权品质 **Q**（`features/market`），
  两者不互相替代。
- `Product.releaseImpactPct` 为 `null` 才计算，写入（含 0）即视为已结算；重复点击、读档、日结不再触发。
- 销量因子直接乘在锚点上，不做逐日连乘；`Product.dailyObservationStartMinute` 保证只有覆盖完整日的
  区间才产生样本。

## 8. 存档基础设施

```
storage.ts（入口，编排）
  ├→ save-types.ts        公共类型
  ├→ save-database.ts     IndexedDB 原始读写
  ├→ save-migrations.ts   版本链 + 受控修复 + 读档兼容规范化（速度镜像）
  └→ save-validation.ts   字段与跨切片一致性校验
```

- 迁移链 `v1 → … → v16` 完整保留，顺序与数据保留行为不变；
  迁移对 `app/state` 世界初始化辅助函数的依赖是**有意的例外**，集中留在 `save-migrations`，
  不扩散到其它基础设施代码，也不由此重新设计世界初始化。
- 校验只读不修：不一致就拒绝；`parseSnapshot` 依次做「迁移 → 兼容规范化 → 校验 → 返回快照」。
- 读档失败绝不替换当前进度：先回退上一份有效快照，仍失败则明确报错。

## 9. 运行时依赖与仅类型依赖

- **运行时**：`app → features → content/core`；`storage → save-*`；`ui → app`（视图与命令）。
- **仅类型**：`save-types` 只被类型引用；视图模型（`*View`）与 `ReadonlyGameState` 是纯类型；
  `ui` 不导入 `features` 的实现，只消费 `app` 暴露的视图与命令。
- 复用 `features` 的纯计算（如 `sharesOf`）属于正常复用，不是业务耦合，也不能据此把两层职责混在一起。

## 10. 仍然存在的行业假设（尚未抽象）

当前只有**科技企业**一种行业，以下位置带有科技行业假设，扩容前需要先拆分：

| 位置 | 假设 |
| --- | --- |
| `technology.companies[companyId]` | 每家企业都有一份科技切片（研发、产品、代际、日销量窗口） |
| `app/state.createInitialState` 与企业创建 | 建企业时同时建科技切片与初始产品 |
| `app/business-settlement` 销售与月报 | 收入来自「产品销售件数 × 单价」 |
| `securities-settlement.fairPriceOf` | 估值输入是账面权益 + 资本化利润 + 科技潜力 |
| `save-validation.validateTechnology` | 要求每家企业都有科技切片 |

通用部分（企业身份与状态、财务、股权、融资、治理、行情）已经与行业细节分离。
本轮不创建保险、零售、房地产等空模块，也不提前设计行业注册框架：真正增加第二个行业时，
再按那时真实的玩法需要拆分行业专属状态与计算。

## 11. 城市政府与动态人口（v11 引入，v12/v13 修正）

### 11.1 三套人口分类互不替代

| 分类 | 权威来源 | 用途 |
| --- | --- | --- |
| 经济阶层（低/中/高） | `population.classes` | 人口增长与月度阶层流动 |
| 政治交叉群体（3 收入 × 4 利益 = 12） | `population.classes` + `content/politics` 条件权重 | 满意度、支持率与票数推导；政治切片只存满意度与监测计数 |
| 消费偏好群体 | `population.groups` | 既有市场销量计算（**不随阶层比例联动**） |

12 个政治群体人数由收入阶层人数 × 该收入内部利益权重派生，合计严格等于城市人口；
收入/利益边际（7 个主要群体）只是展示与提前选举监测视角，不能再加到总人口上。
经济阶层比例变化**不**改变消费偏好权重：二者是不同口径，界面分别展示，不宣称已联动。

### 11.2 政府四件套

`features/government` 把「机构 / 职位 / 人物 / 任职记录」分开表达：

- 机构名与职位名是常量（`塔科夫管理式民主政府` / 首席行政负责人），不存可变副本；
- 人物是当前负责人的快照（过渡负责人或当选人）；
- 任职记录按时间追加，记录每届负责人、起止时间与当届政策；
- 政策效果只有一份定义（`content/government.ts` 的 `POLICY_EFFECTS`），业务模块不自己写数值。

政策以**显式输入**进入业务层（`app/policy.ts` → `activePolicyEffects`）：

| 政策 | 作用点 | 不作用点 |
| --- | --- | --- |
| 创新（研发 +5%） | `features/technology.computeAttributes` 的 growth 段 | 永久科技值、最终 0～100 属性 |
| 就业（运营成本 −5%） | `settleCompanyExpensesTo` 的固定运营费 | 工资、营销、研发、历史应付 |
| 基建（销售成本 −2%） | `settleCompanySales` 的新发生销售成本 | 已发生应付、产品基础成本字段 |

同一时期只有一套政策，不跨届叠加；换届前先用旧政策结清所有未清算公司的销售与费用区间。

### 11.3 人口月结的取数顺序

```
月末边界
  1. 采集经营观察：企业等权的 j/i/p（任职覆盖、工资拖欠、研发投入、停业与清算）
  2. 结算证券观察窗口：等权调整后月回报 R、涨跌覆盖比例
  3. 落账观察样本，按 0.5/0.3/0.2 权重得到本月 j/i/p
  4. 人口模块统一乘 0.30 → J/I/P → 四方向流动率 → 阶层结算（总人口守恒）
  5. 重置自然增长锚点
```

政治满意度**不在人口模块内**：`app/politics-simulation` 在同一月界、人口月结之后
用这份真实经济摘要更新 12 个群体满意度（`features/population` 只负责自己的增长与阶层流动）。

经营与证券样本都要求「覆盖完整观察月」：旧档迁移后的第一个不完整月保持中性，
等获得完整观察月才启用；J/I 需要三个完整观察月，P 按可用样本归一化。

### 11.4 证券月回报的机械修正

`app/population-market.ts` 保存月初基准与事件调整，**不**从可能被截断的价格历史反推整月回报：

| 事件 | 处理 |
| --- | --- |
| 增发摊薄 | 按事件前后价格比例累乘参考因子（`referenceFactor`），并同步换算累计现金到当前价格尺度；事件当刻参考财富连续，不判为财富损失 |
| 分红 | 只累计每股现金分配；除息不再叠加偏移，避免同一笔钱记两次 |
| 清算终止 | 按真实每股回收价值结账，样本保留到本月底（损失不会被删掉），分红现金同时保留 |
| 交易 / 回购 / 发布 / 经营行情 | 真实价格变化，不修正 |

参考财富口径：`参考基准 = 月初价格 × Π(机械事件后价格 ÷ 机械事件前价格)`，
`累计现金` 为每笔分红按之后的机械事件比例换算到当前价格尺度，
`月回报 = (期末价值 + 累计现金) ÷ 参考基准 − 1`。
绝对价差相加是错误口径：它会把机械下调从后续真实跌幅里减掉（100 → 机械 50 → 真实 25 会算成 −25%，正确是 −50%）。
累计现金不与参考基准同尺度同样是错误口径：100 → 分红 20 后 80 → 机械 40 会被算成 +20%，正确是 0%。

### 11.5 存档 v12/v13 的兼容处理

- 机械偏移改为参考因子是真实持久字段变化：v11 的 `mechanicalOffset` 无法无损换算成价格比例，
  若剩余观察月内曾发生机械调整，则将该不完整月降级为中性（`fixedAtMonthStart = false`），下个完整月恢复；
  没有机械调整的样本只补 `referenceFactor = 1`，数值不变。
- v12 → v13 修正累计分红现金的计量尺度：旧档同时保存了累计现金与最终参考因子，
  但无法判断分红与机械事件的先后顺序；当参考因子 ≠ 1 且累计现金 > 0 时把剩余不完整月降级为中性，
  其余样本原样保留；历史已结算摘要不重算。
- v11 首届竞选错误地以 0 基础资源启动：迁移只对 `base === 0` 的候选人补到配置值，并把资源锚点移到迁移时刻，
  补发的资源只能用于迁移之后；已结算的历史选举不重演、不重抽。
- v11 首次投票日程多加了 08:00：迁移只修尚未投票、且由开局公式生成的第 1 届；
  若修正后的时刻已经过去，则安排到迁移后下一分钟开票，不制造非法时间状态。

## 12. 人物生存、物品栏与便利店（v14）

### 12.1 三层职责

| 层 | 内容 |
| --- | --- |
| `content/survival.ts` / `items.ts` / `shops.ts` | 生存参数、物品静态数据、便利店目录与价格；无业务逻辑、无库存 |
| `features/survival` / `inventory` / `shop` | 生存值纯计算、背包数量与请求去重、购买报价；不读完整 GameState |
| `app/supplies` / `supplies-view` | 购买/使用命令（钱、物品、生存同一次提交）与只读视图 |
| `ui/shop-panel` / `inventory-panel` / `hud` | 便利店界面、人物管理「背包」栏目、始终可见的生存 HUD |

便利店不是可经营企业：不接入科技产品市场，不模拟商店利润、工资账户、补货或供应链。

### 12.2 时间与工资衔接

- 生存消耗只在 `app/timeAdvance.advanceGameTime` 的每个时间区间内执行一次：
  `advanceSurvival(draft.survival, segment.minutes)`；暂停、后台、关页面不推进时间，因此不消耗、也不离线恢复。
- 工资效率取**区间开始**的生存状态：`E = max(0, 1 − 饥饿归零 0.5 − 水分归零 0.5)`；
  先按 `实际分钟 × E` 计薪，再结算本区间生存消耗。归零后的后续区间才采用降低后的效率。
- `features/employment.accrueWork` 是唯一计薪实现：分子 = 时薪(分) × 分钟 × 效率百分比(0～100) + 余数，
  按 `6000` 折成分。每日工时上限仍按**实际出勤分钟**（`workedMinutesByDay`）执行。
  效率 100% 时与旧版完全一致；切换岗位只改 jobId，不重置已赚工资、工时、班次或余数。
- 移动倍率 `M = max(0, 1 − 0.15×饥饿归零 − 0.15×水分归零)` 由应用层显式传给 `world.update`，
  world/player 不读取生存状态。
- `AdvanceResult` 同时返回本次实际出勤 `workedMinutes` 与折算有效计薪 `effectiveWorkMinutes`：
  每个工作区间只计算一次区间开始 E，同一份 E 用于计薪与统计；工作提示的平均效率由这两个
  本次推进统计计算，不再把起始效率当作整班效率。

### 12.3 便利店购买上下文与请求协议

`Game.activeShopId` 只在玩家通过建筑 F 交互打开便利店时设置，关闭/打开其它面板/读档/新游戏即清空；
`app/supplies.purchase` 要求传入的 shopId 与它一致，防止仅凭 UI 远程购物。
购买只从个人现金扣款，现金不足整体拒绝；扣款、流水、加物品、协议收据同一次提交完成。

请求身份使用持久化命名空间 + 单调序号（`operationEpoch`、`nextOperationSeq`），
requestId 固定为 `supplies:<epoch>:<sequence>`。最多保留 64 条收据用于内容重放核对；
被裁剪的旧序号由高水位判为 `REQUEST_EXPIRED`，不会因为没有收据而被当成新操作。
只有 sequence = nextOperationSeq 才进入业务写入，成功后落收据并把序号 +1；
小于高水位且有收据按 kind/shopId/itemId/quantity 核对为 `REPLAYED`；大于为乱序拒绝；
命名空间不符或旧随机 UUID 为非法请求。UI 从只读 `requestCursor` 生成 requestId，读取不消耗序号。

### 12.4 存档 v14 → v15

v14 新增 `survival`（内部单位整数）与 `inventory`（物品数量 + 最多 64 条请求去重记录），
工资余数分母由 60 改为 6000（旧档余数精确 ×100），旧档生存值满值、背包为空。

v15 新增 `inventory.operationEpoch` 与 `inventory.nextOperationSeq`；旧随机 UUID 请求保留为
legacy 收据（protocolVersion=0、sequence=null、shopId=null），只作历史、不授权重放；
迁移不重置物品、金钱、生存与其他业务，也不尝试给旧请求补序号。

### 12.5 场景比例与碰撞回退

模型缩放集中在 `content/scene-scale.ts`：记录 buildingId、参照类型、原模型实测高度与目标米制高度；
`applyBuildingModel` 优先使用 `target/source` 的等比系数，模型加载后仍按真实包围盒写回原 collider。
旧 GLB 均为单 mesh、无门洞/楼层节点，只能以整体高度为设计参照，不能伪造门洞测量。
无参照的模型保留旧 min-box 回退。旧档人物因模型变大落入碰撞体时，world 只按最小方向推出，
不无条件传送回出生点。详细测量与最终尺寸见 `docs/scene-scale.md`。

## 13. 城市统计、连续指数、政治满意度与城区扩张（v16）

### 13.1 四个职责分明的切片

| 切片 / 模块 | 负责 | 不负责 |
| --- | --- | --- |
| `features/city-statistics` + `app/city-statistics` + `app/city-stock-index` | 经营产出登记、基础 GDP、连续全市场指数观察、月份统计快照 | 不控制企业、人口或股票；不建 GDP 财务账户 |
| `features/politics` + `app/politics-simulation` | 12 群体满意度、边际统计、提前选举监测与保护期 | 不保存第二份城市总人口；不直接改 elections |
| `features/city-development` + `app/city-development` | 建设门槛、每任期一次判断、阶段预留、项目与永久历史、招商槽位 | 不直接创建 Three.js 对象 |
| `features/city-layout` | 逻辑地图：边界、道路、地块、建筑与稳定标识 | 不含 Three.js / DOM / 经济结算 |

跨模块协作全部由 `app` 层显式调用完成（月界顺序见第 6 节），没有全局事件总线。

### 13.2 游戏 GDP（实时累计发展口径）

```
G0      = 开局各本地在售产品预计日产出之和 × 360   （只生成一次，读档不重算）
P(t)    = 观察开始后累计经营产出（不按月/年清零）
I(t)    = 连续全市场指数（初始 100，按月链结）
S(t)    = round(G0 × 0.30 × (I(t) / 100 − 1))        （当前股市调整值，不是每日收入）
G(t)    = G0 + P(t) + S(t)
```

**实时口径与已结算口径分离**：

- 实时界面：`P实时 = 已结算累计 + 当前可结算但尚未入账的产出`，
  `G实时 = G0 + P实时 + S`。查询只读，不推进销售游标、不改财务与统计状态，
  也不把待结算写进持久累计；正式结算时「待结算 −」与「已结算 +」同额衔接，实时 GDP 不跳变。
- 已结算口径：`settledGdpCentsOf` 只用于**销售已全部结清**的场景（选举前先按旧任期属性结清，
  再做本任期建设判断）；此时两者相等，不得在实时界面误用。
- 月度快照在销售结清后固化（`snapshotCityMonth`），持久累计语义不变。

- P 只来自 `settleCompanySales` 的成功结算（实际售出数量 × 当时成交单价），
  用企业操作序号单调高水位防重复；清算前的产出保留。
- 销售计算只有一份实现：`app/city-statistics.computeSalesPlan`（纯投影），
  正式结算与实时预览共用；实时界面显示「已结算 + 待结算」，切换时不双计。
- 股票只通过 S 这一条路径进入 GDP；股票成交额、融资、增发到账、贷款、个人资产变化
  都不计入经营产出。
- 指数与人口月回报是两个观察用途：数学口径同源，但窗口完全独立、互不重置。

### 13.3 政治交叉群体与满意度

- 3 收入阶层 × 4 利益归属 = 12 个互不重复群体；`N(收入,利益) = classes[收入] × 条件权重`。
- 满意度 0～100（新游戏 50），与支持率分开；进入原评分口径用 `(S − 50) / 50`。
- 目标值 `T = clamp(50 + 10M + 15E − 25P − 10C + 10D, 0, 100)`，
  月度 `S += clamp(0.20 × (T − S), −4, 4)`；人口记录里的 J/I/P 已乘 0.30，使用前显式还原。
- `C`（全城生活成本恶化）当前**没有真实数据源**，统一中性（`hasSample=false`）：
  玩家个人月报的欠租/欠生活费不是城市物价，不得用来降低全体市民满意度。
- `D`（建设履约）只绑定**当前真实任期**（`currentHolder.termId` / `activeTermOf`）：
  只看本任期批准且已到计划完成时刻的项目，前任项目不计入；本任期无到期承诺时中性。
  历史城区、项目与完成记录全部保留，换届不删除城区，也不追加「历史公共设施存量」加分规则。
- 提前选举：全市平均 < 35，或 7 个主要群体之一 < 25 且占人口 ≥ 20%，连续 3 个已结束月成立；
  新任政府保护期 180 日（期内只记录）、每个真实任期最多一次、提前竞选仍为 30 日。
- 当前真实任期只认 `government.currentHolder.termId`，**不用** `elections.termSeq`（含零票重选轮次）。

### 13.4 建设与逻辑城区

- 只在「成功选举并形成真实新任期」后判断一次，门槛 `G0 + 300 万元 × 1.6^阶段`，
  每项目固定 30 游戏日；永久防重复靠单调任期序号高水位 + 阶段预留位图 + 永久完成历史。
- 项目批准即预留唯一位置；完工时才把条带城区写入逻辑地图，并新增一个科技招商槽位。
- 新区沿现有城区同一方向拼接：宽 60 米、深度相同；横向道路与基础东西主路同轴相接。
- 运行时招商只走正常业务路径（真实出资划转、股权、科技状态、AI 记忆），
  **禁止**调用开局种子函数；资金不足保留待招商，按游戏日重试。

### 13.5 世界与读档碰撞修复

- `world.syncLayout(readonlyLayoutView)` 按稳定 ID 增量同步建筑/道路/地面/碰撞/交互，
  不重建整个 World；人物移动边界、位置修正与地面渲染共用同一份动态 `bounds`。
- 读档顺序：恢复逻辑地图 → 同步建筑实例 → 恢复原始存档 pose → 等待该布局最终碰撞就绪
  → 仅当原位置实际非法时做一次最小必要推出（模型加载失败按 fallback 碰撞同样视为就绪）。
- 异步模型加载用 `layoutRevision` + `modelGeneration` 双检查，旧读档的回调不能写回新布局；
  加载期间锁人物移动与 F 交互，但不暂停经济模拟。

### 13.6 存档 v15 → v16

新增 `cityStatistics`、`cityLayout`、`cityDevelopment` 三个切片，并把 `politics` 换成 12 群体、
`government` 任期补方向/效果快照/来源与 `offices`、`world.revision` 升到 3。迁移规则见
`docs/contracts.md` 第二十四节；读档不重算 G0、不重复链结指数、不重建公司、不重复建设。

## 14. 房地产与宏观住房（v17）

### 14.1 三个切片的职责

| 切片 / 模块 | 负责 | 不负责 |
| --- | --- | --- |
| `features/real-estate` | 产权、入住、挂牌、AI 土地报价、成交记录与玩家已实现价差 | 不保存余额、不算需求、不写满意度 |
| `features/housing` | 3 个收入群组的家庭数、居住分配、购房意愿、负担能力与住房压力（纯计算） | 不保存余额、不保存第二份人口、不读写房产 |
| `app/real-estate` / `app/housing-simulation` | 付款与产权转移的唯一写入、月度收入/消费/匹配/成交编排 | 不读 DOM、不建 Three.js 对象 |

`app/residence.ts` 是「永久居住权 → 月度应缴」的唯一口径：月结与界面都读它，
免租在**报价**环节生效，不做事后返款。

### 14.2 产权、入住与保护期

- 产权主体只有三种：`player`、`household`（群组 id）、`investor`（`finance` 的 investor 主体）。
  非玩家主体都有真实余额与流水，不用无余额的 `external` 冒充买地买房的资金来源。
- 入住状态与产权正交：`free-residence`（玩家永久居住权，非玩家产权）、`owner-occupied`（居民自住）、
  `vacant`（空置，含玩家与 AI 持有）。产权变更不会自动改变玩家居住地点。
- 保护期只对**未售新住宅**有效：`firstSoldAtMinute === null` 且 `now < protectionUntilMinute`。
  开局 99 套用「开局第 7 个月月初」的绝对时刻（旧档迁移不会重新获得整段保护）；
  新区住宅从交付时刻起算 180 游戏日。土地不适用保护期。

### 14.3 资金与成交

```
玩家买住宅/土地：个人银行存款 → 卖方主体   （类别 home-purchase / land-purchase，不计个人收支）
玩家卖住宅/土地：买方主体 → 个人银行存款   （类别 home-sale / land-sale，不计个人收支）
居民买住宅：群组账户 → 卖方主体            （群组储蓄真实扣除）
AI 买住宅：   投资者账户 → 卖方主体        （受「余额 − 预留」限制）
```

- 成交只有一份写入实现 `app/real-estate.executePurchase`：同一份草稿里先划款、再改产权与挂牌、
  再写成交记录；任一步失败整份回滚，不会留下双重产权或部分入住。
- 挂牌价与版本号一起校验：界面确认过的价格/版本变化即 `PRICE_CHANGED` / `LISTING_CHANGED`。
- AI 土地报价用 `reserveFunds(..., ref = offerId)` 承诺资金，接受时只消费该单据；
  过期（日界）或拒绝必须释放预留，且同一地块同时只有一份有效报价。
- 已实现价差 = 成交价 − 成本基础（`costBasisCents`）；未实现部分只看参考估值，
  两者分开，净资产只把物业估值计入一次。

### 14.4 宏观居民与住房市场

- 家庭数 = `floor(阶层人数 ÷ 家庭规模)`，每月随人口月结同步；人口仍是唯一权威。
- 群组资金是 `finance` 的 `household:<id>` 主体账户，本切片不保存余额副本。
  收入是**配置的宏观外部输入**，不从企业工资额重复注入；单据 id 含月份，重复推进不重复入账。
- 居住分配互斥：`ownedHouseholds` + 租住 = 家庭数；购房意愿是独立维度（租住家庭可以有首次购房意愿）。
- 购买力受三个约束取小：意愿存量、群组内储蓄档位分布（只有倍数够的那部分家庭有购买力）、
  群组账户真实储蓄；另有「房价 ≤ 家庭年收入 × 可负担倍数」的整组门槛。
  平均储蓄不能让所有家庭同时被判定有购买力。
- 月度匹配：群组轮换起点（`monthIndex % 群组数`）+ 户型偏好 + 单价升序，
  每次成交都重新校验资金、需求、产权与保护期；不设「每月必卖 N 套」。
- 改善置换：买新房后旧房释放为空置并挂牌，家庭始终只算一套自住；旧房真正卖出才产生资金流入。
- 住房压力 `H ∈ [0,1]`（0.5 中性）由房价/收入比与未满足意愿算出，按收入阶层映射进
  政治满意度公式的 `−12 × (H − 0.5)` 项；没有当月样本时中性。
- 界面不展示群组家庭数、资金池、购买力档位、匹配算法或内部区域参数。

### 14.5 与城市建设的衔接

- 建设完成时由 `app/city-development.deliverDistrictHousing` 按真实布局把住宅单元交付一次，
  幂等（按建筑 id 判重），读档与重复推进不会重复交房；旧档迁移为已完成的住房新区补齐单元。
- 交付**不**登记 GDP、不发钱、不改变人口；住宅交付本身不叠加新的 GDP 产出。
- 房地产估值、成交与宏观储蓄注入都不进入 `cityStatistics`；股票仍只通过 `S(t)` 进入 GDP。
- 公共新区的建设用地不进入交易：储备土地是独立的地块记录，拒售不会阻塞城市扩张。

### 14.6 存档 v16 → v17

新增 `realEstate`、`housing` 与 `finance` 的 `household` 主体账户、6 个新流水类别。
迁移规则见 `docs/contracts.md` 第二十五节；读档不重复注资、不重复发房、不重写历史月报。

## 房地产验收问题修复（存档 v18）

- 住宅挂牌使用每处房产持久化的 `listingVersion` 高水位；撤销、过户不清零，重挂和卖方改价均单调递增。v17 → v18 按现有挂牌版本初始化，无挂牌初始化为 0；历史交易和余额不变。
- 月度市场先排除卖方账户不能接收货款、AI 可用余额不足的房源；成交中的意外异常向 `GameStore.run` 传播，回滚整次月结，不允许吞掉异常后提交半笔交易。
- 改善置换只匹配在本群组中有可追踪自住房的家庭；成交后旧房释放并挂牌。宏观背景自有家庭暂无可追踪旧房，不执行置换，也不消费改善意愿。
- 住房月结依据同期人口月结记录的实际四条阶层流动，按转层前人数比例将群组储蓄、住房分配、需求和可追踪产权转移；自然增长不触发资金转移。同月多条流动均使用原始快照，整数与金额余数保留在来源群组。
- 家庭数向下取整为 0 时，剩余资金与产权转给有家庭的接收群组；找不到接收方时回滚，避免资产滞留。具体房屋超过接收群组可居住容量时保留产权并改为空置。
