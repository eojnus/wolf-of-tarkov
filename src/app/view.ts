/**
 * 只读视图模型 —— 界面只消费这里的结果，从不直接读业务内部数据，也不修改状态。
 */

import type { DeepReadonly } from '../core/readonly';
import { dateAtMinute, formatDuration, formatGameDate, type GameDate } from '../core/calendar';
import { formatMoney, formatMoneyCompact } from '../core/money';
import { ECONOMY, JOBS, LOAN, MARKET, TIME, findJob, type JobConfig } from '../content/config';
import { accruedInMonth, planShift, workedMinutesOn, type ShiftPlan } from '../features/employment';
import {
  CATEGORY_LABELS,
  describeAccount,
  monthlyTotals,
  recentPersonalEntries,
  type MonthTotals,
} from '../features/finance';
import { LOAN_STATUS_LABELS, remainingDays, totalOwed, type LoanStatus } from '../features/loan';
import type { MonthCharge } from '../features/living';
import {
  averageCost,
  marketValue,
  priceChangeOf,
  unrealizedPnl,
} from '../features/stock';
import type { MonthReport, ReadonlyGameState } from './state';
import { businessBalance } from '../features/finance';
import {
  availableFunds,
  loanLiability,
  managedCompany,
  netWorth,
  playerHoldingOf,
  propertyValueOf,
  stockValue,
  unlistedEquity,
} from './state';
import { monthChargeOf } from './residence';
import { buildBusinessView, type BusinessView } from './business-view';
import { buildSurvivalStatus, type SurvivalStatusView } from './supplies-view';

export type LedgerDirection = 'in' | 'out' | 'internal';

export interface LedgerRow {
  readonly id: string;
  readonly dateText: string;
  readonly label: string;
  readonly counterParty: string;
  readonly amountText: string;
  readonly direction: LedgerDirection;
}

export interface EmploymentView {
  readonly hired: boolean;
  readonly jobTitle: string;
  readonly employer: string;
  readonly description: string;
  readonly hourlyWageText: string;
  readonly workedToday: number;
  readonly maxDaily: number;
  readonly shiftMinutes: number;
  readonly accruedTotalText: string;
  readonly accruedThisMonthText: string;
  readonly shiftsCompleted: number;
  readonly shift: ShiftPlan;
  readonly shiftLabel: string;
  readonly estimatedEarnText: string;
  /** 当前工作效率（0～100 整数百分比），由生存状态推导。 */
  readonly efficiencyPercent: number;
  readonly efficiencyText: string;
}

export interface MoneyView {
  readonly cash: number;
  readonly savings: number;
  readonly unpaidWages: number;
  readonly debt: number;
  readonly stockValue: number;
  readonly propertyValue: number;
  readonly loanPrincipal: number;
  readonly loanInterest: number;
  readonly loanLiability: number;
  readonly available: number;
  readonly netWorth: number;
  readonly enterpriseEquity: number;
  readonly enterpriseCash: number;
  readonly cashText: string;
  readonly savingsText: string;
  readonly unpaidWagesText: string;
  readonly debtText: string;
  readonly stockValueText: string;
  readonly propertyValueText: string;
  readonly loanPrincipalText: string;
  readonly loanInterestText: string;
  readonly loanLiabilityText: string;
  readonly availableText: string;
  readonly netWorthText: string;
  readonly enterpriseEquityText: string;
  readonly enterpriseCashText: string;
}

export type PriceDirection = 'up' | 'down' | 'flat';

export interface StockView {
  readonly symbol: string;
  readonly name: string;
  readonly price: number;
  readonly priceText: string;
  readonly changeText: string;
  readonly changePctText: string;
  readonly direction: PriceDirection;
  readonly history: readonly number[];
  readonly tickMinutes: number;
  readonly nextTickText: string;
  readonly shares: number;
  readonly avgCostText: string;
  readonly marketValueText: string;
  readonly unrealizedText: string;
  readonly unrealizedPositive: boolean;
  readonly realizedText: string;
  readonly realizedPositive: boolean;
  readonly trades: number;
  readonly canBuy: boolean;
  readonly canSell: boolean;
}

export interface LoanView {
  readonly hasContract: boolean;
  readonly open: boolean;
  readonly status: LoanStatus | null;
  readonly statusText: string;
  readonly overdue: boolean;
  readonly principalText: string;
  readonly outstandingText: string;
  readonly accruedInterestText: string;
  readonly totalOwed: number;
  readonly totalOwedText: string;
  readonly totalPaidText: string;
  readonly interestRateText: string;
  readonly termText: string;
  readonly dueDateText: string;
  readonly remainingText: string;
  readonly maxPrincipalText: string;
  readonly minPrincipalText: string;
  readonly maxRepayableText: string;
  readonly canBorrow: boolean;
  readonly canRepay: boolean;
  readonly startDateText: string;
}

export interface GameViewModel {
  readonly date: GameDate;
  readonly dateText: string;
  readonly clockText: string;
  readonly monthCharge: MonthCharge;
  readonly monthChargeText: string;
  readonly money: MoneyView;
  readonly survival: SurvivalStatusView;
  readonly employment: EmploymentView;
  readonly stock: StockView;
  readonly loan: LoanView;
  readonly ledger: LedgerRow[];
  readonly reports: readonly DeepReadonly<MonthReport>[];
  readonly monthTotals: MonthTotals;
  readonly monthTotalsText: { income: string; expense: string; net: string };
  readonly banking: { minimumText: string; maximumText: string };
  readonly settledCount: number;
  readonly lastSettledMonth: string | null;
  readonly speed: number;
  readonly paused: boolean;
  readonly business: BusinessView;
}

const FALLBACK_JOB: JobConfig | null = JOBS[0] ?? null;

/**
 * 个人视角的资金方向：只要一端不是个人账户，就以「钱是否进到个人」为准。
 * 企业分红（企业 → 个人）是流入，个人出资（个人 → 企业）是流出。
 */
function directionOf(fromOwner: string, toOwner: string): LedgerDirection {
  if (toOwner === 'personal' && fromOwner !== 'personal') return 'in';
  if (fromOwner === 'personal' && toOwner !== 'personal') return 'out';
  return 'internal';
}

function shiftLabelOf(plan: ShiftPlan): string {
  if (!plan.ok) return '无法上班';
  return `上班 ${formatDuration(plan.minutes)}`;
}

function signedText(value: number): string {
  return `${value >= 0 ? '+' : '−'}${formatMoney(Math.abs(value))}`;
}

function buildStockView(state: ReadonlyGameState, savings: number): StockView {
  const market = state.securities.markets[MARKET.symbol];
  if (!market || !state.securities.holdings[MARKET.symbol]) {
    throw new Error('旧独立证券尚未初始化');
  }
  const stock = playerHoldingOf(state, MARKET.symbol);
  const { change, pct } = priceChangeOf(market);
  const direction: PriceDirection = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
  const value = marketValue(stock, market.price);
  const floating = unrealizedPnl(stock, market.price);
  const avg = averageCost(stock);
  const nextTick = dateAtMinute(market.nextTickMinute, TIME.calendar);

  return {
    symbol: MARKET.symbol,
    name: MARKET.name,
    price: market.price,
    priceText: formatMoney(market.price),
    changeText: signedText(change),
    changePctText: `${pct >= 0 ? '+' : '−'}${(Math.abs(pct) * 100).toFixed(2)}%`,
    direction,
    history: market.history.map((point) => point.price),
    tickMinutes: MARKET.tickMinutes,
    nextTickText: `${String(nextTick.hour).padStart(2, '0')}:${String(nextTick.minute).padStart(2, '0')}`,
    shares: stock.shares,
    avgCostText: stock.shares > 0 ? formatMoney(Math.round(avg)) : '—',
    marketValueText: formatMoney(value),
    unrealizedText: stock.shares > 0 ? signedText(floating) : '—',
    unrealizedPositive: floating >= 0,
    realizedText: signedText(stock.realizedPnl),
    realizedPositive: stock.realizedPnl >= 0,
    trades: stock.trades,
    canBuy: savings >= market.price,
    canSell: stock.shares > 0,
  };
}

function buildLoanView(state: ReadonlyGameState, nowMinute: number, savings: number): LoanView {
  const contract = state.loan.contract;
  const isSettled = contract?.status === 'settled';

  if (!contract) {
    const ratePercent = (LOAN.interestRatePerTerm * 100).toFixed(1);
    return {
      hasContract: false,
      open: false,
      status: null,
      statusText: '无贷款',
      overdue: false,
      principalText: '—',
      outstandingText: '—',
      accruedInterestText: '—',
      totalOwed: 0,
      totalOwedText: '—',
      totalPaidText: '—',
      interestRateText: `每 ${LOAN.termDays} 天 ${ratePercent}%（单利）`,
      termText: `${LOAN.termDays} 天`,
      dueDateText: '—',
      remainingText: '—',
      maxPrincipalText: formatMoneyCompact(LOAN.maxPrincipalCents),
      minPrincipalText: formatMoneyCompact(LOAN.minPrincipalCents),
      maxRepayableText: formatMoney(0),
      canBorrow: true,
      canRepay: false,
      startDateText: '—',
    };
  }

  const due = dateAtMinute(contract.dueMinute, TIME.calendar);
  const start = dateAtMinute(contract.startMinute, TIME.calendar);
  const owed = totalOwed(contract);
  const ratePercent = (LOAN.interestRatePerTerm * 100).toFixed(1);
  const overdue = contract.status === 'overdue';

  return {
    hasContract: true,
    open: contract.status !== 'settled',
    status: contract.status,
    statusText: LOAN_STATUS_LABELS[contract.status],
    overdue,
    principalText: formatMoney(contract.principal),
    outstandingText: formatMoney(contract.outstanding),
    accruedInterestText: formatMoney(contract.accruedInterest),
    totalOwed: owed,
    totalOwedText: formatMoney(owed),
    totalPaidText: formatMoney(contract.totalInterestPaid + contract.totalPrincipalPaid),
    interestRateText: `每 ${LOAN.termDays} 天 ${ratePercent}%（单利，按未偿本金）`,
    termText: `${LOAN.termDays} 天`,
    dueDateText: `${due.month}月${due.day}日`,
    remainingText: isSettled ? '已结清' : `${remainingDays(contract, nowMinute)} 天`,
    maxPrincipalText: formatMoneyCompact(LOAN.maxPrincipalCents),
    minPrincipalText: formatMoneyCompact(LOAN.minPrincipalCents),
    maxRepayableText: formatMoney(Math.min(owed, savings)),
    canBorrow: !contract || isSettled,
    canRepay: !isSettled && owed > 0,
    startDateText: `${start.month}月${start.day}日`,
  };
}

export function buildViewModel(state: ReadonlyGameState): GameViewModel {
  const now = dateAtMinute(state.clock.totalMinute, TIME.calendar);
  const job = findJob(state.employment.jobId) ?? FALLBACK_JOB;
  const charge = monthChargeOf(state);
  const totals = monthlyTotals(state.finance, now.monthKey);
  const stockSum = stockValue(state);
  const loanSum = loanLiability(state);
  const contract = state.loan.contract;
  const loanPrincipal = contract && contract.status !== 'settled' ? contract.outstanding : 0;
  const loanInterest = contract && contract.status !== 'settled' ? contract.accruedInterest : 0;

  const moneyView: MoneyView = {
    cash: state.finance.accounts.cash,
    savings: state.finance.accounts.savings,
    unpaidWages: state.employment.accruedWages,
    debt: state.living.debt,
    stockValue: stockSum,
    propertyValue: propertyValueOf(state),
    loanPrincipal,
    loanInterest,
    loanLiability: loanSum,
    available: availableFunds(state),
    netWorth: netWorth(state),
    enterpriseEquity: unlistedEquity(state),
    enterpriseCash: (() => {
      const company = managedCompany(state);
      return company ? businessBalance(state.finance, company.id) : 0;
    })(),
    cashText: formatMoney(state.finance.accounts.cash),
    savingsText: formatMoney(state.finance.accounts.savings),
    unpaidWagesText: formatMoney(state.employment.accruedWages),
    debtText: formatMoney(state.living.debt),
    stockValueText: formatMoney(stockSum),
    propertyValueText: formatMoney(propertyValueOf(state)),
    loanPrincipalText: formatMoney(loanPrincipal),
    loanInterestText: formatMoney(loanInterest),
    loanLiabilityText: formatMoney(loanSum),
    availableText: formatMoney(availableFunds(state)),
    netWorthText: formatMoney(netWorth(state)),
    enterpriseEquityText: formatMoney(unlistedEquity(state)),
    enterpriseCashText: formatMoney(
      (() => {
        const company = managedCompany(state);
        return company ? businessBalance(state.finance, company.id) : 0;
      })(),
    ),
  };

  const shift = job
    ? planShift(state.employment, job, now)
    : { ok: false, minutes: 0, reason: '暂无可应聘岗位', remainingToday: 0 };
  const survival = buildSurvivalStatus(state);
  // 预计收入与统一工资应计保持同一口径：分钟 × 时薪 × 当前效率，仅向下取整到分展示
  const estimatedEarn = job && shift.ok
    ? Math.floor((job.hourlyWageCents * shift.minutes * survival.efficiencyPercent) / 6000)
    : 0;

  const employmentView: EmploymentView = {
    hired: state.employment.jobId !== null,
    jobTitle: job?.title ?? '待业',
    employer: job?.employer ?? '—',
    description: job?.description ?? '',
    hourlyWageText: job ? `${formatMoneyCompact(job.hourlyWageCents)} / 小时` : '—',
    workedToday: job ? workedMinutesOn(state.employment, now.dayKey) : 0,
    maxDaily: job?.maxMinutesPerDay ?? 0,
    shiftMinutes: job?.shiftMinutes ?? 0,
    accruedTotalText: formatMoney(state.employment.accruedWages),
    accruedThisMonthText: formatMoney(accruedInMonth(state.employment, now.monthKey)),
    shiftsCompleted: state.employment.shiftsCompleted,
    shift,
    shiftLabel: shiftLabelOf(shift),
    estimatedEarnText: job && shift.ok ? formatMoney(estimatedEarn) : '—',
    efficiencyPercent: survival.efficiencyPercent,
    efficiencyText: `当前效率 ${survival.efficiencyPercent}%`,
  };

  const ledger: LedgerRow[] = recentPersonalEntries(state.finance, 14).map((entry) => {
    const direction = directionOf(entry.from.owner, entry.to.owner);
    const counterParty =
      direction === 'in' ? describeAccount(entry.from) : describeAccount(entry.to);
    return {
      id: entry.id,
      dateText: formatGameDate(dateAtMinute(entry.atMinute, TIME.calendar)),
      label: CATEGORY_LABELS[entry.category],
      counterParty,
      amountText: formatMoney(entry.amount),
      direction,
    };
  });

  return {
    date: now,
    dateText: formatGameDate(now),
    clockText: `${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`,
    monthCharge: charge,
    monthChargeText: formatMoneyCompact(charge.total),
    money: moneyView,
    survival,
    employment: employmentView,
    stock: buildStockView(state, state.finance.accounts.savings),
    loan: buildLoanView(state, state.clock.totalMinute, state.finance.accounts.savings),
    ledger,
    reports: [...state.reports].reverse(),
    monthTotals: totals,
    monthTotalsText: {
      income: formatMoney(totals.income),
      expense: formatMoney(totals.expense),
      net: formatMoney(totals.net),
    },
    banking: {
      minimumText: formatMoneyCompact(ECONOMY.minimumTransferCents),
      maximumText: formatMoneyCompact(ECONOMY.maximumTransferCents),
    },
    settledCount: state.settlement.settledMonths.length,
    lastSettledMonth: state.settlement.lastSettledMonth,
    speed: state.clock.speed,
    paused: state.clock.paused,
    business: buildBusinessView(state),
  };
}
