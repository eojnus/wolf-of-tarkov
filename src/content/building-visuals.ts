/**
 * 建筑视觉风格与资产登记 —— 纯数据 + 纯函数，不 import Three.js / DOM。
 *
 * 这里只描述**风格**：层高、开间偏好、窗洞比例、阳台/入口/屋顶做法、材质与配色。
 * 具体一栋楼的宽、深、高来自只读规划尺寸（`LayoutBuilding.size`），由
 * `world/buildings/plan.ts` 解析成可施工的 `ResolvedPlan`：
 *
 *   只读布局尺寸（宽/深/高）+ 风格
 *     → 解析：主体退让、层数、层高、开间、阳台与屋顶设备占位
 *     → 保证全部几何落在声明空间内（屋顶设备计入高度）
 *
 * 五种风格只是**配置样例**：同一套构件按任意合法尺寸生成，不做整体非等比拉伸。
 * 其中 `civic-4` 与 `retail-3` 是正式地图接入时新增的公共建筑/商业低楼语言，
 * 让政府与商店不再落入住宅风格（见 `defaultStyleFor` 的显式映射）。
 *
 * 边界：
 *  - 不读 `realEstate` / `housing` / `finance` / `cityLayout`，不写任何业务状态；
 *  - 视觉数量（层数/窗数/阳台数）不反推住房套数或任何经济口径；
 *  - 尺寸必须来自规划投影，不得为了让固定模型好看而改动逻辑地图。
 */

/**
 * 视觉规则版本：进入确定性种子，外观算法调整必须递增。
 *
 * v2：正式接入正式地图。支持 5 米真实低楼（高度下限 6 → 5）、单层建筑不再摆放屋顶设备、
 *     朝向 90° 时局部宽深交换（世界占地不变）、新增公共建筑与商业低楼两种风格。
 */
export const BUILDING_VISUAL_RULES_VERSION = 3;

export type BuildingStyleId =
  | 'residential-6'
  | 'apartment-8'
  | 'office-10'
  | 'civic-4'
  | 'retail-3';

/** 立面 PBR 材质键（对应 public/assets/city-realism/textures 下的真实贴图）。 */
export type FacadeTextureKey = 'plaster-wall' | 'facade-tiles';

export interface VisualTextureAsset {
  readonly id: FacadeTextureKey;
  readonly diffuse: string;
  readonly normal: string;
  /** Poly Haven 的 ARM 打包图：three 从 G 通道取粗糙度、B 通道取金属度。 */
  readonly arm: string;
  /** 一次贴图循环覆盖的真实米数，用于米制 UV（避免拉伸与逐面重算）。 */
  readonly tileMeters: number;
}

export interface VisualModelAsset {
  readonly id: 'fire-escape' | 'utility-box';
  readonly url: string;
  /** 资源记录：来源页、作者、许可见 `public/assets/SOURCES.md`。 */
  readonly note: string;
}

/** 静态资源根目录：全部本地托管，不依赖第三方运行时 CDN。 */
export const VISUAL_ASSET_ROOT = 'assets/city-realism';

export const VISUAL_TEXTURES: Readonly<Record<FacadeTextureKey, VisualTextureAsset>> = {
  'plaster-wall': {
    id: 'plaster-wall',
    diffuse: `${VISUAL_ASSET_ROOT}/textures/plaster-wall-diffuse-1k.jpg`,
    normal: `${VISUAL_ASSET_ROOT}/textures/plaster-wall-normal-1k.jpg`,
    arm: `${VISUAL_ASSET_ROOT}/textures/plaster-wall-arm-1k.jpg`,
    tileMeters: 3.2,
  },
  'facade-tiles': {
    id: 'facade-tiles',
    diffuse: `${VISUAL_ASSET_ROOT}/textures/facade-tiles-diffuse-1k.jpg`,
    normal: `${VISUAL_ASSET_ROOT}/textures/facade-tiles-normal-1k.jpg`,
    arm: `${VISUAL_ASSET_ROOT}/textures/facade-tiles-arm-1k.jpg`,
    tileMeters: 3.0,
  },
};

export const VISUAL_MODELS: Readonly<Record<VisualModelAsset['id'], VisualModelAsset>> = {
  'fire-escape': {
    id: 'fire-escape',
    url: `${VISUAL_ASSET_ROOT}/models/fire-escape-modular.glb`,
    note: 'Poly Haven / Modular Fire Escape（CC0）：阳台栏杆、平台栏杆、楼梯、底段爬梯；已裁剪为单一 PBR 套。',
  },
  'utility-box': {
    id: 'utility-box',
    url: `${VISUAL_ASSET_ROOT}/models/utility-box.glb`,
    note: 'Poly Haven / Utility Box 01（CC0）：屋顶与入口侧的街边设备箱几何。',
  },
};

/* ------------------------------------------------------------------ 风格 */

/** 立面比例：都以「米」为单位，随层高与开间自动收敛。 */
export interface FacadeStyle {
  /** 期望开间宽度；实际按主体宽度整除并夹紧到可用区间。 */
  readonly preferredBayWidth: number;
  readonly sillHeight: number;
  readonly headHeight: number;
  readonly pierWidth: number;
  readonly wallThickness: number;
  readonly glassInset: number;
  readonly frameWidth: number;
  /** 是否生成横贯全宽的层间线脚。 */
  readonly bandedFloors: boolean;
  /** 顶部檐口（默认画）：压在女儿墙脚下的一道浅挑，给天际线收头。 */
  readonly cornice?: boolean;
  /** 竖向翼板宽度（米）：办公风格用，整高贯通，强化"办公楼"辨识。 */
  readonly fins?: number;
}

/**
 * 占地退让：主体相对声明空间的四边内缩，用来容纳出挑的装饰。
 *
 * 这是空间正确性的核心：装饰不是「不参与碰撞就可以超界」，
 * 而是先从声明空间里让出位置，主体再在剩余范围内排布。
 */
export interface FootprintStyle {
  /** 正立面让出的深度：阳台挑出 / 雨棚 / 台阶 取最大值。 */
  readonly frontInset: number;
  /** 背立面让出的深度：外挂疏散楼梯。 */
  readonly backInset: number;
  /** 两侧让出的宽度：基座与层间线脚的外挑。 */
  readonly sideInset: number;
}

export type BalconyPattern = 'none' | 'middle' | 'every-other' | 'ends';

export interface BalconyStyle {
  readonly kind: 'metal-rail' | 'glass-parapet' | 'none';
  /** 挑出深度（实际会与 frontInset 取小）。 */
  readonly depth: number;
  readonly parapetHeight: number;
  /** 参与阳台的开间选择方式（按实际开间数派生具体序号）。 */
  readonly pattern: BalconyPattern;
  /** 阳台从第几层开始（0 为地面层）。 */
  readonly firstFloor: number;
  /** true 表示隔层布置。 */
  readonly alternateFloors: boolean;
}

export interface EntranceStyle {
  readonly width: number;
  readonly height: number;
  readonly canopyDepth: number;
  /** 雨棚净高；实际会夹到地面层高度以内。 */
  readonly canopyHeight: number;
  readonly maxSteps: number;
  /** 商业裙房整面落地橱窗（办公楼用）。 */
  readonly shopfront: boolean;
}

export type RoofEquipmentKind = 'tank' | 'penthouse' | 'none';

export interface RoofStyle {
  readonly parapetHeight: number;
  readonly parapetThickness: number;
  /** 屋顶设备类型：水箱或机电房。设备顶面必须落在声明高度以内。 */
  readonly equipment: RoofEquipmentKind;
  /** 设备高度上限（米）；实际按剩余高度收缩。 */
  readonly equipmentHeight: number;
  /** 设备平面尺寸上限（米），按主体占地收缩。 */
  readonly equipmentWidth: number;
  readonly equipmentDepth: number;
  /** 屋顶室外机数量上限（屋顶余高不足 1.2 米时自动降为 0）。 */
  readonly maxUtilityBoxes: number;
}

export interface StylePalette {
  readonly wallTint: number;
  readonly trimTint: number;
  readonly glassTint: number;
  readonly frameTint: number;
  readonly accentTint: number;
  /**
   * 贴图亮度系数（线性空间乘数，>1 提亮）。贴图是真实拍摄的中灰抹灰/深色幕墙板，
   * 在项目的半球光 + 平行光下略暗，统一提亮到白天观感；不改贴图文件。
   */
  readonly brightness: number;
}

export interface BuildingStyle {
  readonly id: BuildingStyleId;
  readonly label: string;
  readonly notes: string;
  /** 地面层与标准层的目标层高；实际层高按可用高度均分，偏差控制在 ±15% 内。 */
  readonly floorHeights: { readonly ground: number; readonly upper: number };
  readonly facade: FacadeStyle;
  readonly footprint: FootprintStyle;
  readonly balcony: BalconyStyle;
  readonly entrance: EntranceStyle;
  readonly roof: RoofStyle;
  /** 背面低区外挂疏散楼梯。 */
  readonly fireEscape: boolean;
  readonly textures: { readonly wall: FacadeTextureKey; readonly accent: FacadeTextureKey | null };
  readonly palette: StylePalette;
}

/**
 * 五种风格样例。
 *
 * 层高是真实值（住宅 3.0 / 公寓 3.05 / 办公楼 3.6 / 市政 3.6 / 商业 3.0，首层更高）；
 * `frontInset` 与 `backInset` 就是阳台 / 雨棚 / 台阶 / 外挂楼梯占用的空间，
 * 主体先退让，装饰才放得进声明空间。
 */
export const BUILDING_STYLES: Readonly<Record<BuildingStyleId, BuildingStyle>> = {
  'residential-6': {
    id: 'residential-6',
    label: '板式住宅',
    notes: '宽开间、方正窗洞、居中两跨挑出金属栏杆阳台、平屋面 + 屋顶水箱。',
    floorHeights: { ground: 3.4, upper: 3.0 },
    facade: {
      preferredBayWidth: 4.71,
      sillHeight: 0.95,
      headHeight: 2.25,
      pierWidth: 0.9,
      wallThickness: 0.4,
      glassInset: 0.16,
      frameWidth: 0.08,
      bandedFloors: false,
    },
    footprint: { frontInset: 1.6, backInset: 0, sideInset: 0.35 },
    balcony: {
      kind: 'metal-rail',
      depth: 1.5,
      parapetHeight: 1.0,
      pattern: 'middle',
      firstFloor: 1,
      alternateFloors: false,
    },
    entrance: {
      width: 2.4,
      height: 2.6,
      canopyDepth: 1.5,
      canopyHeight: 3.0,
      maxSteps: 2,
      shopfront: false,
    },
    roof: {
      parapetHeight: 1.0,
      parapetThickness: 0.32,
      equipment: 'tank',
      equipmentHeight: 1.5,
      equipmentWidth: 3.2,
      equipmentDepth: 3.2,
      maxUtilityBoxes: 2,
    },
    fireEscape: false,
    textures: { wall: 'plaster-wall', accent: null },
    palette: {
      wallTint: 0xf4f1ea,
      trimTint: 0xfbf8f2,
      glassTint: 0xa8c6d1,
      frameTint: 0x3a3f45,
      accentTint: 0xa89a8a,
      brightness: 1.34,
    },
  },
  'apartment-8': {
    id: 'apartment-8',
    label: '点式公寓',
    notes: '窄开间大窗、层间线脚、两端整层玻璃栏板阳台、屋顶机电房。',
    floorHeights: { ground: 3.6, upper: 3.05 },
    facade: {
      preferredBayWidth: 3.9,
      sillHeight: 0.5,
      headHeight: 2.55,
      pierWidth: 0.6,
      wallThickness: 0.36,
      glassInset: 0.12,
      frameWidth: 0.06,
      bandedFloors: true,
    },
    footprint: { frontInset: 1.8, backInset: 0, sideInset: 0.35 },
    balcony: {
      kind: 'glass-parapet',
      depth: 1.7,
      parapetHeight: 1.05,
      pattern: 'ends',
      firstFloor: 1,
      alternateFloors: false,
    },
    entrance: {
      width: 3.2,
      height: 3.0,
      canopyDepth: 1.6,
      canopyHeight: 3.4,
      maxSteps: 3,
      shopfront: false,
    },
    roof: {
      parapetHeight: 1.1,
      parapetThickness: 0.3,
      equipment: 'penthouse',
      equipmentHeight: 2.6,
      equipmentWidth: 5.2,
      equipmentDepth: 4.2,
      maxUtilityBoxes: 3,
    },
    fireEscape: false,
    textures: { wall: 'plaster-wall', accent: 'facade-tiles' },
    palette: {
      wallTint: 0xe9ebec,
      trimTint: 0xf6f7f8,
      glassTint: 0x8fb4c6,
      frameTint: 0x2f3439,
      accentTint: 0x8c7358,
      brightness: 1.34,
    },
  },
  'office-10': {
    id: 'office-10',
    label: '商业办公楼',
    notes: '商业裙房 + 连续窗带幕墙 + 整高竖向翼板、通高门厅、背面低区外挂疏散楼梯。',
    floorHeights: { ground: 4.8, upper: 3.6 },
    facade: {
      preferredBayWidth: 4.0,
      sillHeight: 0.3,
      headHeight: 3.15,
      pierWidth: 0.22,
      wallThickness: 0.45,
      glassInset: 0.1,
      frameWidth: 0.07,
      bandedFloors: true,
      fins: 0.18,
    },
    footprint: { frontInset: 2.8, backInset: 1.7, sideInset: 0.35 },
    balcony: {
      kind: 'none',
      depth: 0,
      parapetHeight: 0,
      pattern: 'none',
      firstFloor: 0,
      alternateFloors: false,
    },
    entrance: {
      width: 4.2,
      height: 3.4,
      canopyDepth: 2.6,
      canopyHeight: 4.0,
      maxSteps: 3,
      shopfront: true,
    },
    roof: {
      parapetHeight: 1.3,
      parapetThickness: 0.4,
      equipment: 'penthouse',
      equipmentHeight: 2.8,
      equipmentWidth: 7.5,
      equipmentDepth: 6,
      maxUtilityBoxes: 4,
    },
    fireEscape: true,
    textures: { wall: 'facade-tiles', accent: 'plaster-wall' },
    palette: {
      wallTint: 0xe4e9ec,
      trimTint: 0xe8eaec,
      glassTint: 0x7fa6bb,
      frameTint: 0x2b3035,
      accentTint: 0x6f767c,
      brightness: 1.32,
    },
  },
  'civic-4': {
    id: 'civic-4',
    label: '市政公共建筑',
    notes: '厚墙大窗洞、通高门厅与石材基座、层间线脚；不设阳台，屋顶只做女儿墙。',
    floorHeights: { ground: 4.4, upper: 3.6 },
    facade: {
      preferredBayWidth: 5.0,
      sillHeight: 1.1,
      headHeight: 2.5,
      pierWidth: 1.0,
      wallThickness: 0.5,
      glassInset: 0.18,
      frameWidth: 0.09,
      bandedFloors: true,
    },
    footprint: { frontInset: 2.6, backInset: 0.3, sideInset: 0.45 },
    balcony: {
      kind: 'none',
      depth: 0,
      parapetHeight: 0,
      pattern: 'none',
      firstFloor: 0,
      alternateFloors: false,
    },
    entrance: {
      width: 4.0,
      height: 3.0,
      canopyDepth: 2.2,
      canopyHeight: 3.6,
      maxSteps: 2,
      shopfront: false,
    },
    roof: {
      parapetHeight: 1.2,
      parapetThickness: 0.42,
      equipment: 'none',
      equipmentHeight: 0,
      equipmentWidth: 5,
      equipmentDepth: 4,
      maxUtilityBoxes: 1,
    },
    fireEscape: false,
    textures: { wall: 'plaster-wall', accent: 'facade-tiles' },
    palette: {
      wallTint: 0xeceae3,
      trimTint: 0xf7f5ef,
      glassTint: 0x9db9c6,
      frameTint: 0x3b4148,
      accentTint: 0x9aa0a3,
      brightness: 1.32,
    },
  },
  'retail-3': {
    id: 'retail-3',
    label: '商业沿街楼',
    notes: '小开间、首层通高橱窗与门头招牌带；低楼只保留一层商业面，不摆屋顶设备。',
    floorHeights: { ground: 3.6, upper: 3.0 },
    facade: {
      preferredBayWidth: 4.4,
      sillHeight: 0.6,
      headHeight: 2.6,
      pierWidth: 0.34,
      wallThickness: 0.36,
      glassInset: 0.1,
      frameWidth: 0.07,
      bandedFloors: true,
    },
    footprint: { frontInset: 1.9, backInset: 0.2, sideInset: 0.3 },
    balcony: {
      kind: 'none',
      depth: 0,
      parapetHeight: 0,
      pattern: 'none',
      firstFloor: 0,
      alternateFloors: false,
    },
    entrance: {
      width: 3.2,
      height: 2.8,
      canopyDepth: 1.6,
      canopyHeight: 3.2,
      maxSteps: 1,
      shopfront: true,
    },
    roof: {
      parapetHeight: 0.9,
      parapetThickness: 0.3,
      equipment: 'none',
      equipmentHeight: 0,
      equipmentWidth: 3.2,
      equipmentDepth: 3.2,
      maxUtilityBoxes: 2,
    },
    fireEscape: false,
    textures: { wall: 'plaster-wall', accent: 'facade-tiles' },
    palette: {
      // accentTint 就是门头招牌底色（深青）：与旧招牌保持同一品牌观感
      wallTint: 0xece7dc,
      trimTint: 0xf7f3ea,
      glassTint: 0x9fc0c8,
      frameTint: 0x263039,
      accentTint: 0x0e4f55,
      brightness: 1.34,
    },
  },
};

export const STYLE_IDS: readonly BuildingStyleId[] = [
  'residential-6',
  'apartment-8',
  'office-10',
  'civic-4',
  'retail-3',
];

export function styleSpec(id: BuildingStyleId): BuildingStyle {
  return BUILDING_STYLES[id];
}

/**
 * 设施语义类型 → 视觉风格的**显式**映射（正式地图与预览页共用）。
 *
 * 只按 `kind` 与规划高度挑选**风格**，不决定尺寸：宽深高完全来自只读布局。
 * 六类既有设施与三个新区的全部 kind 都必须在这里有明确分支；
 * 政府与商店走公共建筑 / 商业低楼语言，不再落回住宅默认分支。
 * 未知 kind 用办公楼语言兜底（非住宅），并应在调用处记录诊断。
 */
export function defaultStyleFor(kind: string, height: number): BuildingStyleId {
  switch (kind) {
    case 'home':
      return height >= 20 ? 'apartment-8' : 'residential-6';
    case 'bank':
    case 'office':
    case 'securities':
      return 'office-10';
    case 'government':
      return 'civic-4';
    case 'shop':
      return 'retail-3';
    default:
      return 'office-10';
  }
}

/* ------------------------------------------------------------------ 种子 */

/**
 * 确定性种子：稳定建筑 id + 已存城区模板版本 + 视觉规则版本。
 *
 * 刻意不包含时间、GDP、companyId、渲染顺序或任何业务状态：
 * 同一栋楼在同一存档里刷新一百次也必须是同一副外观。
 */
export function seedPartsFor(
  buildingId: string,
  templateVersion: number,
  rulesVersion: number = BUILDING_VISUAL_RULES_VERSION,
): readonly (string | number)[] {
  return [buildingId, templateVersion, rulesVersion];
}
