/**
 * 城市经济面板视图 —— 全部只读数据在此汇总。
 *
 * 规则：
 *  - 只读：不补建状态、不扣款、不触发结算；
 *  - 界面只消费这里的视图，不直接读 features；
 *  - 只展示**有真实来源**的统计：GDP 三部分、经营产出、股市调整、12 群体、
 *    可模拟企业样本、建设阶段与逻辑地图；
 *  - 没有全城市就业/工资/住房供给数据时明确标注统计覆盖范围，不把少量科技公司的样本冒充全城实测；
 *  - GDP 不是现金，不显示任何「GDP 账户」。
 */

import { dateAtMinute, formatGameDate } from '../core/calendar';
import { formatMoney } from '../core/money';
import { TIME } from '../content/config';
import {
  CITY_DEVELOPMENT_RULES,
  CITY_ECONOMY_RULES,
  DEVELOPMENT_DIRECTION_LABELS,
} from '../content/city-economy';
import { INTEREST_GROUPS, INCOME_TIERS } from '../content/politics';
import { isClosed, payablesOf } from '../features/enterprise';
import { displayClasses, totalPopulationOf } from '../features/population';
import {
  averageSatisfactionOf,
  groupSizes,
  marginSatisfactionOf,
} from '../features/politics';
import { developmentViewOf } from './city-development';
import { industriesOf, liveCityEconomyOf } from './city-statistics';
import type { ReadonlyGameState } from './state';

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function yuan(cents: number): string {
  return formatMoney(cents);
}

export interface CityEconomySection {
  readonly gdpText: string;
  readonly baseGdpText: string;
  readonly cumulativeOutputText: string;
  readonly settledOutputText: string;
  readonly pendingOutputText: string;
  readonly compositionText: string;
  readonly stockAdjustText: string;
  readonly stockWeightText: string;
  readonly indexText: string;
  readonly indexValid: boolean;
  readonly indexNote: string;
  readonly monthOutputText: string;
  readonly trend: Array<{
    readonly monthKey: string;
    readonly gdpText: string;
    readonly outputText: string;
    readonly indexText: string;
  }>;
  readonly industries: Array<{
    readonly id: string;
    readonly label: string;
    readonly centsText: string;
    readonly ratio: number;
    readonly ratioText: string;
  }>;
  readonly industryNote: string;
  readonly notes: string;
}

export interface CityPopulationSection {
  readonly totalText: string;
  readonly classes: Array<{
    readonly name: string;
    readonly peopleText: string;
    readonly ratioText: string;
  }>;
  readonly interestMargins: Array<{
    readonly name: string;
    readonly peopleText: string;
    readonly ratioText: string;
    readonly satisfactionText: string;
  }>;
  readonly incomeMargins: Array<{
    readonly name: string;
    readonly peopleText: string;
    readonly ratioText: string;
    readonly satisfactionText: string;
  }>;
  readonly note: string;
}

export interface CityPoliticsSection {
  readonly averageSatisfactionText: string;
  readonly groups: Array<{
    readonly id: string;
    readonly name: string;
    readonly peopleText: string;
    readonly ratioText: string;
    readonly satisfactionText: string;
  }>;
  readonly earlyElectionNote: string;
  readonly cityMonthsText: string;
  readonly protectionText: string;
  readonly note: string;
}

export interface CitySampleSection {
  readonly companyCountText: string;
  readonly activeCompanyCountText: string;
  readonly payablesText: string;
  readonly jText: string;
  readonly iText: string;
  readonly pText: string;
  readonly employmentText: string;
  readonly note: string;
}

export interface CityDevelopmentSection {
  readonly stageText: string;
  readonly nextThresholdText: string;
  readonly gapText: string;
  readonly lastJudgementText: string;
  readonly projects: Array<{
    readonly stageText: string;
    readonly directionText: string;
    readonly statusText: string;
    readonly completeText: string;
    readonly note: string;
  }>;
  readonly completions: Array<{
    readonly districtText: string;
    readonly directionText: string;
    readonly completedText: string;
  }>;
  readonly note: string;
}

export interface CityTerritorySection {
  readonly boundsText: string;
  readonly districts: Array<{
    readonly name: string;
    readonly directionText: string;
    readonly completedText: string;
    readonly buildingCountText: string;
  }>;
  readonly buildingCountText: string;
  readonly shopCountText: string;
  readonly companyBuildingCountText: string;
  readonly note: string;
}

export interface CityEconomyPanelView {
  readonly economy: CityEconomySection;
  readonly population: CityPopulationSection;
  readonly politics: CityPoliticsSection;
  readonly sample: CitySampleSection;
  readonly development: CityDevelopmentSection;
  readonly territory: CityTerritorySection;
}

function buildEconomy(state: ReadonlyGameState): CityEconomySection {
  const nowMinute = state.clock.totalMinute;
  const live = liveCityEconomyOf(state, nowMinute);
  const industries = industriesOf(state);
  const totalOutput = industries.reduce((sum, row) => sum + row.cents, 0);
  const months = state.cityStatistics.months;

  return {
    gdpText: yuan(live.gdpCents),
    baseGdpText: yuan(live.baseGdpCents),
    cumulativeOutputText: yuan(live.cumulativeOutputCents),
    settledOutputText: `${CITY_ECONOMY_RULES.labels.settled} ${yuan(live.settledOutputCents)}`,
    pendingOutputText: `${CITY_ECONOMY_RULES.labels.pending} ${yuan(live.pendingOutputCents)}`,
    compositionText:
      `G = 基础 ${yuan(live.baseGdpCents)} + 累计经营产出 ${yuan(live.cumulativeOutputCents)}` +
      `${live.stockAdjustCents >= 0 ? ' + ' : ' − '}股市调整 ${yuan(Math.abs(live.stockAdjustCents))}`,
    stockAdjustText: yuan(live.stockAdjustCents),
    stockWeightText: `${(CITY_ECONOMY_RULES.stockWeight * 100).toFixed(0)}% × (指数 ÷ 100 − 1)`,
    indexText: live.indexValue.toFixed(2),
    indexValid: live.indexValid,
    indexNote: live.indexValid
      ? `有效样本 ${live.indexSampleCount} 只`
      : `样本不足（${live.indexSampleCount} 只），指数保持上一观察值，不静默恢复 100`,
    monthOutputText: yuan(live.monthOutputCents),
    trend: months.slice(-12).map((row) => ({
      monthKey: row.monthKey,
      gdpText: yuan(row.gdpCents),
      outputText: yuan(row.outputMonthCents),
      indexText: row.indexValue.toFixed(2),
    })),
    industries: industries.map((row) => ({
      id: row.id,
      label: row.label,
      centsText: yuan(row.cents),
      ratio: totalOutput > 0 ? row.cents / totalOutput : 0,
      ratioText: pct(totalOutput > 0 ? row.cents / totalOutput : 0),
    })),
    industryNote:
      '产业占比只使用**真实经营产出**（实际售出数量 × 当时成交单价）；股市调整单独展示，' +
      '不会作为负产业面积进入饼图。股票成交额、融资、增发到账、贷款与旧资产转手都不计入经营产出。',
    notes:
      'GDP 是本作的发展指标（实时累计口径），不是现金，也不是财政账户；' +
      '经营产出不按月/年清零，已经创造的产出不会因为亏损、破产或股价下跌被删除。',
  };
}

function buildPopulation(state: ReadonlyGameState): CityPopulationSection {
  const classes = state.population.classes;
  const display = displayClasses(classes);
  const total = totalPopulationOf(state.population);
  const margins = marginSatisfactionOf(state.politics, classes);
  const incomeRows = INCOME_TIERS.map((tier) => {
    const people = classes[tier.id];
    const margin = margins.find((row) => row.id === `income:${tier.id}`);
    return {
      name: `${tier.name}群体`,
      peopleText: `${Math.round(people).toLocaleString('en-US')} 人`,
      ratioText: pct(total > 0 ? people / total : 0),
      satisfactionText: `${(margin?.satisfaction ?? 0).toFixed(1)} / 100`,
    };
  });
  const interestRows = INTEREST_GROUPS.map((interest) => {
    const margin = margins.find((row) => row.id === `interest:${interest.id}`);
    const people = (margin?.populationShare ?? 0) * total;
    return {
      name: interest.name,
      peopleText: `${Math.round(people).toLocaleString('en-US')} 人`,
      ratioText: pct(margin?.populationShare ?? 0),
      satisfactionText: `${(margin?.satisfaction ?? 0).toFixed(1)} / 100`,
    };
  });
  return {
    totalText: `${display.total.toLocaleString('en-US')} 人`,
    classes: [
      { name: '低收入', peopleText: display.low.toLocaleString('en-US'), ratioText: pct(total > 0 ? display.low / display.total : 0) },
      { name: '中收入', peopleText: display.mid.toLocaleString('en-US'), ratioText: pct(total > 0 ? display.mid / display.total : 0) },
      { name: '高收入', peopleText: display.high.toLocaleString('en-US'), ratioText: pct(total > 0 ? display.high / display.total : 0) },
    ],
    interestMargins: interestRows,
    incomeMargins: incomeRows,
    note:
      '收入与利益边际是**展示与监测视角**，不能把边际人数再加到总人口上；' +
      '12 群体人数由经济阶层人数 × 条件权重派生，合计严格等于城市人口。',
  };
}

function buildPolitics(state: ReadonlyGameState): CityPoliticsSection {
  const classes = state.population.classes;
  const total = totalPopulationOf(state.population);
  const sizes = groupSizes(classes);
  const average = averageSatisfactionOf(state.politics, classes);
  const monitor = state.politics.earlyElection;
  const protectionLeft = Math.max(0, monitor.protectionUntilMinute - state.clock.totalMinute);
  return {
    averageSatisfactionText: `${average.toFixed(2)} / 100`,
    groups: sizes.map((row) => ({
      id: row.config.id,
      name: row.config.name,
      peopleText: `${Math.round(row.people).toLocaleString('en-US')} 人`,
      ratioText: pct(total > 0 ? row.people / total : 0),
      satisfactionText: `${(state.politics.groups[row.config.id]?.satisfaction ?? 0).toFixed(2)}`,
    })),
    earlyElectionNote:
      `提前选举条件：全市平均满意度 < 35，或某个主要群体满意度 < 25 且占人口 ≥ 20%，` +
      `连续 3 个已结束游戏月成立才启动；每个真实任期最多一次，提前竞选仍为 30 日。`,
    cityMonthsText: `全市低满意度连续月计数 ${monitor.cityMonths} / 3`,
    protectionText:
      protectionLeft > 0
        ? `新任政府保护期剩余 ${Math.ceil(protectionLeft / TIME.calendar.minutesPerDay)} 天（保护期内只记录不启动）`
        : '保护期已结束',
    note:
      '满意度是 0～100 的独立指标（新游戏 50），与选举支持率是两件事；' +
      '进入支持率计算时使用 (满意度 − 50) / 50，不会把 0～100 直接塞进原评分公式。GDP 不作为满意度加分项。',
  };
}

function buildSample(state: ReadonlyGameState): CitySampleSection {
  const companies = Object.values(state.enterprises.companies);
  const active = companies.filter((company) => !isClosed(company));
  const payables = active.reduce((sum, company) => sum + payablesOf(company), 0);
  const records = state.population.records;
  const last = records[records.length - 1] ?? null;
  const assigned = Object.values(state.talent.assignments).filter(
    (assignment) => assignment !== null && assignment !== undefined,
  ).length;
  const weight = 0.3;
  const restore = (value: number): number => (weight > 0 ? value / weight : 0);
  return {
    companyCountText: `${companies.length} 家`,
    activeCompanyCountText: `${active.length} 家在营/暂停/危机`,
    payablesText: yuan(payables),
    jText: last ? restore(last.business.j).toFixed(3) : '数据不足',
    iText: last ? restore(last.business.i).toFixed(3) : '数据不足',
    pText: last ? restore(last.business.p).toFixed(3) : '数据不足',
    employmentText: `${assigned} 个科研高管任职`,
    note:
      '以上只是**可模拟企业样本**（当前在营与 AI 企业）的经营、就业薪酬与产业指标，' +
      '不是全市实际就业率、工资水平或产业普查；本作没有全城市就业、工资与住房供给模型。',
  };
}

function buildDevelopment(state: ReadonlyGameState): CityDevelopmentSection {
  const view = developmentViewOf(state);
  return {
    stageText: `已完成阶段 ${view.completions.length} / ${CITY_DEVELOPMENT_RULES.stageCount}`,
    nextThresholdText:
      view.thresholdCents === null ? '已无剩余扩张位置' : yuan(view.thresholdCents),
    gapText:
      view.gapCents === null
        ? '—'
        : view.gapCents > 0
          ? `尚差 ${yuan(view.gapCents)}`
          : '已达标（等待下一次真实成功选举判断）',
    lastJudgementText: view.lastJudgement
      ? `${view.lastJudgement.note}（${formatGameDate(dateAtMinute(view.lastJudgement.judgedAtMinute, TIME.calendar))}，当时 GDP ${yuan(view.lastJudgement.gdpCents)}，门槛 ${yuan(view.lastJudgement.thresholdCents)}）`
      : '本版本新游戏尚未有过建设判断',
    projects: view.projects.map((project) => ({
      stageText: `第 ${project.stage + 1} 阶段`,
      directionText: DEVELOPMENT_DIRECTION_LABELS[project.direction],
      statusText: project.status === 'completed' ? '已完成' : '建设中',
      completeText: formatGameDate(dateAtMinute(project.completeAtMinute, TIME.calendar)),
      note:
        project.status === 'completed'
          ? '已落成并计入永久建设历史'
          : '项目一旦批准不因后续股市下跌或负责人更换取消',
    })),
    completions: view.completions.map((row) => ({
      districtText: row.districtId,
      directionText: DEVELOPMENT_DIRECTION_LABELS[row.direction],
      completedText: formatGameDate(dateAtMinute(row.completedAtMinute, TIME.calendar)),
    })),
    note:
      `建设只在「成功选举并形成真实新任期」之后判断一次：门槛 = 基础 GDP + ${yuan(CITY_DEVELOPMENT_RULES.firstThresholdCents)} × 1.6^阶段，` +
      `每个项目固定 ${CITY_DEVELOPMENT_RULES.projectDays} 游戏日；GDP 不作为建设费用扣除，也不从玩家或企业账户扣钱。`,
  };
}

function buildTerritory(state: ReadonlyGameState): CityTerritorySection {
  const layout = state.cityLayout;
  const districts = layout.districts;
  const baseBuildings = layout.buildings.filter((building) => building.districtId === 'district-base');
  return {
    boundsText:
      `x ${layout.bounds.minX.toFixed(0)} ~ ${layout.bounds.maxX.toFixed(0)} 米 · ` +
      `z ${layout.bounds.minZ.toFixed(0)} ~ ${layout.bounds.maxZ.toFixed(0)} 米`,
    districts: districts.map((district) => {
      const count = layout.buildings.filter((building) => building.districtId === district.id).length;
      return {
        name: district.id,
        directionText:
          district.direction === null
            ? '基础城区'
            : DEVELOPMENT_DIRECTION_LABELS[district.direction],
        completedText:
          district.completedAtMinute > 0
            ? formatGameDate(dateAtMinute(district.completedAtMinute, TIME.calendar))
            : '开局既有',
        buildingCountText: `${count} 栋`,
      };
    }),
    buildingCountText: `${layout.buildings.length} 栋`,
    shopCountText: `${layout.buildings.filter((building) => building.shopId !== null).length} 处可购物`,
    companyBuildingCountText: `${layout.buildings.filter((building) => building.companyId !== null).length} 栋绑定真实企业`,
    note:
      `逻辑地图版本 ${layout.layoutVersion}，revision ${layout.revision}；` +
      `基础城区 ${baseBuildings.length} 栋建筑保持开局布局不变，扩建条带沿同一方向拼接 60 米。` +
      '所有生成结果写入存档，读档不重新随机。',
  };
}

/** 城市经济面板的完整只读视图。 */
export function buildCityEconomyView(state: ReadonlyGameState): CityEconomyPanelView {
  return {
    economy: buildEconomy(state),
    population: buildPopulation(state),
    politics: buildPolitics(state),
    sample: buildSample(state),
    development: buildDevelopment(state),
    territory: buildTerritory(state),
  };
}
