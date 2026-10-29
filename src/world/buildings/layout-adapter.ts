/**
 * 只读布局 → 建筑视觉请求（纯投影，正式地图接入的唯一入口）。
 *
 * 数据流（架构冻结的单向依赖）：
 *   `只读 CityLayoutView + 所属城区模板版本`
 *     → 本文件的纯投影（风格、朝向、局部宽深、种子输入、视觉指纹）
 *     → `factory.begin` → `resolveBuildingPlan` → 视觉对象
 *     → scene 挂载并把 `visual.envelope` 原位写入 `handle.collider`
 *
 * 硬约束：
 *  - 只**读**布局，绝不写回 `cityLayout`，也不读写 realEstate / housing / finance；
 *  - 位置、尺寸、id、districtId、interactionId、shopId、companyId、available 全部照抄，
 *    视觉层不参与任何业务判断，不用窗数/楼层数推算住房套数；
 *  - 种子只来自「稳定建筑 id + 所属城区已存模板版本 + 视觉规则版本」；
 *    绝不用会变化的 `layout.revision`，也不把全城 `layoutVersion` 当成每个城区的模板版本。
 */

import type { DeepReadonly } from '../../core/readonly';
import {
  BUILDING_VISUAL_RULES_VERSION,
  defaultStyleFor,
  type BuildingStyleId,
} from '../../content/building-visuals';
import type { CityLayoutView, LayoutBuilding } from '../../features/city-layout';
import type { BuildingVisualRequest } from './types';

/** 只读布局建筑（`CityLayoutView` 的元素类型）。 */
export type ReadonlyLayoutBuilding = DeepReadonly<LayoutBuilding>;

/** 入口主轴：沿哪个轴、朝哪个方向。 */
export interface EntranceAxis {
  readonly axis: 'x' | 'z';
  readonly sign: 1 | -1;
}

/**
 * 入口主轴规则（与 scene 的门朝向判定同一套）：
 * 入口点相对建筑中心的位移在哪个轴上分量更大，就沿哪个轴，符号取该分量方向。
 */
export function entranceAxis(building: ReadonlyLayoutBuilding): EntranceAxis {
  const dx = building.entrance.x - building.position.x;
  const dz = building.entrance.z - building.position.z;
  if (Math.abs(dx) >= Math.abs(dz)) {
    return { axis: 'x', sign: dx >= 0 ? 1 : -1 };
  }
  return { axis: 'z', sign: dz >= 0 ? 1 : -1 };
}

/**
 * 绕 Y 的朝向：工厂局部正面是 +Z，需要转到入口方向。
 *
 *   +Z → 0，-Z → π，+X → π/2，-X → -π/2
 *
 * 只旋转视觉对象，不改逻辑地图；90° 时局部宽深必须交换（见 `projectBuildingVisualRequest`），
 * 否则旋转后的世界占地会被放大成「宽×宽」或「深×深」。
 */
export function entranceRotationY(building: ReadonlyLayoutBuilding): number {
  const { axis, sign } = entranceAxis(building);
  if (axis === 'x') return (sign * Math.PI) / 2;
  return sign > 0 ? 0 : Math.PI;
}

/**
 * 按 districtId 取**该城区已存**的模板版本；找不到时返回 null（由调用方明确诊断）。
 *
 * 不是 `layout.layoutVersion`（那是全城布局口径），也不是 `layout.revision`（会随招商变化）。
 */
export function districtTemplateVersion(layout: CityLayoutView, districtId: string): number | null {
  for (const district of layout.districts) {
    if (district.id === districtId) return district.templateVersion;
  }
  return null;
}

/**
 * 投影一栋楼的视觉请求。
 *
 * 局部宽深交换：旋转 ±90° 时，世界 X 方向的规划宽 `size.width` 会落到局部 Z 上，
 * 因此传给工厂的 `width` 取规划进深、`depth` 取规划宽；旋转后世界包络仍等于原规划占地。
 */
export function projectBuildingVisualRequest(
  building: ReadonlyLayoutBuilding,
  templateVersion: number,
): BuildingVisualRequest {
  const { axis } = entranceAxis(building);
  const quarterTurn = axis === 'x';
  const localWidth = quarterTurn ? building.size.depth : building.size.width;
  const localDepth = quarterTurn ? building.size.width : building.size.depth;
  const styleId: BuildingStyleId = defaultStyleFor(building.kind, building.size.height);

  return {
    buildingId: building.id,
    styleId,
    size: { width: localWidth, depth: localDepth, height: building.size.height },
    kind: building.kind,
    templateVersion,
    position: { x: building.position.x, z: building.position.z },
    rotationY: entranceRotationY(building),
    // 只有商店需要门头招牌做品牌辨识；其他设施靠标签与立面语言辨识
    ...(building.kind === 'shop' ? { signLabel: building.name } : {}),
  };
}

/**
 * 内存视觉指纹：决定「这栋楼的楼体还能不能复用」。
 *
 * 只含影响几何与外观的输入：风格、规划尺寸、位置、朝向、模板版本、视觉规则版本与招牌文字。
 * 业务字段（companyId / shopId / interactionId / available）与布局 revision **不在其中**，
 * 因此新区招商后只更新标签与交互数据，不会重建未变的楼体。
 */
export function visualFingerprint(request: BuildingVisualRequest): string {
  return [
    request.styleId,
    request.size.width,
    request.size.depth,
    request.size.height,
    request.position.x,
    request.position.z,
    request.rotationY ?? 0,
    request.templateVersion,
    BUILDING_VISUAL_RULES_VERSION,
    request.signLabel ?? '',
    // 闭窗面按固定顺序序列化，保证同一集合的指纹稳定
    ['front', 'back', 'left', 'right']
      .filter((face) => (request.blindFaces ?? []).includes(face as never))
      .join('+'),
  ].join('|');
}
