// 一次性隔离运行环境：写请求 → 启动 Electron → 读结果 → 清理。
// 约束：只管理自己 spawn 的子进程；不枚举、不结束任何其他进程；不接触游戏存档。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ToolError, EXIT } from './schema.mjs';
import { validateTaskResult } from './contract.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const MAIN_CJS = join(here, '..', 'runner', 'main.cjs');

let runCount = 0;

export function renderRunCount() {
  return runCount;
}

function electronBinary() {
  let binary;
  try {
    binary = require('electron');
  } catch (error) {
    throw new ToolError('ELECTRON_MISSING', '项目未安装 electron，无法执行渲染任务', EXIT.UNSUPPORTED, {
      reason: String(error?.message ?? error),
    });
  }
  if (typeof binary !== 'string' || !existsSync(binary)) {
    throw new ToolError('ELECTRON_BINARY', '找不到 electron 可执行文件', EXIT.UNSUPPORTED, { binary });
  }
  return binary;
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => {});
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    /* 清理失败不应掩盖主结果 */
  }
}

/**
 * @param {{request: object, timeoutMs?: number}} options
 * @returns {Promise<{result: ReturnType<typeof validateTaskResult>, durationMs: number, runIndex: number, stderrTail: string}>}
 */
export async function runRendererTask({ request, timeoutMs = 180000 }) {
  const binary = electronBinary();
  const tempRoot = await mkdtemp(join(tmpdir(), 'model-tool-'));
  const requestPath = join(tempRoot, 'request.json');
  const resultPath = join(tempRoot, 'result.json');
  await writeFile(requestPath, JSON.stringify(request), 'utf8');
  runCount += 1;
  const runIndex = runCount;
  const startedAt = Date.now();
  const stderrChunks = [];
  let stderrBytes = 0;

  const child = spawn(binary, [MAIN_CJS, '--request', requestPath, '--result', resultPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      MODEL_TOOL_TEMP: tempRoot,
    },
  });

  child.stderr?.on('data', (chunk) => {
    if (stderrBytes > 8192) return;
    const text = chunk.toString('utf8');
    stderrBytes += text.length;
    stderrChunks.push(text);
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, Math.max(1000, timeoutMs));

  const exit = await new Promise((resolvePromise) => {
    child.on('error', (error) => resolvePromise({ error }));
    child.on('exit', (code, signal) => resolvePromise({ code, signal }));
  });
  clearTimeout(timer);
  const durationMs = Date.now() - startedAt;
  const stderrTail = stderrChunks.join('').slice(-8000);

  if (timedOut) {
    await rm(tempRoot, { recursive: true, force: true });
    throw new ToolError('RENDER_TIMEOUT', `渲染任务超过 ${timeoutMs} ms 未结束，已终止本次子进程`, EXIT.FAILED, {
      runIndex,
      durationMs,
      stderrTail,
    });
  }
  if (exit.error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw new ToolError('RENDER_SPAWN', '无法启动 Electron 渲染进程', EXIT.FAILED, {
      reason: String(exit.error?.message ?? exit.error),
      runIndex,
    });
  }

  let raw;
  try {
    raw = await readFile(resultPath, 'utf8');
  } catch {
    await rm(tempRoot, { recursive: true, force: true });
    throw new ToolError('RENDER_NO_RESULT', '渲染进程未产生结果文件（可能启动失败或崩溃）', EXIT.FAILED, {
      exitCode: exit.code,
      signal: exit.signal,
      durationMs,
      stderrTail,
    });
  }

  await rm(tempRoot, { recursive: true, force: true });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ToolError('RENDER_BAD_RESULT', '渲染进程结果不是合法 JSON', EXIT.FAILED, {
      reason: String(error?.message ?? error),
    });
  }
  return { result: validateTaskResult(parsed), durationMs, runIndex, stderrTail };
}
