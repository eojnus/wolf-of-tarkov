/**
 * 房地产与宏观住房参数 —— 首版保守取值，**尚未经过经济平衡**。
 *
 * 所有金额单位为「分」，面积单位为平方米，时间单位为游戏分钟/游戏日。
 * 业务代码不得内联这些数字；调整数值不应改动任何规则。
 * 取值依据与未平衡说明见 `docs/real-estate-design.md` 与 `docs/decisions.md`。
 */

/* ---------------------------------------------------------------- 产权主体 */

/**
 * 非玩家产权主体的稳定 id。它们都是 `finance` 里真实的 `investor` 主体账户，
 * 有余额、有流水，不使用无余额的 `external` 冒充资金来源。
 */
export const PROPERTY_OWNER_IDS = {
  /** 晴川置业：99 套未售新住宅的初始出售方，资金为开局运营资本。 */
  developer: 'dev-qingchuan',
  /** 城市土地储备中心：4 块储备土地的出让方。 */
  landReserve: 'land-reserve',
  /** 岚亭置业：持有型地产投资者（买房持有，不建房）。 */
  holder: 're-lanting',
  /** 锦山土地：土地收购型投资者（只报土地价，不建房）。 */
  landSpeculator: 're-jinshan',
} as const;

export type PropertyOwnerId = (typeof PROPERTY_OWNER_IDS)[keyof typeof PROPERTY_OWNER_IDS];

export interface PropertyEntityConfig {
  readonly id: string;
  readonly name: string;
  readonly kind: 'developer' | 'land' | 'holder' | 'speculator';
  /** 开局一次性注资（分）：就是卖方/AI 的真实资金，不是凭空生成。 */
  readonly initialCashCents: number;
  /** 单笔最大出资（分），用于 AI 购房/购地。 */
  readonly maxTicketCents: number;
  /** 相对参考估值的出价倍数（1 表示按估值）。 */
  readonly bidPremium: number;
  /** 该主体是否会买住宅、是否会报土地价。 */
  readonly buysHomes: boolean;
  readonly bidsLand: boolean;
  readonly note: string;
}

export const PROPERTY_ENTITIES: readonly PropertyEntityConfig[] = [
  {
    id: PROPERTY_OWNER_IDS.developer,
    name: '晴川置业',
    kind: 'developer',
    // 出售方运营资本：用于说明卖方有真实资金，而不是只收钱不付钱。
    initialCashCents: 500_000_000,
    maxTicketCents: 0,
    bidPremium: 1,
    buysHomes: false,
    bidsLand: false,
    note: '晴川公寓 99 套未售新住宅的初始卖方；只卖不买（不做私人开发与拿地建房）。',
  },
  {
    id: PROPERTY_OWNER_IDS.landReserve,
    name: '城市土地储备中心',
    kind: 'land',
    initialCashCents: 100_000_000,
    maxTicketCents: 0,
    bidPremium: 1,
    buysHomes: false,
    bidsLand: false,
    note: '城市储备土地的出让方；新区建设用地仍为公共用地，不进入交易。',
  },
  {
    id: PROPERTY_OWNER_IDS.holder,
    name: '岚亭置业',
    kind: 'holder',
    initialCashCents: 600_000_000,
    maxTicketCents: 150_000_000,
    bidPremium: 1.03,
    buysHomes: true,
    bidsLand: false,
    note: '持有型地产投资者：在保护期结束后买入住宅并持有，不建房、不算租金回报。',
  },
  {
    id: PROPERTY_OWNER_IDS.landSpeculator,
    name: '锦山土地',
    kind: 'speculator',
    initialCashCents: 300_000_000,
    maxTicketCents: 120_000_000,
    bidPremium: 1.08,
    buysHomes: false,
    bidsLand: true,
    note: '土地收购型投资者：只对玩家持有的储备土地提出有期限报价，不建私人项目。',
  },
];

export function propertyEntityOf(id: string): PropertyEntityConfig | null {
  return PROPERTY_ENTITIES.find((entity) => entity.id === id) ?? null;
}

/* ------------------------------------------------------------------ 户型 */

export type HomeLayoutId = 'studio' | 'compact' | 'family';

export interface HomeLayoutConfig {
  readonly id: HomeLayoutId;
  readonly name: string;
  readonly areaSqm: number;
  /** 基准单价（分/㎡），实际售价再乘地段与供需系数。 */
  readonly pricePerSqmCents: number;
}

export const HOME_LAYOUTS: readonly HomeLayoutConfig[] = [
  { id: 'studio', name: '单间', areaSqm: 30, pricePerSqmCents: 580_000 },
  { id: 'compact', name: '紧凑两居', areaSqm: 62, pricePerSqmCents: 560_000 },
  { id: 'family', name: '家庭三居', areaSqm: 95, pricePerSqmCents: 600_000 },
];

export function homeLayoutOf(id: string): HomeLayoutConfig | null {
  return HOME_LAYOUTS.find((layout) => layout.id === id) ?? null;
}

/* -------------------------------------------------------------- 初始存量 */

export interface UnitPlanEntry {
  readonly layoutId: HomeLayoutId;
  readonly count: number;
}

/** 晴川公寓：100 套，其中 1 套为玩家永久居住权，其余 99 套可售。 */
export const BASE_HOUSING_BUILDING_ID = 'home';
export const BASE_HOUSING_NAME = '晴川公寓';
export const BASE_HOUSING_PLAN: readonly UnitPlanEntry[] = [
  { layoutId: 'studio', count: 36 },
  { layoutId: 'compact', count: 44 },
  { layoutId: 'family', count: 20 },
];

/** 住房新区各建筑的单元计划（键 = 模板建筑后缀）。 */
export const DISTRICT_HOUSING_PLANS: Readonly<Record<string, readonly UnitPlanEntry[]>> = {
  'block-a': [
    { layoutId: 'studio', count: 12 },
    { layoutId: 'compact', count: 12 },
  ],
  'block-b': [
    { layoutId: 'compact', count: 12 },
    { layoutId: 'family', count: 12 },
  ],
  'block-c': [{ layoutId: 'family', count: 18 }],
};

/** 社区服务用房不产生住宅单元。 */
export const DISTRICT_HOUSING_EXCLUDED_SUFFIXES: readonly string[] = ['community'];

/* ------------------------------------------------------------------ 土地 */

export interface ReserveLandConfig {
  readonly id: string;
  readonly name: string;
  readonly districtId: string;
  readonly areaSqm: number;
  readonly center: { readonly x: number; readonly z: number };
  readonly size: { readonly width: number; readonly depth: number };
}

/**
 * 预先划定的城市储备土地：位于基础城区外缘、避开既有建筑与道路。
 * 它们不是新区建设用地，公共扩张仍沿 +X 条带进行，因此玩家拒售不影响公共新区流程。
 */
export const RESERVE_LAND_PARCELS: readonly ReserveLandConfig[] = [
  {
    id: 'land-reserve-nw',
    name: '北岸储备地块',
    districtId: 'district-base',
    areaSqm: 80,
    center: { x: -44, z: 34 },
    size: { width: 10, depth: 8 },
  },
  {
    id: 'land-reserve-ne',
    name: '东岗储备地块',
    districtId: 'district-base',
    areaSqm: 80,
    center: { x: 44, z: 34 },
    size: { width: 10, depth: 8 },
  },
  {
    id: 'land-reserve-sw',
    name: '南浦储备地块',
    districtId: 'district-base',
    areaSqm: 80,
    center: { x: -44, z: -34 },
    size: { width: 10, depth: 8 },
  },
  {
    id: 'land-reserve-se',
    name: '西塘储备地块',
    districtId: 'district-base',
    areaSqm: 80,
    center: { x: 44, z: -34 },
    size: { width: 10, depth: 8 },
  },
];

/* ------------------------------------------------------------ 住宅宏观群组 */

export type HousingIncomeTier = 'low' | 'mid' | 'high';

export interface SavingsTierConfig {
  /** 相对群组平均储蓄的倍数。 */
  readonly multiple: number;
  /** 该档家庭占群组比例（各档合计 1）。 */
  readonly share: number;
}

export interface HousingGroupConfig {
  readonly id: string;
  readonly name: string;
  readonly income: HousingIncomeTier;
  /** 每户平均人数，用于把阶层人数确定性地折算为家庭数。 */
  readonly householdSize: number;
  readonly monthlyHouseholdIncomeCents: number;
  readonly monthlyHouseholdConsumptionCents: number;
  readonly initialSavingsPerHouseholdCents: number;
  /** 群组内储蓄档位分布：只有储蓄倍数够的家庭才被判定有购买力。 */
  readonly savingsTiers: readonly SavingsTierConfig[];
  /** 每月新增首次购房意愿（占租住家庭比例）。 */
  readonly firstTimeIntentRate: number;
  /** 每月新增改善置换意愿（占自有住房家庭比例）。 */
  readonly upgradeIntentRate: number;
  /** 意愿存量上限（占对应家庭比例）。 */
  readonly maxIntentShare: number;
  /** 可负担上限：房价 ≤ 家庭年收入 × 该倍数。 */
  readonly maxPriceToIncome: number;
  /** 舒适口径：房价 ÷ 家庭年收入，用于住房压力。 */
  readonly comfortablePriceToIncome: number;
  /** 该群组对应的典型户型（用于负担能力与住房压力口径）。 */
  readonly typicalLayoutId: HomeLayoutId;
  /** 该群组偏好的户型（匹配顺序）。 */
  readonly preferredLayouts: readonly HomeLayoutId[];
  /** 城区偏好权重：基础城区 / 各扩张城区；按配置顺序轮换，避免固定遍历抢完房源。 */
  readonly districtWeights: Readonly<Record<string, number>>;
}

export const HOUSING_GROUPS: readonly HousingGroupConfig[] = [
  {
    id: 'low',
    name: '低收入家庭',
    income: 'low',
    householdSize: 3.4,
    monthlyHouseholdIncomeCents: 500_000,
    monthlyHouseholdConsumptionCents: 380_000,
    initialSavingsPerHouseholdCents: 8_000_000,
    savingsTiers: [
      { multiple: 0.4, share: 0.45 },
      { multiple: 0.8, share: 0.3 },
      { multiple: 1.5, share: 0.17 },
      { multiple: 2.5, share: 0.08 },
    ],
    firstTimeIntentRate: 0.006,
    upgradeIntentRate: 0.0015,
    maxIntentShare: 0.05,
    maxPriceToIncome: 6,
    comfortablePriceToIncome: 3,
    typicalLayoutId: 'studio',
    preferredLayouts: ['studio', 'compact', 'family'],
    districtWeights: { 'district-base': 1, expansion: 0.6 },
  },
  {
    id: 'mid',
    name: '中等收入家庭',
    income: 'mid',
    householdSize: 3,
    monthlyHouseholdIncomeCents: 1_100_000,
    monthlyHouseholdConsumptionCents: 720_000,
    initialSavingsPerHouseholdCents: 25_000_000,
    savingsTiers: [
      { multiple: 0.4, share: 0.45 },
      { multiple: 0.8, share: 0.3 },
      { multiple: 1.5, share: 0.17 },
      { multiple: 2.5, share: 0.08 },
    ],
    firstTimeIntentRate: 0.007,
    upgradeIntentRate: 0.0025,
    maxIntentShare: 0.05,
    maxPriceToIncome: 5,
    comfortablePriceToIncome: 2.7,
    typicalLayoutId: 'compact',
    preferredLayouts: ['compact', 'studio', 'family'],
    districtWeights: { 'district-base': 1, expansion: 1 },
  },
  {
    id: 'high',
    name: '高收入家庭',
    income: 'high',
    householdSize: 2.6,
    monthlyHouseholdIncomeCents: 2_600_000,
    monthlyHouseholdConsumptionCents: 1_600_000,
    initialSavingsPerHouseholdCents: 35_000_000,
    savingsTiers: [
      { multiple: 0.4, share: 0.45 },
      { multiple: 0.8, share: 0.3 },
      { multiple: 1.5, share: 0.17 },
      { multiple: 2.5, share: 0.08 },
    ],
    firstTimeIntentRate: 0.005,
    upgradeIntentRate: 0.004,
    maxIntentShare: 0.06,
    maxPriceToIncome: 4,
    comfortablePriceToIncome: 1.9,
    typicalLayoutId: 'family',
    preferredLayouts: ['family', 'compact', 'studio'],
    districtWeights: { 'district-base': 1, expansion: 1.2 },
  },
];

export function housingGroupConfigOf(id: string): HousingGroupConfig | null {
  return HOUSING_GROUPS.find((group) => group.id === id) ?? null;
}

/* ---------------------------------------------------------------- 规则 */

export const REAL_ESTATE_RULES = {
  /** 新住宅对居民的禁购期（游戏月）。开局 99 套从开局起算，新区从交付起算。 */
  protectionMonths: 6,
  /** 挂牌价下限（分）：100 元。 */
  minListingPriceCents: 10_000,
  /** 挂牌价上限：参考估值的倍数。 */
  maxListingMultiple: 3,
  /** 城市储备土地对玩家的出让价 = 估值 × 该系数。 */
  landAskPremium: 1.05,
  /** AI 土地报价有效期（游戏日）。 */
  landOfferValidDays: 30,
  /** AI 土地报价溢价范围（相对估值）。 */
  landOfferPremium: { min: 1.02, max: 1.18 },
  /** 住宅估值系数范围（供需要素调整后必须落在这个区间）。 */
  homeValuationFactor: { min: 0.85, max: 1.25 },
  /** 卖方挂牌价相对参考估值的溢价（卖方行为，不是成交价）。 */
  sellerAskingPremium: 1.02,
  /** 住宅供需修正系数：未满足意愿抬价、空置压低价格。 */
  homeMarketFactor: { demandWeight: 0.15, vacancyPenalty: 0.1 },
  /** 地段系数：基础城区为基准，扩张城区按模板给同一小幅溢价。 */
  districtValuationFactor: { base: 1, expansion: 1.02 },
  /** AI 土地报价的月份抖动（确定性，按 monthIndex % 3 在 ±1 档之间）。 */
  landOfferPremiumJitter: 0.02,
  /** 每月每群组最多成交套数。 */
  monthlyGroupSaleCap: 6,
  /** 每月全市场最多成交套数（含玩家与其他买家的成交）。 */
  monthlyTotalSaleCap: 12,
  /** 成交记录保留条数。 */
  tradeHistoryLimit: 240,
  /** 月度住房指标保留条数。 */
  monthHistoryLimit: 24,
  /** 土地基准单价（分/㎡）。 */
  landPricePerSqmCents: 450_000,
  /**
   * 土地估值的可解释修正项（全部有界、确定性）：
   *  - 股市指数：连续全市场指数偏离 100 的部分按权重计入（真实 GDP 关联）；
   *  - 已完成建设阶段：周边建设预期，最多计 3 个阶段；
   *  - 当前执政方向：与建设方向一致的规划预期（不预知选举结果，只看已生效任期）。
   */
  landValuation: {
    /** GDP 增长率对土地估值的权重（增长率本身先夹在 ±30%）。 */
    indexWeight: 0.3,
    completedStageBonus: 0.03,
    completedStageCap: 3,
    directionBonus: { technology: 0.01, commercial: 0.03, housing: 0.04 },
  },
  /** 估值调整的确定性步长上限（每月相对变化）。 */
  valuationMonthlyStep: 0.06,
  /**
   * 群组储蓄上限 = 开局储蓄池 × 该倍数。
   *
   * 超过上限后不再入账：这是宏观模型的边界（避免居民储蓄无限累积并撞上金额上限），
   * 不是「居民没有收入」；界面不展示这些内部数字。
   */
  groupCashCeilingMultiple: 4,
};

/** 首次挂牌价：卖方按参考估值挂牌（可被后续行情与玩家改价覆盖）。 */
export function initialAskingPriceCents(valuationCents: number): number {
  return Math.max(REAL_ESTATE_RULES.minListingPriceCents, Math.round(valuationCents));
}
