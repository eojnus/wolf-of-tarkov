'use strict';

/**
 * Electron 主进程：窗口、应用生命周期、受限本地资源协议与最小桌面能力。
 *
 * 这里不包含任何游戏规则，也不向渲染进程暴露 Node.js。渲染进程只能通过
 * preload.cjs 暴露的「关闭前等待」回调与主进程通信。
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, session, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const PRODUCT_NAME = '塔科夫之狼';
const APP_ID = 'com.wolfoftarkov.desktop';
const APP_SCHEME = 'app';
const APP_HOST = 'game';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const DEV_URL = 'http://127.0.0.1:5173/';
const DEV_USER_DATA = 'WolfOfTarkov-dev';
const PROD_USER_DATA = 'WolfOfTarkov';
const DIST_ROOT = path.join(__dirname, '..', 'dist');
const CLOSE_TIMEOUT_MS = 4000;

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob:",
  "media-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' blob: ws://127.0.0.1:5173`,
  "media-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.gltf', 'model/gltf+json'],
  ['.glb', 'model/gltf-binary'],
  ['.usdz', 'model/vnd.usdz+zip'],
  ['.bin', 'application/octet-stream'],
  ['.wasm', 'application/wasm'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.ktx2', 'image/ktx2'],
  ['.hdr', 'application/octet-stream'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
]);

/** @type {string | null} */
let devUrl = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
let closeState = 'idle';
/** @type {NodeJS.Timeout | null} */
let closeTimer = null;

function resolveDevUrl(raw) {
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '5173' || url.pathname !== '/') {
    throw new Error('WOLF_DEV_SERVER_URL 只允许 http://127.0.0.1:5173/');
  }
  return DEV_URL;
}

try {
  devUrl = resolveDevUrl(process.env.WOLF_DEV_SERVER_URL);
} catch (error) {
  dialog.showErrorBox('开发服务器地址无效', String(error));
  app.exit(1);
}

/* 固定应用身份与用户数据位置；开发与生产使用不同目录。 */
app.setName('WolfOfTarkov');
app.setAppUserModelId(APP_ID);
app.setPath(
  'userData',
  path.join(app.getPath('appData'), devUrl ? DEV_USER_DATA : PROD_USER_DATA),
);

const logFile = path.join(app.getPath('userData'), 'desktop.log');

function log(message) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    /* 日志失败不能影响游戏启动 */
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

function mimeTypeOf(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

function responseHeaders(filePath, size) {
  return {
    'Content-Type': mimeTypeOf(filePath),
    'Content-Length': String(size),
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': PROD_CSP,
  };
}

/** 解析并校验 app://game/ 请求；拒绝目录穿越、目录外访问和非只读方法。 */
async function handleAppRequest(request) {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    const url = new URL(request.url);
    if (url.protocol !== `${APP_SCHEME}:` || url.hostname !== APP_HOST) {
      return new Response('Not Found', { status: 404 });
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    if (pathname.includes('\0') || pathname.includes('\\')) {
      return new Response('Bad Request', { status: 400 });
    }
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    const segments = pathname.split('/').filter((segment) => segment.length > 0);
    if (segments.some((segment) => segment === '.' || segment === '..')) {
      return new Response('Bad Request', { status: 400 });
    }

    const filePath = path.join(DIST_ROOT, ...segments);
    const relative = path.relative(DIST_ROOT, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return new Response('Forbidden', { status: 403 });
    }

    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return new Response('Not Found', { status: 404 });

    const data = await fsp.readFile(filePath);
    return new Response(request.method === 'HEAD' ? null : data, {
      status: 200,
      headers: responseHeaders(filePath, data.byteLength),
    });
  } catch (error) {
    log(`app protocol error: ${request.url} ${String(error)}`);
    return new Response('Not Found', { status: 404 });
  }
}

function isAllowedNavigation(targetUrl) {
  try {
    const url = new URL(targetUrl);
    if (devUrl) {
      return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === '5173';
    }
    return url.protocol === `${APP_SCHEME}:` && url.hostname === APP_HOST;
  } catch {
    return false;
  }
}

function isTrustedContents(webContents) {
  if (!mainWindow || !webContents || webContents !== mainWindow.webContents) return false;
  return isAllowedNavigation(webContents.getURL());
}

function configureSession() {
  const current = session.defaultSession;

  // 默认拒绝全部权限；唯一例外是游戏视角所需的 pointerLock，且只允许主窗口与固定来源。
  current.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = permission === 'pointerLock' && isTrustedContents(webContents);
    if (!allowed) log(`denied permission request: ${permission}`);
    callback(allowed);
  });
  current.setPermissionCheckHandler((webContents, permission) => {
    const allowed = permission === 'pointerLock' && isTrustedContents(webContents);
    if (!allowed) log(`denied permission check: ${permission}`);
    return allowed;
  });

  current.on('will-download', (_event, item) => {
    const fileName = path.basename(item.getFilename());
    item.setSaveDialogOptions({
      title: '保存游戏存档 JSON',
      defaultPath: path.join(app.getPath('documents'), fileName),
    });
  });

  if (devUrl) {
    current.webRequest.onHeadersReceived(
      { urls: [DEV_URL] },
      (details, callback) => {
        const headers = { ...(details.responseHeaders ?? {}) };
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'content-security-policy') delete headers[key];
        }
        headers['Content-Security-Policy'] = [DEV_CSP];
        callback({ responseHeaders: headers });
      },
    );
  }
}

function showAbout(window) {
  const detail = [
    `版本：${app.getVersion()}`,
    `Electron：${process.versions.electron}`,
    `Chromium：${process.versions.chrome}`,
    '',
    `用户数据目录：${app.getPath('userData')}`,
    '',
    '桌面版与浏览器版使用独立的本地存储，不会自动共享进度。',
    '迁移请使用游戏内「导出 JSON」与「导入 JSON」。',
    '卸载程序默认保留此目录；需要彻底清理时请手动删除。',
  ].join('\n');
  void dialog.showMessageBox(window, {
    type: 'info',
    title: `关于${PRODUCT_NAME}`,
    message: `${PRODUCT_NAME} ${app.getVersion()}`,
    detail,
    buttons: ['确定'],
    noLink: true,
  });
}

function buildMenu(window) {
  const template = [
    {
      label: '视图',
      submenu: [
        {
          label: '切换全屏',
          accelerator: 'F11',
          click: () => window.setFullScreen(!window.isFullScreen()),
        },
        { role: 'minimize', label: '最小化' },
        ...(devUrl
          ? [
              { type: 'separator' },
              { role: 'toggleDevTools', label: '开发者工具', accelerator: 'F12' },
            ]
          : []),
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: `关于${PRODUCT_NAME}`, click: () => showAbout(window) },
        {
          label: '打开用户数据目录',
          click: () => {
            void shell.openPath(app.getPath('userData')).then((error) => {
              if (error) log(`failed to open user data directory: ${error}`);
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function finishClose() {
  if (closeState === 'done') return;
  closeState = 'done';
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
}

function createWindow() {
  const window = new BrowserWindow({
    title: PRODUCT_NAME,
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    useContentSize: true,
    show: false,
    backgroundColor: '#0f1720',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
      backgroundThrottling: true,
    },
  });
  mainWindow = window;

  window.once('ready-to-show', () => window.show());

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedNavigation(targetUrl)) {
      event.preventDefault();
      log(`blocked navigation: ${targetUrl}`);
    }
  });
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
    log('blocked webview attach');
  });

  // 不依赖菜单栏是否可见或窗口焦点路径：F11 由主进程直接处理，且阻止页面收到该键。
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11' && !input.isAutoRepeat) {
      event.preventDefault();
      window.setFullScreen(!window.isFullScreen());
    }
  });

  window.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => {
    if (code === -3) return;
    const message = `无法加载游戏页面（${code} ${description}）\n${validatedUrl}\n\n请查看日志：${logFile}`;
    log(message);
    void dialog.showMessageBox(window, {
      type: 'error',
      title: '启动失败',
      message: '无法加载游戏页面',
      detail: message,
      buttons: ['退出'],
      noLink: true,
    }).then(() => app.quit());
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    const message = `渲染进程异常退出：${details.reason}（exitCode ${details.exitCode}）\n日志：${logFile}`;
    log(message);
    void dialog.showMessageBox(window, {
      type: 'error',
      title: '运行异常',
      message: '游戏进程异常退出',
      detail: message,
      buttons: ['退出'],
      noLink: true,
    }).then(() => app.quit());
  });

  window.on('close', (event) => {
    if (closeState === 'done') return;
    event.preventDefault();
    if (closeState === 'waiting') return;
    closeState = 'waiting';
    try {
      window.webContents.send('desktop:before-close');
    } catch (error) {
      log(`failed to notify renderer before close: ${String(error)}`);
      finishClose();
      return;
    }
    closeTimer = setTimeout(() => {
      log('renderer did not acknowledge close within timeout');
      finishClose();
    }, CLOSE_TIMEOUT_MS);
  });

  window.on('closed', () => {
    mainWindow = null;
  });

  buildMenu(window);

  if (devUrl) {
    void window.loadURL(devUrl);
  } else {
    const entry = path.join(DIST_ROOT, 'index.html');
    if (!fs.existsSync(entry)) {
      const message = `未找到生产构建产物：${entry}\n请先执行 npm run build。`;
      log(message);
      void dialog.showMessageBox({
        type: 'error',
        title: '缺少构建产物',
        message: '无法启动游戏',
        detail: message,
        buttons: ['退出'],
        noLink: true,
      }).then(() => app.quit());
      return;
    }
    void window.loadURL(`${APP_ORIGIN}/index.html`);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    log(`starting ${app.getVersion()} packaged=${app.isPackaged} dev=${Boolean(devUrl)}`);
    protocol.handle(APP_SCHEME, handleAppRequest);
    configureSession();

    ipcMain.on('desktop:close-ready', (event) => {
      if (closeState !== 'waiting' || !mainWindow) return;
      if (event.sender !== mainWindow.webContents) return;
      finishClose();
    });

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
