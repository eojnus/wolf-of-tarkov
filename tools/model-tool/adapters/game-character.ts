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

interface TurnOptions {
  readonly fromYaw: number;
  readonly toYaw: number;
  readonly durationSeconds: number;
  readonly requestedTimes: number[];
}

interface SnapshotOptions {
  readonly action: SemanticAction;
  readonly timeSeconds: number;
  readonly yaws: number[];
  readonly yawProvided: boolean;
  readonly anglesProvided: boolean;
  readonly width: number;
  readonly height: number;
  readonly scaleReference: boolean;
  /** 非 null 时进入连续转向模式；静态四方向与连续转向互斥。 */
  readonly turn: TurnOptions | null;
}

const TURN_ARG_KEYS = ['turnFrom', 'turnTo', 'turnDuration', 'turnSamples'] as const;
const MAX_TURN_DURATION_SECONDS = 10;
const MAX_TURN_SAMPLES = 17;

function parseSampleTimes(value: unknown, durationSeconds: number): number[] {
  const parts =
    typeof value === 'string'
      ? value.split(',').map((part) => part.trim()).filter((part) => part !== '')
      : [];
  if (parts.length === 0) argumentError('turn-samples 必须是非空的逗号分隔秒数，如 0,0.5,1', { value });
  if (parts.length > MAX_TURN_SAMPLES) {
    argumentError(`turn-samples 最多 ${MAX_TURN_SAMPLES} 个采样点`, { count: parts.length });
  }
  const times = parts.map((part) => {
    const parsed = Number(part);
    if (!Number.isFinite(parsed)) argumentError('turn-samples 里存在非数字项', { item: part });
    if (parsed < 0 || parsed > durationSeconds + 1e-9) {
      argumentError(`turn-samples 的 ${part} 超出 0–${durationSeconds} 秒`, {
        item: part,
        durationSeconds,
      });
    }
    return parsed;
  });
  return times;
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

  // 连续转向：四个参数必须成组出现，并与 --yaw / --angles 互斥。
  const presentTurnKeys = TURN_ARG_KEYS.filter(
    (key) => key in args && args[key] !== undefined && args[key] !== null,
  );
  let turn: TurnOptions | null = null;
  if (presentTurnKeys.length > 0) {
    const missing = TURN_ARG_KEYS.filter((key) => !presentTurnKeys.includes(key));
    if (missing.length > 0) {
      argumentError(
        `连续转向需要同时提供 ${TURN_ARG_KEYS.map((key) => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`).join(' / ')}`,
        { missing: missing.map((key) => key) },
      );
    }
    if (yawValue !== null || anglesProvided) {
      argumentError('连续转向模式与 --yaw / --angles 互斥，不能同时使用', {
        yawProvided: yawValue !== null,
        anglesProvided,
      });
    }
    const fromYaw = optionalNumber(args, 'turnFrom') as number;
    const toYaw = optionalNumber(args, 'turnTo') as number;
    const durationSeconds = optionalNumber(args, 'turnDuration') as number;
    if (!(durationSeconds > 0) || durationSeconds > MAX_TURN_DURATION_SECONDS) {
      argumentError(`turn-duration 必须大于 0 且不超过 ${MAX_TURN_DURATION_SECONDS} 秒`, {
        durationSeconds,
      });
    }
    const requestedTimes = parseSampleTimes(args.turnSamples, durationSeconds);
    turn = { fromYaw, toYaw, durationSeconds, requestedTimes };
  }

  return {
    action,
    timeSeconds: round(timeSeconds, 4),
    yaws,
    yawProvided: yawValue !== null,
    anglesProvided,
    width: dimension(args, 'width', DEFAULT_WIDTH),
    height: dimension(args, 'height', DEFAULT_HEIGHT),
    scaleReference: optionalBoolean(args, 'scaleReference') ?? DEFAULT_SCALE_REFERENCE,
    turn,
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
  readonly replay: ReplayComparison;
}

interface ReplayComparison {
  readonly steps: number;
  readonly maxLocalDeviationDeg: number | null;
  readonly maxWorldDeviationDeg: number | null;
  readonly consistent: boolean | null;
  readonly note: string;
}

interface TurnSamplePlan {
  readonly index: number;
  readonly requestedTimeSeconds: number;
  readonly frameIndex: number;
  readonly actualTimeSeconds: number;
  readonly yaw: number;
  readonly duplicateOfSampleIndex: number | null;
}

interface TurnSampleRecord {
  readonly index: number;
  readonly requestedTimeSeconds: number;
  readonly actualTimeSeconds: number;
  readonly frameIndex: number;
  readonly yaw: number;
  readonly file: string | null;
  readonly outputPath: string | null;
  readonly duplicateOfSampleIndex: number | null;
  readonly box: ReturnType<typeof boxJson> | null;
  readonly directions: BoneDirectionReport | null;
  readonly staticReplay: ReplayComparison | null;
}

/** 两个同一 yaw 的完整骨骼旋转报告之间的最大偏差（局部/世界）。 */
function replayComparison(
  first: BoneDirectionReport,
  second: BoneDirectionReport,
  yaw: number,
  steps: number,
): ReplayComparison {
  const comparison = compareYawOrientations(
    [
      { yaw, directions: first },
      { yaw, directions: second },
    ],
    { toleranceDeg: ORIENTATION_TOLERANCE_DEG },
  );
  let maxLocal: number | null = null;
  let maxWorld: number | null = null;
  for (const bone of comparison.bones) {
    if (bone.maxLocalDeviationDeg !== null) {
      maxLocal = maxLocal === null ? bone.maxLocalDeviationDeg : Math.max(maxLocal, bone.maxLocalDeviationDeg);
    }
    if (bone.maxWorldDeviationDeg !== null) {
      maxWorld = maxWorld === null ? bone.maxWorldDeviationDeg : Math.max(maxWorld, bone.maxWorldDeviationDeg);
    }
  }
  return {
    steps,
    maxLocalDeviationDeg: maxLocal === null ? null : round(maxLocal, 2),
    maxWorldDeviationDeg: maxWorld === null ? null : round(maxWorld, 2),
    consistent: comparison.consistent,
    note:
      '同一 yaw、同一总步数下重演的完整骨骼旋转偏差；容差 ' +
      `${ORIENTATION_TOLERANCE_DEG}°。用于确认两次重演一致，不是动作自然度判断。`,
  };
}

export const task: Task = async (
  tools: TaskTools,
  request: ToolRequest,
): Promise<TaskOutput> => {
  const options = readOptions(request);
  const plan = buildMotionPlan(options.action);
  const warmupSteps = Math.max(0, Math.round(options.timeSeconds * 60));

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

  /**
   * 按游戏里的真实顺序重演一个朝向：
   *   1) 重置角色动作状态；2) 设置根朝向；3) 同步世界矩阵；
   *   4) 在当前朝向下逐步 rig.update(dt)。
   * 不能在已生成姿态上整体旋转来冒充其他朝向。
   */
  const simulateAtYaw = (yaw: number, steps: number): void => {
    if (!rig) return;
    rig.reset();
    rig.root.rotation.y = THREE.MathUtils.degToRad(yaw);
    rig.root.updateMatrixWorld(true);
    for (let step = 0; step < steps; step += 1) {
      rig.update(DT_SECONDS, step === 0 ? plan.firstStep : plan.steadyState);
    }
    rig.root.updateMatrixWorld(true);
  };

  const measureCurrent = (): { box: THREE.Box3; directions: BoneDirectionReport } => {
    if (!rig) throw new TaskError('CHARACTER_NOT_LOADED', '角色尚未加载，无法测量', 5);
    return {
      box: new THREE.Box3().setFromObject(rig.root),
      directions: boneWorldDirections(rig.root, BONE_NAMES, { axis: BONE_FORWARD_AXIS }),
    };
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

    if (warmupSteps === 0) {
      warn('CHARACTER_ZERO_STEPS', options.turn
        ? '转向前预热步数为 0；第 0 帧为 reset 姿态，后续帧仍会推进动作'
        : '模拟步数为 0，截图只包含 reset 后的初始姿态', {
        timeSeconds: options.timeSeconds,
      });
    }

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

    /* ------------------------------------------------------- 静态多朝向 */
    if (options.turn === null) {
      // 第一轮：每个 yaw 独立重演，测量包围盒与骨骼方向（场景中还没有参照物）。
      const angleGeometry: Array<{
        yaw: number;
        box: THREE.Box3;
        boxJson: ReturnType<typeof boxJson>;
        directions: BoneDirectionReport;
      }> = [];
      for (const yaw of options.yaws) {
        simulateAtYaw(yaw, warmupSteps);
        const measured = measureCurrent();
        for (const issue of measured.directions.issues) {
          warn('CHARACTER_BONE_DIRECTION', issue, { yaw, phase: 'measure' });
        }
        angleGeometry.push({
          yaw,
          box: measured.box,
          boxJson: boxJson(measured.box),
          directions: measured.directions,
        });
      }

      const unionBox = new THREE.Box3();
      for (const entry of angleGeometry) unionBox.union(entry.box);
      if (unionBox.isEmpty() || !Number.isFinite(unionBox.min.y) || !Number.isFinite(unionBox.max.y)) {
        throw new TaskError('CHARACTER_EMPTY_BOUNDS', '角色包围盒为空或包含非有限值', 5, {
          action: options.action,
          simulatedSteps: warmupSteps,
        });
      }

      const unionSize = unionBox.getSize(new THREE.Vector3());
      const heightMeters = round(unionSize.y);
      const footY = round(unionBox.min.y);

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

      // 多朝向一致性：角色局部旋转应不变，世界旋转应随 yaw 旋转。
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
        warn('CHARACTER_ORIENTATION_MISMATCH', '部分骨骼的局部旋转随 yaw 变化，超过容差', {
          toleranceDeg: ORIENTATION_TOLERANCE_DEG,
          bones: offenders,
        });
      }

      // 第二轮：按同一参数重演每个 yaw，截图；同时核对两轮姿态一致。
      const angles: AngleRecord[] = [];
      for (const entry of angleGeometry) {
        simulateAtYaw(entry.yaw, warmupSteps);
        const measured = measureCurrent();
        const replay = replayComparison(
          entry.directions,
          measured.directions,
          entry.yaw,
          warmupSteps,
        );
        if (replay.consistent === false) {
          warn('CHARACTER_REPLAY_MISMATCH', `yaw=${entry.yaw}° 两轮重演的骨骼旋转不一致`, {
            yaw: entry.yaw,
            maxLocalDeviationDeg: replay.maxLocalDeviationDeg,
            toleranceDeg: ORIENTATION_TOLERANCE_DEG,
          });
        }
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
          directions: measured.directions,
          replay,
        });
      }

      tools.info('GAME_CHARACTER_SNAPSHOT', `已用真实 CharacterRig 生成 ${angles.length} 张截图`, {
        action: options.action,
        warmupSteps,
        angles: options.yaws,
        mode: 'per-yaw-replay',
      });

      const assumptions: string[] = [
        `固定模拟步长 dt = 1/60 秒，每个朝向独立重演 ${warmupSteps} 步（round(time × 60)）。`,
        '每个 yaw 的执行顺序：rig.reset() → 设置 root.rotation.y → root.updateMatrixWorld(true) → 在该朝向下逐步 rig.update(dt, motion)。',
        '不是在某个朝向下模拟一次后仅旋转已生成的姿态；两张截图来自各自 yaw 下的真实 rig.update。',
        '为统一取景框会跑两轮：两轮都从 reset 开始、使用相同 yaw 与步数；报告记录两轮局部旋转偏差（容差 ' +
          `${ORIENTATION_TOLERANCE_DEG}°）。`,
        '动作只来自真实 loadCharacterRig()/rig.update()，没有第二套角色逻辑或伪造 rig。',
        `idle：speed 0、moving=false、grounded=true、verticalVelocity=0。`,
        `walk：speed = PLAYER.speed = ${PLAYER.speed} 米/秒。`,
        `run：speed = PLAYER.speed × PLAYER.sprintMultiplier = ${round(PLAYER.speed * PLAYER.sprintMultiplier)} 米/秒。`,
        `jumpStart 自定常量 TAKEOFF_VERTICAL_VELOCITY = ${TAKEOFF_VERTICAL_VELOCITY} 米/秒；第 1 步 grounded=true + leftGround=true，之后 grounded=false 以便 CharacterRig 的 takeoff 相位自然转入空中。`,
        `airborne 自定常量 AIRBORNE_VERTICAL_VELOCITY = ${AIRBORNE_VERTICAL_VELOCITY} 米/秒，grounded=false。`,
        'land：第 1 步 grounded=true + touchedGround=true，之后保持接地。',
        `相机固定 azimuth ${CAMERA_AZIMUTH_DEG}° / elevation ${CAMERA_ELEVATION_DEG}° / padding ${CAMERA_PADDING}；yaw=0° 表示角色面向相机（正面），180° 为背面。`,
        `朝向一致性容差 ${ORIENTATION_TOLERANCE_DEG}°，局部旋转由角色根世界四元数的逆乘以骨骼世界四元数得到。`,
        `比例为视觉参照：刻度柱每 ${RULER_STEP_METERS} 米一节、地面网格 1 米格，高度取角色包围盒向上取整；不改变游戏比例或物理，也不新增资源文件。`,
        `time 上限 ${MAX_TIME_SECONDS} 秒；宽高限制 ${MIN_DIMENSION}–${MAX_DIMENSION} 像素。`,
        `骨骼方向向量取局部 +${BONE_FORWARD_AXIS.toUpperCase()} 轴；一致性比较完整四元数，包括绕该轴的扭转。`,
        'angles 会四舍五入到 2 位小数并按数值去重；文件名由格式化后的 yaw 生成。',
        'angles 只是各 yaw 的静态独立重演，不是连续转向；连续转向需使用 --turn-from/--turn-to/--turn-duration/--turn-samples。',
      ];

      return {
        data: {
          command: 'snapshot-game-character',
          mode: 'angles',
          action: options.action,
          timeSeconds: options.timeSeconds,
          simulatedSteps: warmupSteps,
          dtSeconds: DT_SECONDS,
          motion: {
            action: options.action,
            firstStep: motionJson(plan.firstStep),
            steadyState: motionJson(plan.steadyState),
            moving: plan.moving,
            sprinting: plan.sprinting,
            note: plan.note,
          },
          simulation: {
            mode: 'per-yaw-replay',
            dtSeconds: DT_SECONDS,
            stepsPerYaw: warmupSteps,
            yawSetBeforeUpdate: true,
            resetPerYaw: true,
            passes: 2,
            note: '每个 yaw 都从 reset 开始、先设置朝向再逐步 update；第二轮用于截图并核对两轮姿态一致。',
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
            replay: entry.replay,
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
            turnProvided: false,
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
        },
      };
    }

    /* ------------------------------------------------------- 连续转向 */
    const turn = options.turn;
    const totalFrames = Math.max(1, Math.round(turn.durationSeconds / DT_SECONDS));
    const yawAtFrame = (frameIndex: number): number =>
      round(turn.fromYaw + ((turn.toYaw - turn.fromYaw) * frameIndex) / totalFrames, 4);
    // 把请求的完整区间映射到量化后的帧区间，确保极短时长的终点也到达终止 yaw。
    const frameOf = (seconds: number): number =>
      Math.min(totalFrames, Math.max(0, Math.round((seconds / turn.durationSeconds) * totalFrames)));

    const firstByFrame = new Map<number, TurnSamplePlan>();
    const plans: TurnSamplePlan[] = turn.requestedTimes.map((requested, index) => {
      const frameIndex = frameOf(requested);
      const first = firstByFrame.get(frameIndex);
      const planEntry: TurnSamplePlan = {
        index,
        requestedTimeSeconds: requested,
        frameIndex,
        actualTimeSeconds: round(frameIndex * DT_SECONDS, 6),
        yaw: yawAtFrame(frameIndex),
        duplicateOfSampleIndex: first ? first.index : null,
      };
      if (!first) firstByFrame.set(frameIndex, planEntry);
      return planEntry;
    });

    if (firstByFrame.size < plans.length) {
      tools.info(
        'TURN_SAMPLE_DEDUPLICATED',
        `${plans.length} 个请求采样点映射到 ${firstByFrame.size} 个不同帧；重复采样不重复截图`,
        {
          duplicates: plans
            .filter((entry) => entry.duplicateOfSampleIndex !== null)
            .map((entry) => ({
              index: entry.index,
              duplicateOf: entry.duplicateOfSampleIndex,
              frameIndex: entry.frameIndex,
            })),
        },
      );
    }

    const targetFrames = [...firstByFrame.keys()].sort((a, b) => a - b);
    const maxFrame = targetFrames[targetFrames.length - 1] ?? 0;
    const targetSet = new Set(targetFrames);

    /**
     * 连续转向重演：预热阶段保持起始 yaw；之后每帧先设置当前 yaw、同步世界矩阵，
     * 再调用 rig.update。yaw 在用户给定的数值方向上线性插值（0→360 不会被改成 0→0）。
     */
    const replayTurn = (
      onFrame: (frameIndex: number, state: { box: THREE.Box3; directions: BoneDirectionReport } | null) => void,
    ): void => {
      if (!rig) return;
      rig.reset();
      rig.root.rotation.y = THREE.MathUtils.degToRad(turn.fromYaw);
      rig.root.updateMatrixWorld(true);
      for (let step = 0; step < warmupSteps; step += 1) {
        rig.update(DT_SECONDS, step === 0 ? plan.firstStep : plan.steadyState);
      }
      rig.root.updateMatrixWorld(true);
      onFrame(0, targetSet.has(0) ? measureCurrent() : null);
      for (let frameIndex = 1; frameIndex <= maxFrame; frameIndex += 1) {
        rig.root.rotation.y = THREE.MathUtils.degToRad(yawAtFrame(frameIndex));
        rig.root.updateMatrixWorld(true);
        rig.update(DT_SECONDS, warmupSteps === 0 && frameIndex === 1 ? plan.firstStep : plan.steadyState);
        rig.root.updateMatrixWorld(true);
        onFrame(frameIndex, targetSet.has(frameIndex) ? measureCurrent() : null);
      }
    };

    // 第一轮：测量采样帧的包围盒与骨骼方向。
    const measuredByFrame = new Map<number, { box: THREE.Box3; directions: BoneDirectionReport }>();
    replayTurn((frameIndex, state) => {
      if (state) measuredByFrame.set(frameIndex, state);
    });

    const unionBox = new THREE.Box3();
    for (const state of measuredByFrame.values()) unionBox.union(state.box);
    if (unionBox.isEmpty() || !Number.isFinite(unionBox.min.y) || !Number.isFinite(unionBox.max.y)) {
      throw new TaskError('CHARACTER_EMPTY_BOUNDS', '连续转向的采样包围盒为空或包含非有限值', 5, {
        action: options.action,
        frames: targetFrames,
      });
    }
    const unionSize = unionBox.getSize(new THREE.Vector3());

    const scaleAnomalies = detectScaleAnomalies(rig.root);
    for (const issue of scaleAnomalies.issues) warn('CHARACTER_SCALE_ANOMALY', issue);
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
        warn('CHARACTER_RULER_SKIPPED', '角色高度无效，无法生成比例参照', {
          heightMeters: round(unionSize.y),
        });
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

    // 第二轮：同一参数重演并截图；按采样序号命名，重复帧不写第二个文件。
    // capture 是异步的，因此第二轮不用同步回调，改为显式循环推进同一套顺序。
    const captures = new Map<number, { file: string; outputPath: string }>();
    const captureTurn = async (): Promise<void> => {
      if (!rig) return;
      const captureAt = async (frameIndex: number): Promise<void> => {
        const target = firstByFrame.get(frameIndex);
        if (!target) return;
        const base64 = await frame.capture();
        if (!base64) {
          throw new TaskError('CAPTURE_FAILED', `转向第 ${frameIndex} 帧截图返回空数据`, 5, {
            frameIndex,
          });
        }
        const file = `character-${options.action}-turn-${String(target.index).padStart(3, '0')}.png`;
        const outputPath = await tools.writePng(file, base64);
        captures.set(frameIndex, { file, outputPath });
      };

      rig.reset();
      rig.root.rotation.y = THREE.MathUtils.degToRad(turn.fromYaw);
      rig.root.updateMatrixWorld(true);
      for (let step = 0; step < warmupSteps; step += 1) {
        rig.update(DT_SECONDS, step === 0 ? plan.firstStep : plan.steadyState);
      }
      rig.root.updateMatrixWorld(true);
      await captureAt(0);
      for (let frameIndex = 1; frameIndex <= maxFrame; frameIndex += 1) {
        rig.root.rotation.y = THREE.MathUtils.degToRad(yawAtFrame(frameIndex));
        rig.root.updateMatrixWorld(true);
        rig.update(DT_SECONDS, warmupSteps === 0 && frameIndex === 1 ? plan.firstStep : plan.steadyState);
        rig.root.updateMatrixWorld(true);
        await captureAt(frameIndex);
      }
    };
    await captureTurn();

    // 静态重演对照：同 yaw、同总步数（预热 + 帧号），比较完整局部旋转。
    const staticReplayByFrame = new Map<number, ReplayComparison>();
    for (const target of plans) {
      if (target.duplicateOfSampleIndex !== null) continue;
      simulateAtYaw(target.yaw, warmupSteps + target.frameIndex);
      const measured = measureCurrent();
      const turnDirections = measuredByFrame.get(target.frameIndex)?.directions ?? null;
      if (!turnDirections) continue;
      const comparison = replayComparison(
        turnDirections,
        measured.directions,
        target.yaw,
        warmupSteps + target.frameIndex,
      );
      staticReplayByFrame.set(target.frameIndex, comparison);
      if (comparison.consistent === false) {
        warn(
          'TURN_STATIC_REPLAY_MISMATCH',
          `转向第 ${target.frameIndex} 帧（yaw=${target.yaw}°）与同参数静态重演的局部旋转不一致`,
          {
            frameIndex: target.frameIndex,
            yaw: target.yaw,
            maxLocalDeviationDeg: comparison.maxLocalDeviationDeg,
            toleranceDeg: ORIENTATION_TOLERANCE_DEG,
          },
        );
      }
    }

    const turnSamples: TurnSampleRecord[] = plans.map((target) => {
      const captured = target.duplicateOfSampleIndex === null
        ? captures.get(target.frameIndex) ?? null
        : null;
      const measured = target.duplicateOfSampleIndex === null
        ? measuredByFrame.get(target.frameIndex) ?? null
        : null;
      return {
        index: target.index,
        requestedTimeSeconds: target.requestedTimeSeconds,
        actualTimeSeconds: target.actualTimeSeconds,
        frameIndex: target.frameIndex,
        yaw: target.yaw,
        file: captured?.file ?? null,
        outputPath: captured?.outputPath ?? null,
        duplicateOfSampleIndex: target.duplicateOfSampleIndex,
        box: measured ? boxJson(measured.box) : null,
        directions: measured?.directions ?? null,
        staticReplay: staticReplayByFrame.get(target.frameIndex) ?? null,
      };
    });

    tools.info('GAME_CHARACTER_TURN', `连续转向生成 ${captures.size} 张截图`, {
      action: options.action,
      fromYaw: turn.fromYaw,
      toYaw: turn.toYaw,
      durationSeconds: turn.durationSeconds,
      samples: plans.length,
      uniqueFrames: captures.size,
    });

    const turnAssumptions: string[] = [
      `固定模拟步长 dt = 1/60 秒；转向持续 ${turn.durationSeconds}s → ${totalFrames} 帧，yaw 按 ${turn.fromYaw}° → ${turn.toYaw}° 线性插值（不改成最短路径）。`,
      `预热 ${options.timeSeconds}s（${warmupSteps} 步）在起始 yaw ${turn.fromYaw}° 下执行；预热阶段角色不转向。`,
      '每帧顺序：设置 root.rotation.y → root.updateMatrixWorld(true) → rig.update(dt, motion)；与游戏“先更新朝向、再更新角色”的顺序一致。',
      'turn-samples 按请求时间占持续时间的比例映射到量化帧区间；报告给出请求时间、实际时间和帧号，重复帧只截一张图。',
      '采样点的局部旋转会随动作时间变化，不能在不同时刻之间直接比较；数值对照只对“相同 yaw、相同总步数（预热 + 帧号）”的静态重演进行。',
      '该模式是受控 CharacterRig 模拟，不是实际游戏输入、不是连续转向手感或性能验收。',
      `相机固定 azimuth ${CAMERA_AZIMUTH_DEG}° / elevation ${CAMERA_ELEVATION_DEG}° / padding ${CAMERA_PADDING}，取景框由采样帧包围盒并集决定。`,
      `朝向一致性比较完整骨骼旋转，容差 ${ORIENTATION_TOLERANCE_DEG}°；方向向量轴 +${BONE_FORWARD_AXIS.toUpperCase()}。`,
      `turn-duration 上限 ${MAX_TURN_DURATION_SECONDS}s，turn-samples 上限 ${MAX_TURN_SAMPLES} 个。`,
    ];

    return {
      data: {
        command: 'snapshot-game-character',
        mode: 'turn',
        action: options.action,
        timeSeconds: options.timeSeconds,
        simulatedSteps: warmupSteps,
        dtSeconds: DT_SECONDS,
        motion: {
          action: options.action,
          firstStep: motionJson(plan.firstStep),
          steadyState: motionJson(plan.steadyState),
          moving: plan.moving,
          sprinting: plan.sprinting,
          note: plan.note,
        },
        simulation: {
          mode: 'continuous-turn',
          dtSeconds: DT_SECONDS,
          warmupSteps,
          yawSetBeforeUpdate: true,
          resetBeforeWarmup: true,
          note: '预热保持起始 yaw；之后每帧先设置朝向、同步矩阵，再调用 rig.update。',
        },
        turn: {
          fromYaw: turn.fromYaw,
          toYaw: turn.toYaw,
          durationSeconds: turn.durationSeconds,
          dtSeconds: DT_SECONDS,
          totalFrames,
          interpolation: 'linear-in-user-direction',
          warmupSeconds: options.timeSeconds,
          warmupSteps,
          yawAtFrameRule: 'fromYaw + (toYaw - fromYaw) × frame / totalFrames',
          uniqueFrames: captures.size,
          requestedSamples: plans.length,
          samples: turnSamples,
          duplicates: plans
            .filter((entry) => entry.duplicateOfSampleIndex !== null)
            .map((entry) => ({
              index: entry.index,
              duplicateOfSampleIndex: entry.duplicateOfSampleIndex,
              frameIndex: entry.frameIndex,
              requestedTimeSeconds: entry.requestedTimeSeconds,
            })),
          staticReplayComparison: {
            toleranceDeg: ORIENTATION_TOLERANCE_DEG,
            method: '同 yaw、同总步数（预热 + 帧号）的独立静态重演，比较完整局部骨骼旋转',
            note: '只用于确认两种重演在同一状态下一致，不判断动作自然度。',
          },
          note: '受控 CharacterRig 模拟，不是实际游戏输入；不代表转向手感、动作自然度或性能。',
        },
        angles: [],
        character: {
          boxScope: 'union-of-sampled-frames',
          box: boxJson(unionBox),
          heightMeters: round(unionSize.y),
          footY: round(unionBox.min.y),
          widthMeters: round(unionSize.x),
          depthMeters: round(unionSize.z),
          modelUrl: PLAYER.model.url,
          configuredHeightMeters: PLAYER.model.height,
        },
        orientation: null,
        orientationNote: '连续转向不跨时间比较局部旋转；数值对照见 turn.samples[].staticReplay。',
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
          turnProvided: true,
          width: options.width,
          height: options.height,
        },
        limits: {
          maxTimeSeconds: MAX_TIME_SECONDS,
          maxTurnDurationSeconds: MAX_TURN_DURATION_SECONDS,
          maxTurnSamples: MAX_TURN_SAMPLES,
          minDimension: MIN_DIMENSION,
          maxDimension: MAX_DIMENSION,
          boneDiagnostics: '只读取现有骨骼与 world matrix；不做重定向、不生成新骨架。',
          scaleAnomalies: '只报告非均匀缩放与镜像，不修正任何变换。',
          singleAngleOrientation: '连续转向模式不适用；静态朝向请用 --angles。',
        },
        assumptions: turnAssumptions,
        note:
          '受控 CharacterRig 连续转向模拟：每帧先设置朝向再调用真实 rig.update；' +
          '不是游戏实际输入，也不能证明动作手感、连续转向流畅度或性能。',
        warningsEmitted: warnings.count,
      },
    };
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
