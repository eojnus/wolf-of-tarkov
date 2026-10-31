/**
 * 渲染任务共享接口（A 包定义，B/C/D 只读依赖）。
 *
 * 边界：
 *  - 本文件不加载资源、不建 WebGL 上下文，只有类型与纯工具函数；
 *  - 各任务模块只导出 `task`，由 `main.ts` 统一调度；
 *  - 所有分辨率/相机/时间参数必须显式，任务不得自造默认值后不写进报告。
 */

import * as THREE from 'three';

export type ModelFormat = 'glb' | 'gltf' | 'usdz';

export type Severity = 'info' | 'warning' | 'error';

export interface Diagnostic {
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

/** 由 CLI 写入 URL query 的唯一请求对象；渲染页不读取其他来源。 */
export interface ToolRequest {
  readonly schemaVersion: 1;
  readonly command: string;
  /** 模型绝对路径；无模型命令为 null。 */
  readonly input: string | null;
  /** 输入文件 SHA-256（大写十六进制）；无模型时为 null。 */
  readonly inputSha256: string | null;
  /** 输入文件字节数；无模型时为 null。 */
  readonly inputSize: number | null;
  /** 已由 CLI 校验并创建的输出目录绝对路径。 */
  readonly outDir: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** 允许被访问的模型根目录（模型所在目录）；无模型时为 null。 */
  readonly allowedRoot: string | null;
  /** 持久输出的授权工作区（game2）；所有 output 必须位于其内。 */
  readonly authorizedRoot: string;
  /**
   * 文件声明的资源摘要（目前只有 GLB 由 CLI 侧只读 JSON chunk 得到）；
   * 为 null 表示该命令/格式没有清单，报告必须写 unknown 而不是 0。
   */
  readonly declaredResources?: DeclaredResourceSummary | null;
  /** CLI 工具版本；渲染页报告使用。 */
  readonly toolVersion?: string;
  /** 项目 `public/assets` 的绝对路径，仅游戏角色/碰撞任务使用。 */
  readonly gameAssetsDir: string;
  /** 项目根绝对路径，报告中的相对来源说明用。 */
  readonly projectRoot: string;
}

export interface LoadedAsset {
  readonly root: THREE.Object3D;
  readonly clips: readonly THREE.AnimationClip[];
  readonly format: ModelFormat;
  /** 加载阶段收集的缺失依赖、拒绝的越界引用等（已按类别聚合，见 details.count）。 */
  readonly loadDiagnostics: readonly Diagnostic[];
  /** 加载阶段实际发出的请求与失败的请求；用于区分「声明」「成功」「失败」「未知」。 */
  readonly loads: AssetLoadRecord;
  dispose(): void;
}

/** 一次加载过程中，经 THREE.LoadingManager 走过的 URL。 */
export interface AssetLoadItem {
  readonly url: string;
  readonly category: 'model' | 'texture' | 'buffer' | 'other';
}

export interface AssetLoadRecord {
  /** 去重后的请求 URL；blob: 是临时地址，data: 包含内联内容，均不是稳定资源路径。 */
  readonly started: readonly AssetLoadItem[];
  readonly failed: readonly AssetLoadItem[];
}

/**
 * 文件自身声明的资源摘要（不包含运行时结果）。
 * 字段为 null 表示无法确认，绝不写 0 冒充「没有」。
 */
export interface DeclaredResourceSummary {
  readonly source: 'glb-json' | 'gltf-json' | 'unavailable';
  readonly images: number | null;
  readonly textures: number | null;
  readonly materials: number | null;
  readonly buffers: number | null;
  readonly animations?: number | null;
  readonly imagesEmbedded: number | null;
  readonly imagesDataUri: number | null;
  readonly imagesExternal: number | null;
  readonly imagesLocalFile: number | null;
  readonly imagesWithoutSource: number | null;
  readonly invalidBufferViews: number | null;
  readonly embeddedImageBytes?: number | null;
  readonly mimeTypes: Record<string, number> | null;
  readonly skippedImages?: number | null;
  readonly imageNameSamples?: ReadonlyArray<{ index: number; name: string; mimeType: string | null }>;
  readonly notes: readonly string[];
  readonly error?: { code: string; message: string } | null;
}

/** 材质里贴图槽位的实际使用情况（与文件声明的图片/纹理不是一一对应）。 */
export interface TextureUsage {
  /** 材质实际引用的不同 THREE.Texture 对象数。 */
  readonly textureObjects: number;
  /** 其中真正带 image 数据的数量。 */
  readonly texturesWithImage: number;
  /** 材质上贴图槽位引用次数（同一纹理可被多个槽位/材质引用）。 */
  readonly materialTextureSlots: number;
}

export interface RenderFrame {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly width: number;
  readonly height: number;
  /** 渲染一帧并返回 PNG 的 base64（不含 data: 前缀）。 */
  capture(): Promise<string>;
  setBackground(hex: number): void;
  useDefaultLights(): void;
  /** 实际 WebGL 后端描述；拿不到时返回 null，绝不猜。 */
  backendInfo(): { vendor: string | null; renderer: string | null; version: string | null };
}

export interface TaskTools {
  /** 加载请求里的模型（或显式路径，仍受 allowedRoot 约束）。带缓存。 */
  load(input?: string): Promise<LoadedAsset>;
  /** 懒创建唯一的 WebGL 帧；同一任务内尺寸固定。 */
  frame(width?: number, height?: number): Promise<RenderFrame>;
  /** 把 base64 PNG 写入输出目录下的相对路径，返回绝对路径。 */
  writePng(relPath: string, base64: string): Promise<string>;
  /** 任意二进制（base64）写入输出目录，仅用于派生资产；不覆盖已存在文件。 */
  writeBinary(relPath: string, base64: string): Promise<string>;
  /** 文本写入输出目录（报告片段、映射表）；不覆盖已存在文件。 */
  writeText(relPath: string, text: string): Promise<string>;
  /** 读取已授权的输入旁文件（如许可、同名配置），越界直接抛错。 */
  readSibling(relPath: string): Promise<string>;
  readonly diagnostics: Diagnostic[];
  info(code: string, message: string, details?: Record<string, unknown>): void;
  warn(code: string, message: string, details?: Record<string, unknown>): void;
  fail(code: string, message: string, details?: Record<string, unknown>): void;
  /** 游戏资源目录下的相对 URL（`modeltool://app/assets/...`）。 */
  gameAssetUrl(relPath: string): string;
}

export interface TaskOutput {
  readonly data: Record<string, unknown>;
  /**
   * 任务级结果：默认 ok；partial 表示报告已生成但资源/映射不完整。
   * 这只描述命令结果，不等于业务可用性。
   */
  readonly status?: 'ok' | 'partial';
}

/**
 * 任务级失败：携带架构文档固定的退出码语义，由 `main.ts` 统一转成 envelope。
 * 2 参数错误 / 3 格式或操作不支持 / 4 输入输出或权限 / 5 处理失败 / 6 结果不完整。
 */
export class TaskError extends Error {
  readonly code: string;
  readonly exitCode: 2 | 3 | 4 | 5 | 6;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    exitCode: 2 | 3 | 4 | 5 | 6 = 5,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TaskError';
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export type Task = (tools: TaskTools, request: ToolRequest) => Promise<TaskOutput>;

/* ------------------------------------------------------------------ 数字 */

export function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function finite(value: number): number | null {
  return Number.isFinite(value) ? round(value) : null;
}

export function vectorJson(v: THREE.Vector3): { x: number; y: number; z: number } {
  return { x: round(v.x), y: round(v.y), z: round(v.z) };
}

export function boxJson(box: THREE.Box3): {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
  center: { x: number; y: number; z: number };
  isEmpty: boolean;
} {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  return {
    min: vectorJson(box.min),
    max: vectorJson(box.max),
    size: vectorJson(size),
    center: vectorJson(center),
    isEmpty: box.isEmpty(),
  };
}

/* ------------------------------------------------------------- 场景工具 */

/** 与游戏一致的固定三点光照，只为可复现，不代表游戏内环境光。 */
export function applyDefaultLights(scene: THREE.Scene): void {
  const ambient = new THREE.AmbientLight(0xffffff, 1.6);
  ambient.name = 'model-tool-ambient';
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.name = 'model-tool-key';
  key.position.set(3.2, 5.4, 4.1);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbfd4ff, 0.8);
  fill.name = 'model-tool-fill';
  fill.position.set(-4.0, 2.6, -3.2);
  scene.add(fill);
}

/** 按包围球把相机放到确定性视角；azimuth/elevation 为角度。 */
export function frameCamera(
  camera: THREE.PerspectiveCamera,
  box: THREE.Box3,
  azimuthDeg: number,
  elevationDeg: number,
  padding = 1.18,
): { distance: number; target: THREE.Vector3 } {
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.05);
  const vFov = (camera.fov * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const fov = Math.min(vFov, hFov);
  const distance = (radius * padding) / Math.sin(fov / 2);
  const azimuth = (azimuthDeg * Math.PI) / 180;
  const elevation = (elevationDeg * Math.PI) / 180;
  const target = sphere.center.clone();
  const offset = new THREE.Vector3(
    Math.sin(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    Math.cos(azimuth) * Math.cos(elevation),
  ).multiplyScalar(distance);
  camera.position.copy(target).add(offset);
  camera.near = Math.max(0.01, distance - radius * 4);
  camera.far = distance + radius * 8;
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return { distance: round(distance), target };
}

/**
 * 递归释放一棵子树拥有的几何/材质/贴图。
 * 只处理该子树实际引用到的资源，不触碰环境与共享光照。
 */
export function disposeSubtree(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}

/** 统计子树里的网格/三角面/材质/贴图/骨骼；未知一律返回 0 由调用方另报。 */
export function inspectSubtree(root: THREE.Object3D): {
  meshes: number;
  skinnedMeshes: number;
  triangles: number;
  vertices: number;
  materials: number;
  textures: number;
  bones: number;
  clips: number;
} {
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const bones = new Set<THREE.Bone>();
  let meshes = 0;
  let skinnedMeshes = 0;
  let triangles = 0;
  let vertices = 0;

  root.traverse((child) => {
    const bone = child as THREE.Bone;
    if (bone.isBone) bones.add(bone);
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes += 1;
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) skinnedMeshes += 1;
    const geometry = mesh.geometry;
    if (geometry) {
      const position = geometry.getAttribute('position');
      if (position) vertices += position.count;
      const index = geometry.getIndex();
      triangles += index ? index.count / 3 : (position ? position.count / 3 : 0);
    }
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });

  return {
    meshes,
    skinnedMeshes,
    triangles: Math.round(triangles),
    vertices,
    materials: materials.size,
    textures: textures.size,
    bones: bones.size,
    clips: 0,
  };
}

/** 统计材质上的贴图槽位与贴图对象；用于区分「声明」「加载成功」「失败」。 */
export function textureUsageOf(root: THREE.Object3D): TextureUsage {
  const textures = new Set<THREE.Texture>();
  let materialTextureSlots = 0;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      if (!material) continue;
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        if (value instanceof THREE.Texture) {
          textures.add(value);
          materialTextureSlots += 1;
        }
      }
    }
  });
  let texturesWithImage = 0;
  for (const texture of textures) {
    if (texture.image) texturesWithImage += 1;
  }
  return { textureObjects: textures.size, texturesWithImage, materialTextureSlots };
}

/** 片段摘要：名称、时长、轨道数与目标骨骼/节点名（去重后截断）。 */
export function clipSummary(clip: THREE.AnimationClip, maxTargets = 24): {
  name: string;
  duration: number;
  tracks: number;
  targets: string[];
  targetCount: number;
  loopHint: string | null;
} {
  const targets = new Set<string>();
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.');
    targets.add(dot > 0 ? track.name.slice(0, dot) : track.name);
  }
  const list = [...targets].sort();
  return {
    name: clip.name,
    duration: round(clip.duration),
    tracks: clip.tracks.length,
    targets: list.slice(0, maxTargets),
    targetCount: list.length,
    loopHint: null,
  };
}
