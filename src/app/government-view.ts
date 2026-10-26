/**
 * 政府面板视图 —— 全部只读数据在此汇总。
 *
 * 规则：
 *  - 只读：不补建状态、不扣款、不触发结算；
 *  - 界面只消费这里的视图，不直接读 features；
 *  - 人数字取整用最大余数法（与人口模块同一口径），百分比与饼图面积一致；
 *  - 没有真实来源的统计一律不显示（不虚构出生率、就业率、财政收支）。
 *
 * v16 起政治口径是 3 收入阶层 × 4 利益归属 = 12 个互不重复的群体：
 * 人数只由 `population.classes` 派生，本视图不保存也不推算第二份总人口。
 */

import { dateAtMinute, formatGameDate } from '../core/calendar';
import type { DeepReadonly } from '../core/readonly';
import { formatMoney } from '../core/money';
import { TIME } from '../content/config';
import { CANDIDATES, type CandidateId } from '../content/government';
import { EARLY_ELECTION_RULES, MARGIN_DEFINITIONS, POLITICS_GROUPS } from '../content/politics';
import {
  advertisingOf,
  remainingResourcesOf,
  sponsoredResourcesOf,
  tallyVotes,
  usedResourcesOf,
  type ElectionResult,
} from '../features/elections';
import {
  GOVERNMENT_INSTITUTION,
  GOVERNMENT_OFFICE_TITLE,
  activePolicyOf,
  activeTermOf,
  currentPolicyEffects,
} from '../features/government';
import {
  averageSatisfactionOf,
  groupSizes,
  marginSatisfactionOf,
} from '../features/politics';
import {
  displayClasses,
  totalPopulationOf,
  type PopulationMonthRecord,
} from '../features/population';
import { currentSupportOf } from './government-simulation';
import type { ReadonlyGameState } from './state';

export interface ClassSlice {
  readonly id: 'low' | 'mid' | 'high';
  readonly name: string;
  readonly people: number;
  readonly peopleText: string;
  readonly ratio: number;
  readonly ratioText: string;
}

export interface FlowSlice {
  readonly label: string;
  readonly people: number;
  readonly peopleText: string;
}

export interface TrendPoint {
  readonly monthKey: string;
  readonly low: number;
  readonly mid: number;
  readonly high: number;
}

export interface PopulationSection {
  readonly total: number;
  readonly totalText: string;
  readonly growthRateText: string;
  readonly classes: ClassSlice[];
  readonly flows: FlowSlice[];
  readonly settledMonthKey: string | null;
  readonly settledNote: string;
  readonly growthText: string;
  readonly flowTotalText: string;
  readonly netText: string;
  readonly businessText: string;
  readonly marketText: string;
  readonly marketReturnText: string;
  readonly marketCoverageText: string;
  readonly marketValid: boolean;
  readonly trend: TrendPoint[];
  readonly sampleNote: string;
  readonly incompleteNote: string | null;
}

export interface PoliticalGroupSlice {
  readonly id: string;
  readonly name: string;
  readonly incomeName: string;
  readonly interestName: string;
  readonly people: number;
  readonly peopleText: string;
  readonly ratio: number;
  readonly ratioText: string;
  readonly note: string;
  readonly turnoutText: string;
  readonly satisfactionText: string;
  readonly support: Array<{ candidateId: CandidateId; name: string; ratio: number; ratioText: string }>;
}

export interface MarginSlice {
  readonly id: string;
  readonly name: string;
  readonly peopleText: string;
  readonly ratioText: string;
  readonly satisfactionText: string;
  readonly consecutiveMonths: number;
}

export interface PoliticsSection {
  readonly groups: PoliticalGroupSlice[];
  readonly incomeMargins: MarginSlice[];
  readonly interestMargins: MarginSlice[];
  readonly averageSatisfactionText: string;
  readonly cityMonthsText: string;
  readonly protectionText: string;
  readonly earlyElectionNote: string;
  readonly note: string;
  readonly summaryText: string;
}

export interface StructureSection {
  readonly institution: string;
  readonly officeTitle: string;
  readonly holderName: string;
  readonly holderSinceText: string;
  readonly termLeftText: string;
  readonly termIdText: string;
  readonly directionText: string;
  readonly sourceText: string;
  readonly policyLabel: string;
  readonly policyEffects: Array<{ label: string; value: string }>;
  readonly caretaker: boolean;
  readonly note: string;
}

export interface CandidateSlice {
  readonly id: CandidateId;
  readonly name: string;
  readonly platform: string;
  readonly policyLabel: string;
  readonly campaignAbilityText: string;
  readonly baseText: string;
  readonly sponsoredText: string;
  readonly usedText: string;
  readonly remainingText: string;
  readonly advertisingText: string;
  /** 按「参与人数 × 群体内支持率」估算的预计有效票数（整数）。 */
  readonly expectedVotesText: string;
  /** 全人口加权支持率：按群体比例加权，不乘投票率。 */
  readonly supportText: string;
}

export interface CampaignSection {
  readonly phaseText: string;
  readonly deadlineText: string;
  readonly countdownText: string;
  readonly eligibleText: string;
  readonly expectedParticipantsText: string;
  readonly turnoutText: string;
  readonly lowTurnout: boolean;
  /** 截止或非竞选阶段时赞助按钮禁用；命令层仍会再次校验。 */
  readonly sponsorDisabled: boolean;
  readonly availableBalanceText: string;
  readonly candidates: CandidateSlice[];
  readonly sponsorNote: string;
  readonly records: Array<{
    readonly candidateName: string;
    readonly amountText: string;
    readonly atText: string;
  }>;
}

export interface HistorySection {
  readonly elections: Array<{
    readonly termText: string;
    readonly atText: string;
    readonly populationText: string;
    readonly eligibleText: string;
    readonly participantsText: string;
    readonly votesText: string;
    readonly winnerText: string;
    readonly tieNote: string;
    readonly lowTurnout: boolean;
  }>;
  readonly terms: Array<{
    readonly id: string;
    readonly name: string;
    readonly startText: string;
    readonly endText: string;
    readonly policyText: string;
    readonly directionText: string;
    readonly sourceText: string;
    readonly effectsText: string;
    readonly note: string;
  }>;
  readonly emptyText: string;
}

export interface GovernmentPanelView {
  readonly institution: string;
  readonly population: PopulationSection;
  readonly politics: PoliticsSection;
  readonly structure: StructureSection;
  readonly campaign: CampaignSection;
  readonly history: HistorySection;
}

function pct(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

function signed(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded.toLocaleString('en-US')}`;
}

const CLASS_NAMES: Record<'low' | 'mid' | 'high', string> = {
  low: '低经济阶层',
  mid: '中经济阶层',
  high: '高经济阶层',
};

const INCOME_NAMES: Record<'low' | 'mid' | 'high', string> = {
  low: '低收入',
  mid: '中收入',
  high: '高收入',
};

const INTEREST_NAMES: Record<string, string> = {
  innovation: '科技与创新',
  employment: '商业与就业',
  housing: '住房与基础设施',
  cost: '生活成本与消费',
};

const DIRECTION_NAMES: Record<string, string> = {
  'candidate-a': '科技创新方向',
  'candidate-b': '商业就业方向',
  'candidate-c': '住房与基础设施方向',
};

function buildPopulationSection(state: ReadonlyGameState): PopulationSection {
  const classes = displayClasses(state.population.classes);
  const total = totalPopulationOf(state.population);
  const records = state.population.records;
  const last = records[records.length - 1] ?? null;

  const classSlices: ClassSlice[] = (
    [
      ['low', classes.low],
      ['mid', classes.mid],
      ['high', classes.high],
    ] as const
  ).map(([id, people]) => ({
    id,
    name: CLASS_NAMES[id],
    people,
    peopleText: `${people.toLocaleString('en-US')} 人`,
    ratio: total > 0 ? people / Math.max(1, classes.total) : 0,
    ratioText: pct(total > 0 ? people / Math.max(1, classes.total) : 0),
  }));

  const flows = last
    ? [
        { label: '低 → 中', people: last.flow.lm },
        { label: '中 → 低', people: last.flow.ml },
        { label: '中 → 高', people: last.flow.mh },
        { label: '高 → 中', people: last.flow.hm },
      ].map((flow) => ({
        label: flow.label,
        people: Math.round(flow.people),
        peopleText: `${Math.round(flow.people).toLocaleString('en-US')} 人`,
      }))
    : [];

  const trend: TrendPoint[] = records.slice(-12).map((record: PopulationMonthRecord) => {
    const sum =
      record.classesAfter.low + record.classesAfter.mid + record.classesAfter.high;
    return {
      monthKey: record.monthKey,
      low: sum > 0 ? record.classesAfter.low / sum : 0,
      mid: sum > 0 ? record.classesAfter.mid / sum : 0,
      high: sum > 0 ? record.classesAfter.high / sum : 0,
    };
  });

  const marketValid = last?.market.valid ?? false;
  const marketReturn = last?.market.returnRate ?? 0;
  const downRatio = last?.market.downRatio ?? 0;
  const upRatio = last?.market.upRatio ?? 0;

  const flowTotal = last ? last.flow.lm + last.flow.ml + last.flow.mh + last.flow.hm : 0;

  return {
    total: classes.total,
    totalText: `${classes.total.toLocaleString('en-US')} 人`,
    growthRateText: '每年 +2.0%（按游戏时间累计，暂停不增长）',
    classes: classSlices,
    flows,
    settledMonthKey: last?.monthKey ?? null,
    settledNote: last
      ? `${last.monthKey} 已结算`
      : '尚无已结算的月度记录（第一个月结后出现）',
    growthText: last ? `自然增长 ${signed(last.growthPeople)} 人` : '—',
    flowTotalText: last ? `阶层流动 ${Math.round(flowTotal).toLocaleString('en-US')} 人次` : '—',
    netText: last
      ? `总人口变化 ${signed(
          last.classesAfter.low +
            last.classesAfter.mid +
            last.classesAfter.high -
            (last.classesBefore.low + last.classesBefore.mid + last.classesBefore.high),
        )} 人`
      : '—',
    businessText: last
      ? `经营影响 J ${last.business.j.toFixed(3)} · I ${last.business.i.toFixed(3)} · P ${last.business.p.toFixed(3)}（已乘 0.30）`
      : '—',
    marketText: last
      ? `股市影响：下跌强度 ${marketValid ? '有效' : '中性（样本未覆盖完整月）'}`
      : '—',
    marketReturnText: marketValid ? pct(marketReturn, 2) : '—',
    marketCoverageText: marketValid
      ? `下跌覆盖 ${pct(downRatio, 1)} · 上涨覆盖 ${pct(upRatio, 1)}`
      : '—',
    marketValid,
    trend,
    sampleNote:
      '经营影响只统计**可模拟企业样本**（当前在营与 AI 企业），不代表全市实际就业率；' +
      '其余为中性背景经济基准。',
    incompleteNote: last && !last.market.valid
      ? '本月证券观察窗口没有覆盖完整月份，股市阶层冲击按中性处理；经营影响需要三个完整观察月才会启用。'
      : null,
  };
}

function buildPoliticsSection(state: ReadonlyGameState): PoliticsSection {
  const classes = state.population.classes;
  const total = totalPopulationOf(state.population);
  const sizes = groupSizes(classes);
  const support = currentSupportOf(state);
  const margins = marginSatisfactionOf(state.politics, classes);
  const monitor = state.politics.earlyElection;
  const protectionLeft = Math.max(0, monitor.protectionUntilMinute - state.clock.totalMinute);

  // 全人口加权支持率：按群体比例加权，不乘投票率，也不是预计有效票占比
  const weightedSupport = CANDIDATES.map((candidate) => {
    let weighted = 0;
    for (const row of sizes) {
      const groupSupport = support.find((item) => item.groupId === row.config.id);
      weighted += (groupSupport?.support[candidate.id] ?? 0) * row.ratio;
    }
    return { candidate, weighted };
  });

  const groups: PoliticalGroupSlice[] = sizes.map((row) => {
    const groupSupport = support.find((item) => item.groupId === row.config.id);
    const perCandidate = CANDIDATES.map((candidate) => {
      const ratio = groupSupport?.support[candidate.id] ?? 0;
      return {
        candidateId: candidate.id,
        name: candidate.name,
        ratio,
        ratioText: pct(ratio, 1),
      };
    });
    const groupState = state.politics.groups[row.config.id];
    return {
      id: row.config.id,
      name: row.config.name,
      incomeName: INCOME_NAMES[row.config.income],
      interestName: INTEREST_NAMES[row.config.interest] ?? row.config.interest,
      people: Math.round(row.people),
      peopleText: `${Math.round(row.people).toLocaleString('en-US')} 人`,
      ratio: row.ratio,
      ratioText: pct(row.ratio, 1),
      note: row.config.note,
      turnoutText: `投票率 ${pct(row.config.turnout, 0)}`,
      satisfactionText: `${(groupState?.satisfaction ?? 0).toFixed(2)} / 100`,
      support: perCandidate,
    };
  });

  const toMargin = (kind: 'income' | 'interest'): MarginSlice[] =>
    margins
      .filter((row) => row.id.startsWith(`${kind}:`))
      .map((row) => ({
        id: row.id,
        name:
          MARGIN_DEFINITIONS.find((definition) => definition.id === row.id)?.name ?? row.id,
        peopleText: `${Math.round(row.populationShare * total).toLocaleString('en-US')} 人`,
        ratioText: pct(row.populationShare),
        satisfactionText: `${row.satisfaction.toFixed(2)} / 100`,
        consecutiveMonths:
          monitor.groupMonths[row.id as keyof typeof monitor.groupMonths] ?? 0,
      }));

  return {
    groups,
    incomeMargins: toMargin('income'),
    interestMargins: toMargin('interest'),
    averageSatisfactionText: `${averageSatisfactionOf(state.politics, classes).toFixed(2)} / 100`,
    cityMonthsText: `全市低满意度连续月计数 ${monitor.cityMonths} / ${EARLY_ELECTION_RULES.consecutiveMonths}`,
    protectionText:
      protectionLeft > 0
        ? `新任政府保护期剩余 ${Math.ceil(protectionLeft / TIME.calendar.minutesPerDay)} 天（保护期内只记录、不启动）`
        : '保护期已结束',
    earlyElectionNote:
      `提前选举：全市平均满意度 < ${EARLY_ELECTION_RULES.citySatisfactionThreshold}，` +
      `或某个主要群体满意度 < ${EARLY_ELECTION_RULES.groupSatisfactionThreshold} 且占人口 ≥ ${pct(
        EARLY_ELECTION_RULES.groupPopulationShare,
        0,
      )}，连续 ${EARLY_ELECTION_RULES.consecutiveMonths} 个已结束游戏月成立才启动；` +
      `每个真实任期最多一次，提前竞选仍为 ${EARLY_ELECTION_RULES.campaignDays} 日。`,
    note:
      '政治群体 = 3 收入阶层 × 4 利益归属 = 12 个互不重复群体：人数由经济阶层人数 × 条件权重派生，' +
      '合计严格等于城市人口；收入/利益边际只是展示与监测视角，不能再加到总人口上。',
    summaryText: weightedSupport
      .map((row) => `${row.candidate.name} ${pct(row.weighted)}`)
      .join(' · '),
  };
}

function buildStructureSection(state: ReadonlyGameState): StructureSection {
  const holder = state.government.currentHolder;
  const policy = activePolicyOf(state.government);
  const effects = currentPolicyEffects(state.government);
  const term = activeTermOf(state.government);
  const deadline = state.elections.deadlineMinute;
  const now = state.clock.totalMinute;
  const leftMinutes = Math.max(0, deadline - now);
  const days = Math.floor(leftMinutes / TIME.calendar.minutesPerDay);
  const hours = Math.floor((leftMinutes % TIME.calendar.minutesPerDay) / 60);
  return {
    institution: GOVERNMENT_INSTITUTION,
    officeTitle: GOVERNMENT_OFFICE_TITLE,
    holderName: holder?.name ?? '（无在任负责人）',
    holderSinceText: holder
      ? formatGameDate(dateAtMinute(holder.sinceMinute, TIME.calendar))
      : '—',
    termLeftText: `距下次投票还有 ${days} 天 ${hours} 小时`,
    termIdText: term?.id ?? '—',
    directionText:
      term?.direction === null || term?.direction === undefined
        ? '无（过渡负责人 / 接入前任期）'
        : DIRECTION_NAMES[term.direction] ?? term.direction,
    sourceText:
      term === null
        ? '—'
        : term.source === 'election'
          ? '选举产生'
          : term.source === 'migration'
            ? '旧档接入前任期（不补做建设判断）'
            : '开局过渡',
    policyLabel: policy
      ? ({
          innovation: '科技与创新：新产品研发能力提高 5%',
          employment: '商业与就业：企业固定运营成本降低 5%',
          infrastructure: '基础设施与城市发展：产品单位销售成本降低 2%',
        } as const)[policy]
      : '无（过渡负责人不执行任何产业政策）',
    policyEffects: [
      { label: '研发增长倍率', value: `×${effects.researchGrowthMultiplier.toFixed(2)}` },
      { label: '固定运营成本倍率', value: `×${effects.operatingCostMultiplier.toFixed(2)}` },
      { label: '销售成本倍率', value: `×${effects.salesCostMultiplier.toFixed(2)}` },
    ],
    caretaker: holder?.candidateId === null || holder === null,
    note:
      '每届任期保存「方向 + 政策效果快照 + 配置版本」，生效政策只从当前任期快照读取；' +
      '旧任期效果被整体替换、不累乘企业基础数据，连任也只生效一套倍率。' +
      '已立项研发继续使用立项时的快照。',
  };
}

function buildCampaignSection(state: ReadonlyGameState): CampaignSection {
  const elections = state.elections;
  const now = state.clock.totalMinute;
  const total = totalPopulationOf(state.population);
  const support = currentSupportOf(state);
  const sizes = groupSizes(state.population.classes);
  const groupPeople: Record<string, number> = {};
  const turnout: Record<string, number> = {};
  for (const row of sizes) {
    groupPeople[row.config.id] = row.people;
    turnout[row.config.id] = row.config.turnout;
  }
  // 开票与界面预计共用同一份参与人数/票数口径（含投票资格比例）
  const tally = tallyVotes({
    totalPopulation: total,
    groups: POLITICS_GROUPS,
    support,
    groupPeople,
    turnout,
  });
  const leftMinutes = Math.max(0, elections.deadlineMinute - now);
  const days = Math.floor(leftMinutes / TIME.calendar.minutesPerDay);
  const hours = Math.floor((leftMinutes % TIME.calendar.minutesPerDay) / 60);
  const sponsorDisabled = elections.phase !== 'campaign' || now >= elections.deadlineMinute;

  const candidates: CandidateSlice[] = CANDIDATES.map((candidate) => {
    const expected = tally.votes.find((row) => row.candidateId === candidate.id)?.votes ?? 0;
    // 全人口加权支持率：Σ 群体比例 × 群体内支持率；不乘投票率，也不是预计票占比
    const weightedSupport = sizes.reduce(
      (sum, row) =>
        sum +
        (support.find((item) => item.groupId === row.config.id)?.support[candidate.id] ?? 0) *
          row.ratio,
      0,
    );
    return {
      id: candidate.id,
      name: candidate.name,
      platform: candidate.platform,
      policyLabel: ({
        innovation: '新产品研发能力 +5%',
        employment: '固定运营成本 −5%',
        infrastructure: '单位销售成本 −2%',
      } as const)[candidate.policy],
      campaignAbilityText: `宣传能力 ${candidate.campaignAbility.toFixed(2)}`,
      baseText: formatMoney(elections.candidates[candidate.id]?.base ?? 0),
      sponsoredText: formatMoney(sponsoredResourcesOf(elections, candidate.id)),
      usedText: formatMoney(usedResourcesOf(elections, candidate.id)),
      remainingText: formatMoney(remainingResourcesOf(elections, candidate.id)),
      advertisingText: `宣传影响 ${advertisingOf(elections, candidate.id).toFixed(3)}`,
      expectedVotesText: `预计 ${expected.toLocaleString('en-US')} 票`,
      supportText: pct(weightedSupport, 1),
    };
  });

  const records = elections.sponsorshipRecords
    .slice(-8)
    .reverse()
    .map((record) => ({
      candidateName:
        CANDIDATES.find((candidate) => candidate.id === record.candidateId)?.name ?? '候选人',
      amountText: formatMoney(record.amountCents),
      atText: formatGameDate(dateAtMinute(record.atMinute, TIME.calendar)),
    }));

  return {
    phaseText: elections.phase === 'campaign' ? '竞选进行中' : '任期之间（下一届竞选尚未开始）',
    deadlineText: formatGameDate(dateAtMinute(elections.deadlineMinute, TIME.calendar)),
    countdownText: `距投票还有 ${days} 天 ${hours} 小时`,
    eligibleText: `${tally.eligiblePeople.toLocaleString('en-US')} 人`,
    expectedParticipantsText: `${tally.participatingPeople.toLocaleString('en-US')} 人`,
    // 投票率口径 = 预计参与人数 ÷ 合格人数（不是参与人数 ÷ 总人口）
    turnoutText: pct(tally.turnoutRatio, 1),
    lowTurnout: tally.lowTurnout,
    sponsorDisabled,
    availableBalanceText: formatMoney(state.finance.accounts.savings),
    candidates,
    sponsorNote:
      '赞助仅使用个人存款，**不可退款**；本届未使用的竞选资源在届末失效，不结转、不兑换现金。' +
      '赞助只提高宣传影响，不直接购买选票，也不保证当选。',
    records,
  };
}

/** 政策效果快照 → 一行说明（历史记录用）。 */
function effectsTextOf(effects: {
  readonly researchGrowthMultiplier: number;
  readonly operatingCostMultiplier: number;
  readonly salesCostMultiplier: number;
}): string {
  return `研发 ×${effects.researchGrowthMultiplier.toFixed(2)} · 运营 ×${effects.operatingCostMultiplier.toFixed(2)} · 销售成本 ×${effects.salesCostMultiplier.toFixed(2)}`;
}

function buildHistorySection(state: ReadonlyGameState): HistorySection {
  const elections: HistorySection['elections'] = [...state.elections.history]
    .reverse()
    .map((result: DeepReadonly<ElectionResult>) => ({
      termText: `第 ${result.termSeq} 届`,
      atText: formatGameDate(dateAtMinute(result.atMinute, TIME.calendar)),
      populationText: `${Math.round(result.totalPopulation).toLocaleString('en-US')} 人`,
      eligibleText: `${result.eligiblePeople.toLocaleString('en-US')} 人`,
      participantsText: `${result.participatingPeople.toLocaleString('en-US')} 人`,
      votesText: result.votes
        .map((row) => {
          const name = CANDIDATES.find((candidate) => candidate.id === row.candidateId)?.name ?? '';
          return `${name} ${row.votes.toLocaleString('en-US')}`;
        })
        .join(' · '),
      winnerText:
        result.winnerId === null
          ? '无有效票（过渡负责人留任）'
          : (CANDIDATES.find((candidate) => candidate.id === result.winnerId)?.name ?? ''),
      tieNote: result.tieBreakNote,
      lowTurnout: result.lowTurnout,
    }));

  const terms: HistorySection['terms'] = [...state.government.terms]
    .reverse()
    .map((term) => ({
      id: term.id,
      name: term.name,
      startText: formatGameDate(dateAtMinute(term.startMinute, TIME.calendar)),
      endText:
        term.endMinute === null
          ? '在任'
          : formatGameDate(dateAtMinute(term.endMinute, TIME.calendar)),
      policyText: term.policy ?? '无产业政策',
      directionText:
        term.direction === null ? '无方向' : DIRECTION_NAMES[term.direction] ?? term.direction,
      sourceText:
        term.source === 'election'
          ? '选举'
          : term.source === 'migration'
            ? '旧档接入'
            : '过渡',
      effectsText: effectsTextOf(term.effects),
      note: term.note,
    }));

  return {
    elections,
    terms,
    emptyText: '尚无选举记录：第一届竞选尚未结束。',
  };
}

/** 政府面板的完整只读视图。 */
export function buildGovernmentView(state: ReadonlyGameState): GovernmentPanelView {
  return {
    institution: GOVERNMENT_INSTITUTION,
    population: buildPopulationSection(state),
    politics: buildPoliticsSection(state),
    structure: buildStructureSection(state),
    campaign: buildCampaignSection(state),
    history: buildHistorySection(state),
  };
}
