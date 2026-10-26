/**
 * 人口模拟编排 —— 自然增长、月度经营观察与阶层流动结算。
 *
 * 职责：
 *  - 从企业真实数据（任职、工资支付与拖欠、研发投入、停业与清算）提取经营观察；
 *  - 生成有界的 j/i/p 原始企业指标（企业等权），再由人口模块统一乘 0.30；
 *  - 汇总最近三个完整观察月（权重 0.5 / 0.3 / 0.2）后驱动月度阶层流动；
 *  - 记录结算标识，避免同一个月重复结算。
 *
 * 口径说明：当前可模拟的企业只有少数几家，因此这些指标代表
 * **「可模拟企业样本」**，不是全市实际就业率；界面必须如实标注。
 */

import { monthStartMinute } from '../core/calendar';
import { TIME } from '../content/config';
import { POPULATION_BUSINESS_RULES } from '../content/population';
import { payablesOf, type Enterprise } from '../features/enterprise';
import { assignmentOf, candidateOf } from '../features/talent';
import {
  recordObservationMonth,
  resetGrowthAnchor,
  settleMonthFlow,
  totalPopulationOf,
  weightedBusinessIndicators,
  type BusinessMonthSample,
  type MarketMonthSample,
  type PopulationMonthRecord,
} from '../features/population';
import { beginMarketMonth, finalizeMarketMonth } from './population-market';
import type { GameState } from './state';

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(min, value));
}

/** 单家企业的当月经营观察。 */
interface CompanyObservation {
  readonly j: number;
  readonly i: number;
  readonly p: number;
}

/**
 * 单个企业的指标：
 *  - J：任职岗位覆盖与工资水平（正），减去工资拖欠（负）；
 *  - I：实际研发投入与高能力岗位；
 *  - P：工资拖欠、其他经营拖欠、非正常经营时长与当月清算。
 */
function observeCompany(
  state: GameState,
  company: Enterprise,
  monthKey: string,
  monthStart: number,
  monthEnd: number,
  monthMinutes: number,
): CompanyObservation | null {
  const report = company.reports.find((item) => item.monthKey === monthKey);
  let jobWages = 0;
  let researchSpend = 0;
  if (report) {
    jobWages = report.wages;
    researchSpend = report.research;
  } else if (
    company.closedAtMinute !== null &&
    company.closedAtMinute >= monthStart &&
    company.closedAtMinute <= monthEnd
  ) {
    // 当月清算：公司不会再走一次月报固化，但 `accrual` 仍是真实的当月累计
    // （清算前已调用真实销售/费用结算）。用它生成当月观察，不伪造报表、不补造现金。
    if (company.accrual.monthKey !== monthKey) return null;
    jobWages = company.accrual.wages;
    researchSpend = company.accrual.research;
  } else {
    return null;
  }

  const assignment = assignmentOf(state.talent, company.id);
  const candidate = candidateOf(assignment);
  const hiredAt = assignment ? Math.max(assignment.hiredAtMinute, monthStart) : monthStart;
  const employedMinutes = assignment
    ? clamp(monthEnd - hiredAt, 0, monthMinutes)
    : 0;
  const coverage = clamp(employedMinutes / monthMinutes, 0, 1);
  const wageLevel = candidate
    ? clamp(
        candidate.monthlySalaryCents / POPULATION_BUSINESS_RULES.wageReferenceCents,
        0,
        1,
      )
    : 0;

  const wageArrearsDenominator = Math.max(
    POPULATION_BUSINESS_RULES.wageArrearsFloorCents,
    jobWages,
  );
  const wageArrears = clamp(company.payrollDue / wageArrearsDenominator, 0, 1);

  const j = clamp(
    POPULATION_BUSINESS_RULES.weights.jobCoverage * coverage +
      POPULATION_BUSINESS_RULES.weights.wageLevel * coverage * wageLevel -
      wageArrears,
    -1,
    1,
  );

  const researchRatio = clamp(
    researchSpend / POPULATION_BUSINESS_RULES.researchReferenceCents,
    0,
    1,
  );
  const highSkill =
    candidate && candidate.ability >= POPULATION_BUSINESS_RULES.highSkillAbility ? coverage : 0;
  const i = clamp(
    POPULATION_BUSINESS_RULES.weights.research * researchRatio +
      POPULATION_BUSINESS_RULES.weights.highSkill * highSkill,
    -1,
    1,
  );

  const otherDue =
    company.cogsDue + company.marketingDue + company.opexDue + company.supplyDue;
  const otherArrears = clamp(
    otherDue / POPULATION_BUSINESS_RULES.otherArrearsReferenceCents,
    0,
    1,
  );
  const crisisStart =
    company.crisisSinceMinute !== null ? Math.max(company.crisisSinceMinute, monthStart) : null;
  const inactiveRatio =
    company.status === 'crisis' && crisisStart !== null
      ? clamp((monthEnd - crisisStart) / monthMinutes, 0, 1)
      : company.status === 'paused'
        ? 0.5
        : 0;
  const liquidated =
    company.closedAtMinute !== null &&
    company.closedAtMinute >= monthStart &&
    company.closedAtMinute <= monthEnd
      ? 1
      : 0;
  const p = clamp(
    POPULATION_BUSINESS_RULES.weights.wageArrears * wageArrears +
      POPULATION_BUSINESS_RULES.weights.otherArrears * otherArrears +
      POPULATION_BUSINESS_RULES.weights.inactive * inactiveRatio +
      POPULATION_BUSINESS_RULES.weights.liquidation * liquidated,
    0,
    1,
  );

  return { j, i, p };
}

/**
 * 采集刚结束月份的经营观察样本（企业等权平均）。
 * 没有任何可观察企业时返回中性样本（j=i=p=0），不虚构就业数据。
 */
export function captureBusinessMonth(
  state: GameState,
  monthKey: string,
  monthStart: number,
  monthEnd: number,
  monthMinutes: number,
  complete: boolean,
): BusinessMonthSample {
  const rows: CompanyObservation[] = [];
  for (const company of Object.values(state.enterprises.companies)) {
    // 清算发生在该月月初（含月界当刻）时仍属于「本月清算」，下个月不再重复计入
    if (company.closedAtMinute !== null && company.closedAtMinute < monthStart) continue;
    const observed = observeCompany(
      state,
      company,
      monthKey,
      monthStart,
      monthEnd,
      monthMinutes,
    );
    if (observed) rows.push(observed);
  }
  if (rows.length === 0) return { monthKey, j: 0, i: 0, p: 0, complete };
  const sum = rows.reduce(
    (acc, row) => ({ j: acc.j + row.j, i: acc.i + row.i, p: acc.p + row.p }),
    { j: 0, i: 0, p: 0 },
  );
  return {
    monthKey,
    j: sum.j / rows.length,
    i: sum.i / rows.length,
    p: sum.p / rows.length,
    complete,
  };
}

/**
 * 月度人口结算（应用层唯一入口）：
 *   1. 采集刚结束月份的经营观察样本；
 *   2. 结算市场观察窗口，得到等权月回报与涨跌覆盖比例；
 *   3. 落账观察样本，按三个月权重得到本月的 j/i/p；
 *   4. 结算阶层流动（人口模块内部统一乘 0.30）；
 *   5. 重置自然增长锚点。
 *
 * 政治群体满意度**不在这里**：它由 `app/politics-simulation` 在同一月界、
 * 人口月结之后用这份真实经济摘要协调更新（人口系统只负责自己的增长与阶层流动）。
 */
export function settlePopulationMonth(
  state: GameState,
  input: { monthKey: string; monthIndex: number; boundaryMinute: number },
): PopulationMonthRecord {
  const calendar = TIME.calendar;
  const monthStart = monthStartMinute(input.monthIndex, calendar);
  const monthMinutes = input.boundaryMinute - monthStart;
  const complete = state.population.businessObservationStartMinute <= monthStart;

  const businessSample = captureBusinessMonth(
    state,
    input.monthKey,
    monthStart,
    input.boundaryMinute,
    monthMinutes,
    complete,
  );
  const marketSummary = finalizeMarketMonth(state);
  const marketSample: MarketMonthSample = {
    monthKey: input.monthKey,
    returnRate: marketSummary.returnRate,
    downRatio: marketSummary.downRatio,
    upRatio: marketSummary.upRatio,
    valid: marketSummary.valid,
  };
  recordObservationMonth(state.population, businessSample, marketSample);

  const weighted = weightedBusinessIndicators(state.population);
  const growthPeople = totalPopulationOf(state.population) - state.population.growthAnchorTotal;

  const record = settleMonthFlow(state.population, {
    monthKey: input.monthKey,
    settledAtMinute: input.boundaryMinute,
    business: weighted,
    market: marketSummary,
    growthPeople,
  });

  resetGrowthAnchor(state.population, input.boundaryMinute);
  return record;
}

/** 新月份开始时固定证券观察窗口（必须在月界结算之后调用）。 */
export function startPopulationMonth(state: GameState, monthKey: string, minute: number): void {
  beginMarketMonth(state, monthKey, minute);
}

/** 供界面核对：企业当前应付总额（展示「可模拟企业样本」规模）。 */
export function sampledPayablesOf(state: GameState): number {
  let total = 0;
  for (const company of Object.values(state.enterprises.companies)) {
    if (company.status === 'closed') continue;
    total += payablesOf(company);
  }
  return total;
}
