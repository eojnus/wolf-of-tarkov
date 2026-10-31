/**
 * retarget —— 两套骨架之间的“重定向计划”，只出报告，不产出重定向动画。
 *
 * 边界：
 *  - 只做名称精确匹配与可复核的归一化猜测，禁止按几何位置/启发式强行配对；
 *  - 不导出任何重定向动画、不建预览动图、不复制游戏动作：绑定姿态、轴向与比例
 *    都没有经过验证，导出会制造看似可用实则错误的资产；
 *  - 比例差只警告，不自动缩放（缩放会同时改根位移与碰撞尺度）。
 */

import * as THREE from 'three';

import { TaskError, boxJson, clipSummary, round } from './api';
import type { LoadedAsset, ModelFormat, Task, TaskOutput, TaskTools } from './api';

/** 未匹配骨骼每侧最多列出的条数。 */
const MAX_UNMATCHED = 50;
/** 骨骼名列表最多列出的条数（总数另报）。 */
const MAX_BONE_NAMES = 200;
/** 绑定姿态最多记录的骨骼条数。 */
const MAX_BIND_POSE = 40;
/** 片段明细最多列出的条数。 */
const MAX_CLIPS_LISTED = 50;
/** 身高比例的可接受区间，超出只给 warning。 */
const SCALE_MIN = 0.8;
const SCALE_MAX = 1.2;

/* --------------------------------------------------------------- 路径检查 */

function isAbsoluteLike(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path) || /^\//.test(path);
}

function normalisePathForCompare(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isInsideRoot(root: string | null, path: string): boolean {
  if (root === null || root.length === 0) return false;
  const normalisedRoot = normalisePathForCompare(root);
  const normalisedPath = normalisePathForCompare(path);
  return normalisedPath === normalisedRoot || normalisedPath.startsWith(`${normalisedRoot}/`);
}

/**
 * 两个源文件都必须在 allowedRoot 内。tools.load 也会校验，但这里先给明确错误，
 * 避免把“越界”误报成“文件读不了”。
 */
function assertInsideAllowedRoot(request: { readonly allowedRoot: string | null }, path: string, label: string): void {
  const root = request.allowedRoot;
  if (root === null || root.length === 0) {
    throw new TaskError('ALLOWED_ROOT_MISSING', '请求里没有 allowedRoot，无法证明路径在授权范围内', 4, { label });
  }
  if (!isInsideRoot(root, path)) {
    throw new TaskError('PATH_OUTSIDE_ALLOWED_ROOT', `${label} 不在 allowedRoot 内`, 4, {
      label,
      path,
      allowedRoot: root,
    });
  }
}

function requireAbsolutePath(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TaskError('BAD_ARGS', `参数 ${key} 必须是绝对路径`, 2, { key, receivedType: typeof value });
  }
  const trimmed = value.trim();
  if (!isAbsoluteLike(trimmed)) {
    throw new TaskError('BAD_ARGS', `参数 ${key} 必须是绝对路径`, 2, { key, path: trimmed });
  }
  return trimmed;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadAt(tools: TaskTools, path: string, label: string): Promise<LoadedAsset> {
  try {
    return await tools.load(path);
  } catch (error) {
    if (error instanceof TaskError) throw error;
    throw new TaskError('LOAD_FAILED', `${label} 加载失败：${describeError(error)}`, 4, { label, path });
  }
}

/* --------------------------------------------------------------- 骨架摘要 */

interface BoneRecord {
  readonly name: string;
  readonly depth: number;
  readonly parentName: string | null;
  readonly isRoot: boolean;
  readonly position: { x: number; y: number; z: number };
  readonly quaternion: { x: number; y: number; z: number; w: number };
}

function depthWithin(node: THREE.Object3D, root: THREE.Object3D): number {
  let depth = 0;
  let current = node.parent;
  while (current && current !== root) {
    depth += 1;
    current = current.parent;
  }
  return depth;
}

function collectBones(root: THREE.Object3D): BoneRecord[] {
  const records: BoneRecord[] = [];
  root.traverse((child) => {
    const bone = child as THREE.Bone;
    if (!bone.isBone) return;
    const parentBone = bone.parent && (bone.parent as THREE.Bone).isBone ? (bone.parent as THREE.Bone) : null;
    records.push({
      name: bone.name,
      depth: depthWithin(bone, root),
      parentName: bone.parent ? (parentBone ? parentBone.name : bone.parent.name || null) : null,
      // 绑定姿态：加载后未套用任何 AnimationMixer，局部变换即文件里的节点变换。
      isRoot: parentBone === null,
      position: { x: round(bone.position.x), y: round(bone.position.y), z: round(bone.position.z) },
      quaternion: {
        x: round(bone.quaternion.x),
        y: round(bone.quaternion.y),
        z: round(bone.quaternion.z),
        w: round(bone.quaternion.w),
      },
    });
  });
  records.sort((a, b) => (a.depth !== b.depth ? a.depth - b.depth : a.name.localeCompare(b.name)));
  return records;
}

function heightOf(box: THREE.Box3): number | null {
  if (box.isEmpty()) return null;
  const size = box.getSize(new THREE.Vector3());
  const height = size.y;
  return Number.isFinite(height) && height > 0 ? round(height) : null;
}

interface RigSummary {
  input: string;
  format: ModelFormat;
  clips: number;
  bones: number;
  rootBones: string[];
  boneNames: string[];
  boneNamesTruncated: boolean;
  bbox: ReturnType<typeof boxJson> | null;
  heightMeters: number | null;
  bboxBasis: string;
  clipList: Array<{ name: string; duration: number; tracks: number }>;
  clipListTruncated: boolean;
  skeletonRootsFromMeshes: string[];
}

function summariseRig(asset: LoadedAsset, input: string, bones: BoneRecord[], tools: TaskTools, label: string): RigSummary {
  const box = new THREE.Box3().setFromObject(asset.root);
  const height = heightOf(box);
  if (height === null) {
    tools.warn('HEIGHT_UNKNOWN', `${label} 的包围盒为空，身高记为 null（不写 0 冒充）`, { label });
  }

  const skeletonRoots = new Set<string>();
  asset.root.traverse((child) => {
    const mesh = child as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.skeleton) return;
    const first = mesh.skeleton.bones[0];
    if (first && first.name.length > 0) skeletonRoots.add(first.name);
  });

  const names = bones.map((bone) => bone.name);
  const clipList = asset.clips.slice(0, MAX_CLIPS_LISTED).map((clip) => {
    const summary = clipSummary(clip);
    return { name: summary.name, duration: summary.duration, tracks: summary.tracks };
  });

  return {
    input,
    format: asset.format,
    clips: asset.clips.length,
    bones: bones.length,
    rootBones: bones.filter((bone) => bone.isRoot).map((bone) => bone.name).slice(0, MAX_UNMATCHED),
    boneNames: names.slice(0, MAX_BONE_NAMES),
    boneNamesTruncated: names.length > MAX_BONE_NAMES,
    bbox: box.isEmpty() ? null : boxJson(box),
    heightMeters: height,
    // SkinnedMesh 的 setFromObject 用的是绑定姿态下的几何包围盒，不是逐帧蒙皮后的体积。
    bboxBasis: 'static-geometry-in-bind-pose',
    clipList,
    clipListTruncated: asset.clips.length > MAX_CLIPS_LISTED,
    skeletonRootsFromMeshes: [...skeletonRoots].slice(0, MAX_UNMATCHED),
  };
}

/* --------------------------------------------------------------- 轨道目标 */

/** 轨道真正作用的骨骼名：`bones[Bone].position` 取 objectIndex，其余取 nodeName。 */
function trackTargetOf(trackName: string): { bone: string; property: string } {
  const binding = THREE.PropertyBinding.parseTrackName(trackName);
  const bone = binding.objectName === 'bones' ? String(binding.objectIndex) : binding.nodeName;
  return { bone, property: binding.propertyName };
}

interface RootMotionEntry {
  clip: string;
  track: string;
  bone: string;
  keys: number;
  firstSeconds: number | null;
  lastSeconds: number | null;
}

function detectRootMotion(
  clips: readonly THREE.AnimationClip[],
  rootBoneNames: ReadonlySet<string>,
): RootMotionEntry[] {
  const hits: RootMotionEntry[] = [];
  for (const clip of clips) {
    for (const track of clip.tracks) {
      const target = trackTargetOf(track.name);
      if (target.property !== 'position' || !rootBoneNames.has(target.bone)) continue;
      const times = track.times;
      hits.push({
        clip: clip.name,
        track: track.name,
        bone: target.bone,
        keys: times.length,
        firstSeconds: times.length > 0 ? round(times[0]) : null,
        lastSeconds: times.length > 0 ? round(times[times.length - 1]) : null,
      });
    }
  }
  return hits;
}

/* --------------------------------------------------------------- 骨骼映射 */

interface MappingEntry {
  source: string;
  target: string;
  method: 'user-map' | 'exact-name' | 'normalized-name-guess';
  requiresConfirmation: boolean;
  note?: string;
}

interface InvalidMapping {
  index: number;
  source: string | null;
  target: string | null;
  problems: string[];
}

/**
 * 只用于把「可能是关键骨骼」的名字挑出来供人工核对，不用它证明骨架完整。
 * 归一化后去掉左右后缀，命中提示词即列为关键骨骼候选；没有命中则为 unknown。
 */
const KEY_BONE_HINTS = new Set([
  'hips',
  'pelvis',
  'spine',
  'abdomen',
  'torso',
  'chest',
  'neck',
  'head',
  'shoulder',
  'upperarm',
  'lowerarm',
  'hand',
  'fist',
  'upperleg',
  'lowerleg',
  'foot',
  'toe',
]);

function keyBoneHintOf(name: string): string | null {
  const key = normaliseBoneName(name).replace(/[lr]$/, '');
  return KEY_BONE_HINTS.has(key) ? key : null;
}

/**
 * 归一化猜测用：只抹掉“命名约定差异”，不做语义推断。
 *  - 去掉命名空间前缀（`mixamorig:` / `Armature|` 之前的冒号段）；
 *  - 小写、去掉空格/下划线/连字符/点；
 *  - 去掉 `mixamorig` 前缀；
 *  - 去掉名字末尾的数字（`Spine_01` → `spine`）。
 * 归一化后仍可能撞车，撞车一律转为 ambiguous，不猜。
 */
function normaliseBoneName(name: string): string {
  let value = name.trim();
  const colon = value.lastIndexOf(':');
  if (colon >= 0) value = value.slice(colon + 1);
  value = value.toLowerCase();
  value = value.replace(/^mixamorig[_]?/, '');
  value = value.replace(/[\s_.\-|]/g, '');
  value = value.replace(/[0-9]+$/, '');
  return value;
}

interface RawMappingEntry {
  index: number;
  source: string | null;
  target: string | null;
}

function parseMapArgument(value: unknown): RawMappingEntry[] | null {
  if (value === undefined || value === null) return null;
  const parts: unknown[] = [];
  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      throw new TaskError('BAD_ARGS', 'map 不能为空字符串', 2, { got: 'empty-string' });
    }
    parts.push(...value.split(','));
  } else if (Array.isArray(value)) {
    parts.push(...value);
  } else {
    throw new TaskError('BAD_ARGS', 'map 必须是 "src=dst,src2=dst2" 字符串或数组', 2, {
      receivedType: typeof value,
    });
  }

  return parts.map((part, index) => {
    if (typeof part === 'string') {
      const pair = part.split('=').map((item) => item.trim());
      if (pair.length !== 2 || pair[0].length === 0 || pair[1].length === 0) {
        return { index, source: null, target: null };
      }
      return { index, source: pair[0], target: pair[1] };
    }
    if (part !== null && typeof part === 'object') {
      const record = part as Record<string, unknown>;
      const source = typeof record.source === 'string' ? record.source.trim() : '';
      const target = typeof record.target === 'string' ? record.target.trim() : '';
      if (source.length === 0 || target.length === 0) return { index, source: null, target: null };
      return { index, source, target };
    }
    return { index, source: null, target: null };
  });
}

/* ------------------------------------------------------------------ 任务 */

export const retargetTask: Task = async (tools, request): Promise<TaskOutput> => {
  const args = request.args;
  const sourceArg = requireAbsolutePath(args.source, 'source');
  const targetPath = requireAbsolutePath(args.target, 'target');

  // CLI 用 realPath 推导 allowedRoot，而 args.source 可能是带 `..`/符号链接的原始写法；
  // 若原始写法不在根内但 CLI 已解析的 request.input 在根内，就用后者（同一 --source）。
  let sourcePath = sourceArg;
  if (!isInsideRoot(request.allowedRoot, sourceArg)) {
    const fallback = typeof request.input === 'string' && request.input.length > 0 ? request.input : null;
    if (fallback !== null && isInsideRoot(request.allowedRoot, fallback)) {
      tools.warn('SOURCE_PATH_ALIAS', 'args.source 不在 allowedRoot 内，改用 CLI 已解析的 request.input', {
        provided: sourceArg,
        used: fallback,
      });
      sourcePath = fallback;
    } else {
      assertInsideAllowedRoot(request, sourceArg, 'source');
    }
  }
  assertInsideAllowedRoot(request, targetPath, 'target');

  if (normalisePathForCompare(sourcePath) === normalisePathForCompare(targetPath)) {
    tools.warn('SAME_SOURCE_TARGET', 'source 与 target 指向同一个文件，映射必然是恒等映射', { path: sourcePath });
  }

  const rawMap = parseMapArgument(args.map);

  const sourceAsset = await loadAt(tools, sourcePath, 'source');
  const targetAsset = await loadAt(tools, targetPath, 'target');

  const sourceBones = collectBones(sourceAsset.root);
  const targetBones = collectBones(targetAsset.root);
  const sourceSummary = summariseRig(sourceAsset, sourcePath, sourceBones, tools, 'source');
  const targetSummary = summariseRig(targetAsset, targetPath, targetBones, tools, 'target');

  const sourceNames = new Set(sourceBones.map((bone) => bone.name));
  const targetNames = new Set(targetBones.map((bone) => bone.name));

  /* --- 用户显式映射 --- */
  const invalidMappings: InvalidMapping[] = [];
  const userEntries: MappingEntry[] = [];
  const claimedSources = new Set<string>();
  if (rawMap !== null) {
    for (const raw of rawMap) {
      if (raw.source === null || raw.target === null) {
        invalidMappings.push({ index: raw.index, source: null, target: null, problems: ['malformed'] });
        continue;
      }
      const problems: string[] = [];
      if (!sourceNames.has(raw.source)) problems.push('source-bone-missing');
      if (!targetNames.has(raw.target)) problems.push('target-bone-missing');
      if (claimedSources.has(raw.source)) problems.push('duplicate-source');
      if (problems.length > 0) {
        invalidMappings.push({ index: raw.index, source: raw.source, target: raw.target, problems });
        continue;
      }
      claimedSources.add(raw.source);
      userEntries.push({
        source: raw.source,
        target: raw.target,
        method: 'user-map',
        requiresConfirmation: false,
      });
    }
  }

  /* --- 自动候选：仅精确名称 --- */
  const exactEntries: MappingEntry[] = [];
  const exactPairs = new Map<string, string>();
  for (const bone of sourceBones) {
    if (bone.name.length === 0 || !targetNames.has(bone.name)) continue;
    exactPairs.set(bone.name, bone.name);
    exactEntries.push({
      source: bone.name,
      target: bone.name,
      method: 'exact-name',
      requiresConfirmation: false,
    });
  }

  /* --- 归一化候选：只补精确匹配之外的，撞车不猜 --- */
  const targetByNormalised = new Map<string, string[]>();
  for (const bone of targetBones) {
    const key = normaliseBoneName(bone.name);
    if (key.length === 0) continue;
    const list = targetByNormalised.get(key) ?? [];
    list.push(bone.name);
    targetByNormalised.set(key, list);
  }
  const guessEntries: MappingEntry[] = [];
  const ambiguousGuesses: Array<{ source: string; candidates: string[]; reason: string }> = [];
  for (const bone of sourceBones) {
    if (bone.name.length === 0 || exactPairs.has(bone.name)) continue;
    const key = normaliseBoneName(bone.name);
    if (key.length === 0) continue;
    const candidates = (targetByNormalised.get(key) ?? []).filter((candidate) => candidate !== bone.name);
    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      ambiguousGuesses.push({
        source: bone.name,
        candidates: candidates.slice(0, 10),
        reason: '归一化后对应多个目标骨骼，不做猜测',
      });
      continue;
    }
    guessEntries.push({
      source: bone.name,
      target: candidates[0],
      method: 'normalized-name-guess',
      requiresConfirmation: true,
      note: '仅去除前缀/大小写/下划线/末尾数字后同名，需要人工确认',
    });
  }

  /* --- 合并结果：用户映射优先，否则用自动候选 --- */
  const mapping = rawMap !== null ? userEntries : [...exactEntries, ...guessEntries];
  const usedSource = new Set(mapping.map((entry) => entry.source));
  const usedTarget = new Set(mapping.map((entry) => entry.target));

  const unmatchedSource = sourceBones
    .filter((bone) => bone.name.length > 0 && !usedSource.has(bone.name))
    .map((bone) => bone.name);
  const unmatchedTarget = targetBones
    .filter((bone) => bone.name.length > 0 && !usedTarget.has(bone.name))
    .map((bone) => bone.name);

  /* --- 映射可用性：名称匹配不等于骨架兼容 --- */
  const mappingBySource = new Map(mapping.map((entry) => [entry.source, entry]));
  const keyBoneItems = sourceBones
    .filter((bone) => keyBoneHintOf(bone.name) !== null)
    .map((bone) => {
      const entry = mappingBySource.get(bone.name);
      const status =
        entry === undefined
          ? 'unmatched'
          : entry.method === 'user-map' || entry.method === 'exact-name'
            ? 'name-matched-needs-review'
            : 'candidate-needs-confirmation';
      return {
        source: bone.name,
        hint: keyBoneHintOf(bone.name),
        target: entry?.target ?? null,
        status,
      };
    });
  const unmatchedKeyBones = keyBoneItems.filter((item) => item.status === 'unmatched');
  const keyBonesStatus =
    keyBoneItems.length === 0
      ? 'unknown'
      : unmatchedKeyBones.length > 0
        ? 'unmatched'
        : 'name-only-needs-review';

  const mappingUsabilityReasons: string[] = [];
  if (mapping.length === 0) {
    mappingUsabilityReasons.push('没有任何骨骼匹配，映射不可用');
  } else {
    if (unmatchedSource.length > 0) {
      mappingUsabilityReasons.push(`${unmatchedSource.length} 个源骨骼没有匹配`);
    }
    if (ambiguousGuesses.length > 0) {
      mappingUsabilityReasons.push(`${ambiguousGuesses.length} 个源骨骼存在多个归一化候选`);
    }
    if (invalidMappings.length > 0) {
      mappingUsabilityReasons.push(`${invalidMappings.length} 条用户映射无效`);
    }
    if (keyBonesStatus === 'unmatched') {
      mappingUsabilityReasons.push(`${unmatchedKeyBones.length} 个关键骨骼候选未匹配`);
    }
    if (keyBonesStatus === 'unknown') {
      mappingUsabilityReasons.push('无法可靠识别关键骨骼，状态未知');
    }
    mappingUsabilityReasons.push('名称匹配不代表骨架兼容或动作可用，必须人工确认');
  }

  const mappingUsabilityStatus =
    mapping.length === 0
      ? 'unusable'
      : keyBonesStatus === 'unknown'
        ? 'unknown'
        : 'manual-review-required';

  const mappingIncomplete =
    mapping.length === 0 ||
    invalidMappings.length > 0 ||
    ambiguousGuesses.length > 0 ||
    unmatchedSource.length > 0 ||
    keyBonesStatus === 'unmatched' ||
    keyBonesStatus === 'unknown';

  const taskStatus: 'ok' | 'partial' = mappingIncomplete ? 'partial' : 'ok';

  if (mapping.length === 0) {
    tools.warn('NO_BONE_MATCHES', '没有匹配到任何骨骼；映射不可用，不能进入动作套用', {
      sourceBones: sourceBones.length,
      targetBones: targetBones.length,
      mapped: 0,
      unmatchedSourceCount: unmatchedSource.length,
      unmatchedTargetCount: unmatchedTarget.length,
      exportSupported: false,
    });
  }
  if (keyBonesStatus === 'unmatched') {
    tools.warn('KEY_BONES_UNMATCHED', '关键骨骼候选存在未匹配项，必须人工处理或标记未知', {
      keyBones: keyBoneItems.filter((item) => item.status === 'unmatched').slice(0, 20),
      unmatchedCount: unmatchedKeyBones.length,
      totalKeyBones: keyBoneItems.length,
    });
  } else if (keyBonesStatus === 'unknown') {
    tools.warn('KEY_BONES_UNKNOWN', '无法从骨骼名称可靠识别关键骨骼；不声称关键骨骼齐全', {
      sourceBones: sourceBones.length,
    });
  } else {
    tools.info('KEY_BONES_NAME_ONLY', '关键骨骼候选仅有名称匹配，未经骨架兼容性验证', {
      totalKeyBones: keyBoneItems.length,
    });
  }

  /* --- 根运动与比例 --- */
  const sourceRootNames = new Set(sourceBones.filter((bone) => bone.isRoot).map((bone) => bone.name));
  const rootMotion = detectRootMotion(sourceAsset.clips, sourceRootNames);

  const sourceHeight = sourceSummary.heightMeters;
  const targetHeight = targetSummary.heightMeters;
  const ratio =
    sourceHeight !== null && targetHeight !== null && sourceHeight > 0 ? round(targetHeight / sourceHeight) : null;
  const scaleWarning = ratio !== null && (ratio > SCALE_MAX || ratio < SCALE_MIN);
  if (ratio === null) {
    tools.warn('SCALE_UNKNOWN', '至少一侧身高未知，比例记为 null（不写 0 冒充）', {
      sourceHeightMeters: sourceHeight,
      targetHeightMeters: targetHeight,
    });
  }
  if (scaleWarning) {
    tools.warn('SCALE_MISMATCH', '两侧身高比例差超过 20%，重定向前需要显式缩放（本任务不自动缩放）', {
      ratio,
      sourceHeightMeters: sourceHeight,
      targetHeightMeters: targetHeight,
    });
  }
  if (invalidMappings.length > 0) {
    tools.warn('INVALID_MAPPING', `用户映射里有 ${invalidMappings.length} 条无效，已逐条列出且未应用`, {
      invalidMappings,
    });
  }
  if (ambiguousGuesses.length > 0) {
    tools.warn('AMBIGUOUS_BONE_MAPPING', `${ambiguousGuesses.length} 个源骨骼归一化后对应多个目标骨骼，未自动配对`, {
      ambiguous: ambiguousGuesses.slice(0, 20),
    });
  }

  const statusReasons: string[] = [];
  if (mapping.length === 0) statusReasons.push('没有任何骨骼匹配，映射不可用');
  if (unmatchedSource.length > 0) {
    statusReasons.push(`${unmatchedSource.length} 个源骨骼没有匹配，源骨架覆盖不完整`);
  }
  if (mapping.length > 0 && keyBonesStatus === 'unmatched') {
    statusReasons.push('关键骨骼候选存在未匹配项，需要人工处理');
  }
  if (keyBonesStatus === 'unknown') statusReasons.push('无法可靠识别关键骨骼，关键骨骼状态未知');
  if (invalidMappings.length > 0) statusReasons.push('用户映射含无效条目，已列出未应用');
  if (ambiguousGuesses.length > 0) statusReasons.push('存在归一化后撞车的骨骼，未自动配对');
  if (scaleWarning) statusReasons.push('身高比例超出 0.8–1.2，需要显式缩放');
  const status = statusReasons.length > 0 ? 'warning' : 'ok';

  const method =
    rawMap !== null
      ? 'user-map'
      : guessEntries.length > 0
        ? 'auto-exact+normalized-name-guess'
        : 'auto-exact';

  tools.info('RETARGET_PLAN', '已生成骨骼映射报告（不导出动作；可用性见 mappingUsability）', {
    sourceBones: sourceBones.length,
    targetBones: targetBones.length,
    mapped: mapping.length,
    status,
    mappingUsability: mappingUsabilityStatus,
    taskStatus,
  });

  const data: Record<string, unknown> = {
    status,
    statusReasons,
    source: sourceSummary,
    target: targetSummary,
    scale: {
      sourceHeightMeters: sourceHeight,
      targetHeightMeters: targetHeight,
      ratio,
      acceptableRange: { min: SCALE_MIN, max: SCALE_MAX },
      warning: scaleWarning,
      note: '比例只报告；重定向动画需要显式缩放，本任务不自动缩放，也不改源/目标文件',
    },
    mapping: {
      provided: rawMap !== null,
      method,
      requiresConfirmation: rawMap === null && guessEntries.length > 0,
      confirmed: rawMap !== null && invalidMappings.length === 0,
      entries: mapping,
      counts: {
        sourceBones: sourceBones.length,
        targetBones: targetBones.length,
        userProvided: userEntries.length,
        exactName: exactEntries.length,
        normalizedGuess: guessEntries.length,
        mapped: mapping.length,
        ambiguous: ambiguousGuesses.length,
      },
      exactName: exactEntries,
      normalizedGuess: guessEntries,
      ambiguousGuesses,
      invalidMappings,
      invalidMappingCount: invalidMappings.length,
      unmatchedSource: unmatchedSource.slice(0, MAX_UNMATCHED),
      unmatchedSourceCount: unmatchedSource.length,
      unmatchedTarget: unmatchedTarget.slice(0, MAX_UNMATCHED),
      unmatchedTargetCount: unmatchedTarget.length,
      rule: '只允许名称精确匹配与归一化候选；禁止按几何位置或启发式强行配对',
    },
    mappingUsability: {
      reportGenerated: true,
      status: mappingUsabilityStatus,
      reasons: mappingUsabilityReasons,
      requiresHumanReview: true,
      exportSupported: false,
      mappedCount: mapping.length,
      completeSourceCoverage: unmatchedSource.length === 0,
      unmatchedSourceCount: unmatchedSource.length,
      unmatchedTargetCount: unmatchedTarget.length,
      ambiguousCount: ambiguousGuesses.length,
      invalidMappingCount: invalidMappings.length,
      keyBones: {
        status: keyBonesStatus,
        detected: keyBoneItems.length,
        unmatchedCount: unmatchedKeyBones.length,
        items: keyBoneItems.slice(0, 40),
        truncated: keyBoneItems.length > 40,
        note: '关键骨骼仅按名称提示筛出；名称匹配或归一化候选不等于骨架兼容，未验证关键骨骼齐全',
      },
      note:
        mapping.length === 0
          ? '报告已生成，但没有任何骨骼匹配；映射不可用，不能进入动作套用'
          : '报告已生成，但名称匹配/候选仍需人工确认，不能据此声称骨架兼容或动作可用；unmatchedTarget 是目标侧多余骨骼，不等于源骨架未覆盖',
    },
    bindPose: {
      note: '加载后未套用 AnimationMixer，局部 position/quaternion 即文件节点变换；仅前 40 条',
      maxEntries: MAX_BIND_POSE,
      source: sourceBones.slice(0, MAX_BIND_POSE).map((bone) => ({
        name: bone.name,
        parent: bone.parentName,
        depth: bone.depth,
        isRoot: bone.isRoot,
        position: bone.position,
        quaternion: bone.quaternion,
      })),
      target: targetBones.slice(0, MAX_BIND_POSE).map((bone) => ({
        name: bone.name,
        parent: bone.parentName,
        depth: bone.depth,
        isRoot: bone.isRoot,
        position: bone.position,
        quaternion: bone.quaternion,
      })),
      sourceTruncated: sourceBones.length > MAX_BIND_POSE,
      targetTruncated: targetBones.length > MAX_BIND_POSE,
    },
    rootMotion: {
      sourceRootBones: [...sourceRootNames].slice(0, MAX_UNMATCHED),
      detected: rootMotion.length > 0,
      clipsWithRootMotion: [...new Set(rootMotion.map((entry) => entry.clip))],
      tracks: rootMotion.slice(0, MAX_UNMATCHED),
      trackCount: rootMotion.length,
      note: '只检测影响根骨骼的 position 轨道；有轨道不等于有实际位移，未做位移幅度分析',
    },
    exportSupported: false,
    exportBlockedReason: '绑定姿态、轴向与比例都未证实；生成重定向动画会产出看似可用的错误资产',
    limitations: [
      '不导出任何重定向动画，也不建预览：绑定姿态/轴向/比例未证实',
      '包围盒基于绑定姿态的静态几何，不是蒙皮后的体积',
      '四元数按分量复制，未处理两套骨架的轴向差异',
      '归一化候选只是命名约定差异，必须人工确认',
      'USDZ 只作为只读输入，不涉及写回',
    ],
  };

  return { data, status: taskStatus };
};
