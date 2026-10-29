/**
 * 街区规划数据 —— 纯数据 + 纯类型，不 import Three.js / DOM，不写任何游戏状态。
 *
 * 本轮只有**一个**试点街区：基础城区东西主路北侧、证券中心以东的"东岗街坊"。
 * 它是"被锚点约束的实例"，不是三套标准方形模板（那属阶段 3）。
 *
 * 坐标一律世界坐标（米，x 向东、z 向北），与 `features/city-layout` 同口径。
 * 规划器 `world/blocks/plan.ts` 只读本文件与只读布局，产出可渲染的 `BlockPlan`；
 * 任何几何都不得在规划器里内联，必须回到这里。
 */

import type { BuildingKind } from './config';
import type { BuildingStyleId } from './building-visuals';

/* ------------------------------------------------------------------ 基础类型 */

export interface BlockRect {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
}

/** 楼体正面朝向：决定 `rotationY`，与 `layout-adapter` 的入口轴约定一致。 */
export type DecorFront = 'north' | 'south' | 'east' | 'west';

/**
 * 闭窗面，**按局部朝向**：front = 局部 +Z、back = −Z、right = +X、left = −X。
 * 与 `world/buildings/facade.ts` 的 `facesOf` 同名字面同义。
 */
export type BlindFace = 'front' | 'back' | 'right' | 'left';

/* ------------------------------------------------------------------ 模板 */

export interface DecorBuildingSpec {
  /** 稳定 id 后缀：实例 id = `${blockId}-${id}`。 */
  readonly id: string;
  readonly styleId: BuildingStyleId;
  /**
   * 工厂输入（局部宽 / 深 / 高）。**世界占地与它是两回事**：
   * 北/南向时世界 X = 局部 width、世界 Z = 局部 depth；
   * 东/西向时交换。因此 `footprint` 必须与 `local` 一致，规划器会交叉校验。
   */
  readonly local: { readonly width: number; readonly depth: number; readonly height: number };
  /** 声明包络（世界坐标）。共墙时相邻两栋各含半个墙厚，包络允许重叠。 */
  readonly footprint: BlockRect;
  readonly front: DecorFront;
  readonly blindFaces: readonly BlindFace[];
  /** 供诊断与标签使用；不参与任何业务判断。 */
  readonly label: string;
}

export interface PavingSpec {
  readonly id: string;
  readonly rect: BlockRect;
  readonly surface: 'asphalt' | 'paving';
}

export interface WallSpec {
  readonly id: string;
  readonly rect: BlockRect;
  readonly height: number;
  readonly kind: 'wall' | 'hedge';
}

/** 树位生成区：按沿街长度与间距推导位置，不使用固定点表。 */
export interface TreeZone {
  readonly rect: BlockRect;
  readonly spacing: number;
  /** 只在该矩形内沿某条线布树（行道树）；留空表示按网格铺满（庭院）。 */
  readonly line?: 'x' | 'z';
}

export interface PropSlot {
  readonly x: number;
  readonly z: number;
  /** 绕 Y 的朝向（弧度）。0 表示模型原始朝向。 */
  readonly rotationY: number;
}

export interface BlockTemplate {
  readonly id: string;
  readonly version: number;
  readonly districtId: string;
  readonly name: string;
  readonly note: string;
  readonly buildings: readonly DecorBuildingSpec[];
  readonly paving: readonly PavingSpec[];
  readonly walls: readonly WallSpec[];
  readonly treeZones: readonly TreeZone[];
  readonly benches: readonly PropSlot[];
  readonly lamps: readonly PropSlot[];
  /** 必须避让的储备地块 id（来自 content/real-estate）。 */
  readonly reserveIds: readonly string[];
  /** 必须保持在院的既有业务建筑 id（只读，不修改）。 */
  readonly anchorIds: readonly string[];
  /** 街区自己的步行域（不含街道带；街道带由规划器按道路推导后并入）。 */
  readonly walkable: readonly BlockRect[];
  /** 庭院矩形（用于面积与净宽断言）。 */
  readonly courtyard: BlockRect;
  /** 沿街墙段（用于前宽断言）。 */
  readonly frontageRuns: readonly { readonly rect: BlockRect; readonly share: number }[];
}

/* ------------------------------------------------------------------ 规则版本 */

/**
 * 街区规则版本：进入种子，也进入指纹。
 *
 * 提升它会改变**旧档里装饰楼的布局与碰撞**（装饰不持久化），
 * 因此每次提升都必须在交付说明里列出"旧档可能出现的新障碍"。
 */
export const BLOCK_RULES_VERSION = 1;

/* ------------------------------------------------------------------ 东岗街坊 */

/**
 * 东岗街坊：东西主路北侧、证券中心以东。
 *
 * 关键几何（与 v2.1 补充件一致）：
 *  - 临街线 z = 16.0，与证券中心南立面共线；
 *  - 小巷 x 26.5–29.5 贴证券中心东立面，北通庭院；
 *  - W1 / W2 共墙于 x = 40.0：各自把 0.35 m 墙厚计入声明包络，包络在 40.0 处重叠 0.70 m；
 *  - 界墙 37.5–38.0 与储备地块（39.0 起）保持 1.0 m 面到面净距。
 */
const EAST_GATE: BlockTemplate = {
  id: 'block-base-east-gate',
  version: 1,
  districtId: 'district-base',
  name: '东岗街坊',
  note: '沿街三栋装饰楼 + 小巷 + 庭院；储备地块零覆盖；证券中心四面交互保持。',
  buildings: [
    {
      id: 'w1',
      styleId: 'residential-6',
      // 世界 X 10.85 / Z 12.0；南北向 → 局部 width 10.85、depth 12.0。
      local: { width: 10.85, depth: 12, height: 12.5 },
      footprint: { x0: 29.5, x1: 40.35, z0: 16, z1: 28 },
      front: 'south',
      // 世界 +X（东）面与 W2 共墙 → 局部 −X = left。
      blindFaces: ['left'],
      label: '东岗街坊 W1',
    },
    {
      id: 'w2',
      styleId: 'apartment-8',
      local: { width: 14.35, depth: 12, height: 16.5 },
      footprint: { x0: 39.65, x1: 54, z0: 16, z1: 28 },
      front: 'south',
      // 世界 −X（西）面与 W1 共墙 → 局部 +X = right。
      blindFaces: ['right'],
      label: '东岗街坊 W2',
    },
    {
      id: 't',
      styleId: 'apartment-8',
      local: { width: 11, depth: 10, height: 22 },
      footprint: { x0: 26.5, x1: 37.5, z0: 42, z1: 52 },
      front: 'south',
      blindFaces: [],
      label: '东岗街坊 T',
    },
  ],
  paving: [
    // 小巷：从人行道外沿（z 9.0）直通庭院，宽 3.0。
    { id: 'alley', rect: { x0: 26.5, x1: 29.5, z0: 9, z1: 42 }, surface: 'paving' },
    // 前场：人行道外沿到楼体墙面（最靠外的墙在 z 17.6/17.8，铺到 17.8 让墙面直接落地）。
    { id: 'forecourt', rect: { x0: 29.5, x1: 54, z0: 9, z1: 17.8 }, surface: 'paving' },
    // 庭院
    { id: 'courtyard', rect: { x0: 29.5, x1: 37.5, z0: 28, z1: 42 }, surface: 'paving' },
  ],
  walls: [
    { id: 'hedge-east', rect: { x0: 37.5, x1: 38, z0: 28, z1: 42 }, height: 1.2, kind: 'hedge' },
    { id: 'wall-west', rect: { x0: 26, x1: 26.5, z0: 26, z1: 52 }, height: 1.8, kind: 'wall' },
  ],
  treeZones: [
    // 行道树：前场中部，按间距沿 x 布。
    // 种植带 z 12–14：路灯在 z 10.4 一线上，树冠（深 2.0）与路灯留 1.43 m 净距；
    // 北侧的 W1/W2 立面在 z 16，树冠留 2.0 m。
    { rect: { x0: 30, x1: 53, z0: 12, z1: 14 }, spacing: 4.5, line: 'x' },
    // 庭院树：网格 + 种子抖动，避让墙面与通道。
    { rect: { x0: 30.4, x1: 36.6, z0: 29.4, z1: 40.6 }, spacing: 5.5 },
  ],
  benches: [
    { x: 37, z: 31, rotationY: -Math.PI / 2 },
    { x: 37, z: 35.5, rotationY: -Math.PI / 2 },
  ],
  lamps: [
    { x: 34, z: 10.4, rotationY: 0 },
    { x: 43, z: 10.4, rotationY: 0 },
    { x: 52, z: 10.4, rotationY: 0 },
    { x: 30.2, z: 39.6, rotationY: 0 },
  ],
  reserveIds: ['land-reserve-ne'],
  anchorIds: ['securities'],
  walkable: [
    { x0: 26.5, x1: 29.5, z0: 9, z1: 42 },
    { x0: 29.5, x1: 54, z0: 9, z1: 17.8 },
    { x0: 29.5, x1: 37.5, z0: 28, z1: 42 },
  ],
  courtyard: { x0: 29.5, x1: 37.5, z0: 28, z1: 42 },
  frontageRuns: [
    { rect: { x0: 29.5, x1: 40.35, z0: 16, z1: 28 }, share: 0.35 },
    { rect: { x0: 39.65, x1: 54, z0: 16, z1: 28 }, share: 0.35 },
  ],
};

export const BLOCK_TEMPLATES: readonly BlockTemplate[] = [EAST_GATE];

/** 按 id 取手写模板（试点）。生成模板见 `BLOCK_FAMILIES`。 */
export function blockTemplateById(id: string): BlockTemplate | null {
  return BLOCK_TEMPLATES.find((item) => item.id === id) ?? null;
}

/* ------------------------------------------------------------------ 街区族（参数化） */

/**
 * 街区族 —— 参数化的方形街区模板。
 *
 * 与上面的手写 `BlockTemplate` 并列存在，不互相替代：
 *  - 手写模板（东岗街坊）用绝对坐标，是已验收的试点；
 *  - 街区族只描述"怎么长"，由 `world/blocks/generate.ts` 按**实际可用矩形**实例化，
 *    因此同一份定义既能生成 45×45 完整模板，也能生成 60×110 条带里的裁剪变体。
 *
 * 所有数字都是米。版本号进入种子与指纹：改了参数就是新版本，旧版本按 id + 版本解析不到时
 * 会明确跳过并给出原因，不会"存了版本却读最新"。
 */
export type BlockFamilyId = 'residential-courtyard' | 'commercial-mixed' | 'tech-office';

export interface BlockFamilyDef {
  readonly id: BlockFamilyId;
  readonly version: number;
  readonly name: string;
  readonly note: string;
  /** 完整模板的标称边长（米）。实际生成时按可用矩形收缩。 */
  readonly nominalSize: number;
  /** 临街退线（米）：人行道外沿到建筑正面，做前场铺装。 */
  readonly setback: number;
  /** 沿街楼体进深（米）。可用进深不足时压缩，但不低于工厂下限 8。 */
  readonly buildingDepth: number;
  /** 沿街单元宽度序列（米），按索引循环使用。 */
  readonly unitWidths: readonly number[];
  /** 楼体高度范围（米）。 */
  readonly heightRange: readonly [number, number];
  /** 立面风格池，按单元索引轮换。 */
  readonly styles: readonly BuildingStyleId[];
  /** 巷道宽度（米）。 */
  readonly alleyWidth: number;
  /** 庭院最小进深（米）；不足时退化为 `row` 变体（无庭院、无巷道）。 */
  readonly courtyardMinDepth: number;
  readonly courtyard: {
    /** 是否在庭院远边做绿篱。 */
    readonly hedge: boolean;
    readonly benches: number;
    /** 庭院树间距（米）。 */
    readonly treeSpacing: number;
    /** 前场是否种行道树（需要足够退线，否则自动放弃）。 */
    readonly streetTrees: boolean;
  };
  /** 优先靠近的业务建筑类型（只影响站点排序与锚点标注，不创建任何业务）。 */
  readonly preferNearKinds: readonly BuildingKind[];
}

const RESIDENTIAL_COURTYARD: BlockFamilyDef = {
  id: 'residential-courtyard',
  version: 1,
  name: '住宅庭院街区',
  note: '外围住宅 / 公寓密排成街墙，内部是绿化庭院；靠巷口一栋做小型沿街铺面。',
  nominalSize: 45,
  setback: 5,
  buildingDepth: 12,
  unitWidths: [13, 11, 15, 12],
  heightRange: [12, 21],
  styles: ['residential-6', 'apartment-8', 'apartment-8', 'residential-6'],
  alleyWidth: 4,
  courtyardMinDepth: 7,
  courtyard: { hedge: true, benches: 2, treeSpacing: 5.5, streetTrees: true },
  preferNearKinds: ['home'],
};

const COMMERCIAL_MIXED: BlockFamilyDef = {
  id: 'commercial-mixed',
  version: 1,
  name: '商业混合街区',
  note: '沿街铺面 + 办公/公寓混合楼体，内部是小广场与座椅，不做绿篱。',
  nominalSize: 45,
  setback: 4,
  buildingDepth: 12,
  unitWidths: [10, 14, 9, 12],
  heightRange: [12, 24],
  styles: ['retail-3', 'office-10', 'retail-3', 'apartment-8'],
  alleyWidth: 4.5,
  courtyardMinDepth: 8,
  courtyard: { hedge: false, benches: 3, treeSpacing: 6, streetTrees: false },
  preferNearKinds: ['shop', 'office'],
};

const TECH_OFFICE: BlockFamilyDef = {
  id: 'tech-office',
  version: 1,
  name: '科技办公街区',
  note: '以办公楼为主、底层零售作街角，庭院是硬质办公广场；高度变化更明显。',
  nominalSize: 45,
  setback: 5,
  buildingDepth: 13,
  unitWidths: [15, 12, 10, 14],
  heightRange: [16, 30],
  styles: ['office-10', 'office-10', 'retail-3', 'office-10'],
  alleyWidth: 4.5,
  courtyardMinDepth: 9,
  courtyard: { hedge: false, benches: 2, treeSpacing: 6.5, streetTrees: true },
  preferNearKinds: ['office'],
};

export const BLOCK_FAMILIES: readonly BlockFamilyDef[] = [
  RESIDENTIAL_COURTYARD,
  COMMERCIAL_MIXED,
  TECH_OFFICE,
];

/**
 * 按 **id + 版本** 解析街区族。
 *
 * 版本不匹配返回 null：调用方必须把它当作"跳过并记录原因"，
 * 绝不能退回到"取最新版"，否则存档里记录的老版本会在读档时悄悄变形。
 */
export function blockFamilyById(id: string, version: number): BlockFamilyDef | null {
  const family = BLOCK_FAMILIES.find((item) => item.id === id);
  if (!family) return null;
  return family.version === version ? family : null;
}

/** 按城区模板推断默认街区族：科技 → C，商业 → B，住宅 → A，基础城区按位置轮换。 */
export function defaultFamilyForDistrict(templateId: string, index: number): BlockFamilyId {
  if (templateId === 'district-tech') return 'tech-office';
  if (templateId === 'district-commercial') return 'commercial-mixed';
  if (templateId === 'district-housing') return 'residential-courtyard';
  // 基础城区没有单一主题：按站点序号稳定轮换，形成混合街区
  const rotation: BlockFamilyId[] = ['commercial-mixed', 'residential-courtyard', 'tech-office'];
  return rotation[index % rotation.length];
}
