/**
 * 街景美术资源登记 —— 纯数据，不 import Three.js / DOM。
 *
 * 与 `building-visuals.ts` 分开维护：建筑那一份描述**立面风格**，
 * 这一份只描述**街景**（路面、人行道、路缘、树木、街道家具）。
 * 两者共用 `assets/city-realism` 根目录，但材质键互不混用。
 *
 * 资源来源与许可见 `public/assets/SOURCES.md`；本文件只写运行时要用的路径与参数。
 */

/** 街景静态资源根目录（与建筑共用，全部本地托管，不依赖运行时 CDN）。 */
export const SCENERY_ASSET_ROOT = 'assets/city-realism';

/* ---------------------------------------------------------------- 铺装贴图 */

export type SceneryTextureKey = 'asphalt' | 'paving';

export interface SceneryTextureAsset {
  readonly id: SceneryTextureKey;
  readonly diffuse: string;
  readonly normal: string;
  /** Poly Haven 的 ARM 打包图：three 从 G 通道取粗糙度、B 通道取金属度。 */
  readonly arm: string;
  /** 一次贴图循环覆盖的真实米数（米制 UV 用）。 */
  readonly tileMeters: number;
}

export const SCENERY_TEXTURES: Readonly<Record<SceneryTextureKey, SceneryTextureAsset>> = {
  asphalt: {
    id: 'asphalt',
    diffuse: `${SCENERY_ASSET_ROOT}/textures/asphalt-diffuse-1k.jpg`,
    normal: `${SCENERY_ASSET_ROOT}/textures/asphalt-normal-1k.jpg`,
    arm: `${SCENERY_ASSET_ROOT}/textures/asphalt-arm-1k.jpg`,
    // 沥青的纹理尺度较小：4 m 循环一次，6 m 宽车道能看到 1.5 个循环，不出现明显重复。
    tileMeters: 4,
  },
  paving: {
    id: 'paving',
    diffuse: `${SCENERY_ASSET_ROOT}/textures/paving-diffuse-1k.jpg`,
    normal: `${SCENERY_ASSET_ROOT}/textures/paving-normal-1k.jpg`,
    arm: `${SCENERY_ASSET_ROOT}/textures/paving-arm-1k.jpg`,
    // 人行道铺装块约 0.6 m：2.4 m 一次循环 = 4 块砖，与真实铺装尺度接近。
    tileMeters: 2.4,
  },
};

/* ---------------------------------------------------------------- 无贴图材质 */

/**
 * 只用颜色与粗糙度的街景材质。
 *
 * 路缘石、标线、围墙、绿篱不需要贴图：贴图只会让 0.4 m 宽的条带出现无意义的碎纹，
 * 而它们的作用是**颜色区分**。这里按用途登记，避免在场景代码里内联色值。
 */
export type ScenerySolidKey = 'curb' | 'marking' | 'wall' | 'hedge' | 'soil';

export interface ScenerySolidAsset {
  readonly id: ScenerySolidKey;
  readonly color: number;
  readonly roughness: number;
  readonly metalness: number;
}

export const SCENERY_SOLIDS: Readonly<Record<ScenerySolidKey, ScenerySolidAsset>> = {
  curb: { id: 'curb', color: 0xb9bcc0, roughness: 0.82, metalness: 0 },
  marking: { id: 'marking', color: 0xe8e6dc, roughness: 0.75, metalness: 0 },
  wall: { id: 'wall', color: 0x8d8579, roughness: 0.92, metalness: 0 },
  hedge: { id: 'hedge', color: 0x3f5f38, roughness: 0.95, metalness: 0 },
  soil: { id: 'soil', color: 0x4a4034, roughness: 1, metalness: 0 },
};

/* ------------------------------------------------------------------ 模型 */

export type SceneryModelKey = 'street-tree' | 'street-lamp' | 'bench';

export interface SceneryModelAsset {
  readonly id: SceneryModelKey;
  readonly url: string;
  /** GLB 内要抽取的根节点名；空串表示整个文件就是一个构件。 */
  readonly node: string;
  /** 归一化方式与目标尺寸（米）：加载后按包围盒缩放，脚底贴地。 */
  readonly fit: { readonly axis: 'height' | 'length'; readonly meters: number };
  /**
   * **树干**平面碰撞盒（米）。规划期就按这个值生成碰撞，不依赖异步加载结果；
   * 加载后若实测超出，记录诊断但不改碰撞（避免碰撞随加载时机变化）。
   */
  readonly collider: { readonly width: number; readonly depth: number; readonly height: number };
  /**
   * 树冠平面包络（米）。**只用于视觉避让**（离墙、离家具、离通道的规划判定），
   * 绝不进入玩家碰撞：树冠是稀疏枝叶，做成碰撞盒会把庭院与巷口封死。
   * 由实际模型归一化后量测得到，见 `stage1-tree-fix.md`。
   */
  readonly crown?: { readonly width: number; readonly depth: number };
  /** true 表示不加载模型，由街区层用程序化几何生成（家具类，不计入外部素材）。 */
  readonly procedural?: boolean;
  readonly note: string;
}

export const SCENERY_MODELS: Readonly<Record<SceneryModelKey, SceneryModelAsset>> = {
  'street-tree': {
    id: 'street-tree',
    url: `${SCENERY_ASSET_ROOT}/models/street-tree.glb`,
    node: '',
    // 目标高度 5.6 m：与 12–16 m 的沿街楼形成 1:2.5 的比例，行道树不会被楼压没。
    fit: { axis: 'height', meters: 5.6 },
    // 树干实测直径 0.54 m（底部 8% 高度内量测），碰撞盒留 1 cm 余量。
    collider: { width: 0.56, depth: 0.56, height: 5.6 },
    // 归一化到 5.6 m 后实测树冠 2.44 × 2.00 m（原 Fir Sapling 是 11.8 × 3.52，冠幅是高度的 2.1 倍）。
    crown: { width: 2.44, depth: 2.0 },
    note: 'Poly Haven / Quiver Tree 01（CC0）：窄冠庭园树，减面 + 叶片材质转不透明后单文件 GLB。',
  },
  'street-lamp': {
    id: 'street-lamp',
    url: `${SCENERY_ASSET_ROOT}/models/street-lamp.glb`,
    node: 'street_lamp_01',
    fit: { axis: 'height', meters: 4.2 },
    collider: { width: 0.34, depth: 0.34, height: 4.2 },
    note: 'Poly Haven / Street Lamp 01（CC0）：单构件，灯头保留原生自发光色，不新增光源。',
  },
  bench: {
    id: 'bench',
    // 程序化石凳：Poly Haven 的模块化座椅是"零件陈列"布局（座板/腿/扶手分散在 x −2.3…+1.0），
    // 取任何单一节点都只是平板，拼装又需要逐件手动对位。因此家具改为程序化生成，
    // 并且**不把它算作外部美术资源**。
    url: '',
    node: '',
    fit: { axis: 'length', meters: 1.85 },
    collider: { width: 1.85, depth: 0.65, height: 0.45 },
    procedural: true,
    note: '程序化石凳（座板 + 两侧支墩），材质复用街景库的素色材质；非外部素材。',
  },
};

/* ------------------------------------------------------------------ 规则 */

/** 街区规划的固定参数（米）。全部集中在这里，规划器不得内联数字。 */
export const SCENERY_RULES = {
  /** 楼体到业务建筑的最小净距。2.0 − 2×0.42 = 1.16 m 中心可动，能走通。 */
  buildingToBusiness: 2,
  /** 一切构筑到储备地块边界的最小净距。 */
  clearToReserve: 1,
  /** 家具到业务建筑的最小净距（避免贴身卡位）。 */
  furnitureToBusiness: 0.6,
  /** 巷道最小几何净宽。 */
  alleyMinWidth: 2.4,
  /** 树**冠**到墙面/围墙/楼体的最小净距（视觉避让，不进碰撞）。 */
  treeToWall: 1.2,
  /**
   * 树冠到家具（长椅、路灯）的最小净距。
   *
   * 比贴墙小得多：树冠压低到长椅上方是正常街景，路灯是一根杆，
   * 而贴墙的枝叶会直接插进立面。实测树冠最低叶在 1.96 m（脚底算起），
   * 高于人物视平线 1.7 m，因此遮在长椅上方不会糊脸。
   */
  treeToFurniture: 0.3,
  /** 两段实体之间允许的最小"无人缝"：小于它就视为窄缝，必须贴合或拉开。 */
  minGapBetweenSolids: 1,
  /** 沿街墙段的最小前宽（与工厂最小宽度一致）。 */
  minFrontageRun: 8,
  /** 庭院最小净宽与最小面积。 */
  courtyardMinWidth: 6,
  courtyardMinArea: 60,
  /** 树木归一化后的树冠半径估算系数（仅用于"别种在通道正中"的软约束）。 */
  treeCrownFactor: 0.5,
} as const;
