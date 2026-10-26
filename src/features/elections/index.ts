/**
 * 选举模块 —— 竞选阶段、候选人资源、赞助记录、支持率、票数与选举结果。
 *
 * 边界：
 *  - 不直接操作 finance（扣款由应用层完成）或 government 切片（换届由应用层完成）；
 *  - 不读取完整 GameState；需要的人口与经济数据由应用层以参数传入；
 *  - 随机性只有一处：实际整数票平票时的抽签，使用**独立且持久化**的 PRNG 状态，
 *    不消费股票行情的随机数，读档不会重抽。
 *
 * 资源口径：
 *  - `base`：本届基础竞选资源（每届重置，三位候选人相同）；
 *  - `sponsored`：本届收到的赞助换算成的资源（未使用部分届末失效，不结转）；
 *  - `used`：本届**已实际使用**的资源，宣传影响只按 used 计算。
 *
 * 群体口径：
 *  - 政治群体配置唯一来源是 `content/politics`（3 收入 × 4 利益 = 12 个交叉群体，
 *    含 turnout 与 match）；本模块只消费调用方传入的群体列表，不自己定义群体；
 *  - 群体人数、投票率与满意度评分都由应用层传参，本模块不读人口切片。
 */

import { TIME } from '../../content/config';
import {
  CANDIDATES,
  CAMPAIGN_RULES,
  ELECTION_RULES,
  candidateConfig,
  type CandidateId,
} from '../../content/government';
import type { PoliticsGroupConfig } from '../../content/politics';
import { BusinessError } from '../../core/errors';
import type { DeepReadonly } from '../../core/readonly';
import { largestRemainderSplit } from '../population';

export type CampaignPhase = 'campaign' | 'between';

export interface CandidateCampaignState {
  readonly id: CandidateId;
  /** 本届基础资源。 */
  base: number;
  /** 本届收到的赞助资源。 */
  sponsored: number;
  /** 本届已使用的资源。 */
  used: number;
  /** 资源使用的分子余量（分 × 分钟），保证按实际分钟结算不丢分。 */
  useNumerator: number;
}

export interface SponsorshipRecord {
  /** 唯一操作 id：同一请求重试不会再次扣款。 */
  readonly requestId: string;
  readonly candidateId: CandidateId;
  readonly amountCents: number;
  readonly atMinute: number;
  readonly monthKey: string;
}

export interface CandidateVotes {
  readonly candidateId: CandidateId;
  readonly votes: number;
}

export interface ElectionResult {
  readonly termSeq: number;
  readonly atMinute: number;
  readonly monthKey: string;
  /** 投票时的总人口（浮点快照）。 */
  readonly totalPopulation: number;
  /** 投票时的合格人数（整数）。 */
  readonly eligiblePeople: number;
  /** 投票时的实际参与人数（整数）。 */
  readonly participatingPeople: number;
  /** 各候选人票数（整数，和等于参与人数）。 */
  readonly votes: CandidateVotes[];
  /** 当选人；零有效票时为 null（过渡负责人留任）。 */
  readonly winnerId: CandidateId | null;
  /** 是否发生整数票平票。 */
  readonly tie: boolean;
  /** 平票抽签结果说明（无平票时为空）。 */
  readonly tieBreakNote: string;
  /** 当时是否属于低投票率（界面提示，结果仍然有效）。 */
  readonly lowTurnout: boolean;
}

export interface ElectionState {
  phase: CampaignPhase;
  /** 本届竞选开始时刻（首次为开局时刻）。 */
  campaignStartMinute: number;
  /** 本届投票时刻（到期即结算）。 */
  deadlineMinute: number;
  /** 届序号（从 1 开始）。 */
  termSeq: number;
  /** 三位候选人的本届状态。 */
  candidates: Record<CandidateId, CandidateCampaignState>;
  /** 赞助单据（有限长度，幂等依据）。 */
  sponsorshipRecords: SponsorshipRecord[];
  /** 历史选举结果（有限长度）。 */
  history: ElectionResult[];
  /** 独立平票抽签状态（不与行情共用）。 */
  tieRng: number;
  /** 上次每日资源使用的时间锚点（用于按实际分钟结算）。 */
  lastUsageAnchorMinute: number;
  /** 本届是否已经开过票（防止重复结算同一届）。 */
  settledTerms: number[];
}

/**
 * 一位候选人的初始竞选状态。
 *
 * 基础资源是**每届的真实起点**：新游戏、旧档迁移、后续竞选与零票重选
 * 都从同一份 `CAMPAIGN_RULES.baseResources` 初始化，不能有「首届为 0」的分叉。
 */
function baseCandidateState(id: CandidateId): CandidateCampaignState {
  return { id, base: CAMPAIGN_RULES.baseResources, sponsored: 0, used: 0, useNumerator: 0 };
}

/**
 * 新建选举状态。
 * `firstDeadlineMinute` 是首次投票时刻（游戏分钟）：
 *  - 新游戏：第 30 天 08:00；
 *  - 旧档迁移：迁移时刻 + 30 个游戏日（从接入时刻起安排，不追溯补演）。
 */
export function createElectionState(nowMinute: number, firstDeadlineMinute: number): ElectionState {
  const candidates = {} as Record<CandidateId, CandidateCampaignState>;
  for (const candidate of CANDIDATES) candidates[candidate.id] = baseCandidateState(candidate.id);
  return {
    phase: 'campaign',
    campaignStartMinute: nowMinute,
    deadlineMinute: firstDeadlineMinute,
    termSeq: 1,
    candidates,
    sponsorshipRecords: [],
    history: [],
    tieRng: ELECTION_RULES.tieSeed >>> 0,
    lastUsageAnchorMinute: nowMinute,
    settledTerms: [],
  };
}

/** 开启新一届竞选：重置三位候选人的资源（基础相同、赞助与使用清零）。 */
export function openCampaign(state: ElectionState, startMinute: number, deadlineMinute: number): void {
  state.phase = 'campaign';
  state.campaignStartMinute = startMinute;
  state.deadlineMinute = deadlineMinute;
  state.termSeq += 1;
  state.lastUsageAnchorMinute = startMinute;
  for (const candidate of CANDIDATES) {
    const row = state.candidates[candidate.id];
    row.base = CAMPAIGN_RULES.baseResources;
    row.sponsored = 0;
    row.used = 0;
    row.useNumerator = 0;
  }
}

/**
 * 提前选举启动：与既有竞选开启共用**同一套**资源初始化
 * （届序号 +1、基础资源重置、赞助与已使用清零、资源锚点移到启动时刻），
 * 只是触发来源从「投票前 30 天」变成满意度不足。
 *
 * 不清空赞助单据与历史结果：赞助记录是已发生的真实付款凭证（届末失效不退款），
 * 历史选举结果属于既成事实。已在竞选中时不重复启动（不二次发资源、不延后投票）。
 */
export function beginEarlyCampaign(
  state: ElectionState,
  nowMinute: number,
  campaignDays: number,
): void {
  if (state.phase === 'campaign') return;
  const days = Math.max(1, Math.floor(campaignDays));
  openCampaign(state, nowMinute, nowMinute + days * TIME.calendar.minutesPerDay);
}

/** 竞选是否已到期（到点即结算，不等到日界）。 */
export function isCampaignDue(state: ElectionState, nowMinute: number): boolean {
  return state.phase === 'campaign' && nowMinute >= state.deadlineMinute;
}

/** 距投票还有多少分钟（已到期为 0）。 */
export function minutesToDeadline(state: ElectionState, nowMinute: number): number {
  return Math.max(0, state.deadlineMinute - nowMinute);
}

/** 某候选人本节剩余可用资源（基础 + 赞助 − 已使用）。 */
export function remainingResourcesOf(
  state: ElectionState | DeepReadonly<ElectionState>,
  candidateId: CandidateId,
): number {
  const row = state.candidates[candidateId];
  if (!row) return 0;
  return Math.max(0, row.base + row.sponsored - row.used);
}

/** 某候选人本节已使用资源（宣传影响只按它计算）。 */
export function usedResourcesOf(
  state: ElectionState | DeepReadonly<ElectionState>,
  candidateId: CandidateId,
): number {
  return state.candidates[candidateId]?.used ?? 0;
}

/** 本届已收到的赞助合计（展示用；宣传影响不使用它）。 */
export function sponsoredResourcesOf(
  state: ElectionState | DeepReadonly<ElectionState>,
  candidateId: CandidateId,
): number {
  return state.candidates[candidateId]?.sponsored ?? 0;
}

/**
 * 记录一笔赞助（只改选举切片，不动钱）。
 * 幂等：同一 requestId 重复提交时返回既有记录，不重复增加资源；
 * 同一 requestId 换了候选人或金额则明确拒绝（不能默默改写历史单据）。
 */
export function recordSponsorship(
  state: ElectionState,
  input: {
    requestId: string;
    candidateId: CandidateId;
    amountCents: number;
    atMinute: number;
    monthKey: string;
  },
): { record: SponsorshipRecord; duplicated: boolean } {
  const existing = state.sponsorshipRecords.find(
    (record) => record.requestId === input.requestId,
  );
  if (existing) {
    if (existing.candidateId !== input.candidateId || existing.amountCents !== input.amountCents) {
      throw new BusinessError(
        'SPONSOR_REQUEST_MISMATCH',
        '同一操作 id 已用于另一笔赞助，不能改写已入账的单据',
      );
    }
    return { record: existing, duplicated: true };
  }
  const record: SponsorshipRecord = {
    requestId: input.requestId,
    candidateId: input.candidateId,
    amountCents: input.amountCents,
    atMinute: input.atMinute,
    monthKey: input.monthKey,
  };
  state.sponsorshipRecords.push(record);
  if (state.sponsorshipRecords.length > ELECTION_RULES.maxSponsorshipRecords) {
    state.sponsorshipRecords.splice(
      0,
      state.sponsorshipRecords.length - ELECTION_RULES.maxSponsorshipRecords,
    );
  }
  const row = state.candidates[input.candidateId];
  if (!row) throw new BusinessError('UNKNOWN_CANDIDATE', '没有该候选人');
  row.sponsored += input.amountCents * CAMPAIGN_RULES.resourcePerCent;
  return { record, duplicated: false };
}

/**
 * 按实际经过时间使用竞选资源。
 *
 * 每日上限按「分 × 分钟」分子累计：不满一天的区间按实际分钟折算，
 * 因此首届从 08:00 开始的竞选不会白拿一整天的资源。
 *
 * 资源归属严格按时间：某段区间只能消耗**该区间开始时已经到账**的资源。
 *  - 资源为 0 时，这段时间不产生可结转的整日额度（分子清零），
 *    否则「无资源期间」会在赞助到账后变成一次突击可用的历史额度；
 *  - 区间内资源耗尽时，把可用余额一次用完，剩余时间额度同样作废；
 *  - 只有「整段区间内资源都够用」时才保留不足 1 单位的分子余量。
 *
 * 赞助命令在增加资源之前必须先调用本函数结清旧区间（见 app/government）。
 * 返回本次实际使用量。
 */
export function useCampaignResources(
  state: ElectionState,
  nowMinute: number,
  minutesPerDay: number,
): number {
  if (state.phase !== 'campaign') return 0;
  const elapsed = Math.max(0, nowMinute - state.lastUsageAnchorMinute);
  state.lastUsageAnchorMinute = nowMinute;
  if (elapsed <= 0 || minutesPerDay <= 0) return 0;

  let total = 0;
  for (const candidate of CANDIDATES) {
    const row = state.candidates[candidate.id];
    if (!row) continue;
    const available = Math.max(0, row.base + row.sponsored - row.used);
    if (available <= 0) {
      // 没有资源可用：本段时间的额度不能存起来给未来赞助使用
      row.useNumerator = 0;
      continue;
    }
    row.useNumerator += CAMPAIGN_RULES.dailyUseLimit * elapsed;
    const whole = Math.floor(row.useNumerator / minutesPerDay);
    if (whole <= 0) continue;
    if (whole <= available) {
      row.useNumerator -= whole * minutesPerDay;
      row.used += whole;
      total += whole;
    } else {
      // 区间内资源耗尽：可用的全部用完，超出部分不能留到下次
      row.useNumerator = 0;
      row.used += available;
      total += available;
    }
  }
  return total;
}

/** 宣传影响：Agc = agc × Amax × X/(K+X)，X 为本届已使用资源。 */
export function advertisingOf(
  state: ElectionState | DeepReadonly<ElectionState>,
  candidateId: CandidateId,
): number {
  const config = candidateConfig(candidateId);
  const used = usedResourcesOf(state, candidateId);
  const k = CAMPAIGN_RULES.diminishingK;
  const ratio = k > 0 ? used / (k + used) : 0;
  return config.campaignAbility * CAMPAIGN_RULES.maxAdvertising * ratio;
}

/* ------------------------------------------------------------ 支持率 */

/** 评分输入：群体配置、满意度、现任加分与广告影响。 */
export interface SupportScoreInput {
  readonly groups: readonly PoliticsGroupConfig[];
  /**
   * 群体 id → 满意度评分（[-1,1]，由 (S − 50) / 50 换算）。
   * 不得直接传 0～100 的满意度原值，否则会压过政策匹配项。
   */
  readonly satisfaction: Readonly<Record<string, number>>;
  /** 现任候选人 id（过渡负责人为 null）。 */
  readonly incumbentId: CandidateId | null;
  /** 现任表现加分（0.8J + 0.5I − P 的有界值）。 */
  readonly incumbentPerformance: number;
  /** 各候选人的广告影响。 */
  readonly advertising: Readonly<Record<string, number>>;
}

export interface GroupSupport {
  readonly groupId: string;
  /** 各候选人在该群体内的支持率（和为 1）。 */
  readonly support: Record<string, number>;
  /** 该群体的评分明细（用于界面解释）。 */
  readonly scores: Record<string, number>;
}

/**
 * 群体评分与支持率：
 *   Ugc = Bgc + Pgc + Egc + Igc + Agc
 *   sgc = softmax(Ugc / T)
 * 使用减最大值的数值稳定实现；每个群体对全部候选人的支持率和为 1。
 */
export function supportScores(input: SupportScoreInput): GroupSupport[] {
  const candidateIds = CANDIDATES.map((candidate) => candidate.id);
  return input.groups.map((group) => {
    const scores: Record<string, number> = {};
    const raw: number[] = [];
    for (const candidateId of candidateIds) {
      const config = candidateConfig(candidateId);
      const match = group.match[candidateId] ?? 0;
      const base = config.baseApproval;
      const policyMatch = ELECTION_RULES.policyMatchWeight * match;
      const satisfaction = input.satisfaction[group.id] ?? 0;
      const economic =
        ELECTION_RULES.economicWeight * satisfaction * Math.max(0.25, Math.abs(match));
      const incumbent =
        input.incumbentId === candidateId
          ? ELECTION_RULES.incumbentBase +
            ELECTION_RULES.incumbentPerformanceWeight * input.incumbentPerformance
          : 0;
      const advertising = input.advertising[candidateId] ?? 0;
      const total = base + policyMatch + economic + incumbent + advertising;
      scores[candidateId] = total;
      raw.push(total);
    }
    const max = Math.max(...raw);
    const exp = raw.map((value) => Math.exp((value - max) / ELECTION_RULES.softmaxTemperature));
    const sum = exp.reduce((acc, value) => acc + value, 0);
    const support: Record<string, number> = {};
    candidateIds.forEach((candidateId, index) => {
      support[candidateId] = sum > 0 ? exp[index]! / sum : 1 / candidateIds.length;
    });
    return { groupId: group.id, support, scores };
  });
}

/* ------------------------------------------------------------ 票数 */

export interface VoteTallyInput {
  readonly totalPopulation: number;
  readonly groups: readonly PoliticsGroupConfig[];
  readonly support: readonly GroupSupport[];
  /** 群体 id → 群体人数。 */
  readonly groupPeople: Readonly<Record<string, number>>;
  /** 群体 id → 群体投票率。 */
  readonly turnout: Readonly<Record<string, number>>;
}

export interface VoteTally {
  /** 投票时的权威总人口（浮点）。 */
  readonly totalPopulation: number;
  readonly eligiblePeople: number;
  readonly participatingPeople: number;
  readonly votes: CandidateVotes[];
  readonly lowTurnout: boolean;
  /** 预计投票率 = 预计参与人数 ÷ 合格人数。 */
  readonly turnoutRatio: number;
}

export interface TurnoutInput {
  readonly totalPopulation: number;
  readonly groups: readonly PoliticsGroupConfig[];
  readonly groupPeople: Readonly<Record<string, number>>;
  readonly turnout: Readonly<Record<string, number>>;
}

export interface TurnoutEstimate {
  readonly totalPopulation: number;
  readonly eligiblePeople: number;
  readonly participatingPeople: number;
  /** 群体参与人数（整数，与 groups 同序，最大余数法守恒）。 */
  readonly groupParticipants: number[];
  /** 预计投票率 = 参与人数 ÷ 合格人数。 */
  readonly turnoutRatio: number;
}

/**
 * 参与人数口径的**唯一实现**（开票、界面预计参与、候选人预计票数共用）。
 *
 *  - 合格人数 = 总人口 × 资格比例；
 *  - 群体参与人数 = 总人口 × 资格比例 × 群体比例 × 群体投票率；
 *    `groupPeople` 已经是「总人口 × 群体比例」，所以这里只再乘资格比例与投票率，
 *    不能再把群体比例乘第二次；
 *  - 参与人数不得超过合格人数（浮点误差与配置异常时截断）；
 *  - 群体人数用最大余数法整数化，和严格等于参与人数。
 */
export function estimateTurnout(input: TurnoutInput): TurnoutEstimate {
  const totalPopulation = Math.max(0, input.totalPopulation);
  const eligiblePeople = Math.max(
    0,
    Math.round(totalPopulation * ELECTION_RULES.eligibilityRatio),
  );
  const groupWeights: number[] = [];
  for (const group of input.groups) {
    const people = Math.max(0, input.groupPeople[group.id] ?? 0);
    const rate = Math.min(1, Math.max(0, input.turnout[group.id] ?? 0));
    groupWeights.push(people * ELECTION_RULES.eligibilityRatio * rate);
  }
  const participantsFloat = groupWeights.reduce((sum, value) => sum + value, 0);
  const participatingPeople = Math.min(
    eligiblePeople,
    Math.max(0, Math.round(participantsFloat)),
  );
  const groupParticipants = largestRemainderSplit(participatingPeople, groupWeights);
  return {
    totalPopulation,
    eligiblePeople,
    participatingPeople,
    groupParticipants,
    turnoutRatio: eligiblePeople > 0 ? participatingPeople / eligiblePeople : 0,
  };
}

/**
 * 票数计算：
 *  - 参与人数口径见 `estimateTurnout`（含资格比例、最大余数法）；
 *  - 候选人票数 = Σ 群体参与人数 × 该群体支持率；
 *  - 群体内部同样用最大余数法整数化，票数之和恒等于参与人数。
 */
export function tallyVotes(input: VoteTallyInput): VoteTally {
  const candidateIds = CANDIDATES.map((candidate) => candidate.id);
  const turnout = estimateTurnout({
    totalPopulation: input.totalPopulation,
    groups: input.groups,
    groupPeople: input.groupPeople,
    turnout: input.turnout,
  });

  const votes = new Map<CandidateId, number>(candidateIds.map((id) => [id, 0]));

  input.groups.forEach((group, index) => {
    const groupSupport = input.support.find((item) => item.groupId === group.id);
    if (!groupSupport) return;
    const people = turnout.groupParticipants[index] ?? 0;
    if (people <= 0) return;
    const weights = candidateIds.map((id) => groupSupport.support[id] ?? 0);
    const split = largestRemainderSplit(people, weights);
    candidateIds.forEach((id, candidateIndex) => {
      votes.set(id, (votes.get(id) ?? 0) + (split[candidateIndex] ?? 0));
    });
  });

  return {
    totalPopulation: turnout.totalPopulation,
    eligiblePeople: turnout.eligiblePeople,
    participatingPeople: turnout.participatingPeople,
    votes: candidateIds.map((id) => ({ candidateId: id, votes: votes.get(id) ?? 0 })),
    lowTurnout:
      turnout.eligiblePeople > 0 && turnout.turnoutRatio < ELECTION_RULES.lowTurnoutRatio,
    turnoutRatio: turnout.turnoutRatio,
  };
}

/* ------------------------------------------------------------ 抽签 */

/** 独立 PRNG（mulberry32）：只服务平票抽签，状态随存档保存。 */
function nextRandom(state: ElectionState): number {
  state.tieRng = (state.tieRng + 0x6d2b79f5) >>> 0;
  let t = state.tieRng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * 完成本届选举：生成结果、平票时抽签、写入历史。
 * 零有效票时不产生赢家（由应用层安排过渡负责人留任与 30 天后重选）。
 */
export function completeElection(
  state: ElectionState,
  input: {
    atMinute: number;
    monthKey: string;
    tally: VoteTally;
  },
): ElectionResult {
  if (state.settledTerms.includes(state.termSeq)) {
    throw new BusinessError('ELECTION_ALREADY_SETTLED', '本届选举已经结算过');
  }
  const sorted = [...input.tally.votes].sort((left, right) => right.votes - left.votes);
  const top = sorted[0]?.votes ?? 0;
  const tied = sorted.filter((row) => row.votes === top).map((row) => row.candidateId);

  let winnerId: CandidateId | null = null;
  let tie = false;
  let tieBreakNote = '';
  if (input.tally.participatingPeople > 0 && top > 0) {
    if (tied.length === 1) {
      winnerId = tied[0]!;
    } else {
      tie = true;
      const pick = Math.floor(nextRandom(state) * tied.length) % tied.length;
      winnerId = tied[pick] ?? null;
      tieBreakNote = `平票（${tied
        .map((id) => `${candidateConfig(id).name} ${input.tally.votes.find((v) => v.candidateId === id)?.votes ?? 0} 票`)
        .join('、')}），按独立抽签结果由 ${candidateConfig(winnerId!).name} 当选`;
    }
  }

  const result: ElectionResult = {
    termSeq: state.termSeq,
    atMinute: input.atMinute,
    monthKey: input.monthKey,
    totalPopulation: Math.max(0, input.tally.totalPopulation),
    eligiblePeople: input.tally.eligiblePeople,
    participatingPeople: input.tally.participatingPeople,
    votes: input.tally.votes.map((row) => ({ ...row })),
    winnerId,
    tie,
    tieBreakNote,
    lowTurnout: input.tally.lowTurnout,
  };
  state.history.push(result);
  if (state.history.length > ELECTION_RULES.maxHistory) {
    state.history.splice(0, state.history.length - ELECTION_RULES.maxHistory);
  }
  state.settledTerms.push(state.termSeq);
  if (state.settledTerms.length > ELECTION_RULES.maxHistory) {
    state.settledTerms.splice(0, state.settledTerms.length - ELECTION_RULES.maxHistory);
  }
  // 结算后进入任期之间状态：下一届竞选在投票前 30 天开启
  state.phase = 'between';
  state.deadlineMinute = input.atMinute + ELECTION_RULES.termDays * 1440;
  state.campaignStartMinute = state.deadlineMinute - ELECTION_RULES.campaignDays * 1440;
  state.lastUsageAnchorMinute = input.atMinute;
  return result;
}

/** 进入新一届竞选（由应用层在投票前 30 天调用）。 */
export function beginNextCampaign(state: ElectionState, nowMinute: number): void {
  if (state.phase === 'campaign') return;
  const startMinute = Math.max(nowMinute, state.campaignStartMinute);
  openCampaign(state, startMinute, state.deadlineMinute);
}

/** 零有效票后的重选：30 天后重新投票（不产生新一届任期，但算作新的选举轮次）。 */
export function scheduleRetry(state: ElectionState, atMinute: number): void {
  state.phase = 'campaign';
  state.deadlineMinute = atMinute + ELECTION_RULES.retryDays * 1440;
  state.campaignStartMinute = atMinute;
  state.lastUsageAnchorMinute = atMinute;
  state.termSeq += 1;
  for (const candidate of CANDIDATES) {
    const row = state.candidates[candidate.id];
    row.base = CAMPAIGN_RULES.baseResources;
    row.sponsored = 0;
    row.used = 0;
    row.useNumerator = 0;
  }
}
