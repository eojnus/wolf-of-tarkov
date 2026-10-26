/**
 * 企业经营相关参数 —— 人口、市场、研发、人才、企业与 AI 的全部可调默认值。
 *
 * 这些数值是实现级的首轮默认值，不是核心规则；替换参数不应改动任何业务代码。
 * 界面必须如实说明：本轮是无价格敏感度、无供给上限的抽象市场模型。
 */

/* ---------------------------------------------------------------- 人口 */

export interface PopulationGroupConfig {
  readonly id: string;
  readonly name: string;
  /** 人口权重，合计应为 1。 */
  readonly weight: number;
  /** 品质偏好权重（性能 / 可靠性 / 易用性），合计应为 1。 */
  readonly preferences: {
    readonly performance: number;
    readonly reliability: number;
    readonly usability: number;
  };
  readonly note: string;
}

export const POPULATION_GROUPS: readonly PopulationGroupConfig[] = [
  {
    id: 'low',
    name: '低收入群体',
    weight: 0.5,
    preferences: { performance: 0.2, reliability: 0.5, usability: 0.3 },
    note: '更看重耐用与省心，对参数不敏感。',
  },
  {
    id: 'mid',
    name: '中等收入群体',
    weight: 0.35,
    preferences: { performance: 0.4, reliability: 0.3, usability: 0.3 },
    note: '看重性能，同时要求稳定与易上手。',
  },
  {
    id: 'high',
    name: '高收入群体',
    weight: 0.15,
    preferences: { performance: 0.6, reliability: 0.2, usability: 0.2 },
    note: '为性能买单，愿意容忍一些毛刺。',
  },
];

/* ---------------------------------------------------------------- 市场 */

export const PRODUCT_MARKET = {
  /** 品质分数为参考值时的日销量（件）。 */
  baseDailyUnits: 10,
  /** 品质分数的参考值：Q=50 时日销量等于基础值。 */
  qualityReference: 50,
  /** 营销参考预算（分/天）：100 元。营销系数 = 1 + M/(M+参考)。 */
  marketingReferenceDailyCents: 10_000,
  /** 营销日预算上限（分/天）：5,000 元，避免任意大输入破坏状态。 */
  maxMarketingDailyCents: 500_000,
  /** 每落后一代的销量系数（首轮默认 0.5）。 */
  generationDecay: 0.5,
} as const;

/* ---------------------------------------------------------------- 研发 */

export const TECH = {
  /** 永久科技积累初始值。 */
  initialAccumulation: 10,
  /** 研发参考预算（分）：1,000 元。 */
  researchReferenceBudgetCents: 100_000,
  /** 研发增长系数：预算充足时把基础值放大的上限规模。 */
  researchGrowthCoefficient: 40,
  /** 正常研发天数：此天数内收益线性增长，F(90)=1。 */
  baseDays: 90,
  /** 收益封顶天数：F(720)=2，此后不再增长。 */
  capDays: 720,
  /** 允许输入的最长研发天数（超过 capDays 只提示无额外收益）。 */
  maxPlannedDays: 3_600,
  /** 单次立项的最低预算（分）：100 元。 */
  minResearchBudgetCents: 10_000,
  /** 重点属性系数。 */
  focusCoefficient: 1.4,
  /** 非重点属性系数。 */
  otherCoefficient: 0.8,
  /** 属性的显示上限（0～100）。 */
  attributeScale: 100,
  /** 单位成本基础（分）：20 元。 */
  unitCostBaseCents: 2_000,
  /** 单位成本随平均属性的增量（分/点）。 */
  unitCostPerQualityCents: 40,
  /** 建议售价 = 单位成本 × 该倍数（仅用于界面预填，不是规则）。 */
  suggestedPriceMultiplier: 2.5,
  /** 技术积累投入：参考预算、增长系数与输入范围。 */
  accumulationInvestment: {
    referenceBudgetCents: 200_000,
    growthCoefficient: 8,
    minCents: 10_000,
    maxCents: 5_000_000,
  },
  /** 首个产品的默认名称提示。 */
  defaultProductName: '新星一号',
} as const;

export type FocusKey = 'performance' | 'reliability' | 'usability';

export const FOCUS_OPTIONS: readonly { readonly id: FocusKey; readonly name: string }[] = [
  { id: 'performance', name: '性能' },
  { id: 'reliability', name: '可靠性' },
  { id: 'usability', name: '易用性' },
];

/* ---------------------------------------------------------------- 人才 */

export interface TalentCandidateConfig {
  readonly id: string;
  readonly name: string;
  readonly role: 'research';
  /** 科研能力：直接叠加到公司有效科技水平。 */
  readonly ability: number;
  readonly monthlySalaryCents: number;
  readonly note: string;
}

export const TALENT_CANDIDATES: readonly TalentCandidateConfig[] = [
  {
    id: 'talent-05',
    name: '周叙',
    role: 'research',
    ability: 5,
    monthlySalaryCents: 300_000,
    note: '应届研究员，成本低。',
  },
  {
    id: 'talent-15',
    name: '林知远',
    role: 'research',
    ability: 15,
    monthlySalaryCents: 800_000,
    note: '带过两个量产项目的骨干。',
  },
  {
    id: 'talent-25',
    name: '郑寒',
    role: 'research',
    ability: 25,
    monthlySalaryCents: 1_800_000,
    note: '业内知名技术负责人。',
  },
];

/* ---------------------------------------------------------------- 企业 */

export const ENTERPRISE_RULES = {
  /**
   * 初始出资下限（分）：10,000 元。
   * 这是从个人银行存款转入企业账户的**创始资本**（会计上的实收资本），
   * 不是手续费，也不构成额外费用；追加出资不受这个下限约束。
   */
  minCapitalCents: 1_000_000,
  /** 单次出资 / 追加出资上限（分）：500,000 元。 */
  maxCapitalCents: 50_000_000,
  /** 每日固定运营费（分）：30 元。 */
  operatingCostDailyCents: 3_000,
  /** 分红最小金额（分）：1 元。 */
  minDividendCents: 100,
  /** 危机后多少游戏日仍无改善则由 AI 自行清算。 */
  crisisGraceDays: 30,
  /** 企业月报保留份数。 */
  maxReports: 12,
  /** 公司名长度限制。 */
  nameMinLength: 2,
  nameMaxLength: 12,
  /** 产品名长度限制。 */
  productNameMinLength: 1,
  productNameMaxLength: 16,
  /** 售价范围（分）：1 元 ～ 100,000 元。 */
  minPriceCents: 100,
  maxPriceCents: 10_000_000,
} as const;

/* ---------------------------------------------------------------- AI */

export interface AiCompanyConfig {
  readonly id: string;
  readonly name: string;
  /** 固定有效科技水平，不随投入增长。 */
  readonly techLevel: number;
  readonly initialCashCents: number;
  readonly focus: FocusKey;
  readonly researchDays: number;
  readonly researchBudgetCents: number;
  readonly marketingDailyCents: number;
  /** 可选的研发时长候选，按顺序取第一个可行项。 */
  readonly researchDayOptions: readonly number[];
  readonly strategy: 'aggressive' | 'steady' | 'frugal';
  /** 首款已上市产品。 */
  readonly firstProduct: {
    readonly name: string;
    readonly priceCents: number;
    readonly attributes: {
      readonly performance: number;
      readonly reliability: number;
      readonly usability: number;
    };
  };
}

export const AI_COMPANIES: readonly AiCompanyConfig[] = [
  {
    id: 'ai-tianji',
    name: '天机智算',
    techLevel: 40,
    initialCashCents: 12_000_000,
    focus: 'performance',
    researchDays: 180,
    researchBudgetCents: 600_000,
    marketingDailyCents: 30_000,
    researchDayOptions: [180, 360],
    strategy: 'aggressive',
    firstProduct: {
      name: '天机 X1',
      priceCents: 26_000,
      attributes: { performance: 62, reliability: 58, usability: 55 },
    },
  },
  {
    id: 'ai-qingyu',
    name: '青屿智能',
    techLevel: 30,
    initialCashCents: 8_000_000,
    focus: 'usability',
    researchDays: 180,
    researchBudgetCents: 350_000,
    marketingDailyCents: 15_000,
    researchDayOptions: [90, 180],
    strategy: 'steady',
    firstProduct: {
      name: '青屿 Lite',
      priceCents: 18_000,
      attributes: { performance: 50, reliability: 52, usability: 54 },
    },
  },
  {
    id: 'ai-weilan',
    name: '微澜科技',
    techLevel: 15,
    initialCashCents: 3_000_000,
    focus: 'reliability',
    researchDays: 90,
    researchBudgetCents: 120_000,
    marketingDailyCents: 6_000,
    researchDayOptions: [90],
    strategy: 'frugal',
    firstProduct: {
      name: '微澜 S',
      priceCents: 12_000,
      attributes: { performance: 38, reliability: 40, usability: 36 },
    },
  },
];

export function findAiConfig(id: string): AiCompanyConfig | null {
  return AI_COMPANIES.find((company) => company.id === id) ?? null;
}

export function findTalentCandidate(id: string): TalentCandidateConfig | null {
  return TALENT_CANDIDATES.find((candidate) => candidate.id === id) ?? null;
}
