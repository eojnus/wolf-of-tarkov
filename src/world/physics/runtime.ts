/**
 * Rapier 运行时 —— 唯一物理世界、唯一人物刚体与角色控制器。
 *
 * 职责：
 *  - 异步初始化 WASM；
 *  - 固定步长推进，维护人物竖直速度与接地状态；
 *  - 保存相邻两个已完成物理步的权威位置，并生成仅供表现的位置；
 *  - 把场景静态 AABB 转成静态盒；
 *  - 场景切换/读档/销毁时释放物理对象。
 *
 * 不读取 GameState、不推进游戏时间、不访问存档，也不把表现插值写回刚体。
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { PHYSICS } from '../../content/config';
import { floorBox, withGround } from './collision';
import type {
  PhysicsBounds,
  PhysicsBox,
  PhysicsPose,
  PhysicsStepInput,
  PhysicsStepResult,
} from './types';

let initPromise: Promise<void> | null = null;

function ensureRapier(): Promise<void> {
  if (!initPromise) initPromise = RAPIER.init();
  return initPromise;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function halfExtents(box: PhysicsBox): { x: number; y: number; z: number } {
  return {
    x: (box.maxX - box.minX) / 2,
    y: (box.maxY - box.minY) / 2,
    z: (box.maxZ - box.minZ) / 2,
  };
}

function interpolatePose(a: PhysicsPose, b: PhysicsPose, t: number): PhysicsPose {
  const alpha = clamp(t, 0, 1);
  return {
    x: a.x + (b.x - a.x) * alpha,
    y: a.y + (b.y - a.y) * alpha,
    z: a.z + (b.z - a.z) * alpha,
  };
}

export class PhysicsRuntime {
  private readonly world: RAPIER.World;
  private readonly body: RAPIER.RigidBody;
  private collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly staticBodies: RAPIER.RigidBody[] = [];
  /** 当前静态盒快照，只读用于支撑高度/空间校验，不代替物理世界。 */
  private readonly staticBoxes: PhysicsBox[] = [];

  private bounds: PhysicsBounds;
  private edgeMargin: number;
  private radius: number;
  private accumulator = 0;
  private verticalVelocity = 0;
  private grounded = false;
  /** 最近两个已完成物理步的权威脚底位置，用于表现插值。 */
  private previousPose: PhysicsPose;
  private currentPose: PhysicsPose;
  /** 只给渲染/镜头用的插值位置；绝不写回刚体。 */
  private displayPoseValue: PhysicsPose;
  private velocityX = 0;
  private velocityZ = 0;

  private constructor(pose: PhysicsPose, radius: number) {
    this.world = new RAPIER.World({ x: 0, y: PHYSICS.gravity, z: 0 });
    this.world.timestep = PHYSICS.fixedStepSeconds;
    this.radius = radius;
    this.bounds = { minX: pose.x - 1, maxX: pose.x + 1, minZ: pose.z - 1, maxZ: pose.z + 1 };
    this.edgeMargin = 0;

    const start = { x: pose.x, y: pose.y + PHYSICS.character.spawnLift, z: pose.z };
    this.body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(start.x, start.y, start.z),
    );
    this.collider = this.createCharacterCollider(radius);
    this.previousPose = { ...start };
    this.currentPose = { ...start };
    this.displayPoseValue = { ...start };

    this.controller = this.world.createCharacterController(PHYSICS.character.offset);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.setMaxSlopeClimbAngle(
      (PHYSICS.character.maxSlopeClimbDegrees * Math.PI) / 180,
    );
    this.controller.setMinSlopeSlideAngle(
      (PHYSICS.character.minSlopeSlideDegrees * Math.PI) / 180,
    );
    this.controller.disableAutostep();
    this.controller.disableSnapToGround();
    this.controller.setApplyImpulsesToDynamicBodies(false);
  }

  static async create(pose: PhysicsPose, radius: number): Promise<PhysicsRuntime> {
    await ensureRapier();
    return new PhysicsRuntime(pose, radius);
  }

  private createCharacterCollider(radius: number): RAPIER.Collider {
    const height = PHYSICS.character.height;
    const halfHeight = Math.max(0.01, height / 2 - radius);
    const desc = RAPIER.ColliderDesc.capsule(halfHeight, radius)
      .setTranslation(0, height / 2, 0)
      .setFriction(0)
      .setActiveCollisionTypes(
        RAPIER.ActiveCollisionTypes.DEFAULT | RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED,
      );
    return this.world.createCollider(desc, this.body);
  }

  /** 室内与室外的碰撞半径不同；切换时替换胶囊，仍保持脚底为刚体原点。 */
  setCharacterRadius(radius: number): void {
    if (Math.abs(radius - this.radius) < 1e-6) return;
    this.radius = radius;
    this.world.removeCollider(this.collider, true);
    this.collider = this.createCharacterCollider(radius);
  }

  private addStaticBox(box: PhysicsBox): void {
    const half = halfExtents(box);
    if (half.x <= 1e-5 || half.y <= 1e-5 || half.z <= 1e-5) return;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(
        (box.minX + box.maxX) / 2,
        (box.minY + box.maxY) / 2,
        (box.minZ + box.maxZ) / 2,
      ),
    );
    const desc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setFriction(0.85)
      .setActiveCollisionTypes(
        RAPIER.ActiveCollisionTypes.DEFAULT | RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED,
      );
    this.world.createCollider(desc, body);
    this.staticBodies.push(body);
    this.staticBoxes.push({ ...box });
  }

  private clearStatics(): void {
    for (const body of this.staticBodies) this.world.removeRigidBody(body);
    this.staticBodies.length = 0;
    this.staticBoxes.length = 0;
  }

  /** 室外：地面 + 业务建筑 + 装饰街区静态盒。 */
  setOutdoor(
    boxes: readonly PhysicsBox[],
    bounds: PhysicsBounds,
    edgeMargin: number,
  ): void {
    this.clearStatics();
    this.bounds = { ...bounds };
    this.edgeMargin = edgeMargin;
    for (const box of withGround(boxes, bounds)) this.addStaticBox(box);
    // 静态体创建后先推进一次查询管线，保证紧随其后的支撑/空间校验可见。
    this.world.step();
  }

  /** 室内：地板 + 固定结构（含门头/天花板）+ 当前已提交家具。 */
  setInterior(
    structure: readonly PhysicsBox[],
    furniture: readonly PhysicsBox[],
    bounds: PhysicsBounds,
    room: { readonly width: number; readonly depth: number },
    edgeMargin: number,
  ): void {
    this.clearStatics();
    this.bounds = { ...bounds };
    this.edgeMargin = edgeMargin;
    this.addStaticBox(floorBox(room.width, room.depth));
    for (const box of structure) this.addStaticBox(box);
    for (const box of furniture) this.addStaticBox(box);
    this.world.step();
  }

  /** 场景切换/读档的权威落点。重置竖直速度、累计余量与前后插值状态。 */
  teleport(pose: PhysicsPose): void {
    // 地板已经为控制器 offset 留出间隙，合法落点无需再抬高后下落。
    const target = { x: pose.x, y: pose.y, z: pose.z };
    this.body.setTranslation(target, true);
    this.body.setNextKinematicTranslation(target);
    this.verticalVelocity = 0;
    this.accumulator = 0;
    this.previousPose = { ...target };
    this.currentPose = { ...target };
    this.displayPoseValue = { ...target };
    this.velocityX = 0;
    this.velocityZ = 0;
    // 让新位置同步到 collider，后续查询不会从旧位置开始。
    this.world.step();
    this.grounded = this.isStandingPoseFree(target.x, target.y, target.z);
  }

  get pose(): PhysicsPose {
    const translation = this.body.translation();
    return { x: translation.x, y: translation.y, z: translation.z };
  }

  /** 只读表现位置；镜头、人物显示和环境跟随使用它。 */
  get displayPose(): PhysicsPose {
    return { ...this.displayPoseValue };
  }

  isGrounded(): boolean {
    return this.grounded;
  }

  /** 清空竖直速度、累计余量与跳跃后的缓存；不改变权威位置。 */
  clearMotion(): void {
    this.verticalVelocity = 0;
    this.accumulator = 0;
    const current = this.body.translation();
    this.previousPose = { x: current.x, y: current.y, z: current.z };
    this.currentPose = { ...this.previousPose };
    this.displayPoseValue = { ...this.previousPose };
    this.velocityX = 0;
    this.velocityZ = 0;
    this.grounded = this.isStandingPoseFree(current.x, current.y, current.z);
  }

  debugCounts(): { bodies: number; colliders: number; staticBodies: number } {
    return {
      bodies: this.world.bodies.len(),
      colliders: this.world.colliders.len(),
      staticBodies: this.staticBodies.length,
    };
  }

  /**
   * 地面/低矮实体顶部恢复高度。候选必须同时通过身体空间和实际支撑查询。
   * 没有合法候选时返回 null，不能把实体内部的 y=0 当成安全落点。
   */
  supportHeightAt(x: number, z: number, maxHeight: number = PHYSICS.recoveryMaxSupportHeight): number | null {
    const candidates = new Set<number>([0]);
    for (const box of this.staticBoxes) {
      if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
      if (box.maxY < 0 || box.maxY > maxHeight) continue;
      candidates.add(box.maxY + PHYSICS.character.offset);
    }
    for (const y of [...candidates].sort((a, b) => b - a)) {
      if (this.isStandingPoseFree(x, y, z)) return y;
    }
    return null;
  }

  /** 三维空间校验：胶囊脚底在 (x,y,z) 时是否与当前静态体相交。 */
  isPoseFree(x: number, y: number, z: number): boolean {
    if (
      x < this.bounds.minX + this.edgeMargin || x > this.bounds.maxX - this.edgeMargin ||
      z < this.bounds.minZ + this.edgeMargin || z > this.bounds.maxZ - this.edgeMargin
    ) return false;
    const shape = this.collider.shape;
    const hit = this.world.intersectionWithShape(
      { x, y: y + PHYSICS.character.height / 2 + PHYSICS.character.queryEpsilon, z },
      { x: 0, y: 0, z: 0, w: 1 },
      shape,
      undefined,
      undefined,
      this.collider,
    );
    return hit === null;
  }

  /** 向下扫掠完整胶囊并检查地面法线；墙面接触不能作为起跳支撑。 */
  isStandingPoseFree(x: number, y: number, z: number): boolean {
    if (!this.isPoseFree(x, y, z)) return false;
    const hit = this.world.castShape(
      { x, y: y + PHYSICS.character.height / 2 + PHYSICS.character.queryEpsilon, z },
      { x: 0, y: 0, z: 0, w: 1 },
      { x: 0, y: -1, z: 0 },
      this.collider.shape,
      PHYSICS.character.offset,
      PHYSICS.character.spawnLift + PHYSICS.character.queryEpsilon,
      false,
      undefined,
      undefined,
      this.collider,
    );
    return hit !== null && hit.normal1.y >= Math.cos(
      PHYSICS.character.maxSlopeClimbDegrees * Math.PI / 180,
    );
  }

  advance(dtSeconds: number, input: PhysicsStepInput): PhysicsStepResult {
    if (input.frozen) {
      // 不重算 alpha、不消耗累计余量：显示停在暂停前的最后一帧。
      const authoritative = this.pose;
      return {
        authoritative,
        display: { ...this.displayPoseValue },
        velocityX: 0,
        velocityZ: 0,
        grounded: this.grounded,
        steps: 0,
        jumpHandled: true,
      };
    }

    const dt = Math.min(Math.max(dtSeconds, 0), PHYSICS.maxFrameDeltaSeconds);
    this.accumulator += dt;
    const maxAccumulator = PHYSICS.fixedStepSeconds * PHYSICS.maxSubSteps;
    if (this.accumulator > maxAccumulator) this.accumulator = maxAccumulator;

    let steps = 0;
    let jumpHandled = false;

    while (this.accumulator + 1e-9 >= PHYSICS.fixedStepSeconds) {
      const beforeStep = this.body.translation();
      const stepInput: PhysicsStepInput = {
        ...input,
        jump: input.jump && !jumpHandled,
      };
      this.stepOnce(PHYSICS.fixedStepSeconds, stepInput);
      const afterStep = this.body.translation();
      this.velocityX = (afterStep.x - beforeStep.x) / PHYSICS.fixedStepSeconds;
      this.velocityZ = (afterStep.z - beforeStep.z) / PHYSICS.fixedStepSeconds;
      this.previousPose = { x: beforeStep.x, y: beforeStep.y, z: beforeStep.z };
      this.currentPose = { x: afterStep.x, y: afterStep.y, z: afterStep.z };
      this.accumulator -= PHYSICS.fixedStepSeconds;
      steps += 1;
      if (input.jump) jumpHandled = true;
    }

    if (input.jump && !jumpHandled && steps > 0) jumpHandled = true;

    const alpha = clamp(this.accumulator / PHYSICS.fixedStepSeconds, 0, 1);
    this.displayPoseValue = interpolatePose(this.previousPose, this.currentPose, alpha);

    return {
      authoritative: { ...this.currentPose },
      display: { ...this.displayPoseValue },
      velocityX: input.allowInput ? this.velocityX : 0,
      velocityZ: input.allowInput ? this.velocityZ : 0,
      grounded: this.grounded,
      steps,
      jumpHandled: jumpHandled || input.frozen,
    };
  }

  private stepOnce(dt: number, input: PhysicsStepInput): void {
    const allowInput = input.allowInput;
    let vy = this.verticalVelocity;

    const standing = this.pose;
    if (allowInput && input.jump && this.grounded && vy <= 0 &&
      this.isStandingPoseFree(standing.x, standing.y, standing.z)) {
      vy = PHYSICS.jumpSpeed;
      this.grounded = false;
    }

    vy = Math.max(PHYSICS.terminalVelocity, vy + PHYSICS.gravity * dt);
    // 真实支撑仍在时不持续压入地面；走出边缘后下一步立即恢复重力。
    if (this.grounded && vy < 0 &&
      this.isStandingPoseFree(standing.x, standing.y, standing.z)) vy = 0;

    const vx = allowInput ? input.velocityX : 0;
    const vz = allowInput ? input.velocityZ : 0;
    const desired = { x: vx * dt, y: vy * dt, z: vz * dt };

    this.controller.computeColliderMovement(this.collider, desired);
    const corrected = this.controller.computedMovement();
    const current = this.body.translation();

    let nextX = current.x + corrected.x;
    let nextZ = current.z + corrected.z;
    const minX = this.bounds.minX + this.edgeMargin;
    const maxX = this.bounds.maxX - this.edgeMargin;
    const minZ = this.bounds.minZ + this.edgeMargin;
    const maxZ = this.bounds.maxZ - this.edgeMargin;
    nextX = clamp(nextX, minX, maxX);
    nextZ = clamp(nextZ, minZ, maxZ);
    const nextY = current.y + corrected.y;

    this.body.setNextKinematicTranslation({ x: nextX, y: nextY, z: nextZ });
    this.world.step();

    // 碰头：向上的期望被削掉，立即终止上升，避免贴顶悬停或下一帧继续累加。
    if (vy > 0 && corrected.y < desired.y - 1e-5) vy = 0;
    const after = this.body.translation();
    this.grounded = vy <= 1e-4 && this.isStandingPoseFree(after.x, after.y, after.z);
    if (this.grounded && vy < 0) vy = 0;
    this.verticalVelocity = vy;
  }

  dispose(): void {
    this.world.removeCharacterController(this.controller);
    this.world.free();
  }
}
