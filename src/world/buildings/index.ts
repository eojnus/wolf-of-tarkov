/**
 * 模块化建筑视觉库 —— 对外入口。
 *
 * 只暴露工厂、规划解析、只读布局适配、包络核对与类型：正式场景（scene/world）
 * 与开发预览页都从这里引用，保证预览页跑的就是生产工厂，不存在「演示用另一套实现」。
 */

export {
  BuildingVisualFactory,
  VisualLoadCancelled,
  compareBounds,
  envelopeOf,
  inspectVisual,
  measureWorldBounds,
} from './factory';
export type { BuildingVisualFactoryStats } from './factory';
export {
  districtTemplateVersion,
  entranceAxis,
  entranceRotationY,
  projectBuildingVisualRequest,
  visualFingerprint,
} from './layout-adapter';
export type { EntranceAxis, ReadonlyLayoutBuilding } from './layout-adapter';
export { resolveBuildingPlan, PlanRangeError } from './plan';
export type { PlanInput, ResolvedPlan } from './plan';
export type {
  BuildingVisual,
  BuildingVisualHandle,
  BuildingVisualRequest,
  VisualBounds,
  VisualBoundsReport,
  VisualRenderStats,
} from './types';
