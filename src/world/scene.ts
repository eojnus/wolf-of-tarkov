/**
 * 城市场景搭建 —— 按逻辑地图（layout）生成地面、道路、建筑与标识。
 *
 * 职责边界：
 *  - 本文件只读 `features/city-layout` 的只读视图，不写回逻辑地图，也不读写经济状态；
 *  - 场景实例按稳定 id 增量同步（`CityScene.syncLayout`）：新增的建、移除的销毁，
 *    几何指纹不变的只更新交互数据，**不整场重建**；
 *  - 每栋楼先用程序化占位外观建立实例（标签、门前广场、旧便利店内景都在这里），
 *    模块化楼体由 world 向工厂请求后经 `attachBuildingVisual` 挂上：
 *    成功即隐藏占位，加载中或**明确失败**时才继续显示占位；
 *  - 楼体的位置与朝向由 `visual.group` 持有（`handle.group` 本身不带变换），
 *    `visual.envelope` 原位写入 `handle.collider`，**不替换 collider 对象引用**；
 *  - 释放只有一个入口 `releaseBuildingHandle`：先释放并摘除 visual，再释放本楼独有的
 *    占位与标签；不得让 `disposeObject(this.scene)` 遍历到别栋共享的材质与贴图。
 */

import * as THREE from 'three';
import { CAMERA } from '../content/config';
import type {
  CityLayoutView,
  LayoutBounds,
  LayoutBuilding,
  LayoutRoad,
} from '../features/city-layout';
import {
  type BuildingVisual,
  type BuildingVisualFactory,
  entranceAxis,
  entranceRotationY,
} from './buildings';

/**
 * 建筑碰撞盒（世界坐标 AABB）。
 *
 * 模块化楼体挂载后就地更新为声明包络；读取方（人物碰撞、摄像机遮挡、交互距离）
 * 只当作只读数据使用，不得自行修改。
 */
export interface Collider {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number;
  maxY: number;
}

/** 单栋楼的视觉状态（仅内存，不写存档）。 */
export type BuildingVisualState = 'pending' | 'ready' | 'placeholder';

export interface BuildingHandle {
  /**
   * 布局建筑快照。几何不变而业务字段（交互 id / shopId / companyId / 可用性 / 名称）变化时，
   * 场景保留实例并更新该引用；几何（含商店招牌文字）变化则整个 handle 被替换。
   */
  building: LayoutBuilding;
  readonly collider: Collider;
  readonly group: THREE.Group;
  /** 程序化占位外观（含门前广场、旧便利店内景）。挂上新楼体后隐藏，失败时保留。 */
  readonly placeholder: THREE.Group;
  /**
   * 标签精灵。名称 / 副标题 / 可用性变化时**就地换一张**（旧精灵的材质与画布贴图随即释放），
   * 楼体、碰撞盒与 visual 都不动。
   */
  label: THREE.Sprite;
  /** 仅内存：当前挂载的模块化楼体；null 表示加载中或已降级。 */
  visual: BuildingVisual | null;
  /** 仅内存：当前 visual 的视觉指纹；与请求指纹不一致的结果一律丢弃。 */
  visualKey: string | null;
  /** 仅内存：本栋视觉状态，供诊断与报告使用。 */
  visualState: BuildingVisualState;
}

export interface CityScene {
  readonly scene: THREE.Scene;
  /** 当前布局对应的建筑实例（顺序与 layout.buildings 一致）。 */
  readonly buildings: readonly BuildingHandle[];
  /** 按稳定 id 增量同步布局；幂等，不销毁重建整个场景。 */
  syncLayout(layout: CityLayoutView): void;
  dispose(): void;
}

const PALETTE = {
  ground: 0x93a884,
  road: 0x40454d,
  sidewalk: 0x9aa0a6,
  window: 0x9ec7de,
  door: 0x2f333a,
  curb: 0xd8dcdf,
  trunk: 0x6b5b45,
  leaf: 0x5f7f52,
};

const SKY_COLOR = 0xb8cddc;
const CROSS_ROAD_Z = 0;

export function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = (child as THREE.Mesh).material;
    if (Array.isArray(material)) {
      for (const item of material) item.dispose();
    } else if (material) {
      const withMap = material as THREE.MeshStandardMaterial;
      withMap.map?.dispose();
      material.dispose();
    }
  });
}

/**
 * 圆角矩形路径。`CanvasRenderingContext2D.roundRect` 在旧版 Chromium（如 Edge 92）
 * 中不存在；这里用 arcTo 提供等价回退，避免整个游戏初始化直接失败。
 */
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, radius);
    return;
  }
  const r = Math.min(radius, width / 2, height / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function makeBuildingLabel(building: LayoutBuilding): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 160;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    const texture = new THREE.CanvasTexture(canvas);
    return new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const radius = 26;
  const padding = 6;
  ctx.beginPath();
  roundedRectPath(ctx, padding, padding, canvas.width - padding * 2, canvas.height - padding * 2, radius);
  ctx.fillStyle = building.available ? 'rgba(18, 24, 32, 0.82)' : 'rgba(38, 42, 47, 0.72)';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = building.available ? 'rgba(126, 200, 255, 0.85)' : 'rgba(160, 168, 176, 0.5)';
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = building.available ? '#ffffff' : '#b9c0c7';
  ctx.font = '600 54px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
  ctx.fillText(building.name, canvas.width / 2, 64);
  ctx.fillStyle = building.available ? 'rgba(190, 214, 235, 0.92)' : 'rgba(160, 168, 176, 0.85)';
  ctx.font = '400 30px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
  ctx.fillText(building.subtitle, canvas.width / 2, 116);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(8.4, 2.6, 1);
  sprite.renderOrder = 20;
  return sprite;
}

/** 释放标签精灵独有的材质与画布贴图（标签不共享，换一张就要清掉旧的）。 */
function disposeLabel(label: THREE.Sprite): void {
  label.material.map?.dispose();
  label.material.dispose();
}

/**
 * 就地刷新标签：名称 / 副标题 / 可用性变化时只换这一张精灵。
 *
 * 楼体、`visual`、`collider` 对象与楼层高度都不动；新精灵沿用旧精灵的世界位置，
 * 因此「挂上楼体后抬到 envelope.maxY + 2.6」的结果不会被这次刷新改回去。
 */
function refreshBuildingLabel(handle: BuildingHandle): void {
  const next = makeBuildingLabel(handle.building);
  next.position.copy(handle.label.position);
  handle.group.remove(handle.label);
  disposeLabel(handle.label);
  handle.label = next;
  handle.group.add(next);
}

/* -------------------------------------------------------------- 便利店 */

/**
 * 便利店比例（米）。
 *
 * 配置只给出总包围盒（16 × 6.4 × 12），这里拆成真实楼层：
 * 0.5 基座 + 3.7 米室内净高 + 0.15 米天花 + 招牌女儿墙 + 0.22 米压顶 = 6.4 米。
 * 正立面固定建在本地 -Z 侧，最后整体旋转到入口点方向；碰撞体仍是配置 AABB。
 */
const SHOP = {
  baseHeight: 0.5,
  wallThickness: 0.25,
  /** 天花板底面，也就是室内净高上沿（0.5 + 3.7 = 4.2）。 */
  interiorTop: 4.2,
  /** 天花板顶面。 */
  ceilingTop: 4.35,
  /** 玻璃与门洞上沿。 */
  openingTop: 2.7,
  doorWidth: 2,
  doorPostWidth: 0.15,
  signWidth: 8.2,
  signHeight: 1.25,
  signCenterY: 4.95,
} as const;

/** 招牌贴图：深青底 + 白字 + 暖色 24H 角标，白天靠对比、夜间靠自发光。 */
function makeShopSignTexture(name: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 160;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    ctx.fillStyle = '#0e4f55';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(126, 224, 224, 0.18)';
    ctx.fillRect(0, 0, canvas.width, 16);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
    ctx.fillRect(0, canvas.height - 14, canvas.width, 14);

    // 左侧 24H 角标
    const badgeW = 116;
    const badgeH = 92;
    ctx.beginPath();
    roundedRectPath(ctx, 30, (canvas.height - badgeH) / 2, badgeW, badgeH, 16);
    ctx.fillStyle = '#ffcf5c';
    ctx.fill();
    ctx.fillStyle = '#123c40';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 56px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
    ctx.fillText('24H', 30 + badgeW / 2, canvas.height / 2);

    // 店名
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 78px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
    ctx.fillText(name, 186, canvas.height / 2 + 2);

    // 右侧装饰竖条
    ctx.fillStyle = 'rgba(126, 224, 224, 0.55)';
    ctx.fillRect(canvas.width - 44, 34, 8, canvas.height - 68);
    ctx.fillRect(canvas.width - 26, 34, 8, canvas.height - 68);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * 便利店程序化外观与基础室内。
 *
 * 新区的便利店分店同样走这里：外观只依赖尺寸/颜色/名称，不依赖具体城区。
 * 室内只用于透过橱窗被看见，不承担进入玩法。
 */
function buildShopBuilding(building: LayoutBuilding): BuildingHandle {
  const { width, height, depth } = building.size;
  // 本地正面为 -Z：与模块化楼体（局部 +Z 为正面）差 π
  const rotationY = entranceRotationY(building) + Math.PI;

  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const wallT = SHOP.wallThickness;
  const baseH = SHOP.baseHeight;
  const frontZ = -halfDepth + wallT / 2;
  const glassZ = -halfDepth + 0.14;
  const frameZ = -halfDepth + 0.1;
  const upperFaceZ = -(depth - 0.3) / 2;
  const capHeight = 0.22;
  const upperHeight = Math.max(0.4, height - capHeight - SHOP.ceilingTop);
  const signCenterY = Math.min(
    Math.max(SHOP.interiorTop + 0.7, SHOP.signCenterY),
    height - SHOP.signHeight / 2 - 0.1,
  );

  /* 10 个网格材质：墙面（兼作天花）/ 深色框架 / 玻璃 / 室内地板 / 货架 /
     商品两色 / 招牌 / 灯光 / 门前铺装。总三角面约 1900，远低于预算。 */
  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0xeef1f2,
    roughness: 0.78,
    metalness: 0.05,
  });
  const frameMaterial = new THREE.MeshStandardMaterial({
    color: 0x2b3238,
    roughness: 0.42,
    metalness: 0.5,
  });
  const glassMaterial = new THREE.MeshStandardMaterial({
    color: 0xa9d4df,
    roughness: 0.1,
    metalness: 0.1,
    transparent: true,
    opacity: 0.26,
    emissive: new THREE.Color(0x17333a),
    emissiveIntensity: 0.25,
    depthWrite: false,
  });
  const floorMaterial = new THREE.MeshStandardMaterial({ color: 0xcfc8ba, roughness: 0.9 });
  const shelfMaterial = new THREE.MeshStandardMaterial({
    color: 0xdde2e5,
    roughness: 0.55,
    metalness: 0.25,
  });
  const productAMaterial = new THREE.MeshStandardMaterial({ color: 0xd9642c, roughness: 0.65 });
  const productBMaterial = new THREE.MeshStandardMaterial({ color: 0x2f8f8a, roughness: 0.65 });
  const pavingMaterial = new THREE.MeshStandardMaterial({ color: 0xb7bec4, roughness: 0.95 });
  const lightMaterial = new THREE.MeshStandardMaterial({
    color: 0xfff4dc,
    roughness: 0.35,
    emissive: new THREE.Color(0xffd694),
    emissiveIntensity: 1.1,
  });
  const signTexture = makeShopSignTexture(building.name);
  const signMaterial = new THREE.MeshStandardMaterial({
    map: signTexture,
    emissiveMap: signTexture,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0.65,
    roughness: 0.5,
    metalness: 0.05,
  });
  const productMaterials = [productAMaterial, productBMaterial];

  const placeholder = new THREE.Group();
  placeholder.position.set(building.position.x, 0, building.position.z);
  placeholder.rotation.y = rotationY;

  const box = (
    material: THREE.Material,
    size: readonly [number, number, number],
    position: readonly [number, number, number],
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.position.set(...position);
    mesh.receiveShadow = true;
    placeholder.add(mesh);
    return mesh;
  };

  /* ---------------------------------------------------- 基座、墙体、楼板 */
  box(wallMaterial, [width, baseH, depth], [0, baseH / 2, 0]);
  box(frameMaterial, [width + 0.06, 0.08, depth + 0.06], [0, baseH, 0]);

  const wallHeight = SHOP.interiorTop - baseH;
  const wallCenterY = baseH + wallHeight / 2;
  box(wallMaterial, [wallT, wallHeight, depth - wallT * 2], [-halfWidth + wallT / 2, wallCenterY, 0]);
  box(wallMaterial, [wallT, wallHeight, depth - wallT * 2], [halfWidth - wallT / 2, wallCenterY, 0]);
  box(wallMaterial, [width - wallT * 2, wallHeight, wallT], [0, wallCenterY, halfDepth - wallT / 2]);
  box(wallMaterial, [wallT, wallHeight, wallT], [-halfWidth + wallT / 2, wallCenterY, frontZ]);
  box(wallMaterial, [wallT, wallHeight, wallT], [halfWidth - wallT / 2, wallCenterY, frontZ]);

  // 玻璃上方的白色墙裙（2.7 → 4.2 米）
  box(
    wallMaterial,
    [width - wallT * 2, SHOP.interiorTop - SHOP.openingTop, wallT],
    [0, (SHOP.interiorTop + SHOP.openingTop) / 2, frontZ],
  );

  box(floorMaterial, [width - wallT * 2, 0.04, depth - wallT * 2], [0, baseH + 0.02, 0]);
  box(
    wallMaterial,
    [width, SHOP.ceilingTop - SHOP.interiorTop, depth],
    [0, (SHOP.ceilingTop + SHOP.interiorTop) / 2, 0],
  );

  /* ---------------------------------------------- 南立面：落地玻璃与正门 */
  const glassHeight = SHOP.openingTop - baseH - 0.2;
  const glassCenterY = baseH + 0.1 + glassHeight / 2;
  const glassInnerEdge = SHOP.doorWidth / 2 + SHOP.doorPostWidth;
  const glassSpan = halfWidth - wallT - glassInnerEdge;

  // 上下横挺
  box(frameMaterial, [width - wallT * 2, 0.1, 0.2], [0, baseH + 0.05, frameZ]);
  box(frameMaterial, [width - wallT * 2, 0.1, 0.2], [0, SHOP.openingTop - 0.05, frameZ]);

  // 两侧大玻璃
  for (const side of [-1, 1]) {
    box(glassMaterial, [glassSpan, glassHeight, 0.06], [side * (glassInnerEdge + glassSpan / 2), glassCenterY, glassZ]);
  }

  // 竖向分格（每侧两根，均分三跨）
  for (const k of [1, 2]) {
    const offset = glassInnerEdge + (glassSpan / 3) * k;
    for (const side of [-1, 1]) {
      box(
        frameMaterial,
        [0.12, SHOP.openingTop - baseH, 0.2],
        [side * offset, (SHOP.openingTop + baseH) / 2, frameZ],
      );
    }
  }

  // 正门（双扇玻璃推拉门，门洞 2.0 × 2.2 米，下沿在基座顶面）
  const doorPostX = SHOP.doorWidth / 2 + SHOP.doorPostWidth / 2;
  for (const side of [-1, 1]) {
    box(
      frameMaterial,
      [SHOP.doorPostWidth, SHOP.openingTop - baseH, 0.2],
      [side * doorPostX, (SHOP.openingTop + baseH) / 2, frameZ],
    );
    box(
      glassMaterial,
      [SHOP.doorWidth / 2 - 0.05, glassHeight, 0.06],
      [side * (SHOP.doorWidth / 4), glassCenterY, glassZ],
    );
  }
  box(frameMaterial, [SHOP.doorWidth + 0.3, 0.06, 0.4], [0, baseH + 0.03, -halfDepth + 0.15]);

  /* ------------------------------------------ 上部体量、招牌、雨棚与门前铺装 */
  box(
    wallMaterial,
    [width - 0.3, upperHeight, depth - 0.3],
    [0, SHOP.ceilingTop + upperHeight / 2, 0],
  );
  box(frameMaterial, [width + 0.3, capHeight, depth + 0.3], [0, height - capHeight / 2, 0]);

  box(frameMaterial, [SHOP.signWidth, SHOP.signHeight, 0.16], [0, signCenterY, upperFaceZ - 0.08]);
  const signFace = new THREE.Mesh(
    new THREE.PlaneGeometry(SHOP.signWidth - 0.3, SHOP.signHeight - 0.2),
    signMaterial,
  );
  signFace.position.set(0, signCenterY, upperFaceZ - 0.17);
  signFace.rotation.y = Math.PI;
  placeholder.add(signFace);

  // 雨棚（悬挑，不落地，避免与碰撞体语义混淆）
  box(frameMaterial, [width * 0.66, 0.14, 1.8], [0, 2.98, -halfDepth - 0.82]);
  box(frameMaterial, [width * 0.66, 0.22, 0.12], [0, 2.96, -halfDepth - 1.7]);
  for (const side of [-1, 1]) {
    box(lightMaterial, [1.2, 0.05, 0.5], [side * 2.6, 2.9, -halfDepth - 0.65]);
  }

  // 门前铺装与一级踏步：室外可走面控制在既有广场的高度（约 0.2 米），
  // 0.5 米的室内地面用门口一级踏步衔接，避免在人物可到达的区域立起高台。
  box(pavingMaterial, [11.5, 0.1, 4.2], [0, 0.15, -halfDepth - 2.0]);
  box(frameMaterial, [11.5, 0.02, 0.14], [0, 0.21, -halfDepth - 0.05]);
  box(frameMaterial, [11.5, 0.02, 0.14], [0, 0.21, -halfDepth - 3.9]);
  box(pavingMaterial, [2.8, 0.35, 0.5], [0, 0.175, -halfDepth - 0.27]);
  box(frameMaterial, [1.8, 0.02, 0.32], [0, 0.36, -halfDepth - 0.27]);

  /* ------------------------------------------------------------ 基础室内 */
  // 暖色灯带（吸顶发光板）
  for (const z of [-2.6, 0.4, 3.4]) {
    box(lightMaterial, [4.6, 0.08, 1.1], [0, SHOP.interiorTop - 0.06, z]);
  }

  // 三排货架：底板 + 两端立板 + 三层层板 + 彩色商品小盒
  const shelfRows = [-1.6, 0.6, 2.8];
  const shelfLength = 8;
  const shelfCenterX = -1.2;
  const boardTops = [0.78, 1.2, 1.62];
  for (const rowZ of shelfRows) {
    box(shelfMaterial, [shelfLength, 0.1, 0.9], [shelfCenterX, baseH + 0.07, rowZ]);
    box(frameMaterial, [0.1, 1.5, 0.9], [shelfCenterX - shelfLength / 2 + 0.05, 1.25, rowZ]);
    box(frameMaterial, [0.1, 1.5, 0.9], [shelfCenterX + shelfLength / 2 - 0.05, 1.25, rowZ]);
    for (let level = 0; level < boardTops.length; level += 1) {
      const top = boardTops[level];
      box(shelfMaterial, [shelfLength - 0.2, 0.06, 0.9], [shelfCenterX, top - 0.03, rowZ]);
      for (let item = 0; item < 8; item += 1) {
        const itemWidth = item % 2 === 0 ? 0.36 : 0.3;
        const itemHeight = level === 1 ? 0.34 : 0.26;
        const itemX = shelfCenterX - shelfLength / 2 + 0.55 + (item * (shelfLength - 1.1)) / 7;
        box(
          productMaterials[(item + level) % 2],
          [itemWidth, itemHeight, 0.5],
          [itemX, top + itemHeight / 2, rowZ],
        );
      }
    }
  }

  // 后墙背柜 / 冷柜：深色框架 + 玻璃门 + 内部两层商品
  const cabinetCenterZ = halfDepth - wallT - 0.32;
  const cabinetWidth = 9;
  box(frameMaterial, [cabinetWidth + 0.2, 2.2, 0.1], [0, 1.6, cabinetCenterZ + 0.28]);
  box(frameMaterial, [cabinetWidth + 0.2, 0.1, 0.68], [0, 2.66, cabinetCenterZ]);
  box(frameMaterial, [cabinetWidth + 0.2, 0.1, 0.68], [0, 0.55, cabinetCenterZ]);
  for (const side of [-1, 1]) {
    box(frameMaterial, [0.1, 2.2, 0.68], [side * (cabinetWidth / 2 + 0.05), 1.6, cabinetCenterZ]);
  }
  for (const shelfY of [1.15, 1.65]) {
    box(shelfMaterial, [cabinetWidth, 0.05, 0.6], [0, shelfY, cabinetCenterZ]);
  }
  for (const x of [-3, 0, 3]) {
    box(glassMaterial, [2.86, 1.8, 0.05], [x, 1.6, cabinetCenterZ - 0.34]);
  }
  for (const x of [-4.55, -1.5, 1.5, 4.55]) {
    box(frameMaterial, [0.1, 2.2, 0.14], [x, 1.6, cabinetCenterZ - 0.3]);
  }
  for (const shelfTop of [1.175, 1.675]) {
    for (let item = 0; item < 5; item += 1) {
      const itemHeight = 0.24 + (item % 2) * 0.06;
      box(
        productMaterials[item % 2],
        [0.42, itemHeight, 0.4],
        [-3.6 + item * 1.8, shelfTop + itemHeight / 2, cabinetCenterZ + 0.02],
      );
    }
  }

  // 收银台（靠右前方）与台面设备
  const counterX = halfWidth - 2.3;
  const counterZ = -3.6;
  box(wallMaterial, [1.0, 0.98, 3.0], [counterX, baseH + 0.49, counterZ]);
  box(shelfMaterial, [1.16, 0.08, 3.16], [counterX, baseH + 1.02, counterZ]);
  box(frameMaterial, [0.44, 0.3, 0.4], [counterX, baseH + 1.21, counterZ - 0.85]);
  box(frameMaterial, [0.38, 0.54, 0.38], [counterX, baseH + 1.33, counterZ + 1.0]);
  box(glassMaterial, [0.4, 0.24, 0.04], [counterX, baseH + 1.48, counterZ - 0.85]);

  const label = makeBuildingLabel(building);
  label.position.set(building.position.x, height + 2.6, building.position.z);

  const group = new THREE.Group();
  group.add(placeholder, label);
  group.userData.buildingId = building.id;

  // 碰撞体严格等于配置包围盒：装饰不参与阻挡（新楼体挂载后改为声明包络，数值相同）
  return makeHandle(building, group, placeholder, label);
}

function buildBuilding(building: LayoutBuilding): BuildingHandle {
  if (building.kind === 'shop') return buildShopBuilding(building);

  const { width, height, depth } = building.size;
  const { axis, sign } = entranceAxis(building);

  const material = new THREE.MeshStandardMaterial({
    color: building.color,
    roughness: 0.82,
    metalness: 0.06,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  body.position.set(building.position.x, height / 2, building.position.z);
  body.castShadow = false;
  body.receiveShadow = true;

  // 檐口
  const corniceMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(building.color).multiplyScalar(1.14),
    roughness: 0.7,
  });
  const cornice = new THREE.Mesh(
    new THREE.BoxGeometry(width + 0.9, 0.45, depth + 0.9),
    corniceMaterial,
  );
  cornice.position.set(building.position.x, height + 0.18, building.position.z);

  // 正面：门与窗
  const frontWidth = axis === 'x' ? depth : width;
  const faceCenter = new THREE.Vector3(building.position.x, 0, building.position.z);
  const normal = new THREE.Vector3(axis === 'x' ? sign : 0, 0, axis === 'z' ? sign : 0);
  const tangent = new THREE.Vector3(axis === 'x' ? 0 : 1, 0, axis === 'x' ? 1 : 0);
  const faceOffset = (axis === 'x' ? width : depth) / 2 + 0.06;

  const doorWidth = Math.min(2.6, frontWidth * 0.3);
  const doorMaterial = new THREE.MeshStandardMaterial({
    color: PALETTE.door,
    roughness: 0.5,
    metalness: 0.2,
  });
  const door = new THREE.Mesh(new THREE.BoxGeometry(doorWidth, 2.9, 0.24), doorMaterial);
  door.position.copy(faceCenter).addScaledVector(normal, faceOffset);
  door.position.y = 1.45;
  if (axis === 'z') door.rotation.y = Math.PI / 2;

  const windowMaterial = new THREE.MeshStandardMaterial({
    color: PALETTE.window,
    roughness: 0.28,
    metalness: 0.35,
    emissive: new THREE.Color(0x2c4a5c),
    emissiveIntensity: 0.35,
  });
  const windows = new THREE.Group();
  const rows = Math.max(1, Math.floor((height - 3.4) / 2.9));
  const cols = Math.max(2, Math.floor(frontWidth / 2.6));
  const windowWidth = 1.15;
  const windowHeight = 1.45;
  const gapX = (frontWidth - cols * windowWidth) / (cols + 1);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const pane = new THREE.Mesh(
        new THREE.BoxGeometry(windowWidth, windowHeight, 0.16),
        windowMaterial,
      );
      const offset = -frontWidth / 2 + gapX + windowWidth / 2 + col * (windowWidth + gapX);
      pane.position
        .copy(faceCenter)
        .addScaledVector(normal, faceOffset)
        .addScaledVector(tangent, offset);
      pane.position.y = 4.1 + row * 2.9;
      if (axis === 'z') pane.rotation.y = Math.PI / 2;
      windows.add(pane);
    }
  }

  // 入口台阶与引导小路
  const plazaMaterial = new THREE.MeshStandardMaterial({
    color: PALETTE.curb,
    roughness: 0.95,
  });
  const plaza = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.16, 5.2), plazaMaterial);
  plaza.position.set(building.entrance.x, 0.08, building.entrance.z);

  const label = makeBuildingLabel(building);
  label.position.set(building.position.x, height + 2.6, building.position.z);

  const group = new THREE.Group();
  const placeholder = new THREE.Group();
  placeholder.add(body, cornice, door, windows, plaza);
  group.add(placeholder, label);
  group.userData.buildingId = building.id;

  return makeHandle(building, group, placeholder, label);
}

/**
 * 建立一个楼宇 handle：占位外观 + 标签 + 与规划占地相同的临时碰撞盒。
 *
 * 临时碰撞盒等于布局给的 AABB，模块化楼体挂载后会用声明包络原地覆盖
 * （数值相同，但保证「碰撞只由规划尺寸决定」这一条在代码里只有一处来源）。
 */
function makeHandle(
  building: LayoutBuilding,
  group: THREE.Group,
  placeholder: THREE.Group,
  label: THREE.Sprite,
): BuildingHandle {
  const { width, height, depth } = building.size;
  const collider: Collider = {
    minX: building.position.x - width / 2,
    maxX: building.position.x + width / 2,
    minZ: building.position.z - depth / 2,
    maxZ: building.position.z + depth / 2,
    minY: 0,
    maxY: height,
  };
  return { building, collider, group, placeholder, label, visual: null, visualKey: null, visualState: 'pending' };
}

/**
 * 挂上一栋楼的模块化楼体：挂载、隐藏占位、原位写入碰撞与标签高度。
 *
 * - 变换只应用一次：`visual.group` 自己带世界位置与朝向，`handle.group` 保持单位变换；
 * - 碰撞写的是**声明包络**（规划尺寸 + 朝向），不是装饰包围盒，也不扩大；
 * - `handle.collider` 对象引用不变，World 保存的 colliders 数组继续有效。
 */
export function attachBuildingVisual(handle: BuildingHandle, visual: BuildingVisual, key: string): void {
  const previous = handle.visual;
  if (previous && previous !== visual) previous.dispose();
  handle.visual = visual;
  handle.visualKey = key;
  handle.visualState = 'ready';
  handle.placeholder.visible = false;
  handle.group.add(visual.group);

  const envelope = visual.envelope;
  handle.collider.minX = envelope.minX;
  handle.collider.maxX = envelope.maxX;
  handle.collider.minZ = envelope.minZ;
  handle.collider.maxZ = envelope.maxZ;
  handle.collider.minY = envelope.minY;
  handle.collider.maxY = envelope.maxY;
  handle.label.position.set(
    handle.building.position.x,
    envelope.maxY + 2.6,
    handle.building.position.z,
  );
}

/** 摘下一栋楼的楼体并回到占位外观（指纹变了、或需要重新请求时使用）。 */
export function detachBuildingVisual(handle: BuildingHandle, factory: BuildingVisualFactory): void {
  if (handle.visual) factory.release(handle.visual);
  handle.visual = null;
  handle.visualKey = null;
  handle.visualState = 'pending';
  handle.placeholder.visible = true;
}

/**
 * 释放一栋楼 —— **唯一**的释放路径（删除、替换、整场销毁都走这里）。
 *
 * 顺序：先释放并摘除模块化楼体（只释放本楼几何与实例），再释放本楼独有的
 * 占位几何、门前广场与标签贴图。工厂的共享材质/贴图属于资产库，这里一概不碰。
 */
export function releaseBuildingHandle(handle: BuildingHandle, factory: BuildingVisualFactory): void {
  const visual = handle.visual;
  handle.visual = null;
  handle.visualKey = null;
  if (visual) factory.release(visual);
  handle.group.removeFromParent();
  disposeObject(handle.group);
  handle.group.clear();
}

/* ------------------------------------------------------------------ 道路 */

/** 道路视觉指纹：几何不变时保留实例。 */
function roadVisualKey(road: LayoutRoad): string {
  return [
    road.center.x,
    road.center.z,
    road.size.width,
    road.size.depth,
    road.width,
  ].join('|');
}

/**
 * 按逻辑道路矩形生成路面、人行道与车道虚线。
 *
 * 横向道路（宽 > 深）与纵向道路的铺装方式不同；人行道外扩按城区外边界裁剪，
 * 避免新区条带尽头出现悬空铺装。道路本身不参与碰撞。
 */
function buildRoad(road: LayoutRoad, bounds: LayoutBounds): THREE.Group {
  const group = new THREE.Group();
  const roadMaterial = new THREE.MeshStandardMaterial({ color: PALETTE.road, roughness: 0.95 });
  const walkMaterial = new THREE.MeshStandardMaterial({ color: PALETTE.sidewalk, roughness: 0.95 });
  const lineMaterial = new THREE.MeshStandardMaterial({ color: 0xe9edd8, roughness: 0.8 });

  const boundsDepth = bounds.maxZ - bounds.minZ;
  const horizontal = road.size.width >= road.size.depth;

  if (horizontal) {
    const walkDepth = Math.min(road.size.depth + 4.4, boundsDepth);
    const walk = new THREE.Mesh(
      new THREE.BoxGeometry(road.size.width, 0.08, walkDepth),
      walkMaterial,
    );
    walk.position.set(road.center.x, 0.05, road.center.z);
    const surface = new THREE.Mesh(
      new THREE.BoxGeometry(road.size.width, 0.1, road.size.depth),
      roadMaterial,
    );
    surface.position.set(road.center.x, 0.08, road.center.z);
    group.add(walk, surface);

    // 中央虚线：沿 x 铺；在纵向道路路口处断开
    const half = road.size.width / 2;
    for (let x = road.center.x - half + 3; x < road.center.x + half - 1; x += 6) {
      if (Math.abs(x - road.center.x) < road.size.depth / 2 + 1) continue;
      const dash = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.02, 0.28), lineMaterial);
      dash.position.set(x, 0.14, road.center.z);
      group.add(dash);
    }
  } else {
    const walkWidth = road.size.width + 4.4;
    const walkDepth = Math.min(road.size.depth + 4, boundsDepth);
    const walk = new THREE.Mesh(
      new THREE.BoxGeometry(walkWidth, 0.08, walkDepth),
      walkMaterial,
    );
    walk.position.set(road.center.x, 0.06, road.center.z);
    const surface = new THREE.Mesh(
      new THREE.BoxGeometry(road.size.width, 0.1, road.size.depth),
      roadMaterial,
    );
    surface.position.set(road.center.x, 0.08, road.center.z);
    group.add(walk, surface);

    // 中央虚线：沿 z 铺；与东西主路（所有模板都在 z = 0）交叉处断开
    const half = road.size.depth / 2;
    for (let z = road.center.z - half + 3; z < road.center.z + half - 1; z += 6) {
      if (Math.abs(z - CROSS_ROAD_Z) < road.width / 2 + 1) continue;
      const dash = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.02, 2.6), lineMaterial);
      dash.position.set(road.center.x, 0.14, z);
      group.add(dash);
    }
  }

  return group;
}

function buildTrees(): THREE.Group {
  const group = new THREE.Group();
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: PALETTE.trunk, roughness: 1 });
  const leafMaterial = new THREE.MeshStandardMaterial({ color: PALETTE.leaf, roughness: 1 });
  const positions: Array<[number, number]> = [
    [-9, -30],
    [9, -30],
    [-9, -8],
    [9, -8],
    [-9, 10],
    [9, 10],
    [-9, 30],
    [9, 30],
    [-34, 6],
    [-34, -14],
    [34, 6],
    [34, -14],
  ];
  for (const [x, z] of positions) {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 2.4, 6), trunkMaterial);
    trunk.position.set(x, 1.2, z);
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1.5, 0), leafMaterial);
    crown.position.set(x, 3.4, z);
    group.add(trunk, crown);
  }
  return group;
}

/* ------------------------------------------------------------------ 场景 */

/**
 * 楼体几何指纹：只有会改变**楼体几何与材质**的输入才重建实例。
 *
 * 位置、尺寸、入口朝向、kind、占位配色、旧模型字段，外加**商店名称**——
 * 商店名称是新楼体的门头招牌文字，属于真实视觉输入；改名必须重挂楼体（连带占位里的旧招牌）。
 * 交互 id、shopId、companyId、可用性、非商店的名称/副标题都不在这里：那些只刷新标签。
 */
function buildingGeometryKey(building: LayoutBuilding): string {
  return [
    building.position.x,
    building.position.z,
    building.size.width,
    building.size.height,
    building.size.depth,
    building.entrance.x,
    building.entrance.z,
    building.kind,
    building.color,
    building.model ?? '',
    building.modelScaleKey ?? '',
    // 招牌文字只对商店有意义；其他设施改名不影响楼体
    building.kind === 'shop' ? building.name : '',
  ].join('|');
}

/** 标签指纹：名称 / 副标题 / 可用性变了就地换标签，不动楼体与碰撞。 */
function buildingLabelKey(building: LayoutBuilding): string {
  return [building.name, building.subtitle, building.available ? 1 : 0].join('|');
}

interface RoadHandle {
  readonly group: THREE.Group;
  readonly key: string;
}

class CitySceneImpl implements CityScene {
  readonly scene = new THREE.Scene();
  private readonly ground: THREE.Mesh;
  private readonly buildingsGroup = new THREE.Group();
  private readonly roadsGroup = new THREE.Group();
  private readonly buildingHandles = new Map<
    string,
    { readonly handle: BuildingHandle; readonly key: string; labelKey: string }
  >();
  private readonly roadHandles = new Map<string, RoadHandle>();
  private currentBuildings: BuildingHandle[] = [];
  /** 建筑视觉工厂由 World 持有；scene 只用它释放单栋楼体，不创建也不销毁资产库。 */
  private readonly factory: BuildingVisualFactory;

  constructor(factory: BuildingVisualFactory) {
    this.factory = factory;
    this.scene.background = new THREE.Color(SKY_COLOR);
    this.scene.fog = new THREE.Fog(SKY_COLOR, 70, 165);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x74805f, 1.15);
    const sun = new THREE.DirectionalLight(0xfff3e0, 1.5);
    sun.position.set(38, 54, 24);
    const ambient = new THREE.AmbientLight(0xffffff, 0.18);
    this.scene.add(hemi, sun, ambient);

    const groundMaterial = new THREE.MeshStandardMaterial({ color: PALETTE.ground, roughness: 1 });
    // 单位盒按 bounds 缩放：城区扩张时只改缩放与位置，不重建地面几何体。
    this.ground = new THREE.Mesh(new THREE.BoxGeometry(1, 0.4, 1), groundMaterial);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground, this.buildingsGroup, this.roadsGroup, buildTrees());
  }

  get buildings(): readonly BuildingHandle[] {
    return this.currentBuildings;
  }

  syncLayout(layout: CityLayoutView): void {
    this.updateGround(layout.bounds);
    this.syncRoads(layout.roads, layout.bounds);
    this.syncBuildings(layout.buildings);
  }

  private updateGround(bounds: LayoutBounds): void {
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const depth = Math.max(1, bounds.maxZ - bounds.minZ);
    this.ground.scale.set(width, 1, depth);
    this.ground.position.set((bounds.minX + bounds.maxX) / 2, -0.2, (bounds.minZ + bounds.maxZ) / 2);

    // 雾距离随城市规模：远端仍落在摄像机 far 之内，扩张后不出现「突然出现」的地块。
    const span = Math.max(width, depth);
    const fogFar = Math.min(CAMERA.far - 20, Math.max(165, span * 1.35));
    const fogNear = Math.min(70, fogFar * 0.45);
    this.scene.fog = new THREE.Fog(SKY_COLOR, fogNear, fogFar);
  }

  private syncRoads(roads: readonly LayoutRoad[], bounds: LayoutBounds): void {
    const desired = new Set<string>();
    for (const road of roads) desired.add(road.id);
    for (const [id, handle] of this.roadHandles) {
      if (desired.has(id)) continue;
      this.roadsGroup.remove(handle.group);
      disposeObject(handle.group);
      this.roadHandles.delete(id);
    }
    for (const road of roads) {
      const key = roadVisualKey(road);
      const existing = this.roadHandles.get(road.id);
      if (existing && existing.key === key) continue;
      if (existing) {
        this.roadsGroup.remove(existing.group);
        disposeObject(existing.group);
        this.roadHandles.delete(road.id);
      }
      const group = buildRoad(road, bounds);
      this.roadsGroup.add(group);
      this.roadHandles.set(road.id, { group, key });
    }
  }

  private syncBuildings(buildings: readonly LayoutBuilding[]): void {
    const desired = new Set<string>();
    for (const building of buildings) desired.add(building.id);
    for (const [id, entry] of this.buildingHandles) {
      if (desired.has(id)) continue;
      releaseBuildingHandle(entry.handle, this.factory);
      this.buildingHandles.delete(id);
    }

    const ordered: BuildingHandle[] = [];
    for (const building of buildings) {
      const key = buildingGeometryKey(building);
      const labelKey = buildingLabelKey(building);
      const existing = this.buildingHandles.get(building.id);
      if (existing && existing.key === key) {
        // 几何不变：保留 handle、visual 与 collider 引用，只更新业务字段
        // （interactionId / shopId / companyId 等），标签内容变了就换一张精灵。
        existing.handle.building = building;
        if (existing.labelKey !== labelKey) {
          refreshBuildingLabel(existing.handle);
          existing.labelKey = labelKey;
        }
        ordered.push(existing.handle);
        continue;
      }
      if (existing) {
        // 替换实例：与删除走同一条释放路径（先 visual，再占位与标签）
        releaseBuildingHandle(existing.handle, this.factory);
        this.buildingHandles.delete(building.id);
      }
      const handle = buildBuilding(building);
      this.buildingsGroup.add(handle.group);
      this.buildingHandles.set(building.id, { handle, key, labelKey });
      ordered.push(handle);
    }
    this.currentBuildings = ordered;
  }

  /**
   * 整场销毁：先逐栋释放（楼体 → 占位/标签），再遍历释放地面、道路、树木与人物。
   *
   * 顺序不能反：`disposeObject(this.scene)` 会 `traverse` 到所有网格并释放材质与贴图，
   * 若共享的楼体材质还挂在树上，就会把别栋仍在用的材质/贴图一起释放。
   * 工厂的共享资产由 World 在本方法之后统一销毁。
   */
  dispose(): void {
    for (const entry of this.buildingHandles.values()) {
      releaseBuildingHandle(entry.handle, this.factory);
    }
    this.buildingHandles.clear();
    disposeObject(this.scene);
    this.roadHandles.clear();
    this.currentBuildings = [];
  }
}

/**
 * 按逻辑布局建立城市场景（灯光、地面、道路、建筑占位）。
 *
 * 只创建布局里存在的实例；模块化楼体由 World 向工厂请求后经 `attachBuildingVisual` 挂载，
 * 本文件不发起任何异步加载。
 */
export function buildCityScene(layout: CityLayoutView, factory: BuildingVisualFactory): CityScene {
  const city = new CitySceneImpl(factory);
  city.syncLayout(layout);
  return city;
}
