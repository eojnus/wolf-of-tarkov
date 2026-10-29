/**
 * 玩家角色表现 —— 权威位移由物理层给出，本类只消费结果。
 *
 * 负责：脚底原点的位置、朝向、实际位移驱动的转身与动画；
 * 不负责：碰撞、重力、跳跃或场景查询。这样人物只有一套权威位移。
 */

import * as THREE from 'three';
import { CITY, PHYSICS, PLAYER } from '../content/config';
import type { CharacterRig } from './character';

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
  readonly y: number;
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
 * 室外由当前逻辑地图的 bounds 传入，室内由房间边界传入；物理运行时负责在
 * 每一步之后夹取中心位置，player 自身不再做边界/碰撞判断。
 */
export interface PlayerBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** 人物中心与城区外边界保留的距离（与地面边缘一致），避免走到地面之外。 */
export const PLAYER_EDGE_MARGIN = 1.5;

/** 最短弧插值，避免从 179° 转到 -179° 时绕一大圈。 */
function lerpAngle(from: number, to: number, t: number): number {
  const twoPi = Math.PI * 2;
  const diff = ((((to - from + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
  return from + diff * t;
}

export class Player {
  readonly group: THREE.Group;
  private readonly placeholder: THREE.Group;
  private readonly body: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private readonly shadow: THREE.Mesh;
  private character: CharacterRig | null = null;
  /** 权威脚底位置：碰撞、交互、落点与存档使用。 */
  private authX: number;
  private authY = 0;
  private authZ: number;
  /** 表现脚底位置：场景显示与镜头使用，允许落后一个物理步插值。 */
  private posX: number;
  private posY = 0;
  private posZ: number;
  private facingRad: number;
  private walkPhase = 0;

  constructor() {
    this.authX = CITY.spawn.x;
    this.authZ = CITY.spawn.z;
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
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 22), shadowMaterial);
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.02;

    this.group.add(this.placeholder, this.shadow);
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

  /** 权威位置：碰撞、交互、落点、存档。 */
  pose(): PlayerPose {
    return { x: this.authX, y: this.authY, z: this.authZ, facing: this.facingRad };
  }

  /** 表现位置：只用于渲染、镜头与环境跟随，不得用于碰撞/交互/存档。 */
  displayPose(): { x: number; y: number; z: number } {
    return { x: this.posX, y: this.posY, z: this.posZ };
  }

  /** 场景切换/读档的权威落点；物理层会另行清理竖直速度与插值历史。 */
  restore(pose: PlayerPose): void {
    this.authX = pose.x;
    this.authY = pose.y;
    this.authZ = pose.z;
    this.posX = pose.x;
    this.posY = pose.y;
    this.posZ = pose.z;
    this.facingRad = pose.facing;
    this.applyTransform();
    this.character?.update(0, false, 0, false);
  }

  /**
   * 消费一次物理结果。
   *
   * 位置显示用插值，动画与转身用物理步实际速度，两个时间口径互不混算。
   */
  updateFromPhysics(
    dtSeconds: number,
    authoritative: { readonly x: number; readonly y: number; readonly z: number },
    display: { readonly x: number; readonly y: number; readonly z: number },
    velocityX: number,
    velocityZ: number,
    sprinting: boolean,
  ): PlayerUpdateResult {
    const distance = Math.hypot(display.x - this.posX, display.z - this.posZ);
    this.authX = authoritative.x;
    this.authY = authoritative.y;
    this.authZ = authoritative.z;
    this.posX = display.x;
    this.posY = display.y;
    this.posZ = display.z;

    const speed = Math.hypot(velocityX, velocityZ);
    const moved = speed > PHYSICS.character.minAnimationSpeed;
    if (dtSeconds > 0 && moved) {
      const target = Math.atan2(velocityX, velocityZ);
      const k = 1 - Math.exp(-PLAYER.turnLambda * dtSeconds);
      this.facingRad = lerpAngle(this.facingRad, target, k);
    }
    this.applyTransform();

    this.character?.update(dtSeconds, moved, speed, sprinting && moved);
    this.animatePlaceholder(dtSeconds, moved);
    return { moved, distance, speed };
  }

  private applyTransform(): void {
    this.group.position.set(this.posX, this.posY, this.posZ);
    this.group.rotation.y = this.facingRad;
    // 脚下的贴地圆片留在场景地面，不随跳跃一起浮起。
    this.shadow.position.y = 0.02 - this.posY;
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
