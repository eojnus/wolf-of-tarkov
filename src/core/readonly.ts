/**
 * 深层只读类型的编译期工具。
 *
 * 只有一个用途：让查询/视图拿到的状态无法被写入。
 * 这是**纯类型**边界——运行时没有任何包装、冻结、Proxy 或额外克隆，
 * 因此不会带来每帧开销，也不会改变 GameStore 的全量克隆提交语义。
 *
 * 语义要点：
 *  - 对象：所有属性变 readonly（可读不可赋值）；
 *  - 数组/元组：变 ReadonlyArray（不能 push/splice/改下标）；
 *  - 函数、基本类型原样保留；
 *  - `null | undefined` 原样保留（可选字段不会变成必填）。
 *
 * 可写 → 只读是允许的（T 可赋给 DeepReadonly<T>），
 * 所以写入路径仍可直接把可变模型/草稿传给只读参数，不需要反向断言。
 */

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/**
 * 把内部持有的可变状态暴露为只读视图。
 *
 * 这是整个工程里唯一"可变 → 只读"的类型断言，且方向是收紧权限：
 * 它不会让任何调用方拿到可写引用，也不改变真实对象。
 */
export function asReadonly<T>(value: T): DeepReadonly<T> {
  return value as DeepReadonly<T>;
}

/**
 * 取一份**独立的可写副本**（深克隆）。
 *
 * 只用于「必须拥有写权限」的少数场景：构建存档快照、导入前的规范化等。
 * 因为是深克隆，副本与正式状态没有任何共享引用，改副本不会影响游戏状态。
 */
export function cloneForWrite<T>(value: DeepReadonly<T>): T {
  return structuredClone(value) as T;
}
