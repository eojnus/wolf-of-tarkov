/**
 * 企业界面视图模型 —— 只读，界面只消费这里的结果。
 * 不修改状态，也不把格式化逻辑散落到 DOM 里。
 */

import type { DeepReadonly } from '../core/readonly';
import { dateAtMinute, formatGameDate } from '../core/calendar';
import { formatMoney, formatMoneyCompact } from '../core/money';
import {
  AI_COMPANIES,
  ENTERPRISE_RULES,
  PRODUCT_MARKET,
  TECH,
  TALENT_CANDIDATES,
  FOCUS_OPTIONS,
  type FocusKey,
} from '../content/business';
import { TIME } from '../content/config';
import { equityOf, payablesOf, STATUS_LABELS } from '../features/enterprise';
import { businessBalance, recentBusinessEntries, CATEGORY_LABELS } from '../features/finance';
import { estimateSales } from '../features/market';
import {
  effectiveTechLevel,
  techViewOf,
  focusName,
  generationFactorOf,
  pendingProducts,
  type Product,
  type TechCompanyState,
} from '../features/technology';
import { assignmentOf, candidateOf, candidatePool } from '../features/talent';
import { managedCompany, playerCompanies, type ReadonlyGameState } from './state';
import { activePolicyEffects } from './policy';

export interface AttributeLineView {
  readonly label: string;
  readonly value: string;
}

export interface CandidateView {
  readonly id: string;
  readonly name: string;
  readonly ability: number;
  readonly salaryText: string;
  readonly note: string;
  readonly available: boolean;
  readonly employedByText: string;
}

export interface PendingProductView {
  readonly id: string;
  readonly generatedAtText: string;
  readonly focusName: string;
  readonly quality: number;
  readonly qualityText: string;
  readonly unitCostText: string;
  readonly suggestedPriceText: string;
  readonly attributes: AttributeLineView[];
}

export interface ProductView {
  readonly id: string;
  readonly name: string;
  readonly generation: number;
  readonly generationText: string;
  readonly generationFactorText: string;
  readonly onSale: boolean;
  readonly onSaleText: string;
  readonly priceText: string;
  readonly marketingText: string;
  readonly qualityText: string;
  readonly dailyUnitsText: string;
  readonly unitCostText: string;
  readonly marginText: string;
  readonly totalUnits: number;
  readonly revenueText: string;
  readonly costText: string;
  readonly grossText: string;
  readonly grossPositive: boolean;
}

export interface EnterpriseReportView {
  readonly monthKey: string;
  readonly revenueText: string;
  readonly expenseText: string;
  readonly profitText: string;
  readonly profitPositive: boolean;
  readonly units: number;
  readonly cashText: string;
  readonly payablesText: string;
}

export interface CompetitorView {
  readonly id: string;
  readonly name: string;
  readonly techLevel: number;
  readonly statusText: string;
  readonly cashText: string;
  readonly productCount: number;
  readonly latestProductName: string;
  readonly latestPriceText: string;
  readonly totalUnits: number;
  readonly onSaleCount: number;
}

export interface BusinessView {
  readonly hasCompany: boolean;
  /** 当前玩家公司的稳定 id；没有公司时为空字符串。仅用于界面草稿分区。 */
  readonly id: string;
  readonly canCreate: boolean;
  /** 只有现任 CEO 可以提交经营与资本操作；非 CEO 股东只读。 */
  readonly canManage: boolean;
  readonly createHint: string;
  /** 成立公司的最低初始出资（已格式化），与命令校验使用同一份配置。 */
  readonly createMinCapitalText: string;
  readonly name: string;
  readonly status: string;
  readonly statusText: string;
  readonly isClosed: boolean;
  readonly cash: number;
  readonly cashText: string;
  readonly payables: number;
  readonly payablesText: string;
  readonly equityText: string;
  readonly distributable: number;
  readonly distributableText: string;
  readonly techLevel: number;
  readonly permanentTech: number;
  readonly talentAbility: number;
  readonly talentName: string;
  readonly talentSalaryText: string;
  readonly talentAccruedText: string;
  readonly candidates: CandidateView[];
  readonly hasProject: boolean;
  readonly projectFocusText: string;
  readonly projectDays: number;
  readonly projectElapsedDays: number;
  readonly projectRemainingText: string;
  readonly projectBudgetText: string;
  readonly projectBaseTech: number;
  readonly projectProgressPct: number;
  readonly projectProjected: AttributeLineView[];
  readonly projectEndText: string;
  readonly publishBlocked: boolean;
  readonly publishBlockedText: string;
  readonly pending: PendingProductView[];
  readonly products: ProductView[];
  readonly reports: EnterpriseReportView[];
  readonly competitors: CompetitorView[];
  readonly monthRevenueText: string;
  readonly monthExpenseText: string;
  readonly monthProfitText: string;
  readonly monthProfitPositive: boolean;
  readonly monthUnits: number;
  readonly dividendTotalText: string;
  readonly dueItems: Array<{ readonly label: string; readonly valueText: string }>;
  readonly ledgerRows: Array<{
    readonly id: string;
    readonly timeText: string;
    readonly labelText: string;
    readonly inText: string;
    readonly outText: string;
    readonly categoryText: string;
  }>;
  readonly liquidationNote: string;
  readonly focusOptions: ReadonlyArray<{ readonly id: FocusKey; readonly name: string }>;
  readonly limits: {
    readonly minCapitalText: string;
    readonly maxCapitalText: string;
    readonly minPriceText: string;
    readonly maxPriceText: string;
    readonly maxMarketingText: string;
    readonly minResearchBudgetText: string;
    readonly capDays: number;
    readonly maxPlannedDays: number;
    readonly referenceBudgetText: string;
  };
  readonly savingsText: string;
  readonly currentYear: number;
  readonly marketNote: string;
}

function attrLines(product: DeepReadonly<Product>): AttributeLineView[] {
  return [
    { label: '性能', value: product.attributes.performance.toFixed(1) },
    { label: '可靠性', value: product.attributes.reliability.toFixed(1) },
    { label: '易用性', value: product.attributes.usability.toFixed(1) },
  ];
}

function qualityOfProduct(
  state: ReadonlyGameState,
  product: DeepReadonly<Product>,
): number {
  return estimateSales({
    groups: state.population.groups,
    attributes: product.attributes,
    marketingDailyCents: product.marketingDailyCents,
    generationFactor: 1,
  }).quality;
}

function buildProductView(
  state: ReadonlyGameState,
  tech: DeepReadonly<TechCompanyState>,
  product: DeepReadonly<Product>,
): ProductView {
  const estimate = estimateSales({
    groups: state.population.groups,
    attributes: product.attributes,
    marketingDailyCents: product.marketingDailyCents,
    generationFactor: generationFactorOf(tech, product),
  });
  const gross = product.totalRevenueCents - product.totalCostCents;
  const factor = generationFactorOf(tech, product);
  // 与实际结算一致：展示当前政策下的有效单位成本
  const effectiveUnitCost = Math.round(
    product.unitCostCents * activePolicyEffects(state).salesCostMultiplier,
  );
  return {
    id: product.id,
    name: product.name || '未命名',
    generation: product.generation,
    generationText: `第 ${product.generation} 代`,
    generationFactorText: `×${factor.toFixed(3)}`,
    onSale: product.onSale,
    onSaleText: product.onSale ? '在售' : '已停售',
    priceText: formatMoney(product.priceCents),
    marketingText: `${formatMoneyCompact(product.marketingDailyCents)}/日`,
    qualityText: estimate.quality.toFixed(1),
    dailyUnitsText: estimate.dailyUnits.toFixed(1),
    unitCostText: formatMoney(effectiveUnitCost),
    marginText: formatMoney(product.priceCents - effectiveUnitCost),
    totalUnits: product.totalUnits,
    revenueText: formatMoney(product.totalRevenueCents),
    costText: formatMoney(product.totalCostCents),
    grossText: formatMoney(gross),
    grossPositive: gross >= 0,
  };
}

function buildCompetitors(state: ReadonlyGameState): CompetitorView[] {
  const views: CompetitorView[] = [];
  for (const config of AI_COMPANIES) {
    const company = state.enterprises.companies[config.id];
    if (!company) continue;
    const tech = techViewOf(state.technology, config.id);
    const released = tech.products.filter((product) => product.releasedAtMinute !== null);
    const latest = released[released.length - 1];
    views.push({
      id: config.id,
      name: company.name,
      techLevel: tech.accumulation,
      statusText: STATUS_LABELS[company.status],
      cashText: formatMoney(businessBalance(state.finance, config.id)),
      productCount: released.length,
      latestProductName: latest?.name || '—',
      latestPriceText: latest ? formatMoney(latest.priceCents) : '—',
      totalUnits: released.reduce((sum, product) => sum + product.totalUnits, 0),
      onSaleCount: released.filter((product) => product.onSale).length,
    });
  }
  return views;
}

function emptyView(state: ReadonlyGameState): BusinessView {
  const now = dateAtMinute(state.clock.totalMinute, TIME.calendar);
  return {
    hasCompany: false,
    id: '',
    canCreate: state.finance.accounts.savings >= ENTERPRISE_RULES.minCapitalCents,
    canManage: false,
    createHint:
      state.finance.accounts.savings >= ENTERPRISE_RULES.minCapitalCents
        ? `初始出资从银行存款划入企业账户，不低于 ${formatMoney(
            ENTERPRISE_RULES.minCapitalCents,
          )}（这是创始资本，不是手续费）`
        : `银行存款不足以出资：最低 ${formatMoney(ENTERPRISE_RULES.minCapitalCents)}（创始资本，不是手续费）`,
    createMinCapitalText: formatMoney(ENTERPRISE_RULES.minCapitalCents),
    name: '—',
    status: 'none',
    statusText: '尚未创业',
    isClosed: false,
    cash: 0,
    cashText: '—',
    payables: 0,
    payablesText: '—',
    equityText: '—',
    distributable: 0,
    distributableText: '—',
    techLevel: TECH.initialAccumulation,
    permanentTech: TECH.initialAccumulation,
    talentAbility: 0,
    talentName: '未聘用',
    talentSalaryText: '—',
    talentAccruedText: '—',
    candidates: TALENT_CANDIDATES.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      ability: candidate.ability,
      salaryText: formatMoneyCompact(candidate.monthlySalaryCents),
      note: candidate.note,
      available: true,
      employedByText: '可招聘',
    })),
    hasProject: false,
    projectFocusText: '—',
    projectDays: 0,
    projectElapsedDays: 0,
    projectRemainingText: '—',
    projectBudgetText: '—',
    projectBaseTech: 0,
    projectProgressPct: 0,
    projectProjected: [],
    projectEndText: '—',
    publishBlocked: false,
    publishBlockedText: '',
    pending: [],
    products: [],
    reports: [],
    competitors: buildCompetitors(state),
    monthRevenueText: '—',
    monthExpenseText: '—',
    monthProfitText: '—',
    monthProfitPositive: true,
    monthUnits: 0,
    dividendTotalText: '—',
    dueItems: [],
    ledgerRows: [],
    liquidationNote: '',
    focusOptions: FOCUS_OPTIONS,
    limits: limitsView(),
    savingsText: formatMoney(state.finance.accounts.savings),
    currentYear: now.year,
    marketNote: `抽象市场：日销量 = ${PRODUCT_MARKET.baseDailyUnits} × (Q/${PRODUCT_MARKET.qualityReference})² × 营销 × 代际，售价不影响销量。`,
  };
}

function limitsView() {
  return {
    minCapitalText: formatMoneyCompact(ENTERPRISE_RULES.minCapitalCents),
    maxCapitalText: formatMoneyCompact(ENTERPRISE_RULES.maxCapitalCents),
    minPriceText: formatMoneyCompact(ENTERPRISE_RULES.minPriceCents),
    maxPriceText: formatMoneyCompact(ENTERPRISE_RULES.maxPriceCents),
    maxMarketingText: formatMoneyCompact(PRODUCT_MARKET.maxMarketingDailyCents),
    minResearchBudgetText: formatMoneyCompact(TECH.minResearchBudgetCents),
    capDays: TECH.capDays,
    maxPlannedDays: TECH.maxPlannedDays,
    referenceBudgetText: formatMoneyCompact(TECH.researchReferenceBudgetCents),
  };
}

export function buildBusinessView(state: ReadonlyGameState): BusinessView {
  const company =
    managedCompany(state) ??
    playerCompanies(state).find((item) => item.status !== 'closed') ??
    playerCompanies(state).find((item) => item.status === 'closed') ??
    null;
  if (!company || company.status === 'closed') {
    const base = emptyView(state);
    if (company && company.status === 'closed') {
      return {
        ...base,
        name: company.name,
        status: company.status,
        statusText: STATUS_LABELS[company.status],
        isClosed: true,
        canManage: false,
        liquidationNote: company.liquidationNote ?? '',
        canCreate: state.finance.accounts.savings >= ENTERPRISE_RULES.minCapitalCents,
        createHint: state.finance.accounts.savings >= ENTERPRISE_RULES.minCapitalCents
          ? `可以用银行存款再创办一家新公司（不低于 ${formatMoney(ENTERPRISE_RULES.minCapitalCents)}，是创始资本不是手续费）`
          : '银行存款不足以再次创业',
        createMinCapitalText: formatMoney(ENTERPRISE_RULES.minCapitalCents),
      };
    }
    return base;
  }

  const tech = techViewOf(state.technology, company.id);
  const assignment = assignmentOf(state.talent, company.id);
  const candidate = candidateOf(assignment);
  const cash = businessBalance(state.finance, company.id);
  const payables = payablesOf(company);
  const now = dateAtMinute(state.clock.totalMinute, TIME.calendar);
  const monthExpense =
    company.accrual.cogs +
    company.accrual.wages +
    company.accrual.research +
    company.accrual.marketing +
    company.accrual.opex;
  const monthProfit = company.accrual.revenue - monthExpense;

  const project = tech.project;
  const elapsedMinutes = project ? Math.max(0, state.clock.totalMinute - project.startMinute) : 0;
  const elapsedDays = Math.floor(elapsedMinutes / TIME.calendar.minutesPerDay);
  const remainingDays = project
    ? Math.max(0, Math.ceil((project.endMinute - state.clock.totalMinute) / TIME.calendar.minutesPerDay))
    : 0;

  const pool = candidatePool(state.talent);
  const candidates: CandidateView[] = pool.map((entry) => {
    const ownerId = entry.employedBy;
    const owner =
      ownerId === null
        ? null
        : state.enterprises.companies[ownerId]?.name ?? ownerId;
    return {
      id: entry.candidate.id,
      name: entry.candidate.name,
      ability: entry.candidate.ability,
      salaryText: formatMoneyCompact(entry.candidate.monthlySalaryCents),
      note: entry.candidate.note,
      available: ownerId === null,
      employedByText: ownerId === null ? '可招聘' : `已被${owner}聘请`,
    };
  });

  const products = tech.products
    .filter((product) => product.releasedAtMinute !== null)
    .map((product) => buildProductView(state, tech, product));

  return {
    hasCompany: true,
    id: company.id,
    canCreate: false,
    canManage: managedCompany(state)?.id === company.id,
    createHint: '',
    createMinCapitalText: formatMoney(ENTERPRISE_RULES.minCapitalCents),
    name: company.name,
    status: company.status,
    statusText: STATUS_LABELS[company.status],
    isClosed: false,
    cash,
    cashText: formatMoney(cash),
    payables,
    payablesText: formatMoney(payables),
    equityText: formatMoney(equityOf(company, cash)),
    distributable: Math.max(0, cash - payables),
    distributableText: formatMoney(Math.max(0, cash - payables)),
    techLevel: effectiveTechLevel(tech, candidate?.ability ?? 0),
    permanentTech: tech.accumulation,
    talentAbility: candidate?.ability ?? 0,
    talentName: candidate?.name ?? '未聘用（可用永久积累研发）',
    talentSalaryText: candidate ? `${formatMoneyCompact(candidate.monthlySalaryCents)}/月` : '—',
    // 工资在任职期间逐分钟计入企业应付，因此这里直接读统一负债
    talentAccruedText: formatMoney(company.payrollDue),
    candidates,
    hasProject: project !== null,
    projectFocusText: project ? focusName(project.focus) : '—',
    projectDays: project?.plannedDays ?? 0,
    projectElapsedDays: elapsedDays,
    projectRemainingText: project ? `${remainingDays} 天` : '—',
    projectBudgetText: project ? formatMoney(project.budgetCents) : '—',
    projectBaseTech: project?.effectiveBase ?? 0,
    projectProgressPct: project
      ? Math.min(100, Math.round((elapsedMinutes / (project.plannedDays * TIME.calendar.minutesPerDay)) * 100))
      : 0,
    projectProjected: project
      ? [
          { label: '性能', value: project.projected.performance.toFixed(1) },
          { label: '可靠性', value: project.projected.reliability.toFixed(1) },
          { label: '易用性', value: project.projected.usability.toFixed(1) },
        ]
      : [],
    projectEndText: project
      ? formatGameDate(dateAtMinute(project.endMinute, TIME.calendar))
      : '—',
    publishBlocked: tech.publishedYear === now.year,
    publishBlockedText:
      tech.publishedYear === now.year ? `${now.year} 年已发布过一款产品，下一年度才能再发布` : '',
    pending: pendingProducts(tech).map((product) => {
      const quality = qualityOfProduct(state, product);
      return {
        id: product.id,
        generatedAtText: '研发完成，待上市',
        focusName: '—',
        quality,
        qualityText: quality.toFixed(1),
        unitCostText: formatMoney(
          Math.round(product.unitCostCents * activePolicyEffects(state).salesCostMultiplier),
        ),
        suggestedPriceText: formatMoney(
          Math.round(
            product.unitCostCents *
              activePolicyEffects(state).salesCostMultiplier *
              TECH.suggestedPriceMultiplier,
          ),
        ),
        attributes: attrLines(product),
      };
    }),
    products,
    reports: [...company.reports]
      .slice(-6)
      .reverse()
      .map((report) => ({
        monthKey: report.monthKey,
        revenueText: formatMoney(report.revenue),
        expenseText: formatMoney(report.cogs + report.wages + report.research + report.marketing + report.opex),
        profitText: formatMoney(report.profit),
        profitPositive: report.profit >= 0,
        units: report.units,
        cashText: formatMoney(report.cashEnd),
        payablesText: formatMoney(report.payablesEnd),
      })),
    competitors: buildCompetitors(state),
    monthRevenueText: formatMoney(company.accrual.revenue),
    monthExpenseText: formatMoney(monthExpense),
    monthProfitText: formatMoney(monthProfit),
    monthProfitPositive: monthProfit >= 0,
    monthUnits: company.accrual.units,
    dividendTotalText: formatMoney(company.dividendTotal),
    dueItems: [
      { label: '应付工资', valueText: formatMoney(company.payrollDue) },
      { label: '应付销售成本', valueText: formatMoney(company.cogsDue) },
      { label: '应付营销费', valueText: formatMoney(company.marketingDue) },
      { label: '应付运营费', valueText: formatMoney(company.opexDue) },
      { label: '历史经营应付', valueText: formatMoney(company.supplyDue) },
    ],
    ledgerRows: recentBusinessEntries(state.finance, company.id, 12).map((entry) => {
      const isIncome = entry.from.owner === 'external';
      return {
        id: entry.id,
        timeText: formatGameDate(dateAtMinute(entry.atMinute, TIME.calendar)),
        labelText: entry.memo || CATEGORY_LABELS[entry.category],
        inText: isIncome ? formatMoney(entry.amount) : '',
        outText: isIncome ? '' : formatMoney(entry.amount),
        categoryText: CATEGORY_LABELS[entry.category],
      };
    }),
    liquidationNote: company.liquidationNote ?? '',
    focusOptions: FOCUS_OPTIONS,
    limits: limitsView(),
    savingsText: formatMoney(state.finance.accounts.savings),
    currentYear: now.year,
    marketNote: `抽象市场：日销量 = ${PRODUCT_MARKET.baseDailyUnits} × (Q/${PRODUCT_MARKET.qualityReference})² × 营销 × 代际，售价不影响销量。`,
  };
}
