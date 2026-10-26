/**
 * 生存参数 —— 饱食度 / 水分的时间消耗与提示阈值。
 *
 * 只放参数，不含任何业务逻辑；替换参数不应改动 `features/survival` 的实现。
 * 内部状态一律用「单位」整数累计（不是浮点百分比），只有展示时才换算成点。
 */

export const SURVIVAL = {
  minPoints: 0,
  maxPoints: 100,
  initialPoints: 100,
  /** 每点生存值的内部单位数。 */
  unitsPerPoint: 2880,
  /** 每游戏分钟的消耗单位（100 units = 1/28.8 点；48 小时正好 288000 单位）。 */
  unitsPerMinute: 100,
  /** 满值内部单位 = 100 × 2880 = 288000。 */
  fullUnits: 288_000,
  /** 从满值到 0 的游戏分钟数（48 小时）。 */
  depletionMinutes: 2880,
  /** 低值提示阈值（点）。 */
  lowThresholdPoints: 20,
  /** 饱食度/水分归零时对工作效率的加法扣减。 */
  workDeductionPerZero: 0.5,
  /** 饱食度/水分归零时对移动倍率的加法扣减。 */
  moveDeductionPerZero: 0.15,
} as const;
