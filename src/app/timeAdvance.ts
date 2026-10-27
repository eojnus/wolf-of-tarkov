/**
 * 统一时间推进 —— 所有时间入口（自然流逝、工作、休息、睡觉、企业推进到下一事件）
 * 都只能走这里。没有任何第二套定时器。
 *
 * 同一时间点的处理顺序固定，任何入口都不例外：
 *   a. 个人工资应计、个人贷款利息计提、企业高管工资应计与营销/运营费应计
 *   b. 股票行情节点（跨几个处理几个）
 *   c. 日界：各公司当日销售、费用付款、危机检查
 *   d. 月界：
 *      1. 个人月结 → 企业工资付款与企业月报（旧月销售与费用在这里结清）
 *      2. 到期旧建设项目先完成
 *      3. 固化本月经营产出统计与股市指数窗口
 *      4. 经济人口月结（经营观察 + 市场窗口 → 阶层流动）
 *      4.5 住房月结（家庭数 → 收入/消费 → 需求 → 成交 → 指标固化）
 *      5. 政治满意度更新（引用人口摘要 + 住房压力）
 *      6. 提前选举条件检查
 *      7. 到期选举、真实新任期与属性切换（零票重选不建任期）
 *      8. 本任期唯一一次建设判断
 *      9. 新月份观察窗口正确开启
 *     10. 同时刻后续 AI 决策（使用新政策）
 *   e. 个人贷款到期扣款
 *   f. 研发完成
 *   g. AI 决策（同一节点只执行一次，且一定在该时刻的日结/月结完成之后）
 *   h. 汇总关键事件，决定是否停止本次跳时
 *
 * 关键时序修正：
 *  - 月界不在 onElapsed 里提前执行政府到期检查（避免用旧人口/旧满意度/未结清 GDP 开票）；
 *  - 非月界同一分钟投票与 AI 决策相遇时，先完成选举，再执行新阶段 AI 决策；
 *  - 股票旧月窗口必须先固化再重建，不能先重置丢掉涨跌。
 *
 * 所有步骤都在同一次状态提交的草稿上完成：不逐条重绘界面、不逐条保存、不逐条弹提示。
 * 核心只负责「走了多少分钟、有没有到月界、要不要停」，不认识上面任何一条业务规则。
 */

import { advanceClock } from '../core/clock';
import type { AdvanceSegment } from '../core/clock';
import { dateAtMinute, monthEndBoundaryMinute, monthIndexAtMinute } from '../core/calendar';
import type { CalendarConfig } from '../core/calendar';
import { TIME, type JobConfig } from '../content/config';
import { advanceEnvironment } from '../features/environment';
import { advanceSurvival, workEfficiencyOf } from '../features/survival';
import { accrueWork } from '../features/employment';
import { accrueInterest, settleDue } from '../features/loan';
import { expirePromotion } from '../features/promotion';
import {
  accrueBusinessMinutes,
  reportingMonthKey,
  processBusinessMonthEnd,
  processDayBoundary,
  processResearchCompletion,
  runAiDecisions,
  type BusinessEvent,
  type ResearchEvent,
} from './business-settlement';
import {
  processFinancingResponses,
  processShareholderProposals,
  releaseStaleReservations,
  resolveDueProposals,
  runAiCapitalDecisions,
} from './capital-simulation';
import { settleMonth } from './monthly';
import { advanceSecurities } from './securities-settlement';
import { advanceNaturalGrowth } from '../features/population';
import { deliveryOf } from '../features/city-development';
import { activeTermOf } from '../features/government';
import {
  processGovernmentDay,
  processGovernmentMinute,
  type GovernmentFeedEvent,
} from './government-simulation';
import {
  settlePopulationMonth,
  startPopulationMonth,
} from './population-simulation';
import { checkEarlyElection, updatePoliticsMonth } from './politics-simulation';
import { completeDueProjects } from './city-development';
import { rollCityOutputMonth, snapshotCityMonth } from './city-statistics';
import { beginCityIndexMonth } from './city-stock-index';
import { tryCreateCityEnterprise } from './city-enterprises';
import { expireLandOffers } from './real-estate';
import { settleHousingMonth } from './housing-simulation';
import { managedCompany, type GameState, type MonthReport } from './state';

/** 一次推进中发生的贷款到期事件，供上层汇总提示。 */
export interface LoanDueEvent {
  readonly paidInterest: number;
  readonly paidPrincipal: number;
  readonly settled: boolean;
  readonly overdue: boolean;
}

/** 城市侧的可见事件（新区落成、招商成功），只用于提示。 */
export interface CityEvent {
  readonly kind: 'district-completed' | 'enterprise-founded';
  readonly message: string;
}

export interface AdvanceResult {
  readonly monthsSettled: number;
  readonly marketTicks: number;
  /** 本段时间内生成的融资报价数量（用于提示，不逐条弹窗）。 */
  readonly financingResponses: number;
  readonly wagesEarned: number;
  /** 本次推进中实际出勤分钟（非工作推进为 0）。 */
  readonly workedMinutes: number;
  /** 本次推进中按区间开始效率折算后的有效计薪分钟（可含 0.5 分钟）。 */
  readonly effectiveWorkMinutes: number;
  readonly reports: MonthReport[];
  readonly loanDueEvents: LoanDueEvent[];
  readonly businessEvents: BusinessEvent[];
  readonly researchCompletions: ResearchEvent[];
  /** 竞选开启、选举、提前选举与换届事件（供上层汇总提示）。 */
  readonly governmentEvents: GovernmentFeedEvent[];
  /** 城区扩张与招商事件。 */
  readonly cityEvents: CityEvent[];
  readonly advancedMinutes: number;
  readonly remainingMinutes: number;
  readonly stopReason: string | null;
}

export interface AdvanceGameTimeOptions {
  /** 本段时间是否在上班。给了 job 即视为工作，工资按段归属到对应月份。 */
  readonly job?: JobConfig | null;
  /** 为 false 时忽略关键事件，不提前停止（自然流逝用）。 */
  readonly honorKeyEvents?: boolean;
}

/** 内部累加器（可变），对外只暴露只读的 AdvanceResult。 */
interface Accumulator {
  monthsSettled: number;
  marketTicks: number;
  financingResponses: number;
  wagesEarned: number;
  workedMinutes: number;
  effectiveWorkMinutes: number;
  reports: MonthReport[];
  loanDueEvents: LoanDueEvent[];
  businessEvents: BusinessEvent[];
  researchCompletions: ResearchEvent[];
  governmentEvents: GovernmentFeedEvent[];
  cityEvents: CityEvent[];
  stopReason: string | null;
}

function isMonthBoundary(segment: AdvanceSegment, calendar: CalendarConfig): boolean {
  const monthIndex = monthIndexAtMinute(segment.startMinute, calendar);
  return segment.startMinute + segment.minutes === monthEndBoundaryMinute(monthIndex, calendar);
}

/**
 * 当前玩家公司 id：复用 features/enterprise 的统一口径，已清算的公司不算。
 * 研发完成、危机识别与企业界面因此指向同一家公司。
 */
function playerCompanyIdOf(draft: GameState): string | null {
  return managedCompany(draft)?.id ?? null;
}

/** 宣传到期后复位，避免界面长期显示「进行中」。 */
function expirePromotions(draft: GameState, nowMinute: number): void {
  for (const companyId of Object.keys(draft.promotion.byCompany)) {
    expirePromotion(draft.promotion, companyId, nowMinute);
  }
}

function trySettleLoanDue(draft: GameState, nowMinute: number, result: Accumulator): void {
  const contract = draft.loan.contract;
  if (!contract || contract.status !== 'active') return;
  if (contract.dueMinute > nowMinute) return;

  const outcome = settleDue(
    draft.loan,
    draft.finance,
    {
      // 到期自动扣款的独立标识，避免与玩家主动还款的操作前缀混淆
      operationId: `loan-expiry:${contract.startMinute}`,
      atMinute: nowMinute,
      monthKey: dateAtMinute(nowMinute, TIME.calendar).monthKey,
    },
    nowMinute,
  );
  if (!outcome) return;

  result.loanDueEvents.push({
    paidInterest: outcome.interestPaid,
    paidPrincipal: outcome.principalPaid,
    settled: outcome.settled,
    overdue: draft.loan.contract?.status === 'overdue',
  });
}

/** 处理研发完成；返回本次是否有玩家公司的项目完成。 */
function runResearch(draft: GameState, nowMinute: number, result: Accumulator): boolean {
  const events = processResearchCompletion(draft, nowMinute);
  if (events.length === 0) return false;
  result.researchCompletions.push(...events);
  const playerId = playerCompanyIdOf(draft);
  return playerId !== null && events.some((event) => event.companyId === playerId);
}

/** 关键事件（危机、清算）中属于玩家公司的那一条，用于设定停止原因。 */
function noteBusinessEvents(
  draft: GameState,
  events: BusinessEvent[],
  result: Accumulator,
  honor: boolean,
): void {
  if (events.length === 0) return;
  result.businessEvents.push(...events);
  if (!honor || result.stopReason !== null) return;
  const playerId = playerCompanyIdOf(draft);
  if (playerId === null) return;
  const mine = events.find((event) => event.companyId === playerId);
  if (mine?.kind === 'crisis') {
    result.stopReason = '你的公司进入资金危机，时间已暂停推进';
  }
}

/** 完成到期的旧建设项目：返回城市事件（新区落成）。 */
function runDueProjects(draft: GameState, nowMinute: number, result: Accumulator): void {
  for (const completion of completeDueProjects(draft, nowMinute)) {
    result.cityEvents.push({
      kind: 'district-completed',
      message: `第 ${completion.stage + 1} 阶段城区建设完成（${completion.districtId}）`,
    });
  }
}

/**
 * 满意度输入 C：全城生活成本恶化。
 *
 * 当前版本**没有**任何真实的全城物价 / 居民生活成本数据源，因此这里必须返回中性：
 * 玩家个人月报里的 `newDebt` 是「玩家没付的房租与生活费」，不是城市物价上涨；
 * 玩家投资或赞助后没钱交租，不应因此降低全体市民满意度。
 *
 * 以后若要做这项，必须是独立设计、有真实数据来源的指标（例如分阶层的物价指数），
 * 不能从个人欠租、个人贷款、个人现金或个人购物支出反推全城水平。
 * 接口保留 `hasSample=false`，满意度按中性（C=0）处理。
 */
function cityCostPressureOf(): { value: number; hasSample: boolean } {
  return { value: 0, hasSample: false };
}

/**
 * 推进游戏时间。minutes 必须是整数分钟；不足一分钟的余量由调用方保存。
 * 内部分段粒度固定为 1 分钟，保证到期、行情、日界、月界都落在正确的节点上。
 */
export function advanceGameTime(
  draft: GameState,
  minutes: number,
  options: AdvanceGameTimeOptions = {},
): AdvanceResult {
  const calendar = TIME.calendar;
  const honorKeyEvents = options.honorKeyEvents !== false;
  const result: Accumulator = {
    monthsSettled: 0,
    marketTicks: 0,
    financingResponses: 0,
    wagesEarned: 0,
    workedMinutes: 0,
    effectiveWorkMinutes: 0,
    reports: [],
    loanDueEvents: [],
    businessEvents: [],
    researchCompletions: [],
    governmentEvents: [],
    cityEvents: [],
    stopReason: null,
  };

  const outcome = advanceClock(
    draft.clock,
    minutes,
    calendar,
    {
      onElapsed: (segment) => {
        const segmentEnd = segment.startMinute + segment.minutes;
        const atMonthBoundary = isMonthBoundary(segment, calendar);
        const startDate = dateAtMinute(segment.startMinute, calendar);
        const endDate = dateAtMinute(segmentEnd, calendar);

        // a. 个人工资、个人贷款利息、企业工资与费用应计
        // 工作效率取「区间开始」的生存状态：先计薪，再结算本区间生存消耗，
        // 归零后的后续区间才使用降低后的效率，不能用班次结束状态追溯整个班次。
        if (options.job) {
          // 区间开始效率只计算一次：同一份 E 同时用于计薪与本次推进统计
          const efficiency = workEfficiencyOf(draft.survival);
          result.wagesEarned += accrueWork(draft.employment, options.job, {
            segment,
            dayKey: startDate.dayKey,
            monthKey: startDate.monthKey,
            efficiencyPercent: Math.round(efficiency * 100),
          });
          result.workedMinutes += segment.minutes;
          result.effectiveWorkMinutes += segment.minutes * efficiency;
        }
        // 生存值只在统一时间推进中自然消耗一次：暂停/后台不推进时间，也就不消耗。
        advanceSurvival(draft.survival, segment.minutes);
        accrueInterest(draft.loan, segment.minutes);
        // 用「报表月份」而不按段末时刻取月份：月界那一分钟已属于新月份，跨月段必须按起点归属
        accrueBusinessMinutes(draft, segment.minutes, reportingMonthKey(segment.startMinute));
        // 人口自然增长只认游戏时间：暂停与后台不推进时间，也就不增长
        advanceNaturalGrowth(draft.population, segmentEnd);
        // 环境天气调度同样只认游戏分钟：按目标时刻直接求解，跳时不会逐帧重播历史，
        // 也不影响任何经济结算的顺序
        advanceEnvironment(draft.environment, segmentEnd);

        // b. 行情节点：跨过几个就处理几个
        result.marketTicks += advanceSecurities(draft, segmentEnd);

        // 资本节点：报价回应、报价过期、宣传衰减（与行情同一个时间粒度）
        result.financingResponses += processFinancingResponses(draft, segmentEnd);
        releaseStaleReservations(draft, segmentEnd);
        expirePromotions(draft, segmentEnd);

        // c. 日界：销售结算、费用付款、危机检查（不含 AI 决策）
        const isDayBoundary = endDate.minuteOfDay === 0;
        if (isDayBoundary) {
          noteBusinessEvents(
            draft,
            processDayBoundary(draft, segmentEnd, atMonthBoundary),
            result,
            honorKeyEvents,
          );
          // 土地收购报价按游戏日到期：只释放该单据的预留，不重复承诺同一笔资金
          expireLandOffers(draft, segmentEnd);
          // 治理与竞选资源检查排在该时刻的经营结算之后；月界时整段推后到月结完成之后（见 onMonthEnd），
          // 同一个日界只执行一次，不重复检查也不提前用未结算的结果做判断。
          if (!atMonthBoundary) {
            // 竞选资源按日使用：按实际经过时间折算，不满一天不按整天算
            processGovernmentDay(draft, segmentEnd, result.governmentEvents);
            resolveDueProposals(draft, segmentEnd);
            processShareholderProposals(draft, segmentEnd);
          }
        }

        // 到期建设项目由游戏时间推进：到点即完成，不等待任何模型下载；
        // 同一时刻的「旧项目完成」必须早于下面的选举与建设判断。
        runDueProjects(draft, segmentEnd, result);

        // 竞选开启与到期选举按**分钟**检查：投票时刻（08:00）不是日界，
        // 不能只挂在日界回调上。必须排在同时刻 AI 决策之前：
        // 同一分钟选举产生的新任期政策要作用于之后的 AI 经营决策。
        // 月界不在 onElapsed 提前执行：那一分钟必须等人口月结与满意度更新完成（见 onMonthEnd）。
        if (!atMonthBoundary) {
          processGovernmentMinute(draft, segmentEnd, result.governmentEvents);

          trySettleLoanDue(draft, segmentEnd, result);

          const playerCompleted = runResearch(draft, segmentEnd, result);
          if (playerCompleted && honorKeyEvents && result.stopReason === null) {
            result.stopReason = '有研发项目完成，时间已暂停推进';
          }

          // g. AI 决策：日界之后、选举与研发之后；同一分钟只会执行一次。
          // 资本决策排在经营决策之前：刚拿到有效报价的公司有机会先偿付应付、恢复经营，
          // 不会因为「先清算」的顺序把可挽救的融资机会吃掉。
          if (isDayBoundary) {
            runAiCapitalDecisions(draft, segmentEnd);
            runAiDecisions(draft, segmentEnd, result.businessEvents);
            // 新区招商：只在日界按既有游戏日节点重试，资金不足时保留待招商
            if (tryCreateCityEnterprise(draft, segmentEnd)) {
              result.cityEvents.push({
                kind: 'enterprise-founded',
                message: '科技新区引入了一家新的真实 AI 企业',
              });
            }
          }
        }
      },
      onMonthEnd: (info) => {
        // 1. 个人月结，再企业月结（企业月结内部会先补齐旧月份的销售与费用）
        result.reports.push(settleMonth(draft, info));
        result.monthsSettled += 1;
        noteBusinessEvents(
          draft,
          processBusinessMonthEnd(draft, info),
          result,
          honorKeyEvents,
        );

        // 2. 到期旧建设项目先完成，再判断新任期建设（同一时刻的顺序要求）
        runDueProjects(draft, info.boundaryMinute, result);

        // 3. 固化本月经营产出统计与股市指数窗口（旧窗口先固化再重建，不能丢涨跌）
        snapshotCityMonth(draft, {
          monthKey: info.monthKey,
          boundaryMinute: info.boundaryMinute,
        });

        // 4. 经济人口月结：经营观察 + 市场窗口 → 阶层流动（人口系统只负责自己的部分）
        settlePopulationMonth(draft, {
          monthKey: info.monthKey,
          monthIndex: info.monthIndex,
          boundaryMinute: info.boundaryMinute,
        });

        // 4.5 住房月结：居民收入/消费入账、需求累积、供需匹配成交、指标固化。
        // 必须排在人口月结之后（家庭数由阶层人数派生）、政治满意度之前（满意度读本月指标）。
        settleHousingMonth(draft, {
          monthKey: info.monthKey,
          monthIndex: info.monthIndex,
          boundaryMinute: info.boundaryMinute,
        });

        // 5. 政治满意度更新（引用同一份真实经济摘要，显式还原 0.30 尺度）
        // 建设履约 D 必须绑定**当前真实任期**：用 currentHolder.termId / activeTermOf 的
        // 真实任期 id，绝不能用含零票重选轮次的 elections.termSeq。前任项目不参与本任期履约。
        const currentTermId = activeTermOf(draft.government)?.id ?? null;
        const delivery = deliveryOf(
          draft.cityDevelopment,
          info.boundaryMinute,
          currentTermId,
        );
        const cost = cityCostPressureOf();
        result.governmentEvents.push(
          ...updatePoliticsMonth(draft, {
            monthKey: info.monthKey,
            costPressure: cost.value,
            hasCostSample: cost.hasSample,
            delivery: delivery.value,
            hasDeliverySample: delivery.hasSample,
          }),
        );

        // 6. 提前选举条件检查（保护期/连续月计数/每任期一次，由政治模块判定）
        result.governmentEvents.push(
          ...checkEarlyElection(draft, {
            monthKey: info.monthKey,
            boundaryMinute: info.boundaryMinute,
          }),
        );

        // 月界恰好是日界时补一次竞选资源使用（与日界分支只执行一次）
        if (dateAtMinute(info.boundaryMinute, calendar).minuteOfDay === 0) {
          processGovernmentDay(draft, info.boundaryMinute, result.governmentEvents);
        }

        // 7–8. 到期选举、真实新任期与属性切换；真实新任期内做唯一一次建设判断
        processGovernmentMinute(draft, info.boundaryMinute, result.governmentEvents);

        // 9. 新月份观察窗口正确开启（指数起始值 = 刚固化的收盘值）
        rollCityOutputMonth(draft, reportingMonthKey(info.boundaryMinute));
        beginCityIndexMonth(
          draft,
          dateAtMinute(info.boundaryMinute, calendar).monthKey,
          info.boundaryMinute,
        );
        startPopulationMonth(
          draft,
          dateAtMinute(info.boundaryMinute, calendar).monthKey,
          info.boundaryMinute,
        );

        // e. 个人贷款到期（明确排在月结之后）
        trySettleLoanDue(draft, info.boundaryMinute, result);

        // f. 研发完成
        const playerCompleted = runResearch(draft, info.boundaryMinute, result);
        if (playerCompleted && honorKeyEvents && result.stopReason === null) {
          result.stopReason = '有研发项目完成，时间已暂停推进';
        }

        // 10. 月界恰好也是日界时，AI 决策在这里补一次（同一分钟去重）。
        // 治理检查放在月结**之后**：提案判断要使用刚固化的报表与应付状态；
        // 顺序与日界一致：资本决策（可能接受报价、恢复经营）先于经营决策（可能清算）。
        if (dateAtMinute(info.boundaryMinute, calendar).minuteOfDay === 0) {
          resolveDueProposals(draft, info.boundaryMinute);
          processShareholderProposals(draft, info.boundaryMinute);
          runAiCapitalDecisions(draft, info.boundaryMinute);
          runAiDecisions(draft, info.boundaryMinute, result.businessEvents);
          if (tryCreateCityEnterprise(draft, info.boundaryMinute)) {
            result.cityEvents.push({
              kind: 'enterprise-founded',
              message: '科技新区引入了一家新的真实 AI 企业',
            });
          }
        }
      },
      // h. 整段（含月界结算）完成后统一检查是否要停
      shouldStop: () => result.stopReason !== null,
    },
    { maxStepMinutes: 1 },
  );

  return {
    monthsSettled: result.monthsSettled,
    marketTicks: result.marketTicks,
    financingResponses: result.financingResponses,
    wagesEarned: result.wagesEarned,
    workedMinutes: result.workedMinutes,
    effectiveWorkMinutes: result.effectiveWorkMinutes,
    reports: result.reports,
    loanDueEvents: result.loanDueEvents,
    businessEvents: result.businessEvents,
    researchCompletions: result.researchCompletions,
    governmentEvents: result.governmentEvents,
    cityEvents: result.cityEvents,
    advancedMinutes: outcome.advancedMinutes,
    remainingMinutes: outcome.remainingMinutes,
    stopReason: result.stopReason,
  };
}
