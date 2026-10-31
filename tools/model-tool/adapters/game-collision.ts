/**
 * 静态碰撞几何可视化（D 包）。
 *
 * 只画运行时真实接受的输入几何：
 *  - `layout.buildings[].collision`（业务建筑 AABB）；
 *  - `planCityBlocks(layout).blocks[].colliders`（街区楼体/围墙/家具/树木）；
 *  - `withGround([...], layout.bounds)` 补出的物理地面。
 *
 * 不 import PhysicsRuntime / Rapier，不实例化第二套物理世界，也不读取任何模型网格包围盒。
 * 街区规划是纯确定性函数（hashSeed/mulberry32），同一布局必然得到同一盒集合。
 */

import * as THREE from 'three';
import {
  boxJson,
  frameCamera,
  round,
  TaskError,
  vectorJson,
  type Task,
} from '../renderer/api';
import { CITY, PHYSICS } from '../../../src/content/config';
import { createBaseLayout } from '../../../src/features/city-layout';
import { planCityBlocks, type BlockCollider } from '../../../src/world/blocks/plan';
import { withGround } from '../../../src/world/physics/collision';
import type { PhysicsBox } from '../../../src/world/physics/types';
import { PLAYER_EDGE_MARGIN } from '../../../src/world/player';

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const AZIMUTH_DEG = 35;
const ELEVATION_DEG = 25;
const FRAME_PADDING = 1.18;
const SPAWN_RADIUS_M = 12;
const FOCUS_RADIUS_M = 25;
const FOCUS_PADDING = 1.05;
const OVERVIEW_GRID_INTERVAL_M = 10;
/** 与 `PhysicsRuntime.addStaticBox` 的半边长阈值一致。 */
const DEGENERATE_EPSILON = 1e-5;

const LEGEND = {
  building: '#ffb056',
  block: '#4dd0e1',
  ground: '#6b8f71',
  capsule: '#ff4d4f',
  capsuleRing: '#ffd666',
  axis: '#ffffff',
  grid: '#3a4a5a',
} as const;

type BoxKind = 'building' | 'block' | 'ground';

function colorOf(key: keyof typeof LEGEND): number {
  return Number.parseInt(LEGEND[key].slice(1), 16);
}

function dimensionArg(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 64 || value > 8192) {
    throw new TaskError('INVALID_VIEWPORT', `${label} 必须是 64..8192 的整数`, 2, { value });
  }
  return value;
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

function boxOf(box: PhysicsBox): THREE.Box3 {
  return new THREE.Box3(
    new THREE.Vector3(box.minX, box.minY, box.minZ),
    new THREE.Vector3(box.maxX, box.maxY, box.maxZ),
  );
}

/** 与运行时 `addStaticBox` 相同：任一轴半边长 ≤ 1e-5 即丢弃。 */
function isDegenerate(box: PhysicsBox): boolean {
  return (
    (box.maxX - box.minX) / 2 <= DEGENERATE_EPSILON ||
    (box.maxY - box.minY) / 2 <= DEGENERATE_EPSILON ||
    (box.maxZ - box.minZ) / 2 <= DEGENERATE_EPSILON
  );
}

function blockBoxOf(collider: BlockCollider): PhysicsBox {
  return {
    minX: collider.rect.x0,
    maxX: collider.rect.x1,
    minZ: collider.rect.z0,
    maxZ: collider.rect.z1,
    minY: collider.minY,
    maxY: collider.maxY,
  };
}

function styleMaterial(material: THREE.Material | THREE.Material[], opacity: number): void {
  const list = Array.isArray(material) ? material : [material];
  for (const item of list) {
    item.depthTest = false;
    item.depthWrite = false;
    item.transparent = true;
    item.opacity = opacity;
  }
}

function addBoxHelper(scene: THREE.Scene, box: PhysicsBox, color: number): void {
  const helper = new THREE.Box3Helper(boxOf(box), color);
  helper.name = 'collision-box';
  styleMaterial(helper.material, 0.85);
  scene.add(helper);
}

function createGrid(
  size: number,
  divisions: number,
  centerX: number,
  centerZ: number,
): THREE.GridHelper {
  const grid = new THREE.GridHelper(size, divisions, colorOf('grid'), colorOf('grid'));
  grid.name = 'collision-ground-grid';
  grid.position.set(centerX, 0.02, centerZ);
  grid.material.transparent = true;
  grid.material.opacity = 0.45;
  grid.material.depthWrite = false;
  return grid;
}

function gridRecord(
  size: number,
  divisions: number,
  center: { x: number; z: number },
  note: string,
): Record<string, unknown> {
  return {
    intervalMeters: round(size / divisions, 3),
    sizeMeters: round(size),
    divisions,
    center: { x: round(center.x), z: round(center.z) },
    note,
  };
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
    position: vectorJson(camera.position),
    target: vectorJson(target),
    near: round(camera.near),
    far: round(camera.far),
  };
}

/** 以目标点为球心、给定世界半径取景；角度口径与总览一致。 */
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
  camera.far = 2000;
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return { distance };
}

export const collisionTask: Task = async (tools, request) => {
  const width = dimensionArg(request.args.width, DEFAULT_WIDTH, 'width');
  const height = dimensionArg(request.args.height, DEFAULT_HEIGHT, 'height');
  const focus = parseFocus(request.args.focus);

  const layout = createBaseLayout();

  let plan: ReturnType<typeof planCityBlocks>;
  try {
    plan = planCityBlocks(layout);
  } catch (error) {
    throw new TaskError(
      'COLLISION_DATA_UNAVAILABLE',
      'planCityBlocks(layout) 执行失败，无法取得真实街区碰撞盒',
      3,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (plan.blocks.length === 0) {
    throw new TaskError(
      'COLLISION_DATA_UNAVAILABLE',
      'planCityBlocks(layout) 未产出任何街区，拒绝用假数据代替',
      3,
      { layoutBuildings: layout.buildings.length, skipped: plan.skipped.length },
    );
  }

  const buildingBoxes: PhysicsBox[] = layout.buildings.map((building) => ({
    ...building.collision,
  }));
  const blockBoxes: PhysicsBox[] = plan.blocks.flatMap((block) =>
    block.colliders.map(blockBoxOf),
  );
  const allBoxes = withGround([...buildingBoxes, ...blockBoxes], layout.bounds);

  const byKind: Record<BoxKind, number> = { building: 0, block: 0, ground: 0 };
  const boxesUnion = new THREE.Box3();
  let degenerateDropped = 0;

  const frame = await tools.frame(width, height);
  frame.setBackground(0x101418);
  frame.useDefaultLights();

  const boundsWidth = layout.bounds.maxX - layout.bounds.minX;
  const boundsDepth = layout.bounds.maxZ - layout.bounds.minZ;
  const gridSize = Math.max(boundsWidth, boundsDepth);
  const overviewDivisions = Math.max(1, Math.round(gridSize / OVERVIEW_GRID_INTERVAL_M));
  const overviewGrid = createGrid(
    gridSize,
    overviewDivisions,
    (layout.bounds.minX + layout.bounds.maxX) / 2,
    (layout.bounds.minZ + layout.bounds.maxZ) / 2,
  );
  const spawn = CITY.spawn;
  const spawnGridSize = SPAWN_RADIUS_M * 2;
  const spawnGrid = createGrid(spawnGridSize, spawnGridSize, spawn.x, spawn.z);
  const focusGridSize = FOCUS_RADIUS_M * 2;
  const focusGrid = focus
    ? createGrid(focusGridSize, focusGridSize, focus.x, focus.z)
    : null;
  frame.scene.add(overviewGrid, spawnGrid);
  if (focusGrid) frame.scene.add(focusGrid);

  function activateGrid(name: 'overview' | 'spawn' | 'focus'): void {
    overviewGrid.visible = name === 'overview';
    spawnGrid.visible = name === 'spawn';
    if (focusGrid) focusGrid.visible = name === 'focus';
  }

  allBoxes.forEach((box, index) => {
    if (isDegenerate(box)) {
      degenerateDropped += 1;
      return;
    }
    const kind: BoxKind =
      index === 0 ? 'ground' : index <= buildingBoxes.length ? 'building' : 'block';
    byKind[kind] += 1;
    boxesUnion.union(boxOf(box));
    addBoxHelper(frame.scene, box, colorOf(kind));
  });

  const radius = PHYSICS.character.radius;
  const capsuleHeight = PHYSICS.character.height;
  const centerY = capsuleHeight / 2;
  const capsuleGeometry = new THREE.CapsuleGeometry(
    radius,
    capsuleHeight - 2 * radius,
    8,
    24,
  );

  const capsuleGroup = new THREE.Group();
  capsuleGroup.name = 'collision-player-capsule';
  capsuleGroup.position.set(spawn.x, 0, spawn.z);

  const shellMaterial = new THREE.MeshBasicMaterial({
    color: colorOf('capsule'),
    transparent: true,
    opacity: 0.28,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const shell = new THREE.Mesh(capsuleGeometry, shellMaterial);
  shell.name = 'collision-player-capsule-shell';
  shell.position.y = centerY;

  const wireMaterial = new THREE.MeshBasicMaterial({
    color: colorOf('capsule'),
    wireframe: true,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
    depthWrite: false,
  });
  const wire = new THREE.Mesh(capsuleGeometry, wireMaterial);
  wire.name = 'collision-player-capsule-wire';
  wire.position.y = centerY;

  const ringGeometry = new THREE.TorusGeometry(radius, 0.02, 8, 40);
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: colorOf('capsuleRing'),
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
  });
  const footRing = new THREE.Mesh(ringGeometry, ringMaterial);
  footRing.name = 'collision-capsule-foot-ring';
  footRing.rotation.x = Math.PI / 2;
  footRing.position.y = 0.02;
  const headRing = new THREE.Mesh(ringGeometry, ringMaterial);
  headRing.name = 'collision-capsule-head-ring';
  headRing.rotation.x = Math.PI / 2;
  headRing.position.y = capsuleHeight;

  capsuleGroup.add(shell, wire, footRing, headRing);
  frame.scene.add(capsuleGroup);

  const axis = new THREE.ArrowHelper(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(spawn.x, 0, spawn.z),
    capsuleHeight,
    colorOf('axis'),
    0.18,
    0.08,
  );
  axis.name = 'collision-capsule-axis';
  styleMaterial(axis.line.material, 1);
  styleMaterial(axis.cone.material, 1);
  frame.scene.add(axis);

  const capsuleBox = new THREE.Box3(
    new THREE.Vector3(spawn.x - radius, 0, spawn.z - radius),
    new THREE.Vector3(spawn.x + radius, capsuleHeight, spawn.z + radius),
  );
  const framingUnion = boxesUnion.clone().union(capsuleBox);

  activateGrid('overview');
  const framing = frameCamera(
    frame.camera,
    framingUnion,
    AZIMUTH_DEG,
    ELEVATION_DEG,
    FRAME_PADDING,
  );
  const overviewCamera = cameraRecord(
    'overview',
    frame.camera,
    framing.distance,
    framing.target,
    { padding: FRAME_PADDING },
  );
  const overviewPng = await tools.writePng(
    'collision-overview.png',
    await frame.capture(),
  );

  activateGrid('spawn');
  const spawnTarget = new THREE.Vector3(spawn.x, centerY, spawn.z);
  const spawnFramed = frameAt(frame.camera, spawnTarget, SPAWN_RADIUS_M, FOCUS_PADDING);
  const cameraSpawn = cameraRecord(
    'spawn',
    frame.camera,
    spawnFramed.distance,
    spawnTarget,
    {
      center: { x: round(spawn.x), z: round(spawn.z) },
      radiusMeters: SPAWN_RADIUS_M,
      padding: FOCUS_PADDING,
    },
  );
  const spawnPng = await tools.writePng(
    'collision-spawn.png',
    await frame.capture(),
  );

  let focusCamera: Record<string, unknown> | null = null;
  let focusPng: string | null = null;
  let focusInfo: Record<string, unknown> | null = null;

  if (focus) {
    activateGrid('focus');
    const target = new THREE.Vector3(focus.x, centerY, focus.z);
    const framed = frameAt(frame.camera, target, FOCUS_RADIUS_M, FOCUS_PADDING);
    focusPng = await tools.writePng(
      'collision-focus.png',
      await frame.capture(),
    );
    focusCamera = cameraRecord('focus', frame.camera, framed.distance, target, {
      center: { x: round(focus.x), z: round(focus.z) },
      radiusMeters: FOCUS_RADIUS_M,
      padding: FOCUS_PADDING,
    });
    focusInfo = {
      x: round(focus.x),
      z: round(focus.z),
      radiusMeters: FOCUS_RADIUS_M,
      padding: FOCUS_PADDING,
      png: focusPng,
    };
  }

  const total = byKind.building + byKind.block + byKind.ground;

  const data: Record<string, unknown> = {
    scene: {
      source: 'createBaseLayout()',
      layoutBuildings: layout.buildings.length,
      blockColliders: blockBoxes.length,
      ground: true,
      note:
        '由 createBaseLayout() 与纯函数 planCityBlocks(layout) 确定性重建；盒子只来自 buildings[].collision 与 blocks[].colliders，再以 withGround 补物理地面。',
      grid: {
        overview: gridRecord(
          gridSize,
          overviewDivisions,
          {
            x: (layout.bounds.minX + layout.bounds.maxX) / 2,
            z: (layout.bounds.minZ + layout.bounds.maxZ) / 2,
          },
          '总览 10 m 网格；仅作视觉尺度参照，不代表碰撞体。',
        ),
        near: gridRecord(
          spawnGridSize,
          spawnGridSize,
          { x: spawn.x, z: spawn.z },
          '出生点特写 1 m 网格；仅作视觉尺度参照，不代表碰撞体。',
        ),
        focus: focus
          ? gridRecord(
              focusGridSize,
              focusGridSize,
              focus,
              'focus 特写 1 m 网格；仅作视觉尺度参照，不代表碰撞体。',
            )
          : null,
      },
    },
    boxes: {
      total,
      byKind,
      degenerateDropped,
      bounds: boxJson(boxesUnion),
    },
    capsule: {
      radius: round(radius),
      height: round(capsuleHeight),
      centerY: round(centerY),
      halfHeight: round(capsuleHeight / 2 - radius),
      offset: round(PHYSICS.character.offset),
      spawn: { x: round(spawn.x), z: round(spawn.z), footY: 0, source: 'CITY.spawn' },
      axis: 'Y+（脚底 → 头顶）',
      visual: '真实尺寸半透明外壳 + 线框 + 脚底/头顶水平圆环（未缩放）',
      note: '与 PhysicsRuntime.createCharacterCollider 同参数',
    },
    layout: {
      bounds: {
        minX: round(layout.bounds.minX),
        maxX: round(layout.bounds.maxX),
        minZ: round(layout.bounds.minZ),
        maxZ: round(layout.bounds.maxZ),
      },
      buildings: layout.buildings.length,
      blocks: plan.blocks.length,
      skippedBlocks: plan.skipped.length,
      skippedBlocksNote:
        '来源 planCityBlocks(layout).skipped：由该函数明确判定跳过、因而未产出碰撞的条目数（含手写试点模板、planSites 未通过的站点与 generateBlock 校验失败的生成街区）；与 blocks（实际产出的街区数）不是同一口径。',
      layoutVersion: layout.layoutVersion,
      revision: layout.revision,
    },
    camera: overviewCamera,
    cameraSpawn,
    cameraFocus: focusCamera,
    viewport: {
      width: frame.width,
      height: frame.height,
      pixelRatio: round(frame.renderer.getPixelRatio()),
    },
    png: overviewPng,
    pngSpawn: spawnPng,
    pngFocus: focusPng,
    focus: focusInfo,
    legend: LEGEND,
    parity: [
      '① 未包含会话内 CityBlocks.suppressed 抑制的街区：本图只按 createBaseLayout() 纯重建，读不到会话抑制状态。',
      '② 运行中 PhysicsRuntime.addStaticBox 会丢弃半边长 ≤ 1e-5 的退化盒；本图不绘制它们，并以 degenerateDropped 如实统计。',
      '③ 未包含进入建筑后 setInterior 生成的结构/家具碰撞，只覆盖室外静态盒。',
      `④ PLAYER_EDGE_MARGIN = ${PLAYER_EDGE_MARGIN} m 是物理运行时的位置夹紧，不是碰撞体，本图不把它画成盒。`,
    ],
    limits: [
      '不是运行中 Rapier 世界的逐项快照',
      '不改物理参数与存档',
      '不能替代游戏内手感验收',
      '只覆盖室外静态碰撞盒，不含动态刚体与角色实时位置',
    ],
  };

  return { data };
};
