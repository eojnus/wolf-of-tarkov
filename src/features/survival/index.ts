/**
 * 生存模块 —— 饱食度与水分的唯一状态与纯计算。
 *
 * 职责边界：
 *  - 只负责「随时间掉多少」「吃了恢复多少」「当前对效率/移动的影响」；
 *  - 不读取 GameState，不操作钱、工作或世界，不由渲染帧驱动；
 *  - 时间推进由应用层调用 `advanceSurvival`，按游戏分钟一次性扣减。
 *
 * 精度策略：状态一律用内部单位整数累计，避免浮点反复累减导致误差漂移；
 * 只有对外展示（点）与恢复报告才换算成浮点。单位换算参数全部来自 `SURVIVAL`。
 */

import { BusinessError } from '../../core/errors';
import type { DeepReadonly } from '../../core/readonly';
import { SURVIVAL } from '../../content/survival';

export interface SurvivalState {
  /** 饱食度内部单位，范围 [0, SURVIVAL.fullUnits]。 */
  hungerUnits: number;
  /** 水分内部单位，范围 [0, SURVIVAL.fullUnits]。 */
  waterUnits: number;
}

/** 单次推进允许的最大合法分钟数不需要额外上限：超过一天按归零处理。 */
export function createSurvivalState(): SurvivalState {
  return { hungerUnits: SURVIVAL.fullUnits, waterUnits: SURVIVAL.fullUnits };
}

/**
 * 推进生存值。minutes 必须是非负安全整数。
 *
 * 消耗 = `unitsPerMinute × minutes`。一次推进达到或超过耗尽分钟数时直接归零，
 * 既保证语义正确，也避免乘法结果超出安全整数范围。
 */
export function advanceSurvival(state: SurvivalState, minutes: number): void {
  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new BusinessError('INVALID_SURVIVAL_TICK', '生存值推进分钟数必须是非负整数');
  }
  if (minutes === 0) return;

  const deltaUnits =
    minutes >= SURVIVAL.depletionMinutes
      ? SURVIVAL.fullUnits
      : SURVIVAL.unitsPerMinute * minutes;

  state.hungerUnits = clampUnits(state.hungerUnits - deltaUnits);
  state.waterUnits = clampUnits(state.waterUnits - deltaUnits);
}

/** 当前饱食度（点，用于展示）。 */
export function hungerPointsOf(state: SurvivalState | DeepReadonly<SurvivalState>): number {
  return state.hungerUnits / SURVIVAL.unitsPerPoint;
}

/** 当前水分（点，用于展示）。 */
export function waterPointsOf(state: SurvivalState | DeepReadonly<SurvivalState>): number {
  return state.waterUnits / SURVIVAL.unitsPerPoint;
}

/** 工作效率系数：饱食度或水分归零各扣 0.5，最低为 0。 */
export function workEfficiencyOf(state: SurvivalState | DeepReadonly<SurvivalState>): number {
  const zeroCount = zeroFlagsOf(state);
  return Math.max(0, 1 - SURVIVAL.workDeductionPerZero * zeroCount);
}

/** 移动倍率：饱食度或水分归零各扣 0.15，最低为 0。 */
export function moveMultiplierOf(state: SurvivalState | DeepReadonly<SurvivalState>): number {
  const zeroCount = zeroFlagsOf(state);
  return Math.max(0, 1 - SURVIVAL.moveDeductionPerZero * zeroCount);
}

/**
 * 低值提示：点 < 阈值（任务口径为「低于 20」），0 同样为低值。
 * 用单位比较，避免 0.1 级浮点误差影响边界。
 */
export function isLowHunger(state: SurvivalState | DeepReadonly<SurvivalState>): boolean {
  return state.hungerUnits < SURVIVAL.lowThresholdPoints * SURVIVAL.unitsPerPoint;
}

export function isLowWater(state: SurvivalState | DeepReadonly<SurvivalState>): boolean {
  return state.waterUnits < SURVIVAL.lowThresholdPoints * SURVIVAL.unitsPerPoint;
}

/** 恢复报告：实际恢复与溢出浪费均以「点」为单位（浮点，仅用于展示）。 */
export interface SurvivalRestoreResult {
  readonly hungerRestoredPoints: number;
  readonly waterRestoredPoints: number;
  readonly hungerWastedPoints: number;
  readonly waterWastedPoints: number;
}

interface RestorePlan {
  readonly hungerUnits: number;
  readonly waterUnits: number;
  readonly result: SurvivalRestoreResult;
}

/**
 * 纯查询：只计算吃/喝后的结果，**不修改状态**。
 * 与 `restoreSurvival` 共用同一份公式，界面预览不会与实际恢复不一致。
 */
export function previewRestoreOf(
  state: SurvivalState | DeepReadonly<SurvivalState>,
  effect: { hungerPoints: number; waterPoints: number },
): SurvivalRestoreResult {
  return planRestore(state, effect).result;
}

/**
 * 使用物品恢复饱食度/水分：按内部单位精确恢复并 clamp 到满值。
 *
 * 返回实际恢复与溢出浪费的点数；不可为负。多项同时恢复时各自独立计算。
 */
export function restoreSurvival(
  state: SurvivalState,
  effect: { hungerPoints: number; waterPoints: number },
): SurvivalRestoreResult {
  const plan = planRestore(state, effect);
  state.hungerUnits = plan.hungerUnits;
  state.waterUnits = plan.waterUnits;
  return plan.result;
}

function planRestore(
  state: SurvivalState | DeepReadonly<SurvivalState>,
  effect: { hungerPoints: number; waterPoints: number },
): RestorePlan {
  const hungerBefore = state.hungerUnits;
  const waterBefore = state.waterUnits;

  const requestedHunger = requestedUnitsOf(effect.hungerPoints, '饱食度');
  const requestedWater = requestedUnitsOf(effect.waterPoints, '水分');

  const hungerUnits = Math.min(SURVIVAL.fullUnits, hungerBefore + requestedHunger);
  const waterUnits = Math.min(SURVIVAL.fullUnits, waterBefore + requestedWater);

  const hungerRestoredUnits = hungerUnits - hungerBefore;
  const waterRestoredUnits = waterUnits - waterBefore;

  return {
    hungerUnits,
    waterUnits,
    result: {
      hungerRestoredPoints: hungerRestoredUnits / SURVIVAL.unitsPerPoint,
      waterRestoredPoints: waterRestoredUnits / SURVIVAL.unitsPerPoint,
      hungerWastedPoints:
        (requestedHunger - hungerRestoredUnits) / SURVIVAL.unitsPerPoint,
      waterWastedPoints: (requestedWater - waterRestoredUnits) / SURVIVAL.unitsPerPoint,
    },
  };
}

/** 点 → 内部单位（四舍五入到单位），并把非法效果挡在状态之外。 */
function requestedUnitsOf(points: number, label: string): number {
  if (!Number.isFinite(points) || points < 0) {
    throw new BusinessError('INVALID_SURVIVAL_RESTORE', `${label}恢复量无效`);
  }
  return Math.min(
    SURVIVAL.fullUnits,
    Math.round(points * SURVIVAL.unitsPerPoint),
  );
}

/** 归零项数（0 / 1 / 2），用于效率与移动扣减。 */
function zeroFlagsOf(state: SurvivalState | DeepReadonly<SurvivalState>): number {
  let zeroCount = 0;
  if (state.hungerUnits <= 0) zeroCount += 1;
  if (state.waterUnits <= 0) zeroCount += 1;
  return zeroCount;
}

function clampUnits(units: number): number {
  if (units <= 0) return SURVIVAL.minPoints * SURVIVAL.unitsPerPoint;
  if (units >= SURVIVAL.fullUnits) return SURVIVAL.fullUnits;
  return units;
}
