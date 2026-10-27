/**
 * 环境控制器 —— 天空、太阳、雾与降雨的唯一生命周期与更新入口。
 *
 * 职责边界：
 *  - 读取显式传入的环境采样（普通数字）与天气切片，**不导入 GameStore**、
 *    不读完整业务状态、不决定天气调度与时间推进；
 *  - 全场景一套环境对象：一个太阳、一份雾、一份天空、一份雨体积，
 *    不按建筑或城区复制；
 *  - 所有 GPU 资源在这里创建，也在这里销毁；运行期只改数值，不重建材质与缓冲。
 */

import * as THREE from 'three';
import { ENVIRONMENT, type ShadowQuality } from '../../content/config';
import {
  createEnvironmentSample,
  sampleEnvironment,
  type EnvironmentSample,
  type ReadonlyEnvironmentState,
} from '../../features/environment';
import { RainField } from './rain';
import { SkyDome } from './sky';
import { SunRig } from './sun';

/**
 * 选择阴影档位。
 *
 * 默认取配置里的保守档；小屏或低核心设备降到低档（只降低阴影分辨率/范围与雨量，
 * 不改任何玩法与判定）。`off` 档保持关闭，不会被自动升档。
 */
function resolveQuality(): ShadowQuality {
  const cfg = ENVIRONMENT.shadow;
  if (cfg.quality === 'off') return 'off';
  const downgrade = cfg.autoDowngrade;
  const smallScreen = window.innerWidth <= downgrade.maxWidth;
  const cores = navigator.hardwareConcurrency ?? 8;
  return smallScreen || cores <= downgrade.maxHardwareConcurrency ? downgrade.quality : cfg.quality;
}

export class EnvironmentRig {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly sky: SkyDome;
  private readonly sun: SunRig;
  private readonly rain: RainField;
  private readonly fog: THREE.Fog;
  private readonly background: THREE.Color;
  /** 复用的采样缓冲：渲染循环里不产生每帧分配。 */
  private readonly sample: EnvironmentSample = createEnvironmentSample();
  /** 由城市边界推导的基础雾距离；天气只在其上做倍率修饰。 */
  private fogBaseNear = 70;
  private fogBaseFar = 165;

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    camera: THREE.PerspectiveCamera,
  ) {
    this.scene = scene;
    this.camera = camera;
    const quality = resolveQuality();

    // 阴影开关必须在任何材质编译前确定：运行期改它会导致整场重新编译
    renderer.shadowMap.enabled = quality !== 'off';
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.fog = new THREE.Fog(0x9aa3a8, this.fogBaseNear, this.fogBaseFar);
    scene.fog = this.fog;
    this.background = new THREE.Color(0x9aa3a8);
    scene.background = this.background;

    this.sky = new SkyDome();
    this.rain = new RainField(quality);
    this.sun = new SunRig(scene, quality);
    scene.add(this.sky.root, this.rain.object);

    // 首帧兜底：即使 app 层还没来得及推送状态，画面也不是全黑
    this.update(0, 0, {
      weather: ENVIRONMENT.weather.initial,
      previousWeather: ENVIRONMENT.weather.initial,
      changedAtMinute: 0,
      endsAtMinute: 0,
      randomState: ENVIRONMENT.weather.seed,
    }, 0, 0);
  }

  /** 城市边界变化后更新基础雾距离（只改基数，不上报天气）。 */
  setFogBase(near: number, far: number): void {
    if (Number.isFinite(near) && near > 0) this.fogBaseNear = near;
    if (Number.isFinite(far) && far > this.fogBaseNear) this.fogBaseFar = far;
  }

  /**
   * 应用到 `minute` 为止的环境。
   *
   * `minute` 允许带不足一分钟的余量（只用于视觉平滑）；`dtSeconds` 是表现用时间，
   * 暂停时传 0 —— 雨滴随之冻结，但天空与光照保持当前状态不变。
   */
  update(
    minute: number,
    dtSeconds: number,
    weather: ReadonlyEnvironmentState,
    focusX: number,
    focusZ: number,
  ): void {
    const sample = sampleEnvironment(weather, minute, this.sample);
    this.sky.update(sample);
    this.sun.update(sample, focusX, focusZ);
    this.rain.update(dtSeconds, sample.rainAmount);

    this.fog.color.setHex(sample.fogColor);
    this.fog.near = Math.max(1, this.fogBaseNear * sample.fogNearScale);
    this.fog.far = Math.max(this.fog.near + 6, this.fogBaseFar * sample.fogFarScale);
    this.background.setHex(sample.skyHorizon);
  }

  /** 渲染前调用：天空穹顶与雨体积跟随相机，保持世界方向不变。 */
  followCamera(): void {
    this.sky.follow(this.camera);
    this.rain.follow(this.camera);
  }

  dispose(): void {
    this.sky.dispose();
    this.rain.dispose();
    this.sun.dispose();
    if (this.scene.fog === this.fog) this.scene.fog = null;
    if (this.scene.background === this.background) this.scene.background = null;
  }
}
