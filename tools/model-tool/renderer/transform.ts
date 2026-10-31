/**
 * 朝向 / 比例诊断的纯函数（B 包）。
 *
 * 边界：
 *  - 不加载资源、不创建 WebGL、不改场景；只读取调用方已经更新过的矩阵；
 *  - 只报告，不修正：发现缩放/镜像问题由调用方写进诊断与报告；
 *  - 无法判断时返回 null，绝不静默填 0；
 *  - 所有角度单位为度，保留 2 位小数。
 *
 * 调用约定：调用本模块前，调用方必须已经对角色根调用 `updateMatrixWorld(true)`，
 * 否则读到的是上一帧的世界矩阵。本模块自身不触发矩阵更新，避免副作用。
 */

import * as THREE from 'three';

export type ForwardAxis = 'z' | 'y';

export interface Vec3Json {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface BoneDirectionEntry {
  readonly name: string;
  readonly found: boolean;
  /** 取骨骼世界四元数作用在哪个局部轴上；'+Z' 表示角色前向语义，'+Y' 表示骨骼纵轴语义。 */
  readonly axis: ForwardAxis;
  readonly worldDirection: Vec3Json | null;
  /** 相对角色根世界四元数的方向；同一姿态下应与人物的 yaw 无关。 */
  readonly localDirection: Vec3Json | null;
  readonly worldPosition: Vec3Json | null;
  /** 从角色根到该骨骼经过的父级链长度；不在根之下时为 null。 */
  readonly parentDepth: number | null;
  /** 无法计算时的原因；正常为 null。 */
  readonly reason: string | null;
}

export interface BoneDirectionReport {
  readonly axis: ForwardAxis;
  readonly reference: string;
  readonly bones: BoneDirectionEntry[];
  /** 调用侧必须转成 warning 诊断，不得吞掉。 */
  readonly issues: string[];
}

export interface BoneDirectionOptions {
  readonly axis?: ForwardAxis;
}

const EPSILON = 1e-9;
const MAX_CHAIN = 512;

function round2(value: number): number {
  const factor = 100;
  return Math.round(value * factor) / factor;
}

function vectorJson(v: THREE.Vector3): Vec3Json {
  return { x: round2(v.x), y: round2(v.y), z: round2(v.z) };
}

function isFiniteMatrix(matrix: THREE.Matrix4): boolean {
  return matrix.elements.every((value) => Number.isFinite(value));
}

/** 两个单位向量之间的夹角（度）；非有限输入返回 null。 */
export function angleBetweenDegrees(
  a: THREE.Vector3,
  b: THREE.Vector3,
): number | null {
  if (!isFiniteVector(a) || !isFiniteVector(b)) return null;
  const dot = THREE.MathUtils.clamp(a.dot(b), -1, 1);
  return round2((Math.acos(dot) * 180) / Math.PI);
}

function isFiniteVector(v: THREE.Vector3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function parentDepthWithin(root: THREE.Object3D, object: THREE.Object3D): number | null {
  let depth = 0;
  let cursor: THREE.Object3D | null = object;
  for (let i = 0; i < MAX_CHAIN; i += 1) {
    if (cursor === root) return depth;
    if (!cursor || !cursor.parent) return null;
    cursor = cursor.parent;
    depth += 1;
  }
  return null;
}

/**
 * 每个骨骼的世界前向方向（以及换算回角色局部空间的方向）。
 *
 * 方向取骨骼世界四元数作用在指定局部轴上，并在结果里标注轴；
 * 骨骼缺失或矩阵非有限时 `worldDirection` / `localDirection` 为 null 且带 reason。
 */
export function boneWorldDirections(
  root: THREE.Object3D,
  boneNames: readonly string[],
  options: BoneDirectionOptions = {},
): BoneDirectionReport {
  const axis: ForwardAxis = options.axis ?? 'z';
  const axisVector = axis === 'z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const issues: string[] = [];
  const bones: BoneDirectionEntry[] = [];

  const rootQuat = new THREE.Quaternion();
  const rootScale = new THREE.Vector3();
  const rootPosition = new THREE.Vector3();
  const rootMatrixOk = isFiniteMatrix(root.matrixWorld);
  if (rootMatrixOk) {
    root.matrixWorld.decompose(rootPosition, rootQuat, rootScale);
  } else {
    issues.push('角色根的世界矩阵包含非有限值，局部方向无法换算');
  }
  const rootQuatInverse = rootQuat.clone().invert();

  const worldQuat = new THREE.Quaternion();
  const objectScale = new THREE.Vector3();
  const objectPosition = new THREE.Vector3();
  const worldDirection = new THREE.Vector3();
  const localDirection = new THREE.Vector3();

  for (const name of boneNames) {
    const bone = root.getObjectByName(name);
    if (!bone) {
      bones.push({
        name,
        found: false,
        axis,
        worldDirection: null,
        localDirection: null,
        worldPosition: null,
        parentDepth: null,
        reason: '角色根下找不到该名称的骨骼',
      });
      issues.push(`骨骼 ${name} 不存在，无法给出朝向`);
      continue;
    }

    const depth = parentDepthWithin(root, bone);
    if (depth === null) {
      bones.push({
        name,
        found: true,
        axis,
        worldDirection: null,
        localDirection: null,
        worldPosition: null,
        parentDepth: null,
        reason: '该对象不在角色根之下，父子链无法确认',
      });
      issues.push(`骨骼 ${name} 不在角色根之下`);
      continue;
    }

    if (!isFiniteMatrix(bone.matrixWorld)) {
      bones.push({
        name,
        found: true,
        axis,
        worldDirection: null,
        localDirection: null,
        worldPosition: null,
        parentDepth: depth,
        reason: '骨骼世界矩阵包含非有限值',
      });
      issues.push(`骨骼 ${name} 的世界矩阵包含非有限值`);
      continue;
    }

    bone.matrixWorld.decompose(objectPosition, worldQuat, objectScale);
    worldDirection.copy(axisVector).applyQuaternion(worldQuat);
    localDirection.copy(worldDirection).applyQuaternion(rootQuatInverse);

    if (!isFiniteVector(worldDirection) || !isFiniteVector(localDirection)) {
      bones.push({
        name,
        found: true,
        axis,
        worldDirection: null,
        localDirection: null,
        worldPosition: vectorJson(objectPosition),
        parentDepth: depth,
        reason: '方向分量非有限',
      });
      issues.push(`骨骼 ${name} 的方向分量非有限`);
      continue;
    }

    if (worldDirection.lengthSq() < EPSILON) {
      bones.push({
        name,
        found: true,
        axis,
        worldDirection: null,
        localDirection: null,
        worldPosition: vectorJson(objectPosition),
        parentDepth: depth,
        reason: '世界四元数退化，方向长度为 0',
      });
      issues.push(`骨骼 ${name} 的四元数退化`);
      continue;
    }

    bones.push({
      name,
      found: true,
      axis,
      worldDirection: vectorJson(worldDirection),
      localDirection: vectorJson(localDirection),
      worldPosition: vectorJson(objectPosition),
      parentDepth: depth,
      reason: null,
    });
  }

  return { axis, reference: root.name || '(unnamed-root)', bones, issues };
}

/* ------------------------------------------------------------ 多朝向一致性 */

export interface YawOrientationSample {
  /** 角色根绕 Y 轴的旋转角（度）。 */
  readonly yaw: number;
  readonly directions: BoneDirectionReport;
}

export interface BoneYawDeviation {
  readonly yaw: number;
  /** 相对 0 号样本局部方向的最大偏差（度）；缺数据为 null。 */
  readonly localDeviationDeg: number | null;
  /** 世界方向与「0 号样本世界方向绕 Y 旋转 yaw 差」的偏差（度）；缺数据为 null。 */
  readonly worldDeviationDeg: number | null;
}

export interface BoneYawConsistency {
  readonly name: string;
  readonly axis: ForwardAxis;
  /** 最大局部偏差（度）；无法判断为 null。 */
  readonly maxLocalDeviationDeg: number | null;
  readonly maxWorldDeviationDeg: number | null;
  /** 局部方向是否在容差内保持不变；无法判断为 null。 */
  readonly consistent: boolean | null;
  readonly perYaw: BoneYawDeviation[];
}

export interface YawOrientationComparison {
  readonly toleranceDeg: number;
  readonly yaws: number[];
  readonly bones: BoneYawConsistency[];
  readonly consistent: boolean | null;
  readonly issues: string[];
}

export interface YawCompareOptions {
  readonly toleranceDeg?: number;
}

const DEFAULT_TOLERANCE_DEG = 1;

/**
 * 比较同一骨骼在不同 yaw 下的方向。
 *
 * 判据：角色局部方向应基本不变（主判据）；世界方向应等于 0 号样本绕 Y 旋转 yaw 差
 * （副判据，用来确认旋转确实作用在世界空间而不是被骨骼层级吞掉）。
 * 样本不足 2 个或骨骼缺失时返回 null，并把原因写进 issues。
 */
export function compareYawOrientations(
  samples: readonly YawOrientationSample[],
  options: YawCompareOptions = {},
): YawOrientationComparison {
  const toleranceDeg = options.toleranceDeg ?? DEFAULT_TOLERANCE_DEG;
  const issues: string[] = [];
  const yaws = samples.map((sample) => round2(sample.yaw));

  if (samples.length < 2) {
    issues.push('少于 2 个朝向样本，无法比较一致性');
    return { toleranceDeg, yaws, bones: [], consistent: null, issues };
  }

  const baseline = samples[0];
  const baselineByBone = new Map<string, BoneDirectionEntry>();
  for (const entry of baseline.directions.bones) baselineByBone.set(entry.name, entry);

  const names = new Set<string>();
  for (const sample of samples) {
    for (const entry of sample.directions.bones) names.add(entry.name);
  }

  const bones: BoneYawConsistency[] = [];
  const baselineWorld = new THREE.Vector3();
  const sampleLocal = new THREE.Vector3();
  const sampleWorld = new THREE.Vector3();
  const expectedWorld = new THREE.Vector3();
  const axisQuat = new THREE.Quaternion();
  const axisY = new THREE.Vector3(0, 1, 0);

  for (const name of names) {
    const base = baselineByBone.get(name);
    if (!base || !base.worldDirection || !base.localDirection) {
      bones.push({
        name,
        axis: base?.axis ?? baseline.directions.axis,
        maxLocalDeviationDeg: null,
        maxWorldDeviationDeg: null,
        consistent: null,
        perYaw: samples.map((sample) => ({
          yaw: round2(sample.yaw),
          localDeviationDeg: null,
          worldDeviationDeg: null,
        })),
      });
      issues.push(`骨骼 ${name} 在基准朝向缺少可用方向，一致性未知`);
      continue;
    }

    baselineWorld.set(base.worldDirection.x, base.worldDirection.y, base.worldDirection.z).normalize();
    const baselineLocal = new THREE.Vector3(
      base.localDirection.x,
      base.localDirection.y,
      base.localDirection.z,
    ).normalize();

    let maxLocal = 0;
    let maxWorld = 0;
    let missing = false;
    const perYaw: BoneYawDeviation[] = [];

    for (const sample of samples) {
      const entry = sample.directions.bones.find((candidate) => candidate.name === name);
      if (!entry || !entry.worldDirection || !entry.localDirection) {
        missing = true;
        perYaw.push({
          yaw: round2(sample.yaw),
          localDeviationDeg: null,
          worldDeviationDeg: null,
        });
        issues.push(`骨骼 ${name} 在 yaw=${round2(sample.yaw)}° 缺少可用方向`);
        continue;
      }

      sampleLocal.set(entry.localDirection.x, entry.localDirection.y, entry.localDirection.z).normalize();
      sampleWorld.set(entry.worldDirection.x, entry.worldDirection.y, entry.worldDirection.z).normalize();
      expectedWorld
        .copy(baselineWorld)
        .applyQuaternion(
          axisQuat.setFromAxisAngle(axisY, THREE.MathUtils.degToRad(sample.yaw - baseline.yaw)),
        );

      const localDeviation = angleBetweenDegrees(baselineLocal, sampleLocal);
      const worldDeviation = angleBetweenDegrees(expectedWorld, sampleWorld);
      if (localDeviation !== null) maxLocal = Math.max(maxLocal, localDeviation);
      if (worldDeviation !== null) maxWorld = Math.max(maxWorld, worldDeviation);
      perYaw.push({
        yaw: round2(sample.yaw),
        localDeviationDeg: localDeviation,
        worldDeviationDeg: worldDeviation,
      });
    }

    const consistent = missing ? null : maxLocal <= toleranceDeg;
    bones.push({
      name,
      axis: base.axis,
      maxLocalDeviationDeg: round2(maxLocal),
      maxWorldDeviationDeg: round2(maxWorld),
      consistent,
      perYaw,
    });
  }

  const judged = bones.filter((bone) => bone.consistent !== null);
  const consistent = judged.length === 0 ? null : judged.every((bone) => bone.consistent === true);
  if (judged.length === 0) issues.push('没有任何骨骼可以判断朝向一致性');

  return { toleranceDeg, yaws, bones, consistent, issues };
}

/* --------------------------------------------------------------- 缩放异常 */

export type ScaleAnomalyKind = 'object' | 'bone' | 'mesh';

export interface ScaleAnomalyEntry {
  readonly name: string;
  /** 从角色根到该对象的名称路径。 */
  readonly path: string;
  readonly kind: ScaleAnomalyKind;
  readonly worldScale: Vec3Json | null;
  readonly localScale: Vec3Json | null;
  /** 世界缩放各轴绝对值的最大差；无法判断为 null。 */
  readonly maxAxisDelta: number | null;
  readonly nonUniform: boolean | null;
  /** 世界矩阵 4x4 行列式；负值表示镜像。 */
  readonly determinant: number | null;
  readonly mirrored: boolean | null;
  readonly reason: string | null;
}

export interface ScaleAnomalyReport {
  readonly epsilon: number;
  readonly inspected: number;
  readonly entries: ScaleAnomalyEntry[];
  readonly nonUniformCount: number;
  readonly mirroredCount: number;
  readonly hasAnomalies: boolean;
  readonly issues: string[];
}

export interface ScaleAnomalyOptions {
  readonly epsilon?: number;
}

const DEFAULT_SCALE_EPSILON = 1e-3;

function objectPath(root: THREE.Object3D, object: THREE.Object3D): string {
  const parts: string[] = [];
  let cursor: THREE.Object3D | null = object;
  for (let i = 0; i < MAX_CHAIN; i += 1) {
    if (!cursor) break;
    parts.unshift(cursor.name || `(unnamed-${cursor.type})`);
    if (cursor === root) break;
    cursor = cursor.parent;
  }
  return parts.join('/');
}

function kindOf(object: THREE.Object3D): ScaleAnomalyKind {
  if ((object as THREE.Bone).isBone) return 'bone';
  if ((object as THREE.Mesh).isMesh) return 'mesh';
  return 'object';
}

/**
 * 只报告非均匀缩放与镜像，不修正任何变换。
 *
 * 依据世界矩阵的缩放三轴与行列式；父级缩放会累积到子级，因此同一问题可能出现在多个对象上。
 */
export function detectScaleAnomalies(
  root: THREE.Object3D,
  options: ScaleAnomalyOptions = {},
): ScaleAnomalyReport {
  const epsilon = options.epsilon ?? DEFAULT_SCALE_EPSILON;
  const entries: ScaleAnomalyEntry[] = [];
  const issues: string[] = [];
  let inspected = 0;
  let nonUniformCount = 0;
  let mirroredCount = 0;

  const worldPosition = new THREE.Vector3();
  const worldQuat = new THREE.Quaternion();
  const worldScale = new THREE.Vector3();

  root.traverse((object) => {
    inspected += 1;
    const path = objectPath(root, object);
    const name = object.name || `(unnamed-${object.type})`;
    const localScale = vectorJson(object.scale);

    if (!isFiniteMatrix(object.matrixWorld)) {
      entries.push({
        name,
        path,
        kind: kindOf(object),
        worldScale: null,
        localScale,
        maxAxisDelta: null,
        nonUniform: null,
        determinant: null,
        mirrored: null,
        reason: '世界矩阵包含非有限值，无法判断缩放',
      });
      issues.push(`${path} 的世界矩阵包含非有限值`);
      return;
    }

    object.matrixWorld.decompose(worldPosition, worldQuat, worldScale);
    if (!isFiniteVector(worldScale)) {
      entries.push({
        name,
        path,
        kind: kindOf(object),
        worldScale: null,
        localScale,
        maxAxisDelta: null,
        nonUniform: null,
        determinant: null,
        mirrored: null,
        reason: '世界缩放分量非有限',
      });
      issues.push(`${path} 的世界缩放分量非有限`);
      return;
    }

    const magnitudes = [Math.abs(worldScale.x), Math.abs(worldScale.y), Math.abs(worldScale.z)];
    const rawMaxAxisDelta = Math.max(...magnitudes) - Math.min(...magnitudes);
    const maxAxisDelta = round2(rawMaxAxisDelta);
    // 用未取整的值判断，避免 1e-3 级别的差异被 2 位小数四舍五入抹掉。
    const nonUniform = rawMaxAxisDelta > epsilon;
    const determinantRaw = object.matrixWorld.determinant();
    const mirrored = Number.isFinite(determinantRaw) ? determinantRaw < 0 : null;
    const determinant = Number.isFinite(determinantRaw) ? round2(determinantRaw) : null;

    if (nonUniform) nonUniformCount += 1;
    if (mirrored) mirroredCount += 1;

    if (nonUniform || mirrored || determinant === null) {
      entries.push({
        name,
        path,
        kind: kindOf(object),
        worldScale: vectorJson(worldScale),
        localScale,
        maxAxisDelta,
        nonUniform,
        determinant,
        mirrored,
        reason: determinant === null ? '行列式非有限' : null,
      });
    }
  });

  if (inspected === 0) issues.push('角色根下没有任何对象');
  if (mirroredCount > 0) {
    issues.push(`检测到 ${mirroredCount} 个镜像（行列式 < 0）对象；只报告，不修正`);
  }
  if (nonUniformCount > 0) {
    issues.push(`检测到 ${nonUniformCount} 个非均匀缩放对象；只报告，不修正`);
  }

  return {
    epsilon,
    inspected,
    entries,
    nonUniformCount,
    mirroredCount,
    hasAnomalies: entries.length > 0,
    issues,
  };
}
