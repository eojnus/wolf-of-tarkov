/**
 * 人才模块 —— 候选人、任职关系与工资应计增量。
 *
 * 只维护「谁在哪家公司、任职了多久、这一段时间新增了多少工资」。
 * 不持有企业负债、不改账户、不决定何时支付：
 * 新增工资由应用层同时计入企业应付与当月费用，付款由 finance 执行。
 *
 * 工资按「分 × 分钟」为单位的整数分子累计，不足一分的余量保存在任职关系上，
 * 因此分段推进、月结、解雇都不会因为反复取整而丢钱。
 */

import { CALENDAR } from '../../content/config';
import {
  TALENT_CANDIDATES,
  findTalentCandidate,
  type TalentCandidateConfig,
} from '../../content/business';
import type { DeepReadonly } from '../../core/readonly';
import { BusinessError } from '../../core/errors';

export interface TalentAssignment {
  readonly candidateId: string;
  readonly hiredAtMinute: number;
  /**
   * 工资计算余量（分子，单位 = 分 × 分钟），恒小于 MINUTES_PER_MONTH。
   * 有余量才能在任意分段下保证「同一段总时长 → 同样多的工资」。
   */
  wageNumerator: number;
  /** 实际已发放工资累计（分）。只统计真正付出去的钱，不是「算出应发」。 */
  paidTotalCents: number;
}

export interface TalentState {
  /** companyId → 当前科研高管（没有则为 null）。每家公司最多一个。 */
  assignments: Record<string, TalentAssignment | null>;
}

export const MINUTES_PER_MONTH = CALENDAR.daysPerMonth * CALENDAR.minutesPerDay;

export function createTalentState(): TalentState {
  return { assignments: {} };
}

export function candidateOf(
  assignment: TalentAssignment | DeepReadonly<TalentAssignment> | null,
): TalentCandidateConfig | null {
  if (!assignment) return null;
  return findTalentCandidate(assignment.candidateId);
}

export function assignmentOf(state: TalentState, companyId: string): TalentAssignment | null;
export function assignmentOf(
  state: DeepReadonly<TalentState>,
  companyId: string,
): DeepReadonly<TalentAssignment> | null;
export function assignmentOf(
  state: TalentState | DeepReadonly<TalentState>,
  companyId: string,
): TalentAssignment | DeepReadonly<TalentAssignment> | null {
  return state.assignments[companyId] ?? null;
}

/** 该候选人是否已被任何一家公司雇佣。每个候选人只能被一家企业雇佣。 */
export function isCandidateEmployed(state: TalentState, candidateId: string): boolean {
  return Object.values(state.assignments).some(
    (assignment) => assignment?.candidateId === candidateId,
  );
}

export function abilityOf(state: TalentState, companyId: string): number {
  const candidate = candidateOf(assignmentOf(state, companyId));
  return candidate?.ability ?? 0;
}

export function hire(
  state: TalentState,
  companyId: string,
  candidateId: string,
  nowMinute: number,
): TalentAssignment {
  const candidate = findTalentCandidate(candidateId);
  if (!candidate) throw new BusinessError('NO_CANDIDATE', '没有该候选人');
  if (state.assignments[companyId]) {
    throw new BusinessError('TALENT_SLOT_FULL', '该公司已有科研高管，请先解雇');
  }
  if (isCandidateEmployed(state, candidateId)) {
    throw new BusinessError('CANDIDATE_TAKEN', '该候选人已被其他公司雇佣');
  }
  const assignment: TalentAssignment = {
    candidateId,
    hiredAtMinute: nowMinute,
    wageNumerator: 0,
    paidTotalCents: 0,
  };
  state.assignments[companyId] = assignment;
  return assignment;
}

/**
 * 解雇：直接释放任职关系。
 * 已发生的工资在任职期间已逐分钟计入企业应付，因此解雇不会消除任何薪酬；
 * 调用方应在解雇后立即尝试支付应付。
 */
export function fire(state: TalentState, companyId: string): TalentAssignment | null {
  const assignment = state.assignments[companyId] ?? null;
  if (!assignment) return null;
  state.assignments[companyId] = null;
  return assignment;
}

/**
 * 累计 minutes 分钟的工资，返回**本次新增的整数分**。
 * 余量留在 assignment.wageNumerator 上，因此反复调用不会丢零头。
 */
export function accrueWageIncrement(
  assignment: TalentAssignment,
  minutes: number,
): number {
  if (minutes <= 0) return 0;
  const candidate = candidateOf(assignment);
  if (!candidate) return 0;
  assignment.wageNumerator += candidate.monthlySalaryCents * minutes;
  const whole = Math.floor(assignment.wageNumerator / MINUTES_PER_MONTH);
  if (whole > 0) assignment.wageNumerator -= whole * MINUTES_PER_MONTH;
  return whole;
}

/** 记录实际支付的工资金额（只用于展示，不参与任何结算）。 */
export function recordWagePayment(assignment: TalentAssignment, paidCents: number): void {
  if (paidCents <= 0) return;
  assignment.paidTotalCents += paidCents;
}

/** 界面用：候选人列表与占用状态。 */
export function candidatePool(
  state: TalentState,
): Array<{ candidate: TalentCandidateConfig; employedBy: string | null }> {
  const owners = new Map<string, string>();
  for (const [companyId, assignment] of Object.entries(state.assignments)) {
    if (assignment) owners.set(assignment.candidateId, companyId);
  }
  return TALENT_CANDIDATES.map((candidate) => ({
    candidate,
    employedBy: owners.get(candidate.id) ?? null,
  }));
}
