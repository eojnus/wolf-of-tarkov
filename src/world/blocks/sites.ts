/**
 * 站点枚举 —— 只读布局，找出"可以长出一个街区"的临街矩形。
 *
 * 做法：**按米列扫描可用进深**，而不是"整条带减去障碍再捡碎片"。
 * 后者会把一整块空地切成一堆 1 m 宽的碎片（障碍物在另一侧的边缘会横贯整条带），
 * 结果明明有 25×42 的空地，只捡出一个 25×15 的站点。
 *
 * 现在的算法：
 *  1. 每条道路的每一侧，从人行道外沿向内取 1 m 宽的列；
 *  2. 这一列的可用进深 = 所有压在这一列上的障碍里"最近的那条边"；
 *  3. 相邻且进深足够的列合成一段临街前沿，再按 `slot` 切分成站点；
 *  4. 站点进深取该段内所有列的最小值，保证矩形内部没有障碍。
 *
 * 仍然不猜、不硬塞：放不下的前沿只记录原因（过小的前沿合并成一条计数），不静默丢整片城区。
 */

import { CITY } from '../../content/config';
import { RESERVE_LAND_PARCELS } from '../../content/real-estate';
import { SCENERY_RULES } from '../../content/city-scenery';
import type { DecorFront } from '../../content/city-blocks';
import type { CityLayoutView } from '../../features/city-layout';
import { inflate, type Rect } from './rect';

export interface BlockSite {
  /** 稳定 id：`site-${roadId}-${side}-${起始米数}-${序号}`。布局不变则恒定。 */
  readonly id: string;
  readonly districtId: string;
  readonly roadId: string;
  /** 可建矩形（世界坐标），已扣除道路、人行道、业务建筑、储备地块与已占街区。 */
  readonly rect: Rect;
  /** 楼体正面朝向（朝向道路）。 */
  readonly front: DecorFront;
  readonly frontage: number;
  readonly depth: number;
}

export interface SkippedSite {
  readonly id: string;
  readonly reasons: readonly string[];
}

export interface SitePlan {
  readonly sites: readonly BlockSite[];
  readonly skipped: readonly SkippedSite[];
}

export interface SiteOptions {
  readonly maxDepth: number;
  readonly minFrontage: number;
  readonly minDepth: number;
  readonly slot: number;
}

export const SITE_OPTIONS: SiteOptions = {
  maxDepth: 42,
  minFrontage: 16,
  minDepth: 13,
  slot: 45,
};

/** 列宽：1 m。楼体最小 8 m，列再细没有意义；再粗会把障碍边界抹平。 */
const COLUMN = 1;

interface RoadRect {
  readonly id: string;
  readonly districtId: string;
  readonly rect: Rect;
  readonly horizontal: boolean;
}

function roadRectOf(road: {
  id: string;
  districtId: string;
  center: { x: number; z: number };
  size: { width: number; depth: number };
}): RoadRect {
  return {
    id: road.id,
    districtId: road.districtId,
    rect: {
      x0: road.center.x - road.size.width / 2,
      x1: road.center.x + road.size.width / 2,
      z0: road.center.z - road.size.depth / 2,
      z1: road.center.z + road.size.depth / 2,
    },
    horizontal: road.size.width >= road.size.depth,
  };
}

interface Side {
  readonly key: string;
  readonly front: DecorFront;
  readonly alongX: boolean;
  readonly uStart: number;
  readonly uEnd: number;
  /** 临街边的世界坐标（v = 0 处）。 */
  readonly edge: number;
  /** v 增长方向：+1 表示远离街道沿 +u 轴，-1 表示沿 -u 轴。 */
  readonly direction: 1 | -1;
}

/** 世界矩形 → 该侧的 (u, v) 区间。 */
function project(rect: Rect, side: Side): { u0: number; u1: number; v0: number; v1: number } {
  const u0 = side.alongX ? rect.x0 : rect.z0;
  const u1 = side.alongX ? rect.x1 : rect.z1;
  const a = side.alongX ? rect.z0 : rect.x0;
  const b = side.alongX ? rect.z1 : rect.x1;
  const v0 = side.direction === 1 ? a - side.edge : side.edge - b;
  const v1 = side.direction === 1 ? b - side.edge : side.edge - a;
  return { u0, u1, v0, v1 };
}

/** 该侧坐标 (u, v) → 世界矩形。 */
function unproject(side: Side, u0: number, u1: number, v0: number, v1: number): Rect {
  if (side.alongX) {
    const z0 = side.direction === 1 ? side.edge + v0 : side.edge - v1;
    const z1 = side.direction === 1 ? side.edge + v1 : side.edge - v0;
    return { x0: u0, x1: u1, z0, z1 };
  }
  const x0 = side.direction === 1 ? side.edge + v0 : side.edge - v1;
  const x1 = side.direction === 1 ? side.edge + v1 : side.edge - v0;
  return { x0, x1, z0: u0, z1: u1 };
}

export function planSites(layout: CityLayoutView, occupied: readonly Rect[] = []): SitePlan {
  const roads = layout.roads.map(roadRectOf);
  const bounds = layout.bounds;
  const sidewalk = CITY.sidewalkWidth;

  const obstacles: Rect[] = [
    ...layout.buildings.map((building) =>
      inflate(
        {
          x0: building.position.x - building.size.width / 2,
          x1: building.position.x + building.size.width / 2,
          z0: building.position.z - building.size.depth / 2,
          z1: building.position.z + building.size.depth / 2,
        },
        SCENERY_RULES.buildingToBusiness,
      ),
    ),
    // 储备地块只存在于 content（坐标不可移动），直接读常量
    ...RESERVE_LAND_PARCELS.map((item) =>
      inflate(
        {
          x0: item.center.x - item.size.width / 2,
          x1: item.center.x + item.size.width / 2,
          z0: item.center.z - item.size.depth / 2,
          z1: item.center.z + item.size.depth / 2,
        },
        SCENERY_RULES.clearToReserve,
      ),
    ),
    ...occupied,
  ];

  const sites: BlockSite[] = [];
  const skipped: SkippedSite[] = [];
  const taken: Rect[] = [...occupied];

  for (const road of roads) {
    // 其他道路（含人行道）：整条让开，路口附近不生成站点
    const otherRoads = roads
      .filter((other) => other.id !== road.id)
      .map((other) => inflate(other.rect, sidewalk));

    const sides: Side[] = [];
    if (road.horizontal) {
      sides.push({
        key: 'north',
        front: 'south',
        alongX: true,
        uStart: Math.max(bounds.minX, road.rect.x0),
        uEnd: Math.min(bounds.maxX, road.rect.x1),
        edge: road.rect.z1 + sidewalk,
        direction: 1,
      });
      sides.push({
        key: 'south',
        front: 'north',
        alongX: true,
        uStart: Math.max(bounds.minX, road.rect.x0),
        uEnd: Math.min(bounds.maxX, road.rect.x1),
        edge: road.rect.z0 - sidewalk,
        direction: -1,
      });
    } else {
      sides.push({
        key: 'east',
        front: 'west',
        alongX: false,
        uStart: Math.max(bounds.minZ, road.rect.z0),
        uEnd: Math.min(bounds.maxZ, road.rect.z1),
        edge: road.rect.x1 + sidewalk,
        direction: 1,
      });
      sides.push({
        key: 'west',
        front: 'east',
        alongX: false,
        uStart: Math.max(bounds.minZ, road.rect.z0),
        uEnd: Math.min(bounds.maxZ, road.rect.z1),
        edge: road.rect.x0 - sidewalk,
        direction: -1,
      });
    }

    for (const side of sides) {
      const allObstacles = [...otherRoads, ...obstacles, ...taken];

      // ---- 每列可用进深
      const columns: number[] = [];
      const count = Math.max(0, Math.floor((side.uEnd - side.uStart) / COLUMN));
      const maxByBounds =
        side.direction === 1
          ? (side.alongX ? bounds.maxZ : bounds.maxX) - side.edge
          : side.edge - (side.alongX ? bounds.minZ : bounds.minX);
      for (let i = 0; i < count; i += 1) {
        const u0 = side.uStart + i * COLUMN;
        const u1 = u0 + COLUMN;
        let depth = Math.min(SITE_OPTIONS.maxDepth, Math.max(0, maxByBounds));
        for (const rect of allObstacles) {
          const p = project(rect, side);
          if (p.u1 <= u0 + 1e-6 || p.u0 >= u1 - 1e-6) continue;
          if (p.v1 <= 0) continue; // 完全在临街边之后（背后），不挡这一列
          depth = Math.min(depth, Math.max(0, p.v0));
        }
        columns.push(Math.max(0, depth));
      }

      // ---- 相邻且进深足够的列合成一段前沿
      let runStart = -1;
      let shallow = 0;
      const flush = (endIndex: number): void => {
        if (runStart < 0) return;
        const start = runStart;
        runStart = -1;
        const u0 = side.uStart + start * COLUMN;
        const u1 = side.uStart + endIndex * COLUMN;
        const width = u1 - u0;
        if (width < 4) return;
        if (width < SITE_OPTIONS.minFrontage - 1e-6) {
          skipped.push({
            id: `site-${road.id}-${side.key}-u${Math.round(u0)}`,
            reasons: [`可用前宽仅 ${width.toFixed(1)} m（需 ≥ ${SITE_OPTIONS.minFrontage}）`],
          });
          return;
        }
        let depth = Infinity;
        for (let i = start; i < endIndex; i += 1) depth = Math.min(depth, columns[i]);
        const chunks = Math.max(1, Math.round(width / SITE_OPTIONS.slot));
        const chunkWidth = width / chunks;
        for (let c = 0; c < chunks; c += 1) {
          const cu0 = u0 + c * chunkWidth;
          const cu1 = cu0 + chunkWidth;
          const rect = unproject(side, cu0, cu1, 0, depth);
          sites.push({
            id: `site-${road.id}-${side.key}-${Math.round(cu0)}-${c + 1}`,
            districtId: road.districtId,
            roadId: road.id,
            rect,
            front: side.front,
            frontage: Number(chunkWidth.toFixed(2)),
            depth: Number(depth.toFixed(2)),
          });
          taken.push(rect);
        }
      };

      for (let i = 0; i < columns.length; i += 1) {
        const usable = columns[i] >= SITE_OPTIONS.minDepth - 1e-6;
        if (usable && runStart < 0) runStart = i;
        if (!usable) {
          if (runStart >= 0) flush(i);
          if (columns[i] > 0) shallow += 1;
        }
      }
      if (runStart >= 0) flush(columns.length);
      if (shallow > 0) {
        skipped.push({
          id: `site-${road.id}-${side.key}-shallow`,
          reasons: [`${shallow} m 前沿的可用进深不足 ${SITE_OPTIONS.minDepth} m（被业务建筑/路口切断）`],
        });
      }
    }
  }

  return { sites, skipped };
}
