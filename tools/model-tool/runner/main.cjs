// 模型工具的 Electron 主进程：一次性、隔离、无单实例锁、不接触游戏进程。
// 职责：注册受限虚拟协议 → 打开隐藏窗口 → 收渲染结果 → 写文件 → 退出。
'use strict';

const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const { readFile, writeFile, mkdir, realpath, stat, lstat } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const path = require('node:path');

const BUILD_DIR = path.join(__dirname, '..', '.build');
const TEMP_ROOT = process.env.MODEL_TOOL_TEMP || require('node:os').tmpdir();

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1];
}

const requestPath = argValue('--request');
const resultPath = argValue('--result');

if (!requestPath || !resultPath) {
  // 到这里说明不是本工具调用的，直接失败，不弹窗。
  console.error('model-tool runner: 缺少 --request/--result');
  process.exit(2);
}

// 独立用户数据目录：绝不读写游戏或玩家的 userData。
app.setPath('userData', path.join(TEMP_ROOT, 'userdata'));
app.setPath('sessionData', path.join(TEMP_ROOT, 'userdata'));

if (process.env.MODEL_TOOL_SOFTWARE_GL === '1') {
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
}
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-background-networking');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'modeltool',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ktx2', 'image/ktx2'],
  ['.bin', 'application/octet-stream'],
  ['.glb', 'model/gltf-binary'],
  ['.gltf', 'model/gltf+json'],
  ['.usdz', 'model/vnd.usdz+zip'],
  ['.usd', 'model/vnd.usd'],
  ['.usda', 'model/vnd.usda'],
  ['.usdc', 'application/octet-stream'],
  ['.hdr', 'image/vnd.radiance'],
  ['.wasm', 'application/wasm'],
  ['.woff2', 'font/woff2'],
]);

function decodePath(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function isWithinOrEqual(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** 最近的已存在祖先（目标存在时即目标）。用于 mkdir 前的链接/越界检查。 */
async function nearestExistingAncestor(absolute) {
  let current = absolute;
  for (;;) {
    const info = await stat(current).catch(() => null);
    if (info) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function assertInsideAuthorized(absolute, label) {
  const authorized = state.authorizedRootReal;
  const outRoot = state.outRootReal;
  if (!authorized || !outRoot) throw new Error('输出根尚未初始化');
  const ancestor = await nearestExistingAncestor(absolute);
  if (!ancestor) throw new Error(`找不到可验证的父目录：${label}`);
  const ancestorReal = await realpath(ancestor);
  if (!isWithinOrEqual(authorized, ancestorReal)) {
    throw new Error(`输出路径不在授权工作区内：${label}`);
  }
  if (!isWithinOrEqual(outRoot, ancestorReal)) {
    throw new Error(`输出路径越界：${label}`);
  }
  return ancestorReal;
}

/** 逐层校验：拒绝 ..、盘符、空段；解析真实路径并确认仍在 root 内。 */
async function safeResolve(rootReal, relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter((part) => part !== '');
  if (parts.length === 0) return null;
  for (const part of parts) {
    if (part === '.' || part === '..' || /^[a-zA-Z]:/.test(part)) return null;
  }
  const target = path.join(rootReal, ...parts);
  let real;
  try {
    real = await realpath(target);
  } catch {
    return null;
  }
  const rel = path.relative(rootReal, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const info = await stat(real).catch(() => null);
  if (!info || !info.isFile()) return null;
  return real;
}

function responseFor(buffer, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return new Response(buffer, {
    status: 200,
    headers: {
      'content-type': MIME.get(ext) || 'application/octet-stream',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

async function handleProtocol(request) {
  const url = new URL(request.url);
  if (url.protocol !== 'modeltool:') return new Response('bad scheme', { status: 400 });

  const route = state.route;
  const pathname = decodePath(url.pathname);
  if (pathname === null) return new Response('bad path', { status: 400 });

  try {
    if (url.host === 'app') {
      const rootReal = await realpath(BUILD_DIR);
      if (pathname === '/' || pathname === '') {
        return responseFor(await readFile(path.join(rootReal, 'index.html')), 'index.html');
      }
      // /assets/… 映射到项目 public/assets，供真实角色模块按原相对路径加载。
      if (pathname.startsWith('/assets/')) {
        const assetsRoot = await realpath(path.join(route.projectRoot, 'public', 'assets'));
        const real = await safeResolve(assetsRoot, pathname.slice('/assets/'.length));
        if (!real) return new Response('not found', { status: 404 });
        return responseFor(await readFile(real), real);
      }
      const real = await safeResolve(rootReal, pathname.slice(1));
      if (!real) return new Response('not found', { status: 404 });
      return responseFor(await readFile(real), real);
    }

    if (url.host === 'input') {
      if (!route.allowedRoot) return new Response('no input root', { status: 403 });
      const rootReal = await realpath(route.allowedRoot);
      const real = await safeResolve(rootReal, pathname.slice(1));
      if (!real) return new Response('not found', { status: 404 });
      return responseFor(await readFile(real), real);
    }
  } catch (error) {
    return new Response(`protocol error: ${String(error && error.message ? error.message : error)}`, {
      status: 500,
    });
  }
  return new Response('unknown host', { status: 404 });
}

const state = {
  route: { projectRoot: '', allowedRoot: null, outDir: '' },
  authorizedRootReal: null,
  outRootReal: null,
  finished: false,
  writes: [],
};

async function writeResult(payload) {
  if (state.finished) return;
  state.finished = true;
  const body = JSON.stringify(payload);
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, body, 'utf8');
}

async function finishWithError(code, message, details) {
  await writeResult({
    status: 'error',
    data: null,
    diagnostics: [],
    outputs: state.writes,
    error: { code, message, exitCode: 5, details: details || null },
    metadata: {},
  });
  app.exit(0);
}

async function bootstrap() {
  const raw = await readFile(requestPath, 'utf8');
  const request = JSON.parse(raw);
  if (
    typeof request.authorizedRoot !== 'string' ||
    typeof request.outDir !== 'string' ||
    typeof request.projectRoot !== 'string'
  ) {
    throw new Error('请求缺少 authorizedRoot/outDir/projectRoot');
  }
  const authorizedRootReal = await realpath(request.authorizedRoot);
  const outRootReal = await realpath(request.outDir);
  if (!isWithinOrEqual(authorizedRootReal, outRootReal)) {
    throw new Error(`输出目录不在授权工作区内：${outRootReal}`);
  }
  state.authorizedRootReal = authorizedRootReal;
  state.outRootReal = outRootReal;
  state.route = {
    projectRoot: request.projectRoot,
    allowedRoot: request.allowedRoot,
    outDir: outRootReal,
  };

  ipcMain.handle('model-tool:write', async (_event, payload) => {
    const relPath = String(payload && payload.relPath ? payload.relPath : '');
    const encoding = payload && payload.encoding === 'base64' ? 'base64' : 'utf8';
    const data = payload && typeof payload.data === 'string' ? payload.data : null;
    if (!relPath || data === null) {
      throw new Error('写文件请求缺少 relPath/data');
    }
    const normalized = relPath.replace(/\\/g, '/');
    const parts = normalized.split('/').filter((part) => part !== '');
    if (
      parts.length === 0 ||
      parts.some((part) => part === '.' || part === '..' || /^[a-zA-Z]:/.test(part))
    ) {
      throw new Error(`非法输出路径：${relPath}`);
    }

    const target = path.join(state.outRootReal, ...parts);
    // 创建任何目录之前，先按最近的已存在祖先解析真实路径。
    await assertInsideAuthorized(target, relPath);
    const parent = path.dirname(target);
    await mkdir(parent, { recursive: true });
    const parentReal = await realpath(parent);
    if (!isWithinOrEqual(state.authorizedRootReal, parentReal)) {
      throw new Error(`输出路径创建后不在授权工作区内：${relPath}`);
    }
    if (!isWithinOrEqual(state.outRootReal, parentReal)) {
      throw new Error(`输出路径创建后越界：${relPath}`);
    }
    const absolute = path.join(parentReal, path.basename(target));
    if (!isWithinOrEqual(state.authorizedRootReal, absolute)) {
      throw new Error(`输出目标不在授权工作区内：${relPath}`);
    }
    const existing = await lstat(absolute).catch(() => null);
    if (existing) {
      throw new Error(`拒绝覆盖已存在的文件：${path.basename(target)}`);
    }
    await writeFile(absolute, Buffer.from(data, encoding), { flag: 'wx' });
    const sha256 = createHash('sha256')
      .update(Buffer.from(data, encoding))
      .digest('hex')
      .toUpperCase();
    state.writes.push({ path: absolute, type: encoding === 'base64' ? 'binary' : 'text', sha256 });
    return { path: absolute, sha256 };
  });

  ipcMain.handle('model-tool:submit', async (_event, payload) => {
    const result = payload && typeof payload === 'object' ? payload : null;
    if (!result) {
      await finishWithError('RENDER_RESULT_MISSING', '渲染页提交了空结果');
      return { ok: false };
    }
    await writeResult({ ...result, outputs: state.writes });
    setTimeout(() => app.exit(0), 10);
    return { ok: true };
  });

  await app.whenReady();

  protocol.handle('modeltool', handleProtocol);

  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 1200,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  window.webContents.on('render-process-gone', async (_event, details) => {
    await finishWithError('RENDER_CRASH', '渲染进程异常退出', details);
  });
  window.webContents.on('did-fail-load', async (_event, errorCode, errorDescription) => {
    await finishWithError('RENDER_LOAD_FAILED', '渲染页加载失败', { errorCode, errorDescription });
  });

  const query = encodeURIComponent(raw);
  await window.loadURL(`modeltool://app/index.html?request=${query}`);
  // 等待渲染页通过 IPC 提交结果；超时由 CLI 侧终止整个子进程。
  app.on('window-all-closed', () => {});
}

bootstrap().catch(async (error) => {
  await finishWithError('RUNNER_BOOTSTRAP', '工具主进程启动失败', {
    reason: String(error && error.stack ? error.stack : error),
  });
});
