/**
 * 企业模块 —— 企业身份、所有者归属、经营状态、应付费用与经营报表。
 *
 * 不实现科技研发公式（在 technology），不做市场计算（在 market），不直接改账户余额
 * （一律通过 finance 的公开函数）。这里只维护「这家公司是谁的、什么状态、
 * 欠了多少钱、这个月赚了多少」。
 */

import type { DeepReadonly } from '../../core/readonly';
import { ENTERPRISE_RULES } from '../../content/business';

export type EnterpriseStatus = 'active' | 'paused' | 'crisis' | 'closed';
export type EnterpriseRole = 'player' | 'ai';

export const STATUS_LABELS: Record<EnterpriseStatus, string> = {
  active: '正常经营',
  paused: '暂停经营',
  crisis: '资金危机',
  closed: '已清算',
};

/** 当月经营累计：权威的经营结果口径，不依赖被裁剪的流水。 */
export interface EnterpriseAccrual {
  monthKey: string;
  revenue: number;
  cogs: number;
  wages: number;
  research: number;
  marketing: number;
  opex: number;
  units: number;
}

export interface EnterpriseReport {
  readonly monthKey: string;
  readonly settledAtMinute: number;
  readonly revenue: number;
  readonly cogs: number;
  readonly wages: number;
  readonly research: number;
  readonly marketing: number;
  readonly opex: number;
  /** 应计利润 = 收入 − 已发生费用（未付费用同样计入费用）。 */
  readonly profit: number;
  readonly units: number;
  readonly cashEnd: number;
  readonly payablesEnd: number;
}

export interface Enterprise {
  readonly id: string;
  readonly role: EnterpriseRole;
  name: string;
  status: EnterpriseStatus;
  readonly createdAtMinute: number;
  closedAtMinute: number | null;
  /** 进入资金危机的时刻，用于 AI 的耐心判断。 */
  crisisSinceMinute: number | null;
  /** 已发生但未支付的工资（按任职分钟累计，月末支付）。 */
  payrollDue: number;
  /** 已发生但未支付的销售成本。 */
  cogsDue: number;
  /** 已发生但未支付的营销费。 */
  marketingDue: number;
  /** 已发生但未支付的运营费。 */
  opexDue: number;
  /**
   * 历史经营应付：v3 的 supplyDue 混合了成本/营销/运营，无法可靠追溯分类。
   * 新产生的费用一律进入上面各自的桶，这里只保留旧档遗留金额，付清即归零。
   */
  supplyDue: number;
  /** 费用（营销 + 运营）已累计到哪一刻。暂停/危机期间不推进。 */
  expenseMinute: number;
  /** 营销费不足一分的计算余量（分子，单位 = 分 × 分钟）。 */
  marketingRemainder: number;
  /** 运营费不足一分的计算余量。 */
  opexRemainder: number;
  /** 销售已结算到哪一刻（游戏分钟）。 */
  lastSettledMinute: number;
  /** 企业资金操作的单调序号，用于生成唯一 operationId。 */
  salesOps: number;
  /** 累计分红，仅作展示。 */
  dividendTotal: number;
  liquidationNote: string | null;
  accrual: EnterpriseAccrual;
  reports: EnterpriseReport[];
}

export interface EnterpriseState {
  companies: Record<string, Enterprise>;
}

export function createEnterpriseState(): EnterpriseState {
  return { companies: {} };
}

export function createEnterprise(input: {
  readonly id: string;
  readonly role: EnterpriseRole;
  readonly name: string;
  readonly nowMinute: number;
  readonly monthKey: string;
}): Enterprise {
  return {
    id: input.id,
    role: input.role,
    name: input.name,
    status: 'active',
    createdAtMinute: input.nowMinute,
    closedAtMinute: null,
    crisisSinceMinute: null,
    payrollDue: 0,
    cogsDue: 0,
    marketingDue: 0,
    opexDue: 0,
    supplyDue: 0,
    expenseMinute: input.nowMinute,
    marketingRemainder: 0,
    opexRemainder: 0,
    lastSettledMinute: input.nowMinute,
    salesOps: 1,
    dividendTotal: 0,
    liquidationNote: null,
    accrual: {
      monthKey: input.monthKey,
      revenue: 0,
      cogs: 0,
      wages: 0,
      research: 0,
      marketing: 0,
      opex: 0,
      units: 0,
    },
    reports: [],
  };
}

export function findEnterprise(state: EnterpriseState, companyId: string): Enterprise | null {
  return state.companies[companyId] ?? null;
}

/**
 * 玩家的公司。清算后可能同时存在多家，优先返回仍在营的一家；
 * 全部已清算时返回最近的那家，供界面展示清算结果。
 */
export function playerEnterprise(state: EnterpriseState): Enterprise | null;
export function playerEnterprise(
  state: DeepReadonly<EnterpriseState>,
): DeepReadonly<Enterprise> | null;
export function playerEnterprise(
  state: EnterpriseState | DeepReadonly<EnterpriseState>,
): Enterprise | DeepReadonly<Enterprise> | null {
  let closed: Enterprise | DeepReadonly<Enterprise> | null = null;
  for (const company of Object.values(state.companies)) {
    if (company.role !== 'player') continue;
    if (company.status !== 'closed') return company;
    closed = company;
  }
  return closed;
}

export function aiEnterprises(state: EnterpriseState): Enterprise[] {
  return Object.values(state.companies).filter((company) => company.role === 'ai');
}

/* ------------------------------------------------------------ 应付与权益 */

/** 全部已发生未支付的负债：工资 + 各类经营费用。权益与分红都以它为准。 */
export function payablesOf(company: Enterprise | DeepReadonly<Enterprise>): number {
  return (
    company.payrollDue +
    company.cogsDue +
    company.marketingDue +
    company.opexDue +
    company.supplyDue
  );
}

/** 日常经营费用类应付（不含工资）：日界付款与危机判定用。 */
export function dailyPayablesOf(company: Enterprise): number {
  return company.cogsDue + company.marketingDue + company.opexDue + company.supplyDue;
}

/** 企业账面权益 = 企业现金 − 企业应付费用。 */
export function equityOf(
  company: Enterprise | DeepReadonly<Enterprise>,
  cash: number,
): number {
  return cash - payablesOf(company);
}

/** 可分配现金 = 现金 − 应付费用，分红只能取这部分。 */
export function distributableOf(company: Enterprise, cash: number): number {
  return Math.max(0, cash - payablesOf(company));
}

export function isRunning(company: Enterprise): boolean {
  return company.status === 'active';
}

export function isClosed(company: Enterprise | DeepReadonly<Enterprise>): boolean {
  return company.status === 'closed';
}

/* ------------------------------------------------------------ 状态流转 */

export function enterCrisis(company: Enterprise, nowMinute: number): void {
  if (company.status === 'closed') return;
  company.status = 'crisis';
  if (company.crisisSinceMinute === null) company.crisisSinceMinute = nowMinute;
}

export function leaveCrisis(company: Enterprise): void {
  if (company.status !== 'crisis') return;
  company.status = 'active';
  company.crisisSinceMinute = null;
}

export function pauseCompany(company: Enterprise): void {
  if (company.status === 'closed') return;
  company.status = 'paused';
  company.crisisSinceMinute = null;
}

export function resumeCompany(company: Enterprise): void {
  if (company.status === 'closed') return;
  company.status = 'active';
  company.crisisSinceMinute = null;
}

export function closeCompany(
  company: Enterprise,
  nowMinute: number,
  note: string,
): void {
  company.status = 'closed';
  company.closedAtMinute = nowMinute;
  company.crisisSinceMinute = null;
  company.liquidationNote = note;
}

/* ------------------------------------------------------------ 经营累计 */

export type AccrualField = 'revenue' | 'cogs' | 'wages' | 'research' | 'marketing' | 'opex';

/** 把当月累计切到新的月份（跨月时调用，避免上月数字被算进本月）。 */
export function rollAccrualMonth(company: Enterprise, monthKey: string): void {
  if (company.accrual.monthKey === monthKey) return;
  company.accrual = {
    monthKey,
    revenue: 0,
    cogs: 0,
    wages: 0,
    research: 0,
    marketing: 0,
    opex: 0,
    units: 0,
  };
}

export function accrue(company: Enterprise, field: AccrualField, amount: number): void {
  if (amount <= 0) return;
  company.accrual[field] += amount;
  if (!Number.isSafeInteger(company.accrual[field])) {
    throw new Error('企业经营累计溢出');
  }
}

export function accrueUnits(company: Enterprise, units: number): void {
  if (units <= 0) return;
  company.accrual.units += units;
}

/** 把当月累计固化成报表并清零；返回生成的报表。 */
export function closeAccrualMonth(
  company: Enterprise,
  monthKey: string,
  nextMonthKey: string,
  nowMinute: number,
  cashEnd: number,
): EnterpriseReport {
  const a = company.accrual;
  const expense = a.cogs + a.wages + a.research + a.marketing + a.opex;
  const report: EnterpriseReport = {
    monthKey,
    settledAtMinute: nowMinute,
    revenue: a.revenue,
    cogs: a.cogs,
    wages: a.wages,
    research: a.research,
    marketing: a.marketing,
    opex: a.opex,
    profit: a.revenue - expense,
    units: a.units,
    cashEnd,
    payablesEnd: payablesOf(company),
  };
  company.reports.push(report);
  if (company.reports.length > ENTERPRISE_RULES.maxReports) {
    company.reports.splice(0, company.reports.length - ENTERPRISE_RULES.maxReports);
  }
  // 直接切到下一个月：月界当天不能再被日结重置一次
  company.accrual = {
    monthKey: nextMonthKey,
    revenue: 0,
    cogs: 0,
    wages: 0,
    research: 0,
    marketing: 0,
    opex: 0,
    units: 0,
  };
  return report;
}

/** 下一个企业资金操作 ID（单调递增，避免重名与重复入账）。 */
export function nextOperationId(company: Enterprise, kind: string): string {
  const seq = company.salesOps;
  company.salesOps += 1;
  return `${kind}:${company.id}:${seq}`;
}
