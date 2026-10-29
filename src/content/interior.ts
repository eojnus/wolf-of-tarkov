/**
 * 晴川公寓首套室内 —— 尺寸、摆位、相机与资产清单。
 *
 * 只放数据，不建 Three.js 对象；表现层在 `world/interiors/qingchuan.ts` 读取本文件。
 * 房间坐标：X 向右（0–3.3m），Z 向南（0–6.2m，北入口、南窗），Y 向上。
 */

export type QuarterTurn = 0 | 1 | 2 | 3;

/** 家具网格：0.05 m，名称范围 66 × 124；可放整格范围对应墙面 [0.05, 3.25] / [0.05, 6.15]。 */
export const FURNITURE_CELL_SIZE = 0.05;
export const FURNITURE_RESIDENCE_ID = 'home-001';
export const FURNITURE_LAYOUT_VERSION = 1;
export const FURNITURE_GRID = {
  cellsX: 66,
  cellsZ: 124,
  minCellX: 1,
  maxCellX: 65,
  minCellZ: 1,
  maxCellZ: 123,
} as const;

/** 家具局部人物碰撞盒（米，相对实体可见 AABB 中心；未旋转）。 */
export interface FurnitureLocalBox {
  readonly width: number;
  readonly depth: number;
  readonly offsetX: number;
  readonly offsetZ: number;
  readonly minY: number;
  readonly maxY: number;
}

/**
 * 19 件固定家具定义。footprintWidth/Depth 是未旋转局部整数格；
 * 资产、安装高度、局部碰撞与初始种子只在这里定义。
 */
export interface FurnitureDefinition {
  readonly id: string;
  readonly name: string;
  readonly footprintWidth: number;
  readonly footprintDepth: number;
  readonly seed: {
    readonly cellX: number;
    readonly cellZ: number;
    readonly quarterTurn: QuarterTurn;
  };
  /** 可见高度（表现层测量值，米）。 */
  readonly visualHeight: number;
  /** 拖动射线使用的水平参考面高度（米）。 */
  readonly dragHeight: number;
  /** 四件外部模型的项目资产标识；程序化家具为空。 */
  readonly assetId?: string;
  /** 镜子等需要固定可见偏移的物件；不改变逻辑格。 */
  readonly visualOffsetZ?: number;
  /** 人物碰撞（也是相机遮挡）；地面装饰/高处悬挂物为空。 */
  readonly playerCollision: readonly FurnitureLocalBox[];
}

export interface InteriorFurnitureSpec {
  readonly assetId: string;
  readonly name: string;
  readonly url: string;
  /** 模型中心在房间中的位置（米）。 */
  readonly x: number;
  readonly z: number;
  /** 绕 Y 轴旋转（弧度）。 */
  readonly rotationY: number;
  /** 碰撞与相机遮挡使用的水平包围盒（米）。 */
  readonly footprint: { readonly width: number; readonly depth: number };
}

export const INTERIOR = {
  /** 室内固定关联的永久住所与建筑稳定 id；不做多套住宅注册表。 */
  residenceId: 'home-001',
  buildingId: 'home',
  name: '晴川公寓 · 个人住宅',

  room: {
    width: 3.3,
    depth: 6.2,
    height: 2.55,
    wall: 0.08,
    /** 卫浴与厨房功能带深度。 */
    serviceDepth: 2.4,
  },

  /** 室内人物碰撞半径：比室外略小，保证 1K 里 0.95m 净宽的通道可正常通过。 */
  player: { collisionRadius: 0.3 },

  /**
   * 入户落点：门内走廊南端，面向室内（+Z）。
   * 距北墙约 2.2m，第三人称相机不会被门口墙体压到遮挡距离；距离开触发圈中心约 1.5m，
   * 进入时不会立刻出现离开提示。
   */
  spawn: { x: 2.1, z: 2.2, facing: 0 },
  /** 门口 F 离开的触发范围（不在全屋任意位置退出）。 */
  exit: { x: 1.66, z: 0.72, radius: 0.62 },

  camera: {
    fov: 52,
    near: 0.05,
    far: 40,
    /** 室内近距第三人称。default/min 是滚轮可调范围，遮挡收缩另有硬下限。 */
    distance: { default: 2.8, min: 1.4, max: 4.2 },
    pitch: { default: 0.3, min: -0.08, max: 1.0 },
    sensitivity: 0.0026,
    followLambda: 16,
    distanceLambda: 12,
    zoomStep: 0.88,
    targetHeight: 1.25,
    minHeight: 0.3,
    /** 与遮挡面保留的间隙；室内比城市小，避免相机被过度推近。 */
    collisionPadding: 0.14,
    /** 遮挡收缩的硬下限，独立于滚轮 min。 */
    hardMinDistance: 0.35,
    /** 相机被墙压得比这更近时隐藏人物，避免头部占满画面（退出室外立即恢复）。 */
    characterMinDistance: 1.5,
    /** 进入时的环绕角：相机位于人物背后（-Z），人物面向 +Z。 */
    spawnYaw: Math.PI,
  },

  furniture: {
    bed: {
      assetId: 'polyhaven.old-bed-frame',
      name: '单人床',
      url: 'assets/models/interiors/qingchuan/old_bed_frame/old_bed_frame.gltf',
      x: 0.5075,
      z: 4.14,
      // 模型床头在 -Z（实测顶点）；不旋转，让床头靠北侧隔断、床尾朝南。
      rotationY: 0,
      footprint: { width: 0.905, depth: 2.0 },
    },
    sofa: {
      assetId: 'polyhaven.sofa-01',
      name: '紧凑沙发',
      url: 'assets/models/interiors/qingchuan/Sofa_01/Sofa_01.gltf',
      x: 2.42,
      z: 5.79,
      // 模型正面 +Z；旋转 180° 朝北面向起居区。
      rotationY: Math.PI,
      footprint: { width: 1.571, depth: 0.658 },
    },
    table: {
      assetId: 'polyhaven.wooden-table-02',
      name: '书桌',
      url: 'assets/models/interiors/qingchuan/wooden_table_02/wooden_table_02.gltf',
      x: 2.907,
      z: 3.35,
      rotationY: Math.PI / 2,
      footprint: { width: 0.706, depth: 1.134 },
    },
    chair: {
      assetId: 'polyhaven.dining-chair-02',
      name: '椅子',
      url: 'assets/models/interiors/qingchuan/dining_chair_02/dining_chair_02.gltf',
      x: 2.2,
      z: 3.35,
      // 模型正面 +Z；旋转 90° 面向东侧书桌。
      rotationY: Math.PI / 2,
      footprint: { width: 0.576, depth: 0.434 },
    },
  } satisfies Record<string, InteriorFurnitureSpec>,

  /** 北侧门洞与南窗洞口（用于壳体与出口提示，不参与业务判定）。 */
  openings: {
    entrance: { minX: 1.26, maxX: 2.06, height: 2.1 },
    window: { minX: 0.7, maxX: 2.6, minY: 0.5, maxY: 2.1 },
    bathroomDoor: { minZ: 1.35, maxZ: 2.3, height: 2.05 },
    /**
     * 服务区（玄关/卫浴/厨房）与卧室起居室之间的隔断门洞。
     * 门洞净宽 1.12m；门扇固定全开，停在卫浴南墙外侧，不做门动画。
     */
    partition: {
      minX: 1.54,
      maxX: 2.66,
      height: 2.05,
      /** 门框立柱宽度：贴在门洞两侧，不占净宽。 */
      post: 0.04,
      /** 全开滑门扇宽度；停靠位置由表现层按门洞左缘计算。 */
      leafWidth: 1.05,
    },
  },
} as const;

const box = (
  width: number,
  depth: number,
  maxY: number,
  offsetX = 0,
  offsetZ = 0,
): FurnitureLocalBox => ({ width, depth, offsetX, offsetZ, minY: 0, maxY });

/**
 * 固定 19 件实体。顺序即界面/校验顺序；seed 只在初始化与 v19→v20 迁移使用，
 * 进入住宅或读档不会重新量化。
 */
export const FURNITURE_DEFINITIONS: readonly FurnitureDefinition[] = [
  {
    id: 'bed',
    name: '单人床',
    footprintWidth: 19,
    footprintDepth: 42,
    seed: { cellX: 1, cellZ: 62, quarterTurn: 0 },
    visualHeight: 1.2015,
    dragHeight: 0.55,
    assetId: 'polyhaven.old-bed-frame',
    // 床架+床垫，不含被子/床尾毯的外挑。
    playerCollision: [box(0.9047, 2.0018, 1.2, 0.0012, -0.02835)],
  },
  {
    id: 'sofa',
    name: '紧凑沙发',
    footprintWidth: 32,
    footprintDepth: 14,
    seed: { cellX: 32, cellZ: 109, quarterTurn: 2 },
    visualHeight: 0.7959,
    dragHeight: 0.4,
    assetId: 'polyhaven.sofa-01',
    playerCollision: [box(1.5715, 0.658, 0.8)],
  },
  {
    id: 'desk',
    name: '书桌',
    footprintWidth: 23,
    footprintDepth: 15,
    seed: { cellX: 50, cellZ: 56, quarterTurn: 1 },
    visualHeight: 0.7994,
    dragHeight: 0.4,
    assetId: 'polyhaven.wooden-table-02',
    // 局部未旋转：长边沿 X，短边沿 Z；q=1 时由旋转规则交换。
    playerCollision: [box(1.1344, 0.706, 0.8)],
  },
  {
    id: 'chair',
    name: '椅子',
    footprintWidth: 9,
    footprintDepth: 12,
    seed: { cellX: 37, cellZ: 63, quarterTurn: 1 },
    visualHeight: 0.9747,
    dragHeight: 0.45,
    assetId: 'polyhaven.dining-chair-02',
    // 局部未旋转：宽 0.4336、深 0.5764；q=1 时由旋转规则交换。
    playerCollision: [box(0.4336, 0.5764, 0.98)],
  },
  {
    id: 'shoe-cabinet',
    name: '鞋柜',
    footprintWidth: 9,
    footprintDepth: 15,
    seed: { cellX: 1, cellZ: 2, quarterTurn: 0 },
    visualHeight: 0.9,
    dragHeight: 0.45,
    playerCollision: [box(0.42, 0.7, 0.9)],
  },
  {
    id: 'entry-mat',
    name: '玄关地垫',
    footprintWidth: 16,
    footprintDepth: 10,
    seed: { cellX: 25, cellZ: 3, quarterTurn: 0 },
    visualHeight: 0.002,
    dragHeight: 0.02,
    playerCollision: [],
  },
  {
    id: 'shower',
    name: '淋浴组件',
    footprintWidth: 12,
    footprintDepth: 12,
    seed: { cellX: 17, cellZ: 19, quarterTurn: 0 },
    visualHeight: 1.875,
    dragHeight: 0.55,
    // 底盘可走入，只有玻璃薄条阻挡。
    playerCollision: [box(0.04, 0.56, 1.9, -0.29, 0)],
  },
  {
    id: 'toilet',
    name: '马桶',
    footprintWidth: 12,
    footprintDepth: 12,
    seed: { cellX: 1, cellZ: 21, quarterTurn: 0 },
    visualHeight: 0.62,
    dragHeight: 0.32,
    playerCollision: [box(0.5, 0.57, 0.8, -0.035, -0.005)],
  },
  {
    id: 'washbasin',
    name: '洗手台',
    footprintWidth: 16,
    footprintDepth: 11,
    seed: { cellX: 3, cellZ: 37, quarterTurn: 0 },
    visualHeight: 1.11,
    dragHeight: 0.55,
    playerCollision: [box(0.85, 0.55, 0.9, -0.025, 0.005)],
  },
  {
    id: 'mirror',
    name: '镜子',
    footprintWidth: 14,
    footprintDepth: 1,
    seed: { cellX: 4, cellZ: 47, quarterTurn: 0 },
    visualHeight: 1.89,
    dragHeight: 1.4,
    visualOffsetZ: -0.03,
    playerCollision: [],
  },
  {
    id: 'fridge',
    name: '冰箱',
    footprintWidth: 11,
    footprintDepth: 12,
    seed: { cellX: 53, cellZ: 19, quarterTurn: 0 },
    visualHeight: 1.78,
    dragHeight: 0.9,
    playerCollision: [box(0.54, 0.56, 1.8, 0.005, 0)],
  },
  {
    id: 'base-cabinet',
    name: '下柜台面组件',
    footprintWidth: 12,
    footprintDepth: 17,
    seed: { cellX: 53, cellZ: 30, quarterTurn: 0 },
    visualHeight: 1.14,
    dragHeight: 0.6,
    playerCollision: [box(0.56, 0.82, 0.95, 0, 0.01)],
  },
  {
    id: 'wall-cabinet',
    name: '吊柜',
    footprintWidth: 6,
    footprintDepth: 9,
    seed: { cellX: 59, cellZ: 37, quarterTurn: 0 },
    visualHeight: 2.26,
    dragHeight: 1.9,
    playerCollision: [],
  },
  {
    id: 'range-hood',
    name: '抽油烟机',
    footprintWidth: 8,
    footprintDepth: 9,
    seed: { cellX: 56, cellZ: 30, quarterTurn: 0 },
    visualHeight: 1.61,
    dragHeight: 1.5,
    playerCollision: [],
  },
  {
    id: 'rug',
    name: '地毯',
    footprintWidth: 27,
    footprintDepth: 38,
    seed: { cellX: 17, cellZ: 67, quarterTurn: 0 },
    visualHeight: 0.006,
    dragHeight: 0.02,
    playerCollision: [],
  },
  {
    id: 'nightstand',
    name: '床头小几',
    footprintWidth: 8,
    footprintDepth: 8,
    seed: { cellX: 2, cellZ: 53, quarterTurn: 0 },
    visualHeight: 0.48,
    dragHeight: 0.25,
    playerCollision: [box(0.38, 0.38, 0.5)],
  },
  {
    id: 'table-lamp',
    name: '台灯',
    footprintWidth: 7,
    footprintDepth: 7,
    seed: { cellX: 2, cellZ: 54, quarterTurn: 0 },
    visualHeight: 0.71,
    dragHeight: 0.6,
    playerCollision: [],
  },
  {
    id: 'plant',
    name: '盆栽',
    footprintWidth: 10,
    footprintDepth: 9,
    seed: { cellX: 19, cellZ: 113, quarterTurn: 0 },
    visualHeight: 0.68,
    dragHeight: 0.35,
    // 只让花盆挡人，叶片是软装饰。
    playerCollision: [box(0.26, 0.26, 0.6, 0, 0.005)],
  },
  {
    id: 'ceiling-light',
    name: '吸顶灯',
    footprintWidth: 11,
    footprintDepth: 11,
    seed: { cellX: 28, cellZ: 60, quarterTurn: 0 },
    visualHeight: 2.54,
    dragHeight: 2.3,
    playerCollision: [],
  },
];

export const FURNITURE_DEFINITION_BY_ID: Readonly<
  Record<string, FurnitureDefinition>
> = Object.fromEntries(FURNITURE_DEFINITIONS.map((item) => [item.id, item]));

export function instanceIdOf(definition: FurnitureDefinition): string {
  return `${FURNITURE_RESIDENCE_ID}.${definition.id}-01`;
}
