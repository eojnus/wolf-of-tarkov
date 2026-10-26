/**
 * 就业模块 —— 单个可入职岗位、班次限制与工资应计。
 *
 * 职责边界：
 *  - 只负责「能不能上班」「上了多久」「应计多少工资」，不碰账户余额。
 *  - 工资应计按分钟精确累计，跨月按实际工作时间归属到对应月份；发放由应用层
 *    在月度结算中通过财务公开接口完成。
 *  - 工作效率（0～100%）由应用层作为显式输入传入：有效计薪分钟 = 实际分钟 × E。
 *    本模块不读取生存状态，也不另写任何职位专属工资算法。
 *  - 每日工时上限始终按**实际出勤分钟**执行；切换岗位不重置工时、班次或已赚工资。
 */

import type { AdvanceSegment } from '../../core/clock';
import type { GameDate } from '../../core/calendar';
import { BusinessError } from '../../core/errors';
import { assertMoneyRange, safeAddMoney } from '../../core/money';
import type { JobConfig } from '../../content/config';

export interface EmploymentState {
  jobId: string | null;
  hiredAtMinute: number | null;
  /** 未发工资（分）。净资产中计为正资产。 */
  accruedWages: number;
  /**
   * 按分钟计薪时不足 1 分的余数。
   *
   * 单位为 1 / `WAGE_ACCRUAL_DENOMINATOR` 分（默认 6000）：
   * 分子 = 时薪(分) × 实际分钟 × 效率百分比(0～100) + 余数，
   * 每 6000 得 1 分。效率 100% 时与旧版「每 60 得 1 分」完全等价。
   */
  accrualRemainder: number;
  /** 日期（YYYY-MM-DD）→ 当日已工作分钟（实际出勤，不是有效计薪分钟）。 */
  workedMinutesByDay: Record<string, number>;
  /** 月份（YYYY-MM）→ 该月应计工资（分），月结时清零。 */
  accruedByMonth: Record<string, number>;
  /** 累计完成的班次数，仅用于展示。 */
  shiftsCompleted: number;
}

/** 工资余数分母：时薪(分) × 分钟 × 效率百分比 每 6000 得 1 分。 */
export const WAGE_ACCRUAL_DENOMINATOR = 60 * 100;

/** 效率百分比分母：0～100 的整数百分比，避免把有效分钟或时薪提前取整。 */
export const WAGE_EFFICIENCY_PERCENT_SCALE = 100;


export function createEmploymentState(): EmploymentState {
  return {
    jobId: null,
    hiredAtMinute: null,
    accruedWages: 0,
    accrualRemainder: 0,
    workedMinutesByDay: {},
    accruedByMonth: {},
    shiftsCompleted: 0,
  };
}

export interface HireContext {
  readonly atMinute: number;
  readonly monthKey: string;
}

export function isEmployed(state: EmploymentState): boolean {
  return state.jobId !== null;
}

/**
 * 入职或切换岗位。
 *
 * - 新入职：写入当前岗位与入职时刻；
 * - 切换岗位（已入职另一岗位）：只改岗位与入职时刻，**保留**已赚工资、按日工时、
 *   班次数与工资余数，避免用重新入职绕过每日上限或重置已赚工资；
 * - 重复入职当前岗位：明确拒绝。
 */
export function hire(state: EmploymentState, job: JobConfig, ctx: HireContext): void {
  if (state.jobId === job.id) {
    throw new BusinessError('ALREADY_EMPLOYED', '你已在该岗位，无需重复办理入职');
  }
  if (!job.id) {
    throw new BusinessError('INVALID_JOB', '岗位配置无效');
  }
  state.jobId = job.id;
  state.hiredAtMinute = ctx.atMinute;
  state.accruedByMonth = state.accruedByMonth ?? {};
  void ctx.monthKey;
}

export function workedMinutesOn(state: EmploymentState, dayKey: string): number {
  return state.workedMinutesByDay[dayKey] ?? 0;
}

export function accruedInMonth(state: EmploymentState, monthKey: string): number {
  return state.accruedByMonth[monthKey] ?? 0;
}

export interface ShiftPlan {
  readonly ok: boolean;
  readonly minutes: number;
  readonly reason: string | null;
  readonly remainingToday: number;
}

/** 判断此刻能否开始一个班次，以及本次可工作的分钟数。 */
export function planShift(state: EmploymentState, job: JobConfig, now: GameDate): ShiftPlan {
  const remainingToday = Math.max(0, job.maxMinutesPerDay - workedMinutesOn(state, now.dayKey));
  if (state.jobId !== job.id) {
    return { ok: false, minutes: 0, reason: '尚未入职', remainingToday };
  }
  if (now.minuteOfDay < job.workWindowStart) {
    return { ok: false, minutes: 0, reason: `公司 ${formatMinuteOfDay(job.workWindowStart)} 才开始上班`, remainingToday };
  }
  if (now.minuteOfDay >= job.workWindowEnd) {
    return { ok: false, minutes: 0, reason: `今天已经下班（${formatMinuteOfDay(job.workWindowEnd)} 结束）`, remainingToday };
  }
  if (remainingToday < job.minShiftMinutes) {
    return { ok: false, minutes: 0, reason: `今日工时已用完（上限 ${formatMinutes(job.maxMinutesPerDay)}）`, remainingToday };
  }
  const available = Math.min(job.shiftMinutes, job.workWindowEnd - now.minuteOfDay, remainingToday);
  if (available < job.minShiftMinutes) {
    return {
      ok: false,
      minutes: 0,
      reason: `距离下班只剩 ${available} 分钟，不足一个最短班次（${job.minShiftMinutes} 分钟）`,
      remainingToday,
    };
  }
  return { ok: true, minutes: available, reason: null, remainingToday };
}

export interface WorkSegmentInput {
  readonly segment: AdvanceSegment;
  readonly dayKey: string;
  readonly monthKey: string;
  /** 本区间生效的工作效率百分比（0～100 整数）。缺省 100 保持旧口径。 */
  readonly efficiencyPercent?: number;
}

function normalizeEfficiencyPercent(value: number | undefined): number {
  if (value === undefined) return WAGE_EFFICIENCY_PERCENT_SCALE;
  if (!Number.isSafeInteger(value) || value < 0 || value > WAGE_EFFICIENCY_PERCENT_SCALE) {
    throw new BusinessError('INVALID_EFFICIENCY', '工作效率必须是 0～100 的整数百分比');
  }
  return value;
}

/**
 * 记录一段工作时间的工资应计。
 * 时间段由核心按月份边界切分，因此这里的 monthKey 就是该段的真实归属月份。
 *
 * 精度：分子 = 时薪(分) × 实际分钟 × 效率百分比 + 余数，统一按
 * `WAGE_ACCRUAL_DENOMINATOR = 6000` 折算成分。不先对有效分钟取整，
 * 也不先对 50% 时薪取整；效率 100% 时与旧版结果完全一致。
 */
export function accrueWork(
  state: EmploymentState,
  job: JobConfig,
  input: WorkSegmentInput,
): number {
  const minutes = input.segment.minutes;
  if (minutes <= 0) return 0;
  const efficiencyPercent = normalizeEfficiencyPercent(input.efficiencyPercent);

  const raw = job.hourlyWageCents * minutes * efficiencyPercent + state.accrualRemainder;
  if (!Number.isSafeInteger(raw)) {
    throw new BusinessError('WAGE_OVERFLOW', '工资应计超出安全整数范围');
  }
  const earned = Math.floor(raw / WAGE_ACCRUAL_DENOMINATOR);
  state.accrualRemainder = raw % WAGE_ACCRUAL_DENOMINATOR;

  const isNewDay = !(input.dayKey in state.workedMinutesByDay);
  state.workedMinutesByDay[input.dayKey] =
    (state.workedMinutesByDay[input.dayKey] ?? 0) + minutes;

  if (earned > 0) {
    assertMoneyRange(earned, '应计工资');
    state.accruedWages = safeAddMoney(state.accruedWages, earned, '未发工资');
    state.accruedByMonth[input.monthKey] = safeAddMoney(
      state.accruedByMonth[input.monthKey] ?? 0,
      earned,
      '当月应计工资',
    );
  }

  // 只在新的一天开始时整理一次，避免按分钟计薪时反复排序
  if (isNewDay) pruneWorkedDays(state, input.dayKey);
  return earned;
}

/** 只保留最近两天的工时记录，避免无限增长。 */
function pruneWorkedDays(state: EmploymentState, keepDayKey: string): void {
  const keys = Object.keys(state.workedMinutesByDay);
  if (keys.length <= 2) return;
  const keep = new Set(keys.sort().slice(-2));
  keep.add(keepDayKey);
  for (const key of keys) {
    if (!keep.has(key)) delete state.workedMinutesByDay[key];
  }
}

/** 读取并结清某月应计工资，返回应发金额（分）。 */
export function closeMonth(state: EmploymentState, monthKey: string): number {
  const amount = state.accruedByMonth[monthKey] ?? 0;
  if (amount <= 0) {
    delete state.accruedByMonth[monthKey];
    return 0;
  }
  if (amount > state.accruedWages) {
    throw new BusinessError('ACCRUAL_MISMATCH', '工资应计数据不一致，已中止结算');
  }
  state.accruedWages -= amount;
  delete state.accruedByMonth[monthKey];
  return amount;
}

function formatMinuteOfDay(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return `${hours} 小时`;
  return `${hours} 小时 ${rest} 分钟`;
}
