// 只读检查：不建 WebGL 上下文，不截图，不改文件。
// 未知值写 null 并给诊断，绝不写 0 冒充「没有」。
import * as THREE from 'three';
import {
  boxJson,
  clipSummary,
  finite,
  inspectSubtree,
  round,
  textureUsageOf,
  type Task,
  type TaskTools,
  type ToolRequest,
} from './api';
import { accountResources, resolveDeclared } from './resources';

interface MaterialSummary {
  name: string;
  type: string;
  transparent: boolean;
  maps: string[];
}

interface DependencySummary {
  uri: string;
  kind: 'buffer' | 'image';
  status: 'ok' | 'missing' | 'external' | 'embedded';
}

const MAX_LIST = 40;

function baseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function materialsOf(root: THREE.Object3D): MaterialSummary[] {
  const seen = new Set<THREE.Material>();
  const result: MaterialSummary[] = [];
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      if (!material || seen.has(material)) continue;
      seen.add(material);
      const maps: string[] = [];
      for (const [key, value] of Object.entries(material as unknown as Record<string, unknown>)) {
        if (value instanceof THREE.Texture) maps.push(key);
      }
      result.push({
        name: material.name || '(未命名材质)',
        type: material.type,
        transparent: material.transparent,
        maps,
      });
    }
  });
  return result;
}

async function gltfDependencies(
  tools: TaskTools,
  request: ToolRequest,
): Promise<{ items: DependencySummary[]; notes: string[] }> {
  const notes: string[] = [];
  if (request.input === null) return { items: [], notes };
  if (request.input.toLowerCase().endsWith('.glb')) {
    notes.push('GLB 的声明资源由 CLI 只读 JSON chunk 得出（见 resources.declared）');
    return { items: [], notes };
  }
  if (!request.input.toLowerCase().endsWith('.gltf')) return { items: [], notes };

  let text: string;
  try {
    text = await tools.readSibling(baseName(request.input));
  } catch {
    notes.push('无法读取 .gltf 文本，依赖清单未生成。');
    return { items: [], notes };
  }

  let json: {
    buffers?: unknown[];
    images?: unknown[];
    textures?: unknown[];
    materials?: unknown[];
    animations?: unknown[];
  };
  try {
    json = JSON.parse(text) as typeof json;
  } catch (error) {
    notes.push(`.gltf JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
    return { items: [], notes };
  }

  const collect = (list: unknown[] | undefined, kind: 'buffer' | 'image'): DependencySummary[] => {
    const items: DependencySummary[] = [];
    for (const entry of list ?? []) {
      const uri = (entry as { uri?: unknown })?.uri;
      if (typeof uri !== 'string') {
        items.push({ uri: '(内嵌 bufferView)', kind, status: 'embedded' });
        continue;
      }
      if (/^https?:/i.test(uri) || uri.startsWith('//')) {
        items.push({ uri, kind, status: 'external' });
        continue;
      }
      if (/^data:/i.test(uri)) {
        items.push({ uri: '(data URI)', kind, status: 'embedded' });
        continue;
      }
      items.push({ uri, kind, status: 'ok' });
    }
    return items;
  };

  const images = Array.isArray(json.images) ? json.images : [];
  const items = [...collect(json.buffers, 'buffer'), ...collect(images, 'image')];
  for (const item of items) {
    if (item.status !== 'ok') continue;
    try {
      await tools.readSibling(item.uri);
    } catch {
      item.status = 'missing';
    }
  }

  let imagesWithoutSource = 0;
  for (const entry of images) {
    const uri = (entry as { uri?: unknown })?.uri;
    if (typeof uri !== 'string' && !Number.isInteger((entry as { bufferView?: unknown })?.bufferView)) {
      imagesWithoutSource += 1;
    }
  }
  if (imagesWithoutSource > 0) notes.push(`${imagesWithoutSource} 张图片既无 uri 也无 bufferView`);

  return { items, notes };
}

export const inspectTask: Task = async (tools: TaskTools, request: ToolRequest) => {
  const asset = await tools.load();
  const root = asset.root;
  root.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(root);
  const stats = inspectSubtree(root);
  const usage = textureUsageOf(root);
  const materials = materialsOf(root);

  const skeletonList: Array<{
    bones: number;
    rootBone: string | null;
    boneNames: string[];
    boneNameCount: number;
  }> = [];

  root.traverse((child) => {
    if (skeletonList.length > 0) return;
    const mesh = child as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.skeleton) return;
    const bones = mesh.skeleton.bones;
    let top: THREE.Bone | null = bones[0] ?? null;
    while (top && top.parent && (top.parent as THREE.Bone).isBone) {
      top = top.parent as THREE.Bone;
    }
    const names = bones.map((bone) => bone.name || '(未命名骨骼)');
    skeletonList.push({
      bones: bones.length,
      rootBone: top ? top.name || '(未命名根骨骼)' : null,
      boneNames: names.slice(0, MAX_LIST),
      boneNameCount: names.length,
    });
  });
  const skeleton = skeletonList[0] ?? null;

  let morphTargets = 0;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    morphTargets += mesh.geometry?.morphAttributes?.position?.length ?? 0;
  });

  if (stats.meshes === 0) {
    tools.warn('NO_MESH', '模型中没有网格，可能是空场景或解析不完整');
  }
  if (stats.triangles === 0 && stats.meshes > 0) {
    tools.warn('EMPTY_GEOMETRY', '存在网格但没有三角面数据');
  }
  if (asset.clips.length === 0) {
    tools.warn('NO_ANIMATIONS', '资产内没有任何动画片段；snapshot 只能截静态姿态');
  }

  for (const item of asset.loadDiagnostics) tools.diagnostics.push(item);

  const size = bounds.getSize(new THREE.Vector3());
  if (Number.isFinite(size.y) && size.y > 100) {
    tools.warn('SUSPICIOUS_SCALE', `包围盒高度 ${round(size.y, 2)} 远大于人物/家具量级，请核对单位`, {
      sizeY: round(size.y, 2),
    });
  }

  let nonUniform = 0;
  root.traverse((child) => {
    const scale = child.scale;
    const spread = Math.max(
      Math.abs(scale.x - scale.y),
      Math.abs(scale.y - scale.z),
      Math.abs(scale.x - scale.z),
    );
    if (spread > 1e-3) nonUniform += 1;
  });
  if (nonUniform > 0) {
    tools.warn('NON_UNIFORM_SCALE', `${nonUniform} 个节点存在非均匀缩放；工具只报告，不做修正`, {
      nodes: nonUniform,
    });
  }

  tools.info('AXES_UNDECLARED', '资产未声明 up/forward 轴；工具不猜测坐标系，相关字段为 null');

  const dependencies = await gltfDependencies(tools, request);
  for (const item of dependencies.items) {
    if (item.status === 'missing') {
      tools.warn('MISSING_DEPENDENCY', `依赖缺失：${item.uri}`, { kind: item.kind });
    }
    if (item.status === 'external') {
      tools.warn('EXTERNAL_DEPENDENCY', `依赖指向外部/数据源，工具不会下载：${item.uri}`, {
        kind: item.kind,
      });
    }
  }

  /* --- 资源账本：声明 / 成功 / 失败 / 未知 分开计数 --- */
  const declared = resolveDeclared(asset.format, request.declaredResources, asset.declared);
  const account = accountResources(asset.loads, declared, usage);

  // 声明层清单（.gltf）与运行时请求失败是两件事，分别记录，不混成一个数字。
  const missingDependencies = dependencies.items.filter((item) => item.status === 'missing');
  const externalDependencies = dependencies.items.filter((item) => item.status === 'external');
  const embeddedDependencies = dependencies.items.filter((item) => item.status === 'embedded');
  const okDependencies = dependencies.items.filter((item) => item.status === 'ok');

  const incompleteReasons = [...account.reasons];
  const unknownReasons = [...account.unknown];
  if (missingDependencies.length > 0) {
    incompleteReasons.push(`${missingDependencies.length} 个声明依赖在模型目录中缺失`);
  }
  if (externalDependencies.length > 0) {
    unknownReasons.push(`${externalDependencies.length} 个声明依赖指向外部 URL，未下载或未验证`);
  }
  if (stats.meshes === 0) {
    incompleteReasons.push('模型没有网格，可能解析不完整或为空场景');
  } else if (stats.triangles === 0) {
    incompleteReasons.push('网格没有三角面数据');
  }
  const resourceStatus: 'complete' | 'incomplete' | 'unknown' =
    incompleteReasons.length > 0
      ? 'incomplete'
      : unknownReasons.length > 0
        ? 'unknown'
        : 'complete';
  const resourceReasons = [...incompleteReasons, ...unknownReasons];
  if (resourceStatus !== 'complete') {
    tools.warn('RESOURCE_INTEGRITY_PARTIAL', '报告已生成，但资源完整性不是 complete', {
      status: resourceStatus,
      reasons: resourceReasons,
    });
  }

  /* --- 贴图存在性：不要把「加载失败」说成「模型没有贴图」 --- */
  if (usage.materialTextureSlots === 0) {
    if (materials.length === 0) {
      // 没有材质就无从判断贴图；不写 NO_TEXTURES 这种容易被误解的提示。
    } else if (declared.images === 0) {
      tools.info('NO_TEXTURES', '资产未声明任何图片，材质也没有贴图槽位（可能是顶点色或纯色材质）');
    } else if (declared.images === null) {
      tools.info('TEXTURES_UNKNOWN', '材质没有贴图槽位；资产是否声明图片无法确认（unknown）');
    }
  } else if (usage.texturesWithImage === 0) {
    tools.warn(
      'TEXTURES_NOT_LOADED',
      `材质有 ${usage.materialTextureSlots} 个贴图槽位，但没有一个纹理带有图片数据；` +
        '不能据此认为模型原本没有贴图',
      {
        materialTextureSlots: usage.materialTextureSlots,
        textureObjects: usage.textureObjects,
        declaredImages: declared.images,
        failedImageRequests: account.runtime.textureLoadFailures,
      },
    );
  }

  const clips = asset.clips.map((clip) => clipSummary(clip));
  const triangles = stats.triangles;

  return {
    status: resourceStatus === 'complete' ? 'ok' : 'partial',
    data: {
      format: asset.format,
      source: {
        sha256: request.inputSha256,
        sizeBytes: request.inputSize,
        fileName: request.input ? baseName(request.input) : null,
      },
      bounds: boxJson(bounds),
      geometry: {
        meshes: stats.meshes,
        skinnedMeshes: stats.skinnedMeshes,
        triangles,
        vertices: stats.vertices,
        morphTargets,
      },
      materials: {
        count: materials.length,
        items: materials.slice(0, MAX_LIST),
        truncated: materials.length > MAX_LIST,
      },
      /** 材质实际引用的不同 Texture 对象数；不是文件声明的图片数量。 */
      textures: usage.textureObjects,
      resources: {
        declared: account.declared,
        runtime: account.runtime,
        failures: account.failures,
        notAttemptedImages: account.notAttemptedImages,
        materialRisk: account.materialRisk,
        countsNotes: account.countsNotes,
      },
      skeleton,
      animations: {
        count: clips.length,
        clips,
        note: '片段来自资产本身；这里列出的动作不等于游戏中可用的语义动作',
      },
      dependencies: {
        items: dependencies.items.slice(0, 128),
        truncated: dependencies.items.length > 128,
        notes: dependencies.notes,
      },
      resourceIntegrity: {
        reportGenerated: true,
        status: resourceStatus,
        reasons: resourceReasons,
        dependencies: {
          total: dependencies.items.length,
          ok: okDependencies.length,
          embedded: embeddedDependencies.length,
          missing: missingDependencies.length,
          external: externalDependencies.length,
          missingUris: missingDependencies.slice(0, 40).map((item) => item.uri),
          externalUris: externalDependencies.slice(0, 40).map((item) => item.uri),
          notes: dependencies.notes,
        },
        loadFailureCount: account.runtime.loadFailures,
        loadFailureCodes: account.failures.length > 0 ? ['DEPENDENCY_LOAD_FAILED'] : [],
        note:
          resourceStatus === 'complete'
            ? '声明资源已核对且本次加载没有失败记录；这只描述资源，不代表模型语义、材质观感或动作可用'
            : '报告已生成，但资源完整性不完整或未知；不得写成“全部正常”，也不得把失败解释为“模型没有贴图”',
      },
      axes: {
        up: null,
        forward: null,
        units: null,
        note: '未在资产中声明；工具不猜测轴向或单位',
      },
      dimensions: {
        height: finite(size.y),
        width: finite(size.x),
        depth: finite(size.z),
      },
    },
  };
};
