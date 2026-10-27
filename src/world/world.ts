/**
 * 世界编排 —— 第三人称摄像机、鼠标锁定、移动输入、入口交互、人物与建筑模型加载。
 *
 * 职责边界：
 *  - 世界只读取**逻辑地图（features/city-layout 的只读视图）**与玩家位置，不读写经济状态；
 *  - 人物移动边界、读档位置修正、地面渲染全部使用同一份动态 `bounds`，
 *    不再使用固定 `CITY.groundSize / 2`；
 *  - 布局按稳定 id 增量同步，不销毁重建整个 World；模型加载用 `modelGeneration`
 *    + `layoutRevision` 双检查，旧读档的异步回调不会写回新布局；
 *  - 摄像机与移动都用「按时间指数趋近」做平滑，手感不依赖帧率。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CAMERA, CITY, PLAYER } from '../content/config';
import {
  createBaseLayout,
  type CityLayoutView,
  type LayoutBounds,
  type LayoutBuilding,
} from '../features/city-layout';
import type { ReadonlyEnvironmentState } from '../features/environment';
import type { WorldSaveData } from '../infrastructure/storage';
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
import {
  applyBuildingModel,
  buildCityScene,
  disposeObject,
  type BuildingHandle,
  type CityScene,
  type Collider,
} from './scene';

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

/** 布局结构指纹：用于判断是否需要真正同步（存档 revision 可在不同存档间重复）。 */
function layoutFingerprint(layout: CityLayoutView): string {
  const buildings = layout.buildings
    .map((building) =>
      [
        building.id,
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
    buildings,
    roads,
  ].join('#');
}

export interface WorldCallbacks {
  onPointerLockChange?(locked: boolean): void;
  /** 碰撞就绪状态变化（模型加载完成/明确回退）时通知；供 app 层刷新遮罩与交互提示。 */
  onCollisionReadyChange?(ready: boolean): void;
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
  private readonly modelLoader = new GLTFLoader();
  /** 就绪监听：碰撞由未就绪变为就绪时通知；可重复订阅/退订。 */
  private readonly readyListeners = new Set<() => void>();

  /** 当前逻辑布局（只读视图）及其结构指纹。 */
  private layoutFingerprintValue: string;
  /** 当前布局的建筑实例与碰撞体（与场景同源）。 */
  private handles: readonly BuildingHandle[] = [];
  private colliders: Collider[] = [];
  /** 人物移动、位置修正、地面渲染共用的动态边界。 */
  private bounds: LayoutBounds;
  private layoutRevision = 0;
  /**
   * 模型代次：每次布局同步 +1。异步加载回调必须同时核对「代次 + 布局 revision +
   * 建筑实例仍在当前布局中」才允许写回碰撞/替换外观，旧 Promise 不得覆盖新布局。
   */
  private modelGeneration = 0;
  private pendingModelLoads = 0;
  private collisionReady = true;
  /** 已成功应用模型的建筑 id；几何被替换时会移除并重新加载。 */
  private readonly loadedModelIds = new Set<string>();
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
    this.city = buildCityScene(initialLayout);
    this.handles = this.city.buildings;
    this.colliders = this.handles.map((handle) => handle.collider);
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

    this.beginModelLoading();
    void this.loadCharacter();
  }

  /* ---------------------------------------------------------- 布局同步 */

  /**
   * 同步逻辑地图 —— 按稳定 id 增量建/删建筑与道路实例，不销毁重建整个 World。
   *
   * app 层约定：构造后、新游戏、读档后、以及检测到 `cityLayout.revision` 变化时调用。
   * 内部再做结构指纹比较，因此重复调用与「不同存档 revision 恰好相同」都不会丢更新。
   */
  syncLayout(layout: CityLayoutView): void {
    const fingerprint = layoutFingerprint(layout);
    if (fingerprint === this.layoutFingerprintValue) return;

    const previousHandles = new Map<string, BuildingHandle>();
    for (const handle of this.handles) previousHandles.set(handle.building.id, handle);

    this.layoutFingerprintValue = fingerprint;
    this.layoutRevision = layout.revision;
    this.bounds = { ...layout.bounds };

    this.city.syncLayout(layout);
    this.handles = this.city.buildings;
    this.colliders = this.handles.map((handle) => handle.collider);
    // 城区扩张后雾的基数随边界变化；天气修饰仍由环境系统叠加
    this.environment.setFogBase(this.city.fogBase.near, this.city.fogBase.far);

    // 几何被替换（或新增）的建筑需要重新应用模型；保留实例的建筑继续用已有模型。
    for (const handle of this.handles) {
      const before = previousHandles.get(handle.building.id);
      if (before !== handle) this.loadedModelIds.delete(handle.building.id);
    }

    this.beginModelLoading();
    this.refreshNearbyBuilding();
    this.placeCamera(0, true);
  }

  /* ---------------------------------------------------------- 模型加载 */

  /**
   * 为当前布局中「有 model 且尚未成功应用」的建筑启动 GLB 加载。
   *
   * 每次调用都开启新代次：旧代次的加载结果即使稍后返回也会被丢弃并释放，
   * 因此「读档 A → 立刻读档 B」时，A 的模型不会覆盖 B 的碰撞体或外观。
   * 加载失败保留布局配置 AABB（明确回退碰撞），同样视为已就绪。
   */
  private beginModelLoading(): void {
    const generation = ++this.modelGeneration;
    const targets: BuildingHandle[] = [];
    for (const handle of this.handles) {
      if (handle.building.model === null) continue;
      if (this.loadedModelIds.has(handle.building.id)) continue;
      targets.push(handle);
    }
    this.pendingModelLoads = targets.length;
    this.collisionReady = targets.length === 0;
    for (const handle of targets) {
      void this.loadBuildingModel(handle, generation, this.layoutRevision);
    }
    if (this.collisionReady) this.markCollisionReady();
    else this.notifyCollisionReadyChange(false);
  }

  /** 把「碰撞就绪状态变化」异步通知给 app 层，避免在 World 构造期间回调到未赋值字段。 */
  private notifyCollisionReadyChange(ready: boolean): void {
    const callback = this.callbacks.onCollisionReadyChange;
    if (!callback) return;
    queueMicrotask(() => {
      if (!this.disposed) callback(ready);
    });
  }

  private async loadBuildingModel(
    handle: BuildingHandle,
    generation: number,
    layoutRevision: number,
  ): Promise<void> {
    const url = handle.building.model;
    if (!url) return;
    try {
      const gltf = await this.modelLoader.loadAsync(url);
      if (this.disposed) {
        disposeObject(gltf.scene);
        return;
      }
      // 双检查：代次 + 布局 revision + 建筑实例仍是当前布局里的同一个实例。
      const stale =
        generation !== this.modelGeneration ||
        layoutRevision !== this.layoutRevision ||
        !this.handles.includes(handle) ||
        handle.building.model !== url;
      if (stale) {
        disposeObject(gltf.scene);
        return;
      }
      applyBuildingModel(handle, gltf.scene);
      this.loadedModelIds.add(handle.building.id);
      this.refreshNearbyBuilding();
    } catch (error) {
      if (generation === this.modelGeneration) {
        console.warn(`[world] 建筑模型加载失败，保留灰盒碰撞：${handle.building.id}`, error);
      }
    } finally {
      this.settleModelLoad(generation);
    }
  }

  /** 一次模型加载结束（成功/回退/过期）后的计数；过期代次不得影响新布局的就绪状态。 */
  private settleModelLoad(generation: number): void {
    if (this.disposed || generation !== this.modelGeneration) return;
    this.pendingModelLoads = Math.max(0, this.pendingModelLoads - 1);
    if (this.pendingModelLoads === 0) this.markCollisionReady();
  }

  /** 碰撞就绪：通知监听者，并把等待中的读档位置修正补上（仅当原位置非法时）。 */
  private markCollisionReady(): void {
    this.collisionReady = true;
    this.notifyCollisionReadyChange(true);
    for (const listener of [...this.readyListeners]) listener();
    this.applyPendingRestoreCorrection();
  }

  /** 碰撞（含模型加载或明确回退）是否已经就绪；app 层据此锁人物移动与 F 交互。 */
  isCollisionReady(): boolean {
    return this.collisionReady;
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
    for (let pass = 0; pass < this.colliders.length; pass += 1) {
      const hit = this.colliders.find(
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

  /** 碰撞就绪后：如果读档时原位置非法，做一次最小必要推出。 */
  private applyPendingRestoreCorrection(): void {
    if (this.pendingRestorePose === null) return;
    this.pendingRestorePose = null;
    this.ensurePlayerNotInsideBuildings();
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

  private handleMouseMove = (event: MouseEvent): void => {
    if (!this.pointerLocked) return;
    this.yaw -= event.movementX * CAMERA.sensitivity;
    this.pitch = clamp(
      this.pitch + event.movementY * CAMERA.sensitivity,
      CAMERA.pitch.min,
      CAMERA.pitch.max,
    );
  };

  private handleWheel = (event: WheelEvent): void => {
    if (!this.pointerLocked) return;
    event.preventDefault();
    const factor = event.deltaY > 0 ? 1 / CAMERA.zoomStep : CAMERA.zoomStep;
    this.desiredDistance = clamp(
      this.desiredDistance * factor,
      CAMERA.distance.min,
      CAMERA.distance.max,
    );
  };

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
    const pose = this.player.pose();
    this.environment.update(minute, dtSeconds, weather, pose.x, pose.z);
  }

  update(dtMoveSeconds: number, canMove: boolean, moveMultiplier = 1): PlayerUpdateResult {
    // 碰撞未就绪（GLB 仍在加载）时即使 app 层传允许移动也必须锁住，
    // 避免用布局 AABB 走完后模型变大把人物卡进建筑。
    const canMoveNow = canMove && this.collisionReady;
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
    this.refreshNearbyBuilding();
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
    this.placeCamera(dtSeconds, false);
    // 相机移动之后再让天空与雨体积跟随，避免穹顶与雨幕比画面慢一帧
    this.environment.followCamera();
    this.renderer.render(this.city.scene, this.camera);
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
    const pose = this.player.pose();
    return {
      player: { x: pose.x, z: pose.z, facing: pose.facing },
      camera: { yaw: this.yaw, pitch: this.pitch, distance: this.desiredDistance },
      revision: 3,
    };
  }

  /**
   * 读档：先落**原始存档 pose**，等当前布局最终碰撞就绪（模型加载完成或明确回退）后，
   * 仅在原位置实际非法时做一次最小必要推出。正常位置不产生任何位移。
   *
   * 调用约定：app 层必须先 `syncLayout(存档布局)` 再 `restore(worldData)`。
   */
  restore(data: WorldSaveData): void {
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
    } else {
      // 模型仍在加载：保留 pose，等碰撞就绪后再修正；期间由 app 锁移动与交互
      this.pendingRestorePose = pose;
    }
  }

  resetToSpawn(): void {
    this.pendingRestorePose = null;
    this.player.restore({ x: CITY.spawn.x, z: CITY.spawn.z, facing: Math.PI });
    this.yaw = 0;
    this.pitch = CAMERA.pitch.default;
    this.desiredDistance = CAMERA.distance.default;
    this.currentDistance = this.desiredDistance;
    this.clearInput();
    this.placeCamera(0, true);
    this.refreshNearbyBuilding();
  }

  dispose(): void {
    this.disposed = true;
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
    this.city.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
