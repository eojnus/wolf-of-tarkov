/**
 * 政治交叉群体、满意度与提前选举参数 —— 只保存数值与文案，不含业务计算。
 *
 * 群体口径（本版固定）：
 *  - 3 个收入阶层 × 4 个主要利益归属 = 最多 12 个互不重复的群体；
 *  - 群体**人数只派生**：N(收入,利益) = population.classes[收入] × 该收入内部利益权重；
 *  - 本文件之外不得再保存一份权威总人口或第二份阶层人数；
 *  - 每个人只属于一个主要利益群体，多个政策偏好不改变归属。
 *
 * 满意度是 0～100 的独立指标（新游戏 50），与选举支持率是两件事；
 * 满意度进入原 [-1,1] 评分口径时使用 (S − 50) / 50。
 */

import type { CandidateId } from './government';

export type IncomeTier = 'low' | 'mid' | 'high';
export type InterestId = 'innovation' | 'employment' | 'housing' | 'cost';
/** 稳定群体 ID：如 `low:innovation`、`middle`→`mid`。 */
export type PoliticalGroupId = `${IncomeTier}:${InterestId}`;

export interface PoliticsGroupConfig {
  readonly id: PoliticalGroupId;
  readonly name: string;
  readonly income: IncomeTier;
  readonly interest: InterestId;
  /**
   * 该收入阶层内部的利益归属权重（同一阶层的四个权重合计必须为 1）。
   * 它只是条件权重，不是占全城的比例；全城比例由阶层人数再乘得。
   */
  readonly weight: number;
  /** 群体投票率（沿用既有对应方向口径，生活成本 0.64）。 */
  readonly turnout: number;
  /** 对三位候选人的政策匹配，[-1, 1]，统一归一化后使用。 */
  readonly match: Readonly<Record<CandidateId, number>>;
  readonly note: string;
}

export const INCOME_TIERS: readonly { readonly id: IncomeTier; readonly name: string }[] = [
  { id: 'low', name: '低收入' },
  { id: 'mid', name: '中收入' },
  { id: 'high', name: '高收入' },
];

export const INTEREST_GROUPS: readonly {
  readonly id: InterestId;
  readonly name: string;
  readonly note: string;
  readonly turnout: number;
  readonly match: Readonly<Record<CandidateId, number>>;
}[] = [
  {
    id: 'innovation',
    name: '科技与创新',
    note: '关注研发、技术岗位与长期产业机会。',
    turnout: 0.58,
    match: { 'candidate-a': 1, 'candidate-b': -0.2, 'candidate-c': 0.1 },
  },
  {
    id: 'employment',
    name: '商业与就业',
    note: '关注岗位、工资支付和经营稳定性。',
    turnout: 0.68,
    match: { 'candidate-a': 0.1, 'candidate-b': 1, 'candidate-c': 0.2 },
  },
  {
    id: 'housing',
    name: '住房与基础设施',
    note: '关注住房、基础设施与城市运行空间。',
    turnout: 0.62,
    match: { 'candidate-a': 0, 'candidate-b': 0.1, 'candidate-c': 1 },
  },
  {
    id: 'cost',
    name: '生活成本与消费',
    note: '关注日常开支与生活成本压力；本轮是新增群体，不是旧「综合务实」改名。',
    turnout: 0.64,
    match: { 'candidate-a': 0, 'candidate-b': 0.6, 'candidate-c': 0.4 },
  },
];

/**
 * 每个收入阶层的利益归属权重。
 * 三行分别必须合计为 1（校验器会检查，配置错误直接拒绝读档）。
 */
export const INCOME_INTEREST_WEIGHTS: Readonly<
  Record<IncomeTier, Readonly<Record<InterestId, number>>>
> = {
  low: { innovation: 0.15, employment: 0.35, housing: 0.25, cost: 0.25 },
  mid: { innovation: 0.25, employment: 0.3, housing: 0.25, cost: 0.2 },
  high: { innovation: 0.35, employment: 0.2, housing: 0.25, cost: 0.2 },
};

/** 生成 12 个群体配置（顺序稳定：收入阶层 × 利益归属）。 */
export const POLITICS_GROUPS: readonly PoliticsGroupConfig[] = INCOME_TIERS.flatMap((tier) =>
  INTEREST_GROUPS.map((interest) => ({
    id: `${tier.id}:${interest.id}` as PoliticalGroupId,
    name: `${tier.name} · ${interest.name}`,
    income: tier.id,
    interest: interest.id,
    weight: INCOME_INTEREST_WEIGHTS[tier.id][interest.id],
    turnout: interest.turnout,
    match: interest.match,
    note: interest.note,
  })),
);

export function politicsGroupConfig(id: PoliticalGroupId): PoliticsGroupConfig {
  const found = POLITICS_GROUPS.find((group) => group.id === id);
  if (!found) throw new Error(`未知政治群体：${id}`);
  return found;
}

/* ------------------------------------------------------------ 满意度 */

/**
 * 满意度基线（0～100）。
 *
 *   T = clamp(base + 10M + 15E − 25P − 10C + 10D, 0, 100)
 *   S新 = S旧 + clamp(0.20 × (T − S旧), −4, 4)
 *
 * 输入尺度：M/E 有界 [-1,1]；P/C 为 [0,1]；D 为有界履约尺度 [0,1]。
 * 注意：人口记录里的 J/I/P 已经乘过 0.30 权重，使用前必须显式还原尺度。
 */
export const SATISFACTION_RULES = {
  initial: 50,
  min: 0,
  max: 100,
  /** 目标满意度基线。 */
  base: 50,
  /** M：当前执政方向与群体利益的政策匹配。 */
  matchWeight: 10,
  /** E：可模拟企业样本的就业薪酬与产业表现。 */
  employmentWeight: 15,
  /** P：可模拟企业样本的真实经营压力。 */
  pressureWeight: -25,
  /** C：可观察的生活成本恶化。 */
  costWeight: -10,
  /** D：已承诺建设项目的真实落实。 */
  deliveryWeight: 10,
  /** 月度滚动速率。 */
  updateRate: 0.2,
  /** 单月最大变动。 */
  monthlyCap: 4,
  /**
   * 经济摘要还原尺度：人口记录里的 J/I/P = 原始值 × 该权重。
   * 满意度使用原始尺度时必须除以它，不能重复乘权重。
   */
  restoredBy: 0.3,
  /** E 的构成权重（J 与 I 的加权，放配置）。 */
  employment: { job: 0.6, industry: 0.4 },
  /** 满意度历史保留条数（趋势展示）。 */
  historyLimit: 24,
} as const;

/** 进入原 [-1,1] 评分口径时的换算：不使用 0～100 原值。 */
export function satisfactionToScore(satisfaction: number): number {
  return (satisfaction - SATISFACTION_RULES.initial) / 50;
}

/* ------------------------------------------------------------ 提前选举 */

/**
 * 提前选举配置。
 *
 * 触发条件（同时满足连续月份计数）：
 *  - 全市人口加权平均满意度严格低于 35；或
 *  - 某个主要群体满意度严格低于 25，且该群体占人口至少 20%。
 * 主要群体 = 3 个收入边际 + 4 个利益边际（共 7 个），不要求单个交叉格达标。
 * 同一条件连续 3 个已结束游戏月成立；新任政府保护期 6 个游戏月（180 日）；
 * 每个真实任期最多接受一次提前选举请求；提前竞选仍为 30 日。
 */
export const EARLY_ELECTION_RULES = {
  /** 全市平均满意度阈值（严格低于）。 */
  citySatisfactionThreshold: 35,
  /** 主要群体满意度阈值（严格低于）。 */
  groupSatisfactionThreshold: 25,
  /** 主要群体占人口的最低比例。 */
  groupPopulationShare: 0.2,
  /** 需要连续成立的已结束月数。 */
  consecutiveMonths: 3,
  /** 新政府保护期（游戏日）。 */
  protectionDays: 180,
  /** 提前竞选时长（游戏日）。 */
  campaignDays: 30,
} as const;

/** 边际统计口径：7 个主要群体的稳定 id 与说明。 */
export type MarginId =
  | `income:${IncomeTier}`
  | `interest:${InterestId}`;

export const MARGIN_DEFINITIONS: readonly {
  readonly id: MarginId;
  readonly name: string;
  readonly kind: 'income' | 'interest';
}[] = [
  { id: 'income:low', name: '低收入群体', kind: 'income' },
  { id: 'income:mid', name: '中收入群体', kind: 'income' },
  { id: 'income:high', name: '高收入群体', kind: 'income' },
  { id: 'interest:innovation', name: '科技与创新群体', kind: 'interest' },
  { id: 'interest:employment', name: '商业与就业群体', kind: 'interest' },
  { id: 'interest:housing', name: '住房与基础设施群体', kind: 'interest' },
  { id: 'interest:cost', name: '生活成本与消费群体', kind: 'interest' },
];
