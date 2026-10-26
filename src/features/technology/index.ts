/**
 * 科技模块 —— 永久科技积累、研发项目、产品属性、代际与退市。
 *
 * 只负责「算属性、记项目、存产品」，不扣款、不发薪、不结算销售：
 * 资金由 finance 处理，跨模块顺序由 app 协调。
 *
 * 属性计算完全确定：相同科技基础、预算、重点与时长必然得到相同结果，
 * 不含随机数，也不会出现「研发更久反而更差」。
 */

import type { DeepReadonly } from '../../core/readonly';
import { FOCUS_OPTIONS, PRODUCT_MARKET, TECH, type FocusKey } from '../../content/business';
import { BusinessError } from '../../core/errors';
import type { AttributeScores } from '../market';

export type { FocusKey };

export interface ResearchProject {
  readonly id: string;
  readonly focus: FocusKey;
  readonly budgetCents: number;
  readonly plannedDays: number;
  /** 立项时锁定的基础科技值（永久积累 + 当时的高管能力）。 */
  readonly effectiveBase: number;
  /**
   * 立项时锁定的研发增长倍率（政策快照）。
   * 只乘在「研发增量部分」（growth）上，不改基础科技值，也不改最终 0～100 属性。
   * 旧项目与无政策项目一律为 1；换届不会追溯改变已立项项目。
   */
  readonly researchGrowthMultiplier: number;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly startMonthKey: string;
  /** 立项时算出的属性，仅用于界面预告。 */
  readonly projected: AttributeScores;
}

export interface Product {
  readonly id: string;
  name: string;
  readonly attributes: AttributeScores;
  /** 完成时确定并锁定的单位成本。 */
  readonly unitCostCents: number;
  readonly researchBudgetCents: number;
  /** 发布代次：发布时赋值，未发布为 0。发布后不可变。 */
  generation: number;
  releasedAtMinute: number | null;
  priceCents: number;
  marketingDailyCents: number;
  onSale: boolean;
  /** 不足一件的销量余量，累计到整件才成交。 */
  salesRemainder: number;
  /**
   * 销售成本不足一分的余量（分）。
   * 政策可能把单位销售成本乘 0.98 之类的非整数倍率，结算时把余量留在产品上，
   * 保证任意分段结算都不会因为取整丢掉成本。
   */
  salesCostRemainder: number;
  totalUnits: number;
  totalRevenueCents: number;
  totalCostCents: number;
  /**
   * 首次发布对股价的一次性反应（已结算的百分比）。
   * `null` = 还没结算过；数值（含 0）= 已结算，不再重复触发。
   * 有了这个字段，重复点击、刷新、读档与日结都不会二次施加影响。
   */
  releaseImpactPct: number | null;
  /**
   * 最近几个完整游戏日的实际日销量（只保留观察窗口 + 缓冲）。
   * 由统一销售结算在日界写入，不从界面或证券模块虚构。
   */
  dailySales: ProductDailyUnits[];
  /** 上一次日界记录时的累计销量快照，用于算「当天卖了多少」。 */
  daySnapshotUnits: number;
  /**
   * 日销量观察起点（游戏分钟）：从这个时刻起，销售才算「完整记录过」。
   *
   * 只有观察区间覆盖了刚结束的整个游戏日，才会写入一条日销量样本；
   * 中途发布（例如 23:59）或中途迁移的旧档，首个不足一天的区间只更新快照与起点，
   * 不会拿半天销量冒充完整日。每次日界处理后推进到该日界。
   */
  dailyObservationStartMinute: number;
}

/** 单个完整游戏日的实际销量。day 是用统一日历算出的日序号。 */
export interface ProductDailyUnits {
  readonly day: number;
  units: number;
}

export interface TechCompanyState {
  /** 永久科技积累：只通过技术积累投入增长。 */
  accumulation: number;
  project: ResearchProject | null;
  products: Product[];
  /** 最近一次产品发布所属的游戏年；每个日历年最多发布一款。 */
  publishedYear: number | null;
  nextProductSeq: number;
}

export interface TechnologyState {
  companies: Record<string, TechCompanyState>;
}

export function createTechCompanyState(accumulation = TECH.initialAccumulation): TechCompanyState {
  return {
    accumulation: Math.max(0, Math.round(accumulation)),
    project: null,
    products: [],
    publishedYear: null,
    nextProductSeq: 1,
  };
}

/** 共享的空科技切片：只读查询在数据缺失时使用，不写入状态。 */
const EMPTY_TECH: DeepReadonly<TechCompanyState> = Object.freeze({
  accumulation: 0,
  project: null,
  products: Object.freeze([]) as readonly DeepReadonly<Product>[],
  publishedYear: null,
  nextProductSeq: 1,
});

export function createTechnologyState(): TechnologyState {
  return { companies: {} };
}

/**
 * 只读查询：取某家公司的科技切片视图。缺失时返回共享的空切片，**不创建**。
 *
 * 写入路径仍用 `ensureTechCompany`——那是唯一允许「读取时补建」的地方，
 * 且必须在初始化、迁移或 store.run 的草稿中调用。
 */
export function techViewOf(
  state: TechnologyState | DeepReadonly<TechnologyState>,
  companyId: string,
): DeepReadonly<TechCompanyState> {
  return state.companies[companyId] ?? EMPTY_TECH;
}

export function ensureTechCompany(state: TechnologyState, companyId: string): TechCompanyState {
  let company = state.companies[companyId];
  if (!company) {
    company = createTechCompanyState();
    state.companies[companyId] = company;
  }
  return company;
}

/* ------------------------------------------------------------ 科技水平 */

/** 有效科技水平 = 永久积累 + 当前科研高管能力（没有高管时只算积累）。 */
export function effectiveTechLevel(
  company: TechCompanyState | DeepReadonly<TechCompanyState>,
  talentAbility: number,
): number {
  return Math.max(0, company.accumulation + Math.max(0, talentAbility));
}

/* ------------------------------------------------------------ 时长收益 */

/**
 * 研发时长收益系数 F(t)：
 *   t ≤ 90：t / 90              → F(90) = 1
 *   90 < t ≤ 720：(t-90)/630 的二次曲线 → F(720) = 2
 *   t > 720：按 720 计算，不再增长
 */
export function durationFactor(days: number): number {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const t = Math.min(days, TECH.capDays);
  if (t <= TECH.baseDays) return t / TECH.baseDays;
  const x = (t - TECH.baseDays) / (TECH.capDays - TECH.baseDays);
  return 1 + 2 * x - x * x;
}

/** 预算收益 G = 预算 / (预算 + 参考预算)，范围 [0, 1)。 */
export function budgetFactor(budgetCents: number): number {
  if (budgetCents <= 0) return 0;
  return budgetCents / (budgetCents + TECH.researchReferenceBudgetCents);
}

/** 由原始值收敛到 0～100：100 × (1 − e^(−raw/100))。 */
function squash(raw: number): number {
  return TECH.attributeScale * (1 - Math.exp(-Math.max(0, raw) / TECH.attributeScale));
}

function coefficientFor(focus: FocusKey, key: FocusKey): number {
  return focus === key ? TECH.focusCoefficient : TECH.otherCoefficient;
}

/**
 * 产品属性：先按确定性公式算原始值，再统一收敛。
 * 保留内部精度，显示时才取整。
 */
export function computeAttributes(input: {
  readonly effectiveBase: number;
  readonly budgetCents: number;
  readonly days: number;
  readonly focus: FocusKey;
  /** 研发增长倍率（政策快照，默认 1）：只作用于 growth 这一段。 */
  readonly growthMultiplier?: number;
}): AttributeScores {
  const rawMultiplier = input.growthMultiplier;
  const multiplier =
    typeof rawMultiplier === 'number' && Number.isFinite(rawMultiplier) ? rawMultiplier : 1;
  const growth =
    TECH.researchGrowthCoefficient *
    budgetFactor(input.budgetCents) *
    durationFactor(input.days) *
    multiplier;
  const raw = (key: FocusKey): number =>
    input.effectiveBase + growth * coefficientFor(input.focus, key);
  return {
    performance: squash(raw('performance')),
    reliability: squash(raw('reliability')),
    usability: squash(raw('usability')),
  };
}

/** 单位成本：完成时由属性确定，非负、只依赖属性。 */
export function unitCostOf(attributes: AttributeScores): number {
  const average =
    (attributes.performance + attributes.reliability + attributes.usability) / 3;
  return Math.round(TECH.unitCostBaseCents + TECH.unitCostPerQualityCents * average);
}

/* ------------------------------------------------------------ 研发项目 */

export function startProject(
  company: TechCompanyState,
  input: {
    readonly focus: FocusKey;
    readonly days: number;
    readonly budgetCents: number;
    readonly effectiveBase: number;
    /** 立项时的研发增长倍率快照（默认 1）。 */
    readonly researchGrowthMultiplier?: number;
    readonly startMinute: number;
    readonly monthKey: string;
  },
): ResearchProject {
  if (company.project) {
    throw new BusinessError('PROJECT_EXISTS', '已有进行中的研发项目');
  }
  const plannedDays = Math.min(Math.max(1, Math.round(input.days)), TECH.maxPlannedDays);
  const rawGrowth = input.researchGrowthMultiplier;
  const growthMultiplier =
    typeof rawGrowth === 'number' && Number.isFinite(rawGrowth) ? Math.max(0, rawGrowth) : 1;
  const project: ResearchProject = {
    id: `${input.monthKey}-${company.nextProductSeq}`,
    focus: input.focus,
    budgetCents: input.budgetCents,
    plannedDays,
    effectiveBase: input.effectiveBase,
    researchGrowthMultiplier: growthMultiplier,
    startMinute: input.startMinute,
    endMinute: input.startMinute + plannedDays * 1440,
    startMonthKey: input.monthKey,
    projected: computeAttributes({
      effectiveBase: input.effectiveBase,
      budgetCents: input.budgetCents,
      days: plannedDays,
      focus: input.focus,
      growthMultiplier,
    }),
  };
  company.nextProductSeq += 1;
  return project;
}

/** 研发是否已到完成时刻（分钟粒度）。 */
export function isProjectDue(company: TechCompanyState, nowMinute: number): boolean {
  return company.project !== null && company.project.endMinute <= nowMinute;
}

/** 把已完成的研发转成待发布产品；未到期返回 null。 */
export function completeProject(
  company: TechCompanyState,
  nowMinute: number,
): Product | null {
  const project = company.project;
  if (!project || project.endMinute > nowMinute) return null;
  const attributes = computeAttributes({
    effectiveBase: project.effectiveBase,
    budgetCents: project.budgetCents,
    days: project.plannedDays,
    focus: project.focus,
    growthMultiplier: project.researchGrowthMultiplier,
  });
  const product: Product = {
    id: `product-${project.id}`,
    name: '',
    attributes,
    unitCostCents: unitCostOf(attributes),
    researchBudgetCents: project.budgetCents,
    generation: 0,
    releasedAtMinute: null,
    priceCents: 0,
    marketingDailyCents: 0,
    onSale: false,
    salesRemainder: 0,
    salesCostRemainder: 0,
    totalUnits: 0,
    totalRevenueCents: 0,
    totalCostCents: 0,
    releaseImpactPct: null,
    dailySales: [],
    daySnapshotUnits: 0,
    // 待发布产品还没有开始观察：正式发布时重新初始化
    dailyObservationStartMinute: 0,
  };
  company.products.push(product);
  company.project = null;
  return product;
}

/* ------------------------------------------------------------ 产品 */

export function pendingProducts(company: TechCompanyState): Product[];
export function pendingProducts(
  company: DeepReadonly<TechCompanyState>,
): readonly DeepReadonly<Product>[];
export function pendingProducts(
  company: TechCompanyState | DeepReadonly<TechCompanyState>,
): readonly (Product | DeepReadonly<Product>)[] {
  return company.products.filter((product) => product.releasedAtMinute === null);
}

export function onSaleProducts(
  company: TechCompanyState | DeepReadonly<TechCompanyState>,
): readonly (Product | DeepReadonly<Product>)[] {
  return company.products.filter((product) => product.onSale && product.releasedAtMinute !== null);
}

export function releasedProducts(
  company: TechCompanyState | DeepReadonly<TechCompanyState>,
): readonly (Product | DeepReadonly<Product>)[] {
  return company.products.filter((product) => product.releasedAtMinute !== null);
}

/** 已发布产品中的最新代次（没有产品时为 0）。 */
export function latestGeneration(
  company: TechCompanyState | DeepReadonly<TechCompanyState>,
): number {
  let latest = 0;
  for (const product of company.products) {
    if (product.releasedAtMinute !== null && product.generation > latest) latest = product.generation;
  }
  return latest;
}

/**
 * 代际系数：当前新款为 1，每落后一代乘一次 generationDecay。
 * 用不可变的发布代次计算，不在结算时累计打折。
 */
export function generationFactorOf(
  company: TechCompanyState | DeepReadonly<TechCompanyState>,
  product: DeepReadonly<Product>,
): number {
  if (product.releasedAtMinute === null || product.generation <= 0) return 1;
  const gap = latestGeneration(company) - product.generation;
  if (gap <= 0) return 1;
  return Math.pow(PRODUCT_MARKET.generationDecay, gap);
}

export interface ReleaseInput {
  readonly name: string;
  readonly priceCents: number;
  readonly marketingDailyCents: number;
  readonly nowMinute: number;
  readonly year: number;
}

export function isPublishBlockedThisYear(
  company: TechCompanyState | DeepReadonly<TechCompanyState>,
  year: number,
): boolean {
  return company.publishedYear === year;
}

export function findProduct(company: TechCompanyState, productId: string): Product | null {
  return company.products.find((product) => product.id === productId) ?? null;
}

/** 发布：赋予不可变代次、上架并记录发布年份。 */
export function releaseProduct(
  company: TechCompanyState,
  product: Product,
  input: ReleaseInput,
): void {
  if (product.releasedAtMinute !== null) {
    throw new BusinessError('ALREADY_RELEASED', '该产品已经发布');
  }
  if (isPublishBlockedThisYear(company, input.year)) {
    throw new BusinessError('ANNUAL_PUBLISH_LIMIT', '本年度已经发布过一款产品');
  }
  product.name = input.name;
  product.priceCents = input.priceCents;
  product.marketingDailyCents = input.marketingDailyCents;
  product.releasedAtMinute = input.nowMinute;
  product.generation = latestGeneration(company) + 1;
  product.onSale = true;
  product.salesRemainder = 0;
  // 正式发布才正式开始观察：起点=当前分钟，快照对齐当前累计销量
  product.dailyObservationStartMinute = input.nowMinute;
  product.daySnapshotUnits = product.totalUnits;
  company.publishedYear = input.year;
}

/**
 * 世界初始化时直接上架的既有产品（本轮仅三家 AI 公司的首款产品）。
 * 不改变 publishedYear：它代表游戏开始前就已上市，不占用本年度发布名额。
 */
export function addSeedProduct(
  company: TechCompanyState,
  input: {
    readonly name: string;
    readonly attributes: AttributeScores;
    readonly priceCents: number;
    readonly marketingDailyCents: number;
    readonly nowMinute: number;
  },
): Product {
  const product: Product = {
    id: `seed-${company.nextProductSeq}`,
    name: input.name,
    attributes: { ...input.attributes },
    unitCostCents: unitCostOf(input.attributes),
    researchBudgetCents: 0,
    generation: latestGeneration(company) + 1,
    releasedAtMinute: input.nowMinute,
    priceCents: input.priceCents,
    marketingDailyCents: input.marketingDailyCents,
    onSale: true,
    salesRemainder: 0,
    salesCostRemainder: 0,
    totalUnits: 0,
    totalRevenueCents: 0,
    totalCostCents: 0,
    // 开局就存在的产品不追溯触发发布冲击：直接标记为「已结算、无影响」
    releaseImpactPct: 0,
    dailySales: [],
    daySnapshotUnits: 0,
    // 开局即已上市：从「开始观察的那一分钟」起算，不伪造开局前销量
    dailyObservationStartMinute: input.nowMinute,
  };
  company.nextProductSeq += 1;
  company.products.push(product);
  return product;
}

export function stopSelling(product: Product): void {
  product.onSale = false;
}

/**
 * 产品三项属性的**算术平均** A —— 只用于「首次发布对股价的一次性反应」。
 *
 * 注意与市场销量的加权品质 Q 严格区分：
 *  - Q（features/market.qualityOf）按人口偏好加权，决定销量，本轮不改；
 *  - A（本函数）是等权平均，决定发布冲击，二者互不替代。
 */
export function averageAttributeOf(product: DeepReadonly<Product>): number {
  const { performance, reliability, usability } = product.attributes;
  return (performance + reliability + usability) / 3;
}

/** 最新发布的产品（按发布时刻、再用代次兜底）；没有已发布产品时为 null。 */
/** 选取规则（只读与写入两个入口共用）：发布时刻最新，同刻取代次更大者。 */
function pickLatestProduct<T extends { releasedAtMinute: number | null; generation: number }>(
  products: readonly T[],
): T | null {
  let latest: T | null = null;
  for (const product of products) {
    if (product.releasedAtMinute === null) continue;
    if (
      !latest ||
      product.releasedAtMinute > (latest.releasedAtMinute ?? 0) ||
      (product.releasedAtMinute === latest.releasedAtMinute && product.generation > latest.generation)
    ) {
      latest = product;
    }
  }
  return latest;
}

/** 只读查询：最新发布产品的视图。 */
export function latestReleasedProduct(
  company: DeepReadonly<TechCompanyState>,
): DeepReadonly<Product> | null {
  return pickLatestProduct(company.products);
}

/** 写入路径：最新发布产品的可写引用（日销量记录、日界快照推进用）。 */
export function latestProductForWrite(company: TechCompanyState): Product | null {
  return pickLatestProduct(company.products);
}

/**
 * 记录一个完整游戏日的实际销量。
 *
 * 由统一销售结算在日界调用；同一 day 只会写入一次（重复调用覆盖同一天的记录，
 * 不会把同一天算两遍）。只保留最近 maxRecords 条，避免复制整套销售账本。
 */
export function recordDailyUnits(product: Product, day: number, units: number, maxRecords: number): void {
  if (!Number.isSafeInteger(day) || day < 0) return;
  const value = Number.isFinite(units) ? Math.max(0, Math.floor(units)) : 0;
  const existing = product.dailySales.find((item) => item.day === day);
  if (existing) {
    // 同一天可能被日界与月界各算一次：取较大值，既不重复累计也不会被清零
    existing.units = Math.max(existing.units, value);
  } else {
    product.dailySales.push({ day, units: value });
    product.dailySales.sort((a, b) => a.day - b.day);
  }
  const limit = Math.max(1, Math.floor(maxRecords));
  if (product.dailySales.length > limit) {
    product.dailySales.splice(0, product.dailySales.length - limit);
  }
}

/** 最近 days 个完整游戏日的日均销量；没有完整日记录时返回 null。 */
export function recentDailyAverage(product: DeepReadonly<Product>, days: number): number | null {
  const window = Math.max(1, Math.floor(days));
  const recent = product.dailySales.slice(-window);
  if (recent.length === 0) return null;
  let total = 0;
  for (const item of recent) total += item.units;
  return total / recent.length;
}

export function focusName(focus: FocusKey): string {
  return FOCUS_OPTIONS.find((option) => option.id === focus)?.name ?? focus;
}
