/**
 * 街区装配 —— 把 `BlockPlan` 变成场景对象，并负责本块资源的生命周期。
 *
 * 所有权约定：
 *  - 铺装、围墙的**合并几何**由本块拥有，释放时 `geometry.dispose()`；
 *  - 铺装/围墙/树木/家具的**材质与模型几何**来自 `SceneryAssetLibrary`，本块一律不释放；
 *  - 装饰楼体的合批几何由 `BuildingVisualFactory` 拥有，走 `factory.release`；
 *  - 实例化网格只释放自己的实例缓冲（`mesh.dispose()`），不碰共享几何。
 *
 * 同步策略：按块级指纹整块重建（块内楼体 ≤ 3 栋），不做块内逐栋 diff，
 * 避免"删一半留一半"的中间态与漏更新。
 */

import * as THREE from 'three';
import { CITY } from '../../content/config';
import { SCENERY_MODELS, SCENERY_TEXTURES, type SceneryModelKey } from '../../content/city-scenery';
import { type BuildingVisual, type BuildingVisualFactory, type BuildingVisualHandle } from '../buildings';
import { BuildingAssembly, metricBox } from '../buildings/geometry';
import type { SceneryAssetLibrary } from '../scenery/assets';
import { applySolidShadowFlags } from '../scene';
import type { BlockPlan, PropPlacement, Rect } from './plan';

export interface BlockCollider {
  readonly id: string;
  /** 所属块：抑制与删除时按此摘除。 */
  readonly blockId: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number;
  maxY: number;
}

export interface BlocksReport {
  readonly blocks: number;
  readonly pendingVisuals: number;
  readonly suppressed: readonly string[];
  readonly fallbacks: readonly string[];
  readonly props: number;
  readonly trees: number;
  readonly errors: readonly string[];
}

interface BlockEntry {
  readonly id: string;
  readonly plan: BlockPlan;
  readonly group: THREE.Group;
  readonly colliders: BlockCollider[];
  generation: number;
  pending: number;
  disposed: boolean;
  readonly decorVisuals: BuildingVisual[];
  /** 在途的楼体请求句柄：释放时必须 `cancel()`，避免过期结果继续占用工厂。 */
  readonly decorHandles: BuildingVisualHandle[];
  /** 楼体就绪前显示的占位体块（按楼体 id 索引）。 */
  readonly placeholders: Map<string, THREE.Mesh>;
  readonly modelMeshes: THREE.InstancedMesh[];
}

export class CityBlocks {
  private readonly entries = new Map<string, BlockEntry>();
  private readonly suppressed = new Set<string>();
  private readonly fallbacks: string[] = [];
  private readonly errors: string[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly factory: BuildingVisualFactory,
    private readonly library: SceneryAssetLibrary,
  ) {}

  /** 当前生效的装饰碰撞盒（已排除被抑制的块）。 */
  get colliders(): readonly BlockCollider[] {
    const list: BlockCollider[] = [];
    for (const entry of this.entries.values()) {
      if (this.suppressed.has(entry.id)) continue;
      list.push(...entry.colliders);
    }
    return list;
  }

  get suppressedIds(): readonly string[] {
    return [...this.suppressed];
  }

  get pendingCount(): number {
    let pending = 0;
    for (const entry of this.entries.values()) pending += entry.pending;
    return pending;
  }

  report(): BlocksReport {
    let props = 0;
    let trees = 0;
    for (const entry of this.entries.values()) {
      props += entry.plan.props.length;
      trees += entry.plan.trees.length;
    }
    return {
      blocks: this.entries.size,
      pendingVisuals: this.pendingCount,
      suppressed: [...this.suppressed],
      fallbacks: [...this.fallbacks],
      props,
      trees,
      errors: [...this.errors],
    };
  }

  /** 命中的装饰块 id（旧档恢复用；已排除被抑制的块）。 */
  hitBlockIdsAt(x: number, z: number, radius: number): string[] {
    const hits: string[] = [];
    for (const collider of this.colliders) {
      if (
        x > collider.minX - radius &&
        x < collider.maxX + radius &&
        z > collider.minZ - radius &&
        z < collider.maxZ + radius
      ) {
        hits.push(collider.blockId);
      }
    }
    return [...new Set(hits)];
  }

  /**
   * 开始一次新的"世界显示会话"（读档 / 新游戏时由 World 调用）。
   *
   * 抑制记录只属于**当前这一份进度**：换存档或重新开始时必须清空，否则在 A 档里
   * 因玩家位置冲突被抑制的街区，会在 B 档里继续被跳过（验收复现过）。
   * 普通布局同步、公司绑定刷新、城区扩张都**不得**调用它，
   * 否则玩家仍站在冲突位置时，障碍会被重新建回来压在身上。
   */
  beginDisplaySession(): void {
    this.suppressed.clear();
  }

  /**
   * 抑制一个街区：只存在当前会话，不写任何存档。
   *
   * 走与删除完全相同的释放路径，保证几何与碰撞**同步**移除。
   */
  suppress(blockId: string): void {
    if (this.suppressed.has(blockId)) return;
    this.suppressed.add(blockId);
    const entry = this.entries.get(blockId);
    if (entry) {
      this.releaseEntry(entry);
      this.entries.delete(blockId);
    }
    this.errors.push(`suppressed:${blockId}`);
  }

  sync(plans: readonly BlockPlan[]): void {
    const desired = new Set(plans.map((plan) => plan.id));
    for (const [id, entry] of [...this.entries]) {
      if (!desired.has(id) || this.suppressed.has(id)) {
        this.releaseEntry(entry);
        this.entries.delete(id);
      }
    }
    for (const plan of plans) {
      const existing = this.entries.get(plan.id);
      if (existing && existing.plan.key === plan.key) continue;
      if (existing) {
        this.releaseEntry(existing);
        this.entries.delete(plan.id);
      }
      if (this.suppressed.has(plan.id)) continue;
      this.entries.set(plan.id, this.buildEntry(plan));
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) this.releaseEntry(entry);
    this.entries.clear();
  }

  /* -------------------------------------------------------------- 构建 */

  private buildEntry(plan: BlockPlan): BlockEntry {
    const group = new THREE.Group();
    group.name = plan.id;
    this.scene.add(group);

    const entry: BlockEntry = {
      id: plan.id,
      plan,
      group,
      generation: 0,
      pending: 0,
      disposed: false,
      decorVisuals: [],
      decorHandles: [],
      placeholders: new Map(),
      modelMeshes: [],
      colliders: plan.colliders.map((item) => ({
        id: item.id,
        blockId: plan.id,
        minX: item.rect.x0,
        maxX: item.rect.x1,
        minZ: item.rect.z0,
        maxZ: item.rect.z1,
        minY: item.minY,
        maxY: item.maxY,
      })),
    };

    this.buildPaving(entry);
    this.buildWalls(entry);
    this.loadDecor(entry);
    this.loadProps(entry);
    return entry;
  }

  /** 铺装：米制 UV 的薄盒，顶面标高来自配置；材质异步换成真实 PBR。 */
  private buildPaving(entry: BlockEntry): void {
    const placeholder = this.library.getSolidMaterial('soil');
    for (const spec of entry.plan.paving) {
      const width = spec.rect.x1 - spec.rect.x0;
      const depth = spec.rect.z1 - spec.rect.z0;
      const thickness = 0.08;
      const tileMeters = SCENERY_TEXTURES[spec.surface].tileMeters;
      const geometry = metricBox([width, thickness, depth], tileMeters);
      geometry.translate(
        (spec.rect.x0 + spec.rect.x1) / 2,
        CITY.surfaceTop.paving - thickness / 2,
        (spec.rect.z0 + spec.rect.z1) / 2,
      );
      const mesh = new THREE.Mesh(geometry, placeholder);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.userData.scenery = 'owned-geometry';
      mesh.name = spec.id;
      entry.group.add(mesh);
      void this.assignSurface(entry, mesh, spec.surface);
    }
  }

  private async assignSurface(
    entry: BlockEntry,
    mesh: THREE.Mesh,
    key: 'asphalt' | 'paving',
  ): Promise<void> {
    try {
      const material = await this.library.getSurfaceMaterial(key);
      if (entry.disposed || !mesh.parent) return;
      mesh.material = material;
    } catch (error) {
      this.errors.push(`paving-material:${key}`);
      console.warn('[blocks] 铺装材质加载失败，保留素色', error);
    }
  }

  private buildWalls(entry: BlockEntry): void {
    for (const spec of entry.plan.walls) {
      const material = this.library.getSolidMaterial(spec.kind === 'hedge' ? 'hedge' : 'wall');
      const width = spec.rect.x1 - spec.rect.x0;
      const depth = spec.rect.z1 - spec.rect.z0;
      const geometry = new THREE.BoxGeometry(width, spec.height, depth);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(
        (spec.rect.x0 + spec.rect.x1) / 2,
        spec.height / 2,
        (spec.rect.z0 + spec.rect.z1) / 2,
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.scenery = 'owned-geometry';
      mesh.name = spec.id;
      entry.group.add(mesh);
    }
  }

  /**
   * 装饰楼体：走既有工厂（共享墙面材质），异步返回后按代次校验再挂载。
   *
   * 占位策略（与业务楼同一套纪律）：**请求发起时就挂占位体块**，
   * 成功即移除，失败则保留 —— 任何时刻画面上的体量都与碰撞盒一致，
   * 不会出现"看不见的整栋障碍"，也不会出现"看得见但能穿过去"的楼。
   */
  private loadDecor(entry: BlockEntry): void {
    const generation = ++entry.generation;
    for (const spec of entry.plan.decor) {
      entry.pending += 1;
      this.buildDecorPlaceholder(entry, spec.id, spec.footprint, spec.size.height);
      const handle = this.factory.begin({
        buildingId: spec.id,
        styleId: spec.styleId,
        size: spec.size,
        position: spec.position,
        rotationY: spec.rotationY,
        blindFaces: spec.blindFaces,
        templateVersion: entry.plan.templateVersion,
      });
      entry.decorHandles.push(handle);
      handle.result
        .then((visual) => {
          if (entry.disposed || entry.generation !== generation || handle.cancelled) {
            this.factory.release(visual);
            return;
          }
          applySolidShadowFlags(visual.group);
          entry.group.add(visual.group);
          entry.decorVisuals.push(visual);
          this.removePlaceholder(entry, spec.id);
        })
        .catch((error: unknown) => {
          // 视觉失败：碰撞盒仍然生效（来自规划），占位体块留在原位，
          // 因此玩家看到的是"一栋素色楼"，不是可以穿过去的空气。
          this.fallbacks.push(`${entry.id}/${spec.id}`);
          this.errors.push(`decor:${spec.id}`);
          console.warn(`[blocks] 装饰楼体生成失败，保留占位体块：${spec.id}`, error);
        })
        .finally(() => {
          entry.pending = Math.max(0, entry.pending - 1);
        });
    }
  }

  /** 装饰楼体的占位体块：看得见的障碍，而不是看不见的墙。 */
  private buildDecorPlaceholder(entry: BlockEntry, id: string, rect: Rect, height: number): void {
    const material = this.library.getSolidMaterial('wall');
    const geometry = new THREE.BoxGeometry(rect.x1 - rect.x0, height, rect.z1 - rect.z0);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set((rect.x0 + rect.x1) / 2, height / 2, (rect.z0 + rect.z1) / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.scenery = 'owned-geometry';
    mesh.name = `${entry.id}-placeholder-${id}`;
    entry.group.add(mesh);
    entry.placeholders.set(id, mesh);
  }

  /** 楼体就绪：摘除占位并释放它自己的几何（材质归街景库，不动）。 */
  private removePlaceholder(entry: BlockEntry, id: string): void {
    const mesh = entry.placeholders.get(id);
    if (!mesh) return;
    entry.placeholders.delete(id);
    mesh.removeFromParent();
    mesh.geometry.dispose();
  }

  /** 街道家具与树木：按模型材质分组实例化。 */
  private loadProps(entry: BlockEntry): void {
    const generation = entry.generation;
    const groups = new Map<SceneryModelKey, PropPlacement[]>();
    for (const prop of entry.plan.props) {
      const list = groups.get(prop.key);
      if (list) list.push(prop);
      else groups.set(prop.key, [prop]);
    }
    if (entry.plan.trees.length > 0) {
      const list = groups.get('street-tree');
      if (list) list.push(...entry.plan.trees);
      else groups.set('street-tree', [...entry.plan.trees]);
    }

    for (const [key, list] of groups) {
      // 程序化家具（石凳）：不进模型加载流程，就地生成几何
      if (SCENERY_MODELS[key].procedural) {
        this.buildProceduralProp(entry, key, list);
        continue;
      }
      entry.pending += 1;
      this.library
        .getModel(key)
        .then((asset) => {
          if (entry.disposed || entry.generation !== generation) return;
          for (const piece of asset.pieces) {
            const mesh = new THREE.InstancedMesh(piece.geometry, piece.material, list.length);
            const matrix = new THREE.Matrix4();
            const quaternion = new THREE.Quaternion();
            const scale = new THREE.Vector3(1, 1, 1);
            const position = new THREE.Vector3();
            const axis = new THREE.Vector3(0, 1, 0);
            list.forEach((prop, index) => {
              quaternion.setFromAxisAngle(axis, prop.rotationY);
              position.set(prop.x, 0, prop.z);
              matrix.compose(position, quaternion, scale);
              mesh.setMatrixAt(index, matrix);
            });
            mesh.instanceMatrix.needsUpdate = true;
            /*
             * 路灯不投影：灯杆是细长构件，投出的影子几乎看不出形状，
             * 但全城几十盏灯在阴影 pass 里就是实打实的几十万三角面。
             * 树仍投影（树影是街景可读性的一部分）。
             */
            mesh.castShadow = key !== 'street-lamp';
            mesh.receiveShadow = true;
            // 实例矩阵写完后算一次包围球，让视锥剔除真正生效
            mesh.computeBoundingSphere();
            mesh.frustumCulled = true;
            mesh.userData.scenery = 'shared-geometry';
            mesh.name = `${entry.id}-${key}`;
            entry.group.add(mesh);
            entry.modelMeshes.push(mesh);
          }
        })
        .catch((error: unknown) => {
          this.fallbacks.push(`${entry.id}/${key}`);
          this.errors.push(`prop:${key}`);
          console.warn(`[blocks] 街景模型加载失败：${key}`, error);
        })
        .finally(() => {
          entry.pending = Math.max(0, entry.pending - 1);
        });
    }
  }

  /**
   * 程序化街道家具：石凳（座板 + 两侧支墩）。
   *
   * 不加载模型，也不计入外部素材；几何由本块拥有，材质来自街景库的素色材质。
   */
  private buildProceduralProp(entry: BlockEntry, key: SceneryModelKey, list: readonly PropPlacement[]): void {
    const material = this.library.getSolidMaterial('curb');
    const assembly = new BuildingAssembly();
    for (const prop of list) {
      // 与规划器同一个判据：长轴是否已转到 Z 向（`propFootprint` 用的是 |cos| / |sin| 跨度）
      const rotated = Math.abs(Math.cos(prop.rotationY)) < Math.abs(Math.sin(prop.rotationY));
      const length = 1.85;
      const depth = 0.55;
      const size: [number, number, number] = rotated ? [depth, 0.1, length] : [length, 0.1, depth];
      const along: [number, number, number] = rotated ? [0, 0, 0.65] : [0.65, 0, 0];
      assembly.box(material, size, [prop.x, 0.42, prop.z], 1);
      for (const sign of [-1, 1]) {
        const leg: [number, number, number] = rotated ? [depth, 0.42, 0.14] : [0.14, 0.42, depth];
        assembly.box(
          material,
          leg,
          [prop.x + sign * (rotated ? 0 : along[0]), 0.21, prop.z + sign * (rotated ? along[2] : 0)],
          1,
        );
      }
    }
    const built = assembly.build();
    for (const child of built.children) {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) continue;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.scenery = 'owned-geometry';
      mesh.name = `${entry.id}-${key}`;
      entry.group.add(mesh);
    }
  }

  /* -------------------------------------------------------------- 释放 */

  /**
   * 释放一个街区：标记失效 → 取消在途请求并释放装饰楼体（工厂共享材质不动）→
   * 摘除并释放本块自有几何（含仍显示的占位体块）→ 实例网格只释放实例缓冲。
   */
  private releaseEntry(entry: BlockEntry): void {
    entry.disposed = true;
    entry.generation += 1;
    // 在途句柄必须显式取消：否则过期结果仍会在工厂里排队、结算后才发现块已消失
    for (const handle of entry.decorHandles) handle.cancel();
    entry.decorHandles.length = 0;
    for (const visual of entry.decorVisuals) this.factory.release(visual);
    entry.decorVisuals.length = 0;
    entry.group.removeFromParent();
    disposeBlockGroup(entry.group);
    entry.placeholders.clear();
    entry.modelMeshes.length = 0;
  }
}

/**
 * 释放街区自有几何。
 *
 * 与 `disposeObject` 的区别：**只释放本块拥有的几何**，跳过共享几何与全部材质/贴图；
 * 实例网格只 `dispose()` 自己的实例缓冲。
 */
export function disposeBlockGroup(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const instanced = mesh as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) {
      instanced.dispose();
      return;
    }
    if (mesh.userData.scenery === 'owned-geometry') mesh.geometry.dispose();
  });
  root.clear();
}
