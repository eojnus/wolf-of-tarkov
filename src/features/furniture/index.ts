/**
 * 家具切片 —— 纯数据、纯网格与纯命令规则。
 *
 * 只认 content 中的 19 件固定定义；不读 DOM、Three.js 或 GameState 其他切片。
 * 所有入口共用同一套取整/夹取函数，拖动、旋转、摆放与校验不会各自算一套。
 */

import { BusinessError } from '../../core/errors';
import type { DeepReadonly } from '../../core/readonly';
import {
  FURNITURE_CELL_SIZE,
  FURNITURE_DEFINITION_BY_ID,
  FURNITURE_DEFINITIONS,
  FURNITURE_GRID,
  FURNITURE_LAYOUT_VERSION,
  FURNITURE_RESIDENCE_ID,
  instanceIdOf,
  type FurnitureDefinition,
  type QuarterTurn,
} from '../../content/interior';

export type FurnitureStatus = 'placed' | 'stored';

export interface FurnitureInstance {
  id: string;
  definitionId: string;
  status: FurnitureStatus;
  cellX: number;
  cellZ: number;
  /** 未旋转局部整数格。 */
  footprintWidth: number;
  footprintDepth: number;
  quarterTurn: QuarterTurn;
}

export interface FurnitureState {
  residenceId: 'home-001';
  layoutVersion: 1;
  items: Record<string, FurnitureInstance>;
}

export type ReadonlyFurnitureState = DeepReadonly<FurnitureState>;

export interface FurnitureWorldBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number;
  maxY: number;
}

export interface FurnitureCommandResult {
  readonly ok: boolean;
  readonly message: string | null;
  /** 成功提交后的只读布局；失败时为空。 */
  readonly layout?: ReadonlyFurnitureState;
}

export interface FurnitureSpan {
  readonly width: number;
  readonly depth: number;
}

export function createFurnitureState(): FurnitureState {
  const items: Record<string, FurnitureInstance> = {};
  for (const definition of FURNITURE_DEFINITIONS) {
    const id = instanceIdOf(definition);
    items[id] = {
      id,
      definitionId: definition.id,
      status: 'placed',
      cellX: definition.seed.cellX,
      cellZ: definition.seed.cellZ,
      footprintWidth: definition.footprintWidth,
      footprintDepth: definition.footprintDepth,
      quarterTurn: definition.seed.quarterTurn,
    };
  }
  return {
    residenceId: FURNITURE_RESIDENCE_ID,
    layoutVersion: FURNITURE_LAYOUT_VERSION,
    items,
  };
}

export function definitionOf(item: {
  readonly definitionId: string;
}): FurnitureDefinition {
  const definition = FURNITURE_DEFINITION_BY_ID[item.definitionId];
  if (!definition) {
    throw new BusinessError('UNKNOWN_FURNITURE', `未知家具定义：${item.definitionId}`);
  }
  return definition;
}

/** q 为奇数时宽深互换；width/depth 是局部未旋转格数。 */
export function footprintForRotation(
  width: number,
  depth: number,
  quarterTurn: QuarterTurn,
): FurnitureSpan {
  return quarterTurn % 2 === 0
    ? { width, depth }
    : { width: depth, depth: width };
}

export function footprintOf(item: {
  readonly footprintWidth: number;
  readonly footprintDepth: number;
  readonly quarterTurn: QuarterTurn;
}): FurnitureSpan {
  return footprintForRotation(item.footprintWidth, item.footprintDepth, item.quarterTurn);
}

export function cellCenter(cellX: number, cellZ: number, span: FurnitureSpan): {
  x: number;
  z: number;
} {
  return {
    x: (cellX + span.width / 2) * FURNITURE_CELL_SIZE,
    z: (cellZ + span.depth / 2) * FURNITURE_CELL_SIZE,
  };
}

/** 固定半格规则：floor(v + 0.5 + 1e-6)，再夹到可放整格范围。 */
export function cellFromCenter(
  centerX: number,
  centerZ: number,
  span: FurnitureSpan,
): { cellX: number; cellZ: number } {
  const rawX = Math.floor(centerX / FURNITURE_CELL_SIZE - span.width / 2 + 0.5 + 1e-6);
  const rawZ = Math.floor(centerZ / FURNITURE_CELL_SIZE - span.depth / 2 + 0.5 + 1e-6);
  return {
    cellX: clampCell(rawX, span.width, FURNITURE_GRID.maxCellX),
    cellZ: clampCell(rawZ, span.depth, FURNITURE_GRID.maxCellZ),
  };
}

function clampCell(value: number, span: number, maxCell: number): number {
  const min = Math.max(0, FURNITURE_GRID.minCellX);
  const max = Math.max(min, maxCell - span);
  return Math.min(Math.max(value, min), max);
}

export function isCellPlacementValid(
  cellX: number,
  cellZ: number,
  span: FurnitureSpan,
): boolean {
  return (
    Number.isSafeInteger(cellX) &&
    Number.isSafeInteger(cellZ) &&
    cellX >= FURNITURE_GRID.minCellX &&
    cellZ >= FURNITURE_GRID.minCellZ &&
    cellX + span.width <= FURNITURE_GRID.maxCellX &&
    cellZ + span.depth <= FURNITURE_GRID.maxCellZ
  );
}

function itemOf(state: FurnitureState, id: string): FurnitureInstance {
  const item = state.items[id];
  if (!item) throw new BusinessError('UNKNOWN_FURNITURE', `没有这件家具：${id}`);
  return item;
}

function assertCell(cellX: number, cellZ: number): void {
  if (!Number.isSafeInteger(cellX) || !Number.isSafeInteger(cellZ)) {
    throw new BusinessError('INVALID_FURNITURE_CELL', '家具格位必须是整数');
  }
}

export function moveFurniture(
  state: FurnitureState,
  id: string,
  cellX: number,
  cellZ: number,
): void {
  const item = itemOf(state, id);
  if (item.status !== 'placed') {
    throw new BusinessError('FURNITURE_STORED', '仓库中的家具不能直接移动');
  }
  assertCell(cellX, cellZ);
  const span = footprintOf(item);
  item.cellX = clampCell(cellX, span.width, FURNITURE_GRID.maxCellX);
  item.cellZ = clampCell(cellZ, span.depth, FURNITURE_GRID.maxCellZ);
}

/** 以当前占格中心为目标旋转 90°，一次同时改 q 与锚点。 */
export function rotateFurniture(
  state: FurnitureState,
  id: string,
  direction: -1 | 1,
): void {
  const item = itemOf(state, id);
  if (item.status !== 'placed') {
    throw new BusinessError('FURNITURE_STORED', '仓库中的家具不能旋转');
  }
  const before = footprintOf(item);
  const center = cellCenter(item.cellX, item.cellZ, before);
  const nextTurn = (((item.quarterTurn + direction) % 4) + 4) % 4 as QuarterTurn;
  const after = footprintForRotation(item.footprintWidth, item.footprintDepth, nextTurn);
  const cell = cellFromCenter(center.x, center.z, after);
  item.quarterTurn = nextTurn;
  item.cellX = cell.cellX;
  item.cellZ = cell.cellZ;
}

export function storeFurniture(state: FurnitureState, id: string): void {
  const item = itemOf(state, id);
  if (item.status === 'stored') return;
  item.status = 'stored';
}

export function placeFurniture(
  state: FurnitureState,
  id: string,
  cellX: number,
  cellZ: number,
): void {
  const item = itemOf(state, id);
  assertCell(cellX, cellZ);
  const span = footprintOf(item);
  item.status = 'placed';
  item.cellX = clampCell(cellX, span.width, FURNITURE_GRID.maxCellX);
  item.cellZ = clampCell(cellZ, span.depth, FURNITURE_GRID.maxCellZ);
}

export function occupiedCells(
  state: FurnitureState | ReadonlyFurnitureState,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const item of Object.values(state.items)) {
    if (item.status !== 'placed') continue;
    const span = footprintForRotation(
      item.footprintWidth,
      item.footprintDepth,
      item.quarterTurn,
    );
    for (let x = item.cellX; x < item.cellX + span.width; x += 1) {
      for (let z = item.cellZ; z < item.cellZ + span.depth; z += 1) {
        const key = `${x},${z}`;
        const set = map.get(key);
        if (set) set.add(item.id);
        else map.set(key, new Set([item.id]));
      }
    }
  }
  return map;
}

function rotatedOffset(
  offsetX: number,
  offsetZ: number,
  quarterTurn: QuarterTurn,
): { x: number; z: number } {
  switch (quarterTurn) {
    case 1:
      return { x: offsetZ, z: -offsetX };
    case 2:
      return { x: -offsetX, z: -offsetZ };
    case 3:
      return { x: -offsetZ, z: offsetX };
    default:
      return { x: offsetX, z: offsetZ };
  }
}

export interface StandingSearchBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * 退出编辑的安全落点（纯计算）。
 *
 * 起点可能被家具覆盖，因此允许起点格作为特殊逃逸节点；固定壳体永不忽略，
 * 四方向搜索并用线段检查防止跨过薄墙。
 */
export function findSafeStandingPose(input: {
  readonly pose: { readonly x: number; readonly z: number };
  readonly shell: readonly FurnitureWorldBox[];
  readonly furniture: readonly FurnitureWorldBox[];
  readonly bounds: StandingSearchBounds;
  readonly radius: number;
  readonly edgeMargin: number;
}): { x: number; z: number } | null {
  const { pose, shell, furniture, bounds, radius, edgeMargin } = input;
  const hits = (x: number, z: number, box: FurnitureWorldBox): boolean =>
    x > box.minX - radius &&
    x < box.maxX + radius &&
    z > box.minZ - radius &&
    z < box.maxZ + radius;
  const insideBounds = (x: number, z: number): boolean =>
    x > bounds.minX + edgeMargin &&
    x < bounds.maxX - edgeMargin &&
    z > bounds.minZ + edgeMargin &&
    z < bounds.maxZ - edgeMargin;
  const free = (x: number, z: number): boolean => {
    if (!insideBounds(x, z)) return false;
    for (const box of shell) if (hits(x, z, box)) return false;
    for (const box of furniture) if (hits(x, z, box)) return false;
    return true;
  };

  if (free(pose.x, pose.z)) return { x: pose.x, z: pose.z };
  const covering = furniture.filter((box) => hits(pose.x, pose.z, box));
  if (covering.length === 0) return null;

  // 搜索阶段只以固定壳体建立原站位连通域；所有可移动家具暂时忽略。
  // 最终落点仍由 free() 检查全部家具碰撞。
  const segmentBlocked = (
    ax: number,
    az: number,
    bx: number,
    bz: number,
  ): boolean => {
    for (const box of shell) {
      if (segmentHitsExpandedBox(ax, az, bx, bz, box, radius)) return true;
    }
    return false;
  };

  const candidates: Array<{ x: number; z: number; distance: number }> = [];
  for (const box of covering) {
    candidates.push(
      { x: box.minX - radius - 1e-4, z: pose.z, distance: 0 },
      { x: box.maxX + radius + 1e-4, z: pose.z, distance: 0 },
      { x: pose.x, z: box.minZ - radius - 1e-4, distance: 0 },
      { x: pose.x, z: box.maxZ + radius + 1e-4, distance: 0 },
    );
  }
  for (const candidate of candidates) {
    candidate.distance = Math.hypot(candidate.x - pose.x, candidate.z - pose.z);
  }
  candidates.sort((a, b) => a.distance - b.distance || a.z - b.z || a.x - b.x);
  for (const candidate of candidates) {
    if (
      free(candidate.x, candidate.z) &&
      !segmentBlocked(pose.x, pose.z, candidate.x, candidate.z)
    ) {
      return { x: candidate.x, z: candidate.z };
    }
  }

  const cellSize = FURNITURE_CELL_SIZE;
  const startCellX = Math.floor(pose.x / cellSize);
  const startCellZ = Math.floor(pose.z / cellSize);
  // 起点格中心可能因 2.5cm 量化落进墙外扩盒/边界，不能因此拒绝；
  // 起点只能作为特殊逃逸节点，真正的墙体检查用“实际 pose → 首个格点”的线段。

  const passable = (x: number, z: number): boolean => {
    if (!insideBounds(x, z)) return false;
    for (const box of shell) if (hits(x, z, box)) return false;
    return true;
  };
  interface Node {
    x: number;
    z: number;
    distance: number;
  }
  const heap: Node[] = [{ x: startCellX, z: startCellZ, distance: 0 }];
  const best = new Map<string, number>();
  const before = (a: Node, b: Node): boolean =>
    a.distance < b.distance ||
    (a.distance === b.distance && (a.z < b.z || (a.z === b.z && a.x < b.x)));
  const push = (node: Node): void => {
    heap.push(node);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!before(heap[index]!, heap[parent]!)) break;
      [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
      index = parent;
    }
  };
  const pop = (): Node | null => {
    if (heap.length === 0) return null;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heap.length && before(heap[left]!, heap[smallest]!)) {
          smallest = left;
        }
        if (right < heap.length && before(heap[right]!, heap[smallest]!)) {
          smallest = right;
        }
        if (smallest === index) break;
        [heap[smallest], heap[index]] = [heap[index]!, heap[smallest]!];
        index = smallest;
      }
    }
    return top;
  };

  best.set(`${startCellX},${startCellZ}`, 0);

  while (heap.length > 0) {
    const node = pop();
    if (!node) break;
    const centerX = (node.x + 0.5) * cellSize;
    const centerZ = (node.z + 0.5) * cellSize;
    if (free(centerX, centerZ)) return { x: centerX, z: centerZ };
    const neighbours = [
      { x: node.x + 1, z: node.z },
      { x: node.x - 1, z: node.z },
      { x: node.x, z: node.z + 1 },
      { x: node.x, z: node.z - 1 },
    ];
    for (const next of neighbours) {
      const nextX = (next.x + 0.5) * cellSize;
      const nextZ = (next.z + 0.5) * cellSize;
      if (!passable(nextX, nextZ)) continue;
      const fromX = node.distance === 0 ? pose.x : centerX;
      const fromZ = node.distance === 0 ? pose.z : centerZ;
      if (segmentBlocked(fromX, fromZ, nextX, nextZ)) continue;
      const distance = node.distance + Math.hypot(nextX - centerX, nextZ - centerZ);
      const key = `${next.x},${next.z}`;
      const old = best.get(key);
      if (old !== undefined && old <= distance) continue;
      best.set(key, distance);
      push({ x: next.x, z: next.z, distance });
    }
  }
  return null;
}

function segmentHitsExpandedBox(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  box: FurnitureWorldBox,
  radius: number,
): boolean {
  const minX = box.minX - radius;
  const maxX = box.maxX + radius;
  const minZ = box.minZ - radius;
  const maxZ = box.maxZ + radius;
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dz = bz - az;
  const clip = (origin: number, direction: number, min: number, max: number): boolean => {
    if (Math.abs(direction) < 1e-12) return origin >= min && origin <= max;
    const near = (min - origin) / direction;
    const far = (max - origin) / direction;
    const enter = Math.min(near, far);
    const leave = Math.max(near, far);
    t0 = Math.max(t0, enter);
    t1 = Math.min(t1, leave);
    return t0 <= t1;
  };
  if (!clip(ax, dx, minX, maxX)) return false;
  if (!clip(az, dz, minZ, maxZ)) return false;
  return t0 <= t1;
}

/** 已放置家具的人物碰撞/相机遮挡盒；已收纳不返回。 */
export function playerCollidersOf(
  state: FurnitureState | ReadonlyFurnitureState,
): FurnitureWorldBox[] {
  const boxes: FurnitureWorldBox[] = [];
  for (const item of Object.values(state.items)) {
    if (item.status !== 'placed') continue;
    const definition = FURNITURE_DEFINITION_BY_ID[item.definitionId];
    if (!definition || definition.playerCollision.length === 0) continue;
    const span = footprintForRotation(
      item.footprintWidth,
      item.footprintDepth,
      item.quarterTurn,
    );
    const center = cellCenter(item.cellX, item.cellZ, span);
    for (const local of definition.playerCollision) {
      const offset = rotatedOffset(local.offsetX, local.offsetZ, item.quarterTurn);
      const width = item.quarterTurn % 2 === 0 ? local.width : local.depth;
      const depth = item.quarterTurn % 2 === 0 ? local.depth : local.width;
      boxes.push({
        minX: center.x + offset.x - width / 2,
        maxX: center.x + offset.x + width / 2,
        minZ: center.z + offset.z - depth / 2,
        maxZ: center.z + offset.z + depth / 2,
        minY: local.minY,
        maxY: local.maxY,
      });
    }
  }
  return boxes;
}
