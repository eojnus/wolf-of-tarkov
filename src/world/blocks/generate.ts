/**
 * 参数化街区生成器 —— 纯函数，不 import Three.js，不写状态。
 *
 * 两条**明确分开**的生成路径：
 *  - `generateBlock()`：受限空间变体（`clipped` / `row`）。一面临街，后面能挤多少算多少。
 *    服务全城推广里那些被业务建筑、路口、储备地块切出来的真实地块。
 *  - `generatePerimeterBlock()`：完整方形围合模板（`full`）。四面成街墙、四角各分配一次、
 *    内部庭院、四条巷道与四个对外的**端口**。只有结构真的围合才标记 `full`。
 *
 * 两条路径共用同一套：单元切分、共墙处理、铺装、家具、树、碰撞、指纹。
 * 三套模板（住宅庭院 / 商业混合 / 科技办公）的差别全部来自 `BlockFamilyDef` 参数。
 *
 * 共墙：**按声明包络的真实接触判定**（不是按数组前后）。接触的两栋各自把"朝向对方那一面"
 * 的立面退让量算进自己的包络，主体外表面就在原分界面上贴合——试点 W1/W2 用的就是这个办法。
 * 隔着巷道的两栋不算共墙。
 */

import {
  BLOCK_RULES_VERSION,
  blockFamilyById,
  type BlockFamilyDef,
  type DecorFront,
} from '../../content/city-blocks';
import { BUILDING_STYLES, type BuildingStyleId } from '../../content/building-visuals';
import { SCENERY_MODELS, SCENERY_RULES } from '../../content/city-scenery';
import { hashSeed, mulberry32 } from '../buildings/random';
import {
  gap,
  localFaceOfWorldSide,
  overlaps,
  propFootprint,
  rectDepth,
  rectWidth,
  rotationForFront,
  type Rect,
} from './rect';
import type {
  BlockCollider,
  BlockCoverage,
  BlockPlan,
  BlockPortal,
  BlockVariant,
  DecorPlacement,
  PavingPlacement,
  PropPlacement,
  WallPlacement,
} from './types';

/** 工厂下限：低于它 `resolveBuildingPlan` 会抛错，生成器必须提前放弃。 */
const FACTORY_MIN = 8;
/** 相邻楼体之间留的"实体缝"下限：小于它就必须贴合（共墙），见 SCENERY_RULES。 */
const MIN_GAP = SCENERY_RULES.minGapBetweenSolids;

export interface BlockRequest {
  /** 稳定块 id：站点 id 或预览用的固定 id。 */
  readonly blockId: string;
  readonly familyId: string;
  /** 必须与族定义一致；不一致时明确跳过，不回落到最新版。 */
  readonly templateVersion: number;
  readonly rect: Rect;
  readonly front: DecorFront;
  readonly districtId: string;
  /** 就近的业务建筑（只作诊断与"功能槽位"标注，不创建任何业务）。 */
  readonly anchorIds?: readonly string[];
  /** 标称边长：用于区分完整模板与裁剪变体。 */
  readonly nominalSize?: number;
}

/** 临街坐标系：u 沿街、v 由临街边向内。 */
interface Frame {
  readonly alongX: boolean;
  toRect(u0: number, u1: number, v0: number, v1: number): Rect;
}

function frameOf(rect: Rect, front: DecorFront): Frame {
  switch (front) {
    case 'south':
      return {
        alongX: true,
        toRect: (u0, u1, v0, v1) => ({
          x0: rect.x0 + u0,
          x1: rect.x0 + u1,
          z0: rect.z0 + v0,
          z1: rect.z0 + v1,
        }),
      };
    case 'north':
      return {
        alongX: true,
        toRect: (u0, u1, v0, v1) => ({
          x0: rect.x0 + u0,
          x1: rect.x0 + u1,
          z0: rect.z1 - v1,
          z1: rect.z1 - v0,
        }),
      };
    case 'west':
      return {
        alongX: false,
        toRect: (u0, u1, v0, v1) => ({
          x0: rect.x0 + v0,
          x1: rect.x0 + v1,
          z0: rect.z0 + u0,
          z1: rect.z0 + u1,
        }),
      };
    default:
      return {
        alongX: false,
        toRect: (u0, u1, v0, v1) => ({
          x0: rect.x1 - v1,
          x1: rect.x1 - v0,
          z0: rect.z0 + u0,
          z1: rect.z0 + u1,
        }),
      };
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function rectCenterOf(rect: Rect): { x: number; z: number } {
  return { x: (rect.x0 + rect.x1) / 2, z: (rect.z0 + rect.z1) / 2 };
}

/* ---------------------------------------------------------------- 单元切分 */

/**
 * 前宽切成单元：先按"每单元约 11 m"定数量，再按 1.2 m 的节奏交错宽窄，
 * 最后把误差并进最后一格；每格不低于工厂下限 8 m。
 */
function unitWidths(total: number): number[] {
  const usable = round2(total);
  if (usable < FACTORY_MIN) return [];
  let count = Math.max(1, Math.round(usable / 11));
  count = Math.min(count, Math.max(1, Math.floor(usable / FACTORY_MIN)));
  if (count === 1) return [usable];

  const base = usable / count;
  const widths: number[] = [];
  let remaining = usable;
  for (let i = 0; i < count; i += 1) {
    if (i === count - 1) {
      widths.push(round2(remaining));
      break;
    }
    // base < 10 时等分（没有余量可交错），否则按 ±1.2 m 交错出街墙节奏
    const width = round2(base < 10 ? base : base + (i % 2 === 0 ? 1.2 : -1.2));
    widths.push(width);
    remaining = round2(remaining - width);
  }
  return widths.filter((width) => width >= FACTORY_MIN - 1e-6);
}

/* ---------------------------------------------------------------- 共墙 */

/** 一栋楼的中间态：包络可变，最后再折算成工厂的局部尺寸与世界位置。 */
interface WorkingBuilding {
  readonly id: string;
  readonly styleId: BuildingStyleId;
  readonly front: DecorFront;
  readonly alongX: boolean;
  readonly height: number;
  readonly label: string;
  rect: Rect;
  readonly blindFaces: Set<'front' | 'back' | 'left' | 'right'>;
}

/** 该楼在某个**局部**立面上的退让量（工厂会把主体按这个值往里收）。 */
function insetOf(styleId: BuildingStyleId, face: 'front' | 'back' | 'left' | 'right'): number {
  const footprint = BUILDING_STYLES[styleId].footprint;
  if (face === 'front') return footprint.frontInset;
  if (face === 'back') return footprint.backInset;
  return footprint.sideInset;
}

const WORLD_SIDES = ['north', 'south', 'east', 'west'] as const;
type WorldSide = (typeof WORLD_SIDES)[number];

const OPPOSITE: Record<WorldSide, WorldSide> = {
  north: 'south',
  south: 'north',
  east: 'west',
  west: 'east',
};

function extendToward(building: WorkingBuilding, side: WorldSide, amount: number): void {
  if (amount <= 1e-6) return;
  if (side === 'east') building.rect = { ...building.rect, x1: building.rect.x1 + amount };
  else if (side === 'west') building.rect = { ...building.rect, x0: building.rect.x0 - amount };
  else if (side === 'north') building.rect = { ...building.rect, z1: building.rect.z1 + amount };
  else building.rect = { ...building.rect, z0: building.rect.z0 - amount };
}

/**
 * 共墙处理：找出**包络真正接触**的两栋楼，各自把朝向对方那一面的退让量算进包络，
 * 并把那一面标为闭窗。隔着巷道（有间距）的两栋不会被判成共墙。
 */
function applyPartyJoints(buildings: WorkingBuilding[]): void {
  /*
   * 两阶段：先在**未修改**的包络上把所有共墙关系找全，再统一施加扩展。
   *
   * 一阶段边找边改会出错：前面的配对把包络撑开之后，后面的配对就不再"恰好接触"，
   * 于是一部分接缝被漏掉，留下 0.7–1.9 m 的可见夹缝（实测就是这样漏的）。
   */
  interface Joint {
    readonly a: WorkingBuilding;
    readonly b: WorkingBuilding;
    readonly sideA: WorldSide;
    readonly sideB: WorldSide;
  }
  const joints: Joint[] = [];

  for (let i = 0; i < buildings.length; i += 1) {
    for (let j = i + 1; j < buildings.length; j += 1) {
      const a = buildings[i];
      const b = buildings[j];
      if (gap(a.rect, b.rect) > 1e-6) continue;
      for (const side of WORLD_SIDES) {
        const facing = OPPOSITE[side];
        const touches =
          side === 'east'
            ? Math.abs(a.rect.x1 - b.rect.x0) < 1e-6
            : side === 'west'
              ? Math.abs(a.rect.x0 - b.rect.x1) < 1e-6
              : side === 'north'
                ? Math.abs(a.rect.z1 - b.rect.z0) < 1e-6
                : Math.abs(a.rect.z0 - b.rect.z1) < 1e-6;
        if (!touches) continue;
        // 接触长度 > 0.5 m 才算共墙，只碰一个角不算
        const shareAlongX = Math.min(a.rect.x1, b.rect.x1) - Math.max(a.rect.x0, b.rect.x0);
        const shareAlongZ = Math.min(a.rect.z1, b.rect.z1) - Math.max(a.rect.z0, b.rect.z0);
        const share = side === 'east' || side === 'west' ? shareAlongZ : shareAlongX;
        if (share < 0.5) continue;
        joints.push({ a, b, sideA: side, sideB: facing });
        break;
      }
    }
  }

  /*
   * 同一栋楼在**同一条边**上可能同时贴着两栋邻居（转角处就是如此）。
   * 每个 (楼, 边) 只扩一次，取所需退让量的最大值——否则会被叠加两次，
   * 把主体顶过共墙线 0.35 m，转角处反而出现新的错台。
   */
  const needed = new Map<WorkingBuilding, Map<WorldSide, number>>();
  for (const joint of joints) {
    for (const [building, side] of [
      [joint.a, joint.sideA],
      [joint.b, joint.sideB],
    ] as const) {
      const amount = insetOf(building.styleId, localFaceOfWorldSide(side, building.front));
      let perSide = needed.get(building);
      if (!perSide) {
        perSide = new Map();
        needed.set(building, perSide);
      }
      perSide.set(side, Math.max(perSide.get(side) ?? 0, amount));
      building.blindFaces.add(localFaceOfWorldSide(side, building.front));
    }
  }
  for (const [building, perSide] of needed) {
    for (const [side, amount] of perSide) extendToward(building, side, amount);
  }

  /*
   * 转角补缝：垂直相交的两条建筑带，即便各自按自己的退让量扩展，
   * 主体在**另一个轴**上仍可能错开（实测办公族 1.03 m）。
   * 这里按主体实测间隙再补一次：谁离得近就让谁朝对方长出去，两边各一半，
   * 保证转角不留下能看见却走不进去的缺口。
   */
  for (let pass = 0; pass < 2; pass += 1) {
    let changed = false;
    const bodies = buildings.map((item) => bodyRectOf(item));
    for (let i = 0; i < buildings.length; i += 1) {
      for (let j = i + 1; j < buildings.length; j += 1) {
        if (gap(buildings[i].rect, buildings[j].rect) > 1e-6) continue;
        const a = bodies[i];
        const b = bodies[j];
        const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const overlapZ = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
        for (const axis of ['x', 'z'] as const) {
          const along = axis === 'x' ? overlapZ : overlapX;
          if (along < 0.3) continue;
          // 用中心判断谁在东/北，再取两者之间真正的空档
          const aMid = axis === 'x' ? (a.x0 + a.x1) / 2 : (a.z0 + a.z1) / 2;
          const bMid = axis === 'x' ? (b.x0 + b.x1) / 2 : (b.z0 + b.z1) / 2;
          const bIsMax = bMid >= aMid;
          const gapAlong = bIsMax
            ? Math.max(0, (axis === 'x' ? b.x0 - a.x1 : b.z0 - a.z1))
            : Math.max(0, (axis === 'x' ? a.x0 - b.x1 : a.z0 - b.z1));
          if (gapAlong < 0.02 || gapAlong > 2.5) continue;
          const half = gapAlong / 2;
          extendToward(buildings[i], oppositeOf(axis, bIsMax ? 'max' : 'min'), half);
          extendToward(buildings[j], oppositeOf(axis, bIsMax ? 'min' : 'max'), half);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

/** 该楼的主体矩形（声明包络按各立面退让量往里收）。 */
function bodyRectOf(building: WorkingBuilding): Rect {
  const r = building.rect;
  return {
    x0: r.x0 + insetOf(building.styleId, localFaceOfWorldSide('west', building.front)),
    x1: r.x1 - insetOf(building.styleId, localFaceOfWorldSide('east', building.front)),
    z0: r.z0 + insetOf(building.styleId, localFaceOfWorldSide('south', building.front)),
    z1: r.z1 - insetOf(building.styleId, localFaceOfWorldSide('north', building.front)),
  };
}

/** 轴 + 方向 → 世界方位。 */
function oppositeOf(axis: 'x' | 'z', toward: 'min' | 'max'): WorldSide {
  if (axis === 'x') return toward === 'max' ? 'east' : 'west';
  return toward === 'max' ? 'north' : 'south';
}

/** 中间态 → 工厂请求（局部宽深、世界位置、旋转、闭窗面）。 */
function toDecor(building: WorkingBuilding): DecorPlacement {
  const rect = building.rect;
  const width = building.alongX ? rectWidth(rect) : rectDepth(rect);
  const depth = building.alongX ? rectDepth(rect) : rectWidth(rect);
  return {
    id: building.id,
    styleId: building.styleId,
    size: { width: round2(width), depth: round2(depth), height: building.height },
    position: rectCenterOf(rect),
    rotationY: rotationForFront(building.front),
    blindFaces: [...building.blindFaces],
    footprint: rect,
    label: building.label,
  };
}

/* ---------------------------------------------------------------- 收尾 */

interface FinalizeInput {
  readonly request: BlockRequest;
  readonly family: BlockFamilyDef;
  readonly buildings: WorkingBuilding[];
  readonly paving: PavingPlacement[];
  readonly walls: WallPlacement[];
  /** 内部庭院（已铺装）：树与长椅在这里布。null 表示没有庭院。 */
  readonly courtyard: Rect | null;
  /** 沿街前场：路灯分布用。 */
  readonly forecourts: readonly Rect[];
  readonly walkable: readonly Rect[];
  readonly seed: number;
  readonly variant: BlockVariant;
  readonly kept: readonly string[];
  readonly portals?: readonly BlockPortal[];
  readonly perimeter?: boolean;
}

function finalize(input: FinalizeInput): BlockPlan {
  const { request, family, buildings, paving, walls, courtyard, forecourts, walkable, variant } = input;
  applyPartyJoints(buildings);
  const decor = buildings.map(toDecor);
  const random = mulberry32(input.seed);

  /* ------------------------------------------------------------ 家具 */

  const benchSpec = SCENERY_MODELS.bench;
  const lampSpec = SCENERY_MODELS['street-lamp'];
  const props: PropPlacement[] = [];

  const pushProp = (key: 'bench' | 'street-lamp', x: number, z: number, rot: number, id: string): boolean => {
    const spec = key === 'bench' ? benchSpec : lampSpec;
    const box = propFootprint({ x, z, rotationY: rot, collider: spec.collider });
    for (const item of decor) if (overlaps(box, item.footprint)) return false;
    for (const wall of walls) if (overlaps(box, wall.rect)) return false;
    for (const other of props) if (overlaps(box, propFootprint(other))) return false;
    props.push({ id, key, x, z, rotationY: rot, collider: spec.collider });
    return true;
  };

  if (courtyard) {
    const count = family.courtyard.benches;
    const inset = 1.4;
    for (let i = 0; i < count; i += 1) {
      const t = (i + 1) / (count + 1);
      const x = courtyard.x0 + rectWidth(courtyard) * t;
      const z = courtyard.z1 - inset;
      pushProp('bench', x, z, 0, `${request.blockId}-bench-${i + 1}`);
    }
  }

  for (const [index, forecourt] of forecourts.entries()) {
    const span = Math.max(rectWidth(forecourt), rectDepth(forecourt));
    if (span < 6) continue;
    const count = Math.max(1, Math.floor(span / 12));
    for (let i = 0; i < count; i += 1) {
      const t = (i + 0.5) / count;
      const x = forecourt.x0 + rectWidth(forecourt) * t;
      const z = forecourt.z0 + rectDepth(forecourt) * t;
      pushProp('street-lamp', x, z, 0, `${request.blockId}-lamp-${index + 1}-${i + 1}`);
    }
  }

  /* ------------------------------------------------------------ 树 */

  const treeSpec = SCENERY_MODELS['street-tree'];
  const crown = treeSpec.crown ?? { width: treeSpec.collider.width, depth: treeSpec.collider.depth };
  const crownHalfX = crown.width / 2;
  const crownHalfZ = crown.depth / 2;
  const trees: PropPlacement[] = [];
  const solidBoxes = [
    ...decor.map((item) => item.footprint),
    ...walls.map((item) => item.rect),
    ...props.map((item) => propFootprint(item)),
  ];

  const tryTree = (x: number, z: number, id: string): void => {
    const box: Rect = { x0: x - crownHalfX, x1: x + crownHalfX, z0: z - crownHalfZ, z1: z + crownHalfZ };
    for (const solid of solidBoxes) {
      if (gap(box, solid) < SCENERY_RULES.treeToWall - 1e-6) return;
    }
    for (const other of trees) {
      if (gap(box, propFootprint(other)) < SCENERY_RULES.treeToFurniture - 1e-6) return;
    }
    trees.push({
      id,
      key: 'street-tree',
      x,
      z,
      rotationY: (trees.length * 1.7) % (Math.PI * 2),
      collider: treeSpec.collider,
    });
  };

  if (courtyard) {
    // 树密度按面积定：每棵约 55 ㎡ 的树池，避免 45×28 的院子种成苗圃
    const area = rectWidth(courtyard) * rectDepth(courtyard);
    const spacing = Math.max(family.courtyard.treeSpacing, Math.sqrt(area / 7));
    // 可用种植核 = 庭院内缩"树冠半径 + 贴墙净距"，保证每棵都过得了树冠校验
    // 边距 = min(树冠半径 + 贴墙净距, 庭院短边 × 0.3)：浅院子按比例放宽，否则一棵树都种不下
    const spanZ = rectDepth(courtyard);
    const spanX = rectWidth(courtyard);
    const marginX = Math.min(crownHalfX + SCENERY_RULES.treeToWall, spanX * 0.3);
    const marginZ = Math.min(crownHalfZ + SCENERY_RULES.treeToWall, spanZ * 0.3);
    const uStart = courtyard.x0 + marginX;
    const uEnd = courtyard.x1 - marginX;
    const vStart = courtyard.z0 + marginZ;
    const vEnd = courtyard.z1 - marginZ;
    if (uEnd > uStart && vEnd > vStart) {
      const cols = Math.max(1, Math.floor((uEnd - uStart) / spacing) + 1);
      const rows = Math.max(1, Math.floor((vEnd - vStart) / spacing) + 1);
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const x = cols > 1 ? uStart + ((uEnd - uStart) * c) / (cols - 1) : (uStart + uEnd) / 2;
          const z = rows > 1 ? vStart + ((vEnd - vStart) * r) / (rows - 1) : (vStart + vEnd) / 2;
          const jitter = Math.min(0.6, spacing * 0.1);
          tryTree(
            x + (random() * 2 - 1) * jitter,
            z + (random() * 2 - 1) * jitter,
            `${request.blockId}-tree-${r * cols + c + 1}`,
          );
        }
      }
    }
  }

  /* ------------------------------------------------------------ 碰撞与输出 */

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
      rect: propFootprint(item),
      minY: 0,
      maxY: item.collider.height,
    })),
  ];

  const kept = [...input.kept];
  if (courtyard) kept.push(`内部庭院 ${rectWidth(courtyard).toFixed(0)}×${rectDepth(courtyard).toFixed(0)} m`);
  if (trees.length > 0) kept.push(`树 ${trees.length} 棵`);
  if (props.length > 0) kept.push(`家具 ${props.length} 件`);
  if (input.portals && input.portals.length > 0) kept.push(`对外端口 ${input.portals.length} 个`);

  const coverage: BlockCoverage = {
    frontage: round2(rectWidth(request.rect)),
    depth: round2(rectDepth(request.rect)),
    streetBuildings: decor.length,
    courtyard: courtyard !== null,
    alley: paving.some((item) => item.id.includes('-alley')),
    kept,
    perimeter: input.perimeter === true,
    portals: input.portals?.length ?? 0,
  };

  const key = [
    request.blockId,
    family.id,
    family.version,
    BLOCK_RULES_VERSION,
    request.front,
    request.rect.x0,
    request.rect.z0,
    request.rect.x1,
    request.rect.z1,
    variant,
    ...decor.map((item) =>
      [
        item.id,
        item.styleId,
        item.size.width,
        item.size.depth,
        item.size.height,
        item.position.x,
        item.position.z,
        item.blindFaces.join('+'),
      ].join(':'),
    ),
    ...paving.map((item) => [item.id, item.rect.x0, item.rect.z0, item.rect.x1, item.rect.z1, item.surface].join(':')),
    ...walls.map((item) => [item.id, item.rect.x0, item.rect.z0, item.rect.x1, item.rect.z1, item.kind].join(':')),
    ...props.map((item) => [item.id, item.x, item.z, item.rotationY].join(':')),
    ...trees.map((item) => [item.id, item.x, item.z].join(':')),
    ...(input.portals ?? []).map((item) => [item.id, item.center.x, item.center.z, item.width].join(':')),
  ].join('|');

  return {
    id: request.blockId,
    templateId: family.id,
    templateVersion: family.version,
    key,
    decor,
    paving,
    walls,
    props,
    trees,
    colliders,
    walkable: [...walkable],
    skip: [],
    variant,
    coverage,
    districtId: request.districtId,
    portals: input.portals ?? [],
    perimeter: input.perimeter === true,
  };
}

function skippedPlan(request: BlockRequest, skip: string[]): BlockPlan {
  return {
    id: request.blockId,
    templateId: request.familyId,
    templateVersion: request.templateVersion,
    key: `${request.blockId}|skip|${skip.join(';')}`,
    decor: [],
    paving: [],
    walls: [],
    props: [],
    trees: [],
    colliders: [],
    walkable: [],
    skip,
    districtId: request.districtId,
    portals: [],
    perimeter: false,
  };
}

/* ---------------------------------------------------------------- 受限空间变体 */

/**
 * 受限空间变体：一面临街，进深不够就退化成沿街排。
 * 服务全城推广里被真实障碍切出来的地块，**不**强求四面围合。
 */
export function generateBlock(request: BlockRequest): BlockPlan {
  const family = blockFamilyById(request.familyId, request.templateVersion);
  if (!family) {
    return skippedPlan(request, [`街区族 ${request.familyId}@${request.templateVersion} 不存在或版本不匹配`]);
  }

  const rect = request.rect;
  const frame = frameOf(rect, request.front);
  const frontage = frame.alongX ? rectWidth(rect) : rectDepth(rect);
  const depth = frame.alongX ? rectDepth(rect) : rectWidth(rect);
  if (frontage < FACTORY_MIN || depth < FACTORY_MIN) {
    return skippedPlan(request, [`可用矩形 ${frontage.toFixed(1)}×${depth.toFixed(1)} m 小于工厂下限`]);
  }

  /*
   * 退线与楼体进深的分配顺序：
   *  1. 先用族定义值；2. 放不下庭院时先把退线收到 3 m；
   *  3. 仍然放不下就压楼体进深，但不低于 9 m；4. 还是放不下才退化成 row。
   */
  const clippedCourtMin = 6;
  const minCourt = frontage >= 20 ? Math.min(family.courtyardMinDepth, clippedCourtMin) : Infinity;
  let setback = family.setback;
  let buildingDepth = family.buildingDepth;
  if (depth < setback + buildingDepth + minCourt) {
    setback = Math.min(setback, 3);
    buildingDepth = Math.min(buildingDepth, depth - setback - minCourt);
    if (buildingDepth < 9) buildingDepth = Math.max(FACTORY_MIN, depth - setback - 0.2);
  }
  buildingDepth = Math.min(buildingDepth, depth - setback - 0.2);
  if (buildingDepth < FACTORY_MIN) {
    return skippedPlan(request, [`进深 ${depth.toFixed(1)} m 扣掉退线后不足 ${FACTORY_MIN} m`]);
  }

  const courtyardDepth = round2(depth - setback - buildingDepth);
  const hasCourtyard = courtyardDepth >= minCourt - 1e-6 && Number.isFinite(minCourt);
  const alleyWidth = hasCourtyard ? family.alleyWidth : 0;

  const widths = unitWidths(frontage - alleyWidth);
  if (widths.length === 0) {
    return skippedPlan(request, [`前宽 ${frontage.toFixed(1)} m 放不下一个 ${FACTORY_MIN} m 单元`]);
  }

  const seed = hashSeed([family.id, family.version, BLOCK_RULES_VERSION, request.blockId]);
  const random = mulberry32(seed);
  const alleyIndex = hasCourtyard ? Math.floor(widths.length / 2) : -1;

  const buildings: WorkingBuilding[] = [];
  const rowEdges: { u0: number; u1: number }[] = [];
  let cursor = 0;
  widths.forEach((width, index) => {
    const u0 = cursor;
    const u1 = cursor + width;
    cursor = u1;
    rowEdges.push({ u0, u1 });
    if (index === alleyIndex) cursor += alleyWidth;

    const [minH, maxH] = family.heightRange;
    const bias = index % 2 === 0 ? 0.55 : 0.2;
    const height = round2(minH + (maxH - minH) * (bias + random() * (1 - bias)));
    buildings.push({
      id: `${request.blockId}-b${index + 1}`,
      styleId: family.styles[index % family.styles.length],
      front: request.front,
      alongX: frame.alongX,
      height,
      label: `${family.name} · ${index + 1}`,
      rect: frame.toRect(u0, u1, setback, setback + buildingDepth),
      blindFaces: new Set(),
    });
  });

  const apron = round2(setback + 2.5);
  const paving: PavingPlacement[] = [
    { id: `${request.blockId}-forecourt`, rect: frame.toRect(0, frontage, 0, apron), surface: 'paving' },
  ];
  const walls: WallPlacement[] = [];
  const walkable: Rect[] = [frame.toRect(0, frontage, 0, apron)];

  let courtyard: Rect | null = null;
  if (hasCourtyard) {
    const alleyU0 = rowEdges[alleyIndex].u1;
    const alley = frame.toRect(alleyU0, alleyU0 + alleyWidth, apron, setback + buildingDepth);
    paving.push({ id: `${request.blockId}-alley`, rect: alley, surface: 'paving' });
    courtyard = frame.toRect(0, frontage, setback + buildingDepth, depth);
    paving.push({ id: `${request.blockId}-courtyard`, rect: courtyard, surface: 'paving' });
    walkable.push(alley, courtyard);
    // 庭院够深才放收边绿带：6 m 深的院子再压 0.5 m 绿篱就没有种树的位置了
    if (courtyardDepth >= 8) {
      walls.push({
        id: `${request.blockId}-hedge`,
        rect: frame.toRect(0, frontage, depth - 0.6, depth - 0.1),
        height: family.courtyard.hedge ? 1.2 : 0.45,
        kind: 'hedge',
      });
    }
  }

  const kept = [`临街楼体 ${buildings.length} 栋`, `前场铺装 ${setback.toFixed(1)} m`];
  if (hasCourtyard) kept.push(`小巷 ${alleyWidth} m`);
  else kept.push('无庭院（进深不足，退化为沿街排布）');
  if (request.anchorIds && request.anchorIds.length > 0) kept.push(`锚点 ${request.anchorIds.join(',')}`);

  return finalize({
    request,
    family,
    buildings,
    paving,
    walls,
    courtyard,
    forecourts: [frame.toRect(0, frontage, 0, apron)],
    walkable,
    seed,
    variant: hasCourtyard ? 'clipped' : 'row',
    kept,
  });
}

/* ---------------------------------------------------------------- 完整围合模板 */

/** 东西两侧建筑带向南北带里搭接的长度（米），用来把转角做成实心重叠。 */
const CORNER_LAP = 1.5;

/** 一份"四边围合"的几何口径。所有数字都是米，且都会过一遍工厂下限校验。 */
export interface PerimeterSpec {
  /** 净用地边长（不含外围道路与人行道）。 */
  readonly size: number;
  /** 四侧建筑带进深。 */
  readonly bandDepth: number;
  /** 内部庭院边长 = size − 2 × bandDepth。 */
  readonly courtyardSize: number;
  /** 巷道宽度（每侧一条，居中，从街面通到庭院）。 */
  readonly alleyWidth: number;
}

/** 由族参数推导一份自洽的围合口径；任何一步掉到工厂下限以下就返回原因。 */
export function perimeterSpecOf(family: BlockFamilyDef, size = 45): { spec: PerimeterSpec; reasons: string[] } {
  const reasons: string[] = [];
  /*
   * 带深封顶 12：东西带夹在南北带之间，长度 = size − 2×带深。
   * 带深 13 时长度只剩 19 m，扣掉 4.5 m 巷道后每半段 7.25 m，排不下 8 m 的楼体。
   * 12 是"能围合、还能排下两栋楼、内部庭院仍有 21 m"的唯一交集。
   */
  const bandDepth = Math.min(family.buildingDepth, 12);
  const courtyardSize = round2(size - bandDepth * 2);
  const alleyWidth = Math.max(family.alleyWidth, 4);
  if (bandDepth < FACTORY_MIN) reasons.push(`建筑带进深 ${bandDepth} m 小于工厂下限 ${FACTORY_MIN} m`);
  if (courtyardSize < family.courtyardMinDepth) {
    reasons.push(`内部庭院 ${courtyardSize} m 小于族要求的 ${family.courtyardMinDepth} m`);
  }
  if (size - alleyWidth < FACTORY_MIN * 2) {
    reasons.push(`每侧可排前宽 ${(size - alleyWidth).toFixed(1)} m 不足两栋 ${FACTORY_MIN} m 楼体`);
  }
  return { spec: { size, bandDepth, courtyardSize, alleyWidth }, reasons };
}

const SIDE_OUTWARD: Record<WorldSide, { x: number; z: number }> = {
  north: { x: 0, z: 1 },
  south: { x: 0, z: -1 },
  east: { x: 1, z: 0 },
  west: { x: -1, z: 0 },
};

/**
 * 完整方形围合模板。
 *
 * 几何口径（默认 45×45 净用地，不含外围道路与人行道）：
 *  - 四侧各一条 12 m 深的建筑带，内部 21×21 m 庭院；
 *  - 每侧居中留 4.0–4.5 m 巷道，从街面直通庭院，形成**四个对外端口**；
 *  - 转角只分配一次：南北带横跨全长（含四个转角），东西带夹在两带之间，不与转角抢楼；
 *  - 相邻楼体的共墙由 `applyPartyJoints` 按真实接触处理。
 */
export function generatePerimeterBlock(request: BlockRequest): BlockPlan {
  const family = blockFamilyById(request.familyId, request.templateVersion);
  if (!family) {
    return skippedPlan(request, [`街区族 ${request.familyId}@${request.templateVersion} 不存在或版本不匹配`]);
  }

  const rect = request.rect;
  const size = round2(Math.min(rectWidth(rect), rectDepth(rect)));
  const { spec, reasons } = perimeterSpecOf(family, size);
  if (reasons.length > 0) return skippedPlan(request, reasons);

  const { bandDepth, courtyardSize, alleyWidth } = spec;
  const cx = (rect.x0 + rect.x1) / 2;
  const cz = (rect.z0 + rect.z1) / 2;
  const halfCourt = courtyardSize / 2;

  const seed = hashSeed([family.id, family.version, BLOCK_RULES_VERSION, request.blockId, 'perimeter']);
  const random = mulberry32(seed);
  const buildings: WorkingBuilding[] = [];
  const portals: BlockPortal[] = [];
  const paving: PavingPlacement[] = [];
  const walkable: Rect[] = [];

  const heightFor = (index: number): number => {
    const [minH, maxH] = family.heightRange;
    const bias = index % 2 === 0 ? 0.55 : 0.2;
    return round2(minH + (maxH - minH) * (bias + random() * (1 - bias)));
  };

  interface BandSpec {
    readonly side: WorldSide;
    readonly front: DecorFront;
    /** 沿该侧外墙的 u 轴范围（世界坐标）。 */
    readonly uStart: number;
    readonly uEnd: number;
    /** 建筑带由外到内的 world 区间。 */
    readonly vOuter: number;
    readonly vInner: number;
    readonly alongX: boolean;
  }

  /*
   * `front` 决定**风格轮换的起点**：四条边几何完全对称，转动 front 不改变包络，
   * 但会让不同朝向拿到不同的立面组合（同一份定义因此可以生成"转了 90°"的变体）。
   * 几何口径本身与朝向无关——围合模板四面都是街墙。
   */
  const rotationOffset = request.front === 'south' ? 0 : request.front === 'east' ? 1 : request.front === 'north' ? 2 : 3;
  const baseBands: BandSpec[] = [
    // 南北带横跨全长，四个转角各归其一
    { side: 'north', front: 'north', uStart: rect.x0, uEnd: rect.x1, vOuter: rect.z1, vInner: rect.z1 - bandDepth, alongX: true },
    { side: 'south', front: 'south', uStart: rect.x0, uEnd: rect.x1, vOuter: rect.z0, vInner: rect.z0 + bandDepth, alongX: true },
    /*
     * 东西带夹在南北带之间，不与转角抢楼；两端各向南北带里**搭接 1.5 m**。
     *
     * 转角是两栋垂直楼体的交汇：各自的立面退让量不同（正面 2.8 / 背面 1.7 / 侧面 0.35），
     * 只靠"各扩各的退让量"会在转角另一轴上错开 1 m 左右，形成看得见的缺口。
     * 让东西带直接搭进南北带 1.5 m，转角处两块实体天然重叠，缺口不存在。
     */
    {
      side: 'east',
      front: 'east',
      uStart: rect.z0 + bandDepth - CORNER_LAP,
      uEnd: rect.z1 - bandDepth + CORNER_LAP,
      vOuter: rect.x1,
      vInner: rect.x1 - bandDepth,
      alongX: false,
    },
    {
      side: 'west',
      front: 'west',
      uStart: rect.z0 + bandDepth - CORNER_LAP,
      uEnd: rect.z1 - bandDepth + CORNER_LAP,
      vOuter: rect.x0,
      vInner: rect.x0 + bandDepth,
      alongX: false,
    },
  ];
  const bandOrder = baseBands.map((_, i) => baseBands[(i + rotationOffset) % baseBands.length]);
  const bands = bandOrder;

  let index = 0;
  const counts: Record<WorldSide, number> = { north: 0, south: 0, east: 0, west: 0 };

  for (const [bandIndex, band] of bands.entries()) {
    const mid = (band.uStart + band.uEnd) / 2;
    const halves = [
      { u0: band.uStart, u1: mid - alleyWidth / 2 },
      { u0: mid + alleyWidth / 2, u1: band.uEnd },
    ];
    for (const segment of halves) {
      const widths = unitWidths(segment.u1 - segment.u0);
      if (widths.length === 0) {
        return skippedPlan(request, [
          `${band.side} 侧半段前宽 ${(segment.u1 - segment.u0).toFixed(1)} m 放不下 ${FACTORY_MIN} m 楼体`,
        ]);
      }
      let cursor = segment.u0;
      for (const width of widths) {
        const u0 = cursor;
        const u1 = cursor + width;
        cursor = u1;
        const low = Math.min(band.vOuter, band.vInner);
        const high = Math.max(band.vOuter, band.vInner);
        const footprint: Rect = band.alongX
          ? { x0: u0, x1: u1, z0: low, z1: high }
          : { x0: low, x1: high, z0: u0, z1: u1 };
        index += 1;
        counts[band.side] += 1;
        /*
         * 风格按「该侧在轮换顺序里的位次 + 本侧第几栋」分配，而不是按全局累计计数：
         * 全局计数在「4 栋 × 4 种风格」时会互相抵消，转 90° 看不出任何区别。
         */
        buildings.push({
          id: `${request.blockId}-${band.side}${counts[band.side]}`,
          styleId: family.styles[(bandIndex + counts[band.side] - 1) % family.styles.length],
          front: band.front,
          alongX: band.alongX,
          height: heightFor(index),
          label: `${family.name} · ${band.side}${counts[band.side]}`,
          rect: footprint,
          blindFaces: new Set(),
        });
      }
    }

    // 该侧巷道 + 对外端口（巷道口就是有意保留的开口）
    const alleyRect: Rect = band.alongX
      ? {
          x0: mid - alleyWidth / 2,
          x1: mid + alleyWidth / 2,
          z0: Math.min(band.vOuter, band.vInner),
          z1: Math.max(band.vOuter, band.vInner),
        }
      : {
          x0: Math.min(band.vOuter, band.vInner),
          x1: Math.max(band.vOuter, band.vInner),
          z0: mid - alleyWidth / 2,
          z1: mid + alleyWidth / 2,
        };
    const alleyId = `${request.blockId}-alley-${band.side}`;
    paving.push({ id: alleyId, rect: alleyRect, surface: 'paving' });
    walkable.push(alleyRect);
    portals.push({
      id: `${request.blockId}-portal-${band.side}`,
      side: band.side,
      center: band.alongX ? { x: mid, z: band.vOuter } : { x: band.vOuter, z: mid },
      width: round2(alleyWidth),
      outward: SIDE_OUTWARD[band.side],
      kind: 'alley',
      alleyId,
    });
  }

  if (counts.north === 0 || counts.south === 0 || counts.east === 0 || counts.west === 0) {
    return skippedPlan(request, ['四侧街墙未能全部成立，不标记为完整模板']);
  }

  const courtyard: Rect = {
    x0: cx - halfCourt,
    x1: cx + halfCourt,
    z0: cz - halfCourt,
    z1: cz + halfCourt,
  };
  paving.push({ id: `${request.blockId}-courtyard`, rect: courtyard, surface: 'paving' });
  walkable.push(courtyard);

  /*
   * 围合模板不做绿篱：庭院四边本来就是四侧楼体的外墙，
   * 再插一圈 0.5 m 的绿篱只会把 21×21 的院子挤成没法种树的窄环。
   */
  const walls: WallPlacement[] = [];

  const kept = [`四侧街墙 ${buildings.length} 栋`, `四条巷道 ${alleyWidth} m`];
  if (request.anchorIds && request.anchorIds.length > 0) kept.push(`锚点 ${request.anchorIds.join(',')}`);

  return finalize({
    request,
    family,
    buildings,
    paving,
    walls,
    courtyard,
    forecourts: [],
    walkable,
    seed,
    variant: 'full',
    kept,
    portals,
    perimeter: true,
  });
}

/** 出口自检：所有构件必须落在请求矩形内（供诊断与测试复用）。 */
export function blockInsideRect(plan: BlockPlan, rect: Rect): boolean {
  const inside = (item: Rect): boolean =>
    item.x0 >= rect.x0 - 1e-6 && item.x1 <= rect.x1 + 1e-6 && item.z0 >= rect.z0 - 1e-6 && item.z1 <= rect.z1 + 1e-6;
  return (
    plan.decor.every((item) => inside(item.footprint)) &&
    plan.paving.every((item) => inside(item.rect)) &&
    plan.walls.every((item) => inside(item.rect)) &&
    plan.trees.every((item) => inside(propFootprint(item))) &&
    plan.props.every((item) => inside(propFootprint(item)))
  );
}

export { MIN_GAP };
