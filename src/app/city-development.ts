/**
 * 城市建设应用层 —— 选举后唯一一次判断、项目完成推进、招商槽位与只读视图。
 *
 * 职责边界：
 *  - 只读 `GameState` 切片、只调用 features 的纯函数；不创建 Three.js 对象、不碰 DOM。
 *  - 项目完成时把城区真正追加到逻辑地图（features/city-layout），并建立待招商槽位；
 *    真实公司由 Lead 的 `app/city-enterprises` 创建，本文件只提供「下一个待招商槽位」。
 *  - 不写第二套时钟：所有时间都来自调用方传入的游戏分钟。
 */

import { CALENDAR } from '../content/config';
import {
  CITY_DEVELOPMENT_RULES,
  CONSTRUCTION_OUTCOME_LABELS,
  DEVELOPMENT_DIRECTION_LABELS,
} from '../content/city-economy';
import { districtTemplateOf, type DistrictDirection } from '../content/districts';
import {
  addEnterpriseSlot,
  approveProject,
  markProjectCompleted,
  nextAvailableStage,
  recordJudgement,
  thresholdForStage,
  type CompletedDistrictRecord,
  type ConstructionJudgementRecord,
  type ConstructionOutcome,
  type EnterpriseSlotState,
} from '../features/city-development';
import {
  addDistrict,
  enterpriseBuildingIdFor,
  findLayoutBuilding,
} from '../features/city-layout';
import { deliverHousingUnits } from '../features/real-estate';
import { liveCityEconomyOf } from './city-statistics';
import { districtFactorOf } from './real-estate';
import type { GameState, ReadonlyGameState } from './state';

/**
 * 从稳定 term id 解析单调任期序号（`term-<n>`）。
 *
 * 非法 id 一律返回 0：0 永远不大于高水位，因此非法任期不会被误判为「新任期」。
 */
export function termOrdinalOf(termId: string): number {
  const matched = /^term-(\d+)$/.exec(termId);
  if (!matched) return 0;
  const raw = matched[1];
  const ordinal = Number(raw);
  return Number.isSafeInteger(ordinal) && ordinal > 0 ? ordinal : 0;
}

/**
 * 选举后第 8 步：本任期唯一一次建设判断。
 *
 * - `gdpCents` 由调用方传入**已结算口径**（不含待结算投影）；
 * - 任期序号必须严格大于 `judgedTermHighWater`，否则直接返回 null（永久防重复）；
 * - 未达门槛/无剩余位置/接入前任期也必须记录「已判断」，写高水位；
 * - 批准时预留唯一阶段并生成项目（不创建 Three.js 对象、不改布局）。
 */
export function judgeTermConstruction(
  draft: GameState,
  input: {
    termId: string;
    direction: DistrictDirection | null;
    atMinute: number;
    gdpCents: number;
  },
): ConstructionJudgementRecord | null {
  const development = draft.cityDevelopment;
  const termOrdinal = termOrdinalOf(input.termId);
  // 非法 term id（0）或已经判断过的任期：不做第二次判断，也不写历史。
  if (termOrdinal <= 0 || termOrdinal <= development.judgedTermHighWater) return null;

  const baseGdpCents = draft.cityStatistics.base.gdpCents;
  // `?? null` 兼容运行时「政策映射缺项 → undefined」：类型仍是 DistrictDirection | null，
  // 但缺方向时按「接入前任期」处理，不让时间推进因索引缺项中断。
  const direction: DistrictDirection | null = input.direction ?? null;
  const stage = direction === null ? null : nextAvailableStage(development);

  let outcome: ConstructionOutcome;
  let thresholdCents = 0;
  let projectId: string | null = null;
  let note: string;

  if (direction === null) {
    outcome = 'legacy-skip';
    note = CONSTRUCTION_OUTCOME_LABELS['legacy-skip'];
  } else if (stage === null) {
    outcome = 'no-slot';
    // 展示用：记录「若还有下一阶段」的理论门槛，让人看出 GDP 早已超过、只是没有位置。
    thresholdCents = thresholdForStage(baseGdpCents, CITY_DEVELOPMENT_RULES.stageCount);
    note = CONSTRUCTION_OUTCOME_LABELS['no-slot'];
  } else {
    thresholdCents = thresholdForStage(baseGdpCents, stage);
    if (input.gdpCents < thresholdCents) {
      outcome = 'below-threshold';
      note = `${CONSTRUCTION_OUTCOME_LABELS['below-threshold']}（差 ${thresholdCents - input.gdpCents} 分）`;
    } else {
      const template = districtTemplateOf(direction);
      const project = approveProject(development, {
        stage,
        direction,
        sourceTermId: input.termId,
        approvedAtMinute: input.atMinute,
        gdpAtApprovalCents: input.gdpCents,
        thresholdCents,
        templateId: template.id,
        templateVersion: template.version,
        // 与 addDistrict 用同一个推导函数，保证批准时写下的招商建筑 id 与实际生成一致。
        enterpriseBuildingId: enterpriseBuildingIdFor(template.id, stage),
      });
      projectId = project.id;
      outcome = 'approved';
      note = `${CONSTRUCTION_OUTCOME_LABELS.approved}：${DEVELOPMENT_DIRECTION_LABELS[direction]}`;
    }
  }

  // 先落高水位：即使后面展示记录被裁剪，也不会再对同一任期做第二次判断。
  development.judgedTermHighWater = termOrdinal;
  const record: ConstructionJudgementRecord = {
    termId: input.termId,
    termOrdinal,
    judgedAtMinute: input.atMinute,
    gdpCents: input.gdpCents,
    thresholdCents,
    stage,
    outcome,
    projectId,
    note,
  };
  recordJudgement(development, record);
  return record;
}

/**
 * 时间推进：完成到期的旧建设项目（先完成旧项目，再判断新任期建设由调用方保证）。
 *
 * 幂等、只处理 `status === 'building'` 且 `completeAtMinute <= nowMinute` 的项目；
 * 同一项目重复调用不会重复写完成历史，也不会重复追加城区。
 * 完成顺序按「计划完成时刻 → 项目 id」稳定排列，不依赖对象遍历顺序。
 */
export function completeDueProjects(
  draft: GameState,
  nowMinute: number,
): CompletedDistrictRecord[] {
  const development = draft.cityDevelopment;
  const dueProjectIds = development.projects
    .filter((project) => project.status === 'building' && project.completeAtMinute <= nowMinute)
    .sort((left, right) => {
      if (left.completeAtMinute !== right.completeAtMinute) {
        return left.completeAtMinute - right.completeAtMinute;
      }
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    })
    .map((project) => project.id);

  const completed: CompletedDistrictRecord[] = [];
  for (const projectId of dueProjectIds) {
    const project = development.projects.find((item) => item.id === projectId);
    if (!project) continue;
    const record = markProjectCompleted(development, projectId, nowMinute);
    if (!record) continue;

    // 1) 真实追加城区几何（边界/道路/地块/建筑）；读档后重复调用也不会追加第二份。
    const districtExists = draft.cityLayout.districts.some(
      (district) => district.id === record.districtId,
    );
    if (!districtExists) {
      const added = addDistrict(draft.cityLayout, {
        direction: project.direction,
        stage: project.stage,
        templateId: project.templateId,
        templateVersion: project.templateVersion,
        sourceTermId: project.sourceTermId,
        sourceProjectId: project.id,
        completedAtMinute: record.completedAtMinute,
      });
      if (added.district.id !== record.districtId) {
        throw new Error(
          `[city-development] 城区 id 不一致：项目完成记录 ${record.districtId}，布局生成 ${added.district.id}`,
        );
      }
      if (added.enterpriseBuildingId !== project.enterpriseBuildingId) {
        throw new Error(
          `[city-development] 招商建筑 id 不一致：项目 ${project.id} 记录 ${String(
            project.enterpriseBuildingId,
          )}，布局生成 ${String(added.enterpriseBuildingId)}`,
        );
      }
    }

    // 2) 科技招商位：城区真实存在后才建 pending 槽位；真实公司由 app/city-enterprises 创建。
    if (project.enterpriseBuildingId !== null) {
      if (findLayoutBuilding(draft.cityLayout, project.enterpriseBuildingId) === null) {
        throw new Error(
          `[city-development] 城区 ${record.districtId} 缺少招商建筑 ${project.enterpriseBuildingId}`,
        );
      }
      addEnterpriseSlot(development, {
        districtId: record.districtId,
        buildingId: project.enterpriseBuildingId,
      });
    }

    // 3) 新区住宅交付：建设完成的**那一刻**把实际新增住宅写入房地产切片一次。
    //    幂等：按建筑 id 判重，读档与重复调用不会重复交房；不改变 GDP。
    deliverDistrictHousing(draft, record.districtId, record.completedAtMinute);

    completed.push(record);
  }
  return completed;
}

/**
 * 把一片城区里的住宅建筑交付为可追踪住宅单元（应用层唯一入口）。
 *
 * - 只处理 `kind === 'home'` 的建筑，且单元计划来自配置（`DISTRICT_HOUSING_PLANS`）；
 * - 交付即开启六个游戏月的玩家优先窗口（保护期从交付时刻起算）；
 * - 幂等：同一建筑已有单元时返回 0；
 * - 不登记 GDP、不发钱、不改变人口：交付只是「房子存在了」。
 */
export function deliverDistrictHousing(
  draft: GameState,
  districtId: string,
  completedAtMinute: number,
): number {
  const district = draft.cityLayout.districts.find((item) => item.id === districtId);
  if (!district) return 0;
  const prefix = `${district.templateId}-${district.stage}-`;
  let created = 0;
  for (const building of draft.cityLayout.buildings) {
    if (building.districtId !== districtId) continue;
    if (building.kind !== 'home') continue;
    if (!building.id.startsWith(prefix)) continue;
    created += deliverHousingUnits(draft.realEstate, {
      districtId,
      buildingId: building.id,
      buildingName: building.name,
      buildingSuffix: building.id.slice(prefix.length),
      deliveredAtMinute: completedAtMinute,
      districtFactor: districtFactorOf(districtId),
    });
  }
  return created;
}

/**
 * 待招商重试节点（日界调用）：返回下一个可尝试的 pending 槽位。
 *
 * 只做只读挑选，不创建公司；真实公司创建由 Lead 的 `app/city-enterprises` 完成，
 * 成功后调用 `markEnterpriseCreated` + `bindBuildingCompany`，失败调用 `noteEnterpriseAttempt`。
 * 资金不足等失败按配置的 `investment.retryDays` 游戏日节流；建筑不在当前布局中时跳过。
 */
export function nextPendingEnterpriseSlot(
  draft: GameState,
  nowMinute: number,
): EnterpriseSlotState | null {
  const retryMinutes =
    CITY_DEVELOPMENT_RULES.investment.retryDays * CALENDAR.minutesPerDay;
  for (const slot of draft.cityDevelopment.enterpriseSlots) {
    if (slot.status !== 'pending') continue;
    if (
      slot.lastAttemptMinute !== null &&
      nowMinute - slot.lastAttemptMinute < retryMinutes
    ) {
      continue;
    }
    if (findLayoutBuilding(draft.cityLayout, slot.buildingId) === null) continue;
    return slot;
  }
  return null;
}

/**
 * 迁移：把当前在任任期标记为「接入前任期、不补做建设判断」。
 *
 * 只写高水位（永久防重复）与一条展示用判断记录，**不写项目、不预留阶段**。
 * 已由更高高水位覆盖时幂等返回。
 */
export function adoptLegacyDevelopment(
  draft: GameState,
  termOrdinal: number,
  atMinute: number,
): void {
  if (!Number.isSafeInteger(termOrdinal) || termOrdinal <= 0) return;
  const development = draft.cityDevelopment;
  if (termOrdinal <= development.judgedTermHighWater) return;
  development.judgedTermHighWater = termOrdinal;
  recordJudgement(development, {
    termId: `term-${termOrdinal}`,
    termOrdinal,
    judgedAtMinute: atMinute,
    // 展示用：迁移时刻的实时 GDP（含当时可结算但尚未入账的产出）。
    // 若迁移基线刚好等于该时刻投影，则这部分为 0，与迁移前的已结算口径一致。
    gdpCents: liveCityEconomyOf(draft, atMinute).gdpCents,
    thresholdCents: 0,
    stage: null,
    outcome: 'legacy-skip',
    projectId: null,
    note: CONSTRUCTION_OUTCOME_LABELS['legacy-skip'],
  });
}

/** 只读：用于政府界面（不写状态、不创建任何状态）。 */
export function developmentViewOf(state: ReadonlyGameState): {
  stageCount: number;
  nextStage: number | null;
  thresholdCents: number | null;
  gdpCents: number;
  gapCents: number | null;
  projects: Array<{
    id: string;
    stage: number;
    direction: DistrictDirection;
    status: 'building' | 'completed';
    completeAtMinute: number;
    approvedAtMinute: number;
  }>;
  completions: Array<{
    districtId: string;
    stage: number;
    direction: DistrictDirection;
    completedAtMinute: number;
  }>;
  lastJudgement: ConstructionJudgementRecord | null;
} {
  const development = state.cityDevelopment;
  const baseGdpCents = state.cityStatistics.base.gdpCents;
  // 当前 GDP 用统一的城市经济查询（**实时口径**：G0 + 已结算 + 可结算待入账 + 股市调整），
  // 与界面显示的总 GDP 同口径；不在这里自己拼 G0 + 产出 + 股市调整。
  const gdpCents = liveCityEconomyOf(state, state.clock.totalMinute).gdpCents;
  const nextStage = nextAvailableStage(development);
  const thresholdCents =
    nextStage === null ? null : thresholdForStage(baseGdpCents, nextStage);
  const judgements = development.judgements;
  const last = judgements.length > 0 ? judgements[judgements.length - 1] : null;

  return {
    // 已完成阶段数（永久集合），不是本轮可用位置数
    stageCount: development.completedStages.length,
    nextStage,
    thresholdCents,
    gdpCents,
    gapCents: thresholdCents === null ? null : thresholdCents - gdpCents,
    projects: development.projects.map((project) => ({
      id: project.id,
      stage: project.stage,
      direction: project.direction,
      status: project.status,
      completeAtMinute: project.completeAtMinute,
      approvedAtMinute: project.approvedAtMinute,
    })),
    completions: development.completions.map((completion) => ({
      districtId: completion.districtId,
      stage: completion.stage,
      direction: completion.direction,
      completedAtMinute: completion.completedAtMinute,
    })),
    lastJudgement: last === null ? null : { ...last },
  };
}
