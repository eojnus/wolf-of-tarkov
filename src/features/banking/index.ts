/**
 * 银行业务模块 —— 个人现金与银行存款之间的存取款规则。
 *
 * 职责边界：只做规则校验（金额范围、单笔上下限、余额充足），
 * 实际资金移动一律通过财务模块的公开接口完成。本模块不持有状态。
 */

import { BusinessError } from '../../core/errors';
import { assertMoneyRange, formatMoneyCompact } from '../../core/money';
import { ECONOMY } from '../../content/config';
import {
  transferCashToSavings,
  transferSavingsToCash,
  type FinanceState,
  type LedgerEntry,
  type PostingContext,
} from '../finance';

export interface BankingRequest extends PostingContext {
  /** 金额（分）。 */
  readonly amount: number;
  /** 业务操作唯一标识，由命令层生成。 */
  readonly operationId: string;
}

function assertTransferAmount(amount: number): void {
  assertMoneyRange(amount);
  if (amount < ECONOMY.minimumTransferCents) {
    throw new BusinessError('AMOUNT_TOO_SMALL', `单笔金额不能低于 ${ECONOMY.minimumTransferCents / 100} 元`);
  }
  if (amount > ECONOMY.maximumTransferCents) {
    throw new BusinessError('AMOUNT_TOO_LARGE', `单笔金额不能超过 ${ECONOMY.maximumTransferCents / 100} 元`);
  }
}

/** 存款：现金 → 银行存款。 */
export function depositToSavings(state: FinanceState, request: BankingRequest): LedgerEntry {
  assertTransferAmount(request.amount);
  if (state.accounts.cash < request.amount) {
    throw new BusinessError('INSUFFICIENT_CASH', '现金不足，无法完成存款');
  }
  return transferCashToSavings(state, {
    operationId: request.operationId,
    amount: request.amount,
    atMinute: request.atMinute,
    monthKey: request.monthKey,
    memo: `存入银行 ${formatMoneyCompact(request.amount)}`,
  });
}

/** 取款：银行存款 → 现金。 */
export function withdrawToCash(state: FinanceState, request: BankingRequest): LedgerEntry {
  assertTransferAmount(request.amount);
  if (state.accounts.savings < request.amount) {
    throw new BusinessError('INSUFFICIENT_SAVINGS', '银行存款不足，无法完成取款');
  }
  return transferSavingsToCash(state, {
    operationId: request.operationId,
    amount: request.amount,
    atMinute: request.atMinute,
    monthKey: request.monthKey,
    memo: `银行取现 ${formatMoneyCompact(request.amount)}`,
  });
}
