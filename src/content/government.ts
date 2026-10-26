/** 政府、候选人、选举与赞助配置。只保存参数，不包含业务计算。 */
export type CandidateId = 'candidate-a' | 'candidate-b' | 'candidate-c';
export type PolicyId = 'innovation' | 'employment' | 'infrastructure';

export interface GovernmentPolicyEffects {
  readonly researchGrowthMultiplier: number;
  readonly operatingCostMultiplier: number;
  readonly salesCostMultiplier: number;
}

export const NEUTRAL_POLICY_EFFECTS: GovernmentPolicyEffects = {
  researchGrowthMultiplier: 1,
  operatingCostMultiplier: 1,
  salesCostMultiplier: 1,
};

export const POLICY_EFFECTS: Record<PolicyId, GovernmentPolicyEffects> = {
  innovation: { researchGrowthMultiplier: 1.05, operatingCostMultiplier: 1, salesCostMultiplier: 1 },
  employment: { researchGrowthMultiplier: 1, operatingCostMultiplier: 0.95, salesCostMultiplier: 1 },
  infrastructure: { researchGrowthMultiplier: 1, operatingCostMultiplier: 1, salesCostMultiplier: 0.98 },
};

export const POLICY_LABELS: Record<PolicyId, string> = {
  innovation: '新立项产品的研发增长项提高 5%',
  employment: '企业日常固定运营成本降低 5%',
  infrastructure: '产品单位销售成本降低 2%',
};

export interface CandidateConfig {
  readonly id: CandidateId;
  readonly name: string;
  readonly policy: PolicyId;
  readonly platform: string;
  readonly baseApproval: number;
  readonly campaignAbility: number;
}

export const CANDIDATES: readonly CandidateConfig[] = [
  { id: 'candidate-a', name: '候选人 A', policy: 'innovation', platform: '科技与创新', baseApproval: 0, campaignAbility: 1 },
  { id: 'candidate-b', name: '候选人 B', policy: 'employment', platform: '商业与就业', baseApproval: 0, campaignAbility: 1 },
  { id: 'candidate-c', name: '候选人 C', policy: 'infrastructure', platform: '基础设施与城市发展', baseApproval: 0, campaignAbility: 1 },
];

export const ELECTION_RULES = {
  termDays: 360,
  campaignDays: 30,
  retryDays: 30,
  firstElectionDay: 30,
  firstElectionMinuteOfDay: 8 * 60,
  eligibilityRatio: 0.72,
  lowTurnoutRatio: 0.4,
  softmaxTemperature: 0.75,
  policyMatchWeight: 0.9,
  economicWeight: 0.45,
  satisfactionMemory: 0.7,
  incumbentBase: 0.15,
  incumbentPerformanceWeight: 0.25,
  marketReferenceReturn: 0.2,
  tieSeed: 0x51f15eED,
  maxHistory: 24,
  maxSponsorshipRecords: 200,
} as const;

export const CAMPAIGN_RULES = {
  /** 1 分真实赞助 = 1 单位业务资源；资源不是第二份现金账户。 */
  resourcePerCent: 1,
  baseResources: 900_000,
  dailyUseLimit: 300_000,
  diminishingK: 3_000_000,
  maxAdvertising: 1,
} as const;

export function candidateConfig(id: CandidateId): CandidateConfig {
  const found = CANDIDATES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`未知候选人：${id}`);
  return found;
}
