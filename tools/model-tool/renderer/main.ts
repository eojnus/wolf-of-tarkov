// 隔离渲染进程入口：读请求 → 建唯一的 WebGL 帧 → 跑任务 → 交结果。
// 没有通用文件/命令能力；写文件只能落到 CLI 指定的输出目录。
import * as THREE from 'three';
import {
  TaskError,
  applyDefaultLights,
  type Diagnostic,
  type LoadedAsset,
  type RenderFrame,
  type Task,
  type TaskOutput,
  type TaskTools,
  type ToolRequest,
} from './api';
import { loadAssetFromInput } from './load';
import { inspectTask } from './inspect';
import { snapshotTask } from './render';
import { animationEditTask } from './animation';
import { retargetTask } from './retarget';
import { characterTask } from '../adapters/game-character';
import { collisionTask } from '../adapters/game-collision';
import { runtimeCollisionTask } from '../adapters/runtime-collision';

interface WriteBridge {
  submit(result: unknown): Promise<{ ok: boolean }>;
  write(payload: {
    relPath: string;
    encoding: 'base64' | 'utf8';
    data: string;
  }): Promise<{ path: string; sha256: string }>;
}

declare global {
  interface Window {
    modelTool?: WriteBridge;
  }
}

const TASKS: Record<string, Task> = {
  inspect: inspectTask,
  snapshot: snapshotTask,
  'snapshot-game-character': characterTask,
  'animation-edit': animationEditTask,
  retarget: retargetTask,
  collision: collisionTask,
  'collision-snapshot': runtimeCollisionTask,
};

/**
 * CSP 拦截记录。
 *
 * 资源请求被内容安全策略拒绝时，加载器只拿到一个泛化的失败（例如 blob: URL），
 * 无法说明原因。这里记录浏览器给的 `violatedDirective`，让报告能区分
 * 「资源不存在/损坏」与「被本工具的 CSP 拒绝」，而不是靠猜。
 */
interface CspViolation {
  readonly directive: string;
  readonly blockedURI: string;
}

const cspViolations: CspViolation[] = [];
const MAX_CSP_VIOLATIONS = 50;

window.addEventListener('securitypolicyviolation', (event) => {
  if (cspViolations.length >= MAX_CSP_VIOLATIONS) return;
  cspViolations.push({
    directive: event.violatedDirective || event.effectiveDirective || '(未提供)',
    blockedURI: event.blockedURI || '(未提供)',
  });
});

function cspDiagnostics(): Diagnostic[] {
  if (cspViolations.length === 0) return [];
  const directives = [...new Set(cspViolations.map((item) => item.directive))];
  const blockedUris = [...new Set(cspViolations.map((item) => item.blockedURI))].slice(0, 8);
  return [
    {
      code: 'CSP_BLOCKED',
      severity: 'error',
      message: `内容安全策略阻止了 ${cspViolations.length} 个请求（${directives.join('; ')}）；这些资源没有加载`,
      details: {
        count: cspViolations.length,
        directives,
        blockedUriSamples: blockedUris,
        note: '这不是资源本身缺失，而是本工具页面的 CSP 不允许该请求；报告应视为资源不完整',
      },
    },
  ];
}

function parseRequest(): ToolRequest {
  const raw = new URLSearchParams(window.location.search).get('request');
  if (!raw) throw new TaskError('REQUEST_MISSING', '渲染页没有收到请求', 2);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TaskError('REQUEST_JSON', '请求不是合法 JSON', 2, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return parsed as ToolRequest;
}

function backendFrom(gl: WebGLRenderingContext | WebGL2RenderingContext): {
  vendor: string | null;
  renderer: string | null;
  version: string | null;
} {
  try {
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : null,
      renderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
      version: String(gl.getParameter(gl.VERSION)),
    };
  } catch {
    return { vendor: null, renderer: null, version: null };
  }
}

async function runTask(request: ToolRequest): Promise<{
  status: 'ok' | 'partial' | 'error';
  data: Record<string, unknown> | null;
  diagnostics: Diagnostic[];
  error: { code: string; message: string; exitCode: number; details?: unknown } | null;
  metadata: Record<string, unknown>;
}> {
  const diagnostics: Diagnostic[] = [];
  const bridge = window.modelTool;
  if (!bridge) throw new TaskError('BRIDGE_MISSING', '渲染页未拿到受限写文件通道', 5);

  const cache = new Map<string, LoadedAsset>();
  let framePromise: Promise<RenderFrame> | null = null;
  let backend: { vendor: string | null; renderer: string | null; version: string | null } | null = null;

  const load = async (input?: string): Promise<LoadedAsset> => {
    const target = input ?? request.input;
    if (!target) throw new TaskError('INPUT_REQUIRED', '该任务需要模型输入', 2);
    const cached = cache.get(target);
    if (cached) return cached;
    const asset = await loadAssetFromInput(target);
    cache.set(target, asset);
    return asset;
  };

  const getFrame = async (width = 800, height = 1000): Promise<RenderFrame> => {
    if (framePromise) return framePromise;
    framePromise = (async () => {
      const canvas = document.createElement('canvas');
      const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: false,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance',
      });
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.shadowMap.enabled = false;
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 4000);
      const gl = renderer.getContext();
      backend = backendFrom(gl);
      return {
        scene,
        camera,
        renderer,
        width,
        height,
        async capture() {
          renderer.render(scene, camera);
          const url = canvas.toDataURL('image/png');
          const comma = url.indexOf(',');
          if (comma < 0) throw new TaskError('CAPTURE_FAILED', 'canvas 未产生 PNG 数据', 5);
          return url.slice(comma + 1);
        },
        setBackground(hex: number) {
          scene.background = new THREE.Color(hex);
        },
        useDefaultLights() {
          applyDefaultLights(scene);
        },
        backendInfo() {
          return backend ?? { vendor: null, renderer: null, version: null };
        },
      } satisfies RenderFrame;
    })();
    return framePromise;
  };

  const tools: TaskTools = {
    load,
    frame: getFrame,
    async writePng(relPath, base64) {
      const result = await bridge.write({ relPath, encoding: 'base64', data: base64 });
      return result.path;
    },
    async writeBinary(relPath, base64) {
      const result = await bridge.write({ relPath, encoding: 'base64', data: base64 });
      return result.path;
    },
    async writeText(relPath, text) {
      const result = await bridge.write({ relPath, encoding: 'utf8', data: text });
      return result.path;
    },
    async readSibling(relPath) {
      const encoded = relPath
        .replace(/\\/g, '/')
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/');
      const response = await fetch(`modeltool://input/${encoded}`);
      if (!response.ok) {
        throw new TaskError('SIBLING_READ_FAILED', `无法读取输入旁文件：${relPath}`, 4, {
          status: response.status,
        });
      }
      return response.text();
    },
    diagnostics,
    info(code, message, details) {
      diagnostics.push({ code, severity: 'info', message, ...(details ? { details } : {}) });
    },
    warn(code, message, details) {
      diagnostics.push({ code, severity: 'warning', message, ...(details ? { details } : {}) });
    },
    fail(code, message, details) {
      diagnostics.push({ code, severity: 'error', message, ...(details ? { details } : {}) });
    },
    gameAssetUrl(relPath) {
      return `modeltool://app/assets/${relPath.replace(/^\/+/, '')}`;
    },
  };

  const task = TASKS[request.command];
  let output: TaskOutput | null = null;
  try {
    output = await task(tools, request);
  } finally {
    for (const asset of cache.values()) {
      try {
        asset.dispose();
      } catch {
        /* 释放失败不掩盖主结果 */
      }
    }
  }

  // CSP 拦截属于资源不完整，必须在判定 status 之前并入诊断。
  for (const item of cspDiagnostics()) diagnostics.push(item);

  const hasError = diagnostics.some((item) => item.severity === 'error');
  const taskPartial = output?.status === 'partial';
  const userAgent = navigator.userAgent;
  const electron = /Electron\/([\d.]+)/.exec(userAgent)?.[1] ?? null;
  const chromium = /Chrome\/([\d.]+)/.exec(userAgent)?.[1] ?? null;

  return {
    status: hasError || taskPartial ? 'partial' : 'ok',
    data: output ? output.data : null,
    diagnostics,
    error: null,
    metadata: {
      three: THREE.REVISION,
      electron,
      chromium,
      userAgent,
      rendererBackend: backend ?? { vendor: null, renderer: null, version: null },
      inputSha256: request.inputSha256,
    },
  };
}

function errorPayload(error: unknown): {
  status: 'error';
  data: null;
  diagnostics: Diagnostic[];
  error: { code: string; message: string; exitCode: number; details?: unknown };
  metadata: Record<string, unknown>;
} {
  if (error instanceof TaskError) {
    return {
      status: 'error',
      data: null,
      diagnostics: [
        {
          code: error.code,
          severity: 'error',
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      ],
      error: {
        code: error.code,
        message: error.message,
        exitCode: error.exitCode,
        ...(error.details ? { details: error.details } : {}),
      },
      metadata: {},
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : null;
  return {
    status: 'error',
    data: null,
    diagnostics: [{ code: 'TASK_EXCEPTION', severity: 'error', message, details: { stack } }],
    error: { code: 'TASK_EXCEPTION', message, exitCode: 5, details: { stack } },
    metadata: {},
  };
}

async function main(): Promise<void> {
  const bridge = window.modelTool;
  if (!bridge) {
    console.error('model-tool: 缺少 preload 桥');
    return;
  }
  let request: ToolRequest | null = null;
  try {
    request = parseRequest();
    const result = await runTask(request);
    await bridge.submit(result);
  } catch (error) {
    await bridge.submit({
      ...errorPayload(error),
      metadata: { command: request?.command ?? null },
    });
  }
}

void main();
