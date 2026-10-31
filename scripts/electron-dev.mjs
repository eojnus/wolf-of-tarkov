/**
 * Electron 开发启动器。
 *
 * 1. 只用固定的本机地址 127.0.0.1:5173，并校验响应确实是本项目的 Vite 页面；
 * 2. Vite 未就绪时不启动 Electron，端口被其他服务占用时直接失败；
 * 3. Electron 退出或脚本被中断时，结束本次启动的 Vite 进程树，不遗留后台进程。
 */

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const port = 5173;
const devUrl = `http://127.0.0.1:${port}/`;
const READY_TIMEOUT_MS = 60_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function isOurViteServer() {
  try {
    const response = await fetch(devUrl, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const html = await response.text();
    return html.includes('/src/main.ts');
  } catch {
    return false;
  }
}

function stopProcessTree(child) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

let electron = null;
let vite = null;
let exiting = false;

function shutdown(code) {
  if (exiting) return;
  exiting = true;
  stopProcessTree(electron);
  stopProcessTree(vite);
  process.exit(code);
}

async function main() {
  if (await isOurViteServer()) {
    console.error(
      `[desktop] 127.0.0.1:${port} 已有本项目的 Vite 服务在运行。请先停止它，避免开发实例使用未知来源。`,
    );
    process.exit(1);
  }

  vite = spawn(
    process.execPath,
    [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, FORCE_COLOR: '1' },
    },
  );

  vite.on('error', (error) => {
    console.error(`[desktop] 无法启动 Vite：${String(error)}`);
    shutdown(1);
  });

  vite.on('exit', (code) => {
    if (exiting) return;
    console.error(`[desktop] Vite 已退出（code ${code ?? 'null'}），不启动 Electron。`);
    shutdown(code ?? 1);
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) break;
    if (await isOurViteServer()) {
      ready = true;
      break;
    }
    await delay(300);
  }

  if (!ready) {
    console.error(`[desktop] 等待 ${devUrl} 超时，未启动 Electron。`);
    shutdown(1);
    return;
  }

  const electronPath = require('electron');
  electron = spawn(electronPath, ['.'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, WOLF_DEV_SERVER_URL: devUrl },
  });

  electron.on('error', (error) => {
    console.error(`[desktop] 无法启动 Electron：${String(error)}`);
    shutdown(1);
  });

  electron.on('exit', (code) => {
    shutdown(code ?? 0);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (error) => {
  console.error(`[desktop] ${String(error)}`);
  shutdown(1);
});

void main();
