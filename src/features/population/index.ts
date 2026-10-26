/**
 * 人口模块 —— 城市经济人口的唯一权威，兼保留三类消费群体的偏好数据。
 *
 * 两类数据分清楚：
 *  - `groups`：抽象消费偏好与权重，市场销量计算继续用它，本轮不改动；
 *  - `classes`：低/中/高经济阶层人数（浮点），是全城总人口的唯一权威，
 *    总人口永远等于三者之和，不另存一份总数。
 *
 * 模块只做「增长 + 月度阶层流动」的纯计算：
 *  - 自然增长用固定锚点的指数比，一次推进与分段推进结果一致；
 *  - 月度流动接收标准化的经营指标（j/i/p，原始有界值）与证券市场摘要，
 *    经营权重（0.30）在本模块内统一乘一次，调用方不得再乘；
 *  - 不读取 GameState、企业内部状态或股票内部状态，不管理政治偏好。
 */

import { POPULATION_GROUPS, type PopulationGroupConfig } from '../../content/business';
import { POPULATION_BUSINESS_RULES, POPULATION_RULES } from '../../content/population';
import { TIME } from '../../content/config';
import { BusinessError } from '../../core/errors';
import type { DeepReadonly } from '../../core/readonly';
import type { CalendarConfig } from '../../core/calendar';
import { monthStartMinute, monthIndexAtMinute } from '../../core/calendar';

export interface PopulationGroup {
  readonly id: string;
  readonly name: string;
  readonly weight: number;
  readonly preferences: {
    readonly performance: number;
    readonly reliability: number;
    readonly usability: number;
  };
  readonly note: string;
}

/** 三个经济阶层的人数（浮点，保留小数精度；显示时才统一取整）。 */
export interface EconomicClasses {
  low: number;
  mid: number;
  high: number;
}

/** 证券市场月度摘要：由应用层适配（population-market）计算后传入。 */
export interface MarketMonthSummary {
  /** 等权算术平均的调整后月回报（小数比例）。没有有效样本时 valid 为 false。 */
  readonly returnRate: number;
  /** 月回报为负的样本占比（小数比例，计入分母）。 */
  readonly downRatio: number;
  /** 月回报为正的样本占比（小数比例）。 */
  readonly upRatio: number;
  /** 是否存在覆盖完整月份的有效样本。 */
  readonly valid: boolean;
}

/** 单个完整观察月的经营指标样本（j/i/p 为企业等权后的原始有界值）。 */
export interface BusinessMonthSample {
  readonly monthKey: string;
  readonly j: number;
  readonly i: number;
  readonly p: number;
  /** 该月是否是完整观察月（观察起点早于该月月初）。 */
  readonly complete: boolean;
}

/** 单个完整观察月的市场样本（与经营样本同期落账）。 */
export interface MarketMonthSample {
  readonly monthKey: string;
  readonly returnRate: number;
  readonly downRatio: number;
  readonly upRatio: number;
  readonly valid: boolean;
}

/** 一次月度阶层流动的持久记录（有限长度，供界面趋势展示）。 */
export interface PopulationMonthRecord {
  readonly monthKey: string;
  readonly settledAtMinute: number;
  /** 本月自然增长人数（小数）。 */
  readonly growthPeople: number;
  /** 结算前阶层人数。 */
  readonly classesBefore: EconomicClasses;
  /** 结算后阶层人数。 */
  readonly classesAfter: EconomicClasses;
  /** 四条路径的流动人数（低→中 / 中→低 / 中→高 / 高→中）。 */
  readonly flow: { readonly lm: number; readonly ml: number; readonly mh: number; readonly hm: number };
  /** 本月实际参与计算的经营指标（已乘 0.30 权重后的 J/I/P）。 */
  readonly business: { readonly j: number; readonly i: number; readonly p: number };
  /** 本月市场摘要。 */
  readonly market: MarketMonthSummary;
}

/** 证券月度观察窗口：容器放在人口切片，读写逻辑在 app/population-market。 */
export interface MarketSampleEntry {
  readonly securityId: string;
  /** 月初基准价（分/股）。 */
  baselinePrice: number;
  /**
   * 本月累计的每股现金分配（分红，分/股）。
   *
   * 计量尺度与 `referenceFactor` 一致：每次机械价格调整时，
   * 已累计的现金会按同一价格比例换算到事件后的尺度，避免
   * 「先分红、后增发」把同一笔现金重复放大成虚假收益。
   */
  cashPerShare: number;
  /**
   * 机械价格调整的乘法参考因子（初始 1）。
   *
   * 增发摊薄等机械事件按 `priceAfter / priceBefore` 累乘：
   * 参考基准 = `baselinePrice × referenceFactor`，机械事件当刻
   * 「当前价 ÷ 参考基准」保持不变，之后的真实涨跌才计入回报。
   * 不能用绝对价差相加（那会把机械下调从后续真实跌幅里减掉）。
   */
  referenceFactor: number;
  /** 月中是否已终止。 */
  terminated: boolean;
  /** 终止时的真实每股回收价值（分/股）；未终止为 null。 */
  recoveryPerShare: number | null;
}

export interface PopulationMarketWindow {
  /** 基准固定时所在的报表月份。 */
  monthKey: string;
  fixedAtMinute: number;
  /** 基准是否固定在该月月初（决定本窗口是否覆盖完整月）。 */
  fixedAtMonthStart: boolean;
  samples: Record<string, MarketSampleEntry>;
  /** 最近完成月份的市场摘要（有限长度）。 */
  history: MarketMonthSummary[];
}

export interface PopulationState {
  /** 三类消费群体的偏好与权重（原口径保留，市场计算继续使用）。 */
  groups: PopulationGroup[];
  /** 经济阶层人数（唯一权威总人口）。 */
  classes: EconomicClasses;
  /** 自然增长基准锚点。 */
  growthAnchorMinute: number;
  /** 增长已同步到的时刻（<= nowMinute 才能继续增长）。 */
  growthSyncedMinute: number;
  /** 锚点时刻的总人口。 */
  growthAnchorTotal: number;
  /** 经营观察起点（游戏分钟）：早于该月月初的月份才算完整观察月。 */
  businessObservationStartMinute: number;
  /** 最近经营月样本（最多 4 条，结算只用最近 3 个完整月）。 */
  businessMonths: BusinessMonthSample[];
  /** 最近市场月样本（与经营样本同长度管理）。 */
  marketMonths: MarketMonthSample[];
  /** 证券月度观察窗口（容器，逻辑在 app/population-market）。 */
  marketWindow: PopulationMarketWindow;
  /** 月度记录（最多 POPULATION_RULES.historyLimit 条）。 */
  records: PopulationMonthRecord[];
}

export function createPopulationState(nowMinute = 0): PopulationState {
  const total = POPULATION_RULES.initialPeople;
  const { low, mid, high } = POPULATION_RULES.initialRatios;
  return {
    groups: POPULATION_GROUPS.map((group: PopulationGroupConfig) => ({
      id: group.id,
      name: group.name,
      weight: group.weight,
      preferences: { ...group.preferences },
      note: group.note,
    })),
    classes: { low: total * low, mid: total * mid, high: total * high },
    growthAnchorMinute: nowMinute,
    growthSyncedMinute: nowMinute,
    growthAnchorTotal: total,
    businessObservationStartMinute: nowMinute,
    businessMonths: [],
    marketMonths: [],
    marketWindow: {
      monthKey: '',
      fixedAtMinute: nowMinute,
      fixedAtMonthStart: false,
      samples: {},
      history: [],
    },
    records: [],
  };
}

/** 权重合计，用于界面提示；不等于 1 时说明配置有问题。 */
export function totalWeight(state: PopulationState | DeepReadonly<PopulationState>): number {
  let sum = 0;
  for (const group of state.groups) sum += group.weight;
  return sum;
}

/** 唯一权威总人口（浮点）。 */
export function totalPopulationOf(
  state: PopulationState | DeepReadonly<PopulationState>,
): number {
  return state.classes.low + state.classes.mid + state.classes.high;
}

/* ------------------------------------------------------------ 自然增长 */

function growthFactor(state: PopulationState, nowMinute: number): number {
  const days = (nowMinute - state.growthAnchorMinute) / TIME.calendar.minutesPerDay;
  return Math.pow(1 + POPULATION_RULES.annualNaturalGrowthRate, days / POPULATION_RULES.daysPerYear);
}

/**
 * 推进自然增长到 nowMinute：按「锚点总数 × 指数比」计算，
 * 与调用次数无关（一次推进与分段推进结果一致）。
 * 暂停、关闭、后台不推进时间，自然不产生增长。
 */
export function advanceNaturalGrowth(state: PopulationState, nowMinute: number): void {
  if (nowMinute <= state.growthSyncedMinute) return;
  const anchorFactor = Math.pow(
    1 + POPULATION_RULES.annualNaturalGrowthRate,
    (state.growthSyncedMinute - state.growthAnchorMinute) / TIME.calendar.minutesPerDay
      / POPULATION_RULES.daysPerYear,
  );
  const nowFactor = growthFactor(state, nowMinute);
  const ratio = anchorFactor > 0 ? nowFactor / anchorFactor : 1;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new BusinessError('INVALID_GROWTH', '人口增长参数非法，拒绝结算');
  }
  state.classes.low *= ratio;
  state.classes.mid *= ratio;
  state.classes.high *= ratio;
  state.growthSyncedMinute = nowMinute;
}

/** 月结后重置增长锚点：把当前总数固化为新基准，避免长期浮点漂移。 */
export function resetGrowthAnchor(state: PopulationState, nowMinute: number): void {
  state.growthAnchorMinute = nowMinute;
  state.growthSyncedMinute = nowMinute;
  state.growthAnchorTotal = totalPopulationOf(state);
}

/* ------------------------------------------------------------ 月度流动 */

function clampRate(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new BusinessError('INVALID_FLOW_RATE', `${label} 非法，拒绝人口结算`);
  }
  return value;
}

/**
 * 月度阶层流动。
 *
 * 输入：
 *  - business：{ j, i, p } 原始有界企业指标（j/i ∈ [-1,1]，p ∈ [0,1]），
 *    本函数统一乘 0.30 得到 J/I/P，调用方不得再乘；
 *  - market：当月证券市场摘要（valid=false 或缺省时为中性）。
 *
 * 四条路径全部从同一份结算前快照计算，同一居民不会在同月连续升降两级，
 * 流动不改变总人口（先算全部流出，再互相汇入）。
 */
export function settleMonthFlow(
  state: PopulationState,
  input: {
    readonly monthKey: string;
    readonly settledAtMinute: number;
    readonly business: { readonly j: number; readonly i: number; readonly p: number };
    readonly market: MarketMonthSummary;
    /** 本月自然增长人数（由应用层按锚点差额计算）。 */
    readonly growthPeople?: number;
  },
): PopulationMonthRecord {
  const w = POPULATION_RULES.businessWeight;
  const J = clampRate(input.business.j, '就业指标 J') * w;
  const I = clampRate(input.business.i, '产业指标 I') * w;
  const P = clampRate(input.business.p, '经营压力 P') * w;

  const base = POPULATION_RULES.baseFlow;
  const mod = POPULATION_RULES.businessFlow;
  const bLM = Math.max(0, base.lm + mod.lm.j * J + mod.lm.i * I + mod.lm.p * P);
  const bML = Math.max(0, base.ml + mod.ml.j * J + mod.ml.p * P);
  const bMH = Math.max(0, base.mh + mod.mh.j * J + mod.mh.i * I + mod.mh.p * P);
  const bHM = Math.max(0, base.hm + mod.hm.i * I + mod.hm.p * P);

  const impact = POPULATION_RULES.stockImpact;
  const part = POPULATION_RULES.participation;
  const r = input.market.valid ? input.market.returnRate : 0;
  const dRaw = input.market.valid
    ? input.market.downRatio * Math.min(1, Math.max(0, (-r - impact.threshold) / impact.fullSwing))
    : 0;
  const uRaw = input.market.valid
    ? input.market.upRatio * Math.min(1, Math.max(0, (r - impact.threshold) / impact.fullSwing))
    : 0;
  const D = clampRate(dRaw, '下跌强度 D');
  const U = clampRate(uRaw, '上涨强度 U');

  const rLM = bLM * (1 - impact.suppression * D) + part.low * impact.upward.lm * U;
  const rML = bML + part.mid * impact.downward.ml * D;
  const rMH = bMH * (1 - impact.suppression * D) + part.mid * impact.upward.mh * U;
  const rHM = bHM + part.high * impact.downward.hm * D;

  for (const [rate, label] of [[rLM, '低→中'], [rML, '中→低'], [rMH, '中→高'], [rHM, '高→中']] as const) {
    if (!Number.isFinite(rate) || rate < 0) {
      throw new BusinessError('INVALID_FLOW_RATE', `${label} 流动率非法，拒绝人口结算`);
    }
  }
  if (rML + rMH > 1 || rLM > 1 || rHM > 1) {
    throw new BusinessError('FLOW_OVERFLOW', '流出比例超过来源人数，拒绝人口结算');
  }

  const before: EconomicClasses = { ...state.classes };
  const L = before.low;
  const M = before.mid;
  const H = before.high;
  if (!(L >= 0 && M >= 0 && H >= 0)) {
    throw new BusinessError('INVALID_POPULATION', '阶层人数非法，拒绝人口结算');
  }

  const fLM = L * rLM;
  const fML = M * rML;
  const fMH = M * rMH;
  const fHM = H * rHM;

  state.classes.low = L - fLM + fML;
  state.classes.mid = M - fML - fMH + fLM + fHM;
  state.classes.high = H - fHM + fMH;

  const totalBefore = L + M + H;
  const totalAfter = totalPopulationOf(state);
  if (Math.abs(totalAfter - totalBefore) > 1e-6 || !(totalAfter >= 0)) {
    // 守恒被破坏：拒绝并回滚本次写入
    state.classes.low = L;
    state.classes.mid = M;
    state.classes.high = H;
    throw new BusinessError('POPULATION_CONSERVATION', '人口守恒校验失败，拒绝结算');
  }

  const record: PopulationMonthRecord = {
    monthKey: input.monthKey,
    settledAtMinute: input.settledAtMinute,
    growthPeople: input.growthPeople ?? 0,
    classesBefore: before,
    classesAfter: { ...state.classes },
    flow: { lm: fLM, ml: fML, mh: fMH, hm: fHM },
    business: { j: J, i: I, p: P },
    market: input.market,
  };
  state.records.push(record);
  if (state.records.length > POPULATION_RULES.historyLimit) {
    state.records.splice(0, state.records.length - POPULATION_RULES.historyLimit);
  }
  return record;
}

/* ------------------------------------------------------------ 观察样本 */

/**
 * 记录一个月的观察样本（经营 + 市场），供下一月结算按 0.5/0.3/0.2 加权。
 * 只保留最近 4 条：结算最多用最近 3 个完整月，多余的纯属缓冲。
 */
export function recordObservationMonth(
  state: PopulationState,
  business: BusinessMonthSample,
  market: MarketMonthSample,
): void {
  state.businessMonths.push(business);
  state.marketMonths.push(market);
  const limit = 4;
  if (state.businessMonths.length > limit) {
    state.businessMonths.splice(0, state.businessMonths.length - limit);
  }
  if (state.marketMonths.length > limit) {
    state.marketMonths.splice(0, state.marketMonths.length - limit);
  }
}

/** 某个月份是否是完整观察月（观察起点早于该月月初）。 */
export function isCompleteObservationMonth(
  state: PopulationState,
  monthKey: string,
  calendar: CalendarConfig,
): boolean {
  for (const sample of state.businessMonths) {
    if (sample.monthKey === monthKey) return sample.complete;
  }
  const index = monthIndexOfKey(monthKey, calendar);
  if (index === null) return false;
  return state.businessObservationStartMinute <= monthStartMinute(index, calendar);
}

function monthIndexOfKey(monthKey: string, calendar: CalendarConfig): number | null {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const origin = calendar.start.year * 12 + (calendar.start.month - 1);
  return year * 12 + (month - 1) - origin;
}

/**
 * 按最近三个完整观察月加权出原始 j/i/p（0.5 / 0.3 / 0.2）。
 * J/I 不足三个完整月时保持中性（0）；P 按实际可用样本的权重归一化。
 * 没有任何完整月时全部为中性。
 */
export function weightedBusinessIndicators(
  state: PopulationState,
): { j: number; i: number; p: number } {
  const complete = state.businessMonths.filter((sample) => sample.complete).slice(-3);
  if (complete.length === 0) return { j: 0, i: 0, p: 0 };
  const weights = POPULATION_BUSINESS_RULES.recentWeights;
  let j = 0;  let i = 0;
  let p = 0;
  for (let k = 0; k < complete.length; k += 1) {
    const sample = complete[complete.length - 1 - k]!;
    const weight = weights[k] ?? 0;
    j += sample.j * weight;
    i += sample.i * weight;
    p += sample.p * weight;
  }
  const weightSum = weights.slice(0, complete.length).reduce((sum, value) => sum + value, 0);
  if (complete.length >= 3) {
    return { j, i, p };
  }
  // 不足三个完整月：J/I 中性，P 按可用权重归一化
  const normalizedP = weightSum > 0 ? p / weightSum : 0;
  return { j: 0, i: 0, p: normalizedP };
}

/** 最近一次已落账的市场月样本（没有时返回中性无效样本）。 */
export function latestMarketSample(state: PopulationState): MarketMonthSample {
  const last = state.marketMonths[state.marketMonths.length - 1];
  if (last) return last;
  return { monthKey: '', returnRate: 0, downRatio: 0, upRatio: 0, valid: false };
}

/* ------------------------------------------------------------ 显示取整 */

/**
 * 显示用整数分配（最大余数法）：各阶层人数之和严格等于显示总人口，
 * 比例显示不会因取整导致图表面积对不上。
 */
export function displayClasses(
  classes: EconomicClasses | DeepReadonly<EconomicClasses>,
): { total: number; low: number; mid: number; high: number } {
  const low = Math.max(0, classes.low);
  const mid = Math.max(0, classes.mid);
  const high = Math.max(0, classes.high);
  const total = low + mid + high;
  const totalInt = Math.round(total);
  const parts: Array<{ key: 'low' | 'mid' | 'high'; value: number; floor: number; remainder: number }> = (
    [
      { key: 'low', value: low },
      { key: 'mid', value: mid },
      { key: 'high', value: high },
    ] as const
  ).map((part) => {
    const share = total > 0 ? (part.value / total) * totalInt : Math.floor(totalInt / 3);
    const floor = Math.floor(share);
    return { key: part.key, value: part.value, floor, remainder: share - floor };
  });
  let assigned = parts.reduce((sum, part) => sum + part.floor, 0);
  const ordered = [...parts].sort((left, right) => right.remainder - left.remainder);
  let index = 0;
  while (assigned < totalInt && ordered.length > 0) {
    const pick = ordered[index % ordered.length]!;
    pick.floor += 1;
    assigned += 1;
    index += 1;
    if (index > totalInt + 3) break;
  }
  const result: Record<'low' | 'mid' | 'high', number> = { low: 0, mid: 0, high: 0 };
  for (const part of parts) result[part.key] = part.floor;
  return { total: totalInt, low: result.low, mid: result.mid, high: result.high };
}

/** 通用最大余数分配：把 total 分配到 weights 上，和严格守恒。 */
export function largestRemainderSplit(
  total: number,
  weights: readonly number[],
): number[] {
  const weightSum = weights.reduce((sum, value) => sum + Math.max(0, value), 0);
  const shares = weights.map((value) => {
    const raw = weightSum > 0 ? (Math.max(0, value) / weightSum) * total : total / weights.length;
    return { floor: Math.floor(raw), remainder: raw - Math.floor(raw) };
  });
  let assigned = shares.reduce((sum, share) => sum + share.floor, 0);
  const order = shares
    .map((share, index) => ({ index, remainder: share.remainder }))
    .sort((left, right) => right.remainder - left.remainder);
  let cursor = 0;
  while (assigned < total && order.length > 0) {
    shares[order[cursor % order.length]!.index]!.floor += 1;
    assigned += 1;
    cursor += 1;
    if (cursor > total + weights.length + 2) break;
  }
  return shares.map((share) => share.floor);
}

/** 月份序号辅助：暴露给应用层与校验器复用。 */
export function populationMonthIndexAtMinute(totalMinute: number, calendar: CalendarConfig): number {
  return monthIndexAtMinute(totalMinute, calendar);
}
