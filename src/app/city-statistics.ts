/**
 * 城市统计编排（app）—— 只读投影 + 草稿上的统计登记。
 *
 * 职责：
 *  - 把「企业销售结算」的纯计算提取成唯一实现 `computeSalesPlan`：正式结算与实时预览共用，
 *    不产生第二套销量/成本近似公式；
 *  - 计算开局基础 GDP G0（新游戏用当前在售产品、旧档迁移用本版本标准开局条件）；
 *  - 在月界固化经营产出统计与连续指数窗口，落一条 `CityMonthSnapshot`；
 *  - 提供实时城市经济视图（实时 GDP 含待结算，与组成公式一致），
 *    以及只在「销售已全部结清」场景使用的已结算口径 GDP。
 *
 * 口径：
 *  - 金额单位一律「分」，产出用整数加法；S 用 Math.round；长期累计校验安全整数。
 *  - 实时 GDP = G0 + 实时累计经营产出（已结算 + 待结算）+ 当前股市调整值；
 *    待结算只是只读投影，**不写回**持久累计，正式结算时仍由 registerOutput 唯一登记。
 *  - 查询路径（computeSalesPlan / pendingOutputCentsOf / liveCityEconomyOf /
 *    settledGdpCentsOf / industriesOf）
 *    只读：不推进游标、不改产品余量、不写财务、不补建科技切片。
 *  - 本文件不建立第二套时钟：所有时间都是调用方传入的游戏分钟。
 */

import { BusinessError } from '../core/errors';
import { AI_COMPANIES, POPULATION_GROUPS } from '../content/business';
import { CITY_ECONOMY_RULES } from '../content/city-economy';
import { TIME } from '../content/config';
import { isClosed } from '../features/enterprise';
import {
  currentIndexValue,
  finalizeIndexMonth,
  gdpCentsOf,
  pushMonthSnapshot,
  registerOutput,
  rollOutputMonth,
  stockAdjustCentsOf,
  type CityIndustryOutput,
  type CityMonthSnapshot,
} from '../features/city-statistics';
import { estimateSales } from '../features/market';
import { generationFactorOf, techViewOf } from '../features/technology';
import { marketOf } from '../features/stock';
import { activePolicyEffects } from './policy';
import type { GameState, ReadonlyGameState } from './state';

/**
 * 初始化与旧档迁移需要直接构造统计切片、登记待结算基线。
 *
 * 实现仍在 features/city-statistics；这里转发一条导入路径，
 * 让基础设施层（save-migrations）不必同时认识 features 与应用层两个入口。
 */
export { createCityStatisticsState, setBaselinePending } from '../features/city-statistics';

/**
 * 本轮唯一纳入统计的行业：科技产业（在售产品的真实销售产出）。
 * 增加第二个行业时在这里登记，不要复用人口/证券口径。
 */
const TECHNOLOGY_INDUSTRY = { id: 'technology', label: '科技产业' } as const;

/* ------------------------------------------------------------ 销售纯投影 */

/** 单个产品本次可结算的销量、收入、成本与结算后的余量。 */
export interface SalesLinePlan {
  readonly productId: string;
  /** 本次可结算件数（可为 0）。 */
  readonly units: number;
  readonly revenueCents: number;
  readonly costCents: number;
  /** 结算后产品销量余量（必须回写，含 sold=0 的情况）。 */
  readonly salesRemainderAfter: number;
  readonly salesCostRemainderAfter: number;
}

export interface SalesPlan {
  readonly elapsedMinutes: number;
  readonly lines: readonly SalesLinePlan[];
  readonly units: number;
  readonly revenueCents: number;
  readonly costCents: number;
}

const EMPTY_SALES_PLAN: SalesPlan = {
  elapsedMinutes: 0,
  lines: [],
  units: 0,
  revenueCents: 0,
  costCents: 0,
};

/**
 * 纯只读投影：输入只读产品/余量/结算游标/时间区间/既有市场参数，
 * 输出可结算销量、收入、成本与余量结果。
 *
 * 与 `settleCompanySales` 的现有公式逐项一致：
 *  - 区间起点是 `company.lastSettledMinute`（本函数不改它，也不改任何产品余量）；
 *  - 销量 = estimateSales（含 generationFactorOf 代际系数）/ 游戏日 × 经过分钟 + 产品余量；
 *  - 收入 = 件数 × 当前售价；成本 = 件数 × 单位成本 × 政策销售成本倍率（不足一分留在产品上）；
 *  - 只有「在售且已发布」的产品出现在 lines 中；sold=0 也要回写余量（余量已经增长）。
 */
export function computeSalesPlan(
  state: ReadonlyGameState,
  companyId: string,
  nowMinute: number,
): SalesPlan {
  if (!Number.isSafeInteger(nowMinute) || nowMinute < 0) {
    throw new BusinessError('INVALID_MINUTE', '销售结算时刻必须是合法的游戏分钟');
  }
  const company = state.enterprises.companies[companyId];
  if (!company) return EMPTY_SALES_PLAN;

  const elapsedMinutes = nowMinute - company.lastSettledMinute;
  if (elapsedMinutes <= 0) return EMPTY_SALES_PLAN;
  // 暂停/危机/清算期间不产生销量（与 settleCompanySales 的 isRunning 语义一致；
  // 这里用状态判断是因为只读视图类型不满足 isRunning 的可变签名）
  if (company.status !== 'active') {
    return { elapsedMinutes, lines: [], units: 0, revenueCents: 0, costCents: 0 };
  }

  const tech = techViewOf(state.technology, companyId);
  // 政策以显式输入进入结算：只作用于生效区间内新发生的销售成本
  const salesCostMultiplier = activePolicyEffects(state).salesCostMultiplier;
  const minutesPerDay = TIME.calendar.minutesPerDay;

  const lines: SalesLinePlan[] = [];
  let units = 0;
  let revenueCents = 0;
  let costCents = 0;

  for (const product of tech.products) {
    if (!product.onSale || product.releasedAtMinute === null) continue;
    const estimate = estimateSales({
      groups: state.population.groups,
      attributes: product.attributes,
      marketingDailyCents: product.marketingDailyCents,
      generationFactor: generationFactorOf(tech, product),
    });

    // 与真实结算相同的浮点顺序：先算本区间增量，再加到已有余量
    const grownRemainder = product.salesRemainder + (estimate.dailyUnits * elapsedMinutes) / minutesPerDay;
    const sold = Math.floor(grownRemainder);

    let lineRevenueCents = 0;
    let lineCostCents = 0;
    let salesCostRemainderAfter = product.salesCostRemainder;
    if (sold > 0) {
      lineRevenueCents = sold * product.priceCents;
      // 有效单位成本 = 基础成本 × 政策倍率；不足一分的部分留在产品上，不丢成本
      const numerator =
        product.salesCostRemainder + sold * product.unitCostCents * salesCostMultiplier;
      lineCostCents = Math.floor(numerator);
      salesCostRemainderAfter = numerator - lineCostCents;
    }

    // sold=0 时余量已经增长，必须原样回写；sold>0 时留下不足一件的余量
    const salesRemainderAfter = sold > 0 ? grownRemainder - sold : grownRemainder;
    lines.push({
      productId: product.id,
      units: sold,
      revenueCents: lineRevenueCents,
      costCents: lineCostCents,
      salesRemainderAfter,
      salesCostRemainderAfter,
    });

    units += sold;
    revenueCents += lineRevenueCents;
    costCents += lineCostCents;
  }

  return { elapsedMinutes, lines, units, revenueCents, costCents };
}

/* ------------------------------------------------------------ 基础 GDP */

/**
 * G0（新游戏）：用既有 estimateSales 口径估算「各本地在售产品预计每日销售产出之和 × 360」。
 * 只读：不发钱、不写产品历史、不推进时间、不改任何结算游标。
 */
export function computeBaseGdpCents(state: ReadonlyGameState): number {
  let dailyRevenueCents = 0;
  for (const company of Object.values(state.enterprises.companies)) {
    if (isClosed(company)) continue;
    const tech = techViewOf(state.technology, company.id);
    for (const product of tech.products) {
      if (!product.onSale || product.releasedAtMinute === null) continue;
      const estimate = estimateSales({
        groups: state.population.groups,
        attributes: product.attributes,
        marketingDailyCents: product.marketingDailyCents,
        generationFactor: generationFactorOf(tech, product),
      });
      dailyRevenueCents += estimate.dailyUnits * product.priceCents;
    }
  }
  return Math.max(0, Math.round(dailyRevenueCents * CITY_ECONOMY_RULES.baseGdpDays));
}

/**
 * G0（旧档迁移）：用本版本**标准开局条件**（AI_COMPANIES 首款在售产品 + 标准人口偏好）
 * 生成背景估算，并明确标注来源。
 *
 * 不使用玩家当前的高价产品/后期营销反推：那会把玩家的经营成果伪装成「过去一年的城市产出」。
 */
export function estimateStandardBaseGdpCents(): number {
  let dailyRevenueCents = 0;
  for (const config of AI_COMPANIES) {
    const estimate = estimateSales({
      groups: POPULATION_GROUPS,
      attributes: config.firstProduct.attributes,
      marketingDailyCents: config.marketingDailyCents,
      generationFactor: 1,
    });
    dailyRevenueCents += estimate.dailyUnits * config.firstProduct.priceCents;
  }
  return Math.max(0, Math.round(dailyRevenueCents * CITY_ECONOMY_RULES.baseGdpDays));
}

/* ------------------------------------------------------------ 统计登记 */

/**
 * 把一次真实销售结算的产出登记进统计。
 *
 * `monthKey` 由调用方按**企业 accrual 月份**传入：月界当刻结清的旧区间属于旧月，
 * 月界之后的 AI 决策结算属于新月份；不能用 nowMinute 推算（会串月）。
 * `outputSeq` 是本次销售操作消耗的企业操作序号（单调高水位防重复）。
 */
export function registerSettledOutput(
  draft: GameState,
  companyId: string,
  plan: SalesPlan,
  outputSeq: number,
  monthKey: string,
  nowMinute: number,
): void {
  registerOutput(draft.cityStatistics, {
    companyId,
    outputSeq,
    atMinute: nowMinute,
    monthKey,
    amountCents: plan.revenueCents,
  });
}

/* ------------------------------------------------------------ 实时视图 */

/** 证券权威现价读取器；缺失行情返回 NaN，由统计模块按「无效样本」跳过。 */
function cityPriceOf(state: ReadonlyGameState): (securityId: string) => number {
  return (securityId) => marketOf(state.securities, securityId)?.price ?? Number.NaN;
}

/**
 * 实时待结算产出：
 * Σ 各未清算公司 computeSalesPlan(...).revenueCents − 剩余迁移基线，按公司下限 0。
 *
 * 纯只读（查询路径不得写状态、不得补建切片）：迁移基线只在这里被「看」到，
 * 真正扣减发生在 registerOutput 的真实结算里。
 */
export function pendingOutputCentsOf(state: ReadonlyGameState, nowMinute: number): number {
  let total = 0;
  for (const company of Object.values(state.enterprises.companies)) {
    if (isClosed(company)) continue;
    const plan = computeSalesPlan(state, company.id, nowMinute);
    if (plan.revenueCents <= 0) continue;
    const baseline = state.cityStatistics.output.cursors[company.id]?.baselinePendingCents ?? 0;
    total += Math.max(0, plan.revenueCents - baseline);
  }
  return total;
}

/**
 * 实时口径金额校验：必须是非负安全整数。
 *
 * 与长期统计的 `assertAggregate` 不同，这里**不夹值**：基础 GDP、已结算/待结算产出
 * 以及求和结果任何一项异常都直接抛错，不用 `Math.max(0, …)` 把坏数据伪装成 0。
 */
function assertLiveCents(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BusinessError('INVALID_AMOUNT', `${field}必须是非负安全整数（分）`);
  }
}

/** 实时口径的两项整数加法：两个加数与结果都必须是安全整数；结果非负。 */
function addLiveCents(left: number, right: number, field: string): number {
  assertLiveCents(left, field);
  assertLiveCents(right, field);
  const sum = left + right;
  assertLiveCents(sum, field);
  return sum;
}

/**
 * 实时累加股市调整值 S：S 可以为负（指数低于 100），但最终 GDP 必须非负且是安全整数。
 * 传入的 `baseAndOutputCents` 是已单独校验过的「G0 + 实时累计经营产出」。
 */
function addStockAdjustedCents(baseAndOutputCents: number, stockAdjustCents: number): number {
  assertLiveCents(baseAndOutputCents, '实时 GDP（基础 + 实时累计经营产出）');
  if (!Number.isSafeInteger(stockAdjustCents)) {
    throw new BusinessError('INVALID_AMOUNT', '股市调整值必须是安全整数（分）');
  }
  const gdpCents = baseAndOutputCents + stockAdjustCents;
  assertLiveCents(gdpCents, '实时城市 GDP');
  return gdpCents;
}

export interface LiveCityEconomy {
  /** 开局基础 GDP G0（只生成一次，读档不重算）。 */
  readonly baseGdpCents: number;
  /** 已正式结算并登记进持久统计的累计经营产出。 */
  readonly settledOutputCents: number;
  /** 当前可结算但尚未正式结算的产出（只读投影，不写入持久累计）。 */
  readonly pendingOutputCents: number;
  /**
   * 实时累计经营产出 = 已结算 + 待结算，是**实时 GDP 的组成项**；
   * 只用于当前时刻展示，不写回持久统计（正式结算时才由 registerOutput 唯一登记）。
   */
  readonly cumulativeOutputCents: number;
  /** 实时全市场指数。 */
  readonly indexValue: number;
  readonly indexValid: boolean;
  readonly indexSampleCount: number;
  /** 当前股市调整值 S = round(G0 × 30% × (I/100 − 1))，可为负。 */
  readonly stockAdjustCents: number;
  /**
   * 实时 GDP = G0 + 实时累计经营产出（已结算 + 待结算）+ 当前股市调整值。
   *
   * 与界面组成为同一口径；需要「销售已全部结清」的正式口径时用 `settledGdpCentsOf`。
   */
  readonly gdpCents: number;
  /** 本月新增**已结算**经营产出（不含待结算；月份滚动时清零）。 */
  readonly monthOutputCents: number;
}

export function liveCityEconomyOf(state: ReadonlyGameState, nowMinute: number): LiveCityEconomy {
  const statistics = state.cityStatistics;
  const index = currentIndexValue(statistics.index, cityPriceOf(state));
  const baseGdpCents = statistics.base.gdpCents;
  const settledOutputCents = statistics.output.cumulativeCents;
  // 待结算沿用现有只读投影：不推进销售游标、不改产品余量、不写财务、不写持久累计
  const pendingOutputCents = pendingOutputCentsOf(state, nowMinute);

  assertLiveCents(baseGdpCents, '基础 GDP');
  assertLiveCents(settledOutputCents, '已结算累计经营产出');
  assertLiveCents(pendingOutputCents, '待结算经营产出');
  const cumulativeOutputCents = addLiveCents(
    settledOutputCents,
    pendingOutputCents,
    '实时累计经营产出',
  );
  const stockAdjustCents = stockAdjustCentsOf(baseGdpCents, index.value);
  const gdpCents = addStockAdjustedCents(
    addLiveCents(baseGdpCents, cumulativeOutputCents, '实时 GDP（基础 + 实时累计经营产出）'),
    stockAdjustCents,
  );

  return {
    baseGdpCents,
    settledOutputCents,
    pendingOutputCents,
    cumulativeOutputCents,
    indexValue: index.value,
    indexValid: index.valid,
    indexSampleCount: index.sampleCount,
    stockAdjustCents,
    gdpCents,
    monthOutputCents: statistics.output.monthCents,
  };
}

/**
 * 正式（已结算）GDP = G0 + 已结算累计产出 + 当前股市调整值。
 *
 * 只在「销售已全部结清」的场景使用（如选举后用旧任期属性结清销售再判断建设）；
 * 实时界面必须用 `liveCityEconomyOf`（含待结算），不得误用本函数。
 *
 * 内部复用 `currentIndexValue` 与 features 的 `gdpCentsOf`，不复制指数/股市调整公式。
 */
export function settledGdpCentsOf(state: ReadonlyGameState): number {
  const index = currentIndexValue(state.cityStatistics.index, cityPriceOf(state));
  return gdpCentsOf(state.cityStatistics, index.value);
}

/**
 * 行业经营产出（只统计真实经营产出；本轮唯一纳入的是科技产业）。
 *
 * 口径与 `CityOutputState.byCompany` 一致：**当前统计窗口（自上次月份滚动）内**
 * 各企业已登记产出之和，与 `CityMonthSnapshot.outputMonthCents` 同尺度的拆分。
 */
export function industriesOf(state: ReadonlyGameState): CityIndustryOutput[] {
  let cents = 0;
  for (const value of Object.values(state.cityStatistics.output.byCompany)) {
    if (Number.isSafeInteger(value) && value > 0) cents += value;
  }
  return [{ id: TECHNOLOGY_INDUSTRY.id, label: TECHNOLOGY_INDUSTRY.label, cents }];
}

/* ------------------------------------------------------------ 月界固化 */

/**
 * 月界第 3 步：固化本月经营产出统计与股市指数窗口，并落一条 CityMonthSnapshot。
 *
 * 必须在企业月结完成之后（旧区间销售已登记）、人口月结与建设判断之前调用。
 * 此时各企业在月界当刻的销售已结清、待结算投影为 0，所以快照仍用**已结算口径**
 * 的 `gdpCentsOf`：快照口径不变，也不会把实时待结算预估值写进持久统计。
 * 幂等：同一 monthKey 已存在快照时直接返回，不重复固化（指数 finalize 本身也幂等）。
 */
export function snapshotCityMonth(
  draft: GameState,
  input: { monthKey: string; boundaryMinute: number },
): CityMonthSnapshot {
  const existing = draft.cityStatistics.months.find((item) => item.monthKey === input.monthKey);
  if (existing) return existing;

  const statistics = draft.cityStatistics;
  const summary = finalizeIndexMonth(
    statistics.index,
    input.monthKey,
    input.boundaryMinute,
    cityPriceOf(draft),
  );
  const baseGdpCents = statistics.base.gdpCents;
  const snapshot: CityMonthSnapshot = {
    monthKey: input.monthKey,
    settledAtMinute: input.boundaryMinute,
    baseGdpCents,
    outputCumulativeCents: statistics.output.cumulativeCents,
    outputMonthCents: statistics.output.monthCents,
    stockAdjustCents: stockAdjustCentsOf(baseGdpCents, summary.value),
    gdpCents: gdpCentsOf(statistics, summary.value),
    indexValue: summary.value,
    indexSampleCount: summary.sampleCount,
    indexValid: summary.valid,
    industries: industriesOf(draft),
  };
  pushMonthSnapshot(statistics, snapshot);
  return snapshot;
}

/** 当前累计经营产出的月份滚动（新月份观察窗口开启时调用，和 beginCityIndexMonth 一起）。 */
export function rollCityOutputMonth(draft: GameState, monthKey: string): void {
  rollOutputMonth(draft.cityStatistics, monthKey);
}
