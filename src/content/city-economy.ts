/**
 * 城市经济统计与建设参数 —— 只保存数值与文案，不含业务计算。
 *
 * 口径（本版固定，改口径必须同时升级规则版本与存档迁移）：
 *  - 游戏 GDP 是「实时累计发展指标」，不是现实年度清零口径；
 *  - G(t) = 开局基础 GDP G0 + 累计经营产出 P(t) + 股市调整 S(t)；
 *  - S(t) = round(G0 × 30% × (I(t) / 100 − 1))，I 是连续全市场指数；
 *  - P(t) 只来自真实销售结算，不按月/年清零，也不从财务流水反推。
 *
 * 所有金额单位为「分」，股数为整数股，比例为小数。
 */

/** GDP 与统计口径版本：写入基础 GDP 快照，读档与迁移都不得重算。 */
export const CITY_ECONOMY_RULE_VERSION = 1;

export const CITY_ECONOMY_RULES = {
  /** 基础 GDP 的背景估算天数：用开局在售产品的预计日产出来估算过去一年。 */
  baseGdpDays: 360,
  /** 股市调整权重：30% 的基础 GDP 规模。 */
  stockWeight: 0.3,
  /** 连续全市场指数的起点。 */
  indexStartValue: 100,
  /** 指数历史保留的已结算月份数量。 */
  indexHistoryLimit: 24,
  /** 城市统计月度快照保留数量（只用于趋势展示，不限制建设）。 */
  monthSnapshotLimit: 24,
  /** 实时待结算说明使用的标题（界面文案集中在配置）。 */
  labels: {
    baseGdp: '开局基础 GDP',
    output: '累计经营产出',
    stockAdjust: '股市调整值',
    index: '全市场指数',
    pending: '待结算',
    settled: '已结算',
  },
} as const;

/**
 * 长期统计的金额边界。
 *
 * 单笔交易上限（`assertMoneyRange` 的 1e12 分）只适用于单次财务动作；
 * 累计经营产出、GDP、基础 GDP 是长期累计值，不能套用该上限，
 * 但必须仍然是**安全整数**且有限，否则拒绝读档。
 */
export const CITY_STATISTICS_LIMITS = {
  /** 长期累计金额允许的最大值（安全整数范围内）。 */
  maxAggregateCents: Number.MAX_SAFE_INTEGER,
  /** 单次销售结算登记进统计的金额仍然必须落在单笔金额上限内。 */
  maxSingleSettlementCents: 1_000_000_000_000,
} as const;

/**
 * 城市建设（GDP 驱动扩张）参数。
 *
 * 门槛公式：threshold(k) = G0 + firstThreshold × 1.6^k，k 为从 0 开始的阶段序号。
 * 建设只在「成功选举并形成真实新任期」后判断一次，使用当时的实时 G(t)。
 */
export const CITY_DEVELOPMENT_RULES = {
  /** 第一个建设门槛增量：G0 + 300 万元（分 = 300_000_000）。 */
  firstThresholdCents: 300_000_000,
  /** 后续阶段的等比递增。 */
  thresholdGrowth: 1.6,
  /** 每个项目固定建设时长（游戏日）。 */
  projectDays: 30,
  /** 首版提供的扩张位置（阶段）数量。 */
  stageCount: 3,
  /** 永久建设判断记录保留上限（防重复依赖单调高水位，不依赖本上限）。 */
  judgementHistoryLimit: 24,
  /** 永久建设历史保留上限（防重复依赖已用阶段集合）。 */
  completionHistoryLimit: 24,
  /** 运行时招商的基础信息。 */
  investment: {
    /** 新科技 AI 公司创始资金目标（分 = 50,000 元）。 */
    targetFundingCents: 5_000_000,
    /** 新公司初始科技值。 */
    initialTechLevel: 20,
    /** 资金不足时按游戏日节流重试的间隔（游戏日）。 */
    retryDays: 1,
  },
} as const;

/** 建设方向主题：与技术/商业/住房三个候选人方向一一对应。 */
export const DEVELOPMENT_DIRECTION_LABELS = {
  technology: '科技新区',
  commercial: '商业新区',
  housing: '住房新区',
} as const;

/**
 * 候选人政策 → 建设方向主题的唯一映射。
 * 建设方向由**真实当选任期**决定：科技方向建科技新区，以此类推。
 */
export const POLICY_TO_DEVELOPMENT_DIRECTION = {
  innovation: 'technology',
  employment: 'commercial',
  infrastructure: 'housing',
} as const;

/** 建设判断结果（持久化取值，界面文案另配）。 */
export const CONSTRUCTION_OUTCOME_LABELS = {
  approved: '已达到门槛并安排建设',
  'below-threshold': '未达到门槛',
  'no-slot': '已无剩余扩张位置',
  'legacy-skip': '接入前任期：不补做建设判断',
} as const;
