/**
 * 晴川公寓首套室内 —— 尺寸、摆位、相机与资产清单。
 *
 * 只放数据，不建 Three.js 对象；表现层在 `world/interiors/qingchuan.ts` 读取本文件。
 * 房间坐标：X 向右（0–3.3m），Z 向南（0–6.2m，北入口、南窗），Y 向上。
 */

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
  },
} as const;
