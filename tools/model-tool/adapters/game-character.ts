/**
 * B 包：`snapshot-game-character` 任务。
 *
 * 用真实游戏角色路径（`src/world/character.loadCharacterRig` + `rig.update(dt, motion)`）
 * 驱动语义动作并截图，提供比例参照与多朝向诊断。
 *
 * 边界：
 *  - 不复制角色逻辑、不伪造 rig、不改 `src/**` 与 `PLAYER` 配置；
 *  - 角色资源走 `PLAYER.model.url` 的页面相对 URL，由渲染页 origin 映射到 public/assets；
 *  - walk / run / jump 等语义动作来自真实 CharacterRig 的程序化骨骼路径，不是资产片段；
 *  - 比例参照物只为视觉参照，不改变游戏比例或物理。
 */

import * as THREE from 'three';
import { PLAYER } from '../../../src/content/config';
import { loadCharacterRig, type CharacterMotion } from '../../../src/world/character';
import {
  TaskError,
  boxJson,
  frameCamera,
  round,
  vectorJson,
  type Task,
  type TaskOutput,
  type ToolRequest,
  type TaskTools,
} from '../renderer/api';
import {
  boneWorldDirections,
  compareYawOrientations,
  detectScaleAnomalies,
  type BoneDirectionReport,
  type YawOrientationSample,
} from '../renderer/transform';

/* ------------------------------------------------------------------ 常量 */

/** 固定模拟步长：不接受外部覆盖，保证同一 time 结果可复现。 */
const DT_SECONDS = 1 / 60;

const DEFAULT_TIME_SECONDS = 0.5;
const DEFAULT_YAW_DEG = 0;
const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 900;
const DEFAULT_SCALE_REFERENCE = true;

/** 自定常量：起跳帧的竖直速度（米/秒，向上为正），只用于触发 takeoff 相位与姿态。 */
const TAKEOFF_VERTICAL_VELOCITY = 1.6;
/** 自定常量：空中阶段的竖直速度（米/秒），保持正向以区分下落姿态。 */
const AIRBORNE_VERTICAL_VELOCITY = 1.2;

const MAX_TIME_SECONDS = 120;
const MIN_DIMENSION = 64;
const MAX_DIMENSION = 4096;

const CAMERA_AZIMUTH_DEG = 0;
const CAMERA_ELEVATION_DEG = 8;
const CAMERA_PADDING = 1.22;
const BACKGROUND_HEX = 0x1b2230;

const RULER_STEP_METERS = 0.25;
const RULER_SEGMENT_WIDTH_METERS = 0.06;
const RULER_OFFSET_METERS = 0.6;
const GRID_MIN_SIZE_METERS = 4;

const BONE_FORWARD_AXIS = 'z' as const;
const ORIENTATION_TOLERANCE_DEG = 1;
const MAX_WARNINGS = 20;

const ACTION_NAMES = ['idle', 'walk', 'run', 'jumpStart', 'airborne', 'land'] as const;
type SemanticAction = (typeof ACTION_NAMES)[number];

const BONE_NAMES: readonly string[] = Object.values(PLAYER.model.bones);

/* ------------------------------------------------------------- 参数解析 */

interface SnapshotOptions {
  readonly action: SemanticAction;
  readonly timeSeconds: number;
  readonly yaws: number[];
  readonly yawProvided: boolean;
  readonly anglesProvided: boolean;
  readonly width: number;
  readonly height: number;
  readonly scaleReference: boolean;
}

function argumentError(message: string, details?: Record<string, unknown>): never {
  throw new TaskError('BAD_ARGUMENT', message, 2, details);
}

function optionalNumber(args: Readonly<Record<string, unknown>>, key: string): number | null {
  if (!(key in args) || args[key] === undefined || args[key] === null) return null;
  const value = args[key];
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) argumentError(`参数 ${key} 必须是有限数字`, { key, value });
  return parsed;
}

function optionalBoolean(args: Readonly<Record<string, unknown>>, key: string): boolean | null {
  if (!(key in args) || args[key] === undefined || args[key] === null) return null;
  const value = args[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true' || text === '1') return true;
    if (text === 'false' || text === '0') return false;
  }
  argumentError(`参数 ${key} 必须是布尔值`, { key, value });
}

function dimension(args: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const value = optionalNumber(args, key);
  if (value === null) return fallback;
  if (!Number.isInteger(value) || value < MIN_DIMENSION || value > MAX_DIMENSION) {
    argumentError(`参数 ${key} 必须是 ${MIN_DIMENSION}–${MAX_DIMENSION} 的整数`, { key, value });
  }
  return value;
}

function formatAngle(value: number): string {
  const rounded = round(value, 2);
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/0+$/, '').replace(/\.$/, '');
}

function parseAngles(value: unknown): number[] {
  let raw: number[] = [];
  if (Array.isArray(value)) {
    raw = value.map((item) => {
      const parsed = typeof item === 'number' ? item : typeof item === 'string' ? Number(item) : Number.NaN;
      if (!Number.isFinite(parsed)) argumentError('angles 数组里存在非数字项', { item });
      return parsed;
    });
  } else if (typeof value === 'string') {
    const parts = value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    if (parts.length === 0) argumentError('angles 不能为空', { value });
    raw = parts.map((part) => {
      const parsed = Number(part);
      if (!Number.isFinite(parsed)) argumentError('angles 里存在非数字项', { item: part });
      return parsed;
    });
  } else {
    argumentError('angles 必须是逗号分隔字符串或数字数组', { value });
  }

  if (raw.length === 0) argumentError('angles 不能为空', { value });
  const seen = new Set<string>();
  const unique: number[] = [];
  for (const angle of raw) {
    const rounded = round(angle, 2);
    const key = formatAngle(rounded);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(rounded);
  }
  return unique;
}

function readOptions(request: ToolRequest): SnapshotOptions {
  const args = request.args;

  const rawAction = args.action;
  let action: SemanticAction = 'idle';
  if (rawAction !== undefined && rawAction !== null) {
    if (typeof rawAction !== 'string') {
      throw new TaskError('BAD_ACTION', 'action 必须是字符串', 2, { action: rawAction });
    }
    const normalized = rawAction.trim();
    if (!(ACTION_NAMES as readonly string[]).includes(normalized)) {
      throw new TaskError('BAD_ACTION', `不支持的 action：${normalized}`, 2, {
        action: normalized,
        allowed: [...ACTION_NAMES],
      });
    }
    action = normalized as SemanticAction;
  }

  const timeValue = optionalNumber(args, 'time');
  const timeSeconds = timeValue === null ? DEFAULT_TIME_SECONDS : timeValue;
  if (!(timeSeconds >= 0) || timeSeconds > MAX_TIME_SECONDS) {
    argumentError(`time 必须在 0–${MAX_TIME_SECONDS} 秒之间`, { timeSeconds });
  }

  const yawValue = optionalNumber(args, 'yaw');
  const yaw = yawValue === null ? DEFAULT_YAW_DEG : yawValue;

  const anglesProvided = 'angles' in args && args.angles !== undefined && args.angles !== null;
  const yaws = anglesProvided ? parseAngles(args.angles) : [round(yaw, 2)];

  return {
    action,
    timeSeconds: round(timeSeconds, 4),
    yaws,
    yawProvided: yawValue !== null,
    anglesProvided,
    width: dimension(args, 'width', DEFAULT_WIDTH),
    height: dimension(args, 'height', DEFAULT_HEIGHT),
    scaleReference: optionalBoolean(args, 'scaleReference') ?? DEFAULT_SCALE_REFERENCE,
  };
}

/* --------------------------------------------------------------- 动作映射 */

interface MotionPlan {
  readonly firstStep: CharacterMotion;
  readonly steadyState: CharacterMotion;
  readonly moving: boolean;
  readonly sprinting: boolean;
  readonly note: string;
}

function buildMotionPlan(action: SemanticAction): MotionPlan {
  const still = {
    speed: 0,
    moving: false,
    sprinting: false,
    grounded: true,
    verticalVelocity: 0,
    leftGround: false,
    touchedGround: false,
  } satisfies CharacterMotion;

  switch (action) {
    case 'idle':
      return {
        firstStep: still,
        steadyState: still,
        moving: false,
        sprinting: false,
        note: '站立不动；CharacterRig 的 idle 片段作为底层，程序化叠加权重保持 0。',
      };
    case 'walk': {
      const motion: CharacterMotion = {
        speed: PLAYER.speed,
        moving: true,
        sprinting: false,
        grounded: true,
        verticalVelocity: 0,
        leftGround: false,
        touchedGround: false,
      };
      return {
        firstStep: motion,
        steadyState: motion,
        moving: true,
        sprinting: false,
        note: `speed 取 PLAYER.speed = ${PLAYER.speed} 米/秒；由 CharacterRig 程序化步态生成。`,
      };
    }
    case 'run': {
      const speed = PLAYER.speed * PLAYER.sprintMultiplier;
      const motion: CharacterMotion = {
        speed,
        moving: true,
        sprinting: true,
        grounded: true,
        verticalVelocity: 0,
        leftGround: false,
        touchedGround: false,
      };
      return {
        firstStep: motion,
        steadyState: motion,
        moving: true,
        sprinting: true,
        note: `speed = PLAYER.speed × PLAYER.sprintMultiplier = ${round(speed)} 米/秒；由 CharacterRig 程序化步态生成。`,
      };
    }
    case 'jumpStart':
      return {
        firstStep: {
          speed: 0,
          moving: false,
          sprinting: false,
          grounded: true,
          verticalVelocity: TAKEOFF_VERTICAL_VELOCITY,
          leftGround: true,
          touchedGround: false,
        },
        steadyState: {
          speed: 0,
          moving: false,
          sprinting: false,
          grounded: false,
          verticalVelocity: TAKEOFF_VERTICAL_VELOCITY,
          leftGround: false,
          touchedGround: false,
        },
        moving: false,
        sprinting: false,
        note: `第 1 步 grounded=true 且 leftGround=true（起跳事件），之后 grounded=false 让 takeoff 相位按 CharacterRig 自身节奏转入空中；verticalVelocity 固定为自定常量 ${TAKEOFF_VERTICAL_VELOCITY} 米/秒。`,
      };
    case 'airborne':
      return {
        firstStep: {
          speed: 0,
          moving: false,
          sprinting: false,
          grounded: false,
          verticalVelocity: AIRBORNE_VERTICAL_VELOCITY,
          leftGround: false,
          touchedGround: false,
        },
        steadyState: {
          speed: 0,
          moving: false,
          sprinting: false,
          grounded: false,
          verticalVelocity: AIRBORNE_VERTICAL_VELOCITY,
          leftGround: false,
          touchedGround: false,
        },
        moving: false,
        sprinting: false,
        note: `grounded=false 且 verticalVelocity 为正（自定常量 ${AIRBORNE_VERTICAL_VELOCITY} 米/秒）。`,
      };
    case 'land':
      return {
        firstStep: {
          speed: 0,
          moving: false,
          sprinting: false,
          grounded: true,
          verticalVelocity: 0,
          leftGround: false,
          touchedGround: true,
        },
        steadyState: {
          speed: 0,
          moving: false,
          sprinting: false,
          grounded: true,
          verticalVelocity: 0,
          leftGround: false,
          touchedGround: false,
        },
        moving: false,
        sprinting: false,
        note: '第 1 步 grounded=true 且 touchedGround=true（落地事件），之后保持接地。',
      };
  }
}

function motionJson(motion: CharacterMotion): Record<string, unknown> {
  return {
    speed: round(motion.speed),
    moving: motion.moving,
    sprinting: motion.sprinting,
    grounded: motion.grounded,
    verticalVelocity: round(motion.verticalVelocity),
    leftGround: motion.leftGround,
    touchedGround: motion.touchedGround,
  };
}

/* ------------------------------------------------------------- 场景参照物 */

interface RulerBuild {
  readonly group: THREE.Group;
  readonly grid: THREE.GridHelper;
  readonly heightMeters: number;
  readonly segmentCount: number;
  readonly gridSizeMeters: number;
}

function buildScaleReference(
  scene: THREE.Scene,
  characterBox: THREE.Box3,
): RulerBuild | null {
  const size = characterBox.getSize(new THREE.Vector3());
  if (!Number.isFinite(size.y) || size.y <= 0) return null;

  const heightMeters = Math.max(RULER_STEP_METERS, Math.ceil(size.y / RULER_STEP_METERS) * RULER_STEP_METERS);
  const center = characterBox.getCenter(new THREE.Vector3());
  const group = new THREE.Group();
  group.name = 'model-tool-ruler-column';
  group.position.set(characterBox.max.x + RULER_OFFSET_METERS, 0, center.z);

  const materialEven = new THREE.MeshStandardMaterial({ color: 0xd8e4ee, roughness: 0.6, metalness: 0 });
  const materialOdd = new THREE.MeshStandardMaterial({ color: 0x4d7ea8, roughness: 0.6, metalness: 0 });
  const materialTick = new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.5, metalness: 0 });

  const segmentCount = Math.round(heightMeters / RULER_STEP_METERS);
  for (let index = 0; index < segmentCount; index += 1) {
    const segment = new THREE.Mesh(
      new THREE.BoxGeometry(
        RULER_SEGMENT_WIDTH_METERS,
        RULER_STEP_METERS * 0.98,
        RULER_SEGMENT_WIDTH_METERS,
      ),
      index % 2 === 0 ? materialEven : materialOdd,
    );
    segment.name = `model-tool-ruler-segment-${index}`;
    segment.position.set(0, RULER_STEP_METERS * (index + 0.5), 0);
    group.add(segment);
  }

  // 每 0.25 m 一条刻度：整米刻度更长，便于数格。
  for (let index = 0; index <= segmentCount; index += 1) {
    const isWholeMeter = Math.abs((index * RULER_STEP_METERS) % 1) < 1e-6;
    const length = isWholeMeter ? 0.34 : 0.18;
    const tick = new THREE.Mesh(
      new THREE.BoxGeometry(length, 0.025, 0.025),
      materialTick,
    );
    tick.name = `model-tool-ruler-tick-${index}`;
    tick.position.set(-length / 2, RULER_STEP_METERS * index, 0);
    group.add(tick);
  }

  const gridSizeMeters = Math.max(
    GRID_MIN_SIZE_METERS,
    Math.ceil(Math.max(size.x, size.z, heightMeters) + 2),
  );
  const grid = new THREE.GridHelper(gridSizeMeters, gridSizeMeters, 0x7f9bb3, 0x3a4a5a);
  grid.name = 'model-tool-ruler-grid';
  grid.position.set(center.x, 0, center.z);
  const gridMaterial = grid.material as THREE.LineBasicMaterial;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.65;

  scene.add(group);
  scene.add(grid);

  return { group, grid, heightMeters, segmentCount, gridSizeMeters };
}

function disposeScaleReference(build: RulerBuild | null): void {
  if (!build) return;
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  for (const object of [build.group, build.grid]) {
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if ((mesh as unknown as { geometry?: THREE.BufferGeometry }).geometry) {
        geometries.add(mesh.geometry);
      }
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of list) {
        if (material) materials.add(material);
      }
    });
    object.removeFromParent();
  }
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

/* ------------------------------------------------------------------ 任务 */

interface AngleRecord {
  readonly yaw: number;
  readonly file: string;
  readonly outputPath: string;
  readonly box: ReturnType<typeof boxJson>;
  readonly directions: BoneDirectionReport;
}

export const task: Task = async (
  tools: TaskTools,
  request: ToolRequest,
): Promise<TaskOutput> => {
  const options = readOptions(request);
  const plan = buildMotionPlan(options.action);
  const simulatedSteps = Math.max(0, Math.round(options.timeSeconds * 60));

  const frame = await tools.frame(options.width, options.height);
  const camera = frame.camera;
  camera.aspect = frame.width / frame.height;
  camera.updateProjectionMatrix();

  let rig: Awaited<ReturnType<typeof loadCharacterRig>> | null = null;
  let ruler: RulerBuild | null = null;
  const warnings = { count: 0 };
  const warn = (code: string, message: string, details?: Record<string, unknown>): void => {
    if (warnings.count >= MAX_WARNINGS) return;
    warnings.count += 1;
    tools.warn(code, message, details);
    if (warnings.count === MAX_WARNINGS) {
      tools.warn('DIAGNOSTIC_TRUNCATED', `诊断条目达到 ${MAX_WARNINGS} 条，后续同类条目已省略`);
    }
  };

  try {
    frame.setBackground(BACKGROUND_HEX);
    frame.useDefaultLights();

    try {
      rig = await loadCharacterRig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TaskError('CHARACTER_LOAD_FAILED', `角色加载失败：${message}`, 5, {
        modelUrl: PLAYER.model.url,
        error: {
          name: error instanceof Error ? error.name : typeof error,
          message,
          stack: error instanceof Error ? (error.stack ?? null) : null,
        },
      });
    }

    frame.scene.add(rig.root);

    // 固定步长模拟；先 reset 再逐步 update，保证同一 time 可复现。
    rig.reset();
    for (let step = 0; step < simulatedSteps; step += 1) {
      rig.update(DT_SECONDS, step === 0 ? plan.firstStep : plan.steadyState);
    }
    rig.root.updateMatrixWorld(true);

    if (simulatedSteps === 0) {
      warn('CHARACTER_ZERO_STEPS', '模拟步数为 0，截图只包含 reset 后的初始姿态', {
        timeSeconds: options.timeSeconds,
      });
    }

    // 朝向循环一：包围盒与骨骼朝向诊断（此时场景中还没有参照物）。
    const angleGeometry: Array<{
      yaw: number;
      box: THREE.Box3;
      boxJson: ReturnType<typeof boxJson>;
      directions: BoneDirectionReport;
    }> = [];
    for (const yaw of options.yaws) {
      rig.root.rotation.y = THREE.MathUtils.degToRad(yaw);
      rig.root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(rig.root);
      const directions = boneWorldDirections(rig.root, BONE_NAMES, { axis: BONE_FORWARD_AXIS });
      for (const issue of directions.issues) {
        warn('CHARACTER_BONE_DIRECTION', issue, { yaw });
      }
      angleGeometry.push({ yaw, box, boxJson: boxJson(box), directions });
    }

    const unionBox = new THREE.Box3();
    for (const entry of angleGeometry) unionBox.union(entry.box);
    if (unionBox.isEmpty() || !Number.isFinite(unionBox.min.y) || !Number.isFinite(unionBox.max.y)) {
      throw new TaskError('CHARACTER_EMPTY_BOUNDS', '角色包围盒为空或包含非有限值', 5, {
        action: options.action,
        simulatedSteps,
      });
    }

    const unionSize = unionBox.getSize(new THREE.Vector3());
    const heightMeters = round(unionSize.y);
    const footY = round(unionBox.min.y);

    const rigBones = (() => {
      const bones: THREE.Bone[] = [];
      rig?.root.traverse((child) => {
        const bone = child as THREE.Bone;
        if (bone.isBone) bones.push(bone);
      });
      const names = bones.map((bone) => bone.name).filter((name) => name.length > 0);
      return {
        count: bones.length,
        mappedCount: BONE_NAMES.length,
        names: names.slice(0, 40),
        namesTruncated: names.length > 40,
      };
    })();

    // 缩放/镜像只报告，不修正；必须在加入参照物之前做，避免把参照物算进去。
    const scaleAnomalies = detectScaleAnomalies(rig.root);
    for (const issue of scaleAnomalies.issues) {
      warn('CHARACTER_SCALE_ANOMALY', issue);
    }
    for (const entry of scaleAnomalies.entries) {
      warn('CHARACTER_SCALE_ANOMALY_ENTRY', `缩放异常：${entry.path}`, {
        path: entry.path,
        kind: entry.kind,
        nonUniform: entry.nonUniform,
        mirrored: entry.mirrored,
        worldScale: entry.worldScale,
        determinant: entry.determinant,
      });
    }

    if (options.scaleReference) {
      ruler = buildScaleReference(frame.scene, unionBox);
      if (!ruler) {
        warn('CHARACTER_RULER_SKIPPED', '角色高度无效，无法生成比例参照', { heightMeters });
      }
    }

    const framingBox = unionBox.clone();
    if (ruler) framingBox.union(new THREE.Box3().setFromObject(ruler.group));
    const framing = frameCamera(
      camera,
      framingBox,
      CAMERA_AZIMUTH_DEG,
      CAMERA_ELEVATION_DEG,
      CAMERA_PADDING,
    );

    // 多朝向一致性：局部方向应不变，世界方向应随 yaw 旋转。
    const samples: YawOrientationSample[] = angleGeometry.map((entry) => ({
      yaw: entry.yaw,
      directions: entry.directions,
    }));
    const orientation = compareYawOrientations(samples, { toleranceDeg: ORIENTATION_TOLERANCE_DEG });
    for (const issue of orientation.issues) {
      warn('CHARACTER_ORIENTATION', issue, { yaws: options.yaws });
    }
    if (options.yaws.length > 1 && orientation.consistent === false) {
      const offenders = orientation.bones
        .filter((bone) => bone.consistent === false)
        .map((bone) => ({ name: bone.name, maxLocalDeviationDeg: bone.maxLocalDeviationDeg }));
      warn('CHARACTER_ORIENTATION_MISMATCH', '部分骨骼的局部方向随 yaw 变化，超过容差', {
        toleranceDeg: ORIENTATION_TOLERANCE_DEG,
        bones: offenders,
      });
    }

    // 朝向循环二：逐角度截图。
    const angles: AngleRecord[] = [];
    for (const entry of angleGeometry) {
      rig.root.rotation.y = THREE.MathUtils.degToRad(entry.yaw);
      rig.root.updateMatrixWorld(true);
      const base64 = await frame.capture();
      if (!base64) {
        throw new TaskError('CAPTURE_FAILED', `yaw=${entry.yaw}° 的截图返回空数据`, 5, {
          yaw: entry.yaw,
        });
      }
      const file = `character-${options.action}-${formatAngle(entry.yaw)}deg.png`;
      const outputPath = await tools.writePng(file, base64);
      angles.push({
        yaw: entry.yaw,
        file,
        outputPath,
        box: entry.boxJson,
        directions: entry.directions,
      });
    }

    tools.info('GAME_CHARACTER_SNAPSHOT', `已用真实 CharacterRig 生成 ${angles.length} 张截图`, {
      action: options.action,
      simulatedSteps,
      angles: options.yaws,
    });

    const assumptions: string[] = [
      `固定模拟步长 dt = 1/60 秒，模拟步数 = round(time × 60) = ${simulatedSteps}；先 rig.reset() 再逐步 rig.update(dt, motion)，同一 time 可复现。`,
      '动作只来自真实 loadCharacterRig()/rig.update()，没有第二套角色逻辑或伪造 rig。',
      `idle：speed 0、moving=false、grounded=true、verticalVelocity=0。`,
      `walk：speed = PLAYER.speed = ${PLAYER.speed} 米/秒。`,
      `run：speed = PLAYER.speed × PLAYER.sprintMultiplier = ${round(PLAYER.speed * PLAYER.sprintMultiplier)} 米/秒。`,
      `jumpStart 自定常量 TAKEOFF_VERTICAL_VELOCITY = ${TAKEOFF_VERTICAL_VELOCITY} 米/秒；第 1 步 grounded=true + leftGround=true，之后 grounded=false 以便 CharacterRig 的 takeoff 相位自然转入空中。`,
      `airborne 自定常量 AIRBORNE_VERTICAL_VELOCITY = ${AIRBORNE_VERTICAL_VELOCITY} 米/秒，grounded=false。`,
      'land：第 1 步 grounded=true + touchedGround=true，之后保持接地。',
      `相机固定 azimuth ${CAMERA_AZIMUTH_DEG}° / elevation ${CAMERA_ELEVATION_DEG}° / padding ${CAMERA_PADDING}；yaw=0° 表示角色面向相机（正面），180° 为背面。`,
      `朝向一致性容差 ${ORIENTATION_TOLERANCE_DEG}°，局部方向取自角色根世界四元数的逆变换。`,
      `比例为视觉参照：刻度柱每 ${RULER_STEP_METERS} 米一节、地面网格 1 米格，高度取角色包围盒向上取整；不改变游戏比例或物理，也不新增资源文件。`,
      `time 上限 ${MAX_TIME_SECONDS} 秒；宽高限制 ${MIN_DIMENSION}–${MAX_DIMENSION} 像素。`,
      `骨骼朝向取骨骼世界四元数作用在局部 +${BONE_FORWARD_AXIS.toUpperCase()} 轴，并在结果中标注 axis。`,
      'angles 会四舍五入到 2 位小数并按数值去重；文件名由格式化后的 yaw 生成。',
    ];

    const data: Record<string, unknown> = {
      command: 'snapshot-game-character',
      action: options.action,
      timeSeconds: options.timeSeconds,
      simulatedSteps,
      dtSeconds: DT_SECONDS,
      motion: {
        action: options.action,
        firstStep: motionJson(plan.firstStep),
        steadyState: motionJson(plan.steadyState),
        moving: plan.moving,
        sprinting: plan.sprinting,
        note: plan.note,
      },
      assumptions,
      note:
        'walk / run / jumpStart / airborne / land 的语义动作由真实 CharacterRig 程序化路径生成，不是资产片段；' +
        'idle 由 CharacterRig 播放 PLAYER.model.clips.idle 的裁剪源片段。截图为游戏内真实控制路径的输出，' +
        '不是用 USDZ 自带展示动作冒充游戏动作。',
      character: {
        boxScope: 'union-of-all-angles',
        box: boxJson(unionBox),
        heightMeters,
        footY,
        widthMeters: round(unionSize.x),
        depthMeters: round(unionSize.z),
        modelUrl: PLAYER.model.url,
        configuredHeightMeters: PLAYER.model.height,
      },
      angles: angles.map((entry) => ({
        yaw: entry.yaw,
        file: entry.file,
        outputPath: entry.outputPath,
        box: entry.box,
        boneDirections: entry.directions,
      })),
      orientation,
      rigBones,
      scaleAnomalies,
      scaleReference: {
        enabled: options.scaleReference,
        built: ruler !== null,
        rulerHeightMeters: ruler ? round(ruler.heightMeters) : null,
        stepMeters: RULER_STEP_METERS,
        segmentCount: ruler ? ruler.segmentCount : null,
        gridCellMeters: 1,
        gridSizeMeters: ruler ? ruler.gridSizeMeters : null,
        objectNames: ruler
          ? {
              column: ruler.group.name,
              segments: `model-tool-ruler-segment-0..${ruler.segmentCount - 1}`,
              ticks: `model-tool-ruler-tick-0..${ruler.segmentCount}`,
              grid: ruler.grid.name,
            }
          : null,
        note:
          '刻度柱与地面网格仅为视觉参照，不改变游戏比例或物理；由 Three.js 在场景内生成，不新增资源文件。',
      },
      camera: {
        azimuthDeg: CAMERA_AZIMUTH_DEG,
        elevationDeg: CAMERA_ELEVATION_DEG,
        padding: CAMERA_PADDING,
        distance: framing.distance,
        target: vectorJson(framing.target),
        aspect: round(frame.width / frame.height, 4),
        fovDeg: camera.fov,
        width: frame.width,
        height: frame.height,
      },
      request: {
        timeProvided: 'time' in request.args,
        yawProvided: options.yawProvided,
        anglesProvided: options.anglesProvided,
        width: options.width,
        height: options.height,
      },
      limits: {
        maxTimeSeconds: MAX_TIME_SECONDS,
        maxSimulatedSteps: Math.round(MAX_TIME_SECONDS * 60),
        minDimension: MIN_DIMENSION,
        maxDimension: MAX_DIMENSION,
        boneDiagnostics: '只读取现有骨骼与 world matrix；不做重定向、不生成新骨架。',
        scaleAnomalies: '只报告非均匀缩放与镜像，不修正任何变换。',
        poseTimingHint:
          `CharacterRig 的起跳位姿只持续 PLAYER.model.jump.startSeconds = ${PLAYER.model.jump.startSeconds}s，` +
          `落地位姿只持续 PLAYER.model.jump.landSeconds = ${PLAYER.model.jump.landSeconds}s；` +
          'time 更长时会按 CharacterRig 自身状态机进入后续相位，截图不再停在触发位姿。',
        singleAngleOrientation: '只有一个朝向时无法判断一致性，报告 orientation.consistent 为 null 并给出 warning。',
      },
      warningsEmitted: warnings.count,
    };

    return { data };
  } finally {
    disposeScaleReference(ruler);
    rig?.dispose();
  }
};

/**
 * `renderer/main.ts` 的命令表按 `<name>Task` 命名导入；`task` 是共享契约里的通用导出名。
 * 两者指向同一个实现，避免复制逻辑。
 */
export const characterTask: Task = task;
