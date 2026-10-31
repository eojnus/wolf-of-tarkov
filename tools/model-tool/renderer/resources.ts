// 资源账本：把「文件声明」「运行时成功」「运行时失败」「无法确认」分开计数。
//
// 口径（同时写进报告 countsNotes）：
//  - declared.images / declared.textures 是 glTF JSON 里 images / textures 数组长度。
//    一张图片可以被多个纹理引用，一个纹理可以被多个材质槽位引用，三者不是一一对应。
//  - runtime.textureObjects 是材质实际引用的不同 THREE.Texture 对象数；
//    runtime.materialTextureSlots 是材质贴图槽位引用次数（会重复计数同一纹理）。
//  - 加载失败按 URL 归类；GLB 内嵌图片的 URL 是本次运行临时生成的 blob:，
//    不能当作稳定资源路径，也无法可靠映射回图片索引。
import type {
  AssetLoadRecord,
  DeclaredResourceSummary,
  Diagnostic,
  TextureUsage,
} from './api';

export type LoadCategory = 'model' | 'texture' | 'buffer' | 'other';

export interface LoadFailureGroup {
  readonly category: LoadCategory;
  readonly count: number;
  readonly attempted: number;
  readonly samples: string[];
  readonly note: string | null;
}

export interface ResourceRuntimeCounts {
  readonly loadAttempts: number;
  readonly loadFailures: number;
  readonly textureLoadAttempts: number;
  readonly textureLoadFailures: number;
  readonly textureObjects: number;
  readonly texturesWithImage: number;
  readonly materialTextureSlots: number;
}

export interface ResourceAccount {
  /** 与 inspect 的 resourceIntegrity.status 同义。 */
  readonly status: 'complete' | 'incomplete' | 'unknown';
  /**
   * 材质还原风险：known = 有实际加载失败；possible = 声明与运行时对不上；
   * unknown = 清单不可用（如 USDZ）；none = 没有发现影响材质的缺口。
   */
  readonly materialRisk: 'none' | 'possible' | 'known' | 'unknown';
  readonly reasons: string[];
  readonly unknown: string[];
  readonly declared: DeclaredResourceSummary;
  readonly runtime: ResourceRuntimeCounts;
  readonly failures: LoadFailureGroup[];
  readonly notAttemptedImages: number | null;
  readonly countsNotes: string[];
}

const MAX_SAMPLES = 8;

const CATEGORY_LABEL: Record<LoadCategory, string> = {
  model: '模型主文件',
  texture: '贴图/图片',
  buffer: '二进制缓冲',
  other: '其他依赖',
};

export function groupLoadFailures(loads: AssetLoadRecord): LoadFailureGroup[] {
  const categories: LoadCategory[] = ['model', 'texture', 'buffer', 'other'];
  const groups: LoadFailureGroup[] = [];
  for (const category of categories) {
    const failed = loads.failed.filter((item) => item.category === category);
    if (failed.length === 0) continue;
    const attempted = loads.started.filter((item) => item.category === category).length;
    groups.push({
      category,
      count: failed.length,
      attempted,
      samples: failed.slice(0, MAX_SAMPLES).map((item) =>
        /^data:/i.test(item.url) ? `${item.url.split(',')[0]},[内联数据已省略]` : item.url,
      ),
      note:
        category === 'texture' && failed.some((item) => /^blob:/i.test(item.url))
          ? '失败项含 blob: 临时 URL；该地址每次运行都不同，不能当作原始资源路径，也无法可靠映射回图片索引'
          : null,
    });
  }
  return groups;
}

/** 把多次同类失败聚合成一条诊断：保留实际数量、类别与样例，不静默吞掉。 */
export function failureDiagnostics(groups: readonly LoadFailureGroup[]): Diagnostic[] {
  return groups.map((group) => {
    const truncated = group.count > group.samples.length ? `（仅列前 ${group.samples.length} 个样例）` : '';
    return {
      code: 'DEPENDENCY_LOAD_FAILED',
      severity: 'warning' as const,
      message:
        `${group.count} 个${CATEGORY_LABEL[group.category]}请求加载失败${truncated}；` +
        (group.category === 'texture' ? '截图中材质可能缺失或呈灰色' : '相关结果可能不完整'),
      details: {
        category: group.category,
        count: group.count,
        attempted: group.attempted,
        samples: group.samples,
        aggregated: true,
        ...(group.note ? { note: group.note } : {}),
      },
    };
  });
}

function unavailableDeclared(notes: string[]): DeclaredResourceSummary {
  return {
    source: 'unavailable',
    images: null,
    textures: null,
    materials: null,
    buffers: null,
    imagesEmbedded: null,
    imagesDataUri: null,
    imagesExternal: null,
    imagesLocalFile: null,
    imagesWithoutSource: null,
    invalidBufferViews: null,
    mimeTypes: null,
    notes,
  };
}

/** 没有清单时的占位（USDZ、或 CLI 未能解析 GLB JSON）。 */
export function unknownDeclared(reason: string): DeclaredResourceSummary {
  return unavailableDeclared([reason]);
}

export function accountResources(
  loads: AssetLoadRecord,
  declared: DeclaredResourceSummary | null,
  usage: TextureUsage,
): ResourceAccount {
  const manifest = declared ?? unknownDeclared('该格式/命令没有资源清单');
  const failures = groupLoadFailures(loads);
  const textureLoadAttempts = loads.started.filter((item) => item.category === 'texture').length;
  const textureLoadFailures = loads.failed.filter((item) => item.category === 'texture').length;
  const reasons: string[] = [];
  const unknown: string[] = [];

  for (const group of failures) {
    if (group.category === 'texture') {
      reasons.push(`${group.count} 张贴图/图片加载失败（本次请求 ${group.attempted} 个）`);
    } else {
      reasons.push(`${group.count} 个${CATEGORY_LABEL[group.category]}请求加载失败`);
    }
  }

  if (manifest.invalidBufferViews !== null && manifest.invalidBufferViews > 0) {
    reasons.push(`声明中有 ${manifest.invalidBufferViews} 张内嵌图片的 bufferView 越界或缺失`);
  }

  const notAttemptedImages =
    manifest.images === null ? null : Math.max(0, manifest.images - textureLoadAttempts);

  if (manifest.source === 'unavailable') {
    unknown.push(manifest.notes[0] ?? '无法确认文件声明了哪些资源');
  } else {
    if (manifest.images === null || manifest.textures === null) {
      unknown.push('资源清单字段不完整，声明数量不可用');
    }
    if ((manifest.imagesExternal ?? 0) > 0) {
      unknown.push(`${manifest.imagesExternal} 张声明图片指向远程 URL，工具不下载，未验证`);
    }
    if ((manifest.imagesLocalFile ?? 0) > 0) {
      unknown.push(`${manifest.imagesLocalFile} 张声明图片引用外部文件，结果取决于同目录依赖`);
    }
    if (notAttemptedImages !== null && notAttemptedImages > 0) {
      unknown.push(`${notAttemptedImages} 张声明图片没有出现在加载请求中（可能未被材质引用）`);
    }
  }

  const status: ResourceAccount['status'] =
    reasons.length > 0 ? 'incomplete' : unknown.length > 0 ? 'unknown' : 'complete';

  const materialMissing =
    usage.materialTextureSlots > 0 && usage.texturesWithImage === 0
      ? true
      : usage.texturesWithImage < usage.textureObjects;
  const knownMaterialFailure =
    failures.length > 0 || (manifest.invalidBufferViews ?? 0) > 0;

  const materialRisk: ResourceAccount['materialRisk'] = knownMaterialFailure
    ? 'known'
    : manifest.source === 'unavailable'
      ? 'unknown'
      : (manifest.imagesExternal ?? 0) > 0 || materialMissing
        ? 'possible'
        : 'none';

  return {
    status,
    materialRisk,
    reasons,
    unknown,
    declared: manifest,
    runtime: {
      loadAttempts: loads.started.length,
      loadFailures: loads.failed.length,
      textureLoadAttempts,
      textureLoadFailures,
      textureObjects: usage.textureObjects,
      texturesWithImage: usage.texturesWithImage,
      materialTextureSlots: usage.materialTextureSlots,
    },
    failures,
    notAttemptedImages,
    countsNotes: [
      'declared.images / declared.textures 分别是 glTF JSON images / textures 数组长度；一张图片可被多个纹理、多个材质槽位引用，不一一对应',
      'runtime.textureObjects 是材质实际引用的不同 THREE.Texture 对象数；materialTextureSlots 是槽位引用次数，会重复计数',
      'runtime.textureLoadFailures 只统计本次真正发出并失败的图片请求；按 URL 的类型与扩展名分类，未知类型归为 other',
      'blob: URL 是临时地址，无法可靠回指到具体图片索引或名称；data: 样例省略内联内容',
      'null 表示无法确认，不是 0；不要用本报告的 null 推断「模型没有贴图」',
    ],
  };
}
