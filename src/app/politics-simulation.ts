/**
 * 政治模拟编排 —— 月度满意度滚动 + 提前选举监测的跨模块协调。
 *
 * 只在 `app/timeAdvance` 的唯一月界路径里被调用，不持有第二套时钟：
 *  1. 第 5 步：用人口月结刚落账的真实经济摘要更新 12 个群体满意度；
 *  2. 第 6 步：检查提前选举条件；满足时由本层调用 elections 发起提前竞选。
 *
 * 口径约束：
 *  - 当前真实任期只认 `government.currentHolder.termId` / `activeTermOf`，
 *    **不能**用 `elections.termSeq`（它包含零票重选轮次，不是真实任期标识）；
 *  - 满意度与支持率是两件事：本层只维护 0～100 满意度，支持率由 government-simulation
 *    用 `satisfactionScores` 换算成 [-1,1] 评分后再算；
 *  - 成本压力与建设履约来自其它切片的真实观察，由调用方以参数传入，
 *    没有观察样本时按中性处理（不伪造成本、不把「未达门槛」当失信）。
 */

import { EARLY_ELECTION_RULES } from '../content/politics';
import { beginEarlyCampaign } from '../features/elections';
import { activeTermOf } from '../features/government';
import {
  evaluateEarlyElection,
  markEarlyElectionTriggered,
  noteNewTerm,
  updateMonthlySatisfaction,
  type SatisfactionInput,
} from '../features/politics';
import type { GameState } from './state';

export interface PoliticsEvent {
  readonly kind: 'satisfaction-updated' | 'early-election-started';
  readonly message: string;
}

/** 人口月结记录里的经营摘要（已乘 0.30 权重的最终值）；缺失时为 null。 */
function businessOfMonth(
  draft: GameState,
  monthKey: string,
): { readonly j: number; readonly i: number; readonly p: number } | null {
  const records = draft.population.records;
  const last = records[records.length - 1];
  if (!last || last.monthKey !== monthKey) return null;
  return { j: last.business.j, i: last.business.i, p: last.business.p };
}

/**
 * 月度第 5 步：用人口月结刚落账的经济摘要更新 12 群体满意度。
 *
 * 幂等：同一 monthKey 重复调用不再滚动、不再产生事件（读档/重放不会二次扣减或叠加）。
 * 输入由调用方提供成本压力与建设履约；当前执政方向取真实任期快照。
 */
export function updatePoliticsMonth(
  draft: GameState,
  input: {
    monthKey: string;
    costPressure: number;
    hasCostSample: boolean;
    delivery: number;
    hasDeliverySample: boolean;
  },
): PoliticsEvent[] {
  if (draft.politics.lastUpdatedMonthKey === input.monthKey) return [];
  const term = activeTermOf(draft.government);
  const satisfactionInput: SatisfactionInput = {
    // 过渡负责人没有执政方向：M = 0，不给任何候选人方向加分。
    currentDirection: term?.direction ?? null,
    business: businessOfMonth(draft, input.monthKey),
    costPressure: input.costPressure,
    hasCostSample: input.hasCostSample,
    delivery: input.delivery,
    hasDeliverySample: input.hasDeliverySample,
  };
  const average = updateMonthlySatisfaction(
    draft.politics,
    input.monthKey,
    satisfactionInput,
    draft.population.classes,
  );
  return [
    {
      kind: 'satisfaction-updated',
      message: `${input.monthKey} 全市平均满意度 ${average.toFixed(1)}（12 个群体按人数加权）`,
    },
  ];
}

/**
 * 月度第 6 步：提前选举条件检查。
 *
 * - 已在竞选中：不重新启动、不延后投票、不补发基础竞选资源（条件计数照常记录）；
 * - 保护期内：只记录计数，不触发；
 * - 每个真实任期最多一次；零票重选等既有重选机制不受影响；
 * - 触发后满意度恢复也不取消（是否接受由本层按本任期一次性机会处理）。
 */
export function checkEarlyElection(
  draft: GameState,
  input: { monthKey: string; boundaryMinute: number },
): PoliticsEvent[] {
  const term = activeTermOf(draft.government);
  const decision = evaluateEarlyElection(draft.politics, {
    monthKey: input.monthKey,
    nowMinute: input.boundaryMinute,
    termId: term?.id ?? null,
    classes: draft.population.classes,
    campaignActive: draft.elections.phase === 'campaign',
    protectionDays: EARLY_ELECTION_RULES.protectionDays,
  });
  if (!decision.triggered || !term) return [];
  beginEarlyCampaign(draft.elections, input.boundaryMinute, EARLY_ELECTION_RULES.campaignDays);
  markEarlyElectionTriggered(draft.politics, term.id, decision.triggeredMargin);
  return [
    {
      kind: 'early-election-started',
      message:
        decision.reason ??
        `满意度触发提前选举：竞选已开始，${EARLY_ELECTION_RULES.campaignDays} 天后投票`,
    },
  ];
}

/** 真实新任期开始时调用（由选举流程在写入任职记录后调用）：重置保护期与计数。 */
export function noteTermStarted(draft: GameState, termId: string, startMinute: number): void {
  noteNewTerm(draft.politics, termId, startMinute, EARLY_ELECTION_RULES.protectionDays);
}
