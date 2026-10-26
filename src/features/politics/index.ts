/**
 * 政治满意度与提前选举监测 —— 12 个交叉群体的持久满意度 + 提前选举连续月计数。
 *
 * 边界：
 *  - 群体人数只从权威人口派生：N(收入, 利益) = classes[收入] × 该收入内部利益权重；
 *    本模块不保存第二份城市总人口，也不保存第二份阶层人数；
 *  - 满意度是 0～100 的独立指标（新游戏 50），与选举支持率是两件事：
 *    进入原 [-1,1] 评分口径时统一使用 (S − 50) / 50（`satisfactionToScore`）；
 *  - 纯计算 + 本切片状态：不扣款、不推进时间、不读写 elections / government；
 *  - 提前选举只更新计数并返回结论，是否真正开始竞选由 app/politics-simulation
 *    调用 elections.beginEarlyCampaign 完成。
 *
 * 经济尺度（关键口径）：
 *  人口月结记录里的 `business.j / i / p` 已经乘过 0.30 权重（最终值）。
 *  满意度目标公式使用**原始尺度**，因此必须显式除以 `SATISFACTION_RULES.restoredBy`；
 *  不能把已加权的值再乘一次权重，否则「严重不满」永远无法出现。
 */

import { TIME } from '../../content/config';
import type { CandidateId } from '../../content/government';
import {
  EARLY_ELECTION_RULES,
  MARGIN_DEFINITIONS,
  POLITICS_GROUPS,
  SATISFACTION_RULES,
  satisfactionToScore,
  type IncomeTier,
  type InterestId,
  type MarginId,
  type PoliticalGroupId,
  type PoliticsGroupConfig,
} from '../../content/politics';
import type { DeepReadonly } from '../../core/readonly';

/* ------------------------------------------------------------ 状态 */

/** 单个交叉群体的持久状态。 */
export interface PoliticalGroupState {
  readonly id: PoliticalGroupId;
  readonly income: IncomeTier;
  readonly interest: InterestId;
  /** 0～100 持久值，新游戏 50。 */
  satisfaction: number;
}

/** 提前选举监测器（持久化，避免读档重算或重复触发）。 */
export interface EarlyElectionMonitor {
  /** 全市条件连续成立的已结束月数；最多记到 `consecutiveMonths`（达到门槛后不再累加）。 */
  cityMonths: number;
  /** 7 个主要群体的独立连续月计数（同样最多记到门槛值）。 */
  groupMonths: Record<MarginId, number>;
  lastEvaluatedMonthKey: string | null;
  /** 本任期是否已经接受过提前选举请求（真实任期 id）。 */
  lastTriggeredTermId: string | null;
  /** 新政府保护期结束时刻（游戏分钟）。 */
  protectionUntilMinute: number;
}

/** 一个已结束游戏月的满意度快照（界面趋势与触发记录用）。 */
export interface PoliticsSatisfactionHistoryPoint {
  readonly monthKey: string;
  /** 0～100，12 个群体按人数计权一次（调用方提供人口时）。 */
  readonly average: number;
  readonly cityBelowThreshold: boolean;
  readonly triggeredMargins: readonly MarginId[];
}

export interface PoliticsState {
  groups: Record<PoliticalGroupId, PoliticalGroupState>;
  /** 最近一次滚动到的月份（YYYY-MM），防止同月重复滚动。 */
  lastUpdatedMonthKey: string | null;
  lastSummary: {
    /** 还原到原始尺度后的 J（[-1, 1]）。 */
    readonly j: number;
    readonly i: number;
    /** [0, 1]。 */
    readonly p: number;
    readonly averageSatisfaction: number;
    readonly monthKey: string;
  } | null;
  earlyElection: EarlyElectionMonitor;
  /** 最多 `SATISFACTION_RULES.historyLimit` 条，按时间正序。 */
  history: PoliticsSatisfactionHistoryPoint[];
}

/** 三个经济阶层人数（只读结构，来自 population.classes，不复制权威）。 */
interface SocialClasses {
  readonly low: number;
  readonly mid: number;
  readonly high: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return Math.min(max, Math.max(min, 0));
  return Math.min(max, Math.max(min, value));
}

function emptyGroupMonths(): Record<MarginId, number> {
  const months = {} as Record<MarginId, number>;
  for (const margin of MARGIN_DEFINITIONS) months[margin.id] = 0;
  return months;
}

function emptyMonitor(): EarlyElectionMonitor {
  return {
    cityMonths: 0,
    groupMonths: emptyGroupMonths(),
    lastEvaluatedMonthKey: null,
    lastTriggeredTermId: null,
    protectionUntilMinute: 0,
  };
}

/** 12 个群体全部初始 50（`SATISFACTION_RULES.initial`）。 */
export function createPoliticsState(): PoliticsState {
  const groups = {} as Record<PoliticalGroupId, PoliticalGroupState>;
  for (const config of POLITICS_GROUPS) {
    groups[config.id] = {
      id: config.id,
      income: config.income,
      interest: config.interest,
      satisfaction: SATISFACTION_RULES.initial,
    };
  }
  return {
    groups,
    lastUpdatedMonthKey: null,
    lastSummary: null,
    earlyElection: emptyMonitor(),
    history: [],
  };
}

/**
 * 旧档迁移：给定旧口径的整体满意度（[-1,1] 归一化值），
 * 用 50 × (old + 1) 生成 12 个群体的共同初值（clamp 0～100）。
 */
export function createPoliticsStateFromLegacy(overallNormalized: number): PoliticsState {
  const state = createPoliticsState();
  setAllSatisfaction(state, SATISFACTION_RULES.initial * (overallNormalized + 1));
  return state;
}

/** 迁移辅助：直接批量设置群体满意度（clamp 0～100）。 */
export function setAllSatisfaction(state: PoliticsState, value: number): void {
  const satisfaction = clamp(value, SATISFACTION_RULES.min, SATISFACTION_RULES.max);
  for (const config of POLITICS_GROUPS) {
    const group = state.groups[config.id];
    if (group) group.satisfaction = satisfaction;
  }
}

/* ------------------------------------------------------------ 派生人数 */

/**
 * 12 个群体的人数与全城占比 —— **只派生，不保存权威副本**。
 *
 * N(收入, 利益) = classes[收入] × 该收入内部利益权重；
 * 每个收入阶层的最后一个群体取余量，最后一位再按「全城人数 − 已分配」收口，
 * 使 12 格按数组顺序相加严格等于三个阶层人数之和（不丢浮点尾数），
 * 因此总量与人口切片始终是同一份权威，不需要第二份总人口。
 */
export function groupSizes(
  classes: SocialClasses,
): Array<{ readonly config: PoliticsGroupConfig; readonly people: number; readonly ratio: number }> {
  const tiers: readonly IncomeTier[] = ['low', 'mid', 'high'];
  const tierPeople = {
    low: Math.max(0, classes.low),
    mid: Math.max(0, classes.mid),
    high: Math.max(0, classes.high),
  };
  const total = tierPeople.low + tierPeople.mid + tierPeople.high;
  const rows: Array<{
    readonly config: PoliticsGroupConfig;
    readonly people: number;
    readonly ratio: number;
  }> = [];
  let accumulated = 0;
  tiers.forEach((tier, tierIndex) => {
    const peopleOfTier = tierPeople[tier];
    const groupsOfTier = POLITICS_GROUPS.filter((group) => group.income === tier);
    const weightSum = groupsOfTier.reduce((sum, group) => sum + Math.max(0, group.weight), 0);
    const isLastTier = tierIndex === tiers.length - 1;
    let assignedInTier = 0;
    groupsOfTier.forEach((config, index) => {
      const isLastGroup = index === groupsOfTier.length - 1;
      let people: number;
      if (isLastTier && isLastGroup) {
        // 收口到全城人数：保证 12 格逐项相加严格等于 classes 三者之和。
        people = total - accumulated;
      } else if (isLastGroup) {
        // 同一收入阶层内部，最后一位取该阶层的余量。
        people = peopleOfTier - assignedInTier;
      } else if (weightSum > 0) {
        people = (peopleOfTier * Math.max(0, config.weight)) / weightSum;
      } else {
        people = peopleOfTier / groupsOfTier.length;
      }
      assignedInTier += people;
      accumulated += people;
      rows.push({ config, people, ratio: total > 0 ? people / total : 0 });
    });
  });
  return rows;
}

/* ------------------------------------------------------------ 满意度 */

export interface SatisfactionInput {
  /** 当前执政方向（候选人 id）；过渡负责人为 null。 */
  readonly currentDirection: CandidateId | null;
  /** 人口月结记录里的 business.j/i/p（已乘 0.30 权重的最终值）；缺失时传 null。 */
  readonly business: { readonly j: number; readonly i: number; readonly p: number } | null;
  /** 可观察的生活成本恶化 C ∈ [0,1]；没有观察数据时 hasCostSample=false。 */
  readonly costPressure: number;
  readonly hasCostSample: boolean;
  /** 已承诺建设项目的真实落实 D ∈ [0,1]；没有承诺项目时 hasDeliverySample=false。 */
  readonly delivery: number;
  readonly hasDeliverySample: boolean;
}

function satisfactionOfGroup(
  state: PoliticsState | DeepReadonly<PoliticsState>,
  groupId: PoliticalGroupId,
): number {
  const groups: Readonly<Record<PoliticalGroupId, DeepReadonly<PoliticalGroupState>>> =
    state.groups;
  const group = groups[groupId];
  if (!group) return SATISFACTION_RULES.initial;
  return clamp(group.satisfaction, SATISFACTION_RULES.min, SATISFACTION_RULES.max);
}

/** 只读查询：某群体当前满意度（0～100；缺失时回退配置初值）。 */
export function satisfactionOf(
  state: PoliticsState | DeepReadonly<PoliticsState>,
  groupId: PoliticalGroupId,
): number {
  return satisfactionOfGroup(state, groupId);
}

/** 满意度进入原 [-1,1] 评分口径：(S − 50) / 50。 */
export function satisfactionScoreOf(
  state: PoliticsState | DeepReadonly<PoliticsState>,
  groupId: PoliticalGroupId,
): number {
  return satisfactionToScore(satisfactionOfGroup(state, groupId));
}

/** 满意度评分表（供 elections.supportScores 使用），键为 12 个群体 id。 */
export function satisfactionScores(
  state: PoliticsState | DeepReadonly<PoliticsState>,
): Record<PoliticalGroupId, number> {
  const scores = {} as Record<PoliticalGroupId, number>;
  for (const config of POLITICS_GROUPS) {
    scores[config.id] = satisfactionToScore(satisfactionOfGroup(state, config.id));
  }
  return scores;
}

/** 12 个群体等权平均（只在没有人口输入时的中性回退口径）。 */
function equalAverageSatisfactionOf(state: PoliticsState | DeepReadonly<PoliticsState>): number {
  let sum = 0;
  for (const config of POLITICS_GROUPS) sum += satisfactionOfGroup(state, config.id);
  return clamp(sum / POLITICS_GROUPS.length, SATISFACTION_RULES.min, SATISFACTION_RULES.max);
}

/** 全市人口加权平均满意度（12 格各计权一次，不重复按阶层/利益再加权）。 */
export function averageSatisfactionOf(
  state: PoliticsState | DeepReadonly<PoliticsState>,
  classes: SocialClasses,
): number {
  const sizes = groupSizes(classes);
  let peopleTotal = 0;
  let weighted = 0;
  for (const row of sizes) {
    peopleTotal += row.people;
    weighted += row.people * satisfactionOfGroup(state, row.config.id);
  }
  if (peopleTotal <= 0) return equalAverageSatisfactionOf(state);
  return clamp(weighted / peopleTotal, SATISFACTION_RULES.min, SATISFACTION_RULES.max);
}

export interface MarginSatisfaction {
  readonly id: MarginId;
  readonly name: string;
  readonly satisfaction: number;
  /** 0～1，占全城人口。 */
  readonly populationShare: number;
}

/**
 * 7 个主要群体的满意度：3 个收入边际 + 4 个利益边际。
 *
 * 边际满意度按人数加权：收入边际内部按该收入 4 个利益群体的人数加权，
 * 利益边际内部按 3 个收入群体的人数加权；人群占比同样按人数派生。
 */
export function marginSatisfactionOf(
  state: PoliticsState | DeepReadonly<PoliticsState>,
  classes: SocialClasses,
): MarginSatisfaction[] {
  const sizes = groupSizes(classes);
  const peopleOf = new Map<PoliticalGroupId, number>();
  let total = 0;
  for (const row of sizes) {
    peopleOf.set(row.config.id, row.people);
    total += row.people;
  }
  return MARGIN_DEFINITIONS.map((margin) => {
    const members = POLITICS_GROUPS.filter((group) =>
      margin.kind === 'income'
        ? `income:${group.income}` === margin.id
        : `interest:${group.interest}` === margin.id,
    );
    let people = 0;
    let weighted = 0;
    for (const group of members) {
      const groupPeople = peopleOf.get(group.id) ?? 0;
      people += groupPeople;
      weighted += groupPeople * satisfactionOfGroup(state, group.id);
    }
    return {
      id: margin.id,
      name: margin.name,
      satisfaction:
        people > 0
          ? clamp(weighted / people, SATISFACTION_RULES.min, SATISFACTION_RULES.max)
          : SATISFACTION_RULES.initial,
      populationShare: total > 0 ? people / total : 0,
    };
  });
}

/**
 * 某群体的满意度目标：
 *   M = 当前执政方向与该群体利益的政策匹配（[-1,1]）；过渡负责人 M=0；
 *   E = clamp(employment.job × rawJ + employment.industry × rawI, -1, 1)；
 *   P = clamp(rawP, 0, 1)；C = 有样本时的 costPressure；D = 有履约样本时的 delivery；
 *   T = clamp(base + 10M + 15E − 25P − 10C + 10D, 0, 100)。
 * 其中 rawJ/rawI/rawP 已由调用方显式还原到 0.30 权重之前的原始尺度。
 */
function targetSatisfactionOf(
  config: PoliticsGroupConfig,
  input: SatisfactionInput,
  rawJ: number,
  rawI: number,
  rawP: number,
): number {
  const rules = SATISFACTION_RULES;
  // 显式放宽为可空局部量：即使配置被改坏也不会把 undefined 带进公式。
  const matchValue: number | undefined =
    input.currentDirection === null ? 0 : config.match[input.currentDirection];
  const match = clamp(matchValue ?? 0, -1, 1);
  const employment = clamp(
    rules.employment.job * rawJ + rules.employment.industry * rawI,
    -1,
    1,
  );
  const cost = input.hasCostSample ? clamp(input.costPressure, 0, 1) : 0;
  const delivery = input.hasDeliverySample ? clamp(input.delivery, 0, 1) : 0;
  const target =
    rules.base +
    rules.matchWeight * match +
    rules.employmentWeight * employment +
    rules.pressureWeight * rawP +
    rules.costWeight * cost +
    rules.deliveryWeight * delivery;
  return clamp(target, rules.min, rules.max);
}

/**
 * 月度满意度更新：幂等（同一 monthKey 只滚动一次），返回本月全市平均满意度（0～100）。
 *
 * 目标值先按公式算 T，再按 `S新 = clamp(S旧 + clamp(updateRate × (T − S旧), ±monthlyCap), 0, 100)`
 * 滚动；政府换人不重置满意度，GDP 不作为满意度加分项。
 *
 * `classes` 只用于把本月历史点/返回值按**真实人口**加权（12 格各计权一次）。
 * 不传时回退为 12 群体等权平均（仅直接调用本函数的测试/工具场景使用；
 * app 层必须传人口以符合「按人数计权一次」的口径）。
 */
export function updateMonthlySatisfaction(
  state: PoliticsState,
  monthKey: string,
  input: SatisfactionInput,
  classes?: SocialClasses,
): number {
  if (state.lastUpdatedMonthKey === monthKey) {
    const last = state.history[state.history.length - 1];
    if (last && last.monthKey === monthKey) return last.average;
    return classes ? averageSatisfactionOf(state, classes) : equalAverageSatisfactionOf(state);
  }

  // 显式还原 0.30 权重尺度：人口记录是最终值，满意度公式要的是原始尺度。
  const restoredBy = SATISFACTION_RULES.restoredBy > 0 ? SATISFACTION_RULES.restoredBy : 1;
  const rawJ = input.business ? clamp(input.business.j / restoredBy, -1, 1) : 0;
  const rawI = input.business ? clamp(input.business.i / restoredBy, -1, 1) : 0;
  const rawP = input.business ? clamp(input.business.p / restoredBy, 0, 1) : 0;

  for (const config of POLITICS_GROUPS) {
    const group = state.groups[config.id];
    if (!group) continue;
    const target = targetSatisfactionOf(config, input, rawJ, rawI, rawP);
    const delta = clamp(
      SATISFACTION_RULES.updateRate * (target - group.satisfaction),
      -SATISFACTION_RULES.monthlyCap,
      SATISFACTION_RULES.monthlyCap,
    );
    group.satisfaction = clamp(
      group.satisfaction + delta,
      SATISFACTION_RULES.min,
      SATISFACTION_RULES.max,
    );
  }
  state.lastUpdatedMonthKey = monthKey;

  const average = classes
    ? averageSatisfactionOf(state, classes)
    : equalAverageSatisfactionOf(state);
  state.lastSummary = {
    j: rawJ,
    i: rawI,
    p: rawP,
    averageSatisfaction: average,
    monthKey,
  };

  let cityBelowThreshold = false;
  const triggeredMargins: MarginId[] = [];
  if (classes) {
    cityBelowThreshold = average < EARLY_ELECTION_RULES.citySatisfactionThreshold;
    for (const margin of marginSatisfactionOf(state, classes)) {
      if (
        margin.satisfaction < EARLY_ELECTION_RULES.groupSatisfactionThreshold &&
        margin.populationShare >= EARLY_ELECTION_RULES.groupPopulationShare
      ) {
        triggeredMargins.push(margin.id);
      }
    }
  }
  state.history.push({ monthKey, average, cityBelowThreshold, triggeredMargins });
  if (state.history.length > SATISFACTION_RULES.historyLimit) {
    state.history.splice(0, state.history.length - SATISFACTION_RULES.historyLimit);
  }
  return average;
}

/* ------------------------------------------------------------ 提前选举 */

export interface EarlyElectionDecision {
  readonly triggered: boolean;
  /** 触发原因文案；未触发为 null。 */
  readonly reason: string | null;
  readonly cityMonths: number;
  readonly triggeredMargin: MarginId | null;
}

/**
 * 月度提前选举条件检查（只更新计数与返回结论，**不直接改 elections**）。
 *
 * 条件（各自独立连续计数，条件不满足即把对应计数清零）：
 *  - 全市人口加权平均满意度严格 < 35；或
 *  - 某个主要群体（收入边际 / 利益边际）满意度严格 < 25 且该群体占人口 ≥ 20%；
 *  - 同一个条件连续 3 个已结束月成立才算触发；不同群体轮流不满不会累计成同一个三个月。
 *
 * 保护期内继续记录计数但绝不触发；竞选进行中不触发、不重置计数；
 * 每个真实任期最多一次（`lastTriggeredTermId === termId` 时不再触发）。
 */
export function evaluateEarlyElection(
  state: PoliticsState,
  input: {
    readonly monthKey: string;
    readonly nowMinute: number;
    /** 当前真实任期 id；过渡负责人为 null。 */
    readonly termId: string | null;
    readonly classes: SocialClasses;
    readonly campaignActive: boolean;
    readonly protectionDays: number;
  },
): EarlyElectionDecision {
  const monitor = state.earlyElection;
  // 同一已结束月只评估一次：重复调用不重复加计数、不重复触发。
  if (monitor.lastEvaluatedMonthKey === input.monthKey) {
    return {
      triggered: false,
      reason: null,
      cityMonths: monitor.cityMonths,
      triggeredMargin: null,
    };
  }
  const rules = EARLY_ELECTION_RULES;
  const required = rules.consecutiveMonths;
  const average = averageSatisfactionOf(state, input.classes);
  const cityLow = average < rules.citySatisfactionThreshold;
  // 计数最多记到门槛值：达到触发条件后继续累加没有玩法意义，
  // 同时避免长时间保护期/竞选期把持久计数堆到无界（读档校验只接受 ≤ 门槛值）。
  monitor.cityMonths = cityLow ? Math.min(required, monitor.cityMonths + 1) : 0;
  for (const margin of marginSatisfactionOf(state, input.classes)) {
    const marginLow =
      margin.satisfaction < rules.groupSatisfactionThreshold &&
      margin.populationShare >= rules.groupPopulationShare;
    monitor.groupMonths[margin.id] = marginLow
      ? Math.min(required, monitor.groupMonths[margin.id] + 1)
      : 0;
  }
  monitor.lastEvaluatedMonthKey = input.monthKey;

  const marginTrigger = MARGIN_DEFINITIONS.find(
    (margin) => monitor.groupMonths[margin.id] >= required,
  );
  const cityTriggered = monitor.cityMonths >= required;
  const inProtection = input.nowMinute < monitor.protectionUntilMinute;
  const alreadyUsed = input.termId !== null && monitor.lastTriggeredTermId === input.termId;
  if (
    input.campaignActive ||
    inProtection ||
    input.termId === null ||
    alreadyUsed ||
    (!cityTriggered && marginTrigger === undefined)
  ) {
    return {
      triggered: false,
      reason: null,
      cityMonths: monitor.cityMonths,
      triggeredMargin: null,
    };
  }
  if (marginTrigger !== undefined) {
    return {
      triggered: true,
      reason:
        `${marginTrigger.name}满意度已连续 ${required} 个月低于 ` +
        `${rules.groupSatisfactionThreshold}，且占人口不低于 ` +
        `${Math.round(rules.groupPopulationShare * 100)}%，按规则发起提前选举`,
      cityMonths: monitor.cityMonths,
      triggeredMargin: marginTrigger.id,
    };
  }
  return {
    triggered: true,
    reason:
      `全市平均满意度已连续 ${required} 个月低于 ${rules.citySatisfactionThreshold}，` +
      '按规则发起提前选举',
    cityMonths: monitor.cityMonths,
    triggeredMargin: null,
  };
}

/**
 * 新任真实任期开始：重置保护期（start + protectionDays × 每分钟日数）、
 * 清零 7 个群体计数与全市计数、清空 lastTriggeredTermId。
 *
 * `lastEvaluatedMonthKey` 不重置：同一个已结束月仍然只评估一次，避免重复记账。
 */
export function noteNewTerm(
  state: PoliticsState,
  termId: string,
  startMinute: number,
  protectionDays: number,
): void {
  const monitor = state.earlyElection;
  const days = Math.max(0, Math.floor(protectionDays));
  monitor.protectionUntilMinute = startMinute + days * TIME.calendar.minutesPerDay;
  monitor.cityMonths = 0;
  monitor.groupMonths = emptyGroupMonths();
  monitor.lastTriggeredTermId = null;
  // termId 由调用方保证是本任期 id；监控器只按 id 记「是否已用过一次机会」，
  // 不需要额外保存第二份任期引用。
  void termId;
}

/** 提前选举已被接受（发起竞选）：记录本任期已用掉这次机会。 */
export function markEarlyElectionTriggered(
  state: PoliticsState,
  termId: string,
  marginId: MarginId | null,
): void {
  state.earlyElection.lastTriggeredTermId = termId;
  // marginId 只用于调用方说明触发原因；触发当月的历史点已记录 triggeredMargins，
  // 监控器不重复保存同一事实。
  void marginId;
}
