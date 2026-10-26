/**
 * 政府模拟 —— 竞选开启、日度资源使用、到期选举、结果生成、真实任期与政策切换。
 *
 * 只在 app/timeAdvance 的唯一推进路径里被调用，不持有第二套时钟。
 *
 * 顺序约束（与统一结算顺序一致）：
 *  1. 到点开启竞选（投票前 30 天，或由满意度提前触发）；
 *  2. 每日按实际经过时间消耗竞选资源；
 *  3. 到投票时刻结算选票：先用旧任期属性结清所有未清算公司的销售与费用区间，
 *     再生成结果、写入真实任职记录（含方向/效果快照）并切换政策；
 *  4. 真实新任期形成后才做**本任期唯一一次**建设判断（使用已结算的正式 GDP）；
 *  5. 之后的 AI 经营决策使用新政策。
 *
 * 零有效票走既有重选机制：不创建新任期、不检查建设、不叠加属性。
 */

import { dateAtMinute } from '../core/calendar';
import { TIME } from '../content/config';
import { POLICY_TO_DEVELOPMENT_DIRECTION } from '../content/city-economy';
import { CANDIDATES, ELECTION_RULES, candidateConfig } from '../content/government';
import { POLITICS_GROUPS } from '../content/politics';
import {
  advertisingOf,
  beginNextCampaign,
  completeElection,
  isCampaignDue,
  scheduleRetry,
  supportScores,
  tallyVotes,
  useCampaignResources,
  type ElectionResult,
  type GroupSupport,
} from '../features/elections';
import { appointGovernmentLeader, isIncumbentCandidate } from '../features/government';
import { groupSizes, satisfactionScores } from '../features/politics';
import { totalPopulationOf } from '../features/population';
import { settleCompanyExpensesTo, settleCompanySales } from './business-settlement';
import { settledGdpCentsOf } from './city-statistics';
import { judgeTermConstruction } from './city-development';
import { noteTermStarted, type PoliticsEvent } from './politics-simulation';
import type { GameState, ReadonlyGameState } from './state';

/** 换届相关的提示事件。 */
export interface GovernmentEvent {
  readonly kind: 'campaign-started' | 'election' | 'retry' | 'appointment';
  readonly message: string;
}

/** 时间推进里汇总的政府/政治事件：换届事件与满意度/提前选举事件共用一条提示通道。 */
export type GovernmentFeedEvent = GovernmentEvent | PoliticsEvent;

/** 现任表现加分的输入（用最近一次结算的经济摘要，缺失时为中性）。 */
function incumbentPerformanceOf(state: ReadonlyGameState): number {
  const records = state.population.records;
  const last = records[records.length - 1];
  if (!last) return 0;
  const raw = 0.8 * last.business.j + 0.5 * last.business.i - last.business.p;
  return Math.min(1, Math.max(-1, raw));
}

/** 12 个交叉群体的预估人数（只派生，不保存第二份人口）。 */
export function groupPeopleOf(state: ReadonlyGameState): {
  groupPeople: Record<string, number>;
  turnout: Record<string, number>;
} {
  const sizes = groupSizes(state.population.classes);
  const groupPeople: Record<string, number> = {};
  const turnout: Record<string, number> = {};
  for (const row of sizes) {
    groupPeople[row.config.id] = row.people;
    turnout[row.config.id] = row.config.turnout;
  }
  return { groupPeople, turnout };
}

/** 计算当前的群体支持率（竞选期间、界面与开票共用同一口径）。 */
export function currentSupportOf(state: ReadonlyGameState): GroupSupport[] {
  const advertising: Record<string, number> = {};
  for (const candidate of CANDIDATES) {
    advertising[candidate.id] = advertisingOf(state.elections, candidate.id);
  }
  // 满意度必须换算成原 [-1,1] 评分口径：(S − 50) / 50
  const satisfaction: Record<string, number> = {};
  for (const [groupId, score] of Object.entries(satisfactionScores(state.politics))) {
    satisfaction[groupId] = score;
  }
  return supportScores({
    groups: POLITICS_GROUPS,
    satisfaction,
    incumbentId: state.government.currentHolder?.candidateId ?? null,
    incumbentPerformance: incumbentPerformanceOf(state),
    advertising,
  });
}

/** 每分钟检查：是否该开启竞选、是否到投票时刻。 */
export function processGovernmentMinute(
  state: GameState,
  nowMinute: number,
  events: GovernmentFeedEvent[],
): void {
  const elections = state.elections;
  if (elections.phase === 'between' && nowMinute >= elections.campaignStartMinute) {
    beginNextCampaign(elections, nowMinute);
    events.push({
      kind: 'campaign-started',
      message: `新一届竞选开始，${ELECTION_RULES.campaignDays} 天后投票`,
    });
  }
  if (!isCampaignDue(elections, nowMinute)) return;
  // 读档可能正好落在投票时刻之后：已结算的届次不再结算，也不让异常打断时间推进
  if (elections.settledTerms.includes(elections.termSeq)) {
    elections.phase = 'between';
    return;
  }
  runElection(state, nowMinute, events);
}

/** 日界：按实际经过时间消耗竞选资源。 */
export function processGovernmentDay(
  state: GameState,
  nowMinute: number,
  _events: GovernmentFeedEvent[],
): void {
  if (state.elections.phase !== 'campaign') return;
  useCampaignResources(state.elections, nowMinute, TIME.calendar.minutesPerDay);
}

/**
 * 到期选举：结算选票、生成结果、写入真实任职记录并切换政策。
 *
 * 政策切换前先用旧政策结清所有未清算公司的销售与费用区间，
 * 保证「同一分钟的旧经营区间用旧政策，之后用新政策」。
 */
function runElection(
  state: GameState,
  nowMinute: number,
  events: GovernmentFeedEvent[],
): void {
  const elections = state.elections;
  // 投票时刻可能落在一天中间：先把这段时间的资源按实际分钟用掉
  useCampaignResources(elections, nowMinute, TIME.calendar.minutesPerDay);

  const monthKey = dateAtMinute(nowMinute, TIME.calendar).monthKey;
  const totalPopulation = totalPopulationOf(state.population);
  const { groupPeople, turnout } = groupPeopleOf(state);

  const support = currentSupportOf(state);
  const tally = tallyVotes({
    totalPopulation,
    groups: POLITICS_GROUPS,
    support,
    groupPeople,
    turnout,
  });

  // 先用旧任期属性结清旧经营区间（销售与费用），再切换政策
  for (const company of Object.values(state.enterprises.companies)) {
    if (company.status === 'closed') continue;
    settleCompanySales(state, company, nowMinute);
    settleCompanyExpensesTo(state, company, nowMinute);
  }

  const result: ElectionResult = completeElection(elections, {
    atMinute: nowMinute,
    monthKey,
    tally,
  });

  if (result.winnerId === null) {
    // 零有效票：过渡负责人留任，30 天后重选。不创建新任期、不检查建设、不叠加属性。
    scheduleRetry(elections, nowMinute);
    events.push({
      kind: 'retry',
      message: `本次选举没有有效票，过渡负责人留任，${ELECTION_RULES.retryDays} 天后重新选举`,
    });
    return;
  }

  const winner = candidateConfig(result.winnerId);
  const term = appointGovernmentLeader(state.government, {
    candidateId: result.winnerId,
    personName: winner.name,
    atMinute: nowMinute,
    note: result.tie
      ? result.tieBreakNote
      : `以 ${result.votes.find((row) => row.candidateId === result.winnerId)?.votes ?? 0} 票当选`,
  });
  // 真实新任期：从实际当选时刻重新计算完整任期与提前选举保护期
  noteTermStarted(state, term.id, nowMinute);

  // 本任期唯一一次建设判断。此时旧区间销售已经结清并入账，待结算产出为零，
  // 因此读取**已结算口径**的正式 GDP（settledGdpCentsOf），与实时界面口径区分，
  // 不叠加实时待结算投影，避免双计。
  judgeTermConstruction(state, {
    termId: term.id,
    direction: POLICY_TO_DEVELOPMENT_DIRECTION[winner.policy],
    atMinute: nowMinute,
    gdpCents: settledGdpCentsOf(state),
  });

  events.push({
    kind: 'appointment',
    message: `${winner.name} 当选${winner.platform}方向负责人${result.tie ? `（${result.tieBreakNote}）` : ''}`,
  });
}

/** 只读查询：现任是否为某位候选人（界面用）。 */
export function incumbentOf(state: GameState): string | null {
  const holder = state.government.currentHolder;
  if (!holder || holder.candidateId === null) return null;
  return isIncumbentCandidate(state.government, holder.candidateId) ? holder.candidateId : null;
}
