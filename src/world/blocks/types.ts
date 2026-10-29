/**
 * 街区规划的公共类型 —— 纯类型，不 import Three.js。
 *
 * 由 `plan.ts`（试点 + 编排）、`generate.ts`（参数化生成）、`sites.ts`（站点枚举）
 * 与 `scene.ts`（装配）共同使用，保证三处产出同一份结构。
 */

import type { BuildingStyleId } from '../../content/building-visuals';
import type { SceneryModelKey } from '../../content/city-scenery';
import type { Rect } from './rect';

export interface DecorPlacement {
  readonly id: string;
  readonly styleId: BuildingStyleId;
  readonly size: { readonly width: number; readonly depth: number; readonly height: number };
  readonly position: { readonly x: number; readonly z: number };
  readonly rotationY: number;
  readonly blindFaces: readonly ('front' | 'back' | 'right' | 'left')[];
  readonly footprint: Rect;
  readonly label: string;
}

export interface PavingPlacement {
  readonly id: string;
  readonly rect: Rect;
  readonly surface: 'asphalt' | 'paving';
}

export interface WallPlacement {
  readonly id: string;
  readonly rect: Rect;
  readonly height: number;
  readonly kind: 'wall' | 'hedge';
}

export interface PropPlacement {
  readonly id: string;
  readonly key: SceneryModelKey;
  readonly x: number;
  readonly z: number;
  readonly rotationY: number;
  readonly collider: { readonly width: number; readonly depth: number; readonly height: number };
}

export interface BlockCollider {
  readonly owner: 'decor' | 'wall' | 'prop';
  readonly id: string;
  readonly rect: Rect;
  readonly minY: number;
  readonly maxY: number;
}

/** 街区变体：完整方形模板，或按可用空间裁剪的变体。 */
export type BlockVariant = 'full' | 'clipped' | 'row';

/**
 * 对外端口：外围道路由调用方生成，端口是街区与街道之间**约定好的接口**。
 *
 * 调用方按 `center` / `width` / `outward` 把人行道与车行道接过来即可，
 * 不需要知道内部巷道的具体形状。
 */
export interface BlockPortal {
  /** 稳定 id：`${blockId}-portal-${side}`。 */
  readonly id: string;
  /** 所在侧。 */
  readonly side: 'north' | 'south' | 'east' | 'west';
  /** 入口线段中心（世界坐标，落在净用地边界上）。 */
  readonly center: { readonly x: number; readonly z: number };
  /** 入口宽度（米）。 */
  readonly width: number;
  /** 朝外方向（单位向量，指向街道）。 */
  readonly outward: { readonly x: number; readonly z: number };
  /** 端口类型：巷道口（可穿行）。 */
  readonly kind: 'alley';
  /** 对应的内部巷道 id。 */
  readonly alleyId: string;
}

export interface BlockCoverage {
  /** 实际前宽（沿街，米）。 */
  readonly frontage: number;
  /** 实际进深（米）。 */
  readonly depth: number;
  /** 临街楼栋数。 */
  readonly streetBuildings: number;
  readonly courtyard: boolean;
  readonly alley: boolean;
  /** 保留要素的可读清单，交付说明直接引用。 */
  readonly kept: readonly string[];
  /** 是否为四面围合的完整模板。 */
  readonly perimeter: boolean;
  /** 对外端口数量。 */
  readonly portals: number;
}

export interface BlockPlan {
  readonly id: string;
  readonly templateId: string;
  readonly templateVersion: number;
  /** 结构 + 视觉指纹：任一输入变化都会触发整块重建。 */
  readonly key: string;
  readonly decor: readonly DecorPlacement[];
  readonly paving: readonly PavingPlacement[];
  readonly walls: readonly WallPlacement[];
  readonly props: readonly PropPlacement[];
  /** 树木与家具同一套类型，但单独列出：树木不来自可选的模型表。 */
  readonly trees: readonly PropPlacement[];
  readonly colliders: readonly BlockCollider[];
  /** 本街区自己的步行域（已含街道带衔接）。 */
  readonly walkable: readonly Rect[];
  /** 非空表示该模板被跳过，内容为原因。 */
  readonly skip: readonly string[];
  /** 生成方式与覆盖情况（手写试点不填）。 */
  readonly variant?: BlockVariant;
  readonly coverage?: BlockCoverage;
  /** 所属城区（诊断用；手写试点为 base）。 */
  readonly districtId?: string;
  /** 对外端口（只有完整围合模板会产出）。 */
  readonly portals: readonly BlockPortal[];
  /** 是否由 `generatePerimeterBlock` 生成。 */
  readonly perimeter: boolean;
}

export interface CityBlocksResult {
  readonly blocks: readonly BlockPlan[];
  /** 街道带（路面 + 人行道）的步行矩形，供旧档恢复校验使用。 */
  readonly streetWalkable: readonly Rect[];
  readonly skipped: readonly { readonly id: string; readonly reasons: readonly string[] }[];
}
