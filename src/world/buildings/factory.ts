/**
 * 建筑视觉工厂 —— 生产用入口：只读规划输入 → 视觉对象。
 *
 * 数据流（与架构冻结边界一致）：
 *   只读 LayoutBuilding（稳定 id / kind / size / entrance）+ 城区模板版本
 *     → 纯视觉参数解析（`plan.resolveBuildingPlan`：退让、层数、层高、开间、屋顶占位）
 *     → 模块工厂 + 共享资源（材质库、外部模型构件）
 *     → 视觉对象（合批网格 + 实例化外部构件）与声明空间包络
 *
 * 明确不做：
 *  - 不读 `realEstate` / `housing` / `finance` 内部状态，不创建产权、不交房、不发钱；
 *  - 不写 `cityLayout`，不改建筑 id / 位置 / 尺寸 / 交互 id；
 *  - 不从可见窗户或阳台数量反推任何住房套数；
 *  - 不在渲染里推进任何经济规则；
 *  - 不对整栋楼做非等比缩放：所有尺寸都由规划尺寸推导。
 */

import * as THREE from 'three';
import type { BuildingStyleId } from '../../content/building-visuals';
import { VisualAssetLibrary, type ModelPiece } from './assets';
import { buildBalconies, buildEntrance, buildFireEscape, buildRoof, PieceInstances } from './details';
import { buildShell } from './facade';
import { BuildingAssembly, disposeBuildingGroup } from './geometry';
import { resolveBuildingPlan, type ResolvedPlan } from './plan';
import { mulberry32 } from './random';
import type {
  BuildingVisual,
  BuildingVisualHandle,
  BuildingVisualRequest,
  VisualBounds,
  VisualBoundsReport,
  VisualRenderStats,
} from './types';

/** 取消信号：请求尚未完成时被 `cancel()` / `dispose()` 打断。 */
export class VisualLoadCancelled extends Error {
  constructor(message = '[buildings] 视觉对象请求已取消，结果丢弃') {
    super(message);
    this.name = 'VisualLoadCancelled';
  }
}

/** 外部模型构件清单：只取真实存在且会被摆上去的节点。 */
const FIRE_ESCAPE_PIECES = [
  'modular_fire_escape_railing_middle',
  'modular_fire_escape_platform_railing',
  'modular_fire_escape_stairs',
  'modular_fire_escape_ladder_bottom',
] as const;

const UTILITY_BOX_PIECES = ['utility_box_01_box'] as const;

/** 单栋请求的在途令牌：只存在内存里，不进入任何持久结构。 */
class RequestToken {
  cancelled = false;
  constructor(readonly generation: number) {}
}

export interface BuildingVisualFactoryStats {
  readonly live: number;
  readonly pending: number;
  readonly textures: number;
  readonly models: number;
  readonly pieces: number;
  readonly failures: readonly string[];
}

export class BuildingVisualFactory {
  private readonly assets = new VisualAssetLibrary();
  private readonly live = new Set<BuildingVisual>();
  private readonly pending = new Set<RequestToken>();
  private generation = 0;
  private disposed = false;

  /** 共享资产库（供统计与诊断；调用方不得绕过工厂直接释放它）。 */
  get library(): VisualAssetLibrary {
    return this.assets;
  }

  stats(): BuildingVisualFactoryStats {
    return {
      live: this.live.size,
      pending: this.pending.size,
      textures: this.assets.textureCount,
      models: this.assets.modelCount,
      pieces: this.assets.pieceCount,
      failures: [...this.assets.failures],
    };
  }

  /**
   * 发起一栋楼的构建，返回可取消句柄。
   *
   * 取消只作用于这一栋：共享的贴图/模型/构件加载由资产库自行去重，不会被单栋取消打断。
   */
  begin(request: BuildingVisualRequest): BuildingVisualHandle {
    const token = new RequestToken(this.generation);
    this.pending.add(token);
    const result = this.run(request, token).finally(() => {
      this.pending.delete(token);
    });
    return {
      request,
      result,
      get cancelled(): boolean {
        return token.cancelled;
      },
      cancel: () => {
        token.cancelled = true;
      },
    };
  }

  /** 便捷入口：只关心结果、不需要中途取消时使用。 */
  create(request: BuildingVisualRequest): Promise<BuildingVisual> {
    return this.begin(request).result;
  }

  private async run(request: BuildingVisualRequest, token: RequestToken): Promise<BuildingVisual> {
    const plan = resolveBuildingPlan({
      buildingId: request.buildingId,
      kind: request.kind ?? 'home',
      width: request.size.width,
      depth: request.size.depth,
      height: request.size.height,
      templateVersion: request.templateVersion,
      styleId: request.styleId,
    });

    this.ensureActive(token);
    const materials = await this.assets.getMaterials(plan.materialKey, plan.style);
    this.ensureActive(token);

    const pieces = await this.loadPieces(plan);
    this.ensureActive(token);

    const random = mulberry32(plan.seed);
    const assembly = new BuildingAssembly();
    // 设备箱只借外部模型的几何，材质沿用本楼金属框架，避免为一个 1 米高的箱体再引入三张贴图
    const overrides = new Map<string, THREE.Material>([['utility_box_01_box', materials.frame]]);
    const instances = new PieceInstances(pieces, overrides);
    const context = {
      assembly,
      plan,
      materials,
      tileMeters: materials.wallTileMeters,
      accentTileMeters: materials.accentTileMeters,
      random,
      pieces,
    };

    buildShell(context);
    buildBalconies(context, instances);
    buildEntrance(context);
    buildRoof(context, instances);
    buildFireEscape(context, instances);
    instances.flush(assembly);

    const group = assembly.build();
    const stats: VisualRenderStats = assembly.stats();
    group.position.set(request.position.x, 0, request.position.z);
    group.rotation.y = request.rotationY ?? 0;
    group.userData.buildingId = request.buildingId;
    group.userData.styleId = request.styleId;

    // 组装完成后再次确认：期间被取消或工厂销毁时，释放本楼独有资源并拒绝
    if (!this.isActive(token)) {
      disposeBuildingGroup(group);
      throw new VisualLoadCancelled();
    }

    let released = false;
    const visual: BuildingVisual = {
      request,
      plan,
      group,
      envelope: envelopeOf(request),
      stats,
      dispose: () => {
        if (released) return;
        released = true;
        disposeBuildingGroup(group);
        group.removeFromParent();
        this.live.delete(visual);
      },
    };
    this.live.add(visual);
    return visual;
  }

  /** 释放一栋楼：只释放它自己的几何与实例，共享材质/贴图保持可用。 */
  release(visual: BuildingVisual): void {
    visual.dispose();
  }

  /** 整个预览页 / 场景销毁：先撤销在途请求，再释放共享资产。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    for (const token of this.pending) token.cancelled = true;
    this.pending.clear();
    for (const visual of [...this.live]) visual.dispose();
    this.live.clear();
    this.assets.dispose();
  }

  private ensureActive(token: RequestToken): void {
    if (!this.isActive(token)) throw new VisualLoadCancelled();
  }

  private isActive(token: RequestToken): boolean {
    return !this.disposed && !token.cancelled && token.generation === this.generation;
  }

  private async loadPieces(plan: ResolvedPlan): Promise<readonly ModelPiece[]> {
    const result: ModelPiece[] = [];
    // 阳台用金属栏杆时同样需要消防梯套件里的栏杆构件
    const needsFireEscape = plan.fireEscape || (plan.balcony.enabled && plan.balcony.kind === 'metal-rail');
    const needsUtilityBox = plan.utilityBoxes > 0 || plan.fireEscape;
    try {
      if (needsFireEscape) {
        result.push(...(await this.assets.loadPieces('fire-escape', FIRE_ESCAPE_PIECES)));
      }
      if (needsUtilityBox) {
        result.push(...(await this.assets.loadPieces('utility-box', UTILITY_BOX_PIECES)));
      }
    } catch (error) {
      // 外部模型失败时保留程序化外观（不含该外部构件），不阻断整栋楼的生成
      console.warn('[buildings] 外部模型加载失败，使用纯程序化外观', error);
    }
    return result;
  }
}

/**
 * 声明空间：只由规划尺寸与朝向决定（装饰已在规划阶段退让进这个范围内）。
 *
 * 旋转按 90° 整数倍精确换算；非直角朝向取旋转后矩形的最小外接 AABB（保守、稳定）。
 */
export function envelopeOf(request: BuildingVisualRequest): VisualBounds {
  const halfW = request.size.width / 2;
  const halfD = request.size.depth / 2;
  const rotation = request.rotationY ?? 0;
  const cos = Math.abs(Math.cos(rotation));
  const sin = Math.abs(Math.sin(rotation));
  const extentX = halfW * cos + halfD * sin;
  const extentZ = halfW * sin + halfD * cos;
  return {
    minX: request.position.x - extentX,
    maxX: request.position.x + extentX,
    minZ: request.position.z - extentZ,
    maxZ: request.position.z + extentZ,
    minY: 0,
    maxY: Math.max(0, request.size.height),
  };
}

/** 实际几何的世界包围盒（含实例构件），用于核对是否落在声明空间内。 */
export function measureWorldBounds(group: THREE.Object3D): VisualBounds {
  group.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(group);
  return {
    minX: box.min.x,
    maxX: box.max.x,
    minY: box.min.y,
    maxY: box.max.y,
    minZ: box.min.z,
    maxZ: box.max.z,
  };
}

/** 越界核对：任一方向超出即 `inside = false`，并给出超出量（米）。 */
export function compareBounds(declared: VisualBounds, actual: VisualBounds): VisualBoundsReport {
  const overflow = {
    x: Math.max(declared.minX - actual.minX, actual.maxX - declared.maxX, 0),
    y: Math.max(declared.minY - actual.minY, actual.maxY - declared.maxY, 0),
    z: Math.max(declared.minZ - actual.minZ, actual.maxZ - declared.maxZ, 0),
  };
  return {
    declared,
    actual,
    overflow,
    inside: overflow.x <= 0.001 && overflow.y <= 0.001 && overflow.z <= 0.001,
  };
}

/** 便捷组合：测量一栋实际建成的楼是否在声明空间内。 */
export function inspectVisual(visual: BuildingVisual): VisualBoundsReport {
  return compareBounds(visual.envelope, measureWorldBounds(visual.group));
}

/** 便于预览页统计三角形：整棵子树（含实例）。 */
export function trianglesOf(object: THREE.Object3D): number {
  let total = 0;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    const count = geometry.getIndex()?.count ?? geometry.getAttribute('position')?.count ?? 0;
    const instances = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
    total += (count / 3) * instances;
  });
  return Math.round(total);
}

/** 供调用方构造请求时复用的风格类型再导出。 */
export type { BuildingStyleId };
