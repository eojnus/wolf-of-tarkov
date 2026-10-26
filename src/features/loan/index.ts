/**
 * 贷款模块 —— 单合同个人贷款：放款、单利按分钟计提、部分/全部还款、到期自动扣款。
 *
 * 职责边界：
 *  - 只维护合同状态与计息规则，不直接改账户余额；资金流动一律通过财务公开接口。
 *  - 同时最多一份未结清合同；结清后可再次申请。
 *  - 单利、按实际未偿本金计提；不足一分的利息以整数余量累积，分段推进不改变结果。
 *  - 还款先息后本；不允许透支还款、不自动续贷、不借新还旧、不触发破产。
 *  - 逾期只是状态，不产生罚息，计息规则不变。
 */

import { BusinessError } from '../../core/errors';
import { assertMoneyRange, safeAddMoney } from '../../core/money';
import { CALENDAR, LOAN } from '../../content/config';
import {
  externalAccount,
  payFromSavings,
  receiveToSavings,
  type FinanceState,
  type PostingContext,
} from '../finance';

export type LoanStatus = 'active' | 'overdue' | 'settled';

export interface LoanContract {
  /** 原始本金（分）。 */
  principal: number;
  /** 未偿本金（分）。 */
  outstanding: number;
  /** 已计提未付利息（分）。 */
  accruedInterest: number;
  /** 计息余量（分·分钟），避免分段反复取整改变累计结果。 */
  interestNumerator: number;
  /** 累计已付利息（分）。 */
  totalInterestPaid: number;
  /** 累计已付本金（分）。 */
  totalPrincipalPaid: number;
  startMinute: number;
  dueMinute: number;
  status: LoanStatus;
}

export interface LoanState {
  contract: LoanContract | null;
}

export const LOAN_STATUS_LABELS: Record<LoanStatus, string> = {
  active: '正常',
  overdue: '已逾期',
  settled: '已结清',
};

export function createLoanState(): LoanState {
  return { contract: null };
}

/** 一次计息的分母：使「未偿本金 × 分钟 ÷ 分母」等于应计利息（分）。 */
export function interestDenominator(): number {
  return Math.round((LOAN.termDays * CALENDAR.minutesPerDay) / LOAN.interestRatePerTerm);
}

export function totalOwed(contract: LoanContract): number {
  return contract.outstanding + contract.accruedInterest;
}

export function hasOpenLoan(state: LoanState): boolean {
  return state.contract !== null && state.contract.status !== 'settled';
}

export function remainingDays(contract: LoanContract, nowMinute: number): number {
  const rest = contract.dueMinute - nowMinute;
  if (rest <= 0) return 0;
  return Math.ceil(rest / CALENDAR.minutesPerDay);
}

/* ---------------------------------------------------------------- 借款 */

export interface LoanContext extends PostingContext {
  readonly operationId: string;
}

export function borrow(
  state: LoanState,
  finance: FinanceState,
  amountCents: number,
  ctx: LoanContext,
): LoanContract {
  if (hasOpenLoan(state)) {
    throw new BusinessError('LOAN_EXISTS', '已有未结清贷款，请先还清后再申请');
  }
  assertMoneyRange(amountCents, '借款金额');
  if (amountCents < LOAN.minPrincipalCents) {
    throw new BusinessError('LOAN_TOO_SMALL', `借款金额不能低于 ${LOAN.minPrincipalCents / 100} 元`);
  }
  if (amountCents > LOAN.maxPrincipalCents) {
    throw new BusinessError('LOAN_TOO_LARGE', `借款金额不能超过 ${LOAN.maxPrincipalCents / 100} 元`);
  }

  receiveToSavings(finance, {
    operationId: ctx.operationId,
    amount: amountCents,
    category: 'loan-drawdown',
    memo: `贷款放款 ${(amountCents / 100).toFixed(0)} 元`,
    from: externalAccount('lender'),
    atMinute: ctx.atMinute,
    monthKey: ctx.monthKey,
  });

  const contract: LoanContract = {
    principal: amountCents,
    outstanding: amountCents,
    accruedInterest: 0,
    interestNumerator: 0,
    totalInterestPaid: 0,
    totalPrincipalPaid: 0,
    startMinute: ctx.atMinute,
    dueMinute: ctx.atMinute + LOAN.termDays * CALENDAR.minutesPerDay,
    status: 'active',
  };
  state.contract = contract;
  return contract;
}

/* ---------------------------------------------------------------- 计息 */

/**
 * 按经过的游戏分钟计提单利。返回本次新增利息（分）。
 * 调用方保证每段时间只调用一次，因此不会重复计提。
 */
export function accrueInterest(state: LoanState, minutes: number): number {
  const contract = state.contract;
  if (!contract) return 0;
  if (contract.status === 'settled') return 0;
  if (contract.outstanding <= 0) return 0;
  if (!Number.isSafeInteger(minutes) || minutes <= 0) return 0;

  const denominator = interestDenominator();
  contract.interestNumerator += contract.outstanding * minutes;
  const earned = Math.floor(contract.interestNumerator / denominator);
  if (earned > 0) {
    contract.interestNumerator -= earned * denominator;
    contract.accruedInterest = safeAddMoney(contract.accruedInterest, earned, '已计提利息');
  }
  return earned;
}

/* ---------------------------------------------------------------- 还款 */

export interface RepayResult {
  readonly interestPaid: number;
  readonly principalPaid: number;
  readonly settled: boolean;
}

/** 先息后本，两步支付共享同一个操作前缀。存款不足时整体拒绝，不透支。 */
function payInstallment(
  contract: LoanContract,
  finance: FinanceState,
  amountCents: number,
  ctx: LoanContext,
): RepayResult {
  if (amountCents <= 0) {
    throw new BusinessError('INVALID_AMOUNT', '还款金额必须大于 0');
  }
  if (finance.accounts.savings < amountCents) {
    throw new BusinessError('INSUFFICIENT_SAVINGS', '银行存款不足，无法还款');
  }
  const owed = totalOwed(contract);
  if (amountCents > owed) {
    throw new BusinessError('OVERPAYMENT', '还款金额超过待还总额');
  }

  const interestPaid = Math.min(amountCents, contract.accruedInterest);
  if (interestPaid > 0) {
    payFromSavings(finance, {
      operationId: `${ctx.operationId}:interest`,
      amount: interestPaid,
      category: 'loan-interest',
      memo: '偿还贷款利息',
      to: externalAccount('lender'),
      atMinute: ctx.atMinute,
      monthKey: ctx.monthKey,
    });
    contract.accruedInterest -= interestPaid;
    contract.totalInterestPaid = safeAddMoney(contract.totalInterestPaid, interestPaid, '已付利息');
  }

  const principalPaid = Math.min(amountCents - interestPaid, contract.outstanding);
  if (principalPaid > 0) {
    payFromSavings(finance, {
      operationId: `${ctx.operationId}:principal`,
      amount: principalPaid,
      category: 'loan-principal',
      memo: '偿还贷款本金',
      to: externalAccount('lender'),
      atMinute: ctx.atMinute,
      monthKey: ctx.monthKey,
    });
    contract.outstanding -= principalPaid;
    contract.totalPrincipalPaid = safeAddMoney(
      contract.totalPrincipalPaid,
      principalPaid,
      '已付本金',
    );
  }

  const settled = contract.outstanding === 0 && contract.accruedInterest === 0;
  if (settled) contract.status = 'settled';
  return { interestPaid, principalPaid, settled };
}

/** 玩家主动还款（部分或全部）。 */
export function repay(
  state: LoanState,
  finance: FinanceState,
  amountCents: number,
  ctx: LoanContext,
): RepayResult {
  const contract = state.contract;
  if (!contract || contract.status === 'settled') {
    throw new BusinessError('NO_LOAN', '当前没有未结清的贷款');
  }
  return payInstallment(contract, finance, amountCents, ctx);
}

/**
 * 到期自动扣款：从银行存款按「先息后本」尽力偿还，付不出部分保持欠款并标记逾期。
 * 只在合同处于 active 且已到期时执行一次；逾期不再重复自动扣款。
 */
export function settleDue(
  state: LoanState,
  finance: FinanceState,
  ctx: LoanContext,
  nowMinute: number,
): RepayResult | null {
  const contract = state.contract;
  if (!contract) return null;
  if (contract.status !== 'active') return null;
  if (contract.dueMinute > nowMinute) return null;

  const payable = Math.min(totalOwed(contract), finance.accounts.savings);
  if (payable <= 0) {
    contract.status = 'overdue';
    return { interestPaid: 0, principalPaid: 0, settled: false };
  }

  const result = payInstallment(contract, finance, payable, ctx);
  if (!result.settled) contract.status = 'overdue';
  return result;
}
