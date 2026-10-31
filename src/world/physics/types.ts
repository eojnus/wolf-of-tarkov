/** 物理层共享的纯几何类型；不依赖 Rapier，也不依赖 Three.js。 */
export interface PhysicsBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number;
  maxY: number;
}

export interface PhysicsBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface PhysicsPose {
  x: number;
  y: number;
  z: number;
}

/** 只读的运行时碰撞体快照；所有字段都是可序列化副本。 */
export interface PhysicsColliderSnapshot {
  readonly handle: number;
  readonly role: 'character' | 'static' | 'other';
  readonly shape: string;
  readonly position: PhysicsPose;
  readonly rotation: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
  };
  readonly halfExtents: PhysicsPose | null;
  readonly radius: number | null;
  readonly halfHeight: number | null;
}

/** 物理运行时的只读快照；不暴露 Rapier 对象。 */
export interface PhysicsDebugSnapshot {
  readonly colliders: readonly PhysicsColliderSnapshot[];
  readonly characterHandle: number;
  readonly characterFootPosition: PhysicsPose;
  readonly grounded: boolean;
  readonly bounds: PhysicsBounds;
  readonly edgeMargin: number;
  readonly counts: {
    readonly bodies: number;
    readonly colliders: number;
    readonly staticBodies: number;
  };
}


export interface PhysicsStepInput {
  /** 期望水平速度（米/秒），已经包含疾跑与生存倍率。 */
  readonly velocityX: number;
  readonly velocityZ: number;
  /** 本帧新按下的跳跃请求；只允许落地状态消费一次。 */
  readonly jump: boolean;
  /** 是否允许水平输入与跳跃。面板打开时为 false，但竖直物理仍继续。 */
  readonly allowInput: boolean;
  /** 手动暂停 / 菜单暂停 / 页面隐藏 / 家具编辑 / 场景未就绪时为 true。 */
  readonly frozen: boolean;
}

export interface PhysicsStepResult {
  /** 物理世界的权威脚底位置；碰撞、落点、交互和存档只用它。 */
  readonly authoritative: PhysicsPose;
  /** 仅用于表现的位置：相邻两个物理步之间按剩余累计时间插值。 */
  readonly display: PhysicsPose;
  /** 最近已完成物理步的实际水平速度；无新步时保留，不把插值位移当作速度样本。 */
  readonly velocityX: number;
  readonly velocityZ: number;
  readonly grounded: boolean;
  /**
   * 帧末竖直速度（米/秒，向上为正）。只供表现区分起跳、上升与下落；
   * 无新物理步时保留上一样本，不参与物理或业务判定。
   */
  readonly verticalVelocity: number;
  /**
   * 本帧至少一个物理步从接地变为离地（成功起跳或走出边缘）。
   * 逐物理步累计，不能只看帧末 grounded，否则同帧多个步会漏掉变化。
   */
  readonly leftGround: boolean;
  /** 本帧至少一个物理步从离地变为接地。 */
  readonly touchedGround: boolean;
  readonly steps: number;
  /** 本帧是否已经处理（或丢弃）跳跃请求；World 据此清掉一次性输入。 */
  readonly jumpHandled: boolean;
}
