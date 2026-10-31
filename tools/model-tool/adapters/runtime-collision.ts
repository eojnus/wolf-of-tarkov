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
import type { PhysicsColliderSnapshot } from '../../../src/world/physics/types';
import {
  frameCamera,
  round,
  TaskError,
  type Task,
  type TaskOutput,
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

function addColliderVisual(
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

export const runtimeCollisionTask: Task = async (tools, request): Promise<TaskOutput> => {
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
