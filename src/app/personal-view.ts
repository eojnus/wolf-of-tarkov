/**
 * 人物管理界面的只读视图 —— 人物总览、个人财务、工作情况、股票投资。
 *
 * 只做「读状态 + 格式化」，不修改状态、不做业务计算：
 * 净资产、权益、盈亏全部来自已有口径（state / finance / business-view）。
 * 分页、筛选这类界面状态由 UI 传进来，不写进 GameState。
 */

import type { DeepReadonly } from '../core/readonly';
import { dateAtMinute, formatDuration, formatGameDate } from '../core/calendar';
import { formatMoney, formatMoneyCompact } from '../core/money';
import { BRANDING, JOBS, TIME, findJob } from '../content/config';
import { accruedInMonth, planShift, workedMinutesOn } from '../features/employment';
import {
  CATEGORY_LABELS,
  describeAccount,
  listPersonalEntries,
  monthlyTotals,
  type TransactionCategory,
} from '../features/finance';
import { remainingDays, totalOwed } from '../features/loan';
import { supplyCursorOf, type SupplyRequestCursor } from '../features/inventory';
import { buildBusinessView, type BusinessView } from './business-view';
import {
  buildInventoryItems,
  buildSurvivalStatus,
  type InventoryItemView,
  type SurvivalStatusView,
} from './supplies-view';
import {
  availableFunds,
  loanLiability,
  netWorth,
  stockValue,
  unlistedEquity,
  type ReadonlyGameState,
  type MonthReport,
} from './state';
import {
  buildStocksSection,
  buildCapitalView,
  type StockCardView,
  type StocksSectionView,
  type TradeRowView,
  type CapitalView,
} from './securities-view';

export type { StockCardView, StocksSectionView, TradeRowView };

export type PersonalSection = 'overview' | 'finance' | 'work' | 'inventory' | 'stocks' | 'company';

export interface SummaryItem {
  readonly label: string;
  readonly valueText: string;
  readonly note?: string;
  readonly tone?: 'pos' | 'neg';
}

export interface PersonalTodo {
  readonly id: string;
  readonly text: string;
  readonly detail: string;
  readonly tone: 'warn' | 'danger' | 'info';
  readonly section: PersonalSection;
}

export interface PersonalOverviewView {
  readonly name: string;
  readonly jobText: string;
  readonly companyText: string;
  readonly companyStatusText: string;
  readonly summary: SummaryItem[];
  readonly researchText: string;
  readonly todos: PersonalTodo[];
}

export interface LedgerRowView {
  readonly id: string;
  readonly timeText: string;
  readonly labelText: string;
  readonly inText: string;
  readonly outText: string;
  readonly accountText: string;
  readonly categoryText: string;
  readonly kind: 'in' | 'out' | 'internal' | 'invest' | 'loan' | 'capital';
}

export interface LedgerPageView {
  readonly rows: LedgerRowView[];
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
  readonly months: string[];
  readonly categories: Array<{ id: string; name: string }>;
  readonly month: string | null;
  readonly category: string | null;
}

export interface ReportView {
  readonly monthKey: string;
  readonly incomeText: string;
  readonly expenseText: string;
  readonly netText: string;
  readonly netPositive: boolean;
  readonly lines: Array<{ label: string; valueText: string; tone?: 'pos' | 'neg' }>;
  readonly footer: string;
}

export interface FinanceSectionView {
  readonly assets: SummaryItem[];
  readonly liabilities: SummaryItem[];
  readonly netWorthText: string;
  readonly formulaText: string;
  readonly monthIncomeText: string;
  readonly monthExpenseText: string;
  readonly monthNetText: string;
  readonly monthNetPositive: boolean;
  readonly incomeLines: Array<{ label: string; valueText: string }>;
  readonly expenseLines: Array<{ label: string; valueText: string }>;
  readonly flowNote: string;
  readonly ledger: LedgerPageView;
  readonly reportMonths: string[];
  readonly report: ReportView | null;
  readonly currentMonth: string;
}

export interface WorkSectionView {
  readonly hired: boolean;
  readonly employer: string;
  readonly title: string;
  readonly wageText: string;
  readonly description: string;
  readonly workedText: string;
  readonly remainingText: string;
  readonly monthAccruedText: string;
  readonly totalAccruedText: string;
  readonly canWork: boolean;
  readonly reasonText: string;
  readonly note: string;
  /** 当前工作效率（0～100 整数百分比）与本次班次预计收入。 */
  readonly efficiencyText: string;
  readonly estimatedEarnText: string;
}

export interface PersonalView {
  readonly dateText: string;
  readonly clockText: string;
  readonly overview: PersonalOverviewView;
  readonly survival: SurvivalStatusView;
  readonly inventory: InventoryItemView[];
  readonly inventoryEmpty: boolean;
  /** 背包使用请求 cursor：UI 提交前生成规范 requestId；只读，不消耗序号。 */
  readonly inventoryCursor: SupplyRequestCursor;
  readonly finance: FinanceSectionView;
  readonly work: WorkSectionView;
  readonly stocks: StocksSectionView;
  readonly company: BusinessView;
  readonly capital: CapitalView;
}

/** 界面侧的分页与筛选状态；只影响「看什么」，不影响业务。 */
export interface PersonalUiQuery {
  readonly ledgerPage: number;
  readonly ledgerMonth: string | null;
  readonly ledgerCategory: string | null;
  readonly ledgerSize: number;
  readonly reportMonth: string | null;
  /** 资本子页当前查看的公司；null 表示跟随「当前管理/持股」的默认口径。 */
  readonly capitalCompanyId: string | null;
  /** 回购输入框里的股数：只用于生成「本次预览」，不进存档、不参与业务。 */
  readonly capitalBuybackShares: number;
}

export const DEFAULT_PERSONAL_QUERY: PersonalUiQuery = {
  ledgerPage: 0,
  ledgerMonth: null,
  ledgerCategory: null,
  ledgerSize: 10,
  reportMonth: null,
  capitalCompanyId: null,
  capitalBuybackShares: 0,
};

const LEDGER_CATEGORIES: TransactionCategory[] = [
  'salary',
  'rent',
  'living',
  'loan-interest',
  'loan-drawdown',
  'loan-principal',
  'debt-repayment',
  'deposit',
  'withdrawal',
  'stock-buy',
  'stock-sell',
  'business-capital',
  'business-dividend',
  'business-liquidation',
  'supplies',
];

function directionOf(fromOwner: string, toOwner: string): 'in' | 'out' | 'internal' {
  if (toOwner === 'personal' && fromOwner !== 'personal') return 'in';
  if (fromOwner === 'personal' && toOwner !== 'personal') return 'out';
  return 'internal';
}

/** 流水的「业务形态」：用于把收入、内部转移、投资、借贷、资本往来分开显示。 */
function kindOf(category: TransactionCategory, direction: 'in' | 'out' | 'internal'): LedgerRowView['kind'] {
  if (category === 'stock-buy' || category === 'stock-sell') return 'invest';
  if (
    category === 'loan-drawdown' ||
    category === 'loan-principal' ||
    category === 'loan-interest'
  ) {
    return 'loan';
  }
  if (category.startsWith('business-')) return 'capital';
  return direction;
}

function buildOverview(
  state: ReadonlyGameState,
  company: BusinessView,
  survival: SurvivalStatusView,
): PersonalOverviewView {
  const job = findJob(state.employment.jobId) ?? JOBS[0] ?? null;
  const hired = state.employment.jobId !== null;
  const summary: SummaryItem[] = [
    {
      label: '可用资金',
      valueText: formatMoney(availableFunds(state)),
      note: '现金 + 银行存款',
    },
    {
      label: '总净资产',
      valueText: formatMoney(netWorth(state)),
      tone: netWorth(state) >= 0 ? 'pos' : 'neg',
    },
    { label: '股票市值', valueText: formatMoney(stockValue(state)) },
    {
      label: '企业账面权益',
      valueText: formatMoney(unlistedEquity(state)),
      note: company.hasCompany ? '企业现金 − 企业应付' : '尚未创建公司',
    },
    {
      label: '个人负债',
      valueText: formatMoney(state.living.debt + loanLiability(state)),
      tone: state.living.debt + loanLiability(state) > 0 ? 'neg' : undefined,
      note: '生活欠款 + 未偿贷款本息',
    },
    { label: '未发工资', valueText: formatMoney(state.employment.accruedWages) },
    { label: '饱食度', valueText: survival.hungerText, note: survival.lowHunger ? '偏低' : undefined },
    { label: '水分', valueText: survival.waterText, note: survival.lowWater ? '偏低' : undefined },
  ];

  const researchText = company.hasProject
    ? `研发中：${company.projectFocusText} · ${company.projectDays} 天 · 剩余 ${company.projectRemainingText}`
    : company.pending.length > 0
      ? `有 ${company.pending.length} 款产品待发布`
      : '当前没有进行中的研发';

  const todos: PersonalTodo[] = [];
  const contract = state.loan.contract;
  if (contract && contract.status !== 'settled') {
    const days = remainingDays(contract, state.clock.totalMinute);
    if (contract.status === 'overdue') {
      todos.push({
        id: 'loan-overdue',
        text: '个人贷款已逾期',
        detail: `待还 ${formatMoney(totalOwed(contract))}，会继续计息`,
        tone: 'danger',
        section: 'finance',
      });
    } else if (days <= 3) {
      todos.push({
        id: 'loan-due',
        text: `个人贷款 ${days} 天后到期`,
        detail: `待还 ${formatMoney(totalOwed(contract))}`,
        tone: 'warn',
        section: 'finance',
      });
    }
  }
  if (state.living.debt > 0) {
    todos.push({
      id: 'living-debt',
      text: '有未结清的生活欠款',
      detail: `${formatMoney(state.living.debt)}，每月发薪后自动偿还`,
      tone: 'warn',
      section: 'finance',
    });
  }
  if (survival.zeroHunger || survival.zeroWater) {
    todos.push({
      id: 'survival-zero',
      text: survival.zeroHunger && survival.zeroWater ? '饱食度与水分均已归零' : survival.zeroHunger ? '饱食度已归零' : '水分已归零',
      detail: `工作效率 ${survival.efficiencyPercent}% · 移动 ${survival.movePercent}%；到便利店购买补给或从背包使用`,
      tone: 'danger',
      section: 'inventory',
    });
  } else if (survival.lowHunger || survival.lowWater) {
    todos.push({
      id: 'survival-low',
      text: survival.lowHunger && survival.lowWater ? '饱食度与水分偏低' : survival.lowHunger ? '饱食度偏低' : '水分偏低',
      detail: '低于 20 暂无惩罚，但继续归零会降低工作效率与移动速度',
      tone: 'warn',
      section: 'inventory',
    });
  }
  if (company.hasCompany && company.pending.length > 0) {
    todos.push({
      id: 'pending-product',
      text: '有研发完成的产品待发布',
      detail: '到公司管理的「研发与产品」里命名、定价并上市',
      tone: 'info',
      section: 'company',
    });
  }
  if (company.hasCompany && company.status === 'crisis') {
    todos.push({
      id: 'company-crisis',
      text: '公司处于资金危机',
      detail: `未付应付 ${company.payablesText}，需要追加出资或停售亏损产品`,
      tone: 'danger',
      section: 'company',
    });
  }

  return {
    name: BRANDING.citizenName,
    jobText: hired && job ? `${job.employer} · ${job.title}` : '待业',
    companyText: company.hasCompany ? company.name : '尚未创建公司',
    companyStatusText: company.hasCompany ? company.statusText : '—',
    summary,
    researchText,
    todos,
  };
}

function buildFinance(state: ReadonlyGameState, query: PersonalUiQuery): FinanceSectionView {
  const now = dateAtMinute(state.clock.totalMinute, TIME.calendar);
  const contract = state.loan.contract;
  const open = contract && contract.status !== 'settled' ? contract : null;
  const totals = monthlyTotals(state.finance, now.monthKey);

  const assets: SummaryItem[] = [
    { label: '现金', valueText: formatMoney(state.finance.accounts.cash) },
    { label: '银行存款', valueText: formatMoney(state.finance.accounts.savings) },
    { label: '未发工资', valueText: formatMoney(state.employment.accruedWages), note: '计为正资产' },
    { label: '股票市值', valueText: formatMoney(stockValue(state)) },
    {
      label: '企业账面权益',
      valueText: formatMoney(unlistedEquity(state)),
      note: '只计一次，不重复加企业现金',
    },
  ];

  const liabilities: SummaryItem[] = [
    {
      label: '生活欠款',
      valueText: formatMoney(state.living.debt),
      tone: state.living.debt > 0 ? 'neg' : undefined,
    },
    {
      label: '贷款未偿本金',
      valueText: formatMoney(open ? open.outstanding : 0),
    },
    {
      label: '已计提未付利息',
      valueText: formatMoney(open ? open.accruedInterest : 0),
    },
  ];

  const incomeLines = totals.byCategory
    .filter((line) => line.income > 0)
    .map((line) => ({ label: CATEGORY_LABELS[line.category], valueText: formatMoney(line.income) }));
  const expenseLines = totals.byCategory
    .filter((line) => line.expense > 0)
    .map((line) => ({ label: CATEGORY_LABELS[line.category], valueText: formatMoney(line.expense) }));

  const entries = listPersonalEntries(state.finance, {
    monthKey: query.ledgerMonth,
    category: (query.ledgerCategory as TransactionCategory | null) ?? null,
  });
  const size = Math.max(1, query.ledgerSize);
  const pageCount = Math.max(1, Math.ceil(entries.length / size));
  const page = Math.min(Math.max(0, query.ledgerPage), pageCount - 1);
  const slice = entries.slice(page * size, page * size + size);

  const rows: LedgerRowView[] = slice.map((entry) => {
    const direction = directionOf(entry.from.owner, entry.to.owner);
    const account = direction === 'in' ? entry.to : entry.from;
    return {
      id: entry.id,
      timeText: formatGameDate(dateAtMinute(entry.atMinute, TIME.calendar)),
      labelText: entry.memo || CATEGORY_LABELS[entry.category],
      inText: direction === 'in' ? formatMoney(entry.amount) : '',
      outText: direction === 'out' ? formatMoney(entry.amount) : '',
      accountText: describeAccount(account),
      categoryText: CATEGORY_LABELS[entry.category],
      kind: kindOf(entry.category, direction),
    };
  });

  const months = [...new Set(state.finance.entries.map((entry) => entry.monthKey))]
    .filter((key) => key.length > 0)
    .sort()
    .reverse();

  const reportMonths = [...state.reports].reverse().map((report) => report.monthKey);
  const selectedMonth =
    query.reportMonth ?? (reportMonths.length > 0 ? reportMonths[0]! : null);
  const report = selectedMonth
    ? (state.reports.find((item) => item.monthKey === selectedMonth) ?? null)
    : null;

  return {
    assets,
    liabilities,
    netWorthText: formatMoney(netWorth(state)),
    formulaText:
      '净资产 = 现金 + 银行存款 + 未发工资 + 股票市值 + 企业账面权益 − 生活欠款 − 未偿贷款本息',
    monthIncomeText: formatMoney(totals.income),
    monthExpenseText: formatMoney(totals.expense),
    monthNetText: formatMoney(totals.net),
    monthNetPositive: totals.net >= 0,
    incomeLines,
    expenseLines,
    flowNote:
      '这里只统计个人账户：公司销售收入、研发费、公司工资、营销与运营费不会出现在个人收支里；企业出资、清算分配属于资本往来，也不计入消费。',
    ledger: {
      rows,
      page,
      pageCount,
      total: entries.length,
      months,
      categories: LEDGER_CATEGORIES.map((id) => ({ id, name: CATEGORY_LABELS[id] })),
      month: query.ledgerMonth,
      category: query.ledgerCategory,
    },
    reportMonths,
    report: report ? buildReport(report) : null,
    currentMonth: now.monthKey,
  };
}

function buildReport(report: DeepReadonly<MonthReport>): ReportView {
  const lines = report.breakdown.map((line) => ({
    label: CATEGORY_LABELS[line.category],
    valueText:
      line.income > 0
        ? `收入 ${formatMoney(line.income)}`
        : `支出 ${formatMoney(line.expense)}`,
    tone: (line.income > 0 ? 'pos' : 'neg') as 'pos' | 'neg',
  }));
  return {
    monthKey: report.monthKey,
    incomeText: formatMoney(report.income),
    expenseText: formatMoney(report.expense),
    netText: formatMoney(report.net),
    netPositive: report.net >= 0,
    lines,
    footer: `期末：现金 ${formatMoney(report.endCash)} · 存款 ${formatMoney(report.endSavings)} · 未发工资 ${formatMoney(report.endWagesOwed)} · 欠款 ${formatMoney(report.endDebt)}`,
  };
}

function buildWork(state: ReadonlyGameState, survival: SurvivalStatusView): WorkSectionView {
  const job = findJob(state.employment.jobId);
  const now = dateAtMinute(state.clock.totalMinute, TIME.calendar);
  if (!job) {
    return {
      hired: false,
      employer: '—',
      title: '待业',
      wageText: '—',
      description: `当前没有正式工作。到城市里的「${BRANDING.cityStem}实业大厦」或便利店办理入职后即可上班。`,
      workedText: '—',
      remainingText: '—',
      monthAccruedText: formatMoney(accruedInMonth(state.employment, now.monthKey)),
      totalAccruedText: formatMoney(state.employment.accruedWages),
      canWork: false,
      reasonText: '尚未入职',
      note: '一次只能在一个岗位在职；切换岗位会保留已赚工资与今日工时上限。',
      efficiencyText: survival.efficiencyText,
      estimatedEarnText: '—',
    };
  }

  const plan = planShift(state.employment, job, now);
  const worked = workedMinutesOn(state.employment, now.dayKey);
  const remaining = Math.max(0, job.maxMinutesPerDay - worked);
  // 与统一工资应计同口径：实际分钟 × 时薪 × 当前效率，仅用于展示
  const estimatedEarn = plan.ok
    ? Math.floor((job.hourlyWageCents * plan.minutes * survival.efficiencyPercent) / 6000)
    : 0;
  return {
    hired: true,
    employer: job.employer,
    title: job.title,
    wageText: `${formatMoneyCompact(job.hourlyWageCents)} / 小时`,
    description: job.description,
    workedText: formatDuration(worked),
    remainingText: formatDuration(remaining),
    monthAccruedText: formatMoney(accruedInMonth(state.employment, now.monthKey)),
    totalAccruedText: formatMoney(state.employment.accruedWages),
    canWork: plan.ok,
    reasonText: plan.ok ? `现在可以上班，本次 ${formatDuration(plan.minutes)}` : (plan.reason ?? '当前无法上班'),
    note: '工资在月度结算时发放到现金；未发工资不能直接用于支付。每日上限按实际出勤分钟计算，不因效率降低而翻倍。',
    efficiencyText: `${survival.efficiencyText} · ${survival.moveText}`,
    estimatedEarnText: plan.ok ? formatMoney(estimatedEarn) : '—',
  };
}

export function buildPersonalView(state: ReadonlyGameState, query: PersonalUiQuery): PersonalView {
  const company = buildBusinessView(state);
  const now = dateAtMinute(state.clock.totalMinute, TIME.calendar);
  const survival = buildSurvivalStatus(state);
  const inventory = buildInventoryItems(state);
  return {
    dateText: formatGameDate(now),
    clockText: `${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`,
    overview: buildOverview(state, company, survival),
    survival,
    inventory,
    inventoryEmpty: inventory.length === 0,
    inventoryCursor: supplyCursorOf(state.inventory),
    finance: buildFinance(state, query),
    work: buildWork(state, survival),
    stocks: buildStocksSection(state),
    company,
    capital: buildCapitalView(
      state,
      query.capitalCompanyId,
      query.capitalBuybackShares,
    ),
  };
}
