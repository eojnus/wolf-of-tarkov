/**
 * 建筑原型预览（开发用，不进正式游戏入口）。
 *
 * 用途：
 *  - 在同一套光照/相机/视口下，把三种风格按**给定规划尺寸**生成的建筑与「普通几何基线」对比；
 *  - 显示声明空间与实际几何的越界核对结果（R2 的可视证据）；
 *  - 提供可复现的性能采样（draw calls / 三角形 / 几何与贴图数量 / frame time 分位）
 *    与纹理显存估算；
 *  - 页面调用的是 `world/buildings` 的生产工厂，不存在第二套演示实现。
 *
 * 地址参数：`?mode=prototype|baseline`、`?view=ground|aerial|closeup|...`、`?dpr=1`、`?ui=0`。
 * 自动化入口：`window.__prototype`（见 `PrototypeApi`）。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BUILDING_STYLES, type BuildingStyleId } from '../content/building-visuals';
import {
  BuildingVisualFactory,
  VisualLoadCancelled,
  inspectVisual,
  type BuildingVisual,
  type BuildingVisualHandle,
  type VisualBoundsReport,
} from '../world/buildings';

type Mode = 'prototype' | 'baseline';
type ViewId =
  | 'ground'
  | 'aerial'
  | 'closeup'
  | 'closeup-apartment'
  | 'closeup-office'
  | 'entrance'
  | 'rear-office'
  | 'escape'
  | 'balcony';

interface ViewPreset {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}

const VIEWS: Readonly<Record<ViewId, ViewPreset>> = {
  ground: { position: [3, 3.2, 84], target: [3, 12, 0] },
  aerial: { position: [3, 62, 80], target: [3, 8, 0] },
  closeup: { position: [-17, 10, 24], target: [-34, 9, 0] },
  'closeup-apartment': { position: [15, 14, 26], target: [2, 12, 0] },
  'closeup-office': { position: [56, 12, 30], target: [40, 15, 0] },
  entrance: { position: [40, 1.75, 24], target: [40, 4.2, 8] },
  'rear-office': { position: [74, 6, -32], target: [40, 12, -8] },
  escape: { position: [54, 7, -24], target: [45.5, 7, -8] },
  balcony: { position: [-29.5, 8.5, 15], target: [-35, 6, 4.2] },
};

interface Slot {
  readonly styleId: BuildingStyleId;
  /** 声明空间（对应 `LayoutBuilding.size`）。 */
  readonly size: { readonly width: number; readonly depth: number; readonly height: number };
  readonly x: number;
  readonly z: number;
  readonly templateVersion: number;
}

/** 三栋楼的规划尺寸：与正式地图无关，仅代表「同一个工厂按不同包络生成」。 */
const SLOTS: readonly Slot[] = [
  { styleId: 'residential-6', size: { width: 18.84, depth: 12, height: 19.4 }, x: -34, z: 0, templateVersion: 1 },
  { styleId: 'apartment-8', size: { width: 14.2, depth: 13, height: 26.1 }, x: 2, z: 0, templateVersion: 1 },
  { styleId: 'office-10', size: { width: 20, depth: 16, height: 38.5 }, x: 40, z: 0, templateVersion: 1 },
];

export interface FrameStats {
  readonly p50: number;
  readonly p95: number;
  readonly mean: number;
  readonly max: number;
}

export interface PrototypeSample {
  readonly mode: Mode;
  readonly view: ViewId;
  readonly frames: number;
  readonly seconds: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  readonly programs: number;
  readonly frameMs: FrameStats;
  /** 纹理显存估算（MiB）：Σ 宽 × 高 × 4 字节 × 1.34（含 mipmap 链），非 renderer.info 计数。 */
  readonly textureMiB: number;
  readonly viewport: { readonly width: number; readonly height: number; readonly dpr: number };
}

export interface PrototypeApi {
  readonly ready: Promise<void>;
  setMode(mode: Mode): Promise<void>;
  setView(view: ViewId): Promise<void>;
  setSize(width: number, height: number): void;
  sample(seconds: number): Promise<PrototypeSample>;
  snapshot(): PrototypeSample;
  /** 每栋楼的声明空间与实际几何越界核对（R2 证据）。 */
  bounds(): readonly ({ readonly styleId: string; readonly inside: boolean; readonly overflow: { x: number; y: number; z: number } })[];
  dispose(): void;
}

function percentiles(values: readonly number[], ratios: readonly number[]): number[] {
  if (values.length === 0) return ratios.map(() => 0);
  const sorted = [...values].sort((a, b) => a - b);
  return ratios.map((ratio) => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
    return sorted[index];
  });
}

/** 纹理显存估算：统计场景里真正被材质引用的贴图，按 RGBA8 + mipmap 链估算。 */
function estimateTextureBytes(root: THREE.Object3D): { bytes: number; count: number } {
  const textures = new Set<THREE.Texture>();
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const standard = material as THREE.MeshStandardMaterial;
      for (const texture of [
        standard.map,
        standard.normalMap,
        standard.roughnessMap,
        standard.metalnessMap,
        standard.aoMap,
        standard.emissiveMap,
      ]) {
        if (texture) textures.add(texture);
      }
    }
  });
  let bytes = 0;
  for (const texture of textures) {
    const image = texture.image as { width?: number; height?: number } | undefined;
    const width = image?.width ?? 1024;
    const height = image?.height ?? 1024;
    bytes += width * height * 4 * 1.34;
  }
  return { bytes, count: textures.size };
}

class PrototypeApp {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly stage = new THREE.Group();
  private readonly factory = new BuildingVisualFactory();
  private readonly overlay: HTMLElement;
  private readonly frameTimes: number[] = [];
  private readonly sampleFrames: number[] = [];
  private lastFrameAt = 0;
  private mode: Mode = 'prototype';
  private view: ViewId = 'ground';
  private buildings: BuildingVisual[] = [];
  private reports: VisualBoundsReport[] = [];
  private handles: BuildingVisualHandle[] = [];
  private baseline: THREE.Mesh[] = [];
  private buildGeneration = 0;
  private sampleEndAt = 0;
  private sampleStartedAt = 0;
  private sampleResolve: ((sample: PrototypeSample) => void) | null = null;
  private disposed = false;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0xb8cddc);
    this.scene.fog = new THREE.Fog(0xb8cddc, 120, 340);

    // 与正式场景同一套光照，避免「预览好看、进游戏变样」
    const hemi = new THREE.HemisphereLight(0xffffff, 0x74805f, 1.15);
    const sun = new THREE.DirectionalLight(0xfff3e0, 1.5);
    sun.position.set(38, 54, 24);
    const ambient = new THREE.AmbientLight(0xffffff, 0.18);
    this.scene.add(hemi, sun, ambient);

    const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x8d9a83, roughness: 1 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(420, 420), groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;

    // 2 米网格 + 1.78 米人体比例尺：判断贴地、层高与开间（仅预览页，不进正式场景）
    const grid = new THREE.GridHelper(200, 100, 0x5d6f5c, 0x77876f);
    grid.position.y = 0.005;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    const scaleGroup = new THREE.Group();
    const scaleMaterial = new THREE.MeshBasicMaterial({ color: 0xff9f43, transparent: true, opacity: 0.9 });
    for (const slot of SLOTS) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.78, 0.12), scaleMaterial);
      bar.position.set(slot.x - slot.size.width / 2 - 2.4, 0.89, slot.size.depth / 2 + 1.2);
      scaleGroup.add(bar);
    }
    this.scene.add(ground, grid, scaleGroup, this.stage);

    const size = this.viewportSize();
    this.camera = new THREE.PerspectiveCamera(52, size.width / size.height, 0.1, 420);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 180;

    this.overlay = document.createElement('div');
    this.overlay.style.cssText = [
      'position:fixed',
      'left:16px',
      'top:16px',
      'padding:12px 14px',
      'border-radius:10px',
      'background:rgba(12,16,20,0.82)',
      'border:1px solid rgba(126,200,255,0.28)',
      'color:#e8eef4',
      'font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace',
      'white-space:pre',
      'pointer-events:none',
      'max-width:430px',
      'z-index:10',
    ].join(';');
    if (new URLSearchParams(location.search).get('ui') === '0') this.overlay.style.display = 'none';
    document.body.appendChild(this.overlay);

    this.applyView(this.view);
    this.renderer.setAnimationLoop(this.tick);
  }

  async setMode(mode: Mode): Promise<void> {
    if (mode === this.mode && (this.buildings.length > 0 || this.baseline.length > 0)) return;
    this.mode = mode;
    await this.rebuild();
  }

  async setView(view: ViewId): Promise<void> {
    this.view = view;
    this.applyView(view);
  }

  setSize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, Math.max(1, height), false);
    this.camera.lookAt(this.controls.target);
  }

  /** 固定 DPR：性能采样要求同一台机器上可复现，不受系统缩放影响。 */
  setPixelRatio(ratio: number): void {
    const value = Math.min(Math.max(ratio, 0.5), 3);
    this.renderer.setPixelRatio(value);
    this.setSize(window.innerWidth, window.innerHeight);
  }

  /**
   * 重建舞台。
   *
   * 代次 + 取消：先取消上一轮仍在加载的单栋请求，再递增代次；即使旧请求晚到，
   * 结果也不会挂到当前舞台上，而是被释放。这样「原型还在加载时切基线」不会串台。
   */
  async rebuild(): Promise<void> {
    const generation = ++this.buildGeneration;
    for (const handle of this.handles) handle.cancel();
    this.handles = [];
    this.clearStage();
    if (this.mode === 'baseline') {
      this.buildBaseline();
      this.applyView(this.view);
      return;
    }

    const handles = SLOTS.map((slot) =>
      this.factory.begin({
        buildingId: `prototype-${slot.styleId}`,
        styleId: slot.styleId,
        size: slot.size,
        kind: slot.styleId === 'office-10' ? 'office' : 'home',
        templateVersion: slot.templateVersion,
        position: { x: slot.x, z: slot.z },
      }),
    );
    this.handles = handles;

    const results = await Promise.all(
      handles.map((handle) =>
        handle.result.catch((error: unknown) => {
          if (error instanceof VisualLoadCancelled) return null;
          console.error('[prototype] 建筑生成失败', handle.request.buildingId, error);
          return null;
        }),
      ),
    );

    if (this.disposed || generation !== this.buildGeneration) {
      for (const visual of results) visual?.dispose();
      return;
    }

    for (const visual of results) {
      if (!visual) continue;
      this.buildings.push(visual);
      this.reports.push(inspectVisual(visual));
      this.stage.add(visual.group);
    }
    this.applyView(this.view);
  }

  /** 基线：当前正式场景里的「灰盒 + 檐口」等价表现（每栋 1 个 draw call）。 */
  private buildBaseline(): void {
    for (const slot of SLOTS) {
      const style = BUILDING_STYLES[slot.styleId];
      const material = new THREE.MeshStandardMaterial({
        color: style.palette.wallTint,
        roughness: 0.82,
        metalness: 0.06,
      });
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(slot.size.width, slot.size.height, slot.size.depth),
        material,
      );
      box.position.set(slot.x, slot.size.height / 2, slot.z);
      box.receiveShadow = true;
      this.baseline.push(box);
      this.stage.add(box);
    }
  }

  private clearStage(): void {
    for (const visual of this.buildings) visual.dispose();
    this.buildings = [];
    this.reports = [];
    for (const mesh of this.baseline) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.removeFromParent();
    }
    this.baseline = [];
    this.stage.clear();
  }

  private applyView(view: ViewId): void {
    const preset = VIEWS[view];
    this.camera.position.set(...preset.position);
    this.controls.target.set(...preset.target);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  private viewportSize(): { width: number; height: number } {
    return {
      width: Math.max(1, window.innerWidth),
      height: Math.max(1, window.innerHeight),
    };
  }

  private tick = (): void => {
    const now = performance.now();
    const delta = this.lastFrameAt === 0 ? 0 : now - this.lastFrameAt;
    this.lastFrameAt = now;
    if (delta > 0) {
      this.frameTimes.push(delta);
      if (this.frameTimes.length > 120) this.frameTimes.shift();
      if (this.sampleStartedAt > 0 && now >= this.sampleStartedAt) this.sampleFrames.push(delta);
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.updateOverlay();

    if (this.sampleResolve && now >= this.sampleEndAt) this.finishSample();
  };

  private finishSample(): void {
    const resolve = this.sampleResolve;
    this.sampleResolve = null;
    this.sampleStartedAt = 0;
    this.sampleEndAt = 0;
    if (!resolve) return;
    const frames = [...this.sampleFrames];
    this.sampleFrames.length = 0;
    resolve(this.composeSample(frames));
  }

  private composeSample(frames: readonly number[]): PrototypeSample {
    const [p50, p95] = percentiles(frames, [0.5, 0.95]);
    const mean = frames.length > 0 ? frames.reduce((sum, value) => sum + value, 0) / frames.length : 0;
    const texture = estimateTextureBytes(this.scene);
    const info = this.renderer.info;
    return {
      mode: this.mode,
      view: this.view,
      frames: frames.length,
      seconds: frames.reduce((sum, value) => sum + value, 0) / 1000,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: texture.count,
      programs: info.programs?.length ?? 0,
      frameMs: { p50, p95, mean, max: frames.length ? Math.max(...frames) : 0 },
      textureMiB: texture.bytes / (1024 * 1024),
      viewport: {
        width: this.renderer.domElement.width,
        height: this.renderer.domElement.height,
        dpr: this.renderer.getPixelRatio(),
      },
    };
  }

  snapshot(): PrototypeSample {
    return this.composeSample(this.frameTimes.slice(-30));
  }

  /** 声明空间与实际几何的越界核对结果。 */
  bounds(): readonly { styleId: string; inside: boolean; overflow: { x: number; y: number; z: number } }[] {
    return this.reports.map((report, index) => ({
      styleId: this.buildings[index]?.request.styleId ?? `#${index}`,
      inside: report.inside,
      overflow: report.overflow,
    }));
  }

  /** 采样：先预热 0.8 秒（着色器编译不进样本），再收集 `seconds` 秒的帧时长。 */
  sample(seconds: number): Promise<PrototypeSample> {
    return new Promise((resolve) => {
      const start = performance.now() + 800;
      this.sampleStartedAt = start;
      this.sampleEndAt = start + seconds * 1000;
      this.sampleFrames.length = 0;
      this.sampleResolve = resolve;
    });
  }

  private updateOverlay(): void {
    const sample = this.snapshot();
    const modeLabel = this.mode === 'prototype' ? '模块化原型' : '普通几何基线';
    const lines = [
      `塔科夫市 · 建筑原型   ${modeLabel}   视角 ${this.view}`,
      `draw calls ${sample.drawCalls}   triangles ${sample.triangles.toLocaleString('en-US')}`,
      `geometry ${sample.geometries}   textures ${sample.textures}   估算显存 ${sample.textureMiB.toFixed(1)} MiB`,
      `frame p50 ${sample.frameMs.p50.toFixed(2)} ms   p95 ${sample.frameMs.p95.toFixed(2)} ms`,
      `viewport ${sample.viewport.width}×${sample.viewport.height} @${sample.viewport.dpr}`,
      '',
    ];
    for (const slot of SLOTS) {
      const style = BUILDING_STYLES[slot.styleId];
      const visual = this.buildings.find((item) => item.request.styleId === slot.styleId);
      const size = `${slot.size.width}×${slot.size.depth}×${slot.size.height}`;
      if (!visual) {
        lines.push(`${style.label.padEnd(6, ' ')} ${size} m`);
        continue;
      }
      const report = this.reports[this.buildings.indexOf(visual)];
      const overflow = report
        ? report.inside
          ? '包络内'
          : `越界 x${report.overflow.x.toFixed(2)} y${report.overflow.y.toFixed(2)} z${report.overflow.z.toFixed(2)}`
        : '—';
      lines.push(
        `${style.label.padEnd(6, ' ')} ${size} m  ${visual.plan.storeys}层 开间${visual.plan.faces.front.bays} ` +
          `dc ${visual.stats.drawCalls} tri ${visual.stats.triangles.toLocaleString('en-US')}  ${overflow}`,
      );
    }
    this.overlay.textContent = lines.join('\n');
  }

  dispose(): void {
    this.disposed = true;
    this.buildGeneration += 1;
    for (const handle of this.handles) handle.cancel();
    this.handles = [];
    this.renderer.setAnimationLoop(null);
    this.clearStage();
    this.factory.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.overlay.remove();
  }
}

function readMode(): Mode {
  const mode = new URLSearchParams(location.search).get('mode');
  return mode === 'baseline' ? 'baseline' : 'prototype';
}

function readView(): ViewId {
  const view = new URLSearchParams(location.search).get('view') ?? 'ground';
  const known: readonly string[] = [
    'aerial',
    'closeup',
    'closeup-apartment',
    'closeup-office',
    'entrance',
    'rear-office',
    'escape',
    'balcony',
  ];
  return known.includes(view) ? (view as ViewId) : 'ground';
}

async function main(): Promise<void> {
  const container = document.getElementById('prototype-root');
  if (!container) throw new Error('缺少 #prototype-root 容器');
  const params = new URLSearchParams(location.search);

  const app = new PrototypeApp(container);
  const dpr = Number(params.get('dpr') ?? '0');
  if (Number.isFinite(dpr) && dpr > 0) app.setPixelRatio(dpr);
  await app.setView(readView());
  await app.setMode(readMode());

  window.addEventListener('resize', () => {
    app.setSize(window.innerWidth, window.innerHeight);
  });

  const api: PrototypeApi = {
    ready: Promise.resolve(),
    setMode: (mode) => app.setMode(mode),
    setView: (view) => app.setView(view),
    setSize: (width, height) => app.setSize(width, height),
    sample: (seconds) => app.sample(seconds),
    snapshot: () => app.snapshot(),
    bounds: () => app.bounds(),
    dispose: () => app.dispose(),
  };
  (window as unknown as { __prototype: PrototypeApi }).__prototype = api;
  document.body.dataset.ready = 'true';
}

void main();
