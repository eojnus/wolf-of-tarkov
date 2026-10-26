/**
 * 状态仓库 —— 提供「一次操作整体成功或整体失败」的提交语义。
 *
 * 做法很朴素：在状态副本上执行修改，全部成功才替换当前状态；任何异常都丢弃副本。
 * 这不是通用事务框架，只是首版所需的原子提交。副本与提交都是同步的，
 * 因此期间不可能插入一次保存，也不会出现「写了一半」的状态被读到。
 *
 * 核心不引用任何业务类型：TState 由应用层定义。
 */

import { BusinessError } from './errors';
import { asReadonly, type DeepReadonly } from './readonly';

export type StateListener<TState> = (state: TState) => void;

export class GameStore<TState> {
  private currentState: TState;
  private readonly listeners = new Set<StateListener<DeepReadonly<TState>>>();
  private notifyScheduled = false;
  private running = false;

  constructor(initial: TState) {
    this.currentState = initial;
  }

  /**
   * 正式状态的**只读视图**。
   *
   * 查询、视图与估值都通过它读状态：编译期禁止 push/splice/赋值，
   * 但对象本身仍是同一份引用（没有冻结、没有克隆）。
   * 需要写入时只能走 `run(draft => ...)` 或在初始化/迁移中构造新状态。
   */
  get state(): DeepReadonly<TState> {
    return asReadonly(this.currentState);
  }

  /**
   * 在一次原子提交中修改状态。mutate 只能操作 draft，不得产生外部副作用；
   * 抛错即整体回滚。
   */
  run<R>(mutate: (draft: TState) => R): R {
    if (this.running) {
      throw new BusinessError('NESTED_COMMIT', '不允许在提交过程中嵌套提交');
    }
    this.running = true;
    try {
      const draft = structuredClone(this.currentState);
      const result = mutate(draft);
      this.currentState = draft;
      this.scheduleNotify();
      return result;
    } finally {
      this.running = false;
    }
  }

  /** 用一份已校验的完整快照替换当前状态（读档用）。 */
  replace(next: TState): void {
    this.currentState = next;
    this.scheduleNotify();
  }

  subscribe(listener: StateListener<DeepReadonly<TState>>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private scheduleNotify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      for (const listener of this.listeners) listener(asReadonly(this.currentState));
    });
  }
}
