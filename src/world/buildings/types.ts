/**
 * 建筑视觉工厂的公共类型 —— 只描述表现层产物，不含任何业务字段。
 *
 * 尺寸一律来自**只读规划尺寸**（`LayoutBuilding.size`），本模块不产生也不修改业务数据。
 */

import type * as THREE from 'three';
import type { BuildingStyleId } from '../../content/building-visuals';
import type { ResolvedPlan } from './plan';

/** 世界坐标 AABB。`envelope` 用的是声明空间，`actual` 用的是实际几何。 */
export interface VisualBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly minY: number;
  readonly maxY: number;
}

/** 实际几何相对声明空间的越界量（≤ 0 表示该方向仍在界内）。 */
export interface VisualBoundsReport {
  readonly declared: VisualBounds;
  readonly actual: VisualBounds;
  readonly overflow: { readonly x: number; readonly y: number; readonly z: number };
  readonly inside: boolean;
}

export interface VisualRenderStats {
  /** 本楼新增的 draw call 数（按材质合批 + 外部模型实例）。 */
  readonly drawCalls: number;
  readonly triangles: number;
}

export interface BuildingVisualRequest {
  /** 稳定建筑 id：同时是外观种子的来源，不参与任何业务判断。 */
  readonly buildingId: string;
  /** 外观风格（配置样例）；尺寸不来自风格。 */
  readonly styleId: BuildingStyleId;
  /** 只读规划尺寸（米），直接对应 `LayoutBuilding.size`。 */
  readonly size: { readonly width: number; readonly depth: number; readonly height: number };
  /** 语义类型（`LayoutBuilding.kind`），仅用于缺省风格选择与记录。 */
  readonly kind?: string;
  /** 已存城区模板版本：进入种子，保证同一存档内外观不漂移。 */
  readonly templateVersion: number;
  readonly position: { readonly x: number; readonly z: number };
  /**
   * 朝向（弧度，绕 Y 轴）。原型页默认 0（+Z 为正立面）；
   * 正式接入时按既有入口方向传入，只旋转视觉对象，不改逻辑地图。
   */
  readonly rotationY?: number;
  /**
   * 门头招牌文字（商店的品牌辨识）。只有首层商业面（`entrance.shopfront`）会真正生成招牌；
   * 其他设施不传即可。文字只用于表现，不参与任何业务判断。
   */
  readonly signLabel?: string;
}

/** 一栋建成的视觉对象。 */
export interface BuildingVisual {
  readonly request: BuildingVisualRequest;
  /** 由规划尺寸解析出的实际方案（层数、层高、开间、退让、屋顶占位）。 */
  readonly plan: ResolvedPlan;
  readonly group: THREE.Group;
  /** 声明空间的世界 AABB（只由规划尺寸与朝向决定）。 */
  readonly envelope: VisualBounds;
  readonly stats: VisualRenderStats;
  /** 释放本楼独有的几何与实例矩阵；共享材质/贴图由工厂统一释放。 */
  dispose(): void;
}

/**
 * 单栋请求句柄：加载过程中也可以取消。
 *
 * - `cancel()` 只影响这一栋的在途请求，不会取消其他楼共享的贴图/模型加载；
 * - 取消后 `result` 以 `VisualLoadCancelled` 拒绝；
 * - 令牌只存在内存里，不写入 `LayoutBuilding`、`GameState` 或存档。
 */
export interface BuildingVisualHandle {
  readonly request: BuildingVisualRequest;
  readonly result: Promise<BuildingVisual>;
  /** 是否已取消（含工厂销毁导致的取消）。 */
  readonly cancelled: boolean;
  cancel(): void;
}
