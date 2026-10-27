/**
 * 天空表现 —— 渐变穹顶、星空与太阳光晕。
 *
 * 职责边界：
 *  - 只读 `EnvironmentSample`（普通数字）并画出来，不读业务状态、不决定天气与时间；
 *  - 不新增第二个渲染器、不做后期处理、不生成环境贴图（本项目没有 IBL 需求）；
 *  - 穹顶跟随相机平移但不跟随旋转，因此世界方向保持不变；顶点色只在颜色变化时重算。
 */

import * as THREE from 'three';
import { ENVIRONMENT } from '../../content/config';
import type { EnvironmentSample } from '../../features/environment';

const scratchTop = new THREE.Color();
const scratchHorizon = new THREE.Color();
const scratchGround = new THREE.Color();

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothstep01(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

/** 太阳光晕贴图：一次生成的径向渐变，运行期只改颜色与不透明度。 */
function makeGlowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.35, 'rgba(255, 250, 235, 0.55)');
    gradient.addColorStop(1, 'rgba(255, 245, 220, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 天空整体（穹顶 + 星空 + 日盘光晕），由环境控制器持有并跟随相机。 */
export class SkyDome {
  /** 跟随相机平移的根节点：子物体的局部坐标即世界方向。 */
  readonly root = new THREE.Group();

  private readonly geometry: THREE.SphereGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly colorAttribute: THREE.BufferAttribute;
  private readonly colorArray: Float32Array;
  private readonly starGeometry: THREE.BufferGeometry;
  private readonly starMaterial: THREE.PointsMaterial;
  private readonly glowMaterial: THREE.SpriteMaterial;
  private readonly glowTexture: THREE.CanvasTexture;
  private readonly glow: THREE.Sprite;

  private lastTop = Number.NaN;
  private lastHorizon = Number.NaN;
  private lastGround = Number.NaN;

  constructor() {
    const cfg = ENVIRONMENT.sky;
    this.geometry = new THREE.SphereGeometry(cfg.radius, cfg.segmentsX, cfg.segmentsY);
    const vertexCount = this.geometry.getAttribute('position').count;
    this.colorArray = new Float32Array(vertexCount * 3);
    this.colorAttribute = new THREE.BufferAttribute(this.colorArray, 3);
    this.colorAttribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('color', this.colorAttribute);
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    });
    const dome = new THREE.Mesh(this.geometry, this.material);
    dome.renderOrder = -10;
    dome.frustumCulled = false;

    this.starGeometry = new THREE.BufferGeometry();
    const starCfg = ENVIRONMENT.stars;
    const positions = new Float32Array(starCfg.count * 3);
    for (let i = 0; i < starCfg.count; i += 1) {
      // 只在地平线以上撒点：镜头下方的天空由地面挡住，撒了也看不见，纯属浪费顶点
      const y = 0.03 + Math.random() * 0.97;
      const theta = Math.random() * Math.PI * 2;
      const horizontal = Math.sqrt(Math.max(0, 1 - y * y));
      positions[i * 3] = Math.cos(theta) * horizontal * starCfg.radius;
      positions[i * 3 + 1] = y * starCfg.radius;
      positions[i * 3 + 2] = Math.sin(theta) * horizontal * starCfg.radius;
    }
    this.starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.starMaterial = new THREE.PointsMaterial({
      color: starCfg.color,
      size: starCfg.size * Math.min(window.devicePixelRatio, 2),
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    });
    const stars = new THREE.Points(this.starGeometry, this.starMaterial);
    stars.renderOrder = -9;
    stars.frustumCulled = false;

    this.glowTexture = makeGlowTexture();
    this.glowMaterial = new THREE.SpriteMaterial({
      map: this.glowTexture,
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    });
    this.glow = new THREE.Sprite(this.glowMaterial);
    this.glow.scale.setScalar(cfg.glowSize);
    this.glow.renderOrder = -8;

    this.root.add(dome, stars, this.glow);
  }

  /** 按采样结果更新颜色、星空与日盘；稳态（暂停、天气不变）时几乎不做事。 */
  update(sample: EnvironmentSample): void {
    this.applyColors(sample.skyTop, sample.skyHorizon, sample.skyGround);

    this.starMaterial.opacity = clamp01(sample.starOpacity) * 0.9;
    this.starMaterial.visible = this.starMaterial.opacity > 0.01;

    const glowStrength =
      clamp01(sample.sunVisibility) * (0.25 + 0.75 * clamp01(sample.sunIntensity / 1.1));
    this.glowMaterial.opacity = ENVIRONMENT.sky.glowOpacity * glowStrength;
    this.glowMaterial.color.setHex(sample.sunColor);
    this.glow.visible = this.glowMaterial.opacity > 0.01;
    if (this.glow.visible) {
      const distance = ENVIRONMENT.sky.radius * 0.9;
      this.glow.position.set(
        sample.sunDirectionX * distance,
        sample.sunDirectionY * distance,
        sample.sunDirectionZ * distance,
      );
    }
  }

  /** 穹顶跟随相机平移（不跟随旋转），相机旋转时世界方向仍然正确。 */
  follow(camera: THREE.Camera): void {
    this.root.position.copy(camera.position);
  }

  /**
   * 重算穹顶顶点色。
   *
   * 颜色由「地平线 → 天顶」「地平线 → 地面」两段插值得到，不依赖贴图，
   * 因此没有贴图寻址、接缝或拉伸问题；同一组颜色不会重复上传缓冲。
   */
  private applyColors(top: number, horizon: number, ground: number): void {
    if (top === this.lastTop && horizon === this.lastHorizon && ground === this.lastGround) return;
    this.lastTop = top;
    this.lastHorizon = horizon;
    this.lastGround = ground;

    scratchTop.setHex(top);
    scratchHorizon.setHex(horizon);
    scratchGround.setHex(ground);

    const position = this.geometry.getAttribute('position');
    const radius = ENVIRONMENT.sky.radius;
    const array = this.colorArray;
    for (let i = 0; i < position.count; i += 1) {
      const normalizedY = position.getY(i) / radius;
      const toTop = normalizedY >= 0 ? smoothstep01(normalizedY / 0.85) : 0;
      const toGround = normalizedY < 0 ? smoothstep01(-normalizedY / 0.45) : 0;
      const base = scratchHorizon;
      const target = normalizedY >= 0 ? scratchTop : scratchGround;
      const k = normalizedY >= 0 ? toTop : toGround;
      array[i * 3] = base.r + (target.r - base.r) * k;
      array[i * 3 + 1] = base.g + (target.g - base.g) * k;
      array[i * 3 + 2] = base.b + (target.b - base.b) * k;
    }
    this.colorAttribute.needsUpdate = true;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.starGeometry.dispose();
    this.starMaterial.dispose();
    this.glowMaterial.dispose();
    this.glowTexture.dispose();
  }
}
