/**
 * 市场模块 —— 纯计算：把「群体偏好 + 产品快照」换算成品质分数与销售速度。
 *
 * 本模块不持有 GameState、不改任何账户、不读企业内部数据，也不产生随机数。
 * 因此同一组输入在任何时刻、任何入口都得到相同结果。
 *
 * 本轮显式不含：价格敏感度、竞争份额、供货上限、消费者钱包耗尽。
 * 售价只影响收入，不影响销量；界面必须如实说明这一点。
 */

import { PRODUCT_MARKET } from '../../content/business';

export interface AttributeScores {
  readonly performance: number;
  readonly reliability: number;
  readonly usability: number;
}

/** 市场只需要这两个字段，不需要知道群体还有哪些属性。 */
export interface PreferenceGroup {
  readonly weight: number;
  readonly preferences: AttributeScores;
}

export interface SaleInput {
  readonly groups: readonly PreferenceGroup[];
  readonly attributes: AttributeScores;
  /** 当前有效的每日营销预算（分）。 */
  readonly marketingDailyCents: number;
  /** 代际系数：当前新款为 1，每落后一代乘 generationDecay。 */
  readonly generationFactor: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 品质分数 Q（0～100）= Σ 群体权重 × 该群体对三项属性的加权分。
 * 属性与偏好都按 0～100 / 合计为 1 表达，权重合计不为 1 时按实测合计归一化。
 */
export function qualityOf(
  groups: readonly PreferenceGroup[],
  attributes: AttributeScores,
): number {
  let weighted = 0;
  let weightSum = 0;
  for (const group of groups) {
    const pref = group.preferences;
    const prefSum = pref.performance + pref.reliability + pref.usability;
    if (prefSum <= 0 || group.weight <= 0) continue;
    const score =
      (attributes.performance * pref.performance +
        attributes.reliability * pref.reliability +
        attributes.usability * pref.usability) /
      prefSum;
    weighted += group.weight * score;
    weightSum += group.weight;
  }
  if (weightSum <= 0) return 0;
  return clamp(weighted / weightSum, 0, 100);
}

/** 营销系数：1 + M/(M+参考预算)，范围 [1, 2)，边际收益递减。 */
export function marketingFactor(marketingDailyCents: number): number {
  const budget = clamp(marketingDailyCents, 0, PRODUCT_MARKET.maxMarketingDailyCents);
  if (budget <= 0) return 1;
  return 1 + budget / (budget + PRODUCT_MARKET.marketingReferenceDailyCents);
}

/**
 * 日销售速度（件/游戏日，带小数）：
 *   基础日销量 × (Q / 50)² × 营销系数 × 代际系数
 * 不设上限也不设下限（Q 为 0 时销量为 0）。
 */
export function dailyUnits(input: SaleInput): number {
  return estimateSales(input).dailyUnits;
}

export interface SaleEstimate {
  readonly quality: number;
  readonly dailyUnits: number;
  readonly marketingFactor: number;
}

/** 组合计算，供视图与结算复用同一口径。 */
export function estimateSales(input: SaleInput): SaleEstimate {
  const quality = clamp(qualityOf(input.groups, input.attributes), 0, 100);
  const ratio = quality / PRODUCT_MARKET.qualityReference;
  const factor = marketingFactor(input.marketingDailyCents);
  const units =
    PRODUCT_MARKET.baseDailyUnits * ratio * ratio * factor * Math.max(0, input.generationFactor);
  return { quality, dailyUnits: units, marketingFactor: factor };
}
