/**
 * 月度结算 —— 应用层组织的固定结算顺序。
 *
 * 顺序显式写在本函数里，不依赖事件监听器注册顺序：
 *   1. 结清刚结束月份的工资应计
 *   2. 发放工资（外部 → 现金）
 *   3. 用可用资金偿付此前欠款
 *   4. 生成并支付该月房租与基本生活费
 *   5. 不足部分形成欠款
 *   6. 生成月报并记录已结算月份
 *   7. 由调用方整体提交状态并请求自动保存
 *
 * 整个过程运行在一次状态提交的草稿上，任一步抛错都会让整次推进回滚，
 * 不会留下「发了工资但没扣房租」的中间状态。
 */

import type { MonthBoundaryInfo } from '../core/clock';
import { BusinessError } from '../core/errors';
import { closeMonth } from '../features/employment';
import {
  externalAccount,
  monthlyTotals,
  payFromPersonal,
  personalTotal,
  receiveIncome,
} from '../features/finance';
import { addDebt, maxRepayable, quoteMonth, reduceDebt } from '../features/living';
import type { GameState, MonthReport } from './state';
import { trimReports } from './state';

export function settleMonth(state: GameState, info: MonthBoundaryInfo): MonthReport {
  const { monthKey, boundaryMinute } = info;

  if (state.settlement.settledMonths.includes(monthKey)) {
    throw new BusinessError('MONTH_ALREADY_SETTLED', `${monthKey} 已经结算过，不能重复结算`);
  }

  const ctx = { atMinute: boundaryMinute, monthKey };

  // 1. 结清工资应计
  const wagesDue = closeMonth(state.employment, monthKey);

  // 2. 发放工资
  if (wagesDue > 0) {
    receiveIncome(state.finance, {
      ...ctx,
      operationId: `salary:${monthKey}`,
      amount: wagesDue,
      category: 'salary',
      memo: `${monthKey} 工资`,
      from: externalAccount('employer'),
    });
  }

  // 3. 偿付此前欠款（发薪之后、新增费用之前）
  let debtRepaid = 0;
  const available = personalTotal(state.finance);
  const repayPlan = maxRepayable(state.living.debt, available);
  if (repayPlan > 0) {
    const result = payFromPersonal(state.finance, {
      ...ctx,
      operationId: `debt:${monthKey}`,
      amount: repayPlan,
      category: 'debt-repayment',
      memo: '偿还生活欠款',
      to: externalAccount('creditor'),
    });
    debtRepaid = reduceDebt(state.living, result.paid);
  }

  // 4. 房租与基本生活费
  const charge = quoteMonth();
  const rentResult = payFromPersonal(state.finance, {
    ...ctx,
    operationId: `rent:${monthKey}`,
    amount: charge.rent,
    category: 'rent',
    memo: `${monthKey} 房租`,
    to: externalAccount('landlord'),
  });
  const livingResult = payFromPersonal(state.finance, {
    ...ctx,
    operationId: `living:${monthKey}`,
    amount: charge.living,
    category: 'living',
    memo: `${monthKey} 基本生活费`,
    to: externalAccount('utilities'),
  });

  // 5. 不足部分形成欠款（分别记录来源，便于展示）
  if (rentResult.shortfall > 0) {
    addDebt(state.living, monthKey, rentResult.shortfall, 'rent');
  }
  if (livingResult.shortfall > 0) {
    addDebt(state.living, monthKey, livingResult.shortfall, 'living');
  }

  // 6. 月报
  const totals = monthlyTotals(state.finance, monthKey);
  const report: MonthReport = {
    monthKey,
    settledAtMinute: boundaryMinute,
    income: totals.income,
    expense: totals.expense,
    net: totals.net,
    salary: wagesDue,
    rent: rentResult.paid,
    living: livingResult.paid,
    debtRepaid,
    newDebt: rentResult.shortfall + livingResult.shortfall,
    endCash: state.finance.accounts.cash,
    endSavings: state.finance.accounts.savings,
    endWagesOwed: state.employment.accruedWages,
    endDebt: state.living.debt,
    breakdown: totals.byCategory.map((line) => ({ ...line })),
  };
  state.reports.push(report);
  trimReports(state);

  state.settlement.settledMonths.push(monthKey);
  state.settlement.lastSettledMonth = monthKey;

  return report;
}
