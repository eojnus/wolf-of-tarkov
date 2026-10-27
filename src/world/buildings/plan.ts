/**
 * 规划尺寸 → 可施工的视觉方案（Pure / 无 Three.js）。
 *
 * 输入：只读规划尺寸（宽 / 深 / 高）+ 稳定标识 + 风格。
 * 输出：主体退让、层数层高、开间、阳台与屋顶设备的**实际占位**，以及按这些占位
 *       推导出的确定性种子与材质键。
 *
 * 三条硬约束（对应验收 R1 / R2）：
 *  1. 宽、深、高是**真实输入**：层数、层高、开间、设备数量都由它推导，
 *     不按固定原型套一个模型，也不对整楼做非等比缩放；
 *  2. 装饰先占位再排布：主体从声明空间四边退让（frontInset / backInset / sideInset），
 *     阳台、雨棚、台阶、外挂楼梯才能落在声明空间内且不占道路或门前通道；
 *  3. 高度同样封闭：屋顶设备与女儿墙共用顶部预留（roofReserve），
 *     楼体顶面 = 声明高度 − 顶部预留，设备顶面不超过声明高度。
 */

import {
  defaultStyleFor,
  seedPartsFor,
  styleSpec,
  type BalconyPattern,
  type BuildingStyle,
  type BuildingStyleId,
  type RoofEquipmentKind,
} from '../../content/building-visuals';
import { hashSeed } from './random';

/** 规划输入：正式接入时直接由只读 `LayoutBuilding` 的 id / kind / size 传入。 */
export interface PlanInput {
  readonly buildingId: string;
  readonly kind: string;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly templateVersion: number;
  /** 显式指定风格；缺省按 `kind` 与高度选一个样例。 */
  readonly styleId?: BuildingStyleId;
}

export interface FacePlan {
  /** 开间数量（≥ 1）。 */
  readonly bays: number;
  /** 实际开间宽度 = length / bays。 */
  readonly bayWidth: number;
  readonly length: number;
}

export interface ResolvedRoofEquipment {
  readonly kind: RoofEquipmentKind;
  /** 设备在屋面以上的高度（可能被顶部预留压缩，0 表示没有设备）。 */
  readonly height: number;
  readonly width: number;
  readonly depth: number;
}

export interface ResolvedPlan {
  readonly style: BuildingStyle;
  readonly styleId: BuildingStyleId;
  readonly seed: number;
  /** 声明空间（只读规划尺寸），所有几何都必须落在其中。 */
  readonly envelope: { readonly width: number; readonly depth: number; readonly height: number };
  /** 主体：声明空间四边退让后的实体范围。 */
  readonly body: {
    readonly width: number;
    readonly depth: number;
    /** 主体中心在 z 轴的偏移（相对声明空间中心）。 */
    readonly centerZ: number;
    /** 正/背立面所在 z 坐标（局部坐标，中心为原点）。 */
    readonly frontZ: number;
    readonly backZ: number;
    /** 楼体顶面标高（女儿墙从该标高起算）。 */
    readonly wallTop: number;
  };
  readonly insets: { readonly front: number; readonly back: number; readonly side: number };
  readonly storeys: number;
  readonly groundHeight: number;
  readonly upperHeight: number;
  /** 每层楼面标高（长度 = storeys）。 */
  readonly floors: readonly number[];
  readonly facade: {
    readonly sillHeight: number;
    readonly headHeight: number;
    readonly pierWidth: number;
    readonly wallThickness: number;
    readonly glassInset: number;
    readonly frameWidth: number;
    readonly bandedFloors: boolean;
  };
  readonly faces: {
    readonly front: FacePlan;
    readonly back: FacePlan;
    readonly left: FacePlan;
    readonly right: FacePlan;
  };
  readonly balcony: {
    readonly enabled: boolean;
    readonly kind: 'metal-rail' | 'glass-parapet' | 'none';
    readonly depth: number;
    readonly parapetHeight: number;
    readonly bays: readonly number[];
    readonly floors: readonly number[];
  };
  readonly entrance: {
    readonly width: number;
    readonly height: number;
    readonly canopyDepth: number;
    readonly canopyHeight: number;
    readonly steps: number;
    readonly shopfront: boolean;
  };
  /** 女儿墙总高（含压顶）。`height` 是从 wallTop 起算的全部高度。 */
  readonly parapet: { readonly height: number; readonly thickness: number; readonly coping: number };
  /** 顶部预留 = max(女儿墙, 设备) ，保证顶部一切都在声明高度内。 */
  readonly roofReserve: number;
  readonly roofEquipment: ResolvedRoofEquipment;
  readonly utilityBoxes: number;
  readonly fireEscape: boolean;
  /** 材质缓存键：由真实材质参数（贴图 + 配色 + 亮度）派生，不用 preset id。 */
  readonly materialKey: string;
}

const LIMITS = {
  width: { min: 8, max: 80 },
  depth: { min: 8, max: 60 },
  height: { min: 6, max: 120 },
  /** 女儿墙总高（含压顶）的可施工区间。 */
  parapet: { min: 0.35, max: 2.0 },
  /** 压顶厚度：算在女儿墙总高之内，不再额外抬高顶部。 */
  coping: 0.12,
  bay: { min: 2.2, max: 6.5 },
  floor: { min: 2.4, max: 5.4 },
  /** 主体在任何一个方向上的最小可用尺寸，避免退让把楼吃光。 */
  bodyMin: 6,
} as const;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 输入超出可施工区间：明确拒绝并给出支持范围，不静默夹紧后假装成功。 */
export class PlanRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanRangeError';
  }
}

function requireRange(label: string, value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    throw new PlanRangeError(`[buildings] ${label} 不是有限数值：${String(value)}；支持 ${min}～${max} 米`);
  }
  if (value < min || value > max) {
    throw new PlanRangeError(`[buildings] ${label} = ${value} 米超出支持区间 ${min}～${max} 米`);
  }
  return value;
}

interface FloorLayout {
  readonly ok: boolean;
  readonly storeys: number;
  readonly groundHeight: number;
  readonly upperHeight: number;
}

/**
 * 在给定的楼体高度内排布楼层。
 *
 * `wallTop` 已经扣掉顶部预留（女儿墙含压顶、必要时还有屋顶设备），因此楼层总高
 * 必须恰好等于它 —— 楼层、女儿墙、设备用的是同一套标高，不存在「楼体算完再往上加装饰」。
 * 高度不够时**先减楼层**（允许单层），不会为了让至少两层成立而挤掉顶部空间。
 */
function layoutFloors(wallTop: number, targetGround: number, targetUpper: number): FloorLayout {
  const fail: FloorLayout = { ok: false, storeys: 0, groundHeight: 0, upperHeight: 0 };
  if (!Number.isFinite(wallTop) || wallTop < LIMITS.floor.min) return fail;

  let count = Math.max(1, Math.round(wallTop / targetUpper));
  count = Math.min(count, 60);
  while (count > 1 && wallTop / count < LIMITS.floor.min) count -= 1;

  const average = wallTop / count;
  if (average < LIMITS.floor.min - 1e-6) return fail;
  if (average > LIMITS.floor.max + 1e-6) return fail;
  if (count === 1) return { ok: true, storeys: 1, groundHeight: wallTop, upperHeight: wallTop };

  // 首层可以略高（门厅 / 商业），但上层不得低于最小层高
  const ground = Math.min(targetGround, average * 1.35, wallTop - LIMITS.floor.min * (count - 1));
  const upper = (wallTop - ground) / (count - 1);
  if (ground < LIMITS.floor.min - 1e-6 || upper < LIMITS.floor.min - 1e-6) return fail;
  return { ok: true, storeys: count, groundHeight: ground, upperHeight: upper };
}

/** 开间数量：按偏好宽度取整，再夹紧到可施工区间。 */
function bayCount(length: number, preferred: number): number {
  const target = clamp(preferred, LIMITS.bay.min, LIMITS.bay.max);
  let count = Math.max(2, Math.round(length / target));
  while (count > 2 && length / count < LIMITS.bay.min) count -= 1;
  while (count < 14 && length / count > LIMITS.bay.max) count += 1;
  return Math.min(14, Math.max(1, count));
}

function facePlan(length: number, preferred: number): FacePlan {
  const bays = bayCount(length, preferred);
  return { bays, bayWidth: length / bays, length };
}

/** 阳台开间选择：按实际开间数派生，不写死"第 0、2 跨"。 */
function balconyBays(pattern: BalconyPattern, bays: number): number[] {
  if (bays <= 0) return [];
  const all = Array.from({ length: bays }, (_, index) => index);
  switch (pattern) {
    case 'none':
      return [];
    case 'every-other':
      return all.filter((index) => index % 2 === 0);
    case 'ends':
      return bays >= 3 ? [0, bays - 1] : [0];
    case 'middle':
      if (bays >= 4) {
        const middle = Math.floor(bays / 2);
        return [middle - 1, middle];
      }
      return bays >= 2 ? [Math.floor((bays - 1) / 2)] : [];
    default:
      return [];
  }
}

/**
 * 解析一栋楼的视觉方案。
 *
 * 全部计算是纯函数：同样的输入永远得到同样的输出（种子来自建筑 id + 模板版本 + 规则版本）。
 */
export function resolveBuildingPlan(input: PlanInput): ResolvedPlan {
  const styleId = input.styleId ?? defaultStyleFor(input.kind, input.height);
  const style = styleSpec(styleId);

  const width = requireRange('建筑宽度', input.width, LIMITS.width.min, LIMITS.width.max);
  const depth = requireRange('建筑进深', input.depth, LIMITS.depth.min, LIMITS.depth.max);
  const height = requireRange('建筑高度', input.height, LIMITS.height.min, LIMITS.height.max);

  // 1) 主体退让：装饰先占位，主体在剩余范围内排布
  // 最小退让：基座/压顶会向外挑出 0.05～0.08 米，退让必须先把这部分吃掉
  const MIN_INSET = 0.15;
  let side = Math.min(Math.max(style.footprint.sideInset, MIN_INSET), (width - LIMITS.bodyMin) / 2);
  side = Math.max(MIN_INSET, side);
  let front = Math.min(Math.max(style.footprint.frontInset, MIN_INSET), (depth - LIMITS.bodyMin) * 0.6);
  front = Math.max(MIN_INSET, front);
  let back = Math.min(Math.max(style.footprint.backInset, MIN_INSET), (depth - LIMITS.bodyMin) * 0.4);
  back = Math.max(MIN_INSET, back);
  if (front + back > depth - LIMITS.bodyMin) {
    const overflow = front + back - (depth - LIMITS.bodyMin);
    const shrink = Math.min(front - MIN_INSET, overflow);
    front -= shrink;
    back = Math.max(0, back - (overflow - shrink));
  }

  const bodyWidth = width - side * 2;
  const bodyDepth = depth - front - back;
  const centerZ = (back - front) / 2;
  const frontZ = centerZ + bodyDepth / 2;
  const backZ = centerZ - bodyDepth / 2;

  /*
   * 2) 顶部预留与楼层共用同一套标高。
   *
   * 顶部预留 = 实际女儿墙总高（压顶算在女儿墙总高之内）与屋顶设备高度取大；
   * 楼体顶面 wallTop = 声明高度 − 顶部预留。楼层总高恰好等于 wallTop，
   * 因此「女儿墙顶 = wallTop + 女儿墙 = 声明高度」而不是再加一层压顶。
   *
   * 低楼空间不足时按以下顺序降级（不抬高声明高度、不放宽包络）：
   *   ① 保留设备但层数变少 → 改为不带设备（层数优先）
   *   ② 仍放不下 → 把女儿墙压到最小可施工高度
   *   ③ 仍然放不下 → 明确拒绝并给出支持区间
   */
  const groundTarget = clamp(style.floorHeights.ground, LIMITS.floor.min, LIMITS.floor.max);
  const upperTarget = clamp(style.floorHeights.upper, LIMITS.floor.min, LIMITS.floor.max);
  let parapetHeight = clamp(style.roof.parapetHeight, LIMITS.parapet.min, LIMITS.parapet.max);
  const coping = Math.min(LIMITS.coping, parapetHeight * 0.4);
  const equipmentTarget = style.roof.equipment === 'none' ? 0 : Math.max(0, style.roof.equipmentHeight);

  const layoutWithEquipment = layoutFloors(
    height - Math.max(parapetHeight, equipmentTarget),
    groundTarget,
    upperTarget,
  );
  const layoutBare = layoutFloors(height - parapetHeight, groundTarget, upperTarget);

  let reserve = parapetHeight;
  let layout = layoutBare;
  let keepEquipment = false;
  if (equipmentTarget > 0 && layoutWithEquipment.ok && (!layoutBare.ok || layoutWithEquipment.storeys >= layoutBare.storeys)) {
    reserve = Math.max(parapetHeight, equipmentTarget);
    layout = layoutWithEquipment;
    keepEquipment = true;
  }

  if (!layout.ok) {
    const minimalParapet = LIMITS.parapet.min;
    const layoutTight = layoutFloors(height - minimalParapet, groundTarget, upperTarget);
    if (!layoutTight.ok) {
      throw new PlanRangeError(
        `[buildings] 高度 ${height} 米放不下「至少 1 层 + 女儿墙」：` +
          `支持高度 ${LIMITS.height.min}～${LIMITS.height.max} 米，` +
          `最低需要 ${(LIMITS.floor.min + minimalParapet).toFixed(2)} 米`,
      );
    }
    parapetHeight = minimalParapet;
    reserve = minimalParapet;
    layout = layoutTight;
    keepEquipment = false;
  }

  const roofReserve = reserve;
  const wallTop = height - roofReserve;
  const groundHeight = layout.groundHeight;
  const upperHeight = layout.upperHeight;
  const storeys = layout.storeys;
  const floors: number[] = [];
  for (let floor = 0; floor < storeys; floor += 1) {
    floors.push(floor === 0 ? 0 : groundHeight + (floor - 1) * layout.upperHeight);
  }

  // 4) 开间：正面/背面按主体宽度，两侧按主体进深
  const preferred = style.facade.preferredBayWidth;
  const faces = {
    front: facePlan(bodyWidth, preferred),
    back: facePlan(bodyWidth, preferred),
    left: facePlan(bodyDepth, preferred),
    right: facePlan(bodyDepth, preferred),
  };

  // 5) 立面比例：窗洞高度随层高夹紧，避免低层高时窗顶穿楼板
  const sillHeight = clamp(style.facade.sillHeight, 0.3, Math.max(0.35, upperHeight * 0.4));
  const headHeight = clamp(
    style.facade.headHeight,
    sillHeight + Math.min(0.9, upperHeight * 0.35),
    Math.max(sillHeight + 0.9, upperHeight - 0.45),
  );
  const facade = {
    sillHeight,
    headHeight,
    pierWidth: clamp(style.facade.pierWidth, 0.2, 1.6),
    wallThickness: clamp(style.facade.wallThickness, 0.2, 0.6),
    glassInset: clamp(style.facade.glassInset, 0.06, 0.3),
    frameWidth: clamp(style.facade.frameWidth, 0.04, 0.16),
    bandedFloors: style.facade.bandedFloors,
  };

  // 6) 阳台：深度不得超出前立面预留，开间按实际开间数派生
  const balconyDepth = Math.min(style.balcony.depth, front - 0.12);
  const balconyEnabled =
    style.balcony.kind !== 'none' && balconyDepth >= 0.8 && bodyWidth >= 6 && storeys >= 2;
  const balconyFloors: number[] = [];
  if (balconyEnabled) {
    for (let floor = Math.max(1, style.balcony.firstFloor); floor < storeys; floor += 1) {
      if (style.balcony.alternateFloors && (floor - style.balcony.firstFloor) % 2 !== 0) continue;
      balconyFloors.push(floor);
    }
  }
  const balcony = {
    enabled: balconyEnabled && balconyFloors.length > 0,
    kind: style.balcony.kind,
    depth: balconyDepth,
    parapetHeight: clamp(style.balcony.parapetHeight, 0.9, 1.3),
    bays: balconyEnabled ? balconyBays(style.balcony.pattern, faces.front.bays) : [],
    floors: balconyFloors,
  };

  // 7) 入口：宽度/高度/雨棚/台阶全部夹到地面层与前立面预留以内
  const entranceWidth = clamp(style.entrance.width, 1.6, Math.max(1.6, bodyWidth * 0.4));
  const entranceHeight = clamp(style.entrance.height, 2.0, Math.max(2.0, groundHeight - 0.4));
  const canopyDepth = clamp(style.entrance.canopyDepth, 0.6, Math.max(0.6, front - 0.15));
  const canopyHeight = clamp(
    style.entrance.canopyHeight,
    entranceHeight + 0.15,
    Math.max(entranceHeight + 0.15, groundHeight - 0.2),
  );
  const stepDepth = 0.34;
  const steps = clamp(Math.floor((front - 0.45) / stepDepth), 0, style.entrance.maxSteps);
  const entrance = {
    width: entranceWidth,
    height: entranceHeight,
    canopyDepth,
    canopyHeight,
    steps,
    shopfront: style.entrance.shopfront,
  };

  // 8) 屋顶设备：设备从楼体顶面（wallTop）起算，顶面不得超过 wallTop + roofReserve = 声明高度
  const equipmentRoom = roofReserve;
  let roofEquipment: ResolvedRoofEquipment = { kind: 'none', height: 0, width: 0, depth: 0 };
  if (keepEquipment && equipmentRoom >= 0.8) {
    const equipmentWidth = Math.min(style.roof.equipmentWidth, bodyWidth * 0.5);
    const equipmentDepth = Math.min(style.roof.equipmentDepth, bodyDepth * 0.5);
    roofEquipment = {
      kind: style.roof.equipment,
      height: Math.min(equipmentTarget, equipmentRoom),
      width: Math.max(1.4, equipmentWidth),
      depth: Math.max(1.4, equipmentDepth),
    };
  }

  // 9) 屋顶室外机：设备高 1.12 米，屋顶余高不足时不摆（避免顶面越界）
  const utilityBoxes =
    equipmentRoom >= 1.25 && bodyWidth > 8
      ? clamp(Math.floor(bodyWidth / 6), 0, style.roof.maxUtilityBoxes)
      : 0;

  // 10) 外挂楼梯：只在背面预留足够、主体够宽、楼层够多时才做
  const fireEscape = style.fireEscape && back >= 1.5 && bodyWidth >= 10 && storeys >= 5;

  const materialKey = [
    style.textures.wall,
    style.textures.accent ?? '-',
    style.palette.wallTint.toString(16),
    style.palette.trimTint.toString(16),
    style.palette.accentTint.toString(16),
    style.palette.glassTint.toString(16),
    style.palette.frameTint.toString(16),
    style.palette.brightness.toFixed(2),
  ].join('|');

  return {
    style,
    styleId,
    seed: hashSeed(seedPartsFor(input.buildingId, input.templateVersion)),
    envelope: { width, depth, height },
    body: { width: bodyWidth, depth: bodyDepth, centerZ, frontZ, backZ, wallTop },
    insets: { front, back, side },
    storeys,
    groundHeight,
    upperHeight,
    floors,
    facade,
    faces,
    balcony,
    entrance,
    parapet: {
      height: parapetHeight,
      thickness: clamp(style.roof.parapetThickness, 0.2, 0.6),
      coping,
    },
    roofReserve,
    roofEquipment,
    utilityBoxes,
    fireEscape,
    materialKey,
  };
}
