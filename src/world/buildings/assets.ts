/**
 * 建筑视觉资产库 —— 贴图、GLB 模板、构件几何与共享材质的唯一加载入口。
 *
 * 生命周期契约（对应验收 R3 / R4）：
 *  - 贴图、GLB 模板、构件几何、材质全部由本库**共享持有**；
 *  - 一栋楼的 `dispose()` 只释放它自己的合批几何与实例矩阵，不碰这里的任何对象；
 *  - 只有 `library.dispose()`（整个预览页 / 场景销毁）才真正释放共享资源；
 *  - **同一 URL 的贴图、同一模型同一构件的抽取，都只有一份在途 Promise**：
 *    并发请求共享结果，不会各自克隆后再相互覆盖；
 *  - 任何失败都会把对应的在途项从缓存移除，下一次请求可以重试；失败次数如实记录；
 *  - 材质组同样按「真实材质参数」缓存，失败后移除，允许重试；半成品材质就地释放。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  VISUAL_MODELS,
  VISUAL_TEXTURES,
  type BuildingStyle,
  type FacadeTextureKey,
  type VisualModelAsset,
} from '../../content/building-visuals';

export interface TextureSet {
  readonly diffuse: THREE.Texture;
  readonly normal: THREE.Texture;
  readonly arm: THREE.Texture;
  readonly tileMeters: number;
}

/** 外部模型的一个可复用构件（已换算到节点自身的局部坐标）。 */
export interface ModelPiece {
  readonly name: string;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
  readonly bounds: THREE.Box3;
}

export interface BuildingMaterials {
  readonly wall: THREE.MeshStandardMaterial;
  readonly trim: THREE.MeshStandardMaterial;
  readonly glass: THREE.MeshStandardMaterial;
  readonly frame: THREE.MeshStandardMaterial;
  readonly accent: THREE.MeshStandardMaterial;
  readonly roof: THREE.MeshStandardMaterial;
  /** 雨棚底面灯带：唯一带自发光的材质，白天天光下也仍可辨认。 */
  readonly lamp: THREE.MeshStandardMaterial;
  /** 主墙体贴图一次循环覆盖的米数（米制 UV 用）。 */
  readonly wallTileMeters: number;
  readonly accentTileMeters: number;
}

export class VisualAssetLibrary {
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly texturePromises = new Map<string, Promise<THREE.Texture>>();
  private readonly models = new Map<string, THREE.Object3D>();
  private readonly modelPromises = new Map<string, Promise<THREE.Object3D>>();
  /** 构件按「模型 id + 节点名」缓存，一个构件只有一份几何。 */
  private readonly pieces = new Map<string, ModelPiece>();
  private readonly piecePromises = new Map<string, Promise<ModelPiece>>();
  private readonly materials = new Map<string, Promise<BuildingMaterials>>();
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly loader = new GLTFLoader();
  private readonly textureLoader = new THREE.TextureLoader();
  private disposed = false;
  /** 加载失败记录（供报告与调试；不吞掉错误，调用方仍会收到异常或明确的降级）。 */
  readonly failures: string[] = [];

  get textureCount(): number {
    return this.textures.size;
  }

  get modelCount(): number {
    return this.models.size;
  }

  get pieceCount(): number {
    return this.pieces.size;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  loadTexture(url: string, srgb: boolean): Promise<THREE.Texture> {
    const existing = this.textures.get(url);
    if (existing) return Promise.resolve(existing);
    const pending = this.texturePromises.get(url);
    if (pending) return pending;

    const promise = this.textureLoader
      .loadAsync(url)
      .then((texture) => {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        texture.anisotropy = 4;
        this.texturePromises.delete(url);
        if (this.disposed) {
          // 资产库已销毁：这次加载的结果无人持有，直接释放，避免悬空资源
          texture.dispose();
          throw new Error('[buildings] 资产库已销毁，贴图结果丢弃');
        }
        this.textures.set(url, texture);
        return texture;
      })
      .catch((error: unknown) => {
        this.texturePromises.delete(url);
        this.failures.push(`texture:${url}`);
        throw error;
      });
    this.texturePromises.set(url, promise);
    return promise;
  }

  async loadTextureSet(key: FacadeTextureKey): Promise<TextureSet> {
    const asset = VISUAL_TEXTURES[key];
    const [diffuse, normal, arm] = await Promise.all([
      this.loadTexture(asset.diffuse, true),
      this.loadTexture(asset.normal, false),
      this.loadTexture(asset.arm, false),
    ]);
    return { diffuse, normal, arm, tileMeters: asset.tileMeters };
  }

  /** GLB 模板：只加载一次，返回共享模板本体（调用方不得直接挂到场景里改位置）。 */
  loadModel(id: VisualModelAsset['id']): Promise<THREE.Object3D> {
    const existing = this.models.get(id);
    if (existing) return Promise.resolve(existing);
    const pending = this.modelPromises.get(id);
    if (pending) return pending;

    const url = VISUAL_MODELS[id].url;
    const promise = this.loader
      .loadAsync(url)
      .then((gltf) => {
        this.modelPromises.delete(id);
        if (this.disposed) {
          disposeTemplate(gltf.scene);
          throw new Error('[buildings] 资产库已销毁，模型结果丢弃');
        }
        gltf.scene.updateMatrixWorld(true);
        adaptPbrForScene(gltf.scene);
        this.models.set(id, gltf.scene);
        return gltf.scene;
      })
      .catch((error: unknown) => {
        this.modelPromises.delete(id);
        this.failures.push(`model:${id}`);
        throw error;
      });
    this.modelPromises.set(id, promise);
    return promise;
  }

  /**
   * 抽取单个构件几何（已烘焙节点自身变换）。
   *
   * 同一个「模型 + 节点名」只有一份在途 Promise 与一份结果：
   * 两栋楼并发需要同一段栏杆时共享同一次抽取，不会各自克隆后再相互覆盖。
   */
  loadPiece(id: VisualModelAsset['id'], name: string): Promise<ModelPiece> {
    const key = `${id}/${name}`;
    const cached = this.pieces.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = this.piecePromises.get(key);
    if (pending) return pending;

    const promise = this.extractPiece(id, name, key)
      .then((piece) => {
        this.piecePromises.delete(key);
        this.pieces.set(key, piece);
        return piece;
      })
      .catch((error: unknown) => {
        this.piecePromises.delete(key);
        this.failures.push(`piece:${key}`);
        throw error;
      });
    this.piecePromises.set(key, promise);
    return promise;
  }

  private async extractPiece(id: VisualModelAsset['id'], name: string, key: string): Promise<ModelPiece> {
    const template = await this.loadModel(id);
    if (this.disposed) throw new Error('[buildings] 资产库已销毁，构件抽取取消');
    const node = template.getObjectByName(name);
    if (!node) throw new Error(`[buildings] 模型 ${id} 中不存在构件 ${name}`);

    node.updateWorldMatrix(true, true);
    const inverse = new THREE.Matrix4().copy(node.matrixWorld).invert();
    let result: ModelPiece | null = null;
    node.traverse((child) => {
      if (result) return;
      if (!(child as THREE.Mesh).isMesh) return;
      const mesh = child as THREE.Mesh;
      const local = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
      const geometry = mesh.geometry.clone();
      geometry.applyMatrix4(local);
      geometry.computeBoundingBox();
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      result = {
        name,
        geometry,
        material,
        bounds: geometry.boundingBox?.clone() ?? new THREE.Box3(),
      };
    });

    if (!result) throw new Error(`[buildings] 构件 ${key} 不含网格`);
    const piece: ModelPiece = result;
    if (this.disposed) {
      // 抽取期间资产库被销毁：结果无人持有，释放后拒绝
      piece.geometry.dispose();
      throw new Error('[buildings] 资产库已销毁，构件结果丢弃');
    }
    return piece;
  }

  /**
   * 取一批构件；缺失或失败的构件会被记录并跳过（调用方按 `has()` 做程序化降级），
   * 不会返回与请求无关的缓存内容。
   */
  async loadPieces(id: VisualModelAsset['id'], names: readonly string[]): Promise<readonly ModelPiece[]> {
    const settled = await Promise.all(
      names.map((name) =>
        this.loadPiece(id, name).catch(() => {
          console.warn(`[buildings] 构件缺失，改用程序化做法：${id}/${name}`);
          return null;
        }),
      ),
    );
    const pieces: ModelPiece[] = [];
    for (const piece of settled) {
      if (piece) pieces.push(piece);
    }
    return pieces;
  }

  /**
   * 按真实材质参数取材质组：`key` 由贴图 id + 配色 + 亮度派生（见 `plan.materialKey`），
   * 因此不同参数不会误用同一份材质，相同参数也不会重复创建。
   *
   * 失败时移除缓存并释放这次已创建的半成品材质，允许下一次重试。
   */
  getMaterials(key: string, style: BuildingStyle): Promise<BuildingMaterials> {
    const cached = this.materials.get(key);
    if (cached) return cached;
    const promise = this.createMaterials(style).catch((error: unknown) => {
      this.materials.delete(key);
      throw error;
    });
    this.materials.set(key, promise);
    return promise;
  }

  private async createMaterials(style: BuildingStyle): Promise<BuildingMaterials> {
    const wallSet = await this.loadTextureSet(style.textures.wall);
    const accentSet = style.textures.accent ? await this.loadTextureSet(style.textures.accent) : wallSet;

    // 本次尝试创建的材质先记在本地，成功后才登记为库持有；失败时当场释放
    const local: THREE.Material[] = [];
    const keep = <T extends THREE.Material>(material: T): T => {
      local.push(material);
      return material;
    };

    const textured = (
      set: TextureSet,
      tint: number,
      roughness: number,
      metalness: number,
      brightness = 1,
    ): THREE.MeshStandardMaterial => {
      const color = new THREE.Color(tint);
      if (brightness > 1) color.multiplyScalar(brightness);
      return keep(
        new THREE.MeshStandardMaterial({
          color,
          map: set.diffuse,
          normalMap: set.normal,
          roughnessMap: set.arm,
          metalnessMap: set.arm,
          roughness,
          metalness,
        }),
      );
    };

    const plain = (color: number, roughness: number, metalness: number): THREE.MeshStandardMaterial =>
      keep(new THREE.MeshStandardMaterial({ color, roughness, metalness }));

    try {
      const glass = keep(
        // 场景没有环境贴图：金属度高的玻璃会直接发黑，这里用低金属度 + 轻微自发光模拟天光反射
        new THREE.MeshStandardMaterial({
          color: style.palette.glassTint,
          roughness: 0.22,
          metalness: 0.1,
          transparent: true,
          opacity: 0.86,
          emissive: new THREE.Color(0x2a4250),
          emissiveIntensity: 0.42,
        }),
      );

      const lamp = keep(
        new THREE.MeshStandardMaterial({
          color: 0xfff1d6,
          roughness: 0.35,
          metalness: 0,
          emissive: new THREE.Color(0xffdca8),
          emissiveIntensity: 0.9,
        }),
      );

      const materials: BuildingMaterials = {
        wall: textured(wallSet, style.palette.wallTint, 0.92, 0.02, style.palette.brightness),
        trim: textured(wallSet, style.palette.trimTint, 0.86, 0.04, Math.min(style.palette.brightness, 1.2)),
        glass,
        frame: plain(style.palette.frameTint, 0.52, 0.55),
        accent: textured(accentSet, style.palette.accentTint, 0.8, 0.06, style.palette.brightness),
        roof: textured(wallSet, style.palette.trimTint, 0.95, 0.03, Math.min(style.palette.brightness, 1.1)),
        lamp,
        wallTileMeters: wallSet.tileMeters,
        accentTileMeters: accentSet.tileMeters,
      };

      if (this.disposed) throw new Error('[buildings] 资产库已销毁，材质结果丢弃');
      for (const material of local) this.ownedMaterials.push(material);
      return materials;
    } catch (error) {
      for (const material of local) material.dispose();
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
    this.texturePromises.clear();
    for (const piece of this.pieces.values()) piece.geometry.dispose();
    this.pieces.clear();
    this.piecePromises.clear();
    for (const model of this.models.values()) disposeTemplate(model);
    this.models.clear();
    this.modelPromises.clear();
    for (const material of this.ownedMaterials) material.dispose();
    this.ownedMaterials.length = 0;
    this.materials.clear();
  }
}

/**
 * 外部 PBR 材质适配 —— 场景没有环境贴图（IBL）时，金属度接近 1 的材质会渲染成纯黑。
 *
 * 金属度上限压到 0.32、粗糙度下限提到 0.45，让镀锌钢在半球光 + 平行光下
 * 仍有可辨认的高光与质感；贴图本身的颜色与法线保持不变。属于表现层近似，
 * 不改变资源内容，接入 IBL 后可去掉这一层。
 */
function adaptPbrForScene(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const standard = material as THREE.MeshStandardMaterial;
      if (typeof standard.metalness === 'number') standard.metalness = Math.min(standard.metalness, 0.32);
      if (typeof standard.roughness === 'number') standard.roughness = Math.max(standard.roughness, 0.45);
      standard.envMapIntensity = 0.4;
    }
  });
}

/** 释放 GLB 模板自带的几何、材质与贴图（模板由资产库独占，可以整棵释放）。 */
function disposeTemplate(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const standard = material as THREE.MeshStandardMaterial;
      standard.map?.dispose();
      standard.normalMap?.dispose();
      standard.roughnessMap?.dispose();
      standard.metalnessMap?.dispose();
      standard.aoMap?.dispose();
      material.dispose();
    }
  });
}
