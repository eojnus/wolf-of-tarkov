/**
 * 证券数据 → 城市连续指数的适配层（app）。
 *
 * 只做三件事：
 *  - 在月界把**当前证券权威数据**（现价、终止标记）换算成指数窗口样本；
 *  - 把真实资本事件（分红、增发摊薄、清算回收）转交给指数窗口登记；
 *  - 用证券权威现价读取实时指数。
 *
 * 边界：
 *  - 指数是**独立观察窗口**：与人口月结的证券窗口用途不同，不共用可变数据，
 *    也不修改 features/population 的任何字段；
 *  - 本文件不制造价格、不写证券行情：真实涨跌来自行情与交易，机械调价来自资本操作；
 *  - 不建立第二套时钟：时间全部来自调用方传入的游戏分钟。
 */

import {
  beginIndexMonth,
  currentIndexValue,
  finalizeIndexMonth,
  recordIndexDividend,
  recordIndexMechanicalShift,
  recordIndexTermination,
  type GdpIndexSample,
} from '../features/city-statistics';
import { marketOf, metaOf } from '../features/stock';
import type { GameState, ReadonlyGameState } from './state';

/** 证券权威现价读取器；缺失行情返回 NaN，由指数模块按「无效样本」跳过。 */
function cityPriceOf(state: ReadonlyGameState): (securityId: string) => number {
  return (securityId) => marketOf(state.securities, securityId)?.price ?? Number.NaN;
}

/**
 * 新月份：从当前证券权威数据重建本窗口样本（固定样本）。
 *
 * - 只纳入当时存在且未终止的证券（含独立标的与正常上市企业证券）；
 * - 已终止/清算的不再进入新窗口，月中新上市的公司下个月才加入；
 * - 窗口起点价取当前公开现价，窗口内的分红与机械调价由真实事件入口登记。
 */
export function beginCityIndexMonth(draft: GameState, monthKey: string, minute: number): void {
  const samples: Record<string, GdpIndexSample> = {};
  for (const [securityId, market] of Object.entries(draft.securities.markets)) {
    const meta = metaOf(draft.securities, securityId);
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
  beginIndexMonth(draft.cityStatistics.index, monthKey, minute, samples);
}

/**
 * 月底固化（幂等由 features 保证）。
 * 必须在人口市场窗口重置之前调用，不能先重置丢掉本月涨跌。
 */
export function finalizeCityIndexMonth(
  draft: GameState,
  monthKey: string,
  boundaryMinute: number,
): void {
  finalizeIndexMonth(draft.cityStatistics.index, monthKey, boundaryMinute, cityPriceOf(draft));
}

/** 真实事件入口：分红累计每股现金（除息已体现在现价里，不再补偿）。 */
export function recordCityDividend(
  state: GameState,
  securityId: string,
  cashPerShare: number,
): void {
  recordIndexDividend(state.cityStatistics.index, securityId, cashPerShare);
}

/** 真实事件入口：增发等机械调价（priceBefore / priceAfter 为公开市场价）。 */
export function recordCityMechanicalShift(
  state: GameState,
  securityId: string,
  priceBefore: number,
  priceAfter: number,
): void {
  recordIndexMechanicalShift(state.cityStatistics.index, securityId, priceBefore, priceAfter);
}

/** 真实事件入口：清算终止时的真实每股回收值（样本保留到窗口结束）。 */
export function recordCityTermination(
  state: GameState,
  securityId: string,
  recoveryPerShare: number,
): void {
  recordIndexTermination(state.cityStatistics.index, securityId, recoveryPerShare);
}

/** 实时指数（读取证券权威现价）。无有效样本时保持已有指数并标记 valid=false。 */
export function currentCityIndex(state: ReadonlyGameState): {
  value: number;
  sampleCount: number;
  valid: boolean;
} {
  return currentIndexValue(state.cityStatistics.index, cityPriceOf(state));
}
