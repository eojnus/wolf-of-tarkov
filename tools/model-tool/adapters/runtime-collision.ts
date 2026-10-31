/**
 * 运行时碰撞快照（collision-snapshot）——在隔离工具页中独立创建 World，
 * 读取 World 内真实 PhysicsRuntime 的 Rapier Collider，而不是规划输入。
 *
 * 不连接现有游戏、不读存档；不修改物理对象。每个 CLI 命令只启动一个工具进程。
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { World, type WorldPhysicsDebugSnapshot } from '../../../src/world/world';
import { PhysicsRuntime } from '../../../src/world/physics/runtime';
import type { PhysicsColliderSnapshot } from '../../../src/world/physics/types';
import {
  frameCamera,
  round,
  TaskError,
  type Task,
  type TaskOutput,
  type TaskTools,
  type ToolRequest,
} from '../renderer/api';

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const OUTDOOR_RADIUS_M = 12;
const INDOOR_RADIUS_M = 4;
const MIN_RADIUS_M = 0.5;
const MAX_RADIUS_M = 50;
const AZIMUTH_DEG = 35;
const ELEVATION_DEG = 25;
const FRAME_PADDING = 1.18;
const FOCUS_PADDING = 1.05;
const WORLD_READY_TIMEOUT_MS = 90_000;
const INTERIOR_TIMEOUT_MS = 120_000;
const SCENE_GRID_INTERVAL_M = 2;
const LEGEND = {
  character: '#ff4d4f',
  static: '#4dd0e1',
  other: '#ffb056',
  grid: '#3a4a5a',
} as const;

function dimensionArg(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 64 || value > 8192) {
    throw new TaskError('INVALID_VIEWPORT', `${label} 必须是 64..8192 的整数`, 2, { value });
  }
  return value;
}

function radiusArg(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_RADIUS_M || value > MAX_RADIUS_M) {
    throw new TaskError('INVALID_RADIUS', `radius 必须是 ${MIN_RADIUS_M}..${MAX_RADIUS_M} 米的数字`, 2, {
      value,
    });
  }
  return value;
}

function sceneArg(value: unknown): 'outdoor' | 'indoor' {
  if (value === 'outdoor' || value === 'indoor') return value;
  throw new TaskError('INVALID_SCENE', '--scene 必须是 outdoor 或 indoor', 2, { value });
}

function parseFocus(value: unknown): { x: number; z: number } | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new TaskError('INVALID_FOCUS', 'focus 必须是 "x,z" 米坐标字符串', 2, { value });
  }
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length !== 2) {
    throw new TaskError('INVALID_FOCUS', 'focus 必须是 "x,z" 两段米坐标', 2, { value });
  }
  const x = Number(parts[0]);
  const z = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    throw new TaskError('INVALID_FOCUS', 'focus 的 x/z 必须是有限数字', 2, { value });
  }
  return { x, z };
}

function colorOf(key: keyof typeof LEGEND): number {
  return Number.parseInt(LEGEND[key].slice(1), 16);
}

function roundedPose(pose: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: round(pose.x, 6), y: round(pose.y, 6), z: round(pose.z, 6) };
}

function roundedCollider(collider: PhysicsColliderSnapshot): Record<string, unknown> {
  return {
    ...collider,
    position: roundedPose(collider.position),
    rotation: {
      x: round(collider.rotation.x, 6),
      y: round(collider.rotation.y, 6),
      z: round(collider.rotation.z, 6),
      w: round(collider.rotation.w, 6),
    },
    halfExtents: collider.halfExtents ? roundedPose(collider.halfExtents) : null,
    radius: collider.radius === null ? null : round(collider.radius, 6),
    halfHeight: collider.halfHeight === null ? null : round(collider.halfHeight, 6),
  };
}

function frameAt(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  radius: number,
  padding: number,
): { distance: number } {
  const vFov = (camera.fov * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const fov = Math.min(vFov, hFov);
  const distance = (radius * padding) / Math.sin(fov / 2);
  const azimuth = (AZIMUTH_DEG * Math.PI) / 180;
  const elevation = (ELEVATION_DEG * Math.PI) / 180;
  const offset = new THREE.Vector3(
    Math.sin(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    Math.cos(azimuth) * Math.cos(elevation),
  ).multiplyScalar(distance);
  camera.position.copy(target).add(offset);
  camera.near = 0.1;
  camera.far = 3000;
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return { distance };
}

function cameraRecord(
  mode: string,
  camera: THREE.PerspectiveCamera,
  distance: number,
  target: THREE.Vector3,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    mode,
    ...extra,
    azimuthDeg: AZIMUTH_DEG,
    elevationDeg: ELEVATION_DEG,
    fovDeg: round(camera.fov),
    aspect: round(camera.aspect),
    distance: round(distance),
    position: roundedPose(camera.position),
    target: roundedPose(target),
    near: round(camera.near),
    far: round(camera.far),
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new TaskError('WORLD_TIMEOUT', message, 5, { timeoutMs }));
    }, timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function addColliderVisual(
  scene: THREE.Scene,
  collider: PhysicsColliderSnapshot,
): { box: THREE.Box3 | null; rendered: boolean; renderedAs: 'box' | 'rounded-box' | 'capsule' | null } {
  let geometry: THREE.BufferGeometry | null = null;
  let renderedAs: 'box' | 'rounded-box' | 'capsule' | null = null;
  if (collider.shape === 'cuboid') {
    if (!collider.halfExtents) return { box: null, rendered: false, renderedAs: null };
    geometry = new THREE.BoxGeometry(
      collider.halfExtents.x * 2,
      collider.halfExtents.y * 2,
      collider.halfExtents.z * 2,
    );
    renderedAs = 'box';
  } else if (collider.shape === 'round-cuboid') {
    if (!collider.halfExtents || collider.radius === null) {
      return { box: null, rendered: false, renderedAs: null };
    }
    // Rapier 的 rounded cuboid 是“中心盒 + 圆角半径”；Three 的 RoundedBoxGeometry
    // 外尺寸必须把 border radius 加到每个半轴上，不能退化成普通 BoxGeometry。
    const border = collider.radius;
    const width = (collider.halfExtents.x + border) * 2;
    const height = (collider.halfExtents.y + border) * 2;
    const depth = (collider.halfExtents.z + border) * 2;
    geometry = new RoundedBoxGeometry(width, height, depth, 4, border);
    renderedAs = 'rounded-box';
  } else if (collider.shape === 'capsule') {
    if (collider.radius === null || collider.halfHeight === null) {
      return { box: null, rendered: false, renderedAs: null };
    }
    geometry = new THREE.CapsuleGeometry(
      collider.radius,
      Math.max(0.01, collider.halfHeight * 2),
      8,
      24,
    );
    renderedAs = 'capsule';
  } else {
    // 未知/未支持形状只报告，不用盒子代替。
    return { box: null, rendered: false, renderedAs: null };
  }

  const material = new THREE.MeshBasicMaterial({
    color: colorOf(collider.role),
    transparent: true,
    opacity: collider.role === 'character' ? 0.28 : 0.14,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `runtime-collider-${collider.handle}`;
  mesh.position.set(collider.position.x, collider.position.y, collider.position.z);
  mesh.quaternion.set(
    collider.rotation.x,
    collider.rotation.y,
    collider.rotation.z,
    collider.rotation.w,
  );
  mesh.updateMatrixWorld(true);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({
      color: colorOf(collider.role),
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    }),
  );
  edges.name = `${mesh.name}-edges`;
  edges.position.copy(mesh.position);
  edges.quaternion.copy(mesh.quaternion);
  edges.updateMatrixWorld(true);
  scene.add(mesh, edges);
  return { box: new THREE.Box3().setFromObject(mesh), rendered: true, renderedAs };
}

function createGrid(size: number, centerX: number, centerZ: number): THREE.GridHelper {
  const divisions = Math.max(1, Math.round(size / SCENE_GRID_INTERVAL_M));
  const grid = new THREE.GridHelper(size, divisions, colorOf('grid'), colorOf('grid'));
  grid.name = 'runtime-collision-grid';
  grid.position.set(centerX, 0.02, centerZ);
  grid.material.transparent = true;
  grid.material.opacity = 0.4;
  grid.material.depthWrite = false;
  return grid;
}

function createWorld(container: HTMLElement): {
  world: World;
  physicsFailure: Promise<never>;
} {
  let rejectPhysics!: (error: Error) => void;
  const physicsFailure = new Promise<never>((_, reject) => {
    rejectPhysics = reject;
  });
  // 没有被 race 消费时也不能留下未处理的 rejection。
  physicsFailure.catch(() => {});
  const world = new World(container, {
    onPhysicsError: (message) => {
      rejectPhysics(new Error(message));
    },
  });
  return { world, physicsFailure };
}

async function waitReady(world: World, physicsFailure: Promise<never>, scene: string): Promise<void> {
  await withTimeout(
    Promise.race([world.whenCollisionReady(), physicsFailure]),
    WORLD_READY_TIMEOUT_MS,
    `等待 ${scene} 物理/碰撞就绪超时`,
  );
  if (!world.isCollisionReady()) {
    throw new TaskError('COLLISION_NOT_READY', `${scene} 碰撞未就绪，拒绝生成快照`, 5);
  }
}

/* --------------------------------------------------- 隔离物理自检（--self-check） */

const SELF_CHECK_ROUND = {
  halfX: 0.8,
  halfY: 0.5,
  halfZ: 0.55,
  border: 0.16,
  translation: { x: 0, y: 1.05, z: 0 },
} as const;

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function nearlyEqualPose(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): boolean {
  return (
    Math.abs(a.x - b.x) < 1e-6 &&
    Math.abs(a.y - b.y) < 1e-6 &&
    Math.abs(a.z - b.z) < 1e-6
  );
}

/**
 * 隔离物理自检。只用于验证快照契约，不进入游戏世界：
 *  - 在工具进程单独的 PhysicsRuntime 里加一个真实 Rapier RoundCuboid；
 *  - 用公开的 captureDebugSnapshot() 读取（不复制快照转换逻辑）；
 *  - 用 runtime-collision 的真实绘制函数出图；
 *  - 检查副本隔离、不推进物理。
 *
 * 私有 world 的访问只存在于这段测试辅助代码，不向游戏公开可写 World。
 */
async function runPhysicsSelfCheck(
  tools: TaskTools,
  request: ToolRequest,
): Promise<TaskOutput> {
  const width = dimensionArg(request.args.width, DEFAULT_WIDTH, 'width');
  const height = dimensionArg(request.args.height, DEFAULT_HEIGHT, 'height');
  const config = SELF_CHECK_ROUND;
  const expectedSize = {
    x: 2 * (config.halfX + config.border),
    y: 2 * (config.halfY + config.border),
    z: 2 * (config.halfZ + config.border),
  };

  const runtime = await PhysicsRuntime.create({ x: 0, y: 0, z: 0 }, 0.3);
  try {
    const world = (runtime as unknown as { world: RAPIER.World }).world;
    const stepCalls = { count: 0 };
    const originalStep = world.step.bind(world);
    (world as unknown as { step: () => void }).step = () => {
      stepCalls.count += 1;
      originalStep();
    };

    const countsBeforeAdd = runtime.debugCounts();
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(
        config.translation.x,
        config.translation.y,
        config.translation.z,
      ),
    );
    world.createCollider(
      RAPIER.ColliderDesc.roundCuboid(config.halfX, config.halfY, config.halfZ, config.border),
      body,
    );
    const countsAfterAdd = runtime.debugCounts();

    const stepsBeforeCapture = stepCalls.count;
    const first = runtime.captureDebugSnapshot();
    const second = runtime.captureDebugSnapshot();
    const stepsAfterCapture = stepCalls.count;
    const firstBeforeMutation = stableJson(first);
    const secondBeforeMutation = stableJson(second);

    const roundCollider = second.colliders.find((item) => item.shape === 'round-cuboid');
    if (!roundCollider) {
      throw new TaskError('SELF_CHECK_COLLIDER_MISSING', '隔离世界快照里找不到 round-cuboid', 5, {
        shapes: [...new Set(second.colliders.map((item) => item.shape))],
      });
    }

    // 故意修改第一次返回值里的嵌套对象（只动副本对象）。
    const mutableFirst = first as unknown as {
      colliders: Array<{
        handle: number;
        position: { x: number; y: number; z: number };
        rotation: { x: number; y: number; z: number; w: number };
        halfExtents: { x: number; y: number; z: number } | null;
      }>;
      characterFootPosition: { x: number; y: number; z: number };
    };
    const firstRound =
      mutableFirst.colliders.find((item) => item.handle === roundCollider.handle) ??
      mutableFirst.colliders[0];
    const mutated = {
      position: { ...firstRound.position },
      rotation: { ...firstRound.rotation },
      halfExtents: firstRound.halfExtents ? { ...firstRound.halfExtents } : null,
      foot: { ...mutableFirst.characterFootPosition },
    };
    firstRound.position.x += 999;
    firstRound.rotation.w = 0;
    if (firstRound.halfExtents) firstRound.halfExtents.y += 999;
    mutableFirst.characterFootPosition.x += 999;

    const third = runtime.captureDebugSnapshot();
    const stepsAfterThird = stepCalls.count;

    let actualTranslation: { x: number; y: number; z: number } | null = null;
    world.forEachCollider((collider) => {
      if (collider.handle === roundCollider.handle) {
        const translation = collider.translation();
        actualTranslation = { x: translation.x, y: translation.y, z: translation.z };
      }
    });

    const checks = {
      twoCapturesEqual: firstBeforeMutation === secondBeforeMutation,
      mutationIsolated: secondBeforeMutation === stableJson(third),
      actualColliderUnchanged:
        actualTranslation !== null && nearlyEqualPose(actualTranslation, roundCollider.position),
      noStepDuringCapture:
        stepsAfterCapture === stepsBeforeCapture && stepsAfterThird === stepsAfterCapture,
    };

    const frame = await tools.frame(width, height);
    frame.setBackground(0x101418);
    frame.useDefaultLights();
    const visual = addColliderVisual(frame.scene, roundCollider);
    const visualSize = visual.box
      ? visual.box.getSize(new THREE.Vector3())
      : null;
    const visualSizeMatches =
      visualSize !== null &&
      Math.abs(visualSize.x - expectedSize.x) < 1e-4 &&
      Math.abs(visualSize.y - expectedSize.y) < 1e-4 &&
      Math.abs(visualSize.z - expectedSize.z) < 1e-4;
    const framingBox = visual.box ?? new THREE.Box3(
      new THREE.Vector3(-1, 0, -1),
      new THREE.Vector3(1, 1, 1),
    );
    frameCamera(frame.camera, framingBox, 35, 24, 1.06);
    const png = await tools.writePng(
      'runtime-collision-selfcheck-round-cuboid.png',
      await frame.capture(),
    );

    const partialReasons: string[] = [];
    if (!visual.rendered) partialReasons.push('RoundCuboid 没有被绘制');
    if (visual.renderedAs !== 'rounded-box') partialReasons.push('绘制方式不是 rounded-box');
    if (!visualSizeMatches) partialReasons.push('绘制盒外尺寸与 Rapier 半尺寸 + 圆角半径不一致');
    if (!checks.twoCapturesEqual) partialReasons.push('连续两次快照不一致');
    if (!checks.mutationIsolated) partialReasons.push('修改第一次快照副本影响了后续快照');
    if (!checks.actualColliderUnchanged) partialReasons.push('快照副本与运行时真实 Collider 不一致');
    if (!checks.noStepDuringCapture) partialReasons.push('capture 期间发生了物理 step');

    tools.info('PHYSICS_SELF_CHECK', '隔离物理自检完成', {
      renderedAs: visual.renderedAs,
      checks,
      partialReasons,
    });

    return {
      status: partialReasons.length > 0 ? 'partial' : 'ok',
      data: {
        snapshotKind: 'physics-runtime-selfcheck',
        source: 'PhysicsRuntime/Rapier (isolated)',
        toolVersion: request.toolVersion ?? null,
        threeRevision: THREE.REVISION,
        rapierVersion: RAPIER.version(),
        roundCuboid: {
          shape: roundCollider.shape,
          handle: roundCollider.handle,
          role: roundCollider.role,
          position: roundedPose(roundCollider.position),
          rotation: roundCollider.rotation,
          halfExtents: roundCollider.halfExtents,
          radius: roundCollider.radius,
          expectedVisualSize: {
            x: round(expectedSize.x, 6),
            y: round(expectedSize.y, 6),
            z: round(expectedSize.z, 6),
          },
          visualSize: visualSize
            ? {
                x: round(visualSize.x, 6),
                y: round(visualSize.y, 6),
                z: round(visualSize.z, 6),
              }
            : null,
          visualSizeMatchesRapier: visualSizeMatches,
          rendered: visual.rendered,
          renderedAs: visual.renderedAs,
        },
        snapshotIsolation: {
          captureCalls: 3,
          colliderCountBeforeAdd: countsBeforeAdd.colliders,
          colliderCountAfterAdd: countsAfterAdd.colliders,
          bodyCountBeforeAdd: countsBeforeAdd.bodies,
          bodyCountAfterAdd: countsAfterAdd.bodies,
          stepCallsDuringCaptures: stepsAfterThird - stepsBeforeCapture,
          checks,
          mutatedCopyFields: {
            position: mutated.position,
            rotation: mutated.rotation,
            halfExtents: mutated.halfExtents,
            characterFootPosition: mutated.foot,
          },
          note:
            '自检在工具进程内单独的 PhysicsRuntime 中运行；没有 step 推进、没有玩家会话、没有读写存档。' +
            'checks 只覆盖本次字段与调用，不构成对所有物理状态的绝对保证。',
        },
        character: {
          handle: second.characterHandle,
          footPosition: roundedPose(second.characterFootPosition),
          grounded: second.grounded,
          counts: second.counts,
        },
        screenshot: png,
        partialReasons,
        limitations: [
          '自检世界是工具进程内单独创建的，不是正式游戏地图或玩家会话。',
          'RoundCuboid 由测试辅助代码加入隔离世界；正式 World 仍只创建静态盒与人物胶囊。',
          '只验证 RoundCuboid 的读取/绘制和快照副本语义，不证明所有 Rapier 形状或所有物理状态。',
          '私有 world 访问仅存在于本自检代码，不向游戏公开可写 World。',
        ],
      },
    };
  } finally {
    runtime.dispose();
  }
}

export const runtimeCollisionTask: Task = async (tools, request): Promise<TaskOutput> => {
  if (request.args.selfCheck === true) {
    return runPhysicsSelfCheck(tools, request);
  }
  const scene = sceneArg(request.args.scene);
  const width = dimensionArg(request.args.width, DEFAULT_WIDTH, 'width');
  const height = dimensionArg(request.args.height, DEFAULT_HEIGHT, 'height');
  const requestedFocus = parseFocus(request.args.focus);
  const defaultRadius = scene === 'indoor' ? INDOOR_RADIUS_M : OUTDOOR_RADIUS_M;
  const focusRadius = radiusArg(request.args.radius, defaultRadius);

  const container = document.createElement('div');
  container.style.cssText =
    'position:fixed;left:0;top:0;width:1280px;height:800px;opacity:0;pointer-events:none;';
  document.body.appendChild(container);

  let world: World | null = null;
  try {
    const created = createWorld(container);
    world = created.world;
    await waitReady(world, created.physicsFailure, 'outdoor');

    if (scene === 'indoor') {
      const entered = await withTimeout(
        world.enterInterior(),
        INTERIOR_TIMEOUT_MS,
        '进入默认晴川住宅超时',
      );
      if (!entered.ok) {
        throw new TaskError(
          'INTERIOR_ENTER_FAILED',
          `无法进入默认晴川住宅：${entered.message ?? '未知原因'}`,
          5,
        );
      }
      await waitReady(world, created.physicsFailure, 'indoor');
      if (!world.isIndoor()) {
        throw new TaskError('SCENE_MISMATCH', '请求 indoor，但 World 仍处于室外状态', 5);
      }
    }

    const snapshot: WorldPhysicsDebugSnapshot = world.capturePhysicsDebugSnapshot();
    if (snapshot.interiorMode !== scene) {
      throw new TaskError(
        'SCENE_MISMATCH',
        `请求 ${scene}，实际 World 状态为 ${snapshot.interiorMode}`,
        5,
      );
    }

    const character = snapshot.colliders.find((item) => item.handle === snapshot.characterHandle);
    if (!character) {
      throw new TaskError('CHARACTER_COLLIDER_MISSING', '快照中没有人物胶囊碰撞体', 5);
    }

    const partialReasons: string[] = [];
    if (snapshot.colliders.length !== snapshot.counts.colliders) {
      partialReasons.push('快照 Collider 数与运行时 debugCounts().colliders 不一致');
      tools.warn('COLLIDER_COUNT_MISMATCH', '快照 Collider 数与运行时计数不一致，报告为 partial', {
        snapshot: snapshot.colliders.length,
        runtime: snapshot.counts.colliders,
      });
    }

    const frame = await tools.frame(width, height);
    frame.setBackground(0x101418);
    frame.useDefaultLights();

    const boundsWidth = snapshot.bounds.maxX - snapshot.bounds.minX;
    const boundsDepth = snapshot.bounds.maxZ - snapshot.bounds.minZ;
    const gridSize = Math.max(20, boundsWidth, boundsDepth);
    const overviewGrid = createGrid(
      gridSize,
      (snapshot.bounds.minX + snapshot.bounds.maxX) / 2,
      (snapshot.bounds.minZ + snapshot.bounds.maxZ) / 2,
    );
    frame.scene.add(overviewGrid);

    const visualUnion = new THREE.Box3();
    const renderedAsByHandle = new Map<number, 'box' | 'rounded-box' | 'capsule'>();
    const unrendered: PhysicsColliderSnapshot[] = [];
    let renderedColliders = 0;
    for (const collider of snapshot.colliders) {
      const visual = addColliderVisual(frame.scene, collider);
      if (visual.rendered) {
        renderedColliders += 1;
        if (visual.renderedAs) renderedAsByHandle.set(collider.handle, visual.renderedAs);
        if (visual.box) visualUnion.union(visual.box);
      } else {
        unrendered.push(collider);
      }
    }
    const unknownShapes = unrendered.filter(
      (item) =>
        item.shape !== 'cuboid' && item.shape !== 'round-cuboid' && item.shape !== 'capsule',
    );
    if (unrendered.length > 0) {
      partialReasons.push(`${unrendered.length} 个 Collider 形状未绘制`);
      tools.warn('UNRENDERED_COLLIDER_SHAPES', '存在未绘制 Collider；只报告，不用盒子代替', {
        count: unrendered.length,
        shapes: [...new Set(unrendered.map((item) => item.shape))],
        handles: unrendered.slice(0, 20).map((item) => item.handle),
      });
    }
    if (visualUnion.isEmpty()) {
      visualUnion.set(
        new THREE.Vector3(snapshot.bounds.minX, 0, snapshot.bounds.minZ),
        new THREE.Vector3(snapshot.bounds.maxX, 2, snapshot.bounds.maxZ),
      );
    }

    const overviewFraming = frameCamera(
      frame.camera,
      visualUnion,
      AZIMUTH_DEG,
      ELEVATION_DEG,
      FRAME_PADDING,
    );
    const overviewCamera = cameraRecord('overview', frame.camera, overviewFraming.distance, overviewFraming.target, {
      padding: FRAME_PADDING,
      bounds: {
        min: { x: round(snapshot.bounds.minX), z: round(snapshot.bounds.minZ) },
        max: { x: round(snapshot.bounds.maxX), z: round(snapshot.bounds.maxZ) },
      },
    });
    const overviewPng = await tools.writePng(
      'runtime-collision-overview.png',
      await frame.capture(),
    );

    const focus = requestedFocus ?? {
      x: snapshot.characterFootPosition.x,
      z: snapshot.characterFootPosition.z,
    };
    const targetY =
      character.position.y ?? snapshot.characterFootPosition.y + 0.9;
    const focusTarget = new THREE.Vector3(focus.x, targetY, focus.z);
    const focusGrid = createGrid(focusRadius * 2, focus.x, focus.z);
    frame.scene.add(focusGrid);
    overviewGrid.visible = false;
    const focusFraming = frameAt(frame.camera, focusTarget, focusRadius, FOCUS_PADDING);
    const focusCamera = cameraRecord('closeup', frame.camera, focusFraming.distance, focusTarget, {
      center: { x: round(focus.x), z: round(focus.z) },
      radiusMeters: round(focusRadius),
      padding: FOCUS_PADDING,
    });
    const closeupPng = await tools.writePng(
      'runtime-collision-closeup.png',
      await frame.capture(),
    );

    const rapierVersion = RAPIER.version();
    const characterSummary = {
      handle: character.handle,
      footPosition: roundedPose(snapshot.characterFootPosition),
      grounded: snapshot.grounded,
      collider: roundedCollider(character),
      radius: character.radius,
      halfHeight: character.halfHeight,
      height:
        character.radius !== null && character.halfHeight !== null
          ? round(2 * (character.halfHeight + character.radius), 6)
          : null,
    };

    const limitations = [
      '快照来自工具单独创建的 World 实例，不是现有玩家游戏会话的实时快照。',
      '没有连接现有游戏、没有读取或写入玩家存档。',
      'Collider handle 只在本次运行内有效，不是跨运行稳定 ID。',
      '未知或未支持形状只列入报告并警告，不绘制替代盒子。',
    ];
    if (scene === 'indoor') {
      limitations.push('室内使用默认内存家具布局，不是玩家真实存档中的家具布置。');
    }

    return {
      status: partialReasons.length > 0 ? 'partial' : 'ok',
      data: {
        snapshotKind: 'isolated-game-runtime',
        scene,
        source: 'PhysicsRuntime/Rapier',
        toolVersion: request.toolVersion ?? null,
        threeRevision: THREE.REVISION,
        rapierVersion,
        collisionReady: snapshot.collisionReady,
        interiorMode: snapshot.interiorMode,
        layoutRevision: snapshot.layoutRevision,
        colliderCounts: {
          snapshot: snapshot.colliders.length,
          runtime: snapshot.counts.colliders,
          bodies: snapshot.counts.bodies,
          staticBodies: snapshot.counts.staticBodies,
          rendered: renderedColliders,
          unrendered: unrendered.length,
        },
        colliders: snapshot.colliders.map((collider) => ({
          ...roundedCollider(collider),
          renderedAs: renderedAsByHandle.get(collider.handle) ?? null,
        })),
        character: characterSummary,
        bounds: {
          minX: round(snapshot.bounds.minX, 6),
          maxX: round(snapshot.bounds.maxX, 6),
          minZ: round(snapshot.bounds.minZ, 6),
          maxZ: round(snapshot.bounds.maxZ, 6),
        },
        edgeMargin: round(snapshot.edgeMargin, 6),
        camera: {
          viewport: { width, height },
          overview: overviewCamera,
          closeup: focusCamera,
          focus: { x: round(focus.x, 6), z: round(focus.z, 6) },
          radiusMeters: round(focusRadius, 6),
        },
        screenshots: {
          overview: overviewPng,
          closeup: closeupPng,
        },
        unknownShapes: {
          unrenderedCount: unrendered.length,
          unknownShapeCount: unknownShapes.length,
          shapes: [...new Set(unrendered.map((item) => item.shape))],
        },
        defaultMemoryFurniture: scene === 'indoor',
        partialReasons,
        limitations,
      },
    };
  } finally {
    if (world) {
      try {
        world.dispose();
      } catch {
        /* 释放失败不掩盖主结果 */
      }
    }
    container.remove();
  }
};
