/**
 * 街区规划器 —— 纯函数，只读布局与配置，不 import Three.js，不写任何状态。
 *
 * 输入：存档里的**真实** `CityLayoutView`（不是 `createBaseLayout()` 的假设）
 * 输出：可渲染的 `BlockPlan[]` + 街道步行域 + 跳过原因
 *
 * 三条硬规则：
 *  1. 只读：绝不写回布局，也不读写房地产/资金；
 *  2. 硬门槛不满足就**跳过整个街区**并给出原因，绝不把楼硬塞进既有建筑；
 *  3. 所有位置、尺寸、规则阈值都来自 `content`，本文件不内联数字。
 */

import { CITY } from '../../content/config';
import {
  BLOCK_RULES_VERSION,
  blockFamilyById,
  defaultFamilyForDistrict,
  type BlockFamilyDef,
  type BlockTemplate,
  type DecorBuildingSpec,
} from '../../content/city-blocks';
import { BLOCK_TEMPLATES } from '../../content/city-blocks';
import { RESERVE_LAND_PARCELS } from '../../content/real-estate';
import { SCENERY_MODELS, SCENERY_RULES, type SceneryModelKey } from '../../content/city-scenery';
import type { CityLayoutView } from '../../features/city-layout';
import { hashSeed, mulberry32 } from '../buildings/random';
import {
  EPS,
  gap,
  overlaps,
  propFootprint,
  rectDepth,
  rectWidth,
  rotationForFront,
  sharesEdge,
  type Rect,
} from './rect';
import { generateBlock } from './generate';
import { planSites } from './sites';
import type {
  BlockCollider,
  BlockPlan,
  CityBlocksResult,
  DecorPlacement,
  PavingPlacement,
  PropPlacement,
  WallPlacement,
} from './types';

// 兼容既有引用：这些工具与类型过去都从本文件导出
export type { BlockCollider, BlockPlan, CityBlocksResult, DecorPlacement, PavingPlacement, PropPlacement, WallPlacement } from './types';
export type { Rect } from './rect';
export { insideAnyRect, propFootprint, rectDepth, rectWidth, rotationForFront } from './rect';
export { gap as rectGap, overlaps as rectsOverlap } from './rect';

/* ---------------------------------------------------------------- 几何工具 */

function rectOfCollider(building: { position: { x: number; z: number }; size: { width: number; depth: number } }): Rect {
  return {
    x0: building.position.x - building.size.width / 2,
    x1: building.position.x + building.size.width / 2,
    z0: building.position.z - building.size.depth / 2,
    z1: building.position.z + building.size.depth / 2,
  };
}

/** 局部宽深 → 世界跨度（90° 时交换）。与 `envelopeOf` 的换算一致，用于交叉校验。 */
function worldExtent(spec: DecorBuildingSpec): { x: number; z: number } {
  const quarter = spec.front === 'east' || spec.front === 'west';
  return quarter
    ? { x: spec.local.depth, z: spec.local.width }
    : { x: spec.local.width, z: spec.local.depth };
}

/* ---------------------------------------------------------------- 街道带 */

/**
 * 街道步行带：只向道路**两侧**外扩人行道宽，不沿道路末端延伸。
 *
 * 与渲染端的画法必须完全一致（`world/scene.ts` 的 `sidewalkBandOf`）。
 */
export function sidewalkBandOf(road: { center: { x: number; z: number }; size: { width: number; depth: number } }): Rect {
  const width = CITY.sidewalkWidth;
  const horizontal = road.size.width >= road.size.depth;
  const x0 = road.center.x - road.size.width / 2;
  const x1 = road.center.x + road.size.width / 2;
  const z0 = road.center.z - road.size.depth / 2;
  const z1 = road.center.z + road.size.depth / 2;
  return horizontal
    ? { x0, x1, z0: z0 - width, z1: z1 + width }
    : { x0: x0 - width, x1: x1 + width, z0, z1 };
}

export function streetWalkableOf(layout: CityLayoutView): Rect[] {
  return layout.roads.map((road) => sidewalkBandOf(road));
}

/* ---------------------------------------------------------------- 树位生成 */

interface TreeDraft {
  readonly x: number;
  readonly z: number;
}

/**
 * 按空间生成树位：沿街按间距排布，庭院按网格 + 种子抖动。
 *
 * 位置**由区间长度与间距推导**，不是固定点表；同一 seed 永远同一结果。
 *
 * 两套包络各管一件事：
 *  - **树干盒**只判"是否落在种植带内"（种植带常常只有 2 m 深，用树冠判会把树全排掉）；
 *  - **树冠盒**用于避让建筑、围墙、家具与储备地块，保证枝叶不插进墙面与座椅。
 * 树冠不进碰撞，玩家只与树干相撞。
 */
function placeTrees(
  template: BlockTemplate,
  seed: number,
  isBlocked: (rect: Rect) => boolean,
): TreeDraft[] {
  const random = mulberry32(seed);
  const result: TreeDraft[] = [];
  const spec = SCENERY_MODELS['street-tree'];
  const half = spec.collider.width / 2;
  const crownHalfX = (spec.crown?.width ?? spec.collider.width) / 2;
  const crownHalfZ = (spec.crown?.depth ?? spec.collider.depth) / 2;
  const crownBoxOf = (x: number, z: number): Rect => ({
    x0: x - crownHalfX,
    x1: x + crownHalfX,
    z0: z - crownHalfZ,
    z1: z + crownHalfZ,
  });

  for (const zone of template.treeZones) {
    const rect = zone.rect;
    if (zone.line === 'x') {
      const count = Math.max(1, Math.floor(rectWidth(rect) / zone.spacing) + 1);
      const span = rectWidth(rect);
      const step = count > 1 ? span / (count - 1) : 0;
      const z = (rect.z0 + rect.z1) / 2;
      for (let i = 0; i < count; i += 1) {
        const x = rect.x0 + step * i;
        if (isBlocked(crownBoxOf(x, z))) continue;
        result.push({ x, z });
      }
    } else {
      const cols = Math.max(1, Math.floor(rectWidth(rect) / zone.spacing) + 1);
      const rows = Math.max(1, Math.floor(rectDepth(rect) / zone.spacing) + 1);
      for (let c = 0; c < cols; c += 1) {
        for (let r = 0; r < rows; r += 1) {
          const baseX = rect.x0 + (rectWidth(rect) * (c + 0.5)) / cols;
          const baseZ = rect.z0 + (rectDepth(rect) * (r + 0.5)) / rows;
          // 抖动幅度不超过格距的 18%，保证不会把树推到墙边。
          const jitter = zone.spacing * 0.18;
          const x = baseX + (random() * 2 - 1) * jitter;
          const z = baseZ + (random() * 2 - 1) * jitter;
          const box = { x0: x - half, x1: x + half, z0: z - half, z1: z + half };
          if (box.x0 < rect.x0 || box.x1 > rect.x1 || box.z0 < rect.z0 || box.z1 > rect.z1) continue;
          if (isBlocked(crownBoxOf(x, z))) continue;
          result.push({ x, z });
        }
      }
    }
  }
  return result;
}

/* ---------------------------------------------------------------- 规划主体 */

function planOne(
  template: BlockTemplate,
  layout: CityLayoutView,
  businessRects: readonly { id: string; rect: Rect }[],
  reserveRects: readonly { id: string; rect: Rect; required: boolean }[],
): BlockPlan {
  const skip: string[] = [];
  const bounds = layout.bounds;

  // 锚点必须存在：不存在说明这份布局不是本试点预期的城区，直接跳过而不是错位生成。
  for (const anchorId of template.anchorIds) {
    if (!businessRects.some((item) => item.id === anchorId)) {
      skip.push(`锚点建筑缺失：${anchorId}`);
    }
  }
  // 必须避让的储备地块必须存在，否则无法证明避让成立。
  for (const reserveId of template.reserveIds) {
    if (!reserveRects.some((item) => item.id === reserveId && item.required)) {
      skip.push(`储备地块缺失：${reserveId}`);
    }
  }

  // 1) 楼体：世界跨度与局部宽深必须自洽
  const decor: DecorPlacement[] = [];
  for (const spec of template.buildings) {
    const extent = worldExtent(spec);
    const worldW = rectWidth(spec.footprint);
    const worldD = rectDepth(spec.footprint);
    if (Math.abs(extent.x - worldW) > 1e-6 || Math.abs(extent.z - worldD) > 1e-6) {
      skip.push(
        `楼体 ${spec.id} 的世界占地 ${worldW.toFixed(2)}×${worldD.toFixed(2)} 与局部 ${spec.local.width}×${spec.local.depth} 不换算一致`,
      );
    }
    if (
      spec.footprint.x0 < bounds.minX ||
      spec.footprint.x1 > bounds.maxX ||
      spec.footprint.z0 < bounds.minZ ||
      spec.footprint.z1 > bounds.maxZ
    ) {
      skip.push(`楼体 ${spec.id} 越出城市边界`);
    }
    for (const item of businessRects) {
      const g = gap(spec.footprint, item.rect);
      if (g < SCENERY_RULES.buildingToBusiness - EPS) {
        skip.push(`楼体 ${spec.id} 距业务建筑 ${item.id} 仅 ${g.toFixed(2)} m（需 ≥ ${SCENERY_RULES.buildingToBusiness}）`);
      }
    }
    for (const item of reserveRects) {
      const g = gap(spec.footprint, item.rect);
      if (g < SCENERY_RULES.clearToReserve - EPS) {
        skip.push(`楼体 ${spec.id} 距储备地块 ${item.id} 仅 ${g.toFixed(2)} m（需 ≥ ${SCENERY_RULES.clearToReserve}）`);
      }
    }
    decor.push({
      id: `${template.id}-${spec.id}`,
      styleId: spec.styleId,
      size: { width: spec.local.width, depth: spec.local.depth, height: spec.local.height },
      position: {
        x: (spec.footprint.x0 + spec.footprint.x1) / 2,
        z: (spec.footprint.z0 + spec.footprint.z1) / 2,
      },
      rotationY: rotationForFront(spec.front),
      blindFaces: spec.blindFaces,
      footprint: spec.footprint,
      label: spec.label,
    });
  }

  // 2) 铺装：可贴业务建筑，但不得压进车行道与储备地块
  const roadRects = layout.roads.map((road) => ({
    id: road.id,
    rect: {
      x0: road.center.x - road.size.width / 2,
      x1: road.center.x + road.size.width / 2,
      z0: road.center.z - road.size.depth / 2,
      z1: road.center.z + road.size.depth / 2,
    },
  }));
  const paving: PavingPlacement[] = [];
  for (const spec of template.paving) {
    for (const item of businessRects) {
      if (overlaps(spec.rect, item.rect)) skip.push(`铺装 ${spec.id} 与业务建筑 ${item.id} 面积重叠`);
    }
    for (const item of reserveRects) {
      const g = gap(spec.rect, item.rect);
      if (g < SCENERY_RULES.clearToReserve - EPS) {
        skip.push(`铺装 ${spec.id} 距储备地块 ${item.id} 仅 ${g.toFixed(2)} m`);
      }
    }
    for (const road of roadRects) {
      if (overlaps(spec.rect, road.rect)) skip.push(`铺装 ${spec.id} 压到车行道 ${road.id}`);
    }
    paving.push({ id: `${template.id}-${spec.id}`, rect: spec.rect, surface: spec.surface });
  }

  // 3) 围墙
  const walls: WallPlacement[] = [];
  for (const spec of template.walls) {
    for (const item of businessRects) {
      if (overlaps(spec.rect, item.rect)) skip.push(`围墙 ${spec.id} 与业务建筑 ${item.id} 面积重叠`);
    }
    for (const item of reserveRects) {
      const g = gap(spec.rect, item.rect);
      if (g < SCENERY_RULES.clearToReserve - EPS) {
        skip.push(`围墙 ${spec.id} 距储备地块 ${item.id} 仅 ${g.toFixed(2)} m`);
      }
    }
    walls.push({ ...spec, id: `${template.id}-${spec.id}` });
  }

  // 4) 巷道贯通 + 净宽
  const alley = template.paving.find((item) => item.id === 'alley');
  if (alley) {
    const width = Math.min(rectWidth(alley.rect), rectDepth(alley.rect));
    if (width < SCENERY_RULES.alleyMinWidth - EPS) {
      skip.push(`巷道净宽 ${width.toFixed(2)} m 小于 ${SCENERY_RULES.alleyMinWidth}`);
    }
    const bands = streetWalkableOf(layout);
    if (!bands.some((band) => sharesEdge(alley.rect, band))) skip.push('巷道未与街道人行道带连通');
    if (!sharesEdge(alley.rect, template.courtyard)) skip.push('巷道未与庭院连通');
  } else {
    skip.push('模板缺少巷道');
  }

  // 5) 庭院净宽与面积
  const cw = Math.min(rectWidth(template.courtyard), rectDepth(template.courtyard));
  const area = rectWidth(template.courtyard) * rectDepth(template.courtyard);
  if (cw < SCENERY_RULES.courtyardMinWidth - EPS) skip.push(`庭院净宽 ${cw.toFixed(2)} m 小于 ${SCENERY_RULES.courtyardMinWidth}`);
  if (area < SCENERY_RULES.courtyardMinArea - EPS) skip.push(`庭院面积 ${area.toFixed(0)} ㎡ 小于 ${SCENERY_RULES.courtyardMinArea}`);

  // 6) 沿街墙段前宽（扣除共墙半厚）
  for (const run of template.frontageRuns) {
    const exclusive = rectWidth(run.rect) - run.share;
    if (exclusive < SCENERY_RULES.minFrontageRun - EPS) {
      skip.push(`沿街墙段独占前宽 ${exclusive.toFixed(2)} m 小于 ${SCENERY_RULES.minFrontageRun}`);
    }
  }

  // 7) 窄缝：实体两两之间要么贴合，要么 ≥ 最小值
  const solids = [
    ...template.buildings.map((item) => ({ id: item.id, rect: item.footprint })),
    ...template.walls.map((item) => ({ id: item.id, rect: item.rect })),
  ];
  for (let i = 0; i < solids.length; i += 1) {
    for (let j = i + 1; j < solids.length; j += 1) {
      const a = solids[i];
      const b = solids[j];
      if (overlaps(a.rect, b.rect)) continue; // 共墙：包络重叠是声明过的
      const g = gap(a.rect, b.rect);
      if (g > EPS && g < SCENERY_RULES.minGapBetweenSolids - EPS) {
        skip.push(`实体 ${a.id} 与 ${b.id} 之间存在 ${g.toFixed(2)} m 窄缝`);
      }
    }
  }

  // 8) 家具：不得压到楼体、围墙、储备地块，且必须落在铺装上
  const props: PropPlacement[] = [];
  const solidRects = solids.map((item) => item.rect);
  const addProp = (key: SceneryModelKey, x: number, z: number, rotationY: number, id: string): void => {
    const spec = SCENERY_MODELS[key];
    const box = propFootprint({ x, z, rotationY, collider: spec.collider });
    for (const solid of solidRects) {
      if (overlaps(box, solid)) {
        skip.push(`家具 ${id} 与实体重叠`);
        return;
      }
    }
    for (const item of businessRects) {
      if (gap(box, item.rect) < SCENERY_RULES.furnitureToBusiness - EPS) {
        skip.push(`家具 ${id} 距业务建筑 ${item.id} 过近`);
        return;
      }
    }
    for (const item of reserveRects) {
      if (gap(box, item.rect) < SCENERY_RULES.clearToReserve - EPS) {
        skip.push(`家具 ${id} 距储备地块 ${item.id} 过近`);
        return;
      }
    }
    props.push({ id, key, x, z, rotationY, collider: spec.collider });
  };
  template.benches.forEach((slot, index) => addProp('bench', slot.x, slot.z, slot.rotationY, `${template.id}-bench-${index + 1}`));
  template.lamps.forEach((slot, index) => addProp('street-lamp', slot.x, slot.z, slot.rotationY, `${template.id}-lamp-${index + 1}`));

  // 9) 树位：由空间推导，避让实体、家具、储备地块，并保证通道净宽
  const seed = hashSeed([template.id, template.version, BLOCK_RULES_VERSION]);
  const propRects = props.map((prop) => propFootprint(prop));
  const trees: PropPlacement[] = [];
  const drafts = placeTrees(template, seed, (box) => {
    // 墙面与楼体：树冠留 1.2 m，枝叶不插进立面
    for (const solid of solidRects) {
      if (gap(box, solid) < SCENERY_RULES.treeToWall - EPS) return true;
    }
    // 家具：只要求不压住物件本体，树冠可以遮在长椅上方
    for (const prop of propRects) {
      if (gap(box, prop) < SCENERY_RULES.treeToFurniture - EPS) return true;
    }
    for (const item of businessRects) {
      if (gap(box, item.rect) < SCENERY_RULES.treeToWall - EPS) return true;
    }
    for (const item of reserveRects) {
      if (gap(box, item.rect) < SCENERY_RULES.clearToReserve - EPS) return true;
    }
    return false;
  });
  const treeCollider = SCENERY_MODELS['street-tree'].collider;
  drafts.forEach((draft, index) => {
    trees.push({
      id: `${template.id}-tree-${index + 1}`,
      key: 'street-tree',
      x: draft.x,
      z: draft.z,
      rotationY: (index * 1.7) % (Math.PI * 2),
      collider: treeCollider,
    });
  });

  // 10) 汇总碰撞盒
  const colliders: BlockCollider[] = [
    ...decor.map((item) => ({
      owner: 'decor' as const,
      id: item.id,
      rect: item.footprint,
      minY: 0,
      maxY: item.size.height,
    })),
    ...walls.map((item) => ({
      owner: 'wall' as const,
      id: item.id,
      rect: item.rect,
      minY: 0,
      maxY: item.height,
    })),
    ...[...props, ...trees].map((item) => ({
      owner: 'prop' as const,
      id: item.id,
      // 旋转后的世界跨度：与避让判定、画面上的家具朝向一致
      rect: propFootprint(item),
      minY: 0,
      maxY: item.collider.height,
    })),
  ];

  // 11) 步行域：街区自带 + 街道带（去重按矩形直接拼接，运行期只做成员判定）
  const walkable: Rect[] = [...template.walkable, ...streetWalkableOf(layout)];

  const key = [
    template.id,
    template.version,
    BLOCK_RULES_VERSION,
    ...decor.map((item) =>
      [item.id, item.styleId, item.size.width, item.size.depth, item.size.height, item.position.x, item.position.z, item.rotationY, item.blindFaces.join('+')].join(':'),
    ),
    ...paving.map((item) => [item.id, item.rect.x0, item.rect.z0, item.rect.x1, item.rect.z1, item.surface].join(':')),
    ...walls.map((item) => [item.id, item.rect.x0, item.rect.z0, item.rect.x1, item.rect.z1, item.height, item.kind].join(':')),
    ...props.map((item) => [item.id, item.x, item.z, item.rotationY].join(':')),
    ...trees.map((item) => [item.id, item.x, item.z].join(':')),
  ].join('|');

  return {
    id: template.id,
    templateId: template.id,
    templateVersion: template.version,
    key,
    decor,
    paving,
    walls,
    props,
    trees,
    colliders,
    walkable,
    skip,
    // 手写试点是绝对坐标的单一街墙，没有围合端口
    portals: [],
    perimeter: false,
  };
}

/* ---------------------------------------------------------------- 对外入口 */

/**
 * 规划全城街区。
 *
 * 只处理 `BLOCK_TEMPLATES` 里声明过的模板；模板被跳过时不产出任何几何与碰撞，
 * 因此不会出现"半截街区"或看不见的碰撞。
 */
export interface PlanOptions {
  /** 手写试点（东岗街坊）：默认保留，验收基线。 */
  readonly includePilot?: boolean;
  /** 全城推广：按站点生成街区。 */
  readonly includeGenerated?: boolean;
}

/** 手写模板的完整外框：用于让站点规划避开它。 */
function templateBounds(template: BlockTemplate): Rect {
  const rects: Rect[] = [
    ...template.buildings.map((item) => item.footprint),
    ...template.paving.map((item) => item.rect),
    ...template.walls.map((item) => item.rect),
  ];
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const rect of rects) {
    x0 = Math.min(x0, rect.x0);
    x1 = Math.max(x1, rect.x1);
    z0 = Math.min(z0, rect.z0);
    z1 = Math.max(z1, rect.z1);
  }
  return { x0, x1, z0, z1 };
}

/** 站点附近、符合族偏好的业务建筑（只做标注，不创建任何业务）。 */
function nearestAnchor(
  site: { rect: Rect; districtId: string },
  family: BlockFamilyDef,
  businessRects: readonly { id: string; kind: string; rect: Rect }[],
): string | null {
  let best: { id: string; distance: number } | null = null;
  for (const item of businessRects) {
    if (!family.preferNearKinds.includes(item.kind as never)) continue;
    const distance = gap(site.rect, item.rect);
    if (distance > 45) continue;
    if (!best || distance < best.distance) best = { id: item.id, distance };
  }
  return best ? best.id : null;
}

export function planCityBlocks(layout: CityLayoutView, options: PlanOptions = {}): CityBlocksResult {
  const includePilot = options.includePilot !== false;
  const includeGenerated = options.includeGenerated !== false;

  const businessRects = layout.buildings.map((building) => ({
    id: building.id,
    kind: building.kind,
    rect: rectOfCollider(building),
  }));
  const reserveRects = RESERVE_LAND_PARCELS.map((parcel) => ({
    id: parcel.id,
    rect: {
      x0: parcel.center.x - parcel.size.width / 2,
      x1: parcel.center.x + parcel.size.width / 2,
      z0: parcel.center.z - parcel.size.depth / 2,
      z1: parcel.center.z + parcel.size.depth / 2,
    },
    required: true,
  }));

  const blocks: BlockPlan[] = [];
  const skipped: { id: string; reasons: readonly string[] }[] = [];

  // 1) 手写试点（绝对坐标，已验收）
  const occupied: Rect[] = [];
  for (const template of BLOCK_TEMPLATES) {
    if (!includePilot) {
      occupied.push(templateBounds(template));
      continue;
    }
    const plan = planOne(template, layout, businessRects, reserveRects);
    if (plan.skip.length > 0) {
      skipped.push({ id: template.id, reasons: plan.skip });
      occupied.push(templateBounds(template));
      continue;
    }
    blocks.push({ ...plan, districtId: template.districtId });
    occupied.push(templateBounds(template));
  }

  // 2) 全城推广：按真实布局枚举站点，逐站生成
  if (includeGenerated) {
    const districtTemplate = new Map(layout.districts.map((item) => [item.id, item.templateId]));
    const sitePlan = planSites(layout, occupied);
    for (const item of sitePlan.skipped) skipped.push(item);

    let index = 0;
    for (const site of sitePlan.sites) {
      const templateId = districtTemplate.get(site.districtId) ?? 'district-base';
      const familyId = defaultFamilyForDistrict(templateId, index);
      const family = blockFamilyById(familyId, 1);
      if (!family) {
        skipped.push({ id: site.id, reasons: [`街区族 ${familyId}@1 未定义`] });
        index += 1;
        continue;
      }
      const anchor = nearestAnchor(site, family, businessRects);
      const plan = generateBlock({
        blockId: site.id,
        familyId,
        templateVersion: family.version,
        rect: site.rect,
        front: site.front,
        districtId: site.districtId,
        anchorIds: anchor ? [anchor] : [],
      });
      if (plan.skip.length > 0) {
        skipped.push({ id: site.id, reasons: plan.skip });
      } else {
        blocks.push(plan);
      }
      index += 1;
    }
  }

  return { blocks, streetWalkable: streetWalkableOf(layout), skipped };
}
