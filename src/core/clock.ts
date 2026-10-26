/**
 * 游戏时钟 —— 唯一时间来源。
 *
 * 核心职责：持有整数游戏分钟、暂停/速度状态，并提供唯一的推进入口。
 * 核心不知道工资、房租或任何业务规则；跨月边界只是「一起时间事件」，由调用方
 * 通过 onMonthEnd 自行组织结算。所有跨度都按边界切分，保证一次推进跨越多个
 * 边界时会逐个经过，不会跳过。
 */

import {
  monthEndBoundaryMinute,
  monthIndexAtMinute,
  monthKeyOfIndex,
  type CalendarConfig,
} from './calendar';
import { BusinessError } from './errors';

export interface ClockState {
  /** 从游戏起点起算的整数游戏分钟。唯一时间真相。 */
  totalMinute: number;
  /** 玩家手动暂停。 */
  paused: boolean;
  /** 倍率，1 为正常速度。 */
  speed: number;
}

/** 一段连续推进的时间片，保证不跨越月份边界。 */
export interface AdvanceSegment {
  readonly startMinute: number;
  readonly minutes: number;
}

export interface MonthBoundaryInfo {
  /** 刚结束的月份序号。 */
  readonly monthIndex: number;
  readonly monthKey: string;
  /** 边界时刻的 totalMinute（即下月月初）。 */
  readonly boundaryMinute: number;
}

export interface AdvanceHooks {
  /**
   * 每段推进后立即回调，用于按分钟记账（如工资应计）。
   * 返回 false 表示「本段结束后不再继续推进」，用于在关键事件时刻提前停下。
   * 核心不知道停下的是什么事件，只负责如实返回推进了多少、还剩多少。
   */
  onElapsed?: (segment: AdvanceSegment) => boolean | void;
  /** 时间到达月份边界时回调，用于月度结算。 */
  onMonthEnd?: (info: MonthBoundaryInfo) => void;
  /**
   * 一段（含该段的月界结算）完整处理完后调用，返回 true 表示停止后续推进。
   * 用于「月界回调里才产生的停止请求」——onElapsed 的返回值在月界回调之前就已知，
   * 无法覆盖这种情况。核心不关心停止的原因。
   */
  shouldStop?: () => boolean;
}

export interface AdvanceOptions {
  /**
   * 单段最大分钟数。调用方需要更细的时间事件粒度时传入（例如按分钟处理行情与计息），
   * 核心不关心这些事件是什么，只保证分段不超过该值且不跨越月界。
   * 不传则只在月份边界处切分。
   */
  readonly maxStepMinutes?: number;
}

export interface AdvanceOutcome {
  /** 实际推进的分钟数。 */
  readonly advancedMinutes: number;
  /** 因提前停止而未推进的分钟数。 */
  readonly remainingMinutes: number;
  readonly stopped: boolean;
}

export const SPEED_OPTIONS: readonly number[] = [1, 2, 4];

export function createClockState(initial?: Partial<ClockState>): ClockState {
  return {
    totalMinute: initial?.totalMinute ?? 0,
    paused: initial?.paused ?? false,
    speed: initial?.speed ?? 1,
  };
}

export function isValidSpeed(speed: number): boolean {
  return Number.isFinite(speed) && speed > 0 && speed <= 8;
}

/**
 * 唯一的时间推进入口。会按月份边界切分成若干段，逐段推进。
 * 调用方必须把自己的记账逻辑放进 hooks，不能自行修改 clock.totalMinute。
 *
 * 若 onElapsed 返回 false，本段结算（含该段的月界结算）完成后即停止，
 * 剩余分钟如实返回，由调用方决定后续处理。
 */
export function advanceClock(
  clock: ClockState,
  minutes: number,
  cfg: CalendarConfig,
  hooks: AdvanceHooks = {},
  options: AdvanceOptions = {},
): AdvanceOutcome {
  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new BusinessError('INVALID_DURATION', '时间推进量必须是合法的非负整数分钟');
  }
  if (minutes === 0) return { advancedMinutes: 0, remainingMinutes: 0, stopped: false };

  const maxStep = options.maxStepMinutes;
  if (maxStep !== undefined && (!Number.isSafeInteger(maxStep) || maxStep <= 0)) {
    throw new BusinessError('INVALID_STEP', '单段最大分钟数必须是正整数');
  }

  let remaining = minutes;
  let advanced = 0;
  let guard = 0;
  const stepLimit = maxStep ?? Number.POSITIVE_INFINITY;
  while (remaining > 0) {
    guard += 1;
    if (guard > 1_000_000) {
      throw new BusinessError('CLOCK_OVERFLOW', '时间推进异常：分段次数超出上限');
    }
    const monthIndex = monthIndexAtMinute(clock.totalMinute, cfg);
    const boundary = monthEndBoundaryMinute(monthIndex, cfg);
    const step = Math.min(remaining, boundary - clock.totalMinute, stepLimit);
    const startMinute = clock.totalMinute;
    clock.totalMinute = startMinute + step;
    remaining -= step;
    advanced += step;

    const keepGoing = hooks.onElapsed?.({ startMinute, minutes: step });

    // 月界结算必须完成，即使本段已经请求停止
    if (clock.totalMinute === boundary) {
      hooks.onMonthEnd?.({
        monthIndex,
        monthKey: monthKeyOfIndex(monthIndex, cfg),
        boundaryMinute: boundary,
      });
    }

    if (keepGoing === false) {
      return { advancedMinutes: advanced, remainingMinutes: remaining, stopped: true };
    }
    // 月界结算可能在本段内产生新的停止请求，必须在整段（含 onMonthEnd）完成后才检查
    if (hooks.shouldStop?.()) {
      return { advancedMinutes: advanced, remainingMinutes: remaining, stopped: true };
    }
  }
  return { advancedMinutes: advanced, remainingMinutes: 0, stopped: false };
}
