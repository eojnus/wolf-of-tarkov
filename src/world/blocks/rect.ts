/**
 * 街区几何工具 —— 纯函数，不 import Three.js，不写状态。
 *
 * 站点规划（`sites.ts`）、街区生成（`generate.ts`）与试点校验（`plan.ts`）共用这一份，
 * 避免三处各写一套矩形运算后口径漂移。
 */

import type { BlockRect, DecorFront } from '../../content/city-blocks';

export type Rect = BlockRect;

export const EPS = 1e-6;

export function rectWidth(rect: Rect): number {
  return rect.x1 - rect.x0;
}

export function rectDepth(rect: Rect): number {
  return rect.z1 - rect.z0;
}

export function rectCenter(rect: Rect): { x: number; z: number } {
  return { x: (rect.x0 + rect.x1) / 2, z: (rect.z0 + rect.z1) / 2 };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return (
    Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > EPS &&
    Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) > EPS
  );
}

/** 两个矩形的净距（相交时为 0）。 */
export function gap(a: Rect, b: Rect): number {
  const dx = Math.max(a.x0 - b.x1, b.x0 - a.x1, 0);
  const dz = Math.max(a.z0 - b.z1, b.z0 - a.z1, 0);
  return Math.hypot(dx, dz);
}

/** 共享边：一条边上重叠长度 > minShare 视为连通（不是只碰一个点）。 */
export function sharesEdge(a: Rect, b: Rect, minShare = 0.5): boolean {
  const zTouch = Math.abs(a.z0 - b.z1) < EPS || Math.abs(a.z1 - b.z0) < EPS;
  const xTouch = Math.abs(a.x0 - b.x1) < EPS || Math.abs(a.x1 - b.x0) < EPS;
  const xShare = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const zShare = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
  return (zTouch && xShare >= minShare) || (xTouch && zShare >= minShare);
}

export function inflate(rect: Rect, amount: number): Rect {
  return { x0: rect.x0 - amount, x1: rect.x1 + amount, z0: rect.z0 - amount, z1: rect.z1 + amount };
}

/** 矩形相减：`base` 减去 `cut`，最多四块，丢弃小于 3 mm 的碎片。 */
export function subtractRect(base: Rect, cut: Rect): Rect[] {
  if (!overlaps(base, cut)) return [base];
  const pieces: Rect[] = [];
  if (cut.z0 > base.z0) pieces.push({ x0: base.x0, x1: base.x1, z0: base.z0, z1: cut.z0 });
  if (cut.z1 < base.z1) pieces.push({ x0: base.x0, x1: base.x1, z0: cut.z1, z1: base.z1 });
  const z0 = Math.max(base.z0, cut.z0);
  const z1 = Math.min(base.z1, cut.z1);
  if (cut.x0 > base.x0) pieces.push({ x0: base.x0, x1: cut.x0, z0, z1 });
  if (cut.x1 < base.x1) pieces.push({ x0: cut.x1, x1: base.x1, z0, z1 });
  return pieces.filter((item) => item.x1 - item.x0 > 1e-3 && item.z1 - item.z0 > 1e-3);
}

export function subtractAll(base: Rect, cuts: readonly Rect[]): Rect[] {
  let pieces: Rect[] = [base];
  for (const cut of cuts) {
    if (pieces.length === 0) break;
    pieces = pieces.flatMap((piece) => subtractRect(piece, cut));
  }
  return pieces;
}

/** 正面朝向 → 绕 Y 的角度，与 `layout-adapter.entranceRotationY` 同一套约定。 */
export function rotationForFront(front: DecorFront): number {
  switch (front) {
    case 'south':
      return Math.PI;
    case 'north':
      return 0;
    case 'east':
      return Math.PI / 2;
    case 'west':
      return -Math.PI / 2;
    default:
      return 0;
  }
}

/** 世界方位 → 局部立面名（front = 局部 +Z、back = −Z、right = +X、left = −X）。 */
export function localFaceOfWorldSide(
  side: 'north' | 'south' | 'east' | 'west',
  front: DecorFront,
): 'front' | 'back' | 'left' | 'right' {
  // 各朝向下 rotationY 决定的映射（见 tests 与 EAST_GATE 的既有用法）
  const table: Record<DecorFront, Record<'north' | 'south' | 'east' | 'west', 'front' | 'back' | 'left' | 'right'>> = {
    south: { south: 'front', north: 'back', east: 'left', west: 'right' },
    north: { north: 'front', south: 'back', east: 'right', west: 'left' },
    east: { east: 'front', west: 'back', north: 'left', south: 'right' },
    west: { west: 'front', east: 'back', north: 'right', south: 'left' },
  };
  return table[front][side];
}

/**
 * 家具/树木的世界占地：把局部碰撞尺寸按 `rotationY` 旋转后的 AABB 跨度。
 *
 * 旋转对称构件（树干、方灯柱）不套旋转公式：0.70 m 的树干在 45° 会被放大到 0.99 m，
 * 反而挡住规划时以为可走的通道。
 */
export function propFootprint(prop: {
  readonly x: number;
  readonly z: number;
  readonly rotationY: number;
  readonly collider: { readonly width: number; readonly depth: number };
}): Rect {
  const { width: localW, depth: localD } = prop.collider;
  const symmetric = Math.abs(localW - localD) <= 1e-6;
  const cos = symmetric ? 1 : Math.abs(Math.cos(prop.rotationY));
  const sin = symmetric ? 0 : Math.abs(Math.sin(prop.rotationY));
  const width = cos * localW + sin * localD;
  const depth = sin * localW + cos * localD;
  return {
    x0: prop.x - width / 2,
    x1: prop.x + width / 2,
    z0: prop.z - depth / 2,
    z1: prop.z + depth / 2,
  };
}

/** 供 world 复用的单矩形包含判定（含半径内缩）。 */
export function insideAnyRect(rects: readonly Rect[], x: number, z: number, margin: number): boolean {
  for (const rect of rects) {
    if (x >= rect.x0 + margin && x <= rect.x1 - margin && z >= rect.z0 + margin && z <= rect.z1 - margin) {
      return true;
    }
  }
  return false;
}
