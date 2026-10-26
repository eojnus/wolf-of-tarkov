/**
 * 逻辑地图 —— 城区的纯数据与纯计算（不 import Three.js / DOM / 经济结算）。
 *
 * 口径与不变量：
 *  - 本模块只产生**可序列化 JSON**：边界、城区、道路、地块、建筑全部是普通对象/字符串/数字；
 *    场景层（world）读取本模块导出的只读视图来建实例，绝不反向写回。
 *  - 基础城区沿用 `content/config.ts` 的 `CITY.buildings`：id、交互 id、模型路径、
 *    位置与尺寸逐项照搬，**不重排、不改名、不随机重建**，因此旧存档的人物位置与交互不受影响。
 *  - 每个新增城区是一条沿 +X 拼接的等深条带（宽 60、深 110）；第 k 条带
 *    （k 从 0 开始）占据 x ∈ [55 + 60k, 55 + 60(k + 1)]、z ∈ [-55, 55]，
 *    条带中心为 (55 + 60k + 30, 0)。模板里的 offset 一律相对条带中心。
 *  - 稳定标识规则（写入存档后不得变化）：
 *    建筑 `<templateId>-<stage>-<suffix>`、道路 `road-<districtId>-<suffix>`、
 *    地块 `plot-<districtId>-<suffix>`、城区 `district-stage-<stage + 1>`、基础城区 `district-base`。
 *  - `revision` 只表示**结构变化**：任何会改变建筑/道路/地块集合或建筑业务绑定的操作都 +1，
 *    world 用它与自己的 `layoutRevision` 对齐，判断异步模型回调是否已经过期。
 *  - 三个方向主题共用同一套外边界与连接规则，只有内部地块用途/建筑配置不同（模板提供）。
 */

import type { DeepReadonly } from '../../core/readonly';
import { CITY, type BuildingKind } from '../../content/config';
import {
  DISTRICT_LAYOUT,
  DISTRICT_TEMPLATES,
  type DistrictDirection,
  type DistrictTemplate,
} from '../../content/districts';

export interface LayoutBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface LayoutVec2 {
  readonly x: number;
  readonly z: number;
}

export interface LayoutBuilding {
  /** 稳定实例 id：基础城区沿用既有建筑 id；新区是 `<templateId>-<stage>-<suffix>`。 */
  readonly id: string;
  readonly districtId: string;
  /** 所属地块 id；基础城区没有地块划分，为空串（读档校验接受该哨兵值）。 */
  readonly plotId: string;
  /**
   * 模板类型键：home/bank/office/securities/government/shop 等语义类别；
   * 科技招商位固定为 `tech-lab`。与 `kind`（建模外观分类）分开，二者不得互相替代。
   */
  readonly type: string;
  /** 建模外观分类，来自 content/config 的 BuildingKind。 */
  readonly kind: BuildingKind;
  readonly name: string;
  readonly subtitle: string;
  readonly position: LayoutVec2;
  readonly size: { readonly width: number; readonly height: number; readonly depth: number };
  readonly entrance: LayoutVec2;
  readonly interactionDistance: number;
  /** 交互 id：与既有面板映射（`panelIdForInteraction`）配合；空串表示无交互。 */
  readonly interactionId: string;
  readonly shopId: string | null;
  readonly color: number;
  /** 只有基础城区已有的 GLB 才有值；新区为 null（只使用程序化几何体）。 */
  readonly model: string | null;
  /** 模型比例配置键，与实例 id 分开；基础城区 = 建筑 id，新区为 null。 */
  readonly modelScaleKey: string | null;
  readonly available: boolean;
  /** 逻辑碰撞盒（配置化稳定 AABB，世界坐标）。模型加载成功后由 world 拷贝后覆盖自己的副本。 */
  readonly collision: {
    readonly minX: number;
    readonly maxX: number;
    readonly minZ: number;
    readonly maxZ: number;
    readonly minY: number;
    readonly maxY: number;
  };
  /** 动态建筑的业务引用：科技新区招商成功后指向真实公司 id，否则 null。 */
  readonly companyId: string | null;
}

export interface LayoutRoad {
  readonly id: string;
  readonly districtId: string;
  readonly center: LayoutVec2;
  readonly size: { readonly width: number; readonly depth: number };
  /** 主干道宽度（米），用于车道虚线等表现；不参与碰撞。 */
  readonly width: number;
}

export interface LayoutPlot {
  readonly id: string;
  readonly districtId: string;
  readonly use: string;
  readonly center: LayoutVec2;
  readonly size: { readonly width: number; readonly depth: number };
}

export interface LayoutDistrict {
  readonly id: string;
  readonly templateId: string;
  readonly templateVersion: number;
  /** 方向主题；基础城区没有方向主题，为 null。 */
  readonly direction: DistrictDirection | null;
  /** 扩张阶段序号（从 0 开始）；基础城区为 -1。 */
  readonly stage: number;
  readonly sourceTermId: string;
  readonly sourceProjectId: string;
  readonly completedAtMinute: number;
  readonly bounds: LayoutBounds;
}

export interface CityLayoutState {
  /** content/districts 的 DISTRICT_LAYOUT.layoutVersion。 */
  layoutVersion: number;
  /** 每次结构变化 +1（world 用它判断异步回调是否过期）。 */
  revision: number;
  bounds: LayoutBounds;
  districts: LayoutDistrict[];
  roads: LayoutRoad[];
  plots: LayoutPlot[];
  buildings: LayoutBuilding[];
}

/** 逻辑视图（只读快照类型）：world.syncLayout 的输入。 */
export type CityLayoutView = DeepReadonly<CityLayoutState>;

/** 基础城区 id（稳定值，写入存档后不得变化）。 */
export const BASE_DISTRICT_ID = 'district-base';

/** 基础城区模板 id：只用于区分「历史城区」与三个扩张模板。 */
const BASE_TEMPLATE_ID = 'district-base';
const BASE_STAGE = -1;

/* ------------------------------------------------------------------ 几何 */

/** 基础城区半边长（米）：`CITY.groundSize / 2` 与 `DISTRICT_LAYOUT.baseSize / 2` 必须一致。 */
function baseHalfSize(): number {
  return DISTRICT_LAYOUT.baseSize / 2;
}

function createBaseBounds(): LayoutBounds {
  const half = baseHalfSize();
  return { minX: -half, maxX: half, minZ: -half, maxZ: half };
}

/** 第 stage 条带（stage 从 0 开始）的 x 轴中心。 */
function stripCenterX(stage: number): number {
  return baseHalfSize() + DISTRICT_LAYOUT.stripWidth * stage + DISTRICT_LAYOUT.stripWidth / 2;
}

/** 第 stage 条带在 x 轴上的范围：与前一条带无缝相接，最后一条右边界即新 bounds 的 maxX。 */
function stripBounds(stage: number): LayoutBounds {
  const left = baseHalfSize() + DISTRICT_LAYOUT.stripWidth * stage;
  const half = baseHalfSize();
  return { minX: left, maxX: left + DISTRICT_LAYOUT.stripWidth, minZ: -half, maxZ: half };
}

/** 城区 id 规则：`district-stage-<stage + 1>`（基础城区不用此规则）。 */
export function districtIdForStage(stage: number): string {
  assertStage(stage);
  return `district-stage-${stage + 1}`;
}

function assertStage(stage: number): void {
  if (!Number.isSafeInteger(stage) || stage < 0) {
    throw new Error(`[city-layout] 非法扩张阶段：${String(stage)}（必须是非负整数）`);
  }
}

/* ---------------------------------------------------------------- 模板查询 */

function templateById(templateId: string): DistrictTemplate | null {
  for (const template of Object.values(DISTRICT_TEMPLATES)) {
    if (template.id === templateId) return template;
  }
  return null;
}

/**
 * 科技招商建筑 id：批准项目时即可确定（与 addDistrict 实际生成的值必须一致）。
 *
 * 只有带 `enterpriseSlot` 的模板才有招商位；商业/住房新区返回 null。
 */
export function enterpriseBuildingIdFor(templateId: string, stage: number): string | null {
  assertStage(stage);
  const template = templateById(templateId);
  if (!template) {
    throw new Error(`[city-layout] 未知城区模板：${templateId}`);
  }
  const slot = template.buildings.find((building) => building.enterpriseSlot === true);
  return slot ? `${template.id}-${stage}-${slot.suffix}` : null;
}

/* ---------------------------------------------------------------- 基础布局 */

/**
 * 基础城区布局：把 `content/config.ts` 的 `CITY.buildings` 迁为稳定基础布局。
 *
 * 只做「同一份配置换一种数据结构」：id、交互 id、模型路径、位置、尺寸、颜色、
 * 交互距离全部原样保留。基础城区没有地块划分（`plotId` 用空串哨兵），
 * 道路保持当前表现：东西主路 110 × 12 在 z = 0，南北路 12 × 74 在 z = 3。
 */
export function createBaseLayout(): CityLayoutState {
  const bounds = createBaseBounds();
  const layout: CityLayoutState = {
    layoutVersion: DISTRICT_LAYOUT.layoutVersion,
    revision: 0,
    bounds,
    districts: [
      {
        id: BASE_DISTRICT_ID,
        templateId: BASE_TEMPLATE_ID,
        templateVersion: DISTRICT_LAYOUT.layoutVersion,
        direction: null,
        stage: BASE_STAGE,
        sourceTermId: '',
        sourceProjectId: '',
        completedAtMinute: 0,
        bounds: createBaseBounds(),
      },
    ],
    roads: [
      {
        id: `road-${BASE_DISTRICT_ID}-ew`,
        districtId: BASE_DISTRICT_ID,
        center: { x: 0, z: 0 },
        size: { width: CITY.groundSize, depth: CITY.roadWidth },
        width: CITY.roadWidth,
      },
      {
        id: `road-${BASE_DISTRICT_ID}-ns`,
        districtId: BASE_DISTRICT_ID,
        center: { x: 0, z: 3 },
        size: { width: CITY.roadWidth, depth: 74 },
        width: CITY.roadWidth,
      },
    ],
    plots: [],
    buildings: CITY.buildings.map((config) => {
      const width = config.size.width;
      const height = config.size.height;
      const depth = config.size.depth;
      return {
        id: config.id,
        districtId: BASE_DISTRICT_ID,
        plotId: '',
        type: config.kind,
        kind: config.kind,
        name: config.name,
        subtitle: config.subtitle,
        position: { x: config.position.x, z: config.position.z },
        size: { width, height, depth },
        entrance: { x: config.entrance.x, z: config.entrance.z },
        interactionDistance: config.interactionDistance,
        interactionId: config.interactionId,
        shopId: config.shopId ?? null,
        color: config.color,
        model: config.model ?? null,
        modelScaleKey: config.id,
        available: config.available,
        collision: {
          minX: config.position.x - width / 2,
          maxX: config.position.x + width / 2,
          minZ: config.position.z - depth / 2,
          maxZ: config.position.z + depth / 2,
          minY: 0,
          maxY: height,
        },
        companyId: null,
      };
    }),
  };
  return layout;
}

/* ---------------------------------------------------------------- 城区扩张 */

/**
 * 新增一个条带城区（纯函数式就地追加：同步更新 bounds/districts/roads/plots/buildings 与 revision）。
 *
 * 只追加、不重排、不重新随机；同一阶段重复调用会明确抛错（属于编程错误，
 * 由 app 层的「已用阶段集合」保证不会发生）。
 *
 * 返回新增的科技企业招商建筑 id（非科技城区为 null），
 * 供 app 层在项目批准时写入 `DevelopmentProject.enterpriseBuildingId` 并在完成时建招商槽位。
 */
export function addDistrict(
  layout: CityLayoutState,
  input: {
    direction: DistrictDirection;
    stage: number;
    templateId: string;
    templateVersion: number;
    sourceTermId: string;
    sourceProjectId: string;
    completedAtMinute: number;
  },
): { district: LayoutDistrict; enterpriseBuildingId: string | null } {
  assertStage(input.stage);
  const template = templateById(input.templateId);
  if (!template) {
    throw new Error(`[city-layout] 未知城区模板：${input.templateId}`);
  }
  if (template.direction !== input.direction) {
    throw new Error(
      `[city-layout] 模板方向不一致：模板 ${template.id} 是 ${template.direction}，输入是 ${input.direction}`,
    );
  }
  const districtId = districtIdForStage(input.stage);
  if (layout.districts.some((district) => district.stage === input.stage)) {
    throw new Error(`[city-layout] 阶段 ${input.stage} 已有城区，不能重复追加`);
  }

  const centerX = stripCenterX(input.stage);

  const district: LayoutDistrict = {
    id: districtId,
    templateId: template.id,
    templateVersion: input.templateVersion,
    direction: template.direction,
    stage: input.stage,
    sourceTermId: input.sourceTermId,
    sourceProjectId: input.sourceProjectId,
    completedAtMinute: input.completedAtMinute,
    bounds: stripBounds(input.stage),
  };
  layout.districts.push(district);

  for (const road of template.roads) {
    layout.roads.push({
      id: `road-${districtId}-${road.suffix}`,
      districtId,
      center: { x: centerX + road.offset.x, z: road.offset.z },
      size: { width: road.size.width, depth: road.size.depth },
      width: road.width,
    });
  }

  for (const plot of template.plots) {
    layout.plots.push({
      id: `plot-${districtId}-${plot.suffix}`,
      districtId,
      use: plot.use,
      center: { x: centerX + plot.offset.x, z: plot.offset.z },
      size: { width: plot.size.width, depth: plot.size.depth },
    });
  }

  let enterpriseBuildingId: string | null = null;
  for (const building of template.buildings) {
    const id = `${template.id}-${input.stage}-${building.suffix}`;
    const position = { x: centerX + building.offset.x, z: building.offset.z };
    const entrance = {
      x: position.x + building.entranceOffset.x,
      z: position.z + building.entranceOffset.z,
    };
    // 建筑落在与自身 offset 相同的地块上时引用该地块；找不到对应地块时用空串（不伪造引用）。
    const plot = template.plots.find(
      (item) => item.offset.x === building.offset.x && item.offset.z === building.offset.z,
    );
    if (building.enterpriseSlot === true) enterpriseBuildingId = id;
    layout.buildings.push({
      id,
      districtId,
      plotId: plot ? `plot-${districtId}-${plot.suffix}` : '',
      // 科技招商位使用独立语义类型；其余按外观分类作为模板类型键。
      type: building.enterpriseSlot === true ? 'tech-lab' : building.kind,
      kind: building.kind,
      name: building.name,
      subtitle: building.subtitle,
      position,
      size: { width: building.size.width, height: building.size.height, depth: building.size.depth },
      entrance,
      interactionDistance: building.interactionDistance,
      interactionId: building.interactionId,
      shopId: building.shopId ?? null,
      color: building.color,
      // 新区本轮不下载任何新 GLB：只使用程序化几何体。
      model: null,
      modelScaleKey: null,
      available: building.available,
      collision: {
        minX: position.x - building.size.width / 2,
        maxX: position.x + building.size.width / 2,
        minZ: position.z - building.size.depth / 2,
        maxZ: position.z + building.size.depth / 2,
        minY: 0,
        maxY: building.size.height,
      },
      companyId: null,
    });
  }

  // 外边界只向 +X 扩张：minX/minZ/maxZ 不变，maxX = 55 + 60 ×（最大阶段 + 1）。
  // 正常流程阶段连续追加；这里按最大阶段计算，即使存档阶段不连续也不会把城区落到边界外。
  const half = baseHalfSize();
  let maxStage = -1;
  for (const item of layout.districts) {
    if (item.stage > maxStage) maxStage = item.stage;
  }
  layout.bounds = {
    minX: -half,
    maxX: half + DISTRICT_LAYOUT.stripWidth * (maxStage + 1),
    minZ: -half,
    maxZ: half,
  };
  layout.revision += 1;

  return { district, enterpriseBuildingId };
}

/**
 * 把动态建筑绑定到真实公司（招商成功时由 app 层调用）。
 *
 * 只改业务引用，不改变几何；仍然 +revision，world 会把它当作一次结构更新
 * （几何指纹不变时只更新交互数据，不重建网格）。
 */
export function bindBuildingCompany(
  layout: CityLayoutState,
  buildingId: string,
  companyId: string,
): void {
  const index = layout.buildings.findIndex((building) => building.id === buildingId);
  if (index < 0) {
    throw new Error(`[city-layout] 布局中不存在建筑：${buildingId}`);
  }
  const building = layout.buildings[index];
  if (building.companyId === companyId) return;
  layout.buildings[index] = { ...building, companyId };
  layout.revision += 1;
}

/* ---------------------------------------------------------------- 只读查询 */

/** 按稳定 id 查布局建筑；传入只读视图时返回只读结果（方向由调用方决定）。 */
export function findLayoutBuilding(
  layout: CityLayoutState,
  id: string,
): LayoutBuilding | null;
export function findLayoutBuilding(
  layout: DeepReadonly<CityLayoutState>,
  id: string,
): DeepReadonly<LayoutBuilding> | null;
export function findLayoutBuilding(
  layout: CityLayoutState | DeepReadonly<CityLayoutState>,
  id: string,
): LayoutBuilding | DeepReadonly<LayoutBuilding> | null {
  for (const building of layout.buildings) {
    if (building.id === id) return building;
  }
  return null;
}

/** 当前布局中的全部建筑 id（按布局顺序，稳定）。 */
export function layoutBuildingIds(layout: CityLayoutState): string[] {
  return layout.buildings.map((building) => building.id);
}

/**
 * 面板 id 映射：交互 id → 现有面板 id（home/bank/office/securities/government/shop）。
 *
 * 未知交互 id（包括新区里尚未开放的建筑）返回 null：不猜测、不新造面板。
 */
export function panelIdForInteraction(interactionId: string): string | null {
  const mapping: Readonly<Record<string, string>> = {
    home: 'home',
    bank: 'bank',
    office: 'office',
    securities: 'securities',
    government: 'government',
    shop: 'shop',
  };
  const panelId: string | undefined = mapping[interactionId];
  return panelId ?? null;
}
