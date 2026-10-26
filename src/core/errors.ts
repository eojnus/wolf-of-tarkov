/** 业务规则校验失败的统一错误类型。命令层捕获后转为界面提示。 */
export class BusinessError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
  }
}

export function isBusinessError(error: unknown): error is BusinessError {
  return error instanceof BusinessError;
}

/** 把任意异常转为可展示文案。 */
export function describeError(error: unknown): string {
  if (isBusinessError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return '发生了未知错误';
}
