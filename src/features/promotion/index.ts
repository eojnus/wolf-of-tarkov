/**
 * 投资者宣传 —— 有成本、有失败率、有时限的市场预期操作。
 *
 * 规则：
 *  - 使用公司资金，成本无论成败都支付，作为独立的宣传费用记入流水；
 *  - 20% 失败率，结果在提交时一次性固定（随机状态可保存，读档不重抽）；
 *  - 成功产生有期限、逐步衰减的估值溢价，失败不产生正向效果，也不额外暴跌；
 *  - 同一公司同时只能有一个有效宣传，进行中不能叠加；
 *  - 使用独立随机序列，不消耗股票价格的随机状态。
 */

import type { DeepReadonly } from '../../core/readonly';
import { BusinessError } from '../../core/errors';
import { PROMOTION_RULES } from '../../content/capital';

export type PromotionOutcome = 'success' | 'failure';

export interface PromotionRecord {
  active: boolean;
  startMinute: number;
  expireMinute: number;
  /** 成功时的溢价强度（0～maxBoostPct）。 */
  strength: number;
  lastOutcome: PromotionOutcome | null;
  lastAttemptMinute: number | null;
  lastBudgetCents: number;
}

export interface PromotionState {
  byCompany: Record<string, PromotionRecord>;
  /** 独立 32 位随机状态，与行情随机序列完全分开。 */
  rng: number;
}

export function createPromotionState(): PromotionState {
  return { byCompany: {}, rng: 0x5eed1234 };
}

function nextRandom(state: { rng: number }): number {
  let t = (state.rng = (state.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function recordOf(state: PromotionState, companyId: string): PromotionRecord | null;
export function recordOf(
  state: DeepReadonly<PromotionState>,
  companyId: string,
): DeepReadonly<PromotionRecord> | null;
export function recordOf(
  state: PromotionState | DeepReadonly<PromotionState>,
  companyId: string,
): PromotionRecord | DeepReadonly<PromotionRecord> | null {
  return state.byCompany[companyId] ?? null;
}

/** 是否还有未结束的宣传（有效期内即视为进行中）。 */
export function isPromotionActive(
  state: PromotionState | DeepReadonly<PromotionState>,
  companyId: string,
  nowMinute: number,
): boolean {
  const record = state.byCompany[companyId];
  if (!record || !record.active) return false;
  return nowMinute < record.expireMinute;
}

export function validateBudget(budgetCents: number): void {
  if (!Number.isSafeInteger(budgetCents)) {
    throw new BusinessError('INVALID_AMOUNT', '宣传预算必须是整数（分）');
  }
  if (budgetCents < PROMOTION_RULES.minCents || budgetCents > PROMOTION_RULES.maxCents) {
    throw new BusinessError(
      'INVALID_AMOUNT',
      `宣传预算需在 ${(PROMOTION_RULES.minCents / 100).toFixed(0)} ～ ${(
        PROMOTION_RULES.maxCents / 100
      ).toFixed(0)} 元之间`,
    );
  }
}

/** 预算对应的溢价强度：边际收益递减，最多接近上限。 */
export function strengthOf(budgetCents: number): number {
  const ratio = budgetCents / (budgetCents + PROMOTION_RULES.referenceBudgetCents);
  return PROMOTION_RULES.maxBoostPct * ratio;
}

/**
 * 掷一次结果并写入状态。调用方必须先扣款（费用无论成败都支付）。
 * 这里只写宣传记录，不改资金、不改利润。
 */
export function rollPromotion(
  state: PromotionState,
  companyId: string,
  budgetCents: number,
  nowMinute: number,
): PromotionRecord {
  const roll = nextRandom(state);
  const success = roll >= PROMOTION_RULES.failRate;
  const record: PromotionRecord = {
    active: success,
    startMinute: nowMinute,
    expireMinute: success ? nowMinute + PROMOTION_RULES.durationDays * 1440 : nowMinute,
    strength: success ? strengthOf(budgetCents) : 0,
    lastOutcome: success ? 'success' : 'failure',
    lastAttemptMinute: nowMinute,
    lastBudgetCents: budgetCents,
  };
  state.byCompany[companyId] = record;
  return record;
}

/** 过期后把 active 置回 false，避免界面一直显示「进行中」。 */
export function expirePromotion(
  state: PromotionState,
  companyId: string,
  nowMinute: number,
): void {
  const record = state.byCompany[companyId];
  if (!record || !record.active) return;
  if (nowMinute >= record.expireMinute) record.active = false;
}
