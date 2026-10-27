/**
 * 太阳与环境光 —— 全场景唯一的太阳方向光，以及夜间可读性所需的半球光与环境光。
 *
 * 职责边界：
 *  - 光源强度、颜色、方向全部来自环境采样，本文件不决定天气与时间；
 *  - 阴影相机只覆盖玩家附近的有界区域，跟随焦点平移而不是笼罩整座城市；
 *  - 太阳降到地平线以下时停止投影更新（`shadow.autoUpdate = false`，不再渲染阴影贴图）
 *    并把阴影强度归零；刻意保留 `castShadow` 不切换，避免光源数量变化触发整场着色器重编译；
 *  - 一个场景只有这一盏太阳光，不为建筑分别创建，也不新增月光投影。
 */

import * as THREE from 'three';
import { ENVIRONMENT, type ShadowQuality } from '../../content/config';
import type { EnvironmentSample } from '../../features/environment';

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value >= edge1 ? 1 : 0;
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export class SunRig {
  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly ambient: THREE.AmbientLight;
  /** 该质量档是否允许投影（`off` 档为 false）。 */
  private readonly shadowsAvailable: boolean;
  /** 当前是否真的在投影；用回滞避免太阳在阈值附近反复开关。 */
  private shadowsOn = false;

  constructor(scene: THREE.Scene, quality: ShadowQuality) {
    this.shadowsAvailable = quality !== 'off';

    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.castShadow = this.shadowsAvailable;
    this.sun.target.position.set(0, 0, 0);

    const level = ENVIRONMENT.shadow.levels[quality];
    if (this.shadowsAvailable) {
      const shadow = this.sun.shadow;
      shadow.mapSize.set(level.mapSize, level.mapSize);
      shadow.camera.left = -level.extent;
      shadow.camera.right = level.extent;
      shadow.camera.top = level.extent;
      shadow.camera.bottom = -level.extent;
      shadow.camera.near = ENVIRONMENT.shadow.near;
      shadow.camera.far = ENVIRONMENT.shadow.far;
      shadow.bias = level.bias;
      shadow.normalBias = level.normalBias;
      shadow.camera.updateProjectionMatrix();
    }

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x74805f, 1);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.16);

    scene.add(this.sun, this.sun.target, this.hemi, this.ambient);
    this.shadowsOn = this.shadowsAvailable;
    this.sun.castShadow = this.shadowsAvailable;
  }

  /**
   * 应用一帧采样。`focusX / focusZ` 是阴影区域中心（玩家位置），
   * 光源与目标一起平移，因此阴影范围始终贴着玩家，而不是固定在原点。
   */
  update(sample: EnvironmentSample, focusX: number, focusZ: number): void {
    const distance = ENVIRONMENT.sun.lightDistance;
    this.sun.position.set(
      focusX + sample.sunDirectionX * distance,
      sample.sunDirectionY * distance,
      focusZ + sample.sunDirectionZ * distance,
    );
    this.sun.target.position.set(focusX, 0, focusZ);
    this.sun.color.setHex(sample.sunColor);
    this.sun.intensity = sample.sunIntensity;

    this.hemi.color.setHex(sample.hemiSky);
    this.hemi.groundColor.setHex(sample.hemiGround);
    this.hemi.intensity = sample.hemiIntensity;
    this.ambient.intensity = sample.ambientIntensity;

    if (!this.shadowsAvailable) {
      this.sun.castShadow = false;
      return;
    }

    const cfg = ENVIRONMENT.shadow;
    const elevation = sample.sunElevation;
    // 两个阈值：升到 disable 之上才恢复、降到 disable − 0.03 以下才停止，避免来回抖动
    const shouldUpdate =
      this.shadowsOn
        ? elevation >= cfg.disableElevationRad - 0.03
        : elevation >= cfg.disableElevationRad;
    if (shouldUpdate !== this.shadowsOn) {
      this.shadowsOn = shouldUpdate;
      // 夜晚不再渲染阴影贴图（关闭更新），白天恢复渲染并立刻重画一次
      this.sun.shadow.autoUpdate = shouldUpdate;
      this.sun.shadow.needsUpdate = shouldUpdate;
    }

    // 低太阳高度时逐步减弱阴影对比，避免无限长阴影与条纹
    this.sun.shadow.intensity = this.shadowsOn
      ? smoothstep(cfg.disableElevationRad, cfg.fullElevationRad, elevation)
      : 0;
  }

  dispose(): void {
    this.sun.removeFromParent();
    this.sun.target.removeFromParent();
    this.hemi.removeFromParent();
    this.ambient.removeFromParent();
    if (this.shadowsAvailable) this.sun.shadow.dispose();
    this.sun.dispose();
    this.hemi.dispose();
    this.ambient.dispose();
  }
}
