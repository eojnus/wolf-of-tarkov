/**
 * 资本与证券市场参数 —— 首轮默认值，尚未经过玩法平衡。
 *
 * 所有「金额」都是分，所有「股数」都是整数股。
 * 业务代码不得内联这些数字；调整数值不应改动任何规则。
 */

export interface InvestorConfig {
  readonly id: string;
  readonly name: string;
  /** 风险偏好 0～1：越高越愿意接受高估值、低金额的报价。 */
  readonly risk: number;
  /** 首次注资到其资金账户的金额（分），只发生一次。 */
  readonly initialCashCents: number;
  /** 单笔最大投资额（分）。 */
  readonly maxTicketCents: number;
  /** 报价相对目标金额的偏好倍数（1 表示按期望金额投）。 */
  readonly appetite: number;
  /** 相比基准估值愿意支付的溢价（0.92 = 折价 8%）。 */
  readonly valuationPremium: number;
  /** 一句话风格说明，仅用于界面。 */
  readonly note: string;
}

export const INVESTORS: readonly InvestorConfig[] = [
  {
    id: 'inv-yunshan',
    name: '云杉资本',
    risk: 0.3,
    initialCashCents: 60_000_000,
    maxTicketCents: 24_000_000,
    appetite: 1,
    valuationPremium: 0.94,
    note: '稳健型：金额大但压价，要求更低的估值',
  },
  {
    id: 'inv-xingye',
    name: '星野创投',
    risk: 0.8,
    initialCashCents: 40_000_000,
    maxTicketCents: 16_000_000,
    appetite: 0.62,
    valuationPremium: 1.18,
    note: '激进型：给更高估值，但只投一小部分',
  },
  {
    id: 'inv-beian',
    name: '北岸基金',
    risk: 0.2,
    initialCashCents: 90_000_000,
    maxTicketCents: 30_000_000,
    appetite: 1.35,
    valuationPremium: 0.88,
    note: '保守型：钱多、出价低，稀释最多',
  },
  {
    id: 'inv-shiguang',
    name: '拾光产业',
    risk: 0.55,
    initialCashCents: 25_000_000,
    maxTicketCents: 10_000_000,
    appetite: 0.9,
    valuationPremium: 1.04,
    note: '均衡型：金额与估值都比较中性',
  },
];

export function findInvestor(id: string): InvestorConfig | null {
  return INVESTORS.find((investor) => investor.id === id) ?? null;
}

/* ---------------------------------------------------------------- 股权 */

export const EQUITY_RULES = {
  /** 新公司成立时的总发行股数。 */
  initialShares: 100_000,
  /**
   * 三家 AI 公司的**历史**创始持股比例。
   * 它们「开局前已完成私募并上市」，属于既有事实，不从玩家公司的初始化规则推导。
   */
  founderRatio: 0.7,
  /**
   * 三家 AI 公司的历史做市库存比例。
   * 玩家新建公司**不得**使用这个比例：做市商不是无偿股东，
   * 库存只能通过真实股份转让取得（详见 EQUITY_RULES.playerFounderRatio）。
   */
  marketMakerRatio: 0.3,
  /** 玩家新建公司：初始股份 100% 归创始玩家，做市商不获得无偿股份。 */
  playerFounderRatio: 1,
  /** 库存股初始比例（不投票、不分红）。 */
  treasuryRatio: 0,
  /** 旧独立标的的初始流通股数（无发行公司，仅作为场内可交易总量）。 */
  standaloneFloat: 1_000_000,
  /** 单家公司最多保留的融资轮次记录（超出丢弃最旧的）。 */
  maxRounds: 12,
  /** 融资后若股东表决权低于该值，界面提示失去控制权。 */
  controlThreshold: 0.5,
  /** 首轮最多同时管理的公司数（通过 CEO 职位计算）。 */
  maxManagedCompanies: 1,
} as const;

/* ---------------------------------------------------------------- 融资 */

export const FINANCING_RULES = {
  /** 申请后多久投资者回应（游戏日）。 */
  respondDays: 1,
  /** 报价有效期（游戏日）。 */
  quoteValidDays: 7,
  /** 全部拒绝后多久可以再次申请（游戏日）。 */
  reapplyCooldownDays: 3,
  /** 同一轮最多展示的报价数量。 */
  maxQuotes: 3,
  /** 单份报价的最低金额（分）：低于此值不生成报价。 */
  minQuoteCents: 100_000,
  /** 单次申请可填的金额范围（分）。 */
  minRequestCents: 200_000,
  maxRequestCents: 40_000_000,
  /** 估值下限（分）：避免早期公司被极端稀释。 */
  preMoneyFloorCents: 8_000_000,
} as const;

/* ---------------------------------------------------------------- 估值 */

export const VALUATION_RULES = {
  /** 把最近月利润资本化的倍数（应计口径，未付费用也已扣除）。 */
  profitMultiple: 8,
  /** 资本化部分的绝对值上限：净资产的倍数。 */
  profitCapVsBook: 6,
  /** 每点永久科技积累折算的估值（分）。 */
  techValuePerPoint: 60_000,
  /** 技术潜力估值上限（分）。 */
  techValueCapCents: 12_000_000,
  /** 在研项目的预算按此比例计入潜力（分/分）。 */
  researchInProgressWeight: 0.8,
  /** 未上市公司也使用同一估值口径，但只作为账面参考。 */
  unlistedDiscount: 0.7,
  /** 每个行情节点向合理价值靠拢的比例。 */
  pullPerTick: 0.06,
  /** 单个节点相对合理价值的最大变动幅度。 */
  maxTickChangePct: 0.02,
} as const;

/* ---------------------------------------------------------------- 宣传 */

export const PROMOTION_RULES = {
  minCents: 200_000,
  maxCents: 10_000_000,
  /** 首轮固定 20% 失败率。 */
  failRate: 0.2,
  durationDays: 10,
  /** 成功时的最大估值溢价。 */
  maxBoostPct: 0.12,
  /** 预算达到该值时效果接近上限（边际收益递减）。 */
  referenceBudgetCents: 3_000_000,
} as const;

/* ---------------------------------------------------------------- 流动性 */

export const LIQUIDITY_RULES = {
  /** 做市商初始资金（分）：只有一个资金账户，按标的共享。 */
  deskCashCents: 120_000_000,
  /** 冲击成本参考股数：一次成交这么多股约产生 maxImpactPct 的冲击。 */
  impactReferenceShares: 20_000,
  /** 单次成交的最大价格冲击。 */
  maxImpactPct: 0.05,
  /** 单笔委托的最大股数（防止一次吃掉整个盘口）。 */
  maxOrderShares: 200_000,
  /** 每个证券保留的成交记录条数。 */
  tradeLogLimit: 40,
} as const;

/* ------------------------------------------------------ 产品与股价联动 */

/**
 * 产品首次发布对股价的一次性反应 —— 首轮可调初值，尚未做经济平衡。
 *
 * 属性口径 A =（performance + reliability + usability）÷ 3，使用原始精度判定，
 * 显示时才格式化为一位小数。它**不是**市场销量使用的加权品质 Q：
 * 销量模型保持原有加权公式不变，两个口径必须分开命名、分开使用。
 *
 * 门槛随发布前股价 P（元）抬升，避免低价股被同样的属性值反复推高：
 *   t = clamp((P − priceBaseYuan) ÷ priceSpanYuan, 0, 1)
 *   U = upperBase + upperSpan × t
 *   L = U × lowerRatio
 * 判定：A > U 正面；L ≤ A ≤ U 无额外影响；A < L 负面。
 */
export const PRODUCT_STOCK_RULES = {
  priceBaseYuan: 100,
  priceSpanYuan: 900,
  upperBase: 20,
  upperSpan: 60,
  lowerRatio: 0.5,
  /** 每偏离门槛 1 个属性点的影响（0.25%）。 */
  perPointPct: 0.0025,
  /** 单次发布影响的绝对值上限（5%）。 */
  maxImpactPct: 0.05,
  /** 观察最新发布产品最近多少个完整游戏日的实际日销量。 */
  salesWindowDays: 3,
  /** 每个产品保留的日销量记录条数（只需覆盖观察窗口与缓冲）。 */
  maxDailyRecords: 5,
  /** 销量信号权重：因子 = 1 + salesWeight × s，s ∈ [−1, 1]。 */
  salesWeight: 0.1,
  /** 尚无完整日销量时使用的中性信号。 */
  neutralSignal: 0,
} as const;

/**
 * 做市商的「愿售比例」—— 首轮可调初值。
 *
 * 愿售股数 = floor(做市库存 × 愿售比例)，永远受真实库存约束：
 * 它不转移股份、不创造资金、不增发，也不自动卖出任何人的持仓。
 * 行情上涨时小幅提高、下跌时小幅降低，单节点变动不超过 maxStepPerTick。
 */
export const MARKET_MAKING_RULES = {
  initialForSaleRatio: 0.8,
  minForSaleRatio: 0.6,
  maxForSaleRatio: 1,
  maxStepPerTick: 0.005,
} as const;

/* ---------------------------------------------------------------- 上市 */

export const LISTING_RULES = {
  /** 上市本身不收费、不注资；这里只保留一个明确的口径说明用字段。 */
  feeCents: 0,
  /** 上市后证券代码前缀。 */
  symbolPrefix: 'TK',
} as const;

/* ---------------------------------------------------------------- 治理 */

/**
 * 轻量外部股东提案：不新建董事人物与派系，只用「持股比例 + 经营结果 + 风险偏好」判断。
 *
 * - checkIntervalDays：每隔多少游戏日检查一次，避免每分钟重复提案；
 * - proposalCooldownDays：同一家公司两次外部提案之间的最短间隔；
 * - voteWindowDays：外部提案的表决窗口（玩家必须在此期间投票，否则按弃权处理）。
 */
export const GOVERNANCE_RULES = {
  checkIntervalDays: 4,
  proposalCooldownDays: 15,
  voteWindowDays: 2,
  /** 提出提案的最低持股比例（按有效股份）。 */
  minSponsorStake: 0.1,
  /** 任命自身为 CEO 所需的最低持股比例。 */
  minAppointStake: 0.2,
} as const;
