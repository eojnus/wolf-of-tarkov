/**
 * 宏观住房 —— 有限收入群组的居住分配、购房意愿、负担能力与月度指标。
 *
 * 边界（见 docs/architecture.md 第 14 节）：
 *  - 不创建逐人 NPC、十万个家庭实体或十万个账户；只有 3 个收入群组；
 *  - **不保存群组余额**：群组资金是 `finance` 里的 `household:<groupId>` 主体账户，
 *    本模块只接收「可用储蓄」作为参数做纯计算；
 *  - 城市总人口仍是 `population.classes` 的唯一权威，本模块只保存折算后的家庭数；
 *  - 不读写房产记录（那是 `features/real-estate`），匹配与成交由 app 层编排。
 *
 * 两个维度互斥/独立：
 *  - 居住情况（`ownedHouseholds` / 其余为租住）是**互斥分配**，两者之和等于家庭数；
 *  - 购房意愿（`wantFirstTime` / `wantUpgrade`）是独立维度：租住家庭可以有首次购房意愿。
 */

import type { DeepReadonly } from '../../core/readonly';
import {
  HOUSING_GROUPS,
  REAL_ESTATE_RULES,
  housingGroupConfigOf,
  type HousingGroupConfig,
  type HousingIncomeTier,
} from '../../content/real-estate';
import { BusinessError } from '../../core/errors';

export interface HousingGroupState {
  readonly id: string;
  readonly income: HousingIncomeTier;
  /** 家庭数（整数，由阶层人数 ÷ 家庭规模确定性派生）。 */
  households: number;
  /** 拥有自有住房的家庭数（含持有可追踪住宅单元的家庭）；其余为租住。 */
  ownedHouseholds: number;
  /** 尚未满足的首次购房意愿（户，浮点存量）。 */
  wantFirstTime: number;
  /** 尚未满足的改善置换意愿（户，浮点存量）。 */
  wantUpgrade: number;
}

export interface HousingIncomeTriple {
  readonly low: number;
  readonly mid: number;
  readonly high: number;
}

export interface HousingMonthMetrics {
  readonly monthKey: string;
  readonly settledAtMinute: number;
  /** 本月通过市场完成的成交套数（不含玩家现场买入）。 */
  readonly marketSales: number;
  readonly householdSales: number;
  readonly investorSales: number;
  /** 本月玩家买入套数（由 app 层在该月成交时累加，只用于指标展示）。 */
  readonly playerSales: number;
  readonly avgSalePriceCents: number;
  readonly avgValuationCents: number;
  readonly vacantUnits: number;
  readonly listedUnits: number;
  /** 未满足的有效意愿（户）。 */
  readonly unmetDemand: number;
  /** 房价 ÷ 家庭年收入（按典型户型）。 */
  readonly affordability: HousingIncomeTriple;
  /** 住房压力 0～1（0.5 为中性），按收入阶层映射到政治满意度。 */
  readonly pressure: HousingIncomeTriple;
  /** 是否有完整月的观察样本（迁移后的首个不完整月为 false）。 */
  readonly complete: boolean;
}

export interface HousingState {
  groups: HousingGroupState[];
  lastSettledMonthKey: string | null;
  /** 最近 `monthHistoryLimit` 条月度指标，按时间正序。 */
  monthly: HousingMonthMetrics[];
  /** 观察起点：早于该月月初的月份才算完整月。 */
  observationStartMinute: number;
}

/** 家庭数：确定性向下取整，不做随机与四舍五入（避免凭空多出家庭）。 */
export function householdsOf(people: number, householdSize: number): number {
  if (!Number.isFinite(people) || people <= 0) return 0;
  if (!Number.isFinite(householdSize) || householdSize <= 0) return 0;
  return Math.floor(people / householdSize);
}

export function createHousingState(
  classes: { readonly low: number; readonly mid: number; readonly high: number },
  nowMinute: number,
): HousingState {
  const groups: HousingGroupState[] = HOUSING_GROUPS.map((config) => {
    const households = householdsOf(classes[config.income], config.householdSize);
    return {
      id: config.id,
      income: config.income,
      households,
      // 开局：多数家庭自有住房（配置比例），其余租住；这是宏观背景统计。
      ownedHouseholds: Math.floor(households * OWNERSHIP_SHARE[config.income]),
      wantFirstTime: 0,
      wantUpgrade: 0,
    };
  });
  return {
    groups,
    lastSettledMonthKey: null,
    monthly: [],
    observationStartMinute: nowMinute,
  };
}

/**
 * 开局的「自有住房家庭比例」：用来解释既有城市人口的居住情况，
 * 让全城不是只有 100 套可交互住宅（可交互住宅只是宏观存量中可追踪的子集）。
 */
export const OWNERSHIP_SHARE: Readonly<Record<HousingIncomeTier, number>> = {
  low: 0.45,
  mid: 0.6,
  high: 0.78,
};

export function groupConfig(groupId: string): HousingGroupConfig {
  const config = housingGroupConfigOf(groupId);
  if (!config) throw new BusinessError('NO_HOUSING_GROUP', `未知住房群组：${groupId}`);
  return config;
}

export function groupOf(
  state: HousingState | DeepReadonly<HousingState>,
  groupId: string,
): HousingGroupState | DeepReadonly<HousingGroupState> | null {
  const source: readonly (HousingGroupState | DeepReadonly<HousingGroupState>)[] = state.groups;
  for (const group of source) {
    if (group.id === groupId) return group;
  }
  return null;
}

export function rentedOf(
  group: HousingGroupState | DeepReadonly<HousingGroupState>,
): number {
  return Math.max(0, group.households - group.ownedHouseholds);
}

export function totalHouseholds(
  state: HousingState | DeepReadonly<HousingState>,
): number {
  let total = 0;
  for (const group of state.groups) total += group.households;
  return total;
}

/**
 * 按最新阶层人数同步家庭数。
 *
 * - 家庭数只由人口派生，人口不会因住房变化而改变；
 * - 自有住房家庭数不得超过家庭数（家庭数下降时截断，不伪造新的自有家庭）；
 * - 购房意愿同样按上限收敛，避免人口下降后仍保留不可能的意愿。
 */
export function syncHouseholds(
  state: HousingState,
  classes: { readonly low: number; readonly mid: number; readonly high: number },
): void {
  for (const group of state.groups) {
    const config = groupConfig(group.id);
    const households = householdsOf(classes[group.income], config.householdSize);
    group.households = households;
    if (group.ownedHouseholds > households) group.ownedHouseholds = households;
    const maxFirst = Math.floor(rentedOf(group) * config.maxIntentShare);
    const maxUpgrade = Math.floor(group.ownedHouseholds * config.maxIntentShare);
    if (group.wantFirstTime > maxFirst) group.wantFirstTime = maxFirst;
    if (group.wantUpgrade > maxUpgrade) group.wantUpgrade = maxUpgrade;
  }
}

/** 家庭年收入（分）。 */
export function annualIncomeCents(config: HousingGroupConfig): number {
  return config.monthlyHouseholdIncomeCents * 12;
}

/** 该群组内「储蓄达到 price 的家庭占比」：按配置的储蓄档位分布计算。 */
export function savingsShareAtLeast(config: HousingGroupConfig, priceCents: number, avgSavings: number): number {
  if (avgSavings <= 0 || priceCents <= 0) return 0;
  const ratio = priceCents / avgSavings;
  let share = 0;
  for (const tier of config.savingsTiers) {
    if (tier.multiple >= ratio) share += tier.share;
  }
  return Math.min(1, Math.max(0, share));
}

/**
 * 该群组最多有多少户同时具备购买这套房的条件。
 *
 * 三个约束取小：
 *  - 意愿：不许超过尚未满足的购房意愿户数；
 *  - 财富分布：只有储蓄档位够高的那部分家庭有购买力（平均储蓄不能让所有家庭同时买得起）；
 *  - 资金池：群组账户里的真实储蓄必须够付这套房的全款（不许透支、不许垫付）。
 * 另外房价不得超过「家庭年收入 × 可负担倍数」，否则整组买不起。
 */
export function affordableHouseholds(
  group: HousingGroupState | DeepReadonly<HousingGroupState>,
  config: HousingGroupConfig,
  input: { readonly savingsCents: number; readonly priceCents: number; readonly want: number },
): number {
  if (group.households <= 0 || input.want < 1 || input.priceCents <= 0) return 0;
  if (input.priceCents > annualIncomeCents(config) * config.maxPriceToIncome) return 0;
  const avg = input.savingsCents / group.households;
  const share = savingsShareAtLeast(config, input.priceCents, avg);
  const byWealth = Math.floor(group.households * share);
  const byFunds = Math.floor(input.savingsCents / input.priceCents);
  return Math.max(0, Math.min(Math.floor(input.want), byWealth, byFunds));
}

/** 房价 ÷ 家庭年收入。 */
export function affordabilityRatio(
  config: HousingGroupConfig,
  priceCents: number,
): number {
  const annual = annualIncomeCents(config);
  if (annual <= 0) return 0;
  return priceCents / annual;
}

/**
 * 住房压力 0～1（0.5 为中性）：
 *   gap = clamp((房价/年收入 − 舒适倍数) ÷ 舒适倍数, −1, 1)
 *   pressure = clamp(0.5 + 0.5×gap + 0.4×未满足意愿占比, 0, 1)
 * 只有真实数据（当月均价、意愿存量）进入公式，不读取玩家个人收支。
 */
export function housingPressure(
  config: HousingGroupConfig,
  input: { readonly priceCents: number; readonly unmetShare: number },
): number {
  const ratio = affordabilityRatio(config, input.priceCents);
  const gap = Math.min(
    1,
    Math.max(-1, (ratio - config.comfortablePriceToIncome) / config.comfortablePriceToIncome),
  );
  const unmet = Math.min(1, Math.max(0, input.unmetShare));
  return Math.min(1, Math.max(0, 0.5 + 0.5 * gap + 0.4 * unmet));
}

/**
 * 月度新增购房意愿：按租住/自有家庭比例累积，并受上限约束。
 * 幂等由调用方（每月只调用一次）保证；同一月重复推进不会重复累积。
 */
export function accrueMonthlyDemand(group: HousingGroupState): void {
  const config = groupConfig(group.id);
  const rented = rentedOf(group);
  const maxFirst = rented * config.maxIntentShare;
  const maxUpgrade = group.ownedHouseholds * config.maxIntentShare;
  group.wantFirstTime = Math.min(
    maxFirst,
    group.wantFirstTime + rented * config.firstTimeIntentRate,
  );
  group.wantUpgrade = Math.min(
    maxUpgrade,
    group.wantUpgrade + group.ownedHouseholds * config.upgradeIntentRate,
  );
}

/** 成交后消耗意愿：首次购房消耗首次意愿，改善置换消耗改善意愿。 */
export function consumeDemand(
  group: HousingGroupState,
  kind: 'first-time' | 'upgrade',
): void {
  if (kind === 'first-time') group.wantFirstTime = Math.max(0, group.wantFirstTime - 1);
  else group.wantUpgrade = Math.max(0, group.wantUpgrade - 1);
}

/** 记录家庭迁入自有住房（首次购房）：自有 +1，租住 −1（互斥分配）。 */
export function markOwnershipGained(group: HousingGroupState): void {
  if (group.ownedHouseholds < group.households) group.ownedHouseholds += 1;
}

/** 玩家买入不会改变居民家庭的自有/租住统计：房产从卖方转给玩家。 */
export function recordMonth(state: HousingState, metrics: HousingMonthMetrics): void {
  state.monthly.push(metrics);
  if (state.monthly.length > REAL_ESTATE_RULES.monthHistoryLimit) {
    state.monthly.splice(0, state.monthly.length - REAL_ESTATE_RULES.monthHistoryLimit);
  }
}

export function latestMetrics(
  state: HousingState | DeepReadonly<HousingState>,
): HousingMonthMetrics | null {
  const last = state.monthly[state.monthly.length - 1];
  return last ?? null;
}

/** 没有月度样本时的中性压力（0.5）。 */
export const NEUTRAL_PRESSURE = 0.5;

/** 住房压力按收入阶层映射：政治满意度按群体所属阶层取对应值。 */
export function pressureForIncome(
  metrics: HousingMonthMetrics | DeepReadonly<HousingMonthMetrics> | null,
  income: HousingIncomeTier,
): number {
  return metrics?.pressure[income] ?? NEUTRAL_PRESSURE;
}
