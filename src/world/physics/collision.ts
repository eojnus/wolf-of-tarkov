/**
 * 场景碰撞 → Rapier 静态盒的纯适配。
 *
 * 只接受世界坐标 AABB，不读 Three.js 对象，也不从可见网格反推尺寸。
 * 地面/地板在这里补成有厚度的支撑体；墙体、楼体、街景与家具仍由各自权威数据提供。
 */
import { PHYSICS } from '../../content/config';
import type { PhysicsBox } from './types';

/**
 * 物理地面顶面略低于可见地面，给角色控制器留出数值间隙。
 * 正式传送保持已校验的脚底高度，地面恢复时脚底为 y=0。
 */
const GROUND_TOP = -PHYSICS.character.offset;

export function groundBox(bounds: {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}): PhysicsBox {
  return {
    minX: bounds.minX,
    maxX: bounds.maxX,
    minZ: bounds.minZ,
    maxZ: bounds.maxZ,
    minY: GROUND_TOP - 0.5,
    maxY: GROUND_TOP,
  };
}

export function withGround(
  boxes: readonly PhysicsBox[],
  bounds: {
    readonly minX: number;
    readonly maxX: number;
    readonly minZ: number;
    readonly maxZ: number;
  },
): PhysicsBox[] {
  return [groundBox(bounds), ...boxes];
}

export function floorBox(width: number, depth: number): PhysicsBox {
  return { minX: 0, maxX: width, minZ: 0, maxZ: depth, minY: GROUND_TOP - 0.5, maxY: GROUND_TOP };
}

export function ceilingBox(width: number, depth: number, height: number): PhysicsBox {
  return { minX: 0, maxX: width, minZ: 0, maxZ: depth, minY: height, maxY: height + 0.1 };
}
