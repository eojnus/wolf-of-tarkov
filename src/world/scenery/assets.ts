/**
 * 街景资产库 —— 铺装贴图、街景材质与外部模型的**唯一**加载入口。
 *
 * 所有权契约（与建筑资产库同一套纪律，但**实例独立**）：
 *  - 贴图、材质、模型几何全部由本库**共享持有**，全城一份；
 *  - 街区/道路只持有自己的合并几何与实例矩阵，释放时**不得**碰本库的材质与贴图；
 *  - 只有 `library.dispose()` 才真正释放共享资源，且必须排在所有引用它的场景对象之后；
 *  - 同一 URL 只有一份在途 Promise，失败后移除缓存允许重试。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  SCENERY_MODELS,
  SCENERY_SOLIDS,
  SCENERY_TEXTURES,
  type SceneryModelKey,
  type ScenerySolidKey,
  type SceneryTextureKey,
} from '../../content/city-scenery';

/** 一个可实例化的构件：共享几何 + 共享材质。 */
export interface SceneryPiece {
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
  readonly triangles: number;
}

/**
 * 收集材质引用的全部贴图（漫反射/法线/粗糙度/金属度/AO/自发光/透明…）。
 *
 * 用属性遍历而不是逐个字段取值：glTF 导入的材质带哪些贴图由文件决定，
 * 逐个点名必然漏。调用方再用 `Set` 按**对象身份**去重。
 */
function collectTextures(material: THREE.Material, into: Set<THREE.Texture>): void {
  for (const value of Object.values(material)) {
    const texture = value as THREE.Texture | null;
    if (texture && (texture as THREE.Texture).isTexture) into.add(texture);
  }
}

/** 就地释放一棵 GLTF 场景树（只用于**从未被使用**的迟到结果）。 */
function disposeUnusedTree(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const item of list) {
      if (!item) continue;
      materials.add(item);
      collectTextures(item, textures);
    }
  });
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

/** 就地释放一个已构建的模型资产（迟到结果用）。 */
function disposeAsset(asset: SceneryModelAsset): void {
  const textures = new Set<THREE.Texture>();
  const materials = new Set<THREE.Material>();
  for (const piece of asset.pieces) {
    piece.geometry.dispose();
    materials.add(piece.material);
    collectTextures(piece.material, textures);
  }
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

export interface SceneryModelAsset {
  readonly key: SceneryModelKey;
  readonly pieces: readonly SceneryPiece[];
  /** 归一化后的世界尺寸（米）。 */
  readonly size: { readonly x: number; readonly y: number; readonly z: number };
  readonly triangles: number;
}

export class SceneryAssetLibrary {
  private readonly textureLoader = new THREE.TextureLoader();
  private readonly gltfLoader = new GLTFLoader();
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly texturePromises = new Map<string, Promise<THREE.Texture>>();
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private readonly materialPromises = new Map<string, Promise<THREE.MeshStandardMaterial>>();
  private readonly models = new Map<SceneryModelKey, SceneryModelAsset>();
  private readonly modelPromises = new Map<SceneryModelKey, Promise<SceneryModelAsset>>();
  private readonly failures: string[] = [];
  private disposed = false;

  /** 加载失败记录（诊断用，只增不减）。 */
  get failureList(): readonly string[] {
    return this.failures;
  }

  get materialCount(): number {
    return this.materials.size;
  }

  get textureCount(): number {
    return this.textures.size;
  }

  /* ------------------------------------------------------------ 贴图 */

  private loadTexture(url: string, srgb: boolean, repeat = true): Promise<THREE.Texture> {
    const key = `${url}|${srgb ? 'srgb' : 'linear'}`;
    const cached = this.textures.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = this.texturePromises.get(key);
    if (pending) return pending;

    const promise = this.textureLoader
      .loadAsync(url)
      .then((texture) => {
        texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        if (repeat) {
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
        }
        texture.anisotropy = 4;
        this.texturePromises.delete(key);
        // 销毁之后才到达的结果：就地释放，**不进入缓存**（否则这张图再也没人释放）
        if (this.disposed) {
          texture.dispose();
          return texture;
        }
        this.textures.set(key, texture);
        return texture;
      })
      .catch((error: unknown) => {
        this.texturePromises.delete(key);
        this.failures.push(`texture:${url}`);
        throw error;
      });
    this.texturePromises.set(key, promise);
    return promise;
  }

  /**
   * 取铺装材质（沥青 / 人行道）。
   *
   * ARM 打包图同时驱动粗糙度（G）与金属度（B），省掉两张独立贴图；
   * 贴图的米制循环由 `tileMeters` 决定，铺设时按真实尺寸写 UV（见 `blocks/scene.ts`）。
   */
  getSurfaceMaterial(key: SceneryTextureKey): Promise<THREE.MeshStandardMaterial> {
    const cacheKey = `surface:${key}`;
    const cached = this.materials.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    const pending = this.materialPromises.get(cacheKey);
    if (pending) return pending;

    const asset = SCENERY_TEXTURES[key];
    const promise = Promise.all([
      this.loadTexture(asset.diffuse, true),
      this.loadTexture(asset.normal, false),
      this.loadTexture(asset.arm, false),
    ])
      .then(([map, normalMap, arm]) => {
        if (this.disposed) throw new Error('[scenery] 资产库已销毁');
        const material = new THREE.MeshStandardMaterial({
          map,
          normalMap,
          roughnessMap: arm,
          metalnessMap: arm,
          roughness: 1,
          metalness: 1,
        });
        material.name = `scenery-${key}`;
        this.materialPromises.delete(cacheKey);
        this.materials.set(cacheKey, material);
        return material;
      })
      .catch((error: unknown) => {
        this.materialPromises.delete(cacheKey);
        throw error;
      });
    this.materialPromises.set(cacheKey, promise);
    return promise;
  }

  /** 取无贴图街景材质（路缘石、标线、围墙、绿篱、种植土）。 */
  getSolidMaterial(key: ScenerySolidKey): THREE.MeshStandardMaterial {
    if (this.disposed) throw new Error('[scenery] 资产库已销毁，不能再创建材质');
    const cacheKey = `solid:${key}`;
    const cached = this.materials.get(cacheKey);
    if (cached) return cached;
    const asset = SCENERY_SOLIDS[key];
    const material = new THREE.MeshStandardMaterial({
      color: asset.color,
      roughness: asset.roughness,
      metalness: asset.metalness,
    });
    material.name = `scenery-${key}`;
    this.materials.set(cacheKey, material);
    return material;
  }

  /* ------------------------------------------------------------ 模型 */

  /**
   * 取外部模型：按 `fit` 归一化（缩放到目标高度/长度），脚底贴地、水平居中，
   * 每个材质合并成一个共享几何，供 InstancedMesh 实例化。
   */
  getModel(key: SceneryModelKey): Promise<SceneryModelAsset> {
    const cached = this.models.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = this.modelPromises.get(key);
    if (pending) return pending;

    const promise = this.buildModel(key)
      .then((asset) => {
        if (this.disposed) {
          // 销毁之后才到达的模型：几何、材质、贴图全部就地释放，不进入缓存
          disposeAsset(asset);
          throw new Error('[scenery] 资产库已销毁，模型结果就地释放');
        }
        this.modelPromises.delete(key);
        this.models.set(key, asset);
        return asset;
      })
      .catch((error: unknown) => {
        this.modelPromises.delete(key);
        if (!this.disposed) this.failures.push(`model:${key}`);
        throw error;
      });
    this.modelPromises.set(key, promise);
    return promise;
  }

  private async buildModel(key: SceneryModelKey): Promise<SceneryModelAsset> {
    const spec = SCENERY_MODELS[key];
    const gltf = await this.gltfLoader.loadAsync(spec.url);
    if (this.disposed) {
      disposeUnusedTree(gltf.scene);
      throw new Error('[scenery] 资产库已销毁，模型结果丢弃');
    }

    const root = spec.node ? gltf.scene.getObjectByName(spec.node) : gltf.scene;
    if (!root) throw new Error(`[scenery] 模型 ${key} 中不存在节点 ${spec.node}`);
    root.updateWorldMatrix(true, true);

    // 以 root 自身为基准，把每个网格的世界变换烘进几何
    const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const local = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
      const geometry = mesh.geometry.clone();
      geometry.applyMatrix4(local);
      geometry.deleteAttribute('uv1');
      geometry.deleteAttribute('tangent');
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const list = buckets.get(material);
      if (list) list.push(geometry);
      else buckets.set(material, [geometry]);
    });
    if (buckets.size === 0) throw new Error(`[scenery] 模型 ${key} 不含网格`);

    // 合并同材质几何
    const merged: { material: THREE.Material; geometry: THREE.BufferGeometry }[] = [];
    for (const [material, list] of buckets) {
      // 属性集合必须一致才能合并：只保留 position / normal / uv
      const cleaned = list.map((geometry) => {
        const out = new THREE.BufferGeometry();
        out.setAttribute('position', geometry.getAttribute('position'));
        const normal = geometry.getAttribute('normal');
        if (normal) out.setAttribute('normal', normal);
        const uv = geometry.getAttribute('uv');
        if (uv) out.setAttribute('uv', uv);
        const index = geometry.getIndex();
        if (index) out.setIndex(index);
        return out;
      });
      const geometry = cleaned.length === 1 ? cleaned[0] : (mergeGeometries(cleaned, false) ?? cleaned[0]);
      // 这些几何是加载期的 CPU 副本，从未上传到 GPU：交给 GC，不做 dispose，
      // 否则会把合并结果仍在引用的属性一并释放。
      merged.push({ material, geometry });
    }

    // 归一化：按目标轴缩放，脚底贴地，水平居中
    const box = new THREE.Box3();
    for (const item of merged) {
      item.geometry.computeBoundingBox();
      const b = item.geometry.boundingBox;
      if (b) box.union(b);
    }
    const size = box.getSize(new THREE.Vector3());
    const target = spec.fit.axis === 'height' ? size.y : Math.max(size.x, size.z);
    const scale = target > 1e-4 ? spec.fit.meters / target : 1;
    const center = box.getCenter(new THREE.Vector3());
    const matrix = new THREE.Matrix4()
      .makeTranslation(-center.x, -box.min.y, -center.z)
      .premultiply(new THREE.Matrix4().makeScale(scale, scale, scale));

    const pieces: SceneryPiece[] = [];
    let triangles = 0;
    for (const item of merged) {
      item.geometry.applyMatrix4(matrix);
      item.geometry.computeBoundingBox();
      item.geometry.computeBoundingSphere();
      const index = item.geometry.getIndex();
      const count = index ? index.count : item.geometry.getAttribute('position').count;
      triangles += count / 3;
      pieces.push({ geometry: item.geometry, material: item.material, triangles: count / 3 });
    }

    const scaled = {
      x: size.x * scale,
      y: size.y * scale,
      z: size.z * scale,
    };
    return { key, pieces, size: scaled, triangles: Math.round(triangles) };
  }

  /* ------------------------------------------------------------ 释放 */

  /** 只在整场销毁、且所有引用本库的场景对象都释放之后调用。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // 贴图按**对象身份**去重：同一张图可能被多个材质、多个模型共用，
    // 逐个材质 dispose 会重复释放，漏掉又会残留 GPU 资源。
    const textures = new Set<THREE.Texture>();

    for (const material of this.materials.values()) {
      collectTextures(material, textures);
      material.dispose();
    }
    this.materials.clear();

    for (const texture of this.textures.values()) textures.add(texture);
    this.textures.clear();

    for (const asset of this.models.values()) {
      for (const piece of asset.pieces) {
        collectTextures(piece.material, textures);
        piece.geometry.dispose();
        piece.material.dispose();
      }
    }
    this.models.clear();

    for (const texture of textures) texture.dispose();

    // 在途表清空：迟到的结果会在各自的 then 里就地释放，绝不重新进入缓存
    this.texturePromises.clear();
    this.materialPromises.clear();
    this.modelPromises.clear();
  }
}
