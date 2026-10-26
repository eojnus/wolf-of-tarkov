/**
 * 城市统计（features）—— 经营产出、基础 GDP、连续全市场指数与月度快照的纯数据与纯计算。
 *
 * 边界：
 *  - 只认识本切片与 content/core：不 import app、不 import 其它 features，
 *    也不读取企业/人口/证券的真实状态；指数现价一律由调用方以 `priceOf` 传入。
 *  - 不建立第二套时钟：所有时刻都是调用方传入的游戏分钟参数，本模块不调用 Date.now。
 *  - 不制造价格：真实涨跌由 `priceOf` 反映；分红现金与增发等机械调价只由真实事件入口登记。
 *
 * 口径（与 content/city-economy 的规则版本绑定，改口径必须同时升版本与迁移）：
 *  - G(t) = 开局基础 GDP G0 + 已结算累计经营产出 P(t) + 股市调整 S(t)；
 *  - S(t) = round(G0 × 30% × (I(t) / 100 − 1))，I 起点 100；
 *  - 参考财富 = (期末价值 + 累计现金) ÷ (月初价 × Π机械事件价格比)；
 *  - 分红只累计真实每股现金（除息已在现价里，不再额外补偿）；
 *  - 增发等机械调价：referenceFactor 与 cashPerShare 同时乘 priceAfter / priceBefore；
 *  - 月中清算样本保留到窗口结束（不删跌幅），用真实每股回收值结账；
 *  - 无有效样本时保持已有指数并标记 valid=false，绝不静默回 100；
 *  - 指数与因子必须有限、非负，NaN / Infinity 一律拒绝。
 *
 * 月度窗口由 app 层在月界编排：月底先 `finalizeIndexMonth` 固化，再 `beginIndexMonth` 开新窗口；
 * 两者都幂等/可安全重入，不依赖调用次数。
 */

import { monthIndexFromKey, monthStartMinute } from '../../core/calendar';
import { BusinessError } from '../../core/errors';
import { assertMoneyRange } from '../../core/money';
import type { DeepReadonly } from '../../core/readonly';
import { TIME } from '../../content/config';
import { CITY_ECONOMY_RULES, CITY_STATISTICS_LIMITS } from '../../content/city-economy';

/* ------------------------------------------------------------ 持久数据 */

/** 开局基础 GDP 快照：只生成一次，读档/迁移不得重算。 */
export interface CityBaseGdpRecord {
  readonly gdpCents: number;
  readonly ruleVersion: number;
  readonly generatedAtMinute: number;
  readonly source: 'new-game' | 'migration';
  readonly note: string;
}

/** 本月指数窗口里的单个证券样本。 */
export interface GdpIndexSample {
  securityId: string;
  /** 本窗口起始价（分/股）。 */
  baselinePrice: number;
  /** 累计每股现金分配，随机械事件换算到当前价格尺度。 */
  cashPerShare: number;
  /** 机械调整乘法参考因子，初始 1。 */
  referenceFactor: number;
  terminated: boolean;
  /** 终止时的真实每股回收值；未终止为 null。 */
  recoveryPerShare: number | null;
}

/** 连续指数的一个观察窗口：窗口开始时固定样本，窗口内只更新现金与机械因子。 */
export interface GdpIndexWindow {
  monthKey: string;
  fixedAtMinute: number;
  fixedAtMonthStart: boolean;
  samples: Record<string, GdpIndexSample>;
}

/** 已固化的一个月末指数摘要。 */
export interface GdpIndexMonthSummary {
  readonly monthKey: string;
  /** 月底固化的指数。 */
  readonly value: number;
  /** 本窗口起始指数。 */
  readonly startValue: number;
  /** 本窗口等权财富倍数 − 1。 */
  readonly returnRate: number;
  readonly sampleCount: number;
  /** 窗口是否覆盖完整月且至少有一个有效样本；false 时 returnRate 不可作为月度回报使用。 */
  readonly valid: boolean;
  readonly linkedAtMinute: number;
}

/** 连续指数状态：指数只按月链结，不每月重置回 100。 */
export interface GdpIndexState {
  /** 本窗口起始指数。 */
  monthStartValue: number;
  /** 最近一次月底固化值。 */
  lastClosedValue: number;
  lastClosedMonthKey: string | null;
  window: GdpIndexWindow;
  /** 最多 CITY_ECONOMY_RULES.indexHistoryLimit 条。 */
  history: GdpIndexMonthSummary[];
}

/**
 * 单家企业的产出结算游标。
 *
 * 高水位（`outputSeq`）与结算游标（`settledThroughMinute`）分工不同：
 *  - 高水位只用于防重复登记，永不回退；
 *  - 结算游标记录统计已覆盖到的游戏分钟，供审计与展示，不参与金额计算；
 *  - `baselinePendingCents` 是旧档迁移时**已经发生但尚未结算**的产出基线：
 *    它会在之后首次真实结算/实时预览时被扣除（预览只读，不扣），剩下的继续递减，
 *    避免把迁移前的产出当成统计接入后的新增产出。
 */
export interface OutputCursor {
  outputSeq: number;
  settledThroughMinute: number;
  baselinePendingCents: number;
  totalCents: number;
}

/** 城市经营产出（P(t)）：只来自真实销售结算，永不清零。 */
export interface CityOutputState {
  /** P(t)：已结算累计经营产出（永不清零）。 */
  cumulativeCents: number;
  monthKey: string;
  /** 本月新增已结算产出（月份滚动时清零）。 */
  monthCents: number;
  /** 本统计窗口（自上次月份滚动）内各企业登记的产出，用于分行业拆分。 */
  byCompany: Record<string, number>;
  cursors: Record<string, OutputCursor>;
}

/** 单行业产出：本轮唯一纳入的是科技产业（产品销售）。 */
export interface CityIndustryOutput {
  readonly id: string;
  readonly label: string;
  readonly cents: number;
}

/** 月界固化的城市统计快照（用于趋势展示与建设判断留痕）。 */
export interface CityMonthSnapshot {
  readonly monthKey: string;
  readonly settledAtMinute: number;
  readonly baseGdpCents: number;
  readonly outputCumulativeCents: number;
  readonly outputMonthCents: number;
  readonly stockAdjustCents: number;
  readonly gdpCents: number;
  readonly indexValue: number;
  readonly indexSampleCount: number;
  readonly indexValid: boolean;
  readonly industries: CityIndustryOutput[];
}

/** 城市统计切片：基础 GDP、经营产出与指数三部分互不覆盖。 */
export interface CityStatisticsState {
  base: CityBaseGdpRecord;
  output: CityOutputState;
  index: GdpIndexState;
  /** 最近 CITY_ECONOMY_RULES.monthSnapshotLimit 条。 */
  months: CityMonthSnapshot[];
  /** 统计接入时刻（新游戏 = 0；旧档 = 迁移时刻）。 */
  registeredAtMinute: number;
}

/* ------------------------------------------------------------ 基础校验 */

/** 游戏分钟：非负安全整数。 */
function assertMinute(minute: number, field: string): void {
  if (!Number.isSafeInteger(minute) || minute < 0) {
    throw new BusinessError('INVALID_MINUTE', `${field}必须是合法的游戏分钟`);
  }
}

function assertMonthKey(monthKey: string): void {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    throw new BusinessError('INVALID_MONTH_KEY', `非法月份标识：${monthKey}`);
  }
}

/** 长期累计金额：允许超过单笔上限，但必须是安全整数。 */
function assertAggregate(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BusinessError('INVALID_AMOUNT', `${field}必须是非负安全整数（分）`);
  }
  if (value > CITY_STATISTICS_LIMITS.maxAggregateCents) {
    throw new BusinessError('AGGREGATE_OVERFLOW', `${field}超出长期统计的安全整数范围`);
  }
}

function addAggregate(current: number, amount: number, field: string): number {
  assertAggregate(current, field);
  assertAggregate(amount, field);
  const next = current + amount;
  if (!Number.isSafeInteger(next) || next > CITY_STATISTICS_LIMITS.maxAggregateCents) {
    throw new BusinessError('AGGREGATE_OVERFLOW', `${field}累加后超出长期统计的安全整数范围`);
  }
  return next;
}

/* ------------------------------------------------------------ 构造 */

export function createCityStatisticsState(input: {
  base: CityBaseGdpRecord;
  nowMinute: number;
  monthKey: string;
}): CityStatisticsState {
  assertMinute(input.nowMinute, '统计接入时刻');
  assertMonthKey(input.monthKey);
  assertAggregate(input.base.gdpCents, '基础 GDP');
  return {
    base: { ...input.base },
    output: {
      cumulativeCents: 0,
      monthKey: input.monthKey,
      monthCents: 0,
      byCompany: {},
      cursors: {},
    },
    index: {
      monthStartValue: CITY_ECONOMY_RULES.indexStartValue,
      lastClosedValue: CITY_ECONOMY_RULES.indexStartValue,
      lastClosedMonthKey: null,
      // 样本由 app 层 `beginIndexMonth` 固定；在固定之前这是一个不完整窗口（valid=false）。
      window: {
        monthKey: input.monthKey,
        fixedAtMinute: input.nowMinute,
        fixedAtMonthStart: false,
        samples: {},
      },
      history: [],
    },
    months: [],
    registeredAtMinute: input.nowMinute,
  };
}

/* ------------------------------------------------------------ 指数纯计算 */

/**
 * 指数合法性：必须有限且 >= 0，否则抛 BusinessError('INVALID_INDEX', ...)。
 *
 * 用途覆盖指数值、财富倍数与机械因子：任何 NaN / Infinity / 负数都说明状态或输入已损坏，
 * 宁可让本次提交整体回滚，也不写进存档留下不可解释的指数。
 */
export function assertIndexValue(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new BusinessError('INVALID_INDEX', `指数/因子必须有限且非负：${String(value)}`);
  }
  return value;
}

/**
 * 单个样本的财富倍数 = (当前价值 + 累计现金) ÷ 参考基准。
 *
 * 参考基准 = 起始价 × 机械事件价格比连乘；基准 <= 0 或非有限时返回 null（跳过该样本）。
 *
 * 说明：非终止样本的「当前价值」必须由调用方给出现价。为保持现有调用兼容，
 * 第二个参数 `priceOf` 是**可选**的：省略时只能结算已终止样本（用真实每股回收值），
 * 其余返回 null；`averageMultipleOf` / `currentIndexValue` 内部总会传现价。
 */
export function wealthMultipleOf(
  sample: DeepReadonly<GdpIndexSample> | GdpIndexSample,
  priceOf?: (securityId: string) => number,
): number | null {
  const baseline = sample.baselinePrice * sample.referenceFactor;
  if (!Number.isFinite(baseline) || baseline <= 0) return null;

  let currentValue: number;
  if (sample.terminated) {
    // 清算按真实每股回收价值结账，样本保留到窗口结束（跌幅不会被删掉）
    currentValue = sample.recoveryPerShare ?? 0;
  } else {
    if (!priceOf) return null;
    currentValue = priceOf(sample.securityId);
  }
  if (!Number.isFinite(currentValue) || currentValue < 0) return null;

  // 累计现金已在机械事件时换算到当前价格尺度，与参考基准同尺度
  const cash = Number.isFinite(sample.cashPerShare) ? Math.max(0, sample.cashPerShare) : 0;
  const multiple = (currentValue + cash) / baseline;
  return Number.isFinite(multiple) ? multiple : null;
}

/**
 * 窗口的等权平均财富倍数；没有有效样本时 valid=false、multiple=1（中性）。
 *
 * 样本窗口在月初固定：月中上市的公司不进入本月样本，月中终止的公司保留到月底。
 */
export function averageMultipleOf(
  window: DeepReadonly<GdpIndexWindow> | GdpIndexWindow,
  priceOf: (securityId: string) => number,
): { multiple: number; sampleCount: number; valid: boolean } {
  const samples: Record<string, GdpIndexSample | DeepReadonly<GdpIndexSample>> = window.samples;
  let sum = 0;
  let sampleCount = 0;
  for (const sample of Object.values(samples)) {
    const multiple = wealthMultipleOf(sample, priceOf);
    if (multiple === null) continue;
    sum += multiple;
    sampleCount += 1;
  }
  if (sampleCount === 0) return { multiple: 1, sampleCount: 0, valid: false };
  const multiple = sum / sampleCount;
  if (!Number.isFinite(multiple) || multiple < 0) {
    return { multiple: 1, sampleCount, valid: false };
  }
  return { multiple, sampleCount, valid: true };
}

/**
 * 实时指数 = 本窗口起始指数 × 等权平均财富倍数。
 *
 * 没有有效样本时**保持已有指数**（窗口起始值）并标记 valid=false，绝不静默回 100：
 * 指数只按月链结，任何一个月缺少样本都不会让链路断开。
 *
 * 已固化、尚未开新窗口的中间态：此时 monthStartValue 已经是固化值，若再用同一份旧样本
 * 乘一次就会重复计算本月涨跌（月界编排里 snapshot 与 begin 之间确实会调用实时视图）。
 * 因此当「当前窗口的月份已被固化」时直接返回固化值，等下个窗口 begin 后再继续链结。
 */
export function currentIndexValue(
  state: DeepReadonly<GdpIndexState> | GdpIndexState,
  priceOf: (securityId: string) => number,
): { value: number; sampleCount: number; valid: boolean } {
  const startValue = assertIndexValue(state.monthStartValue);
  if (state.lastClosedMonthKey !== null && state.lastClosedMonthKey === state.window.monthKey) {
    const history: readonly DeepReadonly<GdpIndexMonthSummary>[] = state.history;
    const closed = history.find((item) => item.monthKey === state.window.monthKey);
    return {
      value: assertIndexValue(state.lastClosedValue),
      sampleCount: closed?.sampleCount ?? 0,
      valid: closed?.valid ?? false,
    };
  }
  const average = averageMultipleOf(state.window, priceOf);
  if (!average.valid) {
    return { value: startValue, sampleCount: average.sampleCount, valid: false };
  }
  return {
    value: assertIndexValue(startValue * average.multiple),
    sampleCount: average.sampleCount,
    valid: true,
  };
}

/** 股市调整值 S = round(G0 × 30% × (I / 100 − 1))。可为负，金额为整数分。 */
export function stockAdjustCentsOf(baseGdpCents: number, indexValue: number): number {
  assertAggregate(baseGdpCents, '基础 GDP');
  const index = assertIndexValue(indexValue);
  return Math.round(
    baseGdpCents * CITY_ECONOMY_RULES.stockWeight * (index / CITY_ECONOMY_RULES.indexStartValue - 1),
  );
}

/** G = base + 已结算累计经营产出 + S。金额为整数分，长期累计不套用单笔上限。 */
export function gdpCentsOf(
  state: DeepReadonly<CityStatisticsState> | CityStatisticsState,
  indexValue: number,
): number {
  const base = state.base.gdpCents;
  assertAggregate(base, '基础 GDP');
  assertAggregate(state.output.cumulativeCents, '累计经营产出');
  const gdp = base + state.output.cumulativeCents + stockAdjustCentsOf(base, indexValue);
  assertAggregate(gdp, '城市 GDP');
  return gdp;
}

/* ------------------------------------------------------------ 指数窗口 */

/** 校验样本本身可参与计算：起始价 > 0、因子 > 0、现金与回收值非负有限。 */
function assertIndexSample(sample: GdpIndexSample): void {
  if (!Number.isFinite(sample.baselinePrice) || sample.baselinePrice <= 0) {
    throw new BusinessError('INVALID_INDEX', `证券 ${sample.securityId} 的窗口起始价非法`);
  }
  if (!Number.isFinite(sample.referenceFactor) || sample.referenceFactor <= 0) {
    throw new BusinessError('INVALID_INDEX', `证券 ${sample.securityId} 的参考因子非法`);
  }
  assertIndexValue(sample.cashPerShare);
  const recovery = sample.recoveryPerShare;
  if (recovery !== null) assertIndexValue(recovery);
}

/**
 * 开新观察窗口：调用方保证「上一窗口已 finalize」，本函数把起始指数接在最近固化值上。
 *
 * 窗口是否覆盖完整自然月由**时刻本身**判定（起点必须等于该月月初）：
 *  - 正常月界的起点正好是下月月初 → fixedAtMonthStart = true；
 *  - 新游戏首个窗口与旧档迁移窗口从中途开始 → false，指数仍实时工作，
 *    只是月底摘要的 returnRate 会标记 valid=false（不把半月涨跌当整月回报）。
 */
export function beginIndexMonth(
  state: GdpIndexState,
  monthKey: string,
  minute: number,
  samples: Record<string, GdpIndexSample>,
): void {
  assertMonthKey(monthKey);
  assertMinute(minute, '指数窗口起点');
  for (const sample of Object.values(samples)) assertIndexSample(sample);

  const monthIndex = monthIndexFromKey(monthKey, TIME.calendar);
  const fixedAtMonthStart =
    monthIndex !== null && minute === monthStartMinute(monthIndex, TIME.calendar);

  // 起始指数 = 最近一次固化值（新游戏/迁移时由 create 设为 100），不由本函数重置为 100
  state.monthStartValue = assertIndexValue(state.lastClosedValue);
  state.window = {
    monthKey,
    fixedAtMinute: minute,
    fixedAtMonthStart,
    samples: { ...samples },
  };
}

/**
 * 月底固化指数（幂等）：同一 monthKey 重复调用直接返回已有摘要，不再改状态。
 *
 * 口径：
 *  - `value` 永远取月底实时指数；没有有效样本时保持窗口起始值（指数链不断）；
 *  - `returnRate` 记录实际窗口倍数 − 1；`valid` 只在「窗口自月初固定且至少一个有效样本」时
 *    为 true，因此不完整窗口（新游戏首月、旧档迁移首月）的历史回报不可当整月回报使用；
 *  - 固化后把 value 写回 monthStartValue / lastClosedValue，下月窗口从这个值继续链结。
 */
export function finalizeIndexMonth(
  state: GdpIndexState,
  monthKey: string,
  boundaryMinute: number,
  priceOf: (securityId: string) => number,
): GdpIndexMonthSummary {
  assertMonthKey(monthKey);
  assertMinute(boundaryMinute, '月界时刻');

  const existing = state.history.find((item) => item.monthKey === monthKey);
  if (existing) return existing;

  const current = currentIndexValue(state, priceOf);
  const startValue = assertIndexValue(state.monthStartValue);
  const summary: GdpIndexMonthSummary = {
    monthKey,
    value: current.value,
    startValue,
    returnRate: startValue > 0 ? current.value / startValue - 1 : 0,
    sampleCount: current.sampleCount,
    valid: state.window.fixedAtMonthStart && current.valid,
    linkedAtMinute: boundaryMinute,
  };

  state.monthStartValue = current.value;
  state.lastClosedValue = current.value;
  state.lastClosedMonthKey = monthKey;
  state.history.push(summary);
  const limit = CITY_ECONOMY_RULES.indexHistoryLimit;
  if (state.history.length > limit) {
    state.history.splice(0, state.history.length - limit);
  }
  return summary;
}

/* ------------------------------------------------------------ 真实事件入口 */

/** 分红：只累计真实每股现金分配；除息造成的价格下调已体现在现价里，不再补偿。 */
export function recordIndexDividend(
  state: GdpIndexState,
  securityId: string,
  cashPerShare: number,
): void {
  if (!Number.isFinite(cashPerShare) || cashPerShare <= 0) return;
  const sample = state.window.samples[securityId];
  if (!sample) return;
  const next = assertIndexValue(sample.cashPerShare + cashPerShare);
  sample.cashPerShare = next;
}

/**
 * 增发摊薄等机械价格调整：参考因子与累计现金同时按 priceAfter / priceBefore 换算。
 *
 * 只缩放价格尺度、不改变已收现金价值；机械事件当刻回报为 0，之后的真实涨跌完整保留。
 * 不接受绝对价差累计（那会把机械下调从后续真实跌幅里减掉）。
 */
export function recordIndexMechanicalShift(
  state: GdpIndexState,
  securityId: string,
  priceBefore: number,
  priceAfter: number,
): void {
  if (
    !Number.isFinite(priceBefore) ||
    !Number.isFinite(priceAfter) ||
    priceBefore <= 0 ||
    priceAfter <= 0
  ) {
    return;
  }
  const sample = state.window.samples[securityId];
  if (!sample) return;
  const ratio = priceAfter / priceBefore;
  const nextFactor = assertIndexValue(sample.referenceFactor * ratio);
  const nextCash = assertIndexValue(sample.cashPerShare * ratio);
  if (nextFactor <= 0) {
    throw new BusinessError('INVALID_INDEX', `证券 ${securityId} 的参考因子被机械事件归零`);
  }
  sample.referenceFactor = nextFactor;
  sample.cashPerShare = nextCash;
}

/** 证券终止（清算）：按真实每股回收值结账，样本保留到窗口结束，不删除跌幅。 */
export function recordIndexTermination(
  state: GdpIndexState,
  securityId: string,
  recoveryPerShare: number,
): void {
  const sample = state.window.samples[securityId];
  if (!sample) return;
  const recovery = assertIndexValue(recoveryPerShare);
  sample.terminated = true;
  sample.recoveryPerShare = recovery;
}

/* ------------------------------------------------------------ 经营产出 */

function cursorOf(state: CityStatisticsState, companyId: string): OutputCursor {
  let cursor = state.output.cursors[companyId];
  if (!cursor) {
    cursor = { outputSeq: 0, settledThroughMinute: 0, baselinePendingCents: 0, totalCents: 0 };
    state.output.cursors[companyId] = cursor;
  }
  return cursor;
}

/**
 * 登记一笔已结算经营产出。
 *
 * 规则：
 *  - `outputSeq` 是本次真实销售结算消耗的企业操作序号（调用方在消耗前取值），
 *    单调高水位防重复：<= 已登记高水位时直接返回 0。零金额调用不推进高水位——
 *    没售出时企业序号尚未消耗，若贸然推进会把同一序号的下一次真实结算当成重复。
 *  - 先扣迁移基线：`baselinePendingCents` 是统计接入前已经发生、尚未结算的产出，
 *    扣除后剩下的继续留给之后的结算/预览递减；只有真正计入本统计的部分才累加。
 *  - 累计值（城市/企业）长期累加，不套用单笔金额上限，但必须是安全整数；
 *    单次登记金额仍用 `assertMoneyRange` 校验。
 *  - `monthCents` 只累计「不早于当前统计窗口」的登记：月界当刻结清的旧区间由调用方
 *    按企业 accrual 月份传入旧月，正好在快照之后才滚动；晚于窗口的登记也先计入当前
 *    窗口（快照在滚动之前），避免同一笔产出在两个月份都缺失。
 */
export function registerOutput(
  state: CityStatisticsState,
  input: {
    companyId: string;
    outputSeq: number;
    atMinute: number;
    monthKey: string;
    amountCents: number;
  },
): number {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0) {
    throw new BusinessError('INVALID_AMOUNT', '已结算经营产出必须是非负整数（分）');
  }
  assertMinute(input.atMinute, '产出结算时刻');
  assertMonthKey(input.monthKey);
  if (!Number.isSafeInteger(input.outputSeq) || input.outputSeq <= 0) {
    throw new BusinessError('INVALID_OPERATION_SEQ', '企业操作序号必须是正整数');
  }

  const cursor = cursorOf(state, input.companyId);

  if (input.amountCents === 0) {
    // 没有任何真实产出：只推进结算游标，不推进序号高水位（序号可能尚未被消耗）
    cursor.settledThroughMinute = Math.max(cursor.settledThroughMinute, input.atMinute);
    return 0;
  }
  assertMoneyRange(input.amountCents, '单次已结算经营产出');
  if (input.outputSeq <= cursor.outputSeq) return 0;

  cursor.outputSeq = input.outputSeq;
  cursor.settledThroughMinute = Math.max(cursor.settledThroughMinute, input.atMinute);

  const deducted = Math.min(cursor.baselinePendingCents, input.amountCents);
  const counted = input.amountCents - deducted;
  cursor.baselinePendingCents -= deducted;

  cursor.totalCents = addAggregate(cursor.totalCents, counted, '企业累计产出');
  state.output.cumulativeCents = addAggregate(
    state.output.cumulativeCents,
    counted,
    '城市累计经营产出',
  );

  // 早于当前窗口的登记（例如滚动后才补登旧月）只计入累计，不污染本月增量与行业拆分
  if (state.output.monthKey === '' || input.monthKey >= state.output.monthKey) {
    state.output.monthCents = addAggregate(state.output.monthCents, counted, '本月经营产出');
    state.output.byCompany[input.companyId] = addAggregate(
      state.output.byCompany[input.companyId] ?? 0,
      counted,
      '企业本月经营产出',
    );
  }
  return counted;
}

/**
 * 本月新增产出的月份滚动：调用方必须在**旧月快照固化之后**、开启新月份观察窗口时调用。
 * 同一月份重复调用是幂等的；不允许向前回退。
 */
export function rollOutputMonth(state: CityStatisticsState, monthKey: string): void {
  assertMonthKey(monthKey);
  if (state.output.monthKey === monthKey) return;
  if (monthKey < state.output.monthKey) {
    throw new BusinessError('INVALID_MONTH_KEY', '月份滚动不能回退');
  }
  state.output.monthKey = monthKey;
  state.output.monthCents = 0;
  state.output.byCompany = {};
}

/** 追加快照：同一月份只保留一条（幂等），超出配置上限时丢弃最旧的。 */
export function pushMonthSnapshot(state: CityStatisticsState, snapshot: CityMonthSnapshot): void {
  if (state.months.some((item) => item.monthKey === snapshot.monthKey)) return;
  state.months.push(snapshot);
  const limit = CITY_ECONOMY_RULES.monthSnapshotLimit;
  if (state.months.length > limit) {
    state.months.splice(0, state.months.length - limit);
  }
}

/**
 * 迁移/实时预览用：给某企业登记「已发生但尚未结算」的产出基线。
 *
 * 只登记一次（已有非零值时直接返回，不覆盖）；之后的真实结算与实时预览都会先扣这部分，
 * 因此迁移前的产出不会被当成统计接入后的新增产出。金额仍是单次结算口径。
 */
export function setBaselinePending(
  state: CityStatisticsState,
  companyId: string,
  cents: number,
  atMinute: number,
): void {
  assertMinute(atMinute, '基线登记时刻');
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new BusinessError('INVALID_AMOUNT', '待结算基线必须是非负整数（分）');
  }
  if (cents === 0) return;
  assertMoneyRange(cents, '迁移待结算基线');
  const cursor = cursorOf(state, companyId);
  if (cursor.baselinePendingCents > 0) return;
  cursor.baselinePendingCents = cents;
  cursor.settledThroughMinute = Math.max(cursor.settledThroughMinute, atMinute);
}
