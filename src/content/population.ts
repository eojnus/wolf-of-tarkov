/** 动态人口参数。比例均为小数（1 = 100%），金额均为分。 */
export const POPULATION_RULES = {
  initialPeople: 100_000,
  initialRatios: { low: 0.5, mid: 0.35, high: 0.15 },
  annualNaturalGrowthRate: 0.02,
  daysPerYear: 360,
  historyLimit: 24,
  displayMonths: 12,
  businessWeight: 0.3,
  baseFlow: { lm: 0.0028, ml: 0.004, mh: 0.0012, hm: 0.0028 },
  businessFlow: {
    lm: { j: 0.0012, i: 0.0006, p: -0.0012 },
    ml: { j: -0.0015, p: 0.003 },
    mh: { j: 0.0004, i: 0.0008, p: -0.0006 },
    hm: { i: -0.0008, p: 0.002 },
  },
  participation: { low: 0.1, mid: 0.35, high: 0.75 },
  stockImpact: {
    threshold: 0.05,
    fullSwing: 0.35,
    upward: { lm: 0.15, mh: 0.12 },
    downward: { ml: 0.35, hm: 0.5 },
    suppression: 0.8,
  },
} as const;

export const POPULATION_BUSINESS_RULES = {
  recentWeights: [0.5, 0.3, 0.2] as readonly number[],
  wageReferenceCents: 800_000,
  wageArrearsFloorCents: 300_000,
  researchReferenceCents: 600_000,
  otherArrearsReferenceCents: 90_000,
  highSkillAbility: 15,
  weights: {
    jobCoverage: 0.7,
    wageLevel: 0.3,
    research: 0.6,
    highSkill: 0.4,
    wageArrears: 0.35,
    otherArrears: 0.25,
    inactive: 0.2,
    liquidation: 0.2,
  },
} as const;
