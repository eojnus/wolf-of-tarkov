// 路径规范化、隔离与安全写入。所有路径都是绝对路径；不依赖当前工作目录解释。
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, realpath, stat, lstat, access, constants, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolError, EXIT } from './schema.mjs';

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 持久输出范围：当前项目目录的父目录。
 *
 * 由工具自身位置向上推导（lib → model-tool → tools → 项目目录 → 其父目录），
 * 不依赖调用时的 cwd；不同 worktree 会得到不同的范围。执行环境可能进一步限制写入。
 * 输入模型仍可通过绝对路径读取此范围外的文件，但输入只读不等于允许在该目录写输出。
 */
export const AUTHORIZED_OUTPUT_ROOT = resolve(HERE, '..', '..', '..', '..');

/** 路径是否在 root 内或等于 root。Windows 的盘符与大小写由 path.relative 处理。 */
export function isWithinOrEqual(root, candidate) {
  const rel = relative(root, candidate);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** 路径是否严格位于 root 之内（不含 root 本身）。 */
export function isInside(root, candidate) {
  return isWithinOrEqual(root, candidate) && relative(root, candidate) !== '';
}

export function assertAbsolute(label, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ToolError('PATH_REQUIRED', `${label} 必须是绝对路径`, EXIT.BAD_ARGUMENTS);
  }
  if (!isAbsolute(value)) {
    throw new ToolError('PATH_NOT_ABSOLUTE', `${label} 必须是绝对路径：${value}`, EXIT.BAD_ARGUMENTS);
  }
  if (value.includes('\0')) {
    throw new ToolError('PATH_INVALID', `${label} 含非法字符`, EXIT.BAD_ARGUMENTS);
  }
  return resolve(value);
}

async function statOrNull(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/** 不跟随链接的存在性检查：悬空链接也必须视为已占用。 */
async function lexistsOrNull(path) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

/** 找到最近的已存在祖先（目标本身存在时就是目标），用于创建前的真实路径校验。 */
async function nearestExistingAncestor(absolute) {
  let current = absolute;
  for (;;) {
    const info = await statOrNull(current);
    if (info) return { path: current, info };
    const parent = dirname(current);
    if (parent === current) {
      throw new ToolError('PATH_NO_EXISTING_ANCESTOR', `找不到已存在的父目录：${absolute}`, EXIT.IO);
    }
    current = parent;
  }
}

async function authorizedRootReal() {
  try {
    return await realpath(AUTHORIZED_OUTPUT_ROOT);
  } catch (error) {
    throw new ToolError('OUT_ROOT_UNAVAILABLE', `授权工作区不可用：${AUTHORIZED_OUTPUT_ROOT}`, EXIT.IO, {
      reason: String(error?.message ?? error),
    });
  }
}

/**
 * 在创建任何目录之前校验：最近的已存在祖先解析真实路径后必须仍在授权工作区内。
 * 这样可在 mkdir 之前拒绝 `..`、盘符、符号链接/junction 越界。
 */
async function assertOutputWithinWorkspace(absolute) {
  const rootReal = await authorizedRootReal();
  const ancestor = await nearestExistingAncestor(absolute);
  let ancestorReal;
  try {
    ancestorReal = await realpath(ancestor.path);
  } catch (error) {
    throw new ToolError('OUT_REALPATH_FAILED', `无法解析输出路径的真实父目录：${ancestor.path}`, EXIT.IO, {
      reason: String(error?.message ?? error),
    });
  }
  if (!isWithinOrEqual(rootReal, ancestorReal)) {
    throw new ToolError(
      'OUT_OUTSIDE_WORKSPACE',
      `输出目录必须位于授权工作区内：${rootReal}`,
      EXIT.IO,
      {
        authorizedRoot: rootReal,
        requested: absolute,
        nearestExistingParent: ancestor.path,
        resolvedParent: ancestorReal,
      },
    );
  }
  return rootReal;
}

/** 只读输入：必须存在、是普通文件、可读。返回真实路径（已解析软链接）。 */
export async function resolveInputFile(label, value) {
  const absolute = assertAbsolute(label, value);
  const info = await statOrNull(absolute);
  if (!info) {
    throw new ToolError('INPUT_MISSING', `${label} 不存在：${absolute}`, EXIT.IO);
  }
  if (!info.isFile()) {
    throw new ToolError('INPUT_NOT_FILE', `${label} 不是文件：${absolute}`, EXIT.IO);
  }
  try {
    await access(absolute, constants.R_OK);
  } catch {
    throw new ToolError('INPUT_UNREADABLE', `${label} 不可读：${absolute}`, EXIT.IO);
  }
  return { path: absolute, realPath: await realpath(absolute), size: info.size };
}

/**
 * 输出目录：允许不存在则创建；已存在必须是目录且可写。
 * 创建前先验证最近已存在父目录的真实路径，创建后再次验证最终真实路径。
 * 授权根本身、其合法子目录均允许；明确拒绝工作区外路径。
 */
export async function prepareOutDir(value) {
  const absolute = assertAbsolute('--out', value);
  const rootReal = await assertOutputWithinWorkspace(absolute);

  const info = await statOrNull(absolute);
  if (info && !info.isDirectory()) {
    throw new ToolError('OUT_NOT_DIR', `--out 指向的不是目录：${absolute}`, EXIT.IO);
  }
  if (!info) {
    try {
      await mkdir(absolute, { recursive: true });
    } catch (error) {
      throw new ToolError('OUT_CREATE_FAILED', `无法创建输出目录：${absolute}`, EXIT.IO, {
        reason: String(error?.message ?? error),
      });
    }
  }

  let realPath;
  try {
    realPath = await realpath(absolute);
  } catch (error) {
    throw new ToolError('OUT_REALPATH_FAILED', `无法解析输出目录真实路径：${absolute}`, EXIT.IO, {
      reason: String(error?.message ?? error),
    });
  }
  if (!isWithinOrEqual(rootReal, realPath)) {
    throw new ToolError('OUT_OUTSIDE_WORKSPACE', `输出目录创建后不在授权工作区内：${realPath}`, EXIT.IO, {
      authorizedRoot: rootReal,
      requested: absolute,
      realPath,
    });
  }

  try {
    await access(realPath, constants.W_OK);
  } catch {
    throw new ToolError('OUT_UNWRITABLE', `输出目录不可写：${realPath}`, EXIT.IO);
  }
  return { path: absolute, realPath, authorizedRootReal: rootReal };
}

/** 禁止覆盖：目标已存在（含悬空链接/junction）直接失败，并说明该文件属于谁。 */
export async function assertCreatable(absolutePath) {
  const info = await lexistsOrNull(absolutePath);
  if (info) {
    throw new ToolError('OUTPUT_EXISTS', `拒绝覆盖已存在的文件：${absolutePath}`, EXIT.IO);
  }
  return absolutePath;
}

/**
 * 解析输出目录内的相对路径：拒绝绝对路径、盘符、`..`、Windows 保留名；
 * 在任何 mkdir 之前校验最近已存在父目录的真实路径，创建后再次校验。
 */
export async function resolveOutFile(outDirReal, relPath, authorizedRootReal = null) {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new ToolError('OUTPUT_NAME_EMPTY', '输出文件名不能为空', EXIT.BAD_ARGUMENTS);
  }
  if (isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) {
    throw new ToolError('OUTPUT_NAME_ABSOLUTE', `输出路径必须是相对路径：${relPath}`, EXIT.BAD_ARGUMENTS);
  }
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    throw new ToolError('OUTPUT_NAME_TRAVERSAL', `输出路径不允许 . 或 ..：${relPath}`, EXIT.BAD_ARGUMENTS);
  }
  for (const part of normalized.split('/')) {
    if (WIN_RESERVED.test(part)) {
      throw new ToolError('OUTPUT_NAME_RESERVED', `Windows 保留名不可作为输出：${part}`, EXIT.BAD_ARGUMENTS);
    }
  }

  const target = join(outDirReal, normalized);
  const ancestor = await nearestExistingAncestor(target);
  const ancestorReal = await realpath(ancestor.path);
  if (!isWithinOrEqual(outDirReal, ancestorReal)) {
    throw new ToolError('OUTPUT_ESCAPE', `输出路径越界：${relPath}`, EXIT.IO, {
      outDir: outDirReal,
      nearestExistingParent: ancestor.path,
      resolvedParent: ancestorReal,
    });
  }
  if (authorizedRootReal !== null && !isWithinOrEqual(authorizedRootReal, ancestorReal)) {
    throw new ToolError('OUT_OUTSIDE_WORKSPACE', `输出路径不在授权工作区内：${relPath}`, EXIT.IO, {
      authorizedRoot: authorizedRootReal,
      resolved: ancestorReal,
    });
  }

  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const parentReal = await realpath(parent);
  if (!isWithinOrEqual(outDirReal, parentReal)) {
    throw new ToolError('OUTPUT_ESCAPE', `输出路径创建后越界：${relPath}`, EXIT.IO, {
      outDir: outDirReal,
      parentReal,
    });
  }
  if (authorizedRootReal !== null && !isWithinOrEqual(authorizedRootReal, parentReal)) {
    throw new ToolError('OUT_OUTSIDE_WORKSPACE', `输出路径创建后不在授权工作区内：${relPath}`, EXIT.IO, {
      authorizedRoot: authorizedRootReal,
      parentReal,
    });
  }
  const absolute = join(parentReal, basename(target));
  if (authorizedRootReal !== null && !isWithinOrEqual(authorizedRootReal, absolute)) {
    throw new ToolError('OUT_OUTSIDE_WORKSPACE', `输出目标不在授权工作区内：${absolute}`, EXIT.IO, {
      authorizedRoot: authorizedRootReal,
    });
  }
  return { absolute, normalized };
}

export async function writeNewFile(absolutePath, data) {
  await assertCreatable(absolutePath);
  await writeFile(absolutePath, data, { flag: 'wx' });
  return absolutePath;
}

export function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolvePromise(hash.digest('hex').toUpperCase()));
  });
}

export function modelRootOf(filePath) {
  return dirname(filePath);
}

export function sepOf() {
  return sep;
}
