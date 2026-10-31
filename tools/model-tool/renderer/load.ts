// 加载明确授权的 GLB/glTF/USDZ；所有请求都经过 modeltool:// 协议，
// 越界与远程资源由主进程拒绝，这里只负责把失败变成诊断。
//
// 资源账本：加载阶段经 THREE.LoadingManager 走过的 URL 会被记下来（去重），
// 失败的 URL 也一并记录。失败按类别聚合成一条诊断，但保留实际数量与样例。
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { USDLoader } from 'three/examples/jsm/loaders/USDLoader.js';
import {
  disposeSubtree,
  TaskError,
  type AssetLoadItem,
  type AssetLoadRecord,
  type Diagnostic,
  type LoadedAsset,
  type ModelFormat,
} from './api';
import { failureDiagnostics, groupLoadFailures } from './resources';

const SUPPORTED = new Map<string, ModelFormat>([
  ['.glb', 'glb'],
  ['.gltf', 'gltf'],
  ['.usdz', 'usdz'],
]);

const IMAGE_EXTENSION = /\.(png|jpe?g|webp|avif|ktx2|basis|gif|bmp)$/i;

export function formatOf(filePath: string): ModelFormat {
  const dot = filePath.lastIndexOf('.');
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
  const format = SUPPORTED.get(ext);
  if (!format) {
    throw new TaskError(
      'FORMAT_UNSUPPORTED',
      `不支持的模型扩展名：${ext || '(无扩展名)'}；当前只读取 .glb / .gltf / .usdz`,
      3,
      { supported: [...SUPPORTED.keys()] },
    );
  }
  return format;
}

export function inputUrl(fileName: string): string {
  return `modeltool://input/${encodeURIComponent(fileName)}`;
}

function baseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/** 只读加载；任何异常都带上是哪个 URL 失败，避免 Agent 拿到空错误。 */
export async function loadAssetFromInput(input: string): Promise<LoadedAsset> {
  const format = formatOf(input);
  const fileName = baseName(input);
  const url = inputUrl(fileName);
  const diagnostics: Diagnostic[] = [];

  /** 按 URL 可识别的信息分类；未知 data: 类型不猜成图片。 */
  const classify = (loadUrl: string): AssetLoadItem['category'] => {
    if (loadUrl === url) return 'model';
    if (loadUrl.startsWith('blob:')) return 'texture';
    if (/^data:/i.test(loadUrl)) {
      const mime = /^data:([^;,]*)/i.exec(loadUrl)?.[1]?.toLowerCase() ?? '';
      if (mime.startsWith('image/')) return 'texture';
      if (mime === 'application/octet-stream' || mime === 'application/gltf-buffer') return 'buffer';
      return 'other';
    }
    const clean = loadUrl.split('?')[0].split('#')[0];
    if (IMAGE_EXTENSION.test(clean)) return 'texture';
    if (/\.bin$/i.test(clean)) return 'buffer';
    return 'other';
  };

  const started: AssetLoadItem[] = [];
  const failed: AssetLoadItem[] = [];
  const seen = new Set<string>();

  const manager = new THREE.LoadingManager();
  // LoadingManager 的 onStart 只在「从空闲变为加载中」时触发一次，
  // 不能用来统计每一个请求；onProgress 在每次 itemEnd（含失败）时触发，才是完整清单。
  manager.onProgress = (loadUrl) => {
    if (seen.has(loadUrl)) return;
    seen.add(loadUrl);
    started.push({ url: loadUrl, category: classify(loadUrl) });
  };
  manager.onError = (loadUrl) => {
    failed.push({ url: loadUrl, category: classify(loadUrl) });
  };

  const loads: AssetLoadRecord = { started, failed };
  const finish = <T extends LoadedAsset>(asset: T): T => {
    for (const item of failureDiagnostics(groupLoadFailures(loads))) diagnostics.push(item);
    return asset;
  };

  const startedAt = performance.now();
  try {
    if (format === 'usdz') {
      const loader = new USDLoader(manager);
      const group = (await loader.loadAsync(url)) as THREE.Group & {
        animations?: THREE.AnimationClip[];
      };
      const clips = group.animations ?? [];
      diagnostics.push({
        code: 'USDZ_READ_ONLY',
        severity: 'info',
        message: 'USDZ 仅用于读取与截图；本轮没有无损写回证明，导出能力未实现。',
        details: { writer: null },
      });
      return finish({
        root: group,
        clips,
        format,
        loadDiagnostics: diagnostics,
        loads,
        dispose: () => disposeSubtree(group),
      });
    }

    const loader = new GLTFLoader(manager);
    const gltf = await loader.loadAsync(url);
    const clips = gltf.animations ?? [];
    return finish({
      root: gltf.scene,
      clips,
      format,
      loadDiagnostics: diagnostics,
      loads,
      dispose: () => {
        disposeSubtree(gltf.scene);
        // GLTFLoader 的纹理也可能挂在 parser 上，但 scene 遍历已覆盖实际引用。
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TaskError('LOAD_FAILED', `模型加载失败（${format}）：${message}`, 5, {
      url,
      format,
      fileName,
      elapsedMs: Math.round(performance.now() - startedAt),
      failedRequests: failed.slice(0, 8),
      failedRequestCount: failed.length,
    });
  }
}
