// 只读解析 GLB 头与 JSON chunk，得到「文件声明了哪些资源」。
//
// 边界：
//  - 只读文件头（12 B）、第一个 chunk 头（8 B）、JSON chunk 本身和第二个 chunk 头（8 B）；
//    不读 BIN 数据、不把模型字节转成 base64、不复制到渲染进程。
//  - 任何异常都返回 `source: 'unavailable'` 与说明，不抛错、不猜数字。
//  - 只描述声明与结构性校验结果；图片能否解码由渲染进程实际加载决定。

import { open } from 'node:fs/promises';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'
const MAX_JSON_CHUNK = 32 * 1024 * 1024;
const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const MAX_NAME_SAMPLES = 20;

/** 与渲染页 `DeclaredResourceSummary` 同形；字段全部允许为 null（未知）。 */
function unavailable(reason, code) {
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
    embeddedImageBytes: null,
    mimeTypes: null,
    animations: null,
    skippedImages: null,
    imageNameSamples: [],
    notes: [reason],
    error: { code, message: reason },
  };
}

async function readAt(handle, length, position, size) {
  if (length <= 0) return Buffer.alloc(0);
  if (position < 0 || position + length > size) return null;
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) return null;
  return buffer;
}

/**
 * @param {string} filePath
 * @returns {Promise<object>} 声明资源摘要；失败时为 `source: 'unavailable'` + notes
 */
export async function describeGlbDeclared(filePath) {
  let handle = null;
  try {
    handle = await open(filePath, 'r');
    const { size } = await handle.stat();

    const header = await readAt(handle, HEADER_BYTES, 0, size);
    if (!header) return unavailable('GLB 文件过短，不足 12 字节头部', 'GLB_HEADER_TRUNCATED');
    if (header.readUInt32LE(0) !== GLB_MAGIC) {
      return unavailable('文件头不是 glTF magic，不能按 GLB 解析资源声明', 'GLB_MAGIC_MISMATCH');
    }
    const version = header.readUInt32LE(4);
    if (version !== 2) {
      return unavailable(`GLB 版本为 ${version}，只支持 glTF 2.0 的 GLB`, 'GLB_VERSION_UNSUPPORTED');
    }
    const declaredLength = header.readUInt32LE(8);
    const notes = [];
    if (declaredLength !== size) {
      notes.push(`GLB 头部声明长度 ${declaredLength} 与实际文件大小 ${size} 不一致；声明统计可能不可靠`);
    }

    const jsonChunkHeader = await readAt(handle, CHUNK_HEADER_BYTES, HEADER_BYTES, size);
    if (!jsonChunkHeader) return unavailable('缺少 JSON chunk 头部', 'GLB_JSON_CHUNK_MISSING');
    const jsonLength = jsonChunkHeader.readUInt32LE(0);
    const jsonType = jsonChunkHeader.readUInt32LE(4);
    if (jsonType !== CHUNK_JSON) {
      return unavailable('GLB 第一个 chunk 不是 JSON', 'GLB_JSON_CHUNK_TYPE');
    }
    if (jsonLength === 0 || jsonLength > MAX_JSON_CHUNK) {
      return unavailable(`JSON chunk 长度 ${jsonLength} 超出允许范围（0–${MAX_JSON_CHUNK}）`, 'GLB_JSON_CHUNK_LENGTH');
    }
    const jsonStart = HEADER_BYTES + CHUNK_HEADER_BYTES;
    if (jsonStart + jsonLength > size) {
      return unavailable(
        `JSON chunk 越过文件末尾（起始 ${jsonStart}，长度 ${jsonLength}，文件 ${size}）`,
        'GLB_JSON_CHUNK_OVERFLOW',
      );
    }
    const jsonBuffer = await readAt(handle, jsonLength, jsonStart, size);
    if (!jsonBuffer) return unavailable('无法读取 JSON chunk 内容', 'GLB_JSON_CHUNK_READ');

    let json;
    try {
      // 规范允许 JSON chunk 用空格（0x20）填充；去掉尾部填充后再解析。
      json = JSON.parse(jsonBuffer.toString('utf8').replace(/[\u0000\u0020]+$/g, ''));
    } catch (error) {
      return unavailable(
        `JSON chunk 解析失败：${error instanceof Error ? error.message : String(error)}`,
        'GLB_JSON_PARSE',
      );
    }
    if (!json || typeof json !== 'object') {
      return unavailable('JSON chunk 不是对象', 'GLB_JSON_SHAPE');
    }

    /* --- BIN chunk：只用于校验内嵌图片的 bufferView 是否越界 --- */
    const binHeaderOffset = jsonStart + jsonLength;
    let binLength = null;
    let binValid = false;
    if (binHeaderOffset + CHUNK_HEADER_BYTES <= size) {
      const binHeader = await readAt(handle, CHUNK_HEADER_BYTES, binHeaderOffset, size);
      if (binHeader) {
        const length = binHeader.readUInt32LE(0);
        const type = binHeader.readUInt32LE(4);
        if (type === CHUNK_BIN) {
          if (binHeaderOffset + CHUNK_HEADER_BYTES + length <= size) {
            binLength = length;
            binValid = true;
          } else {
            notes.push(`BIN chunk 声明长度 ${length} 越过文件末尾，内嵌资源边界无法验证`);
          }
        } else {
          notes.push('GLB 第二个 chunk 不是 BIN，内嵌资源边界无法验证');
        }
      }
    }

    const buffers = Array.isArray(json.buffers) ? json.buffers : [];
    const bufferViews = Array.isArray(json.bufferViews) ? json.bufferViews : [];
    const images = Array.isArray(json.images) ? json.images : [];
    const textures = Array.isArray(json.textures) ? json.textures : [];
    const materials = Array.isArray(json.materials) ? json.materials : [];
    const animations = Array.isArray(json.animations) ? json.animations : [];
    const firstBufferEmbedded = !(buffers[0] && typeof buffers[0].uri === 'string');

    let imagesEmbedded = 0;
    let imagesDataUri = 0;
    let imagesExternal = 0;
    let imagesLocalFile = 0;
    let imagesWithoutSource = 0;
    let invalidBufferViews = 0;
    let unverifiableBufferViews = 0;
    let embeddedImageBytes = 0;
    let skippedImages = 0;
    const mimeTypes = {};
    const imageNameSamples = [];

    for (const [index, image] of images.entries()) {
      if (!image || typeof image !== 'object') {
        imagesWithoutSource += 1;
        skippedImages += 1;
        continue;
      }
      const mimeType = typeof image.mimeType === 'string' ? image.mimeType : null;
      if (mimeType) mimeTypes[mimeType] = (mimeTypes[mimeType] ?? 0) + 1;
      if (imageNameSamples.length < MAX_NAME_SAMPLES && typeof image.name === 'string' && image.name !== '') {
        imageNameSamples.push({ index, name: image.name, mimeType });
      }

      if (Number.isInteger(image.bufferView)) {
        imagesEmbedded += 1;
        const view = bufferViews[image.bufferView];
        if (!view || !Number.isInteger(view.byteLength)) {
          invalidBufferViews += 1;
          continue;
        }
        const offset = Number.isInteger(view.byteOffset) ? view.byteOffset : 0;
        if (!firstBufferEmbedded || !binValid) {
          unverifiableBufferViews += 1;
          continue;
        }
        if (offset < 0 || view.byteLength < 0 || offset + view.byteLength > binLength) {
          invalidBufferViews += 1;
          continue;
        }
        embeddedImageBytes += view.byteLength;
      } else if (typeof image.uri === 'string') {
        if (/^data:/i.test(image.uri)) imagesDataUri += 1;
        else if (/^https?:/i.test(image.uri) || image.uri.startsWith('//')) imagesExternal += 1;
        else imagesLocalFile += 1;
      } else {
        imagesWithoutSource += 1;
      }
    }

    if (invalidBufferViews > 0) {
      notes.push(`${invalidBufferViews} 张内嵌图片的 bufferView 越界或缺失；这些图片按声明已损坏`);
    }
    if (unverifiableBufferViews > 0) {
      notes.push(`${unverifiableBufferViews} 张内嵌图片因 BIN 无法校验而未核对边界`);
    }
    if (imagesExternal > 0) {
      notes.push(`${imagesExternal} 张图片引用远程 URL，工具不会下载`);
    }
    if (imagesLocalFile > 0) {
      notes.push(`${imagesLocalFile} 张图片引用外部文件，加载结果取决于同目录依赖是否可读`);
    }

    return {
      source: 'glb-json',
      images: images.length,
      textures: textures.length,
      materials: materials.length,
      buffers: buffers.length,
      animations: animations.length,
      imagesEmbedded,
      imagesDataUri,
      imagesExternal,
      imagesLocalFile,
      imagesWithoutSource,
      invalidBufferViews,
      embeddedImageBytes: firstBufferEmbedded && binValid ? embeddedImageBytes : null,
      mimeTypes: Object.keys(mimeTypes).length > 0 ? mimeTypes : null,
      skippedImages: skippedImages > 0 ? skippedImages : null,
      imageNameSamples,
      notes,
      error: null,
    };
  } catch (error) {
    return unavailable(
      `无法读取 GLB 结构：${error instanceof Error ? error.message : String(error)}`,
      'GLB_READ_FAILED',
    );
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}
