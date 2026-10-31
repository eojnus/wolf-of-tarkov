// 版本化结果 envelope 与退出码的唯一来源（CLI 侧）。
// 架构文档 docs/model-tool-architecture.md §5：字段固定，不得增删顶层键。

export const SCHEMA_VERSION = 1;

/** 退出码语义（与架构文档一致，不得复用为其他含义）。 */
export const EXIT = Object.freeze({
  OK: 0,
  BAD_ARGUMENTS: 2,
  UNSUPPORTED: 3,
  IO: 4,
  FAILED: 5,
  PARTIAL: 6,
});

const SEVERITIES = new Set(['info', 'warning', 'error']);

export class ToolError extends Error {
  /**
   * @param {string} code 稳定诊断码
   * @param {string} message 面向 Agent 的可行动说明
   * @param {number} exitCode 见 EXIT
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, exitCode = EXIT.FAILED, details = undefined) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function diagnostic(code, severity, message, details = undefined) {
  if (!SEVERITIES.has(severity)) {
    throw new TypeError(`未知诊断级别：${severity}`);
  }
  const item = { code, severity, message };
  if (details !== undefined) item.details = details;
  return item;
}

/**
 * 组装 envelope。`status` 与退出码分开表达：CLI 用 exitCode 退出，脚本可只读 JSON。
 * 未知值一律 null，不写 0。
 */
export function envelope({
  command,
  status,
  inputs = {},
  outputs = [],
  diagnostics = [],
  metadata = {},
  data = null,
}) {
  if (!['ok', 'partial', 'error'].includes(status)) {
    throw new TypeError(`未知状态：${status}`);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command,
    status,
    inputs,
    outputs,
    diagnostics,
    metadata: {
      tool: 'model-tool',
      toolVersion: metadata.toolVersion ?? null,
      ...metadata,
    },
    data,
  };
}

export function statusForExit(exitCode) {
  if (exitCode === EXIT.OK) return 'ok';
  if (exitCode === EXIT.PARTIAL) return 'partial';
  return 'error';
}
