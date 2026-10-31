/**
 * animation-edit —— 动作片段按秒裁剪、重命名与（可选、需确认的）GLB 导出。
 *
 * 边界：
 *  - 只读加载源模型，绝不写回源文件；
 *  - USDZ 只有“能读”的证据，没有无损写回证明，遇到 USDZ 直接拒绝（exit 3）；
 *  - 导出是「重新序列化的 GLB」，不是无损编辑；未同时给出 writeGlb 与
 *    confirmWrite === true 时只输出计划，不落盘；
 *  - 导出树只含 asset.root 的克隆与被编辑的那个片段，灯光/相机/辅助体被移除。
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { clone as cloneSkeletonTree } from 'three/examples/jsm/utils/SkeletonUtils.js';

import { TaskError, clipSummary, round } from './api';
import type { LoadedAsset, Task, TaskOutput, TaskTools } from './api';
import { groupLoadFailures } from './resources';

/** 时间比较容差（秒）。仅用于判断“关键帧是否正好落在裁剪端点上”。 */
const TIME_EPS = 1e-6;
/** 循环安全阈值：首末采样最大通道差小于它才视为可无缝循环。 */
const LOOP_THRESHOLD = 1e-3;
/** 片段名列表的最大回报条数。 */
const MAX_LISTED_CLIPS = 20;

/* --------------------------------------------------------------- 参数解析 */

function requireNonEmptyString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TaskError('BAD_ARGS', `参数 ${key} 必须是非空字符串`, 2, {
      key,
      receivedType: typeof value,
    });
  }
  return value.trim();
}

function optionalSeconds(value: unknown, key: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TaskError('BAD_ARGS', `参数 ${key} 必须是有限的秒数`, 2, {
      key,
      receivedType: typeof value,
    });
  }
  return value;
}

function isAbsoluteLike(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path) || /^\//.test(path);
}

/** 输出路径必须是输出目录内的相对路径，且不含 `..`（越界防护由 tools 再做一次）。 */
function assertRelativeOutputPath(relPath: string): void {
  const segments = relPath.split(/[\\/]/);
  if (isAbsoluteLike(relPath) || segments.includes('..')) {
    throw new TaskError('INVALID_OUTPUT_PATH', 'writeGlb 必须是输出目录内的相对路径，且不能包含 ..', 4, {
      writeGlb: relPath,
    });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* --------------------------------------------------------------- 片段定位 */

function findClip(clips: readonly THREE.AnimationClip[], name: string): THREE.AnimationClip {
  const hit = clips.find((clip) => clip.name === name);
  if (hit) return hit;
  const available = clips.map((clip) => clip.name).filter((clipName) => clipName.length > 0);
  throw new TaskError('CLIP_NOT_FOUND', `模型里没有名为 "${name}" 的动作片段`, 3, {
    requested: name,
    availableCount: available.length,
    available: available.slice(0, MAX_LISTED_CLIPS),
    truncated: available.length > MAX_LISTED_CLIPS,
  });
}

/* ------------------------------------------------------------- 轨道采样 */

/**
 * 只依赖插值工厂，不假设轨道类型；调用前已由 assertSupportedTrackInterpolations
 * 拒绝 CUBICSPLINE/Smooth/Bezier/未知工厂，因此这里只应处理：
 *  - InterpolateLinear（含四元数轨道）→ 线性 / slerp；
 *  - InterpolateDiscrete → 取前一个采样。
 * 结构类型避免依赖 `THREE.Interpolant` 是否从入口导出。
 */
interface TrackInterpolantLike {
  evaluate(t: number): ArrayLike<number>;
}

function interpolantOf(track: THREE.KeyframeTrack): TrackInterpolantLike {
  const interpolation = track.getInterpolation();
  if (interpolation === THREE.InterpolateDiscrete) return track.InterpolantFactoryMethodDiscrete();
  if (interpolation === THREE.InterpolateSmooth) return track.InterpolantFactoryMethodSmooth();
  if (interpolation === THREE.InterpolateBezier) return track.InterpolantFactoryMethodBezier();
  return track.InterpolantFactoryMethodLinear();
}

/* --------------------------------------------------- 不支持的插值方式 */

interface CubicSplineFactory {
  isInterpolantFactoryMethodGLTFCubicSpline?: boolean;
}

/**
 * GLTFLoader 的 CUBICSPLINE 不用标准枚举：它给每条 track 安装一个自定义
 * `createInterpolant`，并在工厂函数上标记
 * `isInterpolantFactoryMethodGLTFCubicSpline = true`；此时 `getInterpolation()`
 * 不能可靠返回 CUBICSPLINE（可能是 undefined 或默认值）。
 *
 * 这里同时检查工厂标记、工厂身份和 `getInterpolation()`：只接受项目已经能够
 * 正确采样的 LINEAR / STEP；其余（含 CUBICSPLINE、Smooth、Bezier、未知自定义
 * 工厂）全部明确拒绝，绝不退化成线性。
 */
function unsupportedInterpolationOf(track: THREE.KeyframeTrack): string | null {
  const factory = (track as THREE.KeyframeTrack & { createInterpolant?: CubicSplineFactory })
    .createInterpolant;
  if (factory?.isInterpolantFactoryMethodGLTFCubicSpline === true) return 'CUBICSPLINE';

  const interpolation = track.getInterpolation();
  if (interpolation === THREE.InterpolateLinear || interpolation === THREE.InterpolateDiscrete) {
    if (
      factory === track.InterpolantFactoryMethodLinear ||
      factory === track.InterpolantFactoryMethodDiscrete
    ) {
      return null;
    }
    return 'CUSTOM';
  }
  if (interpolation === THREE.InterpolateSmooth) return 'SMOOTH';
  if (interpolation === THREE.InterpolateBezier) return 'BEZIER';
  return 'UNKNOWN';
}

function assertSupportedTrackInterpolations(clip: THREE.AnimationClip): void {
  const unsupported = clip.tracks
    .map((track) => ({ track, kind: unsupportedInterpolationOf(track) }))
    .filter((item): item is { track: THREE.KeyframeTrack; kind: string } => item.kind !== null);

  if (unsupported.length === 0) return;

  const cubicCount = unsupported.filter((item) => item.kind === 'CUBICSPLINE').length;
  const listed = unsupported.slice(0, MAX_LISTED_CLIPS).map((item) => item.track.name);
  const kinds = [...new Set(unsupported.map((item) => item.kind))];
  const code = cubicCount > 0 ? 'CUBICSPLINE_UNSUPPORTED' : 'INTERPOLATION_UNSUPPORTED';
  const kindText =
    cubicCount > 0
      ? `CUBICSPLINE ${cubicCount} 条${kinds.length > 1 ? `，其他特殊插值 ${unsupported.length - cubicCount} 条` : ''}`
      : kinds.join(' / ');

  throw new TaskError(
    code,
    `片段 "${clip.name}" 含 ${unsupported.length} 条不支持的插值轨道（${kindText}）。` +
      '当前没有三次样条/特殊插值的正确裁剪实现，已拒绝裁剪、重命名和导出；本次没有生成派生资产。',
    3,
    {
      clip: clip.name,
      unsupportedTrackCount: unsupported.length,
      cubicSplineTrackCount: cubicCount,
      interpolationKinds: kinds,
      unsupportedTracks: listed,
      listedTrackCount: listed.length,
      derivedAssetWritten: false,
    },
  );
}


/**
 * 在任意时刻按轨道自身插值语义取一个“关键帧值块”。
 * 返回长度等于 `track.getValueSize()`（三次/贝塞尔轨道是 3 倍通道数，
 * 末端点补出来的整块值可以直接当作一个合法关键帧）。
 */
function sampleTrackAt(track: THREE.KeyframeTrack, time: number): Float32Array {
  const size = Math.max(0, Math.trunc(track.getValueSize()));
  const out = new Float32Array(Math.max(size, 0));
  const times = track.times;
  if (size === 0 || times.length === 0) return out;

  const first = times[0];
  const last = times[times.length - 1];
  if (times.length === 1) {
    out.set(track.values.subarray(0, size));
    return out;
  }
  if (time <= first || time >= last) {
    // 区间外：直接取边界关键帧原值，避免插值器把边界值算成近似值。
    const index = time <= first ? 0 : times.length - 1;
    out.set(track.values.subarray(index * size, index * size + size));
    return out;
  }

  const sample = interpolantOf(track).evaluate(time);
  for (let i = 0; i < size; i += 1) {
    const value = sample[i];
    out[i] = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }
  return out;
}

/* ------------------------------------------------------------- 按秒裁剪 */

interface TrimStats {
  /** 保留的原始关键帧数（所有轨道合计）。 */
  keptKeys: number;
  /** 为端点补出来的关键帧数（每条轨道最多 2 个）。 */
  synthesizedEndpoints: number;
  /** 因为没有任何关键帧值而整条丢弃的轨道名。 */
  droppedTracks: string[];
  /** 参与输出的轨道数。 */
  outputTracks: number;
}

/**
 * 按秒裁剪片段（`AnimationUtils.subclip` 只认帧号，这里不能用）。
 *
 * 算法（每条轨道独立处理，保留轨道名与插值类型）：
 *  1. 保留时间落在 [start, end] 内的全部原始关键帧，时间整体平移 -start
 *     （输出片段从 0 秒开始播放）；
 *  2. 若端点处没有原始关键帧，则用该轨道自己的插值器在 start / end 求值补一个
 *     关键帧——线性/slerp/离散/三次/贝塞尔都按各自语义，不会一律硬切成直线；
 *  3. 端点补出来的值块长度为 `getValueSize()`，对三次/贝塞尔轨道也保持
 *     “切向量 + 值 + 切向量”的结构，因此仍是一个结构合法的关键帧；
 *  4. 时长重算为 `end - start`，不假设源片段从 0 开始。
 *
 * 已知近似：三次/贝塞尔轨道的端点切向量由插值器按通道求得，不是重新拟合的
 * 解析切线；端点附近的曲线形状与源片段可能有极小差异。
 */
function trimClipBySeconds(
  source: THREE.AnimationClip,
  start: number,
  end: number,
  name: string,
): { clip: THREE.AnimationClip; stats: TrimStats } {
  const localDuration = end - start;
  const stats: TrimStats = { keptKeys: 0, synthesizedEndpoints: 0, droppedTracks: [], outputTracks: 0 };
  const tracks: THREE.KeyframeTrack[] = [];

  for (const track of source.tracks) {
    const size = track.getValueSize();
    if (track.times.length === 0 || !Number.isInteger(size) || size <= 0) {
      stats.droppedTracks.push(track.name);
      continue;
    }

    const keys: Array<{ time: number; values: Float32Array }> = [];
    for (let i = 0; i < track.times.length; i += 1) {
      const time = track.times[i];
      if (time < start - TIME_EPS || time > end + TIME_EPS) continue;
      const localTime = Math.min(Math.max(time - start, 0), localDuration);
      keys.push({ time: localTime, values: track.values.slice(i * size, i * size + size) });
      stats.keptKeys += 1;
    }

    const hasStartKey = keys.some((key) => key.time <= TIME_EPS);
    const hasEndKey = keys.some((key) => Math.abs(key.time - localDuration) <= TIME_EPS);
    if (!hasStartKey) {
      keys.push({ time: 0, values: sampleTrackAt(track, start) });
      stats.synthesizedEndpoints += 1;
    }
    if (!hasEndKey) {
      keys.push({ time: localDuration, values: sampleTrackAt(track, end) });
      stats.synthesizedEndpoints += 1;
    }
    keys.sort((a, b) => a.time - b.time);

    const times = new Float32Array(keys.length);
    const values = new Float32Array(keys.length * size);
    for (let i = 0; i < keys.length; i += 1) {
      times[i] = keys[i].time;
      values.set(keys[i].values, i * size);
    }

    // clone() 复制名称/插值模式（并可能共享 times/values），随后整体替换掉时间与值，
    // 源片段的数据不会被改写。
    const clone = track.clone();
    clone.name = track.name;
    clone.times = times;
    clone.values = values;
    tracks.push(clone);
    stats.outputTracks += 1;
  }

  const clip = new THREE.AnimationClip(name, localDuration, tracks, source.blendMode);
  return { clip, stats };
}

/* ------------------------------------------------------------- 循环判定 */

/**
 * 首末采样差：对每条轨道在 0 与 clip.duration 求值，取所有通道的最大绝对差。
 * 四元数按分量差比较（不是角度差），只作为“是否可无缝循环”的量级指标。
 * 无可用轨道时返回 null（不写 0 冒充）。
 */
function loopDelta(clip: THREE.AnimationClip): {
  maxChannelDelta: number | null;
  tracksCompared: number;
  note: string;
} {
  if (!Number.isFinite(clip.duration) || clip.duration <= 0) {
    return {
      maxChannelDelta: null,
      tracksCompared: 0,
      note: '片段时长不是正数，未做首末采样比较',
    };
  }
  let max = 0;
  let compared = 0;
  for (const track of clip.tracks) {
    if (track.times.length === 0 || track.getValueSize() <= 0) continue;
    const head = sampleTrackAt(track, 0);
    const tail = sampleTrackAt(track, clip.duration);
    const length = Math.min(head.length, tail.length);
    for (let i = 0; i < length; i += 1) {
      const delta = Math.abs(head[i] - tail[i]);
      if (delta > max) max = delta;
    }
    compared += 1;
  }
  return {
    maxChannelDelta: compared === 0 ? null : round(max, 6),
    tracksCompared: compared,
    note: '四元数按分量差比较，不是角度差；仅作循环安全量级指标',
  };
}

/* --------------------------------------------------------------- 导出树 */

/**
 * 导出用的克隆树：
 *  - 用 SkeletonUtils.clone 复制骨架并重新绑定 Skeleton（普通 Object3D.clone 会让
 *    克隆后的 SkinnedMesh 继续指向原骨骼，导出时找不到节点）；
 *  - 移除灯光/相机/常见辅助体，避免把参照物写进 GLB；
 *  - 不与源树共享几何/材质之外的状态，因此不对克隆树做 dispose（几何是共享的）。
 */
function buildExportRoot(root: THREE.Object3D, tools: TaskTools): { root: THREE.Object3D; removed: string[] } {
  const clone = cloneSkeletonTree(root);
  const removable: THREE.Object3D[] = [];
  clone.traverse((child) => {
    if (child === clone) return;
    const isHelper =
      child instanceof THREE.GridHelper ||
      child instanceof THREE.AxesHelper ||
      child instanceof THREE.ArrowHelper ||
      child instanceof THREE.BoxHelper;
    if (child instanceof THREE.Light || child instanceof THREE.Camera || isHelper) removable.push(child);
  });

  const removed: string[] = [];
  for (const child of removable) {
    removed.push(child.name.length > 0 ? child.name : child.type);
    child.removeFromParent();
  }
  if (removed.length > 0) {
    tools.info('EXPORT_STRIPPED', `导出前移除了 ${removed.length} 个灯光/相机/辅助节点`, { removed });
  }
  return { root: clone, removed };
}

/**
 * 预检轨道绑定：GLTFExporter 只会对解析不到的轨道打印 console.warn 然后跳过，
 * 那等于静默丢动画。这里用与导出器相同的解析方式先查一遍，有缺失就拒绝导出。
 */
function unresolvedTrackBindings(root: THREE.Object3D, clip: THREE.AnimationClip): string[] {
  const unresolved: string[] = [];
  for (const track of clip.tracks) {
    const binding = THREE.PropertyBinding.parseTrackName(track.name);
    let node = THREE.PropertyBinding.findNode(root, binding.nodeName) as THREE.Object3D | null;
    if (binding.objectName === 'bones') {
      const skinned = node as THREE.SkinnedMesh | null;
      node =
        skinned && skinned.isSkinnedMesh
          ? (skinned.skeleton.getBoneByName(String(binding.objectIndex)) ?? null)
          : null;
    }
    if (!node) unresolved.push(track.name);
  }
  return unresolved;
}

/* ---------------------------------------------------------------- base64 */

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function writeBinaryChecked(tools: TaskTools, relPath: string, bytes: Uint8Array): Promise<string> {
  try {
    return await tools.writeBinary(relPath, bytesToBase64(bytes));
  } catch (error) {
    if (error instanceof TaskError) throw error;
    throw new TaskError('WRITE_FAILED', `写入 ${relPath} 失败：${describeError(error)}`, 4, { relPath });
  }
}

/* ------------------------------------------------------------------ 任务 */

export const animationEditTask: Task = async (tools, request): Promise<TaskOutput> => {
  const args = request.args;

  /* --- 参数 --- */
  const clipName = requireNonEmptyString(args.clip, 'clip');
  const rename =
    args.rename === undefined || args.rename === null ? null : requireNonEmptyString(args.rename, 'rename');
  const start = optionalSeconds(args.start, 'start');
  const end = optionalSeconds(args.end, 'end');

  if ((start === null) !== (end === null)) {
    throw new TaskError('BAD_ARGS', 'start 与 end 必须同时给出，否则不知道裁剪哪一段', 2, { start, end });
  }
  const trimRequested = start !== null && end !== null;
  if (trimRequested && !(end > start)) {
    throw new TaskError('BAD_ARGS', 'end 必须大于 start', 2, { start, end });
  }

  let writeGlb: string | null = null;
  if (args.writeGlb !== undefined && args.writeGlb !== null) {
    writeGlb = requireNonEmptyString(args.writeGlb, 'writeGlb');
    if (!/\.glb$/i.test(writeGlb)) {
      throw new TaskError('BAD_ARGS', 'writeGlb 必须以 .glb 结尾', 2, { writeGlb });
    }
    assertRelativeOutputPath(writeGlb);
  }

  if (
    args.confirmWrite !== undefined &&
    args.confirmWrite !== null &&
    typeof args.confirmWrite !== 'boolean'
  ) {
    throw new TaskError('BAD_ARGS', 'confirmWrite 必须是布尔值', 2, { receivedType: typeof args.confirmWrite });
  }
  const confirmWrite = args.confirmWrite === true;

  /* --- 加载与格式闸门 --- */
  const asset: LoadedAsset = await tools.load();
  for (const item of asset.loadDiagnostics) tools.diagnostics.push(item);
  if (asset.format === 'usdz') {
    throw new TaskError(
      'USDZ_WRITE_UNSUPPORTED',
      '当前只有读取 USDZ 的证据，没有无损写回证明：拒绝写出，也不声称支持 USDZ 编辑',
      3,
      { format: asset.format, clipCount: asset.clips.length, requestedClip: clipName },
    );
  }

  /**
   * 资源缺口：重新序列化时贴图来自已加载的纹理对象。
   * 贴图/缓冲区加载失败会让派生 GLB 丢失材质或几何，因此不允许静默导出。
   */
  const loadFailureGroups = groupLoadFailures(asset.loads);
  const failedLoadCount = asset.loads.failed.length;
  if (failedLoadCount > 0) {
    tools.warn(
      'RESOURCE_LOAD_FAILED',
      `加载阶段有 ${failedLoadCount} 个请求失败；派生资产可能丢失贴图或几何`,
      { groups: loadFailureGroups.map((group) => ({ category: group.category, count: group.count })) },
    );
  }

  /* --- 定位片段 --- */
  const sourceClip = findClip(asset.clips, clipName);
  // 必须在裁剪、重命名和导出之前拒绝：CUBICSPLINE 的键值布局是
  // [inTangent, value, outTangent]，按普通关键帧采样会生成错误动作。
  assertSupportedTrackInterpolations(sourceClip);
  const durationBefore = sourceClip.duration;
  if (!Number.isFinite(durationBefore) || durationBefore <= 0) {
    tools.warn('CLIP_DURATION_UNKNOWN', '源片段时长不是有效正数，裁剪与循环判定不可靠', {
      clip: sourceClip.name,
      duration: durationBefore,
    });
  }

  /* --- 裁剪 --- */
  let editedClip: THREE.AnimationClip;
  let trimStats: TrimStats | null = null;
  if (trimRequested) {
    if (start < 0) {
      throw new TaskError('TRIM_OUT_OF_RANGE', 'start 不能为负', 2, { start, end, duration: durationBefore });
    }
    if (start >= durationBefore - TIME_EPS) {
      throw new TaskError('TRIM_OUT_OF_RANGE', 'start 必须小于片段时长', 2, {
        start,
        end,
        duration: round(durationBefore),
      });
    }
    if (end > durationBefore + 1e-3) {
      throw new TaskError('TRIM_OUT_OF_RANGE', 'end 超出片段时长', 2, {
        start,
        end,
        duration: round(durationBefore),
      });
    }
    const trimmed = trimClipBySeconds(sourceClip, start, end, rename ?? sourceClip.name);
    editedClip = trimmed.clip;
    trimStats = trimmed.stats;
  } else {
    editedClip = sourceClip.clone();
    if (rename !== null) editedClip.name = rename;
  }

  const loop = loopDelta(editedClip);
  const loopSafe = loop.maxChannelDelta === null ? null : loop.maxChannelDelta < LOOP_THRESHOLD;

  /* --- 写出计划 --- */
  const willWrite = writeGlb !== null && confirmWrite;
  const writePlanned = {
    requested: writeGlb !== null,
    confirmed: confirmWrite,
    willWrite,
    targetPath: writeGlb,
    exporter: 'THREE.GLTFExporter.parseAsync',
    threeRevision: THREE.REVISION,
    threeVersionNote: '渲染进程只能拿到 THREE.REVISION，完整 semver 未在此读取',
    binary: true,
    animations: [editedClip.name],
    stripLightsAndCameras: true,
    reason:
      writeGlb === null
        ? '未提供 writeGlb：只输出编辑计划，不落盘'
        : confirmWrite
          ? null
          : 'confirmWrite 不为 true：只输出写出计划，不落盘',
  };

  /* --- 导出 --- */
  let written = false;
  let writeResult: Record<string, unknown> | null = null;
  if (willWrite && writeGlb !== null) {
    if (failedLoadCount > 0) {
      // 明确拒绝而不是产出「看起来可用」的残缺资产。
      tools.fail('EXPORT_RESOURCE_INCOMPLETE', '源模型有资源加载失败，拒绝导出可能丢失贴图/几何的 GLB', {
        failedLoadCount,
        groups: loadFailureGroups.map((group) => ({ category: group.category, count: group.count })),
      });
      throw new TaskError(
        'EXPORT_RESOURCE_INCOMPLETE',
        `源模型有 ${failedLoadCount} 个资源请求加载失败（贴图或缓冲），导出的 GLB 会丢失对应材质/几何；` +
          '本次不写出派生资产。先用 inspect 修复资源或确认可接受的缺失后再导出',
        5,
        {
          failedLoadCount,
          groups: loadFailureGroups.map((group) => ({
            category: group.category,
            count: group.count,
            samples: group.samples,
          })),
          writeGlb,
        },
      );
    }
    const { root: exportRoot, removed } = buildExportRoot(asset.root, tools);
    const unresolved = unresolvedTrackBindings(exportRoot, editedClip);
    if (unresolved.length > 0) {
      tools.fail('EXPORT_FAILED', `导出树里有 ${unresolved.length} 条轨道找不到目标节点`, {
        unresolved: unresolved.slice(0, MAX_LISTED_CLIPS),
      });
      throw new TaskError(
        'EXPORT_FAILED',
        '轨道绑定在导出树里无法解析，拒绝生成会静默丢动画的 GLB',
        5,
        {
          unresolvedCount: unresolved.length,
          unresolved: unresolved.slice(0, MAX_LISTED_CLIPS),
          removedNodes: removed,
        },
      );
    }

    let bytes: Uint8Array;
    try {
      const exporter = new GLTFExporter();
      const result = await exporter.parseAsync(exportRoot, {
        binary: true,
        animations: [editedClip],
        trs: true,
        onlyVisible: true,
      });
      if (!(result instanceof ArrayBuffer)) {
        throw new Error('导出器返回了 JSON 文本而不是二进制 GLB');
      }
      bytes = new Uint8Array(result.slice(0));
    } catch (error) {
      tools.fail('EXPORT_FAILED', `GLB 导出失败：${describeError(error)}`, { writeGlb });
      throw new TaskError('EXPORT_FAILED', `GLB 导出失败：${describeError(error)}`, 5, {
        writeGlb,
        clip: editedClip.name,
        removedNodes: removed,
        // 诊断本身已进 tools.diagnostics；此处保留失败现场，方便 CLI 输出。
        diagnostics: tools.diagnostics.slice(-5),
      });
    }

    const absolutePath = await writeBinaryChecked(tools, writeGlb, bytes);
    written = true;
    writeResult = {
      absolutePath,
      bytes: bytes.byteLength,
      clip: editedClip.name,
      trackCount: editedClip.tracks.length,
    };
    tools.info('GLB_WRITTEN', `已写出只含片段 "${editedClip.name}" 的 GLB`, {
      path: writeGlb,
      bytes: bytes.byteLength,
    });
  }

  const sourceSummary = clipSummary(sourceClip);
  const resultSummary = clipSummary(editedClip);

  tools.info('ANIMATION_EDIT', `已编辑片段 "${sourceClip.name}"`, {
    trimApplied: trimRequested,
    renameApplied: editedClip.name !== sourceClip.name,
    written,
  });

  const data: Record<string, unknown> = {
    format: asset.format,
    sourceClip: sourceClip.name,
    resultClip: editedClip.name,
    durationBefore: round(durationBefore),
    durationAfter: round(editedClip.duration),
    tracksBefore: sourceClip.tracks.length,
    tracksAfter: editedClip.tracks.length,
    sourceClipSummary: sourceSummary,
    resultClipSummary: resultSummary,
    trim: {
      requested: trimRequested,
      applied: trimRequested,
      mode: trimRequested ? 'seconds' : null,
      start: trimRequested ? round(start) : null,
      end: trimRequested ? round(end) : null,
      duration: trimRequested ? round(end - start) : null,
      timeOriginShiftedToZero: trimRequested,
      endpointStrategy: trimRequested
        ? '每条轨道用自己的线性/离散插值器在端点求值补帧（已拒绝 CUBICSPLINE 与特殊插值）'
        : null,
      keptKeys: trimStats ? trimStats.keptKeys : null,
      synthesizedEndpoints: trimStats ? trimStats.synthesizedEndpoints : null,
      droppedTracks: trimStats ? trimStats.droppedTracks.slice(0, MAX_LISTED_CLIPS) : [],
      droppedTrackCount: trimStats ? trimStats.droppedTracks.length : 0,
    },
    rename: {
      requested: rename !== null,
      applied: editedClip.name !== sourceClip.name,
      from: sourceClip.name,
      to: editedClip.name,
    },
    loopSafe: {
      maxChannelDelta: loop.maxChannelDelta,
      threshold: LOOP_THRESHOLD,
      loopSafe,
      tracksCompared: loop.tracksCompared,
      note: loop.note,
    },
    writePlanned,
    written,
    writeResult,
    resourceLoad: {
      failedRequests: failedLoadCount,
      failedGroups: loadFailureGroups.map((group) => ({
        category: group.category,
        count: group.count,
        samples: group.samples,
      })),
      exportBlocked: willWrite && failedLoadCount > 0,
      note:
        failedLoadCount > 0
          ? '加载阶段有资源请求失败；确认导出会被拒绝（EXPORT_RESOURCE_INCOMPLETE），避免产出丢失贴图/几何的派生资产'
          : '本次加载没有资源请求失败；仍不代表导出与源文件逐字节一致',
    },
    limits: [
      '不是无损编辑：导出为重新序列化的 GLB',
      'USDZ 写回未实现',
      'CUBICSPLINE / 其他特殊插值轨道不支持编辑：明确拒绝，不线性化、不导出',
    ],
  };

  return { data };
};
