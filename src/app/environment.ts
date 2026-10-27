/**
 * 环境协调 —— 应用层把「游戏时间 + 天气切片」交给世界表现。
 *
 * 职责边界：
 *  - 只读 `clock.totalMinute` 与 `environment` 切片，不写状态、不推进时间；
 *  - 天气调度本身在 `features/environment`，由 `app/timeAdvance` 在统一时间推进里调用，
 *    这里只负责把结果与表现用分钟传给 `world`；
 *  - 表现分钟 = 权威整数分钟 + 主循环已保留的不足一分钟余量，
 *    只用于画面平滑，**不构成第二份时间权威**。
 */

import type { World } from '../world/world';
import type { ReadonlyGameState } from './state';

/** 表现余量的上限：它必须是「不足一分钟」，多出来的部分一律丢弃。 */
const MAX_VISUAL_REMAINDER = 0.999;

/** 表现用游戏分钟：权威整数分钟 + 合法余量。 */
export function visualMinuteOf(state: ReadonlyGameState, remainder: number): number {
  const base = Number.isFinite(state.clock.totalMinute) ? state.clock.totalMinute : 0;
  const extra = Number.isFinite(remainder)
    ? Math.min(Math.max(remainder, 0), MAX_VISUAL_REMAINDER)
    : 0;
  return base + extra;
}

/**
 * 推一帧环境到世界。
 *
 * `dtSeconds` 为表现时间：暂停时调用方传 0，雨滴静止而天空与光照保持当前状态。
 */
export function pushEnvironment(
  world: World,
  state: ReadonlyGameState,
  remainder: number,
  dtSeconds: number,
): void {
  world.updateEnvironment(visualMinuteOf(state, remainder), dtSeconds, state.environment);
}
