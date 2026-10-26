/**
 * 城市建设 —— 门槛判断、每任期一次判断、阶段预留、项目与永久建设历史。
 *
 * 纯业务模块：只认识本切片，不 import Three.js / DOM / world / 场景，
 * 也不创建任何渲染对象（场景由 app 层在项目完成后通过 city-layout 追加）。
 *
 * 口径与不变量：
 *  - 门槛 threshold(k) = G0 + firstThreshold × 1.6^k（分，四舍五入）。
 *  - 判断只在「形成真实新任期」后做一次；`judgedTermHighWater` 是单调任期序号高水位，
 *    永久防重复只依赖「高水位 + 已预留/已完成阶段 + termOrdinal」，
 *    **不依赖**会被裁剪的政府任职历史（`government.terms` 只保留最近 24 条）。
 *  - 项目一经批准不因后续股市下跌或负责人更换取消；批准即预留唯一阶段。
 *  - 只有「到达完成时刻且由 app 层标记完成」的项目才进入 completedStages；
 *    reservedStages 仍然保留（已用阶段集合 = reserved ∪ completed）。
 *  - 永久建设历史（completedStages）不受展示上限影响；`completions` 与 `judgements`
 *    只是界面展示数组，按配置上限裁剪。
 */

import type { DeepReadonly } from '../../core/readonly';
import { CALENDAR } from '../../content/config';
import { CITY_DEVELOPMENT_RULES } from '../../content/city-economy';
import type { DistrictDirection } from '../../content/districts';

/** 一次建设判断的结果（持久化取值，界面文案在 content/city-economy）。 */
export type ConstructionOutcome = 'approved' | 'below-threshold' | 'no-slot' | 'legacy-skip';

export interface ConstructionJudgementRecord {
  readonly termId: string;
  /** 从 term id 解析出的单调序号；用于唯一性判断。 */
  readonly termOrdinal: number;
  readonly judgedAtMinute: number;
  readonly gdpCents: number;
  readonly thresholdCents: number;
  readonly stage: number | null;
  readonly outcome: ConstructionOutcome;
  readonly projectId: string | null;
  readonly note: string;
}

export interface DevelopmentProject {
  readonly id: string;
  readonly stage: number;
  readonly direction: DistrictDirection;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly districtId: string;
  readonly sourceTermId: string;
  readonly approvedAtMinute: number;
  readonly completeAtMinute: number;
  /** 只允许 building → completed；不存在「取消」状态。 */
  status: 'building' | 'completed';
  readonly gdpAtApprovalCents: number;
  readonly thresholdCents: number;
  readonly enterpriseBuildingId: string | null;
}

export interface CompletedDistrictRecord {
  readonly projectId: string;
  readonly districtId: string;
  readonly stage: number;
  readonly direction: DistrictDirection;
  readonly completedAtMinute: number;
  readonly templateId: string;
  readonly templateVersion: number;
}

export interface EnterpriseSlotState {
  readonly id: string;
  readonly districtId: string;
  readonly buildingId: string;
  status: 'pending' | 'created';
  companyId: string | null;
  attempts: number;
  lastAttemptMinute: number | null;
}

export interface CityDevelopmentState {
  /** 仅展示用，最多 judgementHistoryLimit 条。 */
  judgements: ConstructionJudgementRecord[];
  /** 单调任期序号高水位：永久防重复，绝不依赖会被裁剪的政府历史。 */
  judgedTermHighWater: number;
  /** 已预留阶段（批准即预留，防止另一个任期重复预订同一低门槛阶段）。 */
  reservedStages: number[];
  /** 已完成的城区阶段（永久）。 */
  completedStages: number[];
  projects: DevelopmentProject[];
  completions: CompletedDistrictRecord[];
  enterpriseSlots: EnterpriseSlotState[];
  nextProjectSeq: number;
}

/**
 * 新建建设切片。
 *
 * G0 的权威保存在 `cityStatistics.base.gdpCents`，本切片**不另存副本**；
 * 参数只用于入口自校验：门槛计算每次由调用方显式传入 G0，避免出现两份基础 GDP。
 */
export function createCityDevelopmentState(baseGdpCents: number): CityDevelopmentState {
  if (!Number.isSafeInteger(baseGdpCents) || baseGdpCents < 0) {
    throw new Error(`[city-development] 基础 GDP 必须是非负安全整数（分），收到 ${String(baseGdpCents)}`);
  }
  return {
    judgements: [],
    judgedTermHighWater: 0,
    reservedStages: [],
    completedStages: [],
    projects: [],
    completions: [],
    enterpriseSlots: [],
    nextProjectSeq: 1,
  };
}

/** threshold(k) = G0 + firstThreshold × 1.6^k（分，Math.round）。 */
export function thresholdForStage(baseGdpCents: number, stage: number): number {
  if (!Number.isSafeInteger(baseGdpCents) || baseGdpCents < 0) {
    throw new Error(`[city-development] 基础 GDP 必须是非负安全整数（分），收到 ${String(baseGdpCents)}`);
  }
  if (!Number.isSafeInteger(stage) || stage < 0) {
    throw new Error(`[city-development] 非法建设阶段：${String(stage)}`);
  }
  return Math.round(
    baseGdpCents +
      CITY_DEVELOPMENT_RULES.firstThresholdCents *
        Math.pow(CITY_DEVELOPMENT_RULES.thresholdGrowth, stage),
  );
}

/** 已用阶段（预留或完成）集合；两者都可能包含同一阶段，按并集判断。 */
function stageUsed(
  state: CityDevelopmentState | DeepReadonly<CityDevelopmentState>,
  stage: number,
): boolean {
  return (
    state.reservedStages.includes(stage) || state.completedStages.includes(stage)
  );
}

/** 下一个未预留阶段；没有剩余位置时返回 null。按阶段序号从小到大。 */
export function nextAvailableStage(
  state: CityDevelopmentState | DeepReadonly<CityDevelopmentState>,
): number | null {
  for (let stage = 0; stage < CITY_DEVELOPMENT_RULES.stageCount; stage += 1) {
    if (!stageUsed(state, stage)) return stage;
  }
  return null;
}

/** 记录一次任期判断（仅展示字段，防重复用单调高水位，不依赖本数组）。 */
export function recordJudgement(
  state: CityDevelopmentState,
  record: ConstructionJudgementRecord,
): void {
  state.judgements.push(record);
  if (state.judgements.length > CITY_DEVELOPMENT_RULES.judgementHistoryLimit) {
    state.judgements.splice(
      0,
      state.judgements.length - CITY_DEVELOPMENT_RULES.judgementHistoryLimit,
    );
  }
}

/**
 * 批准项目：预留阶段、生成 districtId 与 30 日完成时刻，返回项目。
 *
 * 只接受「尚未预留/完成」的阶段；重复批准同阶段属于编程错误，明确抛错。
 * 完成时刻按 `projectDays × minutesPerDay` 计算，不读系统时间。
 */
export function approveProject(
  state: CityDevelopmentState,
  input: {
    stage: number;
    direction: DistrictDirection;
    sourceTermId: string;
    approvedAtMinute: number;
    gdpAtApprovalCents: number;
    thresholdCents: number;
    templateId: string;
    templateVersion: number;
    enterpriseBuildingId: string | null;
  },
): DevelopmentProject {
  if (!Number.isSafeInteger(input.stage) || input.stage < 0) {
    throw new Error(`[city-development] 非法建设阶段：${String(input.stage)}`);
  }
  if (stageUsed(state, input.stage)) {
    throw new Error(`[city-development] 阶段 ${input.stage} 已被预留或完成，不能重复批准`);
  }
  // 城区 id 规则：`district-stage-<stage + 1>`。与 city-layout 用同一条规则，
  // 但本模块不 import 其它业务模块；app 层在完成项目时会核对「项目 districtId =
  // 实际追加的城区 id」，漂移会在那次核对中明确报错。
  const districtId = `district-stage-${input.stage + 1}`;
  const project: DevelopmentProject = {
    id: `project-${state.nextProjectSeq}`,
    stage: input.stage,
    direction: input.direction,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    districtId,
    sourceTermId: input.sourceTermId,
    approvedAtMinute: input.approvedAtMinute,
    completeAtMinute:
      input.approvedAtMinute + CITY_DEVELOPMENT_RULES.projectDays * CALENDAR.minutesPerDay,
    status: 'building',
    gdpAtApprovalCents: input.gdpAtApprovalCents,
    thresholdCents: input.thresholdCents,
    enterpriseBuildingId: input.enterpriseBuildingId,
  };
  state.nextProjectSeq += 1;
  state.reservedStages.push(input.stage);
  state.reservedStages.sort((left, right) => left - right);
  state.projects.push(project);
  return project;
}

/**
 * 完成项目：标记 completed、写入 completions、写 completedStages。
 *
 * 幂等：项目不存在或已经完成时返回 null，不重复写历史。
 * 完成时刻用调用方传入的 `nowMinute`（游戏时间），不早于计划完成时刻。
 */
export function markProjectCompleted(
  state: CityDevelopmentState,
  projectId: string,
  nowMinute: number,
): CompletedDistrictRecord | null {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project || project.status !== 'building') return null;
  project.status = 'completed';
  if (!state.completedStages.includes(project.stage)) {
    state.completedStages.push(project.stage);
    state.completedStages.sort((left, right) => left - right);
  }
  const record: CompletedDistrictRecord = {
    projectId: project.id,
    districtId: project.districtId,
    stage: project.stage,
    direction: project.direction,
    completedAtMinute: nowMinute,
    templateId: project.templateId,
    templateVersion: project.templateVersion,
  };
  state.completions.push(record);
  if (state.completions.length > CITY_DEVELOPMENT_RULES.completionHistoryLimit) {
    state.completions.splice(
      0,
      state.completions.length - CITY_DEVELOPMENT_RULES.completionHistoryLimit,
    );
  }
  return record;
}

/**
 * 新增一个招商槽位（项目完成、城区真实出现后调用）。
 *
 * 每个城区最多一个槽位（id = `slot-<districtId>`），重复调用返回已有槽位，不重复创建。
 */
export function addEnterpriseSlot(
  state: CityDevelopmentState,
  input: { districtId: string; buildingId: string },
): EnterpriseSlotState {
  const id = `slot-${input.districtId}`;
  const existing = state.enterpriseSlots.find((slot) => slot.id === id);
  if (existing) return existing;
  const slot: EnterpriseSlotState = {
    id,
    districtId: input.districtId,
    buildingId: input.buildingId,
    status: 'pending',
    companyId: null,
    attempts: 0,
    lastAttemptMinute: null,
  };
  state.enterpriseSlots.push(slot);
  return slot;
}

/** 招商成功：槽位标记 created 并记录公司 id（幂等，重复调用只更新公司引用）。 */
export function markEnterpriseCreated(
  state: CityDevelopmentState,
  slotId: string,
  companyId: string,
  nowMinute: number,
): void {
  const slot = state.enterpriseSlots.find((item) => item.id === slotId);
  if (!slot) return;
  slot.status = 'created';
  slot.companyId = companyId;
  slot.attempts += 1;
  slot.lastAttemptMinute = nowMinute;
}

/** 记录一次招商尝试失败（资金不足等）；重试节奏由调用方按游戏日判断。 */
export function noteEnterpriseAttempt(
  state: CityDevelopmentState,
  slotId: string,
  nowMinute: number,
): void {
  const slot = state.enterpriseSlots.find((item) => item.id === slotId);
  if (!slot || slot.status !== 'pending') return;
  slot.attempts += 1;
  slot.lastAttemptMinute = nowMinute;
}

/**
 * 建设履约 D：**当前真实任期**已承诺且已到完成时刻的项目中完成的比例 ∈ [0,1]。
 *
 * 口径（D 只绑定当前真实任期，不累计历史）：
 *  - 只统计 `project.sourceTermId === currentTermId` 的项目；前任批准的项目一律排除，
 *    包括「前任批准、后任任期内才到完成时刻」的项目（其 `sourceTermId` 仍是前任）。
 *  - 只评价 `completeAtMinute <= nowMinute` 的到期承诺；尚在正常建设期的项目既不算违约
 *    也不算完成，不进入分母。
 *  - 本任期没有到期承诺（含未达 GDP 门槛、没有承诺建设、或项目都还在建设期）时返回
 *    `{ value: 0, hasSample: false }`：中性，不扣分也不算失信。
 *  - 有到期承诺时 `value = 已完成数量 / 到期承诺数量`，天然有界于 [0,1]，`hasSample = true`；
 *    全部完成 = 1，部分完成 = 比例，全部未完成 = 0（有样本）。
 *  - `currentTermId === null`（过渡负责人/无真实任期）→ 中性 `{ 0, false }`。
 *
 * 换届只影响「谁被评价」，不删除任何历史：已建成的城区、`projects`、`completions`、
 * `completedStages` 等永久建设历史全部保留，新区不会因为换届消失。
 *
 * 业务模块只接收任期 id，不读取 government / 整个 GameState；跨模块由 app 层编排，
 * 调用方用 `activeTermOf(government)?.id ?? null` 传入当前真实任期。
 */
export function deliveryOf(
  state: CityDevelopmentState | DeepReadonly<CityDevelopmentState>,
  nowMinute: number,
  currentTermId: string | null,
): { value: number; hasSample: boolean } {
  if (currentTermId === null) return { value: 0, hasSample: false };
  let due = 0;
  let completed = 0;
  for (const project of state.projects) {
    if (project.sourceTermId !== currentTermId) continue;
    if (project.completeAtMinute > nowMinute) continue;
    due += 1;
    if (project.status === 'completed') completed += 1;
  }
  if (due <= 0) return { value: 0, hasSample: false };
  return { value: completed / due, hasSample: true };
}
