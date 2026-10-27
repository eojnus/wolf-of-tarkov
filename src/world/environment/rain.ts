/**
 * 降雨粒子 —— 一个跟随相机的有界雨体积。
 *
 * 职责边界：
 *  - 只负责「看起来在下雨」：雨滴位置、雨丝倾斜与数量上限；
 *  - 不决定天气、不读业务状态；雨量由环境采样给出；
 *  - 缓冲区在构造时一次分配，运行期只更新坐标与 draw range，
 *    不重新分配缓冲、不重建材质；`dt = 0`（暂停）时雨滴完全静止。
 */

import * as THREE from 'three';
import { ENVIRONMENT, type ShadowQuality } from '../../content/config';

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export class RainField {
  readonly object: THREE.LineSegments;

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.LineBasicMaterial;
  private readonly positionAttribute: THREE.BufferAttribute;
  private readonly positions: Float32Array;
  /** 每滴的局部偏移与状态：x / z / y / 速度。 */
  private readonly baseX: Float32Array;
  private readonly baseZ: Float32Array;
  private readonly baseY: Float32Array;
  private readonly speed: Float32Array;
  private readonly drops: number;
  private readonly width: number;
  private readonly depth: number;
  private readonly height: number;
  /** 雨丝端点相对雨滴的固定偏移（沿速度反方向）。 */
  private readonly streakX: number;
  private readonly streakY: number;
  private readonly streakZ: number;
  /** 当前绘制的雨滴数；变化时才重设 draw range。 */
  private count = 0;
  /** 缓冲区尚未写入当前雨滴集合（首次或数量增加）。 */
  private dirty = true;

  constructor(quality: ShadowQuality) {
    const cfg = ENVIRONMENT.rain;
    const scale = cfg.qualityScale[quality];
    this.drops = Math.max(1, Math.round(cfg.maxDrops * scale));
    this.width = cfg.width;
    this.depth = cfg.depth;
    this.height = cfg.height;

    this.positions = new Float32Array(this.drops * 2 * 3);
    this.baseX = new Float32Array(this.drops);
    this.baseZ = new Float32Array(this.drops);
    this.baseY = new Float32Array(this.drops);
    this.speed = new Float32Array(this.drops);

    const velocityX = cfg.windX;
    const velocityY = cfg.fallSpeed;
    const velocityZ = cfg.windZ;
    const velocityLength = Math.hypot(velocityX, velocityY, velocityZ) || 1;
    this.streakX = (-velocityX / velocityLength) * cfg.streakLength;
    this.streakY = (velocityY / velocityLength) * cfg.streakLength;
    this.streakZ = (-velocityZ / velocityLength) * cfg.streakLength;

    for (let i = 0; i < this.drops; i += 1) {
      this.baseX[i] = (Math.random() - 0.5) * this.width;
      this.baseZ[i] = (Math.random() - 0.5) * this.depth;
      this.baseY[i] = Math.random() * this.height;
      this.speed[i] = cfg.fallSpeed * (0.85 + Math.random() * 0.3);
    }

    this.geometry = new THREE.BufferGeometry();
    this.positionAttribute = new THREE.BufferAttribute(this.positions, 3);
    this.positionAttribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.positionAttribute);
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.LineBasicMaterial({
      color: cfg.color,
      transparent: true,
      opacity: cfg.opacity,
      depthWrite: false,
    });

    this.object = new THREE.LineSegments(this.geometry, this.material);
    // 体积整体跟随相机移动，包围球每帧都在变，交给显式可见性管理更稳
    this.object.frustumCulled = false;
    this.object.visible = false;
    this.object.renderOrder = 5;
  }

  /**
   * 推进雨滴并同步绘制范围。
   *
   * `dtSeconds` 是表现用时间（暂停时传 0）；`amount` 是 0..1 的雨量。
   * 数量用 draw range 表达，因此小雨与暴雨共用同一份缓冲。
   */
  update(dtSeconds: number, amount: number): void {
    const clamped = clamp01(amount);
    if (clamped <= 0.02) {
      // 停雨时把**缓存数量与实际绘制范围一起归零**。只隐藏并置 0 而不清缓存时，
      // 再次进入相同雨量会因为 `count !== this.count` 不成立而跳过恢复分支，
      // 结果 object 可见但一条雨丝都画不出来（读档/跳时直接 雨→晴→雨 可复现）。
      // dirty 置位只表示「下次可见时需要重写一遍坐标」，停雨期间不产生上传。
      this.count = 0;
      this.dirty = true;
      if (this.object.visible) {
        this.object.visible = false;
        this.geometry.setDrawRange(0, 0);
      }
      return;
    }

    this.object.visible = true;
    this.material.opacity = ENVIRONMENT.rain.opacity * Math.min(1, 0.35 + clamped * 0.75);

    const count = Math.max(1, Math.round(this.drops * clamped));
    if (count !== this.count) {
      this.count = count;
      this.dirty = true;
      this.geometry.setDrawRange(0, count * 2);
    }

    // 暂停（dt = 0）且雨滴集合没变时什么都不做：不推进、不重传坐标
    const advance = dtSeconds > 0 ? dtSeconds : 0;
    if (advance === 0 && !this.dirty) return;

    const halfWidth = this.width / 2;
    const halfDepth = this.depth / 2;
    const driftX = ENVIRONMENT.rain.windX * advance * 0.35;
    const driftZ = ENVIRONMENT.rain.windZ * advance * 0.35;

    for (let i = 0; i < count; i += 1) {
      let x = this.baseX[i];
      let z = this.baseZ[i];
      let y = this.baseY[i];

      if (advance > 0) {
        x += driftX;
        z += driftZ;
        y -= this.speed[i] * advance;
        if (y < 0) y += this.height;
        if (x > halfWidth) x -= this.width;
        else if (x < -halfWidth) x += this.width;
        if (z > halfDepth) z -= this.depth;
        else if (z < -halfDepth) z += this.depth;
        this.baseX[i] = x;
        this.baseZ[i] = z;
        this.baseY[i] = y;
      }

      const base = i * 6;
      this.positions[base] = x;
      this.positions[base + 1] = y;
      this.positions[base + 2] = z;
      this.positions[base + 3] = x + this.streakX;
      this.positions[base + 4] = y + this.streakY;
      this.positions[base + 5] = z + this.streakZ;
    }
    this.dirty = false;
    this.positionAttribute.needsUpdate = true;
  }

  /** 雨体积跟随相机水平位置；垂直方向固定贴地，避免随地形起伏飘走。 */
  follow(camera: THREE.Camera): void {
    this.object.position.set(camera.position.x, 0, camera.position.z);
  }

  dispose(): void {
    this.object.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
