/**
 * 证券市场 → 人口系统的适配层。
 *
 * 只做一件事：把证券市场的真实月度表现换算成人口系统能用的摘要
 * （等权月回报 R、涨跌覆盖比例），并且**修正机械价格变化**：
 *  - 增发摊薄导致的价格下调是机械重算，不是财富损失 → 按价格比例累乘参考因子；
 *  - 分红除息会下调价格，但股东真实拿到现金 → 只累计每股现金分配，不额外加除息偏移；
 *  - 清算终止按**真实每股回收价值**计算，不一律当归零；
 *  - 交易、回购、产品发布与经营行情引起的价格变化是真实回报，不修正。
 *
 * 参考财富口径（唯一）：
 *   参考基准 = 月初价格 × Π(机械事件后价格 / 机械事件前价格)
 *   累计现金 = Σ 每次分红金额 × 该笔分红之后所有机械事件的价格比例
 *              （即累计现金随机械事件换算到**当前价格尺度**）
 *   月回报   = (期末价值 + 累计现金) / 参考基准 − 1
 *
 * 累计现金必须和参考基准使用同一尺度：机械事件只改变每股价格尺度，
 * 不改变已经收到的现金价值；若不换算，则「先分红、后增发」会把同一笔
 * 现金在缩小后的参考基准上重复放大（10 万本金、分红 20、增发后 50，
 * 会得到 +20% 的虚假收益，正确是 0%）。机械事件当刻「(当前价 + 现金) ÷ 参考基准」
 * 连续，所以事件本身贡献 0 回报，之后的真实涨跌完整保留。
 *
 * 样本规则：
 *  - 月初固定样本：当时存在且未终止的证券（含独立标的与正常上市企业证券）；
 *  - 月中上市 → 下月才加入样本；
 *  - 月中终止 → 仍保留在本月样本中，损失不会被删掉；
 *  - 不从可能被截断的价格历史反推整月回报。
 */

import { POPULATION_RULES } from '../content/population';
import type { MarketMonthSummary, PopulationState } from '../features/population';
import { marketOf } from '../features/stock';
import type { GameState } from './state';

function windowOf(state: GameState): PopulationState['marketWindow'] {
  return state.population.marketWindow;
}

/** 新月份开始：固定本月样本与月初基准价。 */
export function beginMarketMonth(state: GameState, monthKey: string, minute: number): void {
  const window = windowOf(state);
  window.monthKey = monthKey;
  window.fixedAtMinute = minute;
  window.fixedAtMonthStart = true;
  const samples: PopulationState['marketWindow']['samples'] = {};
  for (const [securityId, market] of Object.entries(state.securities.markets)) {
    const meta = state.securities.meta[securityId];
    if (!meta) continue;
    if (meta.terminatedAtMinute !== null) continue;
    samples[securityId] = {
      securityId,
      baselinePrice: market.price,
      cashPerShare: 0,
      referenceFactor: 1,
      terminated: false,
      recoveryPerShare: null,
    };
  }
  window.samples = samples;
}

/**
 * 结束月份：按调整后价值计算每份样本的月回报，汇总为市场摘要。
 * 窗口不是固定在月初（例如旧档迁移后的第一个不完整月）时返回无效摘要，
 * 人口系统据此保持股市影响中性。
 */
export function finalizeMarketMonth(state: GameState): MarketMonthSummary {
  const window = windowOf(state);
  if (!window.fixedAtMonthStart) {
    return { returnRate: 0, downRatio: 0, upRatio: 0, valid: false };
  }
  const returns: number[] = [];
  for (const sample of Object.values(window.samples)) {
    const referenceBaseline = sample.baselinePrice * sample.referenceFactor;
    if (!(referenceBaseline > 0)) continue;
    const market = marketOf(state.securities, sample.securityId);
    const currentValue = sample.terminated
      ? (sample.recoveryPerShare ?? 0)
      : (market ? market.price : sample.baselinePrice);
    // 分红现金必须保留：清算时也不能和股价损失一起被抹掉。
    // cashPerShare 已在每次机械事件时换算到当前价格尺度，与 referenceBaseline 同尺度。
    const adjusted = currentValue + sample.cashPerShare;
    if (!Number.isFinite(adjusted)) continue;
    returns.push(adjusted / referenceBaseline - 1);
  }
  if (returns.length === 0) {
    return { returnRate: 0, downRatio: 0, upRatio: 0, valid: false };
  }
  const sum = returns.reduce((acc, value) => acc + value, 0);
  const down = returns.filter((value) => value < 0).length;
  const up = returns.filter((value) => value > 0).length;
  const summary: MarketMonthSummary = {
    returnRate: sum / returns.length,
    downRatio: down / returns.length,
    upRatio: up / returns.length,
    valid: true,
  };
  window.history.push(summary);
  if (window.history.length > POPULATION_RULES.historyLimit) {
    window.history.splice(0, window.history.length - POPULATION_RULES.historyLimit);
  }
  return summary;
}

/** 分红：累计每股现金分配（除息造成的价格下调不再另记偏移，避免重复补偿）。 */
export function recordCashDistribution(
  state: GameState,
  securityId: string,
  cashPerShare: number,
): void {
  if (!(cashPerShare > 0)) return;
  const sample = windowOf(state).samples[securityId];
  if (!sample) return;
  sample.cashPerShare += cashPerShare;
}

/**
 * 机械价格调整（增发摊薄等）：按事件前后的价格比例累乘参考因子。
 *
 * 机械事件当刻「当前价 ÷ 参考基准」保持不变，因此事件本身回报为 0；
 * 之后真实下跌（例如 50 → 25）会完整反映为 −50%，不会被机械下调抵消。
 * 不接受绝对价差累计：绝对偏移会在后续真实下跌时把跌幅减掉。
 *
 * 累计分红现金也按同一比例换算到事件后的价格尺度：
 * 机械事件只改变每股价格尺度，不改变已收现金的价值。若只缩放参考基准、
 * 不缩放现金，则「分红后增发」会把同一笔现金重复放大，产生虚假正收益。
 */
export function recordMechanicalPriceShift(
  state: GameState,
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
  const sample = windowOf(state).samples[securityId];
  if (!sample) return;
  const ratio = priceAfter / priceBefore;
  sample.referenceFactor *= ratio;
  sample.cashPerShare *= ratio;
}

/** 证券终止（清算）：按真实每股回收价值结账，样本保留到本月底。 */
export function recordTermination(
  state: GameState,
  securityId: string,
  recoveryPerShare: number,
): void {
  const sample = windowOf(state).samples[securityId];
  if (!sample) return;
  sample.terminated = true;
  sample.recoveryPerShare = Math.max(0, recoveryPerShare);
}

/** 只读查询：当前窗口的样本数量（界面提示用）。 */
export function sampleCountOf(state: GameState): number {
  return Object.keys(windowOf(state).samples).length;
}
