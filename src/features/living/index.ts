/**
 * 居住与生活模块 —— 房租、基本生活费与生活欠款。
 *
 * 职责边界：
 *  - 只负责「每月应缴多少」「欠了多少」，不碰账户余额。
 *  - 实际扣款由应用层在月度结算中调用财务公开接口完成；扣不上的部分回写为欠款。
 *  - 首版不做驱逐、破产或游戏结束。
 */

import { BusinessError } from '../../core/errors';
import { assertMoneyRange, safeAddMoney } from '../../core/money';
import { ECONOMY } from '../../content/config';

export type DebtReason = 'rent' | 'living' | 'settlement';

export const DEBT_REASON_LABELS: Record<DebtReason, string> = {
  rent: '房租欠款',
  living: '生活费欠款',
  settlement: '月结欠款',
};

export interface DebtRecord {
  readonly monthKey: string;
  readonly amount: number;
  readonly reason: DebtReason;
}

export interface LivingState {
  /** 生活欠款总额（分）。净资产中计为负债。 */
  debt: number;
  /** 欠款形成记录，按时间追加。 */
  debtRecords: DebtRecord[];
}

export interface MonthCharge {
  readonly rent: number;
  readonly living: number;
  readonly total: number;
}

export function createLivingState(): LivingState {
  return { debt: 0, debtRecords: [] };
}

/**
 * 每月应缴金额 —— **唯一报价口径**（月结与界面都从这里取）。
 *
 * `rentExempt` 表示玩家已拥有永久免费居住权：此时房租为 0，基本生活费照常。
 * 免租必须在**报价**环节生效，不能靠事后返款或直接改余额实现，否则月报、欠款与流水会互相矛盾。
 */
export function quoteMonth(options: { readonly rentExempt?: boolean } = {}): MonthCharge {
  const rent = options.rentExempt === true ? 0 : ECONOMY.rentCents;
  const living = ECONOMY.livingCostCents;
  return { rent, living, total: rent + living };
}

/** 增加欠款（新的费用付不出时调用）。 */
export function addDebt(
  state: LivingState,
  monthKey: string,
  amount: number,
  reason: DebtReason,
): void {
  if (amount <= 0) return;
  assertMoneyRange(amount, '欠款金额');
  state.debt = safeAddMoney(state.debt, amount, '生活欠款');
  state.debtRecords.push({ monthKey, amount, reason });
}

/**
 * 减少欠款，返回实际减少额。
 * 调用方必须先扣款成功，这里只做账务登记，不产生资金流动。
 */
export function reduceDebt(state: LivingState, amount: number): number {
  if (amount <= 0) return 0;
  const applied = Math.min(state.debt, amount);
  if (applied <= 0) return 0;
  state.debt -= applied;
  return applied;
}

/** 本月最多能偿还多少（受可用资金与欠款双重限制）。 */
export function maxRepayable(debt: number, availableFunds: number): number {
  return Math.max(0, Math.min(debt, availableFunds));
}

export function assertDebtConsistent(state: LivingState): void {
  if (!Number.isSafeInteger(state.debt) || state.debt < 0) {
    throw new BusinessError('INVALID_DEBT', '生活欠款数据异常');
  }
}
