/**
 * 世界编排 —— 第三人称摄像机、鼠标锁定、移动输入、入口交互、人物与建筑视觉调度。
 *
 * 职责边界：
 *  - 世界只读取**逻辑地图（features/city-layout 的只读视图）**与玩家位置，不读写经济状态；
 *  - 人物移动边界、读档位置修正、地面渲染全部使用同一份动态 `bounds`，
 *    不再使用固定 `CITY.groundSize / 2`；
 *  - 布局按稳定 id 增量同步，不销毁重建整个 World；建筑视觉请求用 `visualGeneration`
 *    + `layoutRevision` + handle 实例 + 视觉指纹四重检查，旧读档的异步回调不会写回新布局；
 *  - 只有**一个** `BuildingVisualFactory`（全城共享贴图/材质/外部构件），World 负责请求、
 *    取消与就绪计数；scene 负责 handle、标签、挂载、碰撞写入与单栋释放；
 *  - 摄像机与移动都用「按时间指数趋近」做平滑，手感不依赖帧率。
 */

import * as THREE from 'three';
import { CAMERA, CITY, PLAYER } from '../content/config';
import { INTERIOR } from '../content/interior';
import {
  createBaseLayout,
  type CityLayoutView,
  type LayoutBounds,
  type LayoutBuilding,
} from '../features/city-layout';
import type { ReadonlyEnvironmentState } from '../features/environment';
import type { WorldSaveData } from '../infrastructure/storage';
import {
  BuildingVisualFactory,
  VisualLoadCancelled,
  projectBuildingVisualRequest,
  visualFingerprint,
  type BuildingVisualFactoryStats,
  type BuildingVisualHandle,
  type BuildingVisualRequest,
} from './buildings';
import { loadCharacterRig } from './character';
import { EnvironmentRig } from './environment';
import {
  EMPTY_INPUT,
  PLAYER_EDGE_MARGIN,
  Player,
  type MoveInput,
  type PlayerBounds,
  type PlayerPose,
  type PlayerUpdateResult,
} from './player';
import type { InteriorRuntime } from './interiors/qingchuan';
import {
  attachBuildingVisual,
  buildCityScene,
  detachBuildingVisual,
  type BuildingHandle,
  type CityScene,
  type Collider,
} from './scene';
import { CityBlocks, type BlocksReport } from './blocks/scene';
import { insideAnyRect, planCityBlocks, type Rect } from './blocks/plan';
import { SceneryAssetLibrary } from './scenery/assets';

const MOVE_KEYS: Record<string, keyof MoveInput> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 射线与轴对齐盒的最近交点距离；未命中返回 null。dir 为单位向量。 */
function rayBoxDistance(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  box: Collider,
  maxDistance: number,
): number | null {
  let tMin = 0;
  let tMax = maxDistance;
  const axes: Array<['x' | 'y' | 'z', number, number]> = [
    ['x', box.minX, box.maxX],
    ['y', box.minY, box.maxY],
    ['z', box.minZ, box.maxZ],
  ];

  for (const [axis, min, max] of axes) {
    const o = origin[axis];
    const d = dir[axis];
    if (Math.abs(d) < 1e-6) {
      if (o < min || o > max) return null;
      continue;
    }
    let t1 = (min - o) / d;
    let t2 = (max - o) / d;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  return tMin > 0.05 ? tMin : null;
}

/**
 * 布局结构指纹：用于判断是否需要真正同步（存档 revision 可在不同存档间重复）。
 *
 * 除了几何与业务绑定，这里**必须**包含「建筑所属城区」与「该城区的已存模板版本」：
 * 它们是楼体外观的种子输入，若只靠内层 `visualFingerprint` 判断，一份几何与 revision
 * 都相同、只有城区模板版本不同的布局会在提前返回处被丢掉，导致继续显示旧种子的楼体。
 */
function layoutFingerprint(layout: CityLayoutView): string {
  const districts = layout.districts
    .map((district) => [district.id, district.templateVersion].join(','))
    .join('|');
  const buildings = layout.buildings
    .map((building) =>
      [
        building.id,
        building.districtId,
        building.position.x,
        building.position.z,
        building.size.width,
        building.size.height,
        building.size.depth,
        building.entrance.x,
        building.entrance.z,
        building.kind,
        building.color,
        building.model ?? '',
        building.modelScaleKey ?? '',
        building.name,
        building.subtitle,
        building.available ? 1 : 0,
        building.interactionId,
        building.shopId ?? '',
        building.companyId ?? '',
      ].join(','),
    )
    .join('|');
  const roads = layout.roads
    .map((road) =>
      [road.id, road.center.x, road.center.z, road.size.width, road.size.depth].join(','),
    )
    .join('|');
  return [
    layout.layoutVersion,
    layout.revision,
    layout.bounds.minX,
    layout.bounds.maxX,
    layout.bounds.minZ,
    layout.bounds.maxZ,
    districts,
    buildings,
    roads,
  ].join('#');
}

export interface WorldCallbacks {
  onPointerLockChange?(locked: boolean): void;
  /** 碰撞就绪状态变化（楼体挂载完成/明确降级）时通知；供 app 层刷新遮罩与交互提示。 */
  onCollisionReadyChange?(ready: boolean): void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 只读诊断：正式场景里当前有多少栋楼真的用上了模块化楼体。 */
export interface WorldVisualReport {
  readonly ready: number;
  readonly pending: number;
  readonly placeholder: readonly string[];
  readonly failures: readonly string[];
  readonly assets: BuildingVisualFactoryStats;
  /** 装饰街区诊断：块数、在途、被抑制的块、降级与错误。 */
  readonly blocks: BlocksReport;
}

/** 城区 id → 已存模板版本。用于视觉种子，绝不以全城 layoutVersion 或 revision 代替。 */
function districtVersionsOf(layout: CityLayoutView): ReadonlyMap<string, number> {
  const versions = new Map<string, number>();
  for (const district of layout.districts) versions.set(district.id, district.templateVersion);
  return versions;
}

export class World {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly city: CityScene;
  private readonly environment: EnvironmentRig;
  private readonly player: Player;
  private readonly container: HTMLElement;
  private readonly callbacks: WorldCallbacks;
  private readonly followTarget = new THREE.Vector3();
  private readonly input: MoveInput = { ...EMPTY_INPUT };
  private readonly resizeHandler = () => this.resize();
  private readonly pointerLockHandler = () => this.handlePointerLockChange();
  /** 全城唯一的建筑视觉工厂：贴图、材质与外部构件在全城共享，不每栋新建。 */
  private readonly visualFactory = new BuildingVisualFactory();
  /** 就绪监听：碰撞由未就绪变为就绪时通知；可重复订阅/退订。 */
  private readonly readyListeners = new Set<() => void>();

  /** 当前逻辑布局（只读视图）及其结构指纹。 */
  private layoutFingerprintValue: string;
  /** 当前布局的建筑实例与碰撞体（与场景同源）。 */
  private handles: readonly BuildingHandle[] = [];
  /** 人物移动用的合并碰撞集合（业务建筑 + 装饰街区）。 */
  private colliders: Collider[] = [];
  /** 业务建筑碰撞盒：旧档位置修正**只**用它，保持既有行为不变。 */
  private buildingColliders: Collider[] = [];
  /** 街景资产库：铺装贴图、街景材质与外部模型的唯一拥有者。 */
  private readonly sceneryLibrary = new SceneryAssetLibrary();
  /** 装饰街区：只读规划产物 + 场景装配 + 自己的碰撞盒。 */
  private readonly blocks: CityBlocks;
  /** 已打印过跳过原因的站点 id：避免每次布局同步重复刷屏。 */
  private readonly reportedSkips = new Set<string>();
  /** 规划期产出的步行域（街道带 + 街区铺装），旧档恢复只在这些区域里找落点。 */
  private walkable: Rect[] = [];
  /** 人物移动、位置修正、地面渲染共用的动态边界。 */
  private bounds: LayoutBounds;
  private layoutRevision = 0;
  /** 当前布局各城区的已存模板版本（视觉种子输入）。 */
  private districtVersions: ReadonlyMap<string, number>;
  /**
   * 视觉代次：每次开始一轮楼体请求时 +1。异步回调必须同时核对「代次 + 布局 revision +
   * handle 仍是当前实例 + 视觉指纹」才允许挂载，旧 Promise 不得覆盖新布局。
   */
  private visualGeneration = 0;
  private pendingVisualLoads = 0;
  /** 在途请求（建筑 id → 句柄），只存在内存；用于布局同步与销毁时取消上一轮。 */
  private readonly visualRequests = new Map<string, BuildingVisualHandle>();
  /** 明确降级为占位外观的建筑诊断（只增不减，仅存在于内存）。 */
  private readonly visualFallbacks: string[] = [];
  private collisionReady = true;
  /** 读档时等待碰撞就绪后再做「仅非法时」最小推出的原始 pose。 */
  private pendingRestorePose: PlayerPose | null = null;

  private yaw = 0;
  private pitch: number = CAMERA.pitch.default;
  private desiredDistance: number = CAMERA.distance.default;
  private currentDistance: number = CAMERA.distance.default;
  private pointerLocked = false;
  private disposed = false;
  /** 疾跑开关。属于输入/表现状态，不写进 GameState，也不进存档。 */
  private sprinting = false;
  /** 上一帧是否允许人物移动；不移动时不允许切换疾跑。 */
  private movementAllowed = false;
  /** 当前交互目标缓存，由 update / 模型加载 / 布局同步 / 读档后重新计算。 */
  private nearbyBuilding: LayoutBuilding | null = null;

  /* ------------------------------------------------------------ 室内会话 */
  /** 室内模式只存内存：outdoor → loading → indoor。 */
  private interiorMode: 'outdoor' | 'loading' | 'indoor' = 'outdoor';
  /** 室内场景与碰撞；只在 indoor 时非空。 */
  private interior: InteriorRuntime | null = null;
  /** 进入/取消/读档/新游戏/销毁都会递增；迟到的加载结果据此丢弃并释放。 */
  private interiorGeneration = 0;
  /** 进入前记录的完整室外回归快照（位置、朝向、相机）。 */
  private outdoorSnapshot: WorldSaveData | null = null;
  private interiorColliders: readonly Collider[] = [];
  /** 相机遮挡盒：墙体 + 家具 + 天花板/门洞封口（人物碰撞不使用）。 */
  private interiorOccluders: readonly Collider[] = [];
  private interiorBounds: PlayerBounds | null = null;
  private interiorExit: { readonly x: number; readonly z: number; readonly radius: number } | null = null;

  constructor(container: HTMLElement, callbacks: WorldCallbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    // 默认先建立基础城区：即使 app 层还没来得及 syncLayout，旧城区也保持可用。
    // 读档时 app 层必须随后调用 syncLayout(存档布局) 覆盖它。
    const initialLayout = createBaseLayout();
    this.layoutFingerprintValue = layoutFingerprint(initialLayout);
    this.layoutRevision = initialLayout.revision;
    this.bounds = { ...initialLayout.bounds };
    this.districtVersions = districtVersionsOf(initialLayout);
    this.city = buildCityScene(initialLayout, this.visualFactory, this.sceneryLibrary);
    this.blocks = new CityBlocks(this.city.scene, this.visualFactory, this.sceneryLibrary);
    this.handles = this.city.buildings;
    this.rebuildColliders();
    this.planBlocks(initialLayout);
    this.player = new Player();
    this.city.scene.add(this.player.group);

    const aspect = container.clientWidth / Math.max(1, container.clientHeight);
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, aspect, CAMERA.near, CAMERA.far);

    // 环境（天空、太阳、雾、雨）在这里建立一次并贯穿整个 World 生命周期；
    // 它只接受显式的环境采样，不读 GameState。
    this.environment = new EnvironmentRig(this.city.scene, this.renderer, this.camera);
    this.environment.setFogBase(this.city.fogBase.near, this.city.fogBase.far);

    const pose = this.player.pose();
    this.followTarget.set(pose.x, CAMERA.targetHeight, pose.z);
    this.placeCamera(0, true);
    this.refreshNearbyBuilding();

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    window.addEventListener('resize', this.resizeHandler);
    window.addEventListener('wheel', this.handleWheel, { passive: false });
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('pointerlockchange', this.pointerLockHandler);
    this.resize();

    this.beginVisualLoading();
    void this.loadCharacter();
  }

  /* ---------------------------------------------------------- 布局同步 */

  /**
   * 开始一次新的"世界显示会话"：读档、导入存档、重新开始游戏时由 app 层调用。
   *
   * 做两件事：
   *  1. 清掉上一份进度留下的**装饰抑制**记录（抑制只在本会话内有效，不写存档）；
   *  2. 把布局指纹置空，让紧接着的 `syncLayout()` 一定真正执行——
   *     否则"读同一份布局"会被指纹提前返回拦住，抑制过的街区永远回不来。
   *
   * 之后的冲突检查仍按该存档的真实玩家位置执行，仍有冲突时可以重新抑制。
   */
  beginDisplaySession(): void {
    this.blocks.beginDisplaySession();
    // 只清指纹，不在这里取消在途请求：紧接着的 `syncLayout()` 本身会先取消再按新布局
    // 重新请求。若在这里提前取消、而调用方没有紧跟一次同步，在途楼体会停在占位上。
    this.layoutFingerprintValue = '';
  }

  /**
   * 同步逻辑地图 —— 按稳定 id 增量建/删建筑与道路实例，不销毁重建整个 World。
   *
   * app 层约定：构造后、新游戏、读档后、以及检测到 `cityLayout.revision` 变化时调用。
   * 内部再做结构指纹比较，因此重复调用与「不同存档 revision 恰好相同」都不会丢更新。
   *
   * 顺序固定：先取消上一轮在途请求 → 再改变场景实例 → 最后按新布局重新请求。
   * 已完成且视觉指纹不变的楼体原样保留，不因新增一栋楼而重建整城。
   */
  syncLayout(layout: CityLayoutView): void {
    const fingerprint = layoutFingerprint(layout);
    if (fingerprint === this.layoutFingerprintValue) return;

    // 场景实例即将变化：上一轮未完成的请求其结果一律不许再挂载
    this.cancelVisualRequests();

    this.layoutFingerprintValue = fingerprint;
    this.layoutRevision = layout.revision;
    this.bounds = { ...layout.bounds };
    this.districtVersions = districtVersionsOf(layout);

    this.city.syncLayout(layout);
    this.handles = this.city.buildings;
    this.rebuildColliders();
    this.planBlocks(layout);
    // 城区扩张后雾的基数随边界变化；天气修饰仍由环境系统叠加
    this.environment.setFogBase(this.city.fogBase.near, this.city.fogBase.far);

    this.beginVisualLoading();
    if (this.interiorMode === 'outdoor') {
      this.refreshNearbyBuilding();
      this.placeCamera(0, true);
    }
  }

  /* ---------------------------------------------------------- 楼体调度 */

  /**
   * 为当前布局里「还没有楼体、或视觉指纹已变」的建筑启动模块化请求。
   *
   * 每次调用都开启新代次：旧代次的结果即使稍后返回也会被丢弃并释放，
   * 因此「读档 A → 立刻读档 B」时，A 的楼体不会覆盖 B 的碰撞体或外观。
   * 已完成且指纹不变的楼体不会被重新请求。
   * 明确失败（尺寸越界等）保留占位外观，同样视为已结算，不会卡住碰撞就绪。
   */
  private beginVisualLoading(): void {
    const generation = ++this.visualGeneration;
    const targets: Array<{ handle: BuildingHandle; request: BuildingVisualRequest; key: string }> = [];

    for (const handle of this.handles) {
      const templateVersion = this.districtVersions.get(handle.building.districtId);
      if (templateVersion === undefined) {
        // 种子必须来自所属城区的已存模板版本；匹配失败时明确诊断，绝不随机补种子
        this.keepPlaceholder(
          handle,
          `找不到所属城区的模板版本（districtId=${handle.building.districtId}）`,
        );
        continue;
      }
      const request = projectBuildingVisualRequest(handle.building, templateVersion);
      const key = visualFingerprint(request);
      // 已完成且指纹不变：原样保留，不重新加载
      if (handle.visual && handle.visualKey === key) continue;
      if (handle.visual) {
        // 指纹变了（几何/朝向/风格/招牌文字变化）：先摘下旧楼体，回到占位直到新楼体就绪
        detachBuildingVisual(handle, this.visualFactory);
      }
      targets.push({ handle, request, key });
    }

    this.pendingVisualLoads = targets.length;
    this.collisionReady = targets.length === 0;
    for (const target of targets) {
      void this.loadBuildingVisual(
        target.handle,
        target.request,
        target.key,
        generation,
        this.layoutRevision,
      );
    }
    if (this.collisionReady) this.markCollisionReady();
    else this.notifyCollisionReadyChange(this.isCollisionReady());
  }

  /** 把「碰撞就绪状态变化」异步通知给 app 层，避免在 World 构造期间回调到未赋值字段。 */
  private notifyCollisionReadyChange(ready: boolean): void {
    const callback = this.callbacks.onCollisionReadyChange;
    if (!callback) return;
    queueMicrotask(() => {
      if (!this.disposed) callback(ready);
    });
  }

  /**
   * 请求并挂载一栋楼的模块化楼体。
   *
   * 异步返回后必须同时通过四项检查才允许挂载：World 代次、布局 revision、
   * handle 仍是当前布局里的同一个实例、以及重算的视觉指纹与请求一致。
   * 工厂内部的令牌/代次是**它自己那一层**，不能替代这里的世界检查。
   */
  private async loadBuildingVisual(
    handle: BuildingHandle,
    request: BuildingVisualRequest,
    key: string,
    generation: number,
    layoutRevision: number,
  ): Promise<void> {
    let token: BuildingVisualHandle;
    try {
      token = this.visualFactory.begin(request);
    } catch (error) {
      this.keepPlaceholder(handle, describeError(error));
      this.settleVisualLoad(generation);
      return;
    }
    this.visualRequests.set(handle.building.id, token);

    try {
      const visual = await token.result;
      if (this.isStaleVisual(handle, token, key, generation, layoutRevision)) {
        // 过期成功结果必须释放，不能挂到已变化的布局上
        visual.dispose();
        return;
      }
      attachBuildingVisual(handle, visual, key);
      this.refreshNearbyBuilding();
    } catch (error) {
      // 取消不是失败：不降级、不报错，由新代次重新请求
      if (error instanceof VisualLoadCancelled) return;
      if (generation === this.visualGeneration && !this.disposed) {
        this.keepPlaceholder(handle, describeError(error));
      }
    } finally {
      if (this.visualRequests.get(handle.building.id) === token) {
        this.visualRequests.delete(handle.building.id);
      }
      this.settleVisualLoad(generation);
    }
  }

  /** 过期判定：任一条件不成立都说明这栋楼的外观已经不代表当前布局。 */
  private isStaleVisual(
    handle: BuildingHandle,
    token: BuildingVisualHandle,
    key: string,
    generation: number,
    layoutRevision: number,
  ): boolean {
    if (this.disposed) return true;
    if (token.cancelled) return true;
    if (generation !== this.visualGeneration) return true;
    if (layoutRevision !== this.layoutRevision) return true;
    if (!this.handles.includes(handle)) return true;
    const templateVersion = this.districtVersions.get(handle.building.districtId);
    if (templateVersion === undefined) return true;
    return visualFingerprint(projectBuildingVisualRequest(handle.building, templateVersion)) !== key;
  }

  /**
   * 一次楼体请求结束（成功/明确失败/取消/过期）后的计数。
   *
   * 过期代次不得扣当前代次的 pending，也不得触发新代次的就绪；
   * 当前代次无论成功还是明确失败都恰好结算一次，不会永久停在「正在初始化」。
   */
  private settleVisualLoad(generation: number): void {
    if (this.disposed || generation !== this.visualGeneration) return;
    this.pendingVisualLoads = Math.max(0, this.pendingVisualLoads - 1);
    if (this.pendingVisualLoads === 0) this.markCollisionReady();
  }

  /** 明确降级：保留占位外观（碰撞仍用规划 AABB），并记录一条可追溯的诊断。 */
  private keepPlaceholder(handle: BuildingHandle, reason: string): void {
    handle.visualState = 'placeholder';
    handle.placeholder.visible = true;
    const { building } = handle;
    const detail =
      `${building.id}［${building.kind} ${building.size.width}×${building.size.height}×` +
      `${building.size.depth} m，${building.districtId}］：${reason}`;
    if (!this.visualFallbacks.includes(detail)) this.visualFallbacks.push(detail);
    console.warn(`[world] 建筑视觉明确降级为占位外观 —— ${detail}`);
  }

  /** 取消上一轮全部在途请求（布局同步与销毁时调用）。已完成并挂载的楼体不受影响。 */
  private cancelVisualRequests(): void {
    for (const token of this.visualRequests.values()) token.cancel();
    this.visualRequests.clear();
  }

  /** 只读诊断：正式场景里楼体的实际使用情况（不写任何状态）。 */
  visualReport(): WorldVisualReport {
    const placeholder: string[] = [];
    let ready = 0;
    for (const handle of this.handles) {
      if (handle.visualState === 'ready') ready += 1;
      else if (handle.visualState === 'placeholder') placeholder.push(handle.building.id);
    }
    return {
      ready,
      pending: this.pendingVisualLoads,
      placeholder,
      failures: [...this.visualFallbacks],
      assets: this.visualFactory.stats(),
      blocks: this.blocks.report(),
    };
  }

  /** 碰撞就绪：通知监听者，并把等待中的读档位置修正补上（仅当原位置非法时）。 */
  private markCollisionReady(): void {
    this.collisionReady = true;
    this.notifyCollisionReadyChange(this.isCollisionReady());
    for (const listener of [...this.readyListeners]) listener();
    if (this.interiorMode === 'outdoor') this.applyPendingRestoreCorrection();
  }

  /** 碰撞就绪：室内以室内场景为准（城市在后台更新不阻塞室内）；室外看城市楼体。 */
  isCollisionReady(): boolean {
    return this.interiorMode === 'indoor' ? true : this.collisionReady;
  }

  /**
   * 订阅碰撞就绪事件；已经就绪时在微任务中立即回调一次。
   * 返回退订函数。
   */
  onCollisionReady(listener: () => void): () => void {
    let active = true;
    this.readyListeners.add(listener);
    if (this.collisionReady) {
      queueMicrotask(() => {
        if (active && !this.disposed) listener();
      });
    }
    return () => {
      active = false;
      this.readyListeners.delete(listener);
    };
  }

  /** Promise 形式：读档流程可 `await world.whenCollisionReady()`。 */
  whenCollisionReady(): Promise<void> {
    if (this.collisionReady) return Promise.resolve();
    return new Promise((resolve) => {
      let unsubscribe: (() => void) | null = null;
      unsubscribe = this.onCollisionReady(() => {
        unsubscribe?.();
        resolve();
      });
    });
  }

  /* ------------------------------------------------------------ 室内会话 */

  isIndoor(): boolean {
    return this.interiorMode === 'indoor';
  }

  isInteriorTransitioning(): boolean {
    return this.interiorMode === 'loading';
  }

  /** 只有站在门口触发范围内才允许离开；不是全屋任意位置。 */
  canExitInterior(): boolean {
    if (this.interiorMode !== 'indoor' || !this.interiorExit) return false;
    const pose = this.player.pose();
    return (
      Math.hypot(pose.x - this.interiorExit.x, pose.z - this.interiorExit.z) <=
      this.interiorExit.radius
    );
  }

  /**
   * 按需进入个人住宅：先记录室外回归快照，再动态加载室内模块与四类模型。
   *
   * 加载期间保持室外画面、锁人物移动，不暂停经济；只有全部模型可用后才原子切换。
   * `validate` 由 app 提供，在加载完成、正式提交前再问一次居住权与会话是否仍有效；
   * World 不读业务状态，只负责在返回 false 时释放半成品并保持室外。
   * 失败时释放半成品并保持室外，绝不用占位几何顶替交付。
   */
  async enterInterior(
    validate?: () => boolean,
  ): Promise<{ ok: boolean; message?: string }> {
    if (this.interiorMode !== 'outdoor') {
      return { ok: false, message: '正在切换场景，请稍候' };
    }
    if (!this.collisionReady) {
      return { ok: false, message: '城市仍在加载，请稍候' };
    }

    const snapshot = this.getSaveData();
    this.outdoorSnapshot = snapshot;
    this.interiorMode = 'loading';
    this.interiorGeneration += 1;
    const generation = this.interiorGeneration;
    this.clearInput();

    try {
      const module = await import('./interiors/qingchuan');
      const runtime = await module.loadQingchuanInterior();
      if (this.disposed || generation !== this.interiorGeneration) {
        runtime.dispose();
        return { ok: false, message: '进入已取消' };
      }
      // 加载期间居住权或会话可能已变化：提交前由 app 再校验一次。
      if (validate && !validate()) {
        runtime.dispose();
        this.interiorMode = 'outdoor';
        this.outdoorSnapshot = null;
        this.notifyCollisionReadyChange(this.isCollisionReady());
        return { ok: false, message: '当前已不是可进入的个人住宅' };
      }

      this.interior = runtime;
      this.interiorColliders = runtime.colliders;
      this.interiorOccluders = runtime.occluders;
      this.interiorBounds = runtime.bounds;
      this.interiorExit = runtime.exit;

      this.city.scene.remove(this.player.group);
      runtime.scene.add(this.player.group);
      this.player.restore(runtime.spawn);

      this.yaw = INTERIOR.camera.spawnYaw;
      this.pitch = INTERIOR.camera.pitch.default;
      this.desiredDistance = INTERIOR.camera.distance.default;
      this.currentDistance = this.desiredDistance;
      this.followTarget.set(runtime.spawn.x, INTERIOR.camera.targetHeight, runtime.spawn.z);
      this.placeInteriorCamera(0, true);
      this.nearbyBuilding = null;
      this.interiorMode = 'indoor';
      this.setCameraProjection(
        INTERIOR.camera.fov,
        INTERIOR.camera.near,
        INTERIOR.camera.far,
      );
      this.notifyCollisionReadyChange(true);
      return { ok: true };
    } catch (error) {
      if (generation === this.interiorGeneration) {
        this.interiorMode = 'outdoor';
        this.outdoorSnapshot = null;
      }
      return { ok: false, message: describeError(error) };
    }
  }

  /** 门口离开 / 取消加载：恢复进入前的室外位置、朝向与相机。 */
  exitInterior(): boolean {
    if (this.interiorMode === 'loading') {
      this.cancelInterior();
      return true;
    }
    if (this.interiorMode !== 'indoor' || !this.interior || !this.outdoorSnapshot) return false;

    const snapshot = this.outdoorSnapshot;
    this.interior.scene.remove(this.player.group);
    this.city.scene.add(this.player.group);
    this.interior.dispose();
    this.interior = null;
    this.interiorColliders = [];
    this.interiorOccluders = [];
    this.interiorBounds = null;
    this.interiorExit = null;
    this.outdoorSnapshot = null;
    this.interiorMode = 'outdoor';
    this.setCameraProjection(CAMERA.fov, CAMERA.near, CAMERA.far);
    this.player.group.visible = true;

    this.player.restore({
      x: snapshot.player.x,
      z: snapshot.player.z,
      facing: snapshot.player.facing,
    });
    if (snapshot.camera) {
      this.yaw = snapshot.camera.yaw;
      this.pitch = clamp(snapshot.camera.pitch, CAMERA.pitch.min, CAMERA.pitch.max);
      this.desiredDistance = clamp(
        snapshot.camera.distance,
        CAMERA.distance.min,
        CAMERA.distance.max,
      );
      this.currentDistance = this.desiredDistance;
    }
    this.clearInput();
    this.placeCamera(0, true);
    this.refreshNearbyBuilding();
    this.notifyCollisionReadyChange(this.isCollisionReady());
    return true;
  }

  /**
   * 读档 / 新游戏 / dispose 前失效室内会话。
   * 加载中只递增代次，迟到结果会被 enterInterior 释放；已在室内则恢复室外快照。
   */
  cancelInterior(): void {
    if (this.interiorMode === 'loading') {
      this.interiorGeneration += 1;
      this.interiorMode = 'outdoor';
      this.outdoorSnapshot = null;
      this.notifyCollisionReadyChange(this.isCollisionReady());
      return;
    }
    if (this.interiorMode === 'indoor') this.exitInterior();
  }

  /* ---------------------------------------------------------- 位置修正 */

  /**
   * 旧档碰撞安全：人物中心落入「建筑碰撞盒外扩 PLAYER.radius」时，
   * 按东/西/南/北四个方向的最小位移推到刚好在盒外，朝向保持不变；
   * 同时把越界位置夹回当前动态 bounds 内。
   *
   * 只做最小修正，不做无条件传送回出生点；正常位置不会产生任何位移。
   * 只在读档流程（含等待模型加载完成/回退后）调用一次，不进入渲染循环。
   */
  private ensurePlayerNotInsideBuildings(): void {
    const pose = this.player.pose();
    const minX = this.bounds.minX + PLAYER_EDGE_MARGIN;
    const maxX = this.bounds.maxX - PLAYER_EDGE_MARGIN;
    const minZ = this.bounds.minZ + PLAYER_EDGE_MARGIN;
    const maxZ = this.bounds.maxZ - PLAYER_EDGE_MARGIN;
    let x = clamp(pose.x, minX, maxX);
    let z = clamp(pose.z, minZ, maxZ);
    let corrected = x !== pose.x || z !== pose.z;

    // 相邻建筑的修正可能互相影响，按建筑数量设置上限逐个解决；正常位置直接跳过。
    for (let pass = 0; pass < this.buildingColliders.length; pass += 1) {
      const hit = this.buildingColliders.find(
        (collider) =>
          x > collider.minX - PLAYER.radius &&
          x < collider.maxX + PLAYER.radius &&
          z > collider.minZ - PLAYER.radius &&
          z < collider.maxZ + PLAYER.radius,
      );
      if (!hit) break;

      const toWest = x - (hit.minX - PLAYER.radius);
      const toEast = hit.maxX + PLAYER.radius - x;
      const toSouth = z - (hit.minZ - PLAYER.radius);
      const toNorth = hit.maxZ + PLAYER.radius - z;
      const smallest = Math.min(toWest, toEast, toSouth, toNorth);

      if (smallest === toWest) {
        x = hit.minX - PLAYER.radius;
      } else if (smallest === toEast) {
        x = hit.maxX + PLAYER.radius;
      } else if (smallest === toSouth) {
        z = hit.minZ - PLAYER.radius;
      } else {
        z = hit.maxZ + PLAYER.radius;
      }
      corrected = true;
    }

    if (!corrected) return;

    // 修正只改位置，朝向沿用存档里的原值
    this.player.restore({
      x: clamp(x, minX, maxX),
      z: clamp(z, minZ, maxZ),
      facing: pose.facing,
    });
    this.placeCamera(0, true);
    this.refreshNearbyBuilding();
  }

  /* ---------------------------------------------------------- 碰撞集合 */

  /** 合并碰撞集合：业务建筑在前、装饰街区在后，顺序稳定。 */
  private rebuildColliders(): void {
    this.buildingColliders = this.handles.map((handle) => handle.collider);
    const scenery: Collider[] = this.blocks.colliders.map((item) => ({
      minX: item.minX,
      maxX: item.maxX,
      minZ: item.minZ,
      maxZ: item.maxZ,
      minY: item.minY,
      maxY: item.maxY,
    }));
    this.colliders = [...this.buildingColliders, ...scenery];
  }

  /* ---------------------------------------------------------- 街区规划 */

  /**
   * 按**当前真实布局**规划装饰街区。
   *
   * 规划器只读布局与配置；硬门槛不满足时整块跳过（不产出几何与碰撞），
   * 因此不会出现"半截街区"或看不见的障碍。
   */
  private planBlocks(layout: CityLayoutView): void {
    const result = planCityBlocks(layout);
    this.blocks.sync(result.blocks);
    this.walkable = [...result.streetWalkable, ...result.blocks.flatMap((block) => block.walkable)];
    // 跳过原因只在首次出现时打印：布局每次同步都会重算，重复刷同一批警告没有信息量
    for (const item of result.skipped) {
      if (this.reportedSkips.has(item.id)) continue;
      this.reportedSkips.add(item.id);
      console.warn(`[world] 街区跳过：${item.id} —— ${item.reasons.join('；')}`);
    }
    this.rebuildColliders();
  }

  /**
   * 旧档恢复：**只处理新增装饰造成的冲突**。
   *
   * 前提：`ensurePlayerNotInsideBuildings()` 已经用业务建筑碰撞把位置修正过了，
   * 这里只在"位置合法但与装饰相撞"时介入，且绝不传送到未经验证的位置：
   *  1. 取命中的装饰块，按单个盒做四轴最小推出 → 得到唯一候选；
   *  2. 候选必须同时通过三重校验（完整碰撞集合 / 人物边界 / 规划步行域）；
   *  3. 不通过则**抑制**这些装饰块（只在本会话生效，不写存档，几何与碰撞同步移除），
   *     玩家留在原地；
   *  4. 抑制后仍非法就保留原位置并记录诊断 —— 不回退到出生点、不再尝试第二次。
   */
  private resolveSceneryConflict(): void {
    const pose = this.player.pose();
    const hits = this.blocks.hitBlockIdsAt(pose.x, pose.z, PLAYER.radius);
    if (hits.length === 0) return;

    const candidate = this.minimalSceneryPush(pose.x, pose.z);
    if (candidate && this.isTrustedStanding(candidate.x, candidate.z)) {
      this.player.restore({ x: candidate.x, z: candidate.z, facing: pose.facing });
      this.placeCamera(0, true);
      this.refreshNearbyBuilding();
      return;
    }

    // 降级：抑制冲突块，保留原位置
    for (const blockId of hits) {
      this.blocks.suppress(blockId);
      console.warn(`[world] 旧档位置与装饰街区冲突，已临时抑制 ${blockId}（仅本次会话，不写存档）`);
    }
    this.rebuildColliders();
    this.refreshNearbyBuilding();
  }

  /** 对命中的单个装饰盒做四轴最小推出；只返回一个候选，不做搜索。 */
  private minimalSceneryPush(x: number, z: number): { x: number; z: number } | null {
    const hit = this.blocks.colliders.find(
      (item) =>
        x > item.minX - PLAYER.radius &&
        x < item.maxX + PLAYER.radius &&
        z > item.minZ - PLAYER.radius &&
        z < item.maxZ + PLAYER.radius,
    );
    if (!hit) return null;
    const toWest = x - (hit.minX - PLAYER.radius);
    const toEast = hit.maxX + PLAYER.radius - x;
    const toSouth = z - (hit.minZ - PLAYER.radius);
    const toNorth = hit.maxZ + PLAYER.radius - z;
    const smallest = Math.min(toWest, toEast, toSouth, toNorth);
    if (smallest === toWest) return { x: hit.minX - PLAYER.radius, z };
    if (smallest === toEast) return { x: hit.maxX + PLAYER.radius, z };
    if (smallest === toSouth) return { x, z: hit.minZ - PLAYER.radius };
    return { x, z: hit.maxZ + PLAYER.radius };
  }

  /**
   * 可信落点：完整碰撞集合不相交 + 在人物边界内 + 落在规划步行域里。
   *
   * 第三条是关键：只证明"不碰撞"不够，还必须证明落点在有铺装的通行区域，
   * 否则可能把玩家推进一个四面围合的空腔。
   */
  private isTrustedStanding(x: number, z: number): boolean {
    for (const collider of this.colliders) {
      if (
        x > collider.minX - PLAYER.radius &&
        x < collider.maxX + PLAYER.radius &&
        z > collider.minZ - PLAYER.radius &&
        z < collider.maxZ + PLAYER.radius
      ) {
        return false;
      }
    }
    const minX = this.bounds.minX + PLAYER_EDGE_MARGIN;
    const maxX = this.bounds.maxX - PLAYER_EDGE_MARGIN;
    const minZ = this.bounds.minZ + PLAYER_EDGE_MARGIN;
    const maxZ = this.bounds.maxZ - PLAYER_EDGE_MARGIN;
    if (x < minX || x > maxX || z < minZ || z > maxZ) return false;
    return insideAnyRect(this.walkable, x, z, PLAYER.radius * 0.5);
  }

  /** 碰撞就绪后：如果读档时原位置非法，做一次最小必要推出。 */
  private applyPendingRestoreCorrection(): void {
    if (this.pendingRestorePose === null) return;
    this.pendingRestorePose = null;
    this.ensurePlayerNotInsideBuildings();
    this.resolveSceneryConflict();
  }

  /** 人物资源是交付要求；失败时保留占位模型并在控制台明确报错。 */
  private async loadCharacter(): Promise<void> {
    try {
      const rig = await loadCharacterRig();
      if (this.disposed) {
        rig.dispose();
        return;
      }
      this.player.attachCharacter(rig);
    } catch (error) {
      console.error('[world] 人物模型加载失败，继续使用占位模型', error);
    }
  }

  /* -------------------------------------------------------------- 输入 */

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.target instanceof HTMLElement) {
      const tag = event.target.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        event.target.isContentEditable
      ) {
        return;
      }
    }

    // Shift 切换疾跑：只按一次生效，长按不反复切换；keyup 不改变模式
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
      if (event.repeat) return;
      if (!this.pointerLocked || !this.movementAllowed) return;
      event.preventDefault();
      this.sprinting = !this.sprinting;
      return;
    }

    const key = MOVE_KEYS[event.code];
    if (!key) return;
    // 与 Shift 同一条件：鼠标已锁定且当前允许移动时才接受方向输入。
    // keyup 不做限制，任何情况下都允许清除，避免按键卡住。
    if (!this.pointerLocked || !this.movementAllowed) return;
    event.preventDefault();
    this.input[key] = true;
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    const key = MOVE_KEYS[event.code];
    if (!key) return;
    this.input[key] = false;
  };

  private handleBlur = (): void => {
    this.clearInput();
  };

  /** 当前场景的镜头参数：室内近距离范围独立，室外保持原体验。 */
  private cameraProfile(): {
    readonly distance: { readonly min: number; readonly max: number };
    readonly pitch: { readonly min: number; readonly max: number };
    readonly sensitivity: number;
    readonly zoomStep: number;
  } {
    return this.interiorMode === 'indoor' ? INTERIOR.camera : CAMERA;
  }

  private handleMouseMove = (event: MouseEvent): void => {
    if (!this.pointerLocked) return;
    const profile = this.cameraProfile();
    this.yaw -= event.movementX * profile.sensitivity;
    this.pitch = clamp(
      this.pitch + event.movementY * profile.sensitivity,
      profile.pitch.min,
      profile.pitch.max,
    );
  };

  private handleWheel = (event: WheelEvent): void => {
    if (!this.pointerLocked) return;
    event.preventDefault();
    const profile = this.cameraProfile();
    const factor = event.deltaY > 0 ? 1 / profile.zoomStep : profile.zoomStep;
    this.desiredDistance = clamp(
      this.desiredDistance * factor,
      profile.distance.min,
      profile.distance.max,
    );
  };

  /** 切换室内/室外时同步投影参数；raf 循环与 resize 都使用当前相机。 */
  private setCameraProjection(fov: number, near: number, far: number): void {
    this.camera.fov = fov;
    this.camera.near = near;
    this.camera.far = far;
    this.camera.updateProjectionMatrix();
  }

  private handlePointerLockChange = (): void => {
    const locked = document.pointerLockElement === this.renderer.domElement;
    if (locked === this.pointerLocked) return;
    this.pointerLocked = locked;
    // 解锁时立刻清空输入与视角增量，避免残留按键或突然旋转
    this.clearInput();
    this.callbacks.onPointerLockChange?.(locked);
  };

  clearInput(): void {
    this.input.forward = false;
    this.input.back = false;
    this.input.left = false;
    this.input.right = false;
    // 失焦、鼠标解锁、打开面板、读档、重开、暂停都会走这里，疾跑状态一并复位
    this.sprinting = false;
  }

  /** 只读查询，供 app 转交 HUD 显示；HUD 不接触 World 内部字段。 */
  isSprinting(): boolean {
    return this.sprinting;
  }

  isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  requestPointerLock(): void {
    if (this.pointerLocked) return;
    const element = this.renderer.domElement;
    try {
      // 旧版 DOM 类型把返回值声明为 void，而新浏览器返回 Promise；用 unknown 接住再判断，
      // 不做双重断言，也不把运行时差异带进业务类型。
      const removed: unknown = element.requestPointerLock();
      if (removed instanceof Promise) {
        // 拒绝时（例如 Esc 后立刻重试）静默忽略，由遮罩兜底
        void removed.catch(() => undefined);
      }
    } catch (error) {
      console.warn('[world] 无法锁定鼠标', error);
    }
  }

  exitPointerLock(): void {
    if (!this.pointerLocked) return;
    try {
      document.exitPointerLock();
    } catch (error) {
      console.warn('[world] 无法释放鼠标', error);
    }
  }

  /** 把输入方向转换到世界空间：以摄像机在地面的朝向为基准。 */
  private readMoveDirection(): { x: number; z: number } {
    let ix = 0;
    let iz = 0;
    if (this.input.forward) iz += 1;
    if (this.input.back) iz -= 1;
    if (this.input.right) ix += 1;
    if (this.input.left) ix -= 1;
    if (ix === 0 && iz === 0) return { x: 0, z: 0 };

    const forwardX = -Math.sin(this.yaw);
    const forwardZ = -Math.cos(this.yaw);
    const rightX = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);
    return {
      x: forwardX * iz + rightX * ix,
      z: forwardZ * iz + rightZ * ix,
    };
  }

  /* -------------------------------------------------------------- 循环 */

  /**
   * 应用一帧环境（太阳、天空、雾、雨）。
   *
   * `minute` 是表现用游戏分钟（权威整数分钟 + 不足一分钟的余量），`dtSeconds`
   * 是表现用时间；暂停时由 app 层传 0，雨滴随之冻结而天气与光照保持不动。
   * 世界不读业务状态，只接收这一份显式环境视图。
   */
  updateEnvironment(
    minute: number,
    dtSeconds: number,
    weather: ReadonlyEnvironmentState,
  ): void {
    // 室内不更新室外雨幕、太阳与天空；退出后由 app 的下一帧按最新状态重新采样。
    if (this.interiorMode === 'indoor') return;
    const pose = this.player.pose();
    this.environment.update(minute, dtSeconds, weather, pose.x, pose.z);
  }

  update(dtMoveSeconds: number, canMove: boolean, moveMultiplier = 1): PlayerUpdateResult {
    if (this.interiorMode === 'indoor' && this.interiorBounds) {
      const canMoveNow = canMove && !this.disposed;
      this.movementAllowed = canMoveNow;
      const dir = canMoveNow ? this.readMoveDirection() : { x: 0, z: 0 };
      return this.player.update(
        dtMoveSeconds,
        dir,
        this.interiorColliders,
        this.interiorBounds,
        canMoveNow,
        canMoveNow && this.sprinting,
        moveMultiplier,
        PLAYER.radius,
        INTERIOR.player.collisionRadius,
      );
    }

    // 碰撞未就绪（GLB 仍在加载）时即使 app 层传允许移动也必须锁住，
    // 避免用布局 AABB 走完后模型变大把人物卡进建筑。
    const canMoveNow = canMove && this.collisionReady && this.interiorMode === 'outdoor';
    this.movementAllowed = canMoveNow;
    // 即使不能移动也要推进一帧，让动画平滑回到待机而不是冻结在行走姿势
    const dir = canMoveNow ? this.readMoveDirection() : { x: 0, z: 0 };
    const bounds: PlayerBounds = this.bounds;
    const result = this.player.update(
      dtMoveSeconds,
      dir,
      this.colliders,
      bounds,
      canMoveNow,
      canMoveNow && this.sprinting,
      moveMultiplier,
    );
    if (this.interiorMode === 'outdoor') this.refreshNearbyBuilding();
    return result;
  }

  /**
   * 重新计算当前交互目标。
   *
   * 用建筑碰撞体在水平面的矩形到人物中心点的距离，再减去人物半径得到「表面距离」；
   * 四边与转角都可交互，不要求朝向入口，也不以建筑中心距离代替矩形距离。
   * 多个候选取表面距离最小者；相等时按稳定建筑 ID 排序，不依赖模型异步加载顺序。
   */
  private refreshNearbyBuilding(): void {
    if (this.interiorMode !== 'outdoor') {
      this.nearbyBuilding = null;
      return;
    }
    const pose = this.player.pose();
    let best: LayoutBuilding | null = null;
    let bestSurface = Number.POSITIVE_INFINITY;

    for (const handle of this.handles) {
      const collider = handle.collider;
      const building = handle.building;
      // 没有交互 id 的建筑（新区未开放/招商位）不进入交互提示，避免按 F 却什么也不发生。
      if (building.interactionId === '') continue;
      const dx = Math.max(collider.minX - pose.x, 0, pose.x - collider.maxX);
      const dz = Math.max(collider.minZ - pose.z, 0, pose.z - collider.maxZ);
      const centerDistance = Math.hypot(dx, dz);
      const surfaceDistance = Math.max(0, centerDistance - PLAYER.radius);
      if (surfaceDistance > building.interactionDistance) continue;

      const better =
        best === null ||
        surfaceDistance < bestSurface - 1e-9 ||
        (Math.abs(surfaceDistance - bestSurface) <= 1e-9 && building.id < best.id);
      if (better) {
        best = building;
        bestSurface = surfaceDistance;
      }
    }

    this.nearbyBuilding = best;
  }

  /** 摄像机位置与遮挡。dt 用真实时间，不随经济倍率变化。 */
  render(dtSeconds: number): void {
    if (this.interiorMode === 'indoor' && this.interior) {
      this.placeInteriorCamera(dtSeconds, false);
      this.renderer.render(this.interior.scene, this.camera);
      return;
    }
    this.placeCamera(dtSeconds, false);
    // 相机移动之后再让天空与雨体积跟随，避免穹顶与雨幕比画面慢一帧
    this.environment.followCamera();
    this.renderer.render(this.city.scene, this.camera);
  }

  /** 室内近距第三人称：滚轮范围与遮挡硬下限分离，避障优先。 */
  private placeInteriorCamera(dtSeconds: number, immediate: boolean): void {
    const pose = this.player.pose();
    const target = new THREE.Vector3(pose.x, INTERIOR.camera.targetHeight, pose.z);
    if (immediate) {
      this.followTarget.copy(target);
      this.currentDistance = this.desiredDistance;
    } else {
      const followK = 1 - Math.exp(-INTERIOR.camera.followLambda * Math.max(dtSeconds, 0));
      this.followTarget.lerp(target, followK);
      const distK = 1 - Math.exp(-INTERIOR.camera.distanceLambda * Math.max(dtSeconds, 0));
      this.currentDistance += (this.desiredDistance - this.currentDistance) * distK;
    }

    const cosPitch = Math.cos(this.pitch);
    const direction = new THREE.Vector3(
      Math.sin(this.yaw) * cosPitch,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cosPitch,
    ).normalize();

    let distance = this.currentDistance;
    for (const collider of this.interiorOccluders) {
      const hit = rayBoxDistance(this.followTarget, direction, collider, distance);
      if (hit !== null) {
        distance = Math.min(distance, hit - INTERIOR.camera.collisionPadding);
      }
    }
    distance = Math.max(INTERIOR.camera.hardMinDistance, distance);

    this.camera.position
      .copy(this.followTarget)
      .addScaledVector(direction, distance);
    // 天花板/地面双向夹紧：抬头时相机不穿出屋顶，低头时不切入地板
    this.camera.position.y = clamp(
      this.camera.position.y,
      INTERIOR.camera.minHeight,
      INTERIOR.room.height - 0.12,
    );
    this.camera.lookAt(this.followTarget);
    // 贴墙时第三人称距离不足，隐藏人物避免头部挡满画面；离开墙面自动恢复。
    this.player.group.visible = distance >= INTERIOR.camera.characterMinDistance;
  }

  private placeCamera(dtSeconds: number, immediate: boolean): void {
    const pose = this.player.pose();
    const target = new THREE.Vector3(pose.x, CAMERA.targetHeight, pose.z);
    if (immediate) {
      this.followTarget.copy(target);
      this.currentDistance = this.desiredDistance;
    } else {
      const followK = 1 - Math.exp(-CAMERA.followLambda * Math.max(dtSeconds, 0));
      this.followTarget.lerp(target, followK);
      const distK = 1 - Math.exp(-CAMERA.distanceLambda * Math.max(dtSeconds, 0));
      this.currentDistance += (this.desiredDistance - this.currentDistance) * distK;
    }

    const cosPitch = Math.cos(this.pitch);
    const direction = new THREE.Vector3(
      Math.sin(this.yaw) * cosPitch,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cosPitch,
    ).normalize();

    let distance = this.currentDistance;
    for (const collider of this.colliders) {
      const hit = rayBoxDistance(this.followTarget, direction, collider, distance);
      if (hit !== null) {
        distance = Math.min(distance, hit - CAMERA.collisionPadding);
      }
    }
    // 避障结果优先：贴墙时允许摄像机拉到很近，只用一个极小的硬下限兜底，
    // 不能用「舒适跟随距离」把它推回去，否则会重新穿进墙里。
    distance = Math.max(CAMERA.hardMinDistance, distance);

    this.camera.position
      .copy(this.followTarget)
      .addScaledVector(direction, distance);
    if (this.camera.position.y < CAMERA.minHeight) {
      this.camera.position.y = CAMERA.minHeight;
    }
    this.camera.lookAt(this.followTarget);
  }

  resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 返回缓存的当前可交互设施（布局建筑）。
   *
   * app 层用它拿 `id` / `interactionId` / `shopId` / `name` / `subtitle` / `available`；
   * 判定只在 refreshNearbyBuilding 中做，避免两套算法。
   */
  getNearbyBuilding(): LayoutBuilding | null {
    return this.nearbyBuilding;
  }

  /** 存档只保存人物与摄像机；逻辑布局属于 GameState（Lead 的存档切片），这里不重复保存。 */
  getSaveData(): WorldSaveData {
    // 加载中/室内：保存进入前的室外回归快照，经济与物品仍是保存瞬间的最新状态。
    if (this.interiorMode !== 'outdoor' && this.outdoorSnapshot) return this.outdoorSnapshot;
    const pose = this.player.pose();
    return {
      player: { x: pose.x, z: pose.z, facing: pose.facing },
      camera: { yaw: this.yaw, pitch: this.pitch, distance: this.desiredDistance },
      revision: 3,
    };
  }

  /**
   * 读档：先落**原始存档 pose**，等当前布局最终碰撞就绪（楼体挂载完成或明确降级）后，
   * 仅在原位置实际非法时做一次最小必要推出。正常位置不产生任何位移。
   *
   * 调用约定：app 层必须先 `syncLayout(存档布局)` 再 `restore(worldData)`。
   */
  restore(data: WorldSaveData): void {
    this.cancelInterior();
    const pose: PlayerPose = {
      x: data.player.x,
      z: data.player.z,
      facing: data.player.facing,
    };
    this.player.restore(pose);
    if (data.camera) {
      this.yaw = data.camera.yaw;
      this.pitch = clamp(data.camera.pitch, CAMERA.pitch.min, CAMERA.pitch.max);
      this.desiredDistance = clamp(
        data.camera.distance,
        CAMERA.distance.min,
        CAMERA.distance.max,
      );
      this.currentDistance = this.desiredDistance;
    }
    this.clearInput();
    this.placeCamera(0, true);
    this.refreshNearbyBuilding();
    if (this.collisionReady) {
      // 模型已就绪：立即用最终碰撞体做一次「仅非法时」修正
      this.pendingRestorePose = null;
      this.ensurePlayerNotInsideBuildings();
      this.resolveSceneryConflict();
    } else {
      // 模型仍在加载：保留 pose，等碰撞就绪后再修正；期间由 app 锁移动与交互
      this.pendingRestorePose = pose;
    }
  }

  resetToSpawn(): void {
    this.cancelInterior();
    this.pendingRestorePose = null;
    this.player.restore({ x: CITY.spawn.x, z: CITY.spawn.z, facing: Math.PI });
    this.yaw = 0;
    this.pitch = CAMERA.pitch.default;
    this.desiredDistance = CAMERA.distance.default;
    this.currentDistance = this.desiredDistance;
    this.clearInput();
    this.placeCamera(0, true);
    this.refreshNearbyBuilding();
    // 出生点同样可能落在新增装饰里：沿用同一套"只处理装饰冲突"的处理
    this.resolveSceneryConflict();
  }

  /**
   * 销毁顺序固定：先标记失效并取消在途 → 释放场景楼体与占位 → 最后销毁工厂共享资产与 renderer。
   *
   * 先取消在途，迟到贴图/模型结果会就地释放且不会再挂回已销毁的场景；
   * 场景必须在工厂之前释放，否则共享材质/贴图会在楼体还挂在树上时被销毁。
   */
  dispose(): void {
    this.disposed = true;
    this.interiorGeneration += 1;
    this.cancelVisualRequests();
    if (this.interior) {
      // 人物属于全局 Player，不能随室内场景一起 dispose
      this.interior.scene.remove(this.player.group);
      this.interior.dispose();
      this.interior = null;
    }
    this.interiorMode = 'outdoor';
    this.outdoorSnapshot = null;
    this.interiorColliders = [];
    this.interiorOccluders = [];
    this.interiorBounds = null;
    this.interiorExit = null;
    this.pendingVisualLoads = 0;
    this.readyListeners.clear();
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    window.removeEventListener('resize', this.resizeHandler);
    window.removeEventListener('wheel', this.handleWheel);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('pointerlockchange', this.pointerLockHandler);
    this.player.dispose();
    this.environment.dispose();
    // 顺序不能改：装饰街区 -> 场景（含路网）-> 街景共享库 -> 建筑工厂
    this.blocks.dispose();
    this.city.dispose();
    this.sceneryLibrary.dispose();
    this.visualFactory.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
