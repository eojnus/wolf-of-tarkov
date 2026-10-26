/**
 * 企业经营结算 —— 日界、月界、研发节点与 AI 决策的集中处理。
 *
 * 只由 app/timeAdvance 调用，没有独立定时器。
 * 统一口径：
 *   - 工资：按任职分钟持续形成「费用 + 应付」，月末支付；支付只减少现金与负债，不再计费用。
 *   - 营销/运营：只对**实际正常经营的分钟**计提，同样持续形成「费用 + 应付」；
 *     日界集中付款，付款不再次计费用。
 *   - 销售成本：按成交数量形成「费用 + 应付」，同样只在付款时减少现金。
 * 任一步失败整次推进回滚，不会留下「卖了货没记成本」的中间状态。
 */

import { daySerialAtMinute, monthIndexAtMinute, monthKeyOfIndex } from '../core/calendar';
import type { MonthBoundaryInfo } from '../core/clock';
import { assertMoneyRange } from '../core/money';
import { AI_COMPANIES, ENTERPRISE_RULES } from '../content/business';
import { PRODUCT_STOCK_RULES } from '../content/capital';
import { TIME } from '../content/config';
import { decide, type AiPolicyConfig, type AiProductSnapshot, type AiSnapshot } from '../features/business-ai';
import {
  accrue,
  accrueUnits,
  closeAccrualMonth,
  closeCompany,
  dailyPayablesOf,
  enterCrisis,
  isClosed,
  isRunning,
  nextOperationId,
  payablesOf,
  playerEnterprise,
  rollAccrualMonth,
  type Enterprise,
} from '../features/enterprise';
import {
  businessAccountRef,
  businessBalance,
  externalAccount,
  payBusinessExpense,
  receiveBusinessRevenue,
  releaseFunds,
  transferFunds,
} from '../features/finance';
import { bookOfCompany, effectiveShares } from '../features/equity';
import { activeApplication } from '../features/financing';
import { applyProductReleaseImpact, dividendRecipient } from './securities-settlement';
import { holdingOf, securitiesOfCompany, settleTerminatedHolding, terminateSecurity } from '../features/stock';
import { estimateSales } from '../features/market';
import {
  completeProject,
  ensureTechCompany,
  generationFactorOf,
  isPublishBlockedThisYear,
  isProjectDue,
  latestProductForWrite,
  pendingProducts,
  recordDailyUnits,
  releaseProduct,
  startProject,
  stopSelling,
  type Product,
  type TechCompanyState,
} from '../features/technology';
import {
  accrueWageIncrement,
  assignmentOf,
  recordWagePayment,
} from '../features/talent';
import { activePolicyEffects } from './policy';
import { computeSalesPlan, registerSettledOutput } from './city-statistics';
import { recordCityTermination } from './city-stock-index';
import { recordTermination } from './population-market';
import type { GameState } from './state';

/**
 * 报表口径的月份：与月结边界（monthEndBoundaryMinute）一致。
 *
 * 两点必须记清：
 *  - 月界在月末 24:00（即下月第 1 天 00:00），那一分钟已经属于新月份，
 *    因此营业时间的月份归属一律取「段起点」，跨月段不会被记到新月份；
 *  - 首月从 08:00 起算只有 42,720 分钟，工资偏低是定价口径，不是缺陷。
 */
export function reportingMonthKey(minute: number): string {
  return monthKeyOfIndex(monthIndexAtMinute(minute, TIME.calendar), TIME.calendar);
}

/** 与报表月份一致的年份，用于「每年发布一款」的名额判断。 */
function yearAt(minute: number): number {
  return Number(reportingMonthKey(minute).slice(0, 4));
}

export interface BusinessEvent {
  readonly companyId: string;
  readonly companyName: string;
  readonly kind: 'crisis' | 'liquidated';
  readonly detail: string;
}

/* ------------------------------------------------------------ 销售结算 */

/**
 * 把某家公司的销售结算到 nowMinute。
 * 改价、改营销、发布、退市、暂停前必须先调用它，
 * 让旧规则只影响它生效之前的时间，不会追溯影响过去销量。
 *
 * 销量与成本的**唯一计算实现**是 `app/city-statistics.computeSalesPlan`（纯投影）：
 * 正式结算与实时统计预览共用同一份计算，避免出现第二套近似销量公式。
 * 结算成功时在同一次提交里把本次真实产出登记进城市统计（带企业操作序号高水位防重复）。
 */
export function settleCompanySales(
  state: GameState,
  company: Enterprise,
  nowMinute: number,
): void {
  const elapsed = nowMinute - company.lastSettledMinute;
  if (elapsed <= 0) return;
  if (!isRunning(company)) {
    // 暂停/危机/清算期间不产生销量，但游标仍要前进，恢复后不会补算停业期间
    company.lastSettledMinute = nowMinute;
    return;
  }

  const plan = computeSalesPlan(state, company.id, nowMinute);
  company.lastSettledMinute = nowMinute;

  const tech = ensureTechCompany(state.technology, company.id);
  // 先把纯投影的结果写回产品（余量始终回写，含本次不足一件的情况）
  for (const line of plan.lines) {
    const product = tech.products.find((item) => item.id === line.productId);
    if (!product) continue;
    product.salesRemainder = line.salesRemainderAfter;
    if (line.units <= 0) continue;
    product.salesCostRemainder = line.salesCostRemainderAfter;
    product.totalUnits += line.units;
    product.totalRevenueCents += line.revenueCents;
    product.totalCostCents += line.costCents;
  }
  if (plan.units <= 0) return;

  const revenue = plan.revenueCents;
  const cost = plan.costCents;
  const units = plan.units;
  assertMoneyRange(revenue, '销售收入');
  assertMoneyRange(cost, '销售成本');

  const ctx = { atMinute: nowMinute, monthKey: reportingMonthKey(nowMinute) };

  // 本次销售操作将消耗的企业操作序号：统计侧用它做单调高水位，不要求序号连续
  const outputSeq = company.salesOps;

  receiveBusinessRevenue(state.finance, company.id, {
    ...ctx,
    operationId: nextOperationId(company, 'sale'),
    amount: revenue,
    memo: `销售收入 ${units} 件`,
  });
  const paidCost = payBusinessExpense(state.finance, company.id, {
    ...ctx,
    operationId: nextOperationId(company, 'cogs'),
    amount: cost,
    to: externalAccount('supplier'),
    category: 'business-cogs',
    memo: `销售成本 ${units} 件`,
  });
  // 付不出的部分只记销售成本应付，不再混进其他费用
  if (paidCost.shortfall > 0) company.cogsDue += paidCost.shortfall;

  accrue(company, 'revenue', revenue);
  accrue(company, 'cogs', cost);
  accrueUnits(company, units);

  // 同一事务内登记真实经营产出：实际售出数量 × 当时实际成交单价。
  // 月份归属取企业当月累计的月份（月界当刻结清的旧区间仍属于旧月，不会串月）。
  registerSettledOutput(
    state,
    company.id,
    plan,
    outputSeq,
    company.accrual.monthKey,
    nowMinute,
  );
}

/* ------------------------------------------------------- 营销与运营费 */

function dailyMarketingOf(tech: TechCompanyState): number {
  let total = 0;
  for (const product of tech.products) {
    if (product.onSale && product.releasedAtMinute !== null) {
      total += Math.max(0, product.marketingDailyCents);
    }
  }
  return total;
}

/** 按「分 × 分钟」整数分子累计，返回完整的分与新的余量。 */
function accruePerDay(
  perDayCents: number,
  minutes: number,
  remainder: number,
): { whole: number; remainder: number } {
  if (perDayCents <= 0 || minutes <= 0) return { whole: 0, remainder };
  const numerator = remainder + perDayCents * minutes;
  const whole = Math.floor(numerator / TIME.calendar.minutesPerDay);
  return { whole, remainder: numerator - whole * TIME.calendar.minutesPerDay };
}

/**
 * 企业费用（营销 + 运营）检查点：把 [expenseMinute, nowMinute) 的费用按分钟计提。
 *
 * 只对**实际正常经营**的时段计费：暂停与危机期间不推进费用检查点，
 * 因此「午夜前把营销调成 0 / 暂停公司」不能免除此前已经发生的费用，
 * 「临近午夜才开业」也不会被收整天费用。
 */
export function settleCompanyExpensesTo(
  state: GameState,
  company: Enterprise,
  nowMinute: number,
): void {
  const elapsed = nowMinute - company.expenseMinute;
  if (elapsed <= 0) return;
  company.expenseMinute = nowMinute;
  if (!isRunning(company)) return;

  const tech = ensureTechCompany(state.technology, company.id);
  const marketing = accruePerDay(dailyMarketingOf(tech), elapsed, company.marketingRemainder);
  company.marketingRemainder = marketing.remainder;
  if (marketing.whole > 0) {
    company.marketingDue += marketing.whole;
    accrue(company, 'marketing', marketing.whole);
  }

  const opex = accruePerDay(
    ENTERPRISE_RULES.operatingCostDailyCents * activePolicyEffects(state).operatingCostMultiplier,
    elapsed,
    company.opexRemainder,
  );
  company.opexRemainder = opex.remainder;
  if (opex.whole > 0) {
    company.opexDue += opex.whole;
    accrue(company, 'opex', opex.whole);
  }
}

/* ------------------------------------------------------------ 付款 */

type DueBucket = 'cogsDue' | 'marketingDue' | 'opexDue' | 'supplyDue';

interface PaySpec {
  readonly bucket: DueBucket;
  readonly category: 'business-cogs' | 'business-marketing' | 'business-opex';
  readonly payee: string;
  readonly memo: string;
}

const DAILY_BUCKETS: readonly PaySpec[] = [
  { bucket: 'cogsDue', category: 'business-cogs', payee: 'supplier', memo: '补付销售成本' },
  {
    bucket: 'marketingDue',
    category: 'business-marketing',
    payee: 'advertiser',
    memo: '补付营销费用',
  },
  { bucket: 'opexDue', category: 'business-opex', payee: 'operator', memo: '补付运营费用' },
  // v3 遗留：分类已无法追溯，统一按经营费用补付，且不重复计入费用
  {
    bucket: 'supplyDue',
    category: 'business-opex',
    payee: 'operator',
    memo: '补付历史经营应付（v3 混合口径）',
  },
];

/** 支付日常经营费用应付。只减少现金与负债，不再计费用。 */
export function payDailyPayables(
  state: GameState,
  company: Enterprise,
  nowMinute: number,
): void {
  const monthKey = reportingMonthKey(nowMinute);
  for (const spec of DAILY_BUCKETS) {
    const amount = company[spec.bucket];
    if (amount <= 0) continue;
    const paid = payBusinessExpense(state.finance, company.id, {
      atMinute: nowMinute,
      monthKey,
      operationId: nextOperationId(company, spec.bucket),
      amount,
      to: externalAccount(spec.payee),
      category: spec.category,
      memo: spec.memo,
    });
    company[spec.bucket] -= paid.paid;
  }
}

/** 支付工资负债。只减少现金与负债，不再计费用。 */
export function payPayroll(state: GameState, company: Enterprise, nowMinute: number): void {
  const amount = company.payrollDue;
  if (amount <= 0) return;
  const paid = payBusinessExpense(state.finance, company.id, {
    atMinute: nowMinute,
    monthKey: reportingMonthKey(nowMinute),
    operationId: nextOperationId(company, 'wage'),
    amount,
    to: externalAccount('staff'),
    category: 'business-wages',
    memo: '支付高管工资',
  });
  company.payrollDue -= paid.paid;
  if (paid.paid > 0) {
    const assignment = assignmentOf(state.talent, company.id);
    if (assignment) recordWagePayment(assignment, paid.paid);
  }
}

/** 尽力付清全部应付（出资、恢复经营、清算时使用）。 */
export function tryPayPayables(state: GameState, company: Enterprise, nowMinute: number): void {
  payDailyPayables(state, company, nowMinute);
  payPayroll(state, company, nowMinute);
}

/** 立即支付一笔研发投入（不计入日常费用检查点）。 */
export function payResearch(
  state: GameState,
  company: Enterprise,
  amountCents: number,
  memo: string,
  nowMinute: number,
): number {
  if (amountCents <= 0) return 0;
  const paid = payBusinessExpense(state.finance, company.id, {
    atMinute: nowMinute,
    monthKey: reportingMonthKey(nowMinute),
    operationId: nextOperationId(company, 'research'),
    amount: amountCents,
    to: externalAccount('supplier'),
    category: 'business-research',
    memo,
  });
  accrue(company, 'research', amountCents);
  return paid.paid;
}

/* ------------------------------------------------------------ 日界 */

/**
 * 日界：结清刚结束时段的销售与费用，然后集中付款、检查危机。
 * 不做 AI 决策——决策由 timeAdvance 在月结之后统一执行，
 * 避免月初立项的研发费被记进上月报表。
 */
/**
 * 日界记录「最新发布产品」当天的实际销量。
 *
 * 数据来源只有统一销售结算（totalUnits 的增量），不在界面或证券模块另算。
 *
 * 关键：只有**观察区间覆盖了刚结束的整个游戏日**，才写入一条「完整日」样本。
 *  - 观察起点（`dailyObservationStartMinute`）晚于该日零点（中途发布、中途迁移的旧档），
 *    说明这段区间不足一天：只更新累计销量快照与观察起点，不写入样本，
 *    避免把「23:59 发布 + 午夜」算成一天零销量，反过来压低估值。
 *  - 覆盖完整日时才记录增量；随后无论是否记录，都把起点推进到该日界。
 *    因此同一天被日界与月界各处理一次时，第二次的起点已等于边界，不会重复记录。
 *  - 「刚结束的那一天」用统一日历求日序号（boundaryMinute − 1），不用累计分钟整除。
 */
function recordDailySalesOfLatestProduct(
  state: GameState,
  company: Enterprise,
  boundaryMinute: number,
): void {
  const tech = ensureTechCompany(state.technology, company.id);
  const latest = latestProductForWrite(tech);
  if (!latest) return;

  const dayLength = TIME.calendar.minutesPerDay;
  // 刚结束的完整游戏日区间是 [boundaryMinute − 一天, boundaryMinute)
  const dayStartMinute = boundaryMinute - dayLength;
  const day = daySerialAtMinute(Math.max(0, boundaryMinute - 1), TIME.calendar);
  const covered = latest.dailyObservationStartMinute <= dayStartMinute;
  const delta = latest.totalUnits - latest.daySnapshotUnits;

  latest.daySnapshotUnits = latest.totalUnits;
  latest.dailyObservationStartMinute = boundaryMinute;
  if (!covered) return;
  recordDailyUnits(latest, day, Math.max(0, delta), PRODUCT_STOCK_RULES.maxDailyRecords);
}

export function processDayBoundary(
  state: GameState,
  boundaryMinute: number,
  atMonthBoundary: boolean,
): BusinessEvent[] {
  const events: BusinessEvent[] = [];
  const monthKey = reportingMonthKey(boundaryMinute);

  for (const company of Object.values(state.enterprises.companies)) {
    if (isClosed(company)) continue;

    settleCompanySales(state, company, boundaryMinute);
    settleCompanyExpensesTo(state, company, boundaryMinute);
    recordDailySalesOfLatestProduct(state, company, boundaryMinute);
    payDailyPayables(state, company, boundaryMinute);
    // 月界与日界是同一刻时不能滚动当月累计：月报还没固化，
    // 先切到新月份会把上月数字清零（交给 processBusinessMonthEnd 处理）。
    if (!atMonthBoundary) rollAccrualMonth(company, monthKey);

    // 工资在月末才到期，日界只用「日常费用是否付得出」判定危机
    if (company.status === 'active' && dailyPayablesOf(company) > 0) {
      enterCrisis(company, boundaryMinute);
      events.push({
        companyId: company.id,
        companyName: company.name,
        kind: 'crisis',
        detail: `资金不足，未付经营费用 ${(dailyPayablesOf(company) / 100).toFixed(2)} 元`,
      });
    }
  }
  return events;
}

/* ------------------------------------------------------------ 月界 */

/**
 * 月界：先补完旧月份的收入与费用（月界不一定在午夜），再支付工资、固化报表、切到新月份。
 * 个人月结由调用方在此之前完成。
 */
export function processBusinessMonthEnd(
  state: GameState,
  info: MonthBoundaryInfo,
): BusinessEvent[] {
  const { monthKey, boundaryMinute } = info;
  const nextMonthKey = reportingMonthKey(boundaryMinute);
  const events: BusinessEvent[] = [];

  for (const company of Object.values(state.enterprises.companies)) {
    if (isClosed(company)) continue;

    settleCompanySales(state, company, boundaryMinute);
    settleCompanyExpensesTo(state, company, boundaryMinute);
    payDailyPayables(state, company, boundaryMinute);
    payPayroll(state, company, boundaryMinute);

    const cash = businessBalance(state.finance, company.id);
    closeAccrualMonth(company, monthKey, nextMonthKey, boundaryMinute, cash);

    if (company.status === 'active' && payablesOf(company) > 0) {
      enterCrisis(company, boundaryMinute);
      events.push({
        companyId: company.id,
        companyName: company.name,
        kind: 'crisis',
        detail: `月末应付未清 ${(payablesOf(company) / 100).toFixed(2)} 元`,
      });
    }
  }
  return events;
}

/* ------------------------------------------------------------ 研发完成 */

export interface ResearchEvent {
  readonly companyId: string;
  readonly companyName: string;
  readonly productId: string;
}

export function processResearchCompletion(
  state: GameState,
  nowMinute: number,
): ResearchEvent[] {
  const events: ResearchEvent[] = [];
  for (const company of Object.values(state.enterprises.companies)) {
    if (isClosed(company)) continue;
    const tech = ensureTechCompany(state.technology, company.id);
    if (!isProjectDue(tech, nowMinute)) continue;
    const product = completeProject(tech, nowMinute);
    if (product) {
      events.push({
        companyId: company.id,
        companyName: company.name,
        productId: product.id,
      });
    }
  }
  return events;
}

/* ------------------------------------------------------------ AI 决策 */

/** 按当前售价与销量估算的日毛利（分），用于 AI 判断是否停售。 */
export function dailyProfitOf(
  state: GameState,
  tech: TechCompanyState,
  product: Product,
): number {
  const estimate = estimateSales({
    groups: state.population.groups,
    attributes: product.attributes,
    marketingDailyCents: product.marketingDailyCents,
    generationFactor: generationFactorOf(tech, product),
  });
  const revenue = estimate.dailyUnits * product.priceCents;
  // 与实际结算一致：使用当前政策下的有效单位成本
  const cost = estimate.dailyUnits * product.unitCostCents * activePolicyEffects(state).salesCostMultiplier;
  return Math.round(revenue - cost - product.marketingDailyCents);
}

function aiSnapshotOf(state: GameState, company: Enterprise, nowMinute: number): AiSnapshot {
  const tech = ensureTechCompany(state.technology, company.id);
  const year = yearAt(nowMinute);
  const products: AiProductSnapshot[] = tech.products
    .filter((product) => product.releasedAtMinute !== null)
    .map((product) => ({
      id: product.id,
      onSale: product.onSale,
      generation: product.generation,
      dailyProfitCents: dailyProfitOf(state, tech, product),
    }));
  const crisisDays =
    company.status === 'crisis' && company.crisisSinceMinute !== null
      ? Math.floor((nowMinute - company.crisisSinceMinute) / TIME.calendar.minutesPerDay)
      : 0;
  return {
    cash: businessBalance(state.finance, company.id),
    payables: payablesOf(company),
    techLevel: tech.accumulation,
    hasProject: tech.project !== null,
    pendingProductCount: pendingProducts(tech).length,
    products,
    status: company.status,
    crisisDays,
    publishBlocked: isPublishBlockedThisYear(tech, year),
  };
}

/**
 * AI 在指定节点执行一次决策。
 * 只应在「该时刻的日结与月结都已完成」之后调用，新产生的研发投入属于新月份/新时段。
 * 同一分钟只执行一次。
 */
/**
 * 没有 CEO（或 CEO 不是玩家）的公司都按 AI 规则运行：
 * 三家 AI 公司用各自参数，玩家失去 CEO 职位的公司用一组中性默认值。
 */
function policyFor(company: Enterprise, techLevel: number): AiPolicyConfig {
  const config = AI_COMPANIES.find((item) => item.id === company.id);
  if (config) {
    return {
      researchDayOptions: config.researchDayOptions,
      researchBudgetCents: config.researchBudgetCents,
      marketingDailyCents: config.marketingDailyCents,
      strategy: config.strategy,
      crisisGraceDays: ENTERPRISE_RULES.crisisGraceDays,
    };
  }
  return {
    researchDayOptions: [90, 180, 360],
    researchBudgetCents: techLevel >= 30 ? 400_000 : 150_000,
    marketingDailyCents: 10_000,
    strategy: 'steady',
    crisisGraceDays: ENTERPRISE_RULES.crisisGraceDays,
  };
}

export function runAiDecisions(
  state: GameState,
  nowMinute: number,
  events: BusinessEvent[] = [],
): void {
  for (const company of Object.values(state.enterprises.companies)) {
    if (isClosed(company)) continue;
    const book = bookOfCompany(state.equity, company.id);
    // 玩家自己在管的公司由玩家决策
    if (book?.ceoId === 'player') continue;
    const config = AI_COMPANIES.find((item) => item.id === company.id);

    let memory = state.businessAi.companies[company.id];
    if (!memory) {
      memory = { lastDecisionMinute: null, productSeq: 1 };
      state.businessAi.companies[company.id] = memory;
    }
    if (memory.lastDecisionMinute === nowMinute) continue;
    memory.lastDecisionMinute = nowMinute;

    const tech = ensureTechCompany(state.technology, company.id);
    const actions = decide(aiSnapshotOf(state, company, nowMinute), policyFor(company, tech.accumulation));

    for (const action of actions) {
      if (action.kind === 'liquidate') {
        liquidateCompany(state, company, nowMinute, action.reason);
        events.push({
          companyId: company.id,
          companyName: company.name,
          kind: 'liquidated',
          detail: action.reason,
        });
        break;
      }
      if (action.kind === 'stop-selling') {
        settleCompanySales(state, company, nowMinute);
        settleCompanyExpensesTo(state, company, nowMinute);
        const product = tech.products.find((item) => item.id === action.productId);
        if (product) stopSelling(product);
        continue;
      }
      if (action.kind === 'set-marketing') {
        // 改营销前先结清旧预算已发生的费用，避免追溯
        settleCompanySales(state, company, nowMinute);
        settleCompanyExpensesTo(state, company, nowMinute);
        const product = tech.products.find((item) => item.id === action.productId);
        if (product) product.marketingDailyCents = action.dailyCents;
        continue;
      }
      if (action.kind === 'release-product') {
        const pending = pendingProducts(tech)[0];
        if (!pending) continue;
        const suggested = Math.max(
          ENTERPRISE_RULES.minPriceCents,
          pending.unitCostCents * 3,
        );
        releaseProduct(tech, pending, {
          name: `${config?.name ?? company.name} ${String(memory.productSeq).padStart(2, '0')}`,
          priceCents: config ? config.firstProduct.priceCents : suggested,
          marketingDailyCents: config ? config.marketingDailyCents : 10_000,
          nowMinute,
          year: yearAt(nowMinute),
        });
        // 与玩家发布共用同一入口：产品首次上市对股价的一次性反应，同一次提交内完成
        applyProductReleaseImpact(state, company, pending, nowMinute);
        memory.productSeq += 1;
        continue;
      }
      if (action.kind === 'start-research') {
        if (tech.project) continue;
        const cash = businessBalance(state.finance, company.id);
        const budget = Math.min(action.budgetCents, cash);
        if (budget <= 0) continue;
        payResearch(state, company, budget, '产品研发投入', nowMinute);
        // AI 的有效科技水平是固定值，不随投入增长
        tech.project = startProject(tech, {
          days: action.days,
          budgetCents: budget,
          focus: config?.focus ?? 'performance',
          effectiveBase: tech.accumulation,
          // 与玩家共用同一份政策快照：只乘在研发增量部分
          researchGrowthMultiplier: activePolicyEffects(state).researchGrowthMultiplier,
          startMinute: nowMinute,
          monthKey: reportingMonthKey(nowMinute),
        });
      }
    }
  }
}

/* ------------------------------------------------------------ 清算 */

/**
 * 清算：先结清销售与费用检查点，再支付企业应付，最后按有效持股分配剩余现金、
 * 终止证券、释放人才与未完成的资本承诺，并关闭公司。
 *
 * 口径固定：
 *  - 分配顺序是「先付应付、再分剩余」，库存股不参与分配；
 *  - 分配后证券终止：不再生成行情、不能交易、剩余股权价值为 0；
 *  - 玩家的清算回收款与剩余持仓成本一次性形成最终投资结果（已实现盈亏），
 *    资金进入个人账户后不再按股票市值重复计入；
 *  - 股数、成本与成交记录保留，不删除记录冒充「已结清」；
 *  - 无力全部清偿时记录未清偿结果，不追索玩家个人资金，游戏继续。
 */
export function liquidateCompany(
  state: GameState,
  company: Enterprise,
  nowMinute: number,
  reason: string,
): void {
  if (isClosed(company)) return;
  settleCompanySales(state, company, nowMinute);
  settleCompanyExpensesTo(state, company, nowMinute);
  tryPayPayables(state, company, nowMinute);

  const cash = businessBalance(state.finance, company.id);
  const remaining = payablesOf(company);
  const monthKey = reportingMonthKey(nowMinute);
  let paidToPlayer = 0;

  if (cash > 0) {
    const book = bookOfCompany(state.equity, company.id);
    const base = book ? effectiveShares(book) : 0;
    if (book && base > 0) {
      // 多股东：按有效持股分配剩余现金；库存股不参与分配
      for (const [holderId, holderShares] of Object.entries(book.holdings)) {
        if (holderShares <= 0) continue;
        const cut = Math.floor((cash * holderShares) / base);
        if (cut <= 0) continue;
        transferFunds(state.finance, {
          atMinute: nowMinute,
          monthKey,
          operationId: nextOperationId(company, 'liquidate'),
          from: businessAccountRef(company.id),
          to: dividendRecipient(holderId),
          amount: cut,
          category: 'business-liquidation',
          memo: '清算按持股分配',
        });
        if (holderId === 'player') paidToPlayer += cut;
      }
    } else if (company.role === 'player') {
      // 没有股权簿（极早期存档）时退回旧口径：全部给玩家存款
      transferFunds(state.finance, {
        atMinute: nowMinute,
        monthKey,
        operationId: nextOperationId(company, 'liquidate'),
        from: businessAccountRef(company.id),
        to: dividendRecipient('player'),
        amount: cash,
        category: 'business-liquidation',
        memo: '清算分配（无股权簿回退）',
      });
      paidToPlayer += cash;
    } else {
      // AI 的清算余额回到外部投资人，不进入玩家账户
      payBusinessExpense(state.finance, company.id, {
        atMinute: nowMinute,
        monthKey,
        operationId: nextOperationId(company, 'liquidate'),
        amount: cash,
        to: externalAccount('investor'),
        category: 'business-liquidation',
        memo: '清算返还投资人',
      });
    }
  }

  // 证券终止：保留历史成交与成本，但此后不再计市值、不能再交易
  const liquidationBook = bookOfCompany(state.equity, company.id);
  const recoveryBase = liquidationBook ? effectiveShares(liquidationBook) : 0;
  const recoveryPerShare = recoveryBase > 0 ? Math.max(0, cash / recoveryBase) : 0;
  for (const securityId of securitiesOfCompany(state.securities, company.id)) {
    // 人口月结的证券观察窗口：按真实每股回收价值结账，不把清算一律当归零
    recordTermination(state, securityId, recoveryPerShare);
    // 城市统计的连续指数窗口同理：用真实回收值结账，样本保留到本窗口结束
    recordCityTermination(state, securityId, recoveryPerShare);
    terminateSecurity(state.securities, securityId, nowMinute);
    settleTerminatedHolding(holdingOf(state.securities, securityId), paidToPlayer, nowMinute);
  }

  // 未完成的资本承诺：报价作废并释放预留，不能让资金继续被锁住
  cancelCapitalCommitments(state, company, nowMinute);

  // 治理：CEO 空缺（由 AI 代管），未决提案随公司清算失效
  const book = bookOfCompany(state.equity, company.id);
  if (book) book.ceoId = null;
  for (const proposal of state.governance.proposals[company.id] ?? []) {
    if (proposal.status !== 'open') continue;
    proposal.status = 'rejected';
    proposal.resolvedAtMinute = nowMinute;
    proposal.note = '公司已清算，提案失效';
  }

  const tech = ensureTechCompany(state.technology, company.id);
  for (const product of tech.products) product.onSale = false;
  tech.project = null;
  state.talent.assignments[company.id] = null;

  closeCompany(
    company,
    nowMinute,
    remaining > 0 ? `${reason}；未清偿 ${(remaining / 100).toFixed(2)} 元` : reason,
  );
}

/**
 * 取消一家公司的未完成资本事项：在途融资申请作废、报价预留全部释放。
 * 清算与公司关闭都走这里，避免预留资金被永久锁在已关闭的申请上。
 */
export function cancelCapitalCommitments(
  state: GameState,
  company: Enterprise,
  nowMinute: number,
): void {
  const application = activeApplication(state.financing, company.id);
  if (!application) return;
  if (application.status !== 'pending' && application.status !== 'quoted') return;
  for (const quote of application.quotes) {
    releaseFunds(state.finance, 'investor', quote.investorId, quote.amountCents, quote.id);
  }
  application.quotes = [];
  application.status = 'rejected';
  application.decidedAtMinute = nowMinute;
}

/**
 * 资本注入后的经营恢复判断（融资成功、接受报价后调用）。
 *
 * 顺序固定：先按现有规则偿付到期应付，再看应付是否清零；
 * 只有应付真正清零才恢复经营 —— 不无条件解除危机，也不会凭空补现金。
 */
export function settleCrisisAfterCapital(
  state: GameState,
  company: Enterprise,
  nowMinute: number,
): { recovered: boolean; payablesLeft: number } {
  if (isClosed(company)) return { recovered: false, payablesLeft: 0 };
  settleCompanySales(state, company, nowMinute);
  settleCompanyExpensesTo(state, company, nowMinute);
  tryPayPayables(state, company, nowMinute);
  const left = payablesOf(company);
  if (company.status === 'crisis' && left === 0) {
    company.status = 'active';
    company.crisisSinceMinute = null;
    return { recovered: true, payablesLeft: 0 };
  }
  return { recovered: false, payablesLeft: left };
}

/* ------------------------------------------------------------ 工资应计 */

/**
 * 每分钟：按任职时间累计工资，并把新增金额同时计入企业应付与当月费用。
 * 暂停经营不会免除在职高管的工资——只要还在任职，就继续计提。
 */
export function accrueBusinessMinutes(
  state: GameState,
  minutes: number,
  monthKey: string,
): void {
  for (const company of Object.values(state.enterprises.companies)) {
    if (isClosed(company)) continue;
    const assignment = assignmentOf(state.talent, company.id);
    if (!assignment) continue;
    const added = accrueWageIncrement(assignment, minutes);
    if (added <= 0) continue;
    rollAccrualMonth(company, monthKey);
    company.payrollDue += added;
    accrue(company, 'wages', added);
  }
}

/* ------------------------------------------------------------ 查询辅助 */

export function playerNeedsAttention(state: GameState): boolean {
  const company = playerEnterprise(state.enterprises);
  return company !== null && company.status === 'crisis';
}

/** 「推进到下一事件」的目标时刻：研发完成。 */
export function nextBusinessEventMinute(state: GameState, nowMinute: number): number | null {
  const company = playerEnterprise(state.enterprises);
  if (!company || isClosed(company)) return null;
  const tech = ensureTechCompany(state.technology, company.id);
  if (!tech.project) return null;
  return tech.project.endMinute > nowMinute ? tech.project.endMinute : null;
}
