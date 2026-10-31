/**
 * 人物表现 —— 加载角色资源、归一化尺寸、语义动作选择与混合。
 *
 * 职责边界：
 *  - 只负责「看起来怎么样」：权威位移、碰撞、重力与接地判定全部来自 `world/physics`；
 *  - 当前 Alina USDZ 只带一段约 22.6 秒的待机动作，因此 idle 使用裁剪后的源片段，
 *    walk / run / 跳跃阶段使用程序化骨骼姿态；若配置里提供了对应片段则优先播放片段；
 *  - 根位移轨道会被移除，避免动画与物理移动重复推动人物；
 *  - 加载失败由调用方回退到灰盒占位，资产与 GPU 资源由本模块释放。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { USDLoader } from 'three/examples/jsm/loaders/USDLoader.js';
import { PHYSICS, PLAYER } from '../content/config';

/** 语义动作。以后增加挥拳/持枪时在此增加映射，不预建战斗状态。 */
export type CharacterAction = 'idle' | 'walk' | 'run' | 'jumpStart' | 'airborne' | 'land';

type JumpPhase = 'ground' | 'takeoff' | 'air' | 'land';

/** 物理结果中与动画直接相关的只读表现信息。 */
export interface CharacterMotion {
  readonly speed: number;
  readonly moving: boolean;
  readonly sprinting: boolean;
  readonly grounded: boolean;
  /** 帧末竖直速度（米/秒，向上为正），用于区分起跳、上升与下落。 */
  readonly verticalVelocity: number;
  /** 本帧至少一个物理步从接地变为离地（跳跃或走出边缘）。 */
  readonly leftGround: boolean;
  /** 本帧至少一个物理步从离地变为接地。 */
  readonly touchedGround: boolean;
}

export interface CharacterRig {
  readonly root: THREE.Group;
  /** dt 秒；motion 只含物理派生表现信息，不参与任何物理或业务判定。 */
  update(dtSeconds: number, motion: CharacterMotion): void;
  /** 读档、场景切换、位置恢复：清除不再有效的跳跃/落地表现状态。 */
  reset(): void;
  dispose(): void;
}

interface CharacterAsset {
  readonly root: THREE.Object3D;
  readonly clips: readonly THREE.AnimationClip[];
  dispose(): void;
}

interface LoadedActions {
  readonly idle: THREE.AnimationAction;
  readonly walk: THREE.AnimationAction | null;
  readonly run: THREE.AnimationAction | null;
  readonly jumpStart: THREE.AnimationAction | null;
  readonly airborne: THREE.AnimationAction | null;
  readonly land: THREE.AnimationAction | null;
}

interface BoneMap {
  readonly pelvis: THREE.Bone;
  readonly chest: THREE.Bone;
  readonly leftHip: THREE.Bone;
  readonly leftKnee: THREE.Bone;
  readonly leftFoot: THREE.Bone;
  readonly rightHip: THREE.Bone;
  readonly rightKnee: THREE.Bone;
  readonly rightFoot: THREE.Bone;
  readonly leftShoulder: THREE.Bone;
  readonly leftElbow: THREE.Bone;
  readonly rightShoulder: THREE.Bone;
  readonly rightElbow: THREE.Bone;
  readonly controlled: readonly THREE.Bone[];
  readonly feet: readonly THREE.Bone[];
}

const ACTION_KEYS = ['idle', 'walk', 'run', 'jumpStart', 'airborne', 'land'] as const;

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function degrees(value: number): number {
  return (value * Math.PI) / 180;
}

function isUsdz(url: string): boolean {
  return /\.usdz(?:\?|$)/i.test(url);
}

/** 资产里与模型无关的共享资源释放；只处理这棵子树拥有的几何、材质与贴图。 */
function disposeAsset(root: THREE.Object3D): void {
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
      // 不按具体材质类型列举贴图字段，避免漏掉 clearcoat / transmission 等扩展贴图。
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });

  for (const texture of textures) {
    const image = texture.image as { src?: unknown; close?: unknown } | null;
    texture.dispose();
    if (image && typeof image.src === 'string' && image.src.startsWith('blob:')) {
      URL.revokeObjectURL(image.src);
    }
  }
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}

async function loadAsset(): Promise<CharacterAsset> {
  const url = PLAYER.model.url;
  if (isUsdz(url)) {
    const loader = new USDLoader();
    const group = (await loader.loadAsync(url)) as THREE.Group & {
      animations?: THREE.AnimationClip[];
    };
    return {
      root: group,
      clips: group.animations ?? [],
      dispose: () => disposeAsset(group),
    };
  }

  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  return {
    root: gltf.scene,
    clips: gltf.animations ?? [],
    dispose: () => disposeAsset(gltf.scene),
  };
}

/** 语义动作配置的类型收窄；null 表示该动作没有源片段。 */
function clipReference(key: CharacterAction): {
  readonly name: string;
  readonly start?: number;
  readonly end?: number;
} | null {
  const reference = PLAYER.model.clips[key] as {
    readonly name?: string;
    readonly start?: number;
    readonly end?: number;
  } | null;
  if (!reference || typeof reference.name !== 'string') return null;
  return { name: reference.name, start: reference.start, end: reference.end };
}

function trimClip(
  source: THREE.AnimationClip,
  name: string,
  start: number,
  end: number,
): THREE.AnimationClip {
  if (!(end > start)) {
    throw new Error(`人物动画片段 ${name} 的裁剪区间无效：${start} → ${end}`);
  }
  // 源文件 timeCodesPerSecond = 120；subclip 用帧号筛选轨道采样，再按剩余采样重算时长。
  const fps = 120;
  const clip = THREE.AnimationUtils.subclip(
    source,
    name,
    Math.round(start * fps),
    Math.round(end * fps),
    fps,
  );
  if (clip.tracks.length === 0) {
    throw new Error(`人物动画片段 ${name} 在 ${start}–${end}s 内没有可用轨道`);
  }
  return clip;
}

/** 移除骨骼根节点的位移/旋转轨道，动画不得与 Player/物理重复推动人物。 */
function stripRootMotion(clip: THREE.AnimationClip, rootName: string): THREE.AnimationClip {
  const prefix = `${rootName}.`;
  const tracks = clip.tracks.filter((track) => !track.name.startsWith(prefix));
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

function findSkeletonRoot(skeleton: THREE.Skeleton): THREE.Bone | null {
  for (const bone of skeleton.bones) {
    const parent = bone.parent as THREE.Bone | null;
    if (!parent || !parent.isBone) return bone;
  }
  return skeleton.bones[0] ?? null;
}

function findBoneMap(skeleton: THREE.Skeleton): BoneMap | null {
  const names = PLAYER.model.bones;
  const find = (name: string): THREE.Bone | null =>
    skeleton.bones.find((bone) => bone.name === name) ?? null;

  const pelvis = find(names.pelvis);
  const chest = find(names.chest);
  const leftHip = find(names.leftHip);
  const leftKnee = find(names.leftKnee);
  const leftFoot = find(names.leftFoot);
  const rightHip = find(names.rightHip);
  const rightKnee = find(names.rightKnee);
  const rightFoot = find(names.rightFoot);
  const leftShoulder = find(names.leftShoulder);
  const leftElbow = find(names.leftElbow);
  const rightShoulder = find(names.rightShoulder);
  const rightElbow = find(names.rightElbow);

  if (
    !pelvis || !chest || !leftHip || !leftKnee || !leftFoot || !rightHip || !rightKnee ||
    !rightFoot || !leftShoulder || !leftElbow || !rightShoulder || !rightElbow
  ) {
    return null;
  }

  const controlled = [
    pelvis,
    chest,
    leftHip,
    leftKnee,
    leftFoot,
    rightHip,
    rightKnee,
    rightFoot,
    leftShoulder,
    leftElbow,
    rightShoulder,
    rightElbow,
  ];
  return {
    pelvis,
    chest,
    leftHip,
    leftKnee,
    leftFoot,
    rightHip,
    rightKnee,
    rightFoot,
    leftShoulder,
    leftElbow,
    rightShoulder,
    rightElbow,
    controlled,
    feet: [leftFoot, rightFoot],
  };
}

export async function loadCharacterRig(): Promise<CharacterRig> {
  const asset = await loadAsset();
  const model = asset.root;

  // 归一化：保留加载器自身的单位缩放（USDZ 的 metersPerUnit），只在此基础上乘身高系数。
  model.updateMatrixWorld(true);
  const rawBox = new THREE.Box3().setFromObject(model);
  const rawSize = rawBox.getSize(new THREE.Vector3());
  if (!Number.isFinite(rawSize.y) || rawSize.y <= 0.001) {
    asset.dispose();
    throw new Error('人物模型尺寸异常');
  }
  const factor = PLAYER.model.height / rawSize.y;
  model.scale.multiplyScalar(factor);
  model.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= box.min.y;

  model.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    // 人物参与统一太阳阴影；脚下贴地圆片仍保留，夜里没有太阳投影时不至于「浮」在地上。
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
  });

  let skeleton: THREE.Skeleton | null = null;
  model.traverse((child) => {
    const mesh = child as THREE.SkinnedMesh;
    if (!skeleton && mesh.isSkinnedMesh) skeleton = mesh.skeleton;
  });
  const skeletonRoot = skeleton ? findSkeletonRoot(skeleton) : null;
  if (!skeletonRoot) {
    asset.dispose();
    throw new Error('人物模型没有可用的骨骼根');
  }

  const root = new THREE.Group();
  const inner = new THREE.Group();
  inner.rotation.y = PLAYER.model.yawOffset;
  inner.add(model);
  root.add(inner);

  // 解析语义动作 → 片段。配置了名称却找不到时明确报错；没有配置则候选程序化。
  const resolved = new Map<CharacterAction, THREE.AnimationClip>();
  for (const key of ACTION_KEYS) {
    const reference = clipReference(key);
    if (!reference) continue;
    const found = THREE.AnimationClip.findByName([...asset.clips], reference.name);
    if (!found) {
      asset.dispose();
      throw new Error(`人物模型缺少配置的动作片段：${key} → ${reference.name}`);
    }
    let clip =
      reference.start !== undefined && reference.end !== undefined
        ? trimClip(found, `${reference.name}-${key}`, reference.start, reference.end)
        : found;
    clip = stripRootMotion(clip, skeletonRoot.name);
    resolved.set(key, clip);
  }

  const idleClip = resolved.get('idle');
  if (!idleClip) {
    asset.dispose();
    throw new Error('人物模型缺少 idle 动作片段');
  }

  const mixer = new THREE.AnimationMixer(model);
  const actionFor = (key: CharacterAction): THREE.AnimationAction | null => {
    const clip = resolved.get(key);
    if (!clip) return null;
    const action = mixer.clipAction(clip);
    if (key === 'jumpStart' || key === 'land') {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    } else {
      action.setLoop(THREE.LoopRepeat, Infinity);
    }
    action.enabled = true;
    action.setEffectiveWeight(key === 'idle' ? 1 : 0);
    action.play();
    return action;
  };

  const actions: LoadedActions = {
    idle: actionFor('idle') as THREE.AnimationAction,
    walk: actionFor('walk'),
    run: actionFor('run'),
    jumpStart: actionFor('jumpStart'),
    airborne: actionFor('airborne'),
    land: actionFor('land'),
  };

  const clipLocomotion = actions.walk !== null && actions.run !== null;
  const clipJump =
    actions.jumpStart !== null && actions.airborne !== null && actions.land !== null;
  const boneMap = skeleton ? findBoneMap(skeleton) : null;
  const procedural = boneMap !== null;

  const missing: CharacterAction[] = [];
  for (const key of ACTION_KEYS) {
    if (key === 'idle' || resolved.has(key)) continue;
    if (key === 'walk' || key === 'run') {
      if (!clipLocomotion) missing.push(key);
    } else if (!clipJump) {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    if (procedural) {
      console.info(
        `[character] 以下动作没有源片段，使用程序化骨骼表现：${missing.join(' / ')}`,
      );
    } else {
      console.warn(
        `[character] 以下动作没有源片段，且骨骼映射不完整，无法生成程序化表现：${missing.join(' / ')}`,
      );
    }
  }

  // 基准姿态取 idle 第 0 帧：这是自然的站立姿态，不是加载器的 A/T 绑定姿态。
  mixer.setTime(0);
  model.updateMatrixWorld(true);
  const baseQuats = new Map<THREE.Bone, THREE.Quaternion>();
  if (boneMap) {
    for (const bone of boneMap.controlled) baseQuats.set(bone, bone.quaternion.clone());
  }
  const idleQuats = new Map<THREE.Bone, THREE.Quaternion>();
  const appliedQuats = new Map<THREE.Bone, THREE.Quaternion>();
  if (boneMap) {
    for (const bone of boneMap.controlled) {
      idleQuats.set(bone, new THREE.Quaternion());
      appliedQuats.set(bone, new THREE.Quaternion());
    }
  }

  const footSample = new THREE.Vector3();
  const measureFootMin = (): number => {
    if (!boneMap) return 0;
    inner.position.y = 0;
    inner.updateMatrixWorld(true);
    skeletonRoot.updateMatrixWorld(true);
    let min = Number.POSITIVE_INFINITY;
    for (const foot of boneMap.feet) {
      footSample.setFromMatrixPosition(foot.matrixWorld);
      inner.worldToLocal(footSample);
      min = Math.min(min, footSample.y);
    }
    return Number.isFinite(min) ? min : 0;
  };
  const baseFootMin = measureFootMin();

  const parentQuat = new THREE.Quaternion();
  const worldQuat = new THREE.Quaternion();
  const worldQuatInverse = new THREE.Quaternion();
  const axisLocal = new THREE.Vector3();
  const deltaQuat = new THREE.Quaternion();
  const characterQuat = new THREE.Quaternion();
  const characterAxisX = new THREE.Vector3();
  const characterAxisY = new THREE.Vector3();
  const characterAxisZ = new THREE.Vector3();

  /**
   * 把角色本地轴转换到世界坐标。
   *
   * 动作轴必须跟随人物朝向，否则人物转身 180° 后前倾会变后仰、手臂内收/外展会反向。
   * `inner` 包含模型自身的 yawOffset，是比世界 X/Z 更稳定的基准。
   */
  const updateCharacterAxes = (): void => {
    // 骨骼根挂在蒙皮网格下；先把这条父链更新到当前世界矩阵，后面的骨骼旋转才不会
    // 用上一帧的人物朝向。
    const skeletonParent = skeletonRoot.parent;
    if (skeletonParent) skeletonParent.updateWorldMatrix(true, false);
    else inner.updateWorldMatrix(true, false);
    inner.getWorldQuaternion(characterQuat);
    characterAxisX.copy(AXIS_X).applyQuaternion(characterQuat);
    characterAxisY.copy(AXIS_Y).applyQuaternion(characterQuat);
    characterAxisZ.copy(AXIS_Z).applyQuaternion(characterQuat);
  };

  /** 让骨骼绕指定世界坐标轴旋转（相对于第 0 帧的站立姿态）。 */
  const rotateWorldAxis = (
    bone: THREE.Bone,
    base: THREE.Quaternion,
    axis: THREE.Vector3,
    angle: number,
  ): void => {
    const parent = bone.parent;
    if (!parent) return;
    parent.getWorldQuaternion(parentQuat);
    worldQuat.copy(parentQuat).multiply(base);
    worldQuatInverse.copy(worldQuat).invert();
    axisLocal.copy(axis).applyQuaternion(worldQuatInverse);
    bone.quaternion.copy(base).multiply(deltaQuat.setFromAxisAngle(axisLocal, angle));
  };
  const rotateWorld = (bone: THREE.Bone, base: THREE.Quaternion, angle: number): void => {
    rotateWorldAxis(bone, base, characterAxisX, angle);
  };

  const resetControlledToBase = (): void => {
    if (!boneMap) return;
    for (const bone of boneMap.controlled) {
      const base = baseQuats.get(bone);
      if (base) bone.quaternion.copy(base);
    }
    skeletonRoot.updateMatrixWorld(true);
  };

  // 状态机与姿态参数。
  let phase: JumpPhase = 'ground';
  let phaseTime = 0;
  let overrideWeight = 0;
  let runWeight = 0;
  let gaitPhase = 0;
  let hasApplied = false;
  let activeJumpAction: THREE.AnimationAction | null = null;
  const actionWeights = new Map<THREE.AnimationAction, number>();
  for (const action of Object.values(actions)) {
    if (action) actionWeights.set(action, action === actions.idle ? 1 : 0);
  }

  const gait = PLAYER.model.gait;
  const jump = PLAYER.model.jump;

  const enterPhase = (next: JumpPhase): void => {
    if (next === phase) return;
    phase = next;
    phaseTime = 0;
    if (!clipJump) return;
    const action =
      next === 'takeoff'
        ? actions.jumpStart
        : next === 'air'
          ? actions.airborne
          : next === 'land'
            ? actions.land
            : null;
    if (action && action !== activeJumpAction) {
      action.reset();
      action.play();
      activeJumpAction = action;
    }
    if (next === 'ground') activeJumpAction = null;
  };

  const setTargetWeights = (motion: CharacterMotion): Map<THREE.AnimationAction, number> => {
    const targets = new Map<THREE.AnimationAction, number>();
    for (const action of Object.values(actions)) {
      if (action) targets.set(action, 0);
    }

    if (clipJump && phase !== 'ground') {
      const active =
        phase === 'takeoff'
          ? actions.jumpStart
          : phase === 'air'
            ? actions.airborne
            : actions.land;
      if (active) targets.set(active, 1);
      else targets.set(actions.idle, 1);
      return targets;
    }

    // 空中/落地阶段绝不让地面走跑片段继续占权重；没有跳跃片段时由 idle 作为程序化底层。
    if (phase !== 'ground') {
      targets.set(actions.idle, 1);
      return targets;
    }

    if (clipLocomotion) {
      targets.set(actions.idle, motion.moving ? 0 : 1);
      targets.set(actions.walk as THREE.AnimationAction, motion.moving && !motion.sprinting ? 1 : 0);
      targets.set(actions.run as THREE.AnimationAction, motion.moving && motion.sprinting ? 1 : 0);
      return targets;
    }

    // 程序化动作以 idle 为底层姿态，再由骨骼叠加；片段的 idle 权重保持 1。
    targets.set(actions.idle, 1);
    return targets;
  };

  const blendActionWeights = (targets: Map<THREE.AnimationAction, number>, dt: number): void => {
    const fade = Math.max(0.02, PLAYER.model.fadeSeconds);
    const k = 1 - Math.exp(-dt / fade);
    for (const [action, target] of targets) {
      const current = actionWeights.get(action) ?? 0;
      const next = current + (target - current) * k;
      actionWeights.set(action, Math.abs(next - target) < 0.001 ? target : next);
      action.setEffectiveWeight(actionWeights.get(action) ?? 0);
    }
  };

  const updateGaitPhase = (motion: CharacterMotion, dt: number): void => {
    if (!motion.moving || motion.speed <= PHYSICS.character.minAnimationSpeed) return;
    const stride = lerp(gait.walkStrideMeters, gait.runStrideMeters, runWeight);
    const cycles = clamp(
      motion.speed / Math.max(0.1, stride),
      gait.minCyclesPerSecond,
      gait.maxCyclesPerSecond,
    );
    gaitPhase = (gaitPhase + dt * cycles * Math.PI * 2) % (Math.PI * 2);
  };

  /** 计算目标姿态（写入骨骼），随后由调用方与 idle/applied 混合。 */
  const poseGait = (): void => {
    if (!boneMap) return;
    updateCharacterAxes();
    resetControlledToBase();
    const hipAmp = degrees(lerp(gait.walkHipDegrees, gait.runHipDegrees, runWeight));
    const kneeAmp = degrees(lerp(gait.walkKneeDegrees, gait.runKneeDegrees, runWeight));
    const armAmp = degrees(lerp(gait.walkArmDegrees, gait.runArmDegrees, runWeight));
    const elbow = degrees(lerp(gait.walkElbowDegrees, gait.runElbowDegrees, runWeight));
    const lean = degrees(lerp(gait.walkLeanDegrees, gait.runLeanDegrees, runWeight));
    const kneeBase = degrees(lerp(3, 10, runWeight));

    // 骨盆轻微左右扭转，与上身前倾一起构成步态的躯干反向摆动。
    rotateWorldAxis(
      boneMap.pelvis,
      baseQuats.get(boneMap.pelvis) as THREE.Quaternion,
      characterAxisY,
      hipAmp * 0.12 * Math.sin(gaitPhase),
    );
    // 上身前倾：+X 把朝 +Z 的脊柱顶部向前推。
    rotateWorld(boneMap.chest, baseQuats.get(boneMap.chest) as THREE.Quaternion, lean);
    skeletonRoot.updateMatrixWorld(true);

    const hipLeft = -hipAmp * Math.cos(gaitPhase);
    const hipRight = -hipAmp * Math.cos(gaitPhase + Math.PI);
    const kneeLeft = kneeBase + kneeAmp * Math.max(0, -Math.sin(gaitPhase));
    const kneeRight = kneeBase + kneeAmp * Math.max(0, -Math.sin(gaitPhase + Math.PI));
    const shoulderLeft = armAmp * Math.cos(gaitPhase);
    const shoulderRight = armAmp * Math.cos(gaitPhase + Math.PI);

    rotateWorld(boneMap.leftHip, baseQuats.get(boneMap.leftHip) as THREE.Quaternion, hipLeft);
    rotateWorld(boneMap.rightHip, baseQuats.get(boneMap.rightHip) as THREE.Quaternion, hipRight);
    rotateWorld(
      boneMap.leftShoulder,
      baseQuats.get(boneMap.leftShoulder) as THREE.Quaternion,
      shoulderLeft,
    );
    rotateWorld(
      boneMap.rightShoulder,
      baseQuats.get(boneMap.rightShoulder) as THREE.Quaternion,
      shoulderRight,
    );
    skeletonRoot.updateMatrixWorld(true);

    rotateWorld(boneMap.leftKnee, baseQuats.get(boneMap.leftKnee) as THREE.Quaternion, kneeLeft);
    rotateWorld(boneMap.rightKnee, baseQuats.get(boneMap.rightKnee) as THREE.Quaternion, kneeRight);
    rotateWorld(boneMap.leftElbow, baseQuats.get(boneMap.leftElbow) as THREE.Quaternion, -elbow);
    rotateWorld(boneMap.rightElbow, baseQuats.get(boneMap.rightElbow) as THREE.Quaternion, -elbow);
    skeletonRoot.updateMatrixWorld(true);

    // 脚掌反向旋转，保持鞋底大致水平。
    rotateWorld(
      boneMap.leftFoot,
      baseQuats.get(boneMap.leftFoot) as THREE.Quaternion,
      -(hipLeft + kneeLeft),
    );
    rotateWorld(
      boneMap.rightFoot,
      baseQuats.get(boneMap.rightFoot) as THREE.Quaternion,
      -(hipRight + kneeRight),
    );
    skeletonRoot.updateMatrixWorld(true);
  };

  const poseJump = (motion: CharacterMotion): void => {
    if (!boneMap) return;
    updateCharacterAxes();
    resetControlledToBase();
    const crouchKnee = degrees(jump.crouchKneeDegrees);
    const riseKnee = degrees(jump.riseKneeDegrees);
    const airHip = degrees(jump.airHipDegrees);
    const fallHip = degrees(jump.fallHipDegrees);
    const armAmp = degrees(jump.armDegrees);
    const lean = degrees(jump.leanDegrees);

    let hip: number;
    let knee: number;
    let shoulder: number;
    let elbow: number;
    let torsoLean: number;

    if (phase === 'takeoff') {
      const t = clamp(phaseTime / Math.max(0.02, jump.startSeconds), 0, 1);
      hip = -lerp(airHip + 0.18, fallHip, t);
      knee = lerp(crouchKnee, 0.08, t);
      shoulder = lerp(0.32, -armAmp, t);
      elbow = lerp(0.28, 0.12, t);
      torsoLean = lerp(lean * 0.5, lean * 0.2, t);
    } else if (phase === 'air') {
      // 起跳/下落时竖直速度大，腿伸展；接近顶点时收腿。这样不会在最高点反而伸直。
      const tuck = 1 - clamp(Math.abs(motion.verticalVelocity) / 5, 0, 1);
      hip = -lerp(fallHip, airHip + 0.1, tuck);
      knee = lerp(degrees(28), riseKnee, tuck);
      shoulder = -lerp(0.12, armAmp, tuck);
      elbow = lerp(0.2, 0.45, tuck);
      torsoLean = lean * (0.3 + 0.4 * tuck);
    } else if (phase === 'land') {
      const t = clamp(phaseTime / Math.max(0.02, jump.landSeconds), 0, 1);
      hip = -lerp(airHip + 0.12, 0.05, t);
      knee = lerp(crouchKnee + 0.15, 0.08, t);
      shoulder = lerp(-armAmp * 0.4, 0.1, t);
      elbow = lerp(0.35, 0.12, t);
      torsoLean = lerp(lean, lean * 0.2, t);
    } else {
      return;
    }

    rotateWorld(boneMap.chest, baseQuats.get(boneMap.chest) as THREE.Quaternion, torsoLean);
    skeletonRoot.updateMatrixWorld(true);

    rotateWorld(boneMap.leftHip, baseQuats.get(boneMap.leftHip) as THREE.Quaternion, hip);
    rotateWorld(boneMap.rightHip, baseQuats.get(boneMap.rightHip) as THREE.Quaternion, hip);
    rotateWorld(
      boneMap.leftShoulder,
      baseQuats.get(boneMap.leftShoulder) as THREE.Quaternion,
      shoulder,
    );
    rotateWorld(
      boneMap.rightShoulder,
      baseQuats.get(boneMap.rightShoulder) as THREE.Quaternion,
      shoulder,
    );
    // 跳跃/落地时让手臂向两侧打开，第三人称背后视角也能看清离地与缓冲。
    const abduct =
      phase === 'takeoff'
        ? lerp(0.08, 0.3, clamp(phaseTime / Math.max(0.02, jump.startSeconds), 0, 1))
        : phase === 'air'
          ? 0.34
          : 0.26;
    const leftAbduct = boneMap.leftShoulder.quaternion.clone();
    const rightAbduct = boneMap.rightShoulder.quaternion.clone();
    rotateWorldAxis(boneMap.leftShoulder, leftAbduct, characterAxisZ, abduct);
    rotateWorldAxis(boneMap.rightShoulder, rightAbduct, characterAxisZ, -abduct);
    skeletonRoot.updateMatrixWorld(true);

    rotateWorld(boneMap.leftKnee, baseQuats.get(boneMap.leftKnee) as THREE.Quaternion, knee);
    rotateWorld(boneMap.rightKnee, baseQuats.get(boneMap.rightKnee) as THREE.Quaternion, knee);
    rotateWorld(boneMap.leftElbow, baseQuats.get(boneMap.leftElbow) as THREE.Quaternion, -elbow);
    rotateWorld(boneMap.rightElbow, baseQuats.get(boneMap.rightElbow) as THREE.Quaternion, -elbow);
    skeletonRoot.updateMatrixWorld(true);

    rotateWorld(
      boneMap.leftFoot,
      baseQuats.get(boneMap.leftFoot) as THREE.Quaternion,
      -(hip + knee),
    );
    rotateWorld(
      boneMap.rightFoot,
      baseQuats.get(boneMap.rightFoot) as THREE.Quaternion,
      -(hip + knee),
    );
    skeletonRoot.updateMatrixWorld(true);
  };

  const applyGroundOffset = (motion: CharacterMotion, dt: number): void => {
    if (!boneMap) return;
    const lift = measureFootMin() - baseFootMin;
    let target = 0;
    if (phase === 'land' && motion.grounded) {
      target = -lift;
    } else if (phase === 'ground' && motion.grounded && overrideWeight > 0.5) {
      // 走/跑时只允许小幅下沉，避免把跑步的腾空期完全钉在地面。
      target = -clamp(lift, 0, 0.12);
    }
    const k = 1 - Math.exp(-dt / (phase === 'land' ? 0.03 : 0.06));
    inner.position.y += (target - inner.position.y) * k;
    if (Math.abs(inner.position.y) < 0.0005) inner.position.y = 0;
  };

  const applyProcedural = (motion: CharacterMotion, dt: number): void => {
    if (!boneMap) return;
    for (const bone of boneMap.controlled) {
      idleQuats.get(bone)?.copy(bone.quaternion);
    }
    if (!hasApplied) {
      for (const bone of boneMap.controlled) {
        appliedQuats.get(bone)?.copy(bone.quaternion);
      }
      hasApplied = true;
    }

    if (phase === 'ground') poseGait();
    else poseJump(motion);

    const smoothing = 1 - Math.exp(-dt / Math.max(0.01, PLAYER.model.proceduralSmoothingSeconds));
    for (const bone of boneMap.controlled) {
      const idle = idleQuats.get(bone);
      const applied = appliedQuats.get(bone);
      if (!idle || !applied) continue;
      applied.slerp(bone.quaternion, smoothing);
      bone.quaternion.copy(idle).slerp(applied, overrideWeight);
    }
    skeletonRoot.updateMatrixWorld(true);
    applyGroundOffset(motion, dt);
  };

  const fadeProceduralToIdle = (dt: number): void => {
    if (!boneMap) return;
    for (const bone of boneMap.controlled) {
      const idle = idleQuats.get(bone);
      const applied = appliedQuats.get(bone);
      if (!idle || !applied) continue;
      idle.copy(bone.quaternion);
      bone.quaternion.copy(idle).slerp(applied, overrideWeight);
    }
    skeletonRoot.updateMatrixWorld(true);
    const k = 1 - Math.exp(-dt / 0.1);
    inner.position.y += (0 - inner.position.y) * k;
    if (Math.abs(inner.position.y) < 0.0005) inner.position.y = 0;
  };

  const rig: CharacterRig = {
    root,
    update(dtSeconds, motion) {
      // 暂停/冻结时表现停在最后一帧；不推进 mixer、不重读状态、不重复触发起跳或落地。
      if (dtSeconds <= 0) return;
      const dt = Math.min(dtSeconds, 0.1);

      if (motion.touchedGround) {
        enterPhase('land');
      } else if (motion.leftGround) {
        enterPhase(motion.verticalVelocity > 0.5 ? 'takeoff' : 'air');
      } else if (phase === 'ground' && !motion.grounded) {
        // 无事件但物理已离地（例如读档后首次采样）：按空中处理，不补播起跳。
        enterPhase('air');
      } else if (phase !== 'ground' && phase !== 'land' && motion.grounded) {
        enterPhase('ground');
      }

      phaseTime += dt;
      if (phase === 'takeoff' && phaseTime >= jump.startSeconds) enterPhase('air');
      if (phase === 'land' && phaseTime >= jump.landSeconds) enterPhase('ground');

      const runTarget = motion.sprinting && motion.moving ? 1 : 0;
      runWeight += (runTarget - runWeight) * (1 - Math.exp(-dt / 0.18));
      if (Math.abs(runWeight - runTarget) < 0.001) runWeight = runTarget;

      if (phase === 'ground') updateGaitPhase(motion, dt);

      const proceduralGround = !clipLocomotion && procedural;
      const proceduralAir = !clipJump && procedural;
      const wantProcedural =
        phase === 'ground'
          ? proceduralGround && motion.moving && motion.speed > PHYSICS.character.minAnimationSpeed
          : proceduralAir;

      const weightTarget = wantProcedural ? 1 : 0;
      const blendSeconds = wantProcedural
        ? phase === 'ground'
          ? PLAYER.model.proceduralBlendSeconds
          : PLAYER.model.proceduralBlendSeconds * 0.55
        : PLAYER.model.proceduralBlendSeconds * 1.3;
      overrideWeight +=
        (weightTarget - overrideWeight) * (1 - Math.exp(-dt / Math.max(0.02, blendSeconds)));
      if (overrideWeight < 0.002) {
        overrideWeight = 0;
        hasApplied = false;
      }

      const targets = setTargetWeights(motion);
      blendActionWeights(targets, dt);

      if (clipLocomotion && phase === 'ground' && motion.moving) {
        // 片段路线沿用按实际速度匹配播放速率；程序化路线由 gaitPhase 控制步频。
        const walk = actions.walk as THREE.AnimationAction;
        const run = actions.run as THREE.AnimationAction;
        walk.setEffectiveTimeScale(
          clamp(
            motion.speed / Math.max(0.1, gait.walkReferenceSpeed),
            PLAYER.model.minTimeScale,
            PLAYER.model.maxTimeScale,
          ),
        );
        run.setEffectiveTimeScale(
          clamp(
            motion.speed / Math.max(0.1, gait.runReferenceSpeed),
            PLAYER.model.minTimeScale,
            PLAYER.model.maxTimeScale,
          ),
        );
      }

      mixer.update(dt);

      if (overrideWeight > 0) {
        if (wantProcedural) applyProcedural(motion, dt);
        else fadeProceduralToIdle(dt);
      } else if (inner.position.y !== 0) {
        inner.position.y += (0 - inner.position.y) * (1 - Math.exp(-dt / 0.1));
        if (Math.abs(inner.position.y) < 0.0005) inner.position.y = 0;
      }
    },
    reset() {
      enterPhase('ground');
      phaseTime = 0;
      overrideWeight = 0;
      runWeight = 0;
      gaitPhase = 0;
      hasApplied = false;
      inner.position.y = 0;
      activeJumpAction = null;
      for (const action of Object.values(actions)) {
        if (!action) continue;
        action.stop();
        action.reset();
      }
      actions.idle.setEffectiveWeight(1);
      actionWeights.clear();
      for (const action of Object.values(actions)) {
        if (!action) continue;
        actionWeights.set(action, action === actions.idle ? 1 : 0);
        action.play();
      }
      mixer.setTime(0);
      skeletonRoot.updateMatrixWorld(true);
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      inner.remove(model);
      asset.dispose();
      root.removeFromParent();
    },
  };

  rig.reset();
  return rig;
}
