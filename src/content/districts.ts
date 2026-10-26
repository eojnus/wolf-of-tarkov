/**
 * 固定城区模板配置 —— 逻辑地图的静态定义，不含 Three.js、DOM 或经济结算。
 *
 * 首版扩张规则：
 *  - 基础城区保留当前 110 米布局（见 `content/config.ts` 的 CITY），不重排、不改交互 ID；
 *  - 每次新增一条沿 +X 方向拼接的等深条带：宽 60 米、深度与基础城区相同（110 米）；
 *  - 三个方向主题共用同一套外边界与连接规则，只有内部地块用途与建筑配置不同；
 *  - 道路必须真实接入既有路网：条带的横向道路与基础城区东西主路在同一条 z 轴上延续。
 *
 * 模板必须带版本：老城区布局不能因为新版模板改变而漂移，读档也不得重新随机。
 */

import type { BuildingKind } from './config';

export type DistrictDirection = 'technology' | 'commercial' | 'housing';

/** 逻辑地图的固定几何参数。 */
export const DISTRICT_LAYOUT = {
  /** 基础城区边长（米），必须与 CITY.groundSize 一致。 */
  baseSize: 110,
  /** 每次新增条带宽度（米）。 */
  stripWidth: 60,
  /** 与基础城区相同的条带深度（米）。 */
  stripDepth: 110,
  /** 主干道宽度（米），复用 CITY.roadWidth。 */
  roadWidth: 12,
  /** 逻辑布局版本：写入存档，读档不得重算或重排。 */
  layoutVersion: 1,
} as const;

export interface DistrictBuildingTemplate {
  /** 条带内稳定后缀：实例 id = `${templateId}-${stage}-${suffix}`。 */
  readonly suffix: string;
  readonly name: string;
  readonly kind: BuildingKind;
  readonly subtitle: string;
  /** 相对条带中心的本地坐标（x 沿条带宽度，z 沿条带深度）。 */
  readonly offset: { readonly x: number; readonly z: number };
  readonly size: { readonly width: number; readonly height: number; readonly depth: number };
  readonly entranceOffset: { readonly x: number; readonly z: number };
  readonly interactionDistance: number;
  readonly interactionId: string;
  readonly shopId?: string;
  readonly color: number;
  readonly available: boolean;
  /** 该建筑是否为科技企业招商位（每个科技新区最多 1 家真实公司）。 */
  readonly enterpriseSlot?: boolean;
}

export interface DistrictPlotTemplate {
  readonly suffix: string;
  readonly use: 'industry' | 'commerce' | 'residence' | 'infrastructure' | 'park';
  readonly offset: { readonly x: number; readonly z: number };
  readonly size: { readonly width: number; readonly depth: number };
}

/** 道路用矩形表达：中心 + 尺寸，便于场景增量同步。 */
export interface DistrictRoadTemplate {
  readonly suffix: string;
  readonly offset: { readonly x: number; readonly z: number };
  readonly size: { readonly width: number; readonly depth: number };
  readonly width: number;
  /** 是否与既有路网在同一条轴线上直接相连（横向主路延续）。 */
  readonly connectsToExisting: boolean;
}

export interface DistrictTemplate {
  readonly id: string;
  readonly version: number;
  readonly direction: DistrictDirection;
  readonly name: string;
  readonly note: string;
  readonly buildings: readonly DistrictBuildingTemplate[];
  readonly plots: readonly DistrictPlotTemplate[];
  readonly roads: readonly DistrictRoadTemplate[];
}

const COMMON_PLOTS: readonly DistrictPlotTemplate[] = [
  {
    suffix: 'nw',
    use: 'infrastructure',
    offset: { x: -18, z: 26 },
    size: { width: 24, depth: 30 },
  },
  { suffix: 'ne', use: 'commerce', offset: { x: 18, z: 26 }, size: { width: 24, depth: 30 } },
  { suffix: 'sw', use: 'industry', offset: { x: -18, z: -26 }, size: { width: 24, depth: 30 } },
  { suffix: 'se', use: 'park', offset: { x: 18, z: -26 }, size: { width: 24, depth: 30 } },
];

const COMMON_ROADS: readonly DistrictRoadTemplate[] = [
  // 横向主路：与基础城区东西主路同一条 z 轴，直接接入既有路网
  {
    suffix: 'ew',
    offset: { x: 0, z: 0 },
    size: { width: DISTRICT_LAYOUT.stripWidth, depth: DISTRICT_LAYOUT.roadWidth },
    width: DISTRICT_LAYOUT.roadWidth,
    connectsToExisting: true,
  },
  // 条带内纵向道路：与横向主路形成真实路口
  {
    suffix: 'ns',
    offset: { x: 0, z: 0 },
    size: { width: DISTRICT_LAYOUT.roadWidth, depth: DISTRICT_LAYOUT.stripDepth },
    width: DISTRICT_LAYOUT.roadWidth,
    connectsToExisting: false,
  },
];

const TECHNOLOGY_TEMPLATE: DistrictTemplate = {
  id: 'district-tech',
  version: 1,
  direction: 'technology',
  name: '科技新区',
  note:
    '沿既有城区同方向拼接的科技产业条带：提供科技主题建筑与地块，' +
    '每个科技新区最多引入 1 家真实科技 AI 公司（真实研发、发布、销售与融资，不赠送上市状态）。',
  plots: [
    { suffix: 'lab', use: 'industry', offset: { x: -18, z: 26 }, size: { width: 26, depth: 30 } },
    { suffix: 'campus', use: 'commerce', offset: { x: 18, z: 26 }, size: { width: 24, depth: 30 } },
    { suffix: 'incubator', use: 'industry', offset: { x: -18, z: -26 }, size: { width: 24, depth: 30 } },
    { suffix: 'park', use: 'park', offset: { x: 18, z: -26 }, size: { width: 24, depth: 30 } },
  ],
  roads: COMMON_ROADS,
  buildings: [
    {
      suffix: 'lab',
      name: '科技研发中心',
      kind: 'office',
      subtitle: '科技新区 · 企业招商位',
      offset: { x: -18, z: 26 },
      size: { width: 14, height: 10, depth: 12 },
      entranceOffset: { x: 0, z: -6.7 },
      interactionDistance: 2,
      interactionId: '',
      color: 0x5f7f9a,
      available: false,
      enterpriseSlot: true,
    },
    {
      suffix: 'hub',
      name: '科创服务中心',
      kind: 'office',
      subtitle: '求职 · 工作',
      offset: { x: 18, z: 26 },
      size: { width: 12, height: 9, depth: 10 },
      entranceOffset: { x: -6.2, z: 0 },
      interactionDistance: 2,
      interactionId: 'office',
      color: 0x6f8ea6,
      available: true,
    },
    {
      suffix: 'incubator',
      name: '孵化器',
      kind: 'office',
      subtitle: '科技新区 · 孵化空间',
      offset: { x: -18, z: -26 },
      size: { width: 12, height: 7, depth: 10 },
      entranceOffset: { x: 0, z: -5.7 },
      interactionDistance: 2,
      interactionId: '',
      color: 0x8fa6b8,
      available: false,
    },
  ],
};

const COMMERCIAL_TEMPLATE: DistrictTemplate = {
  id: 'district-commercial',
  version: 1,
  direction: 'commercial',
  name: '商业新区',
  note:
    '复用当前真实存在的便利店与就业服务能力，不制作不存在的零售企业利润、供应链或行业 GDP；' +
    '商业区的经营产出仍只来自真实销售结算。',
  plots: COMMON_PLOTS,
  roads: COMMON_ROADS,
  buildings: [
    {
      suffix: 'store',
      name: '晴川便利店（分店）',
      kind: 'shop',
      subtitle: '生活补给 · 便利店岗位',
      offset: { x: -18, z: -26 },
      size: { width: 16, height: 6.4, depth: 12 },
      entranceOffset: { x: 0, z: -6.7 },
      interactionDistance: 2.5,
      interactionId: 'shop',
      shopId: 'convenience-store',
      color: 0xd8d2c4,
      available: true,
    },
    {
      suffix: 'employment',
      name: '就业服务中心',
      kind: 'office',
      subtitle: '求职 · 工作',
      offset: { x: -18, z: 26 },
      size: { width: 13, height: 16, depth: 11 },
      entranceOffset: { x: 6.2, z: 0 },
      interactionDistance: 2,
      interactionId: 'office',
      color: 0x7d8fa6,
      available: true,
    },
    {
      suffix: 'arcade',
      name: '商业街铺',
      kind: 'shop',
      subtitle: '商业新区 · 沿街铺面',
      offset: { x: 18, z: 26 },
      size: { width: 14, height: 6, depth: 10 },
      entranceOffset: { x: 0, z: -5.7 },
      interactionDistance: 2,
      interactionId: '',
      color: 0xc9b49a,
      available: false,
    },
  ],
};

const HOUSING_TEMPLATE: DistrictTemplate = {
  id: 'district-housing',
  version: 1,
  direction: 'housing',
  name: '住房新区',
  note:
    '提供住宅、道路与基础设施空间；本轮没有住房经济模型，' +
    '因此不声称形成可计算的住房供给、租金或房地产利润。',
  plots: COMMON_PLOTS,
  roads: COMMON_ROADS,
  buildings: [
    {
      suffix: 'block-a',
      name: '晴川住宅 A 座',
      kind: 'home',
      subtitle: '住房新区 · 住宅',
      offset: { x: -18, z: 26 },
      size: { width: 12, height: 14, depth: 10 },
      entranceOffset: { x: 0, z: -5.7 },
      interactionDistance: 2,
      interactionId: '',
      color: 0xb98a72,
      available: false,
    },
    {
      suffix: 'block-b',
      name: '晴川住宅 B 座',
      kind: 'home',
      subtitle: '住房新区 · 住宅',
      offset: { x: 18, z: 26 },
      size: { width: 12, height: 14, depth: 10 },
      entranceOffset: { x: 0, z: -5.7 },
      interactionDistance: 2,
      interactionId: '',
      color: 0xc39b82,
      available: false,
    },
    {
      suffix: 'block-c',
      name: '晴川住宅 C 座',
      kind: 'home',
      subtitle: '住房新区 · 住宅',
      offset: { x: -18, z: -26 },
      size: { width: 12, height: 11, depth: 10 },
      entranceOffset: { x: 0, z: -5.7 },
      interactionDistance: 2,
      interactionId: '',
      color: 0xb98a72,
      available: false,
    },
    {
      suffix: 'community',
      name: '社区服务用房',
      kind: 'home',
      subtitle: '住房新区 · 基础设施',
      offset: { x: 18, z: -26 },
      size: { width: 10, height: 5, depth: 8 },
      entranceOffset: { x: 0, z: -4.7 },
      interactionDistance: 2,
      interactionId: '',
      color: 0xcbb6a2,
      available: false,
    },
  ],
};

export const DISTRICT_TEMPLATES: Readonly<Record<DistrictDirection, DistrictTemplate>> = {
  technology: TECHNOLOGY_TEMPLATE,
  commercial: COMMERCIAL_TEMPLATE,
  housing: HOUSING_TEMPLATE,
};

export function districtTemplateOf(direction: DistrictDirection): DistrictTemplate {
  return DISTRICT_TEMPLATES[direction];
}
