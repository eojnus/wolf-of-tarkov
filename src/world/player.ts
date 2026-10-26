/**
 * 玩家角色 —— 第三人称移动、碰撞、朝实际移动方向转身、动画驱动。
 *
 * 位移由代码控制；人物动画不含根位移，不做叠加。
 * 是否播放行走/跑步由「本帧实际产生的位移」决定，撞墙没有位移时不会空转。
 */

import * as THREE from 'three';
import { CITY, PLAYER, TIME } from '../content/config';
import type { CharacterRig } from './character';
import type { Collider } from './scene';

export interface MoveInput {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
}

export const EMPTY_INPUT: MoveInput = {
  forward: false,
  back: false,
  left: false,
  right: false,
};

export interface PlayerPose {
  readonly x: number;
  readonly z: number;
  readonly facing: number;
}

export interface PlayerUpdateResult {
  readonly moved: boolean;
  readonly distance: number;
  readonly speed: number;
}

/**
 * 人物可移动的世界边界（米，世界坐标）。
 *
 * 由 world 从**当前逻辑地图**的 bounds 传入，与地面渲染、读档位置修正同源；
 * player 不读取布局模块，也不自己用固定城市尺寸。
 */
export interface PlayerBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** 人物中心与城区外边界保留的距离（与地面边缘一致），避免走到地面之外。 */
export const PLAYER_EDGE_MARGIN = 1.5;

const ZERO_RESULT: PlayerUpdateResult = { moved: false, distance: 0, speed: 0 };

function hits(x: number, z: number, colliders: readonly Collider[], radius: number): boolean {
  for (const collider of colliders) {
    if (
      x > collider.minX - radius &&
      x < collider.maxX + radius &&
      z > collider.minZ - radius &&
      z < collider.maxZ + radius
    ) {
      return true;
    }
  }
  return false;
}

/** 最短弧插值，避免从 179° 转到 -179° 时绕一大圈。 */
function lerpAngle(from: number, to: number, t: number): number {
  const twoPi = Math.PI * 2;
  let diff = (((to - from + Math.PI) % twoPi) + twoPi) % twoPi - Math.PI;
  return from + diff * t;
}

export class Player {
  readonly group: THREE.Group;
  private readonly placeholder: THREE.Group;
  private readonly body: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private character: CharacterRig | null = null;
  private posX: number;
  private posZ: number;
  private facingRad: number;
  private walkPhase = 0;

  constructor() {
    this.posX = CITY.spawn.x;
    this.posZ = CITY.spawn.z;
    this.facingRad = Math.PI;

    this.group = new THREE.Group();

    this.placeholder = new THREE.Group();
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x2f6f8f, roughness: 0.7 });
    this.body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.62, 6, 12), bodyMaterial);
    this.body.position.y = 0.82;
    const headMaterial = new THREE.MeshStandardMaterial({ color: 0xe7c9a9, roughness: 0.8 });
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 16, 12), headMaterial);
    this.head.position.y = 1.62;
    this.placeholder.add(this.body, this.head);

    const shadowMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
    });
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 22), shadowMaterial);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;

    this.group.add(this.placeholder, shadow);
    this.group.position.set(this.posX, 0, this.posZ);
    this.group.rotation.y = this.facingRad;
  }

  /** 人物模型加载成功后替换灰盒占位。 */
  attachCharacter(rig: CharacterRig): void {
    this.character = rig;
    this.group.add(rig.root);
    this.placeholder.visible = false;
  }

  hasCharacter(): boolean {
    return this.character !== null;
  }

  pose(): PlayerPose {
    return { x: this.posX, z: this.posZ, facing: this.facingRad };
  }

  restore(pose: PlayerPose): void {
    this.posX = pose.x;
    this.posZ = pose.z;
    this.facingRad = pose.facing;
    this.group.position.set(this.posX, 0, this.posZ);
    this.group.rotation.y = this.facingRad;
    this.character?.update(0, false, 0, false);
  }

  /**
   * 推进一帧。dir 是已转换到世界空间的移动方向（长度 0 表示没有输入）。
   *
   * 位移按「每步不超过半径一半」切成子步逐个做 X/Z 分离碰撞，
   * 避免疾跑时单帧位移大于建筑厚度而穿模。动画与转身在整帧位移结束后
   * 统一按**实际位移**更新，因此贴墙滑动时朝向与实际移动一致。
   *
   * `bounds` 来自当前逻辑地图（world 传入），是移动边界的唯一来源。
   * `speedMultiplier` 由应用层根据生存状态传入（0～1）；本类不读取任何业务状态。
   */
  update(
    dtSeconds: number,
    dir: { x: number; z: number },
    colliders: readonly Collider[],
    bounds: PlayerBounds,
    canMove: boolean,
    sprinting: boolean,
    speedMultiplier = 1,
  ): PlayerUpdateResult {
    const length = Math.hypot(dir.x, dir.z);
    if (!canMove || length < 1e-6 || dtSeconds <= 0) {
      this.character?.update(dtSeconds, false, 0, false);
      this.animatePlaceholder(0, false);
      return ZERO_RESULT;
    }

    const moveDt = Math.min(dtSeconds, TIME.maxMoveDeltaMs / 1000);
    const multiplier = Math.max(0, Math.min(1, speedMultiplier));
    const targetSpeed = (sprinting ? PLAYER.speed * PLAYER.sprintMultiplier : PLAYER.speed) * multiplier;
    const totalDistance = targetSpeed * moveDt;

    const dirX = dir.x / length;
    const dirZ = dir.z / length;
    const minX = bounds.minX + PLAYER_EDGE_MARGIN;
    const maxX = bounds.maxX - PLAYER_EDGE_MARGIN;
    const minZ = bounds.minZ + PLAYER_EDGE_MARGIN;
    const maxZ = bounds.maxZ - PLAYER_EDGE_MARGIN;
    const radius = PLAYER.radius;
    const beforeX = this.posX;
    const beforeZ = this.posZ;

    const maxStep = radius / 2;
    const steps = Math.max(1, Math.ceil(totalDistance / maxStep));
    const stepLength = totalDistance / steps;

    for (let i = 0; i < steps; i += 1) {
      const nextX = this.posX + dirX * stepLength;
      if (!hits(nextX, this.posZ, colliders, radius) && nextX > minX && nextX < maxX) {
        this.posX = nextX;
      }
      const nextZ = this.posZ + dirZ * stepLength;
      if (!hits(this.posX, nextZ, colliders, radius) && nextZ > minZ && nextZ < maxZ) {
        this.posZ = nextZ;
      }
    }

    const deltaX = this.posX - beforeX;
    const deltaZ = this.posZ - beforeZ;
    const distance = Math.hypot(deltaX, deltaZ);
    const moved = distance > 0.0005;
    const speed = dtSeconds > 0 ? distance / dtSeconds : 0;

    if (moved) {
      // 朝向跟随实际位移方向：沿墙滑动时不会朝着墙里「原地走」
      const target = Math.atan2(deltaX, deltaZ);
      const k = 1 - Math.exp(-PLAYER.turnLambda * dtSeconds);
      this.facingRad = lerpAngle(this.facingRad, target, k);
      this.group.rotation.y = this.facingRad;
    }

    this.group.position.set(this.posX, 0, this.posZ);
    this.character?.update(dtSeconds, moved, speed, sprinting);
    this.animatePlaceholder(dtSeconds, moved);

    return { moved, distance, speed };
  }

  /** 模型未加载时的占位起伏，避免完全静止的观感。 */
  private animatePlaceholder(dtSeconds: number, moving: boolean): void {
    if (!this.placeholder.visible) return;
    if (!moving) {
      this.body.position.y = 0.82;
      this.head.position.y = 1.62;
      return;
    }
    this.walkPhase += dtSeconds * 10;
    const lift = Math.abs(Math.sin(this.walkPhase)) * 0.06;
    this.body.position.y = 0.82 + lift;
    this.head.position.y = 1.62 + lift;
  }

  dispose(): void {
    this.character?.dispose();
    this.character = null;
  }
}
