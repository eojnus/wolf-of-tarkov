// 资产片段截图：确定性相机、显式时间与朝向。
// 明确边界：这里只采样资产自带的 AnimationClip，不是游戏里的程序化 walk/run/jump。
import * as THREE from 'three';
import {
  boxJson,
  frameCamera,
  inspectSubtree,
  textureUsageOf,
  TaskError,
  type Task,
  type TaskTools,
  type ToolRequest,
} from './api';
import { accountResources, unknownDeclared } from './resources';

function numArg(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function safeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return (cleaned || 'clip').slice(0, 40);
}

export const snapshotTask: Task = async (tools: TaskTools, request: ToolRequest) => {
  const args = request.args;
  const clipName = typeof args.clip === 'string' && args.clip.trim() !== '' ? args.clip.trim() : null;
  const requestedTime = numArg(args.time, 0);
  const yaw = numArg(args.yaw, 0);
  const width = Math.max(64, Math.round(numArg(args.width, 800)));
  const height = Math.max(64, Math.round(numArg(args.height, 1000)));
  const background = numArg(args.background, 0x20242b);

  const asset = await tools.load();
  for (const item of asset.loadDiagnostics) tools.diagnostics.push(item);

  let clip: THREE.AnimationClip | null = null;
  if (clipName) {
    clip = asset.clips.find((item) => item.name === clipName) ?? null;
    if (!clip) {
      throw new TaskError('CLIP_NOT_FOUND', `资产里没有名为 ${clipName} 的片段`, 3, {
        available: asset.clips.map((item) => item.name).slice(0, 20),
      });
    }
  } else if (asset.clips.length > 0) {
    tools.info('CLIP_NOT_SELECTED', '未指定 --clip，输出为静止姿态；资产内有片段可用', {
      available: asset.clips.map((item) => item.name).slice(0, 20),
    });
  }

  let time = requestedTime;
  if (clip) {
    if (time < 0) {
      tools.warn('TIME_CLAMPED', `--time 为负，已按 0 处理`, { requested: requestedTime });
      time = 0;
    }
    if (time > clip.duration) {
      tools.warn('TIME_CLAMPED', `--time 超片段时长，已按片段末尾处理`, {
        requested: requestedTime,
        duration: clip.duration,
      });
      time = clip.duration;
    }
  }

  const wrapper = new THREE.Group();
  wrapper.name = 'model-tool-subject';
  wrapper.rotation.y = (yaw * Math.PI) / 180;
  wrapper.add(asset.root);

  const frame = await tools.frame(width, height);
  frame.setBackground(background);
  frame.useDefaultLights();
  frame.scene.add(wrapper);

  let mixer: THREE.AnimationMixer | null = null;
  if (clip) {
    mixer = new THREE.AnimationMixer(asset.root);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    mixer.setTime(time);
  }

  wrapper.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(asset.root);
  if (bounds.isEmpty()) {
    throw new TaskError('EMPTY_BOUNDS', '模型包围盒为空，无法取景', 5);
  }
  const cameraInfo = frameCamera(frame.camera, bounds, 30, 10);
  const backend = frame.backendInfo();
  const base64 = await frame.capture();
  const fileName = `snapshot-${safeName(clip ? clip.name : 'static')}-${Math.round(yaw)}deg.png`;
  const written = await tools.writePng(fileName, base64);

  const stats = inspectSubtree(asset.root);
  const usage = textureUsageOf(asset.root);
  const declared =
    asset.format === 'glb'
      ? (request.declaredResources ??
        unknownDeclared('CLI 未能解析 GLB JSON chunk，声明资源数量为 unknown'))
      : unknownDeclared(
          asset.format === 'gltf'
            ? 'snapshot 不解析 .gltf JSON；声明资源请用 inspect 查看'
            : 'USDZ 未逐项枚举资源，声明数量为 unknown',
        );
  const account = accountResources(asset.loads, declared, usage);

  /**
   * 截图是否可以作为「材质正确」的证据：
   *  - known：确实有贴图/模型请求失败，截图可能呈灰模；
   *  - possible：声明与运行时对不上（例如外部图片、有槽位但没有图片数据）；
   *  - unknown：没有清单（USDZ），保持原有的 ok，但报告必须写明未验证；
   *  - none：没有发现影响材质的缺口。
   */
  const materialPartial = account.materialRisk === 'known' || account.materialRisk === 'possible';
  const status: 'ok' | 'partial' = account.status === 'incomplete' || materialPartial ? 'partial' : 'ok';
  const materialNote =
    account.materialRisk === 'known'
      ? '有贴图/资源请求加载失败：截图中的材质可能缺失或呈灰色，不能作为材质正确的证据'
      : account.materialRisk === 'possible'
        ? '资源声明与运行时结果对不上（见 resources.unknown/failures）：截图材质未经证实'
        : account.materialRisk === 'unknown'
          ? '没有资源清单：截图可见的内容不代表材质已完整还原'
          : '本次加载没有发现影响材质的资源缺口';

  return {
    status,
    data: {
      source: {
        sha256: request.inputSha256,
        sizeBytes: request.inputSize,
        fileName: request.input ? request.input.replace(/\\/g, '/').split('/').pop() ?? null : null,
      },
      clip: clip
        ? { name: clip.name, duration: clip.duration, tracks: clip.tracks.length }
        : null,
      timeSeconds: time,
      requestedTimeSeconds: requestedTime,
      yawDegrees: yaw,
      viewport: { width, height, background: `#${background.toString(16).padStart(6, '0')}` },
      camera: {
        projection: 'perspective',
        fov: frame.camera.fov,
        azimuthDegrees: 30,
        elevationDegrees: 10,
        distanceMeters: cameraInfo.distance,
        target: {
          x: cameraInfo.target.x,
          y: cameraInfo.target.y,
          z: cameraInfo.target.z,
        },
      },
      bounds: boxJson(bounds),
      geometry: {
        meshes: stats.meshes,
        triangles: stats.triangles,
        textures: usage.textureObjects,
        texturesWithImage: usage.texturesWithImage,
      },
      resources: {
        declared: account.declared,
        runtime: account.runtime,
        failures: account.failures,
        notAttemptedImages: account.notAttemptedImages,
        materialRisk: account.materialRisk,
        countsNotes: account.countsNotes,
      },
      resourceIntegrity: {
        reportGenerated: true,
        status: account.status,
        materialRisk: account.materialRisk,
        reasons: account.reasons,
        unknown: account.unknown,
        note: materialNote,
      },
      environment: {
        three: THREE.REVISION,
        renderer: backend,
        lights: 'ambient 1.6 + key 2.2 + fill 0.8（工具固定光照，非游戏环境）',
        toneMapping: 'none',
        colorSpace: 'srgb',
      },
      image: { path: written, sha256: null },
      missingResources: asset.loadDiagnostics,
      note: '只采样资产自带片段；不代表游戏内程序化 walk/run/jump，也不代表运行手感或性能',
      limits: [
        '单张静态截图不能证明动作流畅或方向自然',
        '材质还原基于 three USDLoader/GLTFLoader，与游戏或原工具有差异',
        ...(status === 'partial'
          ? ['资源不完整：截图仍会写出用于排查，但不能作为材质正确或资产可用的证据']
          : []),
        'USDZ 只读，未生成任何派生资产',
      ],
    },
  };
};
