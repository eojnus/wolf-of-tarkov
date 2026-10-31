// 请求/结果校验（CLI ↔ Electron 主进程 ↔ 渲染页三方共用同一份形状）。
// 校验只做「形状与绝对路径」检查；权限与越界由 paths.mjs + 协议处理做真实校验。
import { isAbsolute } from 'node:path';
import { SCHEMA_VERSION, ToolError, EXIT } from './schema.mjs';

export const TASK_COMMANDS = Object.freeze([
  'inspect',
  'snapshot',
  'snapshot-game-character',
  'animation-edit',
  'retarget',
  'collision',
  'collision-snapshot',
]);

const ALLOWED_KEYS = new Set([
  'schemaVersion',
  'command',
  'input',
  'inputSha256',
  'inputSize',
  'outDir',
  'args',
  'allowedRoot',
  'authorizedRoot',
  'declaredResources',
  'toolVersion',
  'gameAssetsDir',
  'projectRoot',
]);

function bad(code, message, details) {
  return new ToolError(code, message, EXIT.BAD_ARGUMENTS, details);
}

/** 校验 CLI 构造的请求；返回同一对象（不复制大字段）。 */
export function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw bad('REQUEST_INVALID', '请求必须是 JSON 对象');
  }
  const extra = Object.keys(value).filter((key) => !ALLOWED_KEYS.has(key));
  if (extra.length > 0) {
    throw bad('REQUEST_UNKNOWN_KEYS', `请求含未知字段：${extra.join(', ')}`, { extra });
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw bad('REQUEST_SCHEMA', `请求 schemaVersion 必须是 ${SCHEMA_VERSION}`);
  }
  if (!TASK_COMMANDS.includes(value.command)) {
    throw bad('REQUEST_COMMAND', `未知任务命令：${value.command}`, { command: value.command });
  }
  for (const key of ['outDir', 'gameAssetsDir', 'projectRoot']) {
    if (typeof value[key] !== 'string' || !isAbsolute(value[key])) {
      throw bad('REQUEST_PATH', `${key} 必须是绝对路径`, { key, value: value[key] });
    }
  }
  if (value.command === 'snapshot-game-character' || value.command === 'collision' || value.command === 'collision-snapshot') {
    // 这些任务需要项目资源/真实游戏模块；input 可以为空。
    if (value.input !== null && typeof value.input !== 'string') {
      throw bad('REQUEST_INPUT', 'input 必须是绝对路径或 null');
    }
  } else if (typeof value.input !== 'string' || !isAbsolute(value.input)) {
    throw bad('REQUEST_INPUT', 'input 必须是绝对路径', { input: value.input });
  }
  if (value.allowedRoot !== null && (typeof value.allowedRoot !== 'string' || !isAbsolute(value.allowedRoot))) {
    throw bad('REQUEST_ROOT', 'allowedRoot 必须是绝对路径或 null');
  }
  if (typeof value.authorizedRoot !== 'string' || !isAbsolute(value.authorizedRoot)) {
    throw bad('REQUEST_AUTHORIZED_ROOT', 'authorizedRoot 必须是绝对路径');
  }
  if (value.declaredResources !== undefined && value.declaredResources !== null) {
    const declared = value.declaredResources;
    if (typeof declared !== 'object' || Array.isArray(declared)) {
      throw bad('REQUEST_DECLARED_RESOURCES', 'declaredResources 必须是对象或 null');
    }
    if (typeof declared.source !== 'string') {
      throw bad('REQUEST_DECLARED_RESOURCES', 'declaredResources.source 必须是字符串');
    }
  }
  if (value.toolVersion !== undefined && typeof value.toolVersion !== 'string') {
    throw bad('REQUEST_TOOL_VERSION', 'toolVersion 必须是字符串');
  }
  if (value.inputSha256 !== null && !/^[0-9A-F]{64}$/.test(value.inputSha256 ?? '')) {
    throw bad('REQUEST_HASH', 'inputSha256 必须是 64 位大写十六进制或 null');
  }
  if (!value.args || typeof value.args !== 'object' || Array.isArray(value.args)) {
    throw bad('REQUEST_ARGS', 'args 必须是对象');
  }
  return value;
}

/**
 * 渲染页返回的任务结果。status 只允许 ok/partial/error；
 * ok/partial 必须有 data 对象，error 必须有 error.code 与 error.message。
 */
export function validateTaskResult(value) {
  if (!value || typeof value !== 'object') {
    throw new ToolError('RESULT_INVALID', '渲染页未返回结果对象', EXIT.FAILED);
  }
  if (!['ok', 'partial', 'error'].includes(value.status)) {
    throw new ToolError('RESULT_STATUS', `未知结果状态：${value.status}`, EXIT.FAILED);
  }
  const diagnostics = Array.isArray(value.diagnostics) ? value.diagnostics : [];
  const outputs = Array.isArray(value.outputs) ? value.outputs : [];
  if (value.status === 'error') {
    const error = value.error ?? {};
    return {
      status: 'error',
      diagnostics,
      outputs,
      data: value.data ?? null,
      error: {
        code: typeof error.code === 'string' ? error.code : 'TASK_FAILED',
        message: typeof error.message === 'string' ? error.message : '任务失败（无说明）',
        exitCode: Number.isInteger(error.exitCode) && error.exitCode >= 2 && error.exitCode <= 6
          ? error.exitCode
          : EXIT.FAILED,
        details: error.details ?? null,
      },
      metadata: value.metadata ?? {},
    };
  }
  if (!value.data || typeof value.data !== 'object') {
    throw new ToolError('RESULT_DATA', '成功结果必须包含 data 对象', EXIT.FAILED);
  }
  return {
    status: value.status,
    diagnostics,
    outputs,
    data: value.data,
    error: null,
    metadata: value.metadata ?? {},
  };
}

/** 渲染页上报的写文件请求形状。 */
export function validateWriteRequest(value) {
  if (!value || typeof value !== 'object') {
    throw bad('WRITE_INVALID', '写文件请求必须是对象');
  }
  const { relPath, encoding, data } = value;
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw bad('WRITE_PATH', 'relPath 必须是非空字符串');
  }
  if (!['base64', 'utf8'].includes(encoding)) {
    throw bad('WRITE_ENCODING', `不支持的编码：${encoding}`);
  }
  if (typeof data !== 'string') {
    throw bad('WRITE_DATA', 'data 必须是字符串');
  }
  return { relPath, encoding, data };
}
