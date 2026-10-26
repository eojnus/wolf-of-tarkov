/**
 * 城市场景搭建 —— 按逻辑地图（layout）生成地面、道路、建筑与标识。
 *
 * 职责边界：
 *  - 本文件只读 `features/city-layout` 的只读视图，不写回逻辑地图，也不读写经济状态；
 *  - 场景实例按稳定 id 增量同步（`CityScene.syncLayout`）：新增的建、移除的销毁，
 *    几何指纹不变的只更新交互数据，**不整场重建**；
 *  - 只有布局建筑带 `model` 时才加载 GLB；`model === null` 的新区建筑只用程序化几何体；
 *  - 模型比例键用 `modelScaleKey ?? id`，与实例 id 分开，基础城区仍走 scene-scale 参照。
 */

import * as THREE from 'three';
import { CAMERA } from '../content/config';
import { scaleReferenceFor } from '../content/scene-scale';
import type {
  CityLayoutView,
  LayoutBounds,
  LayoutBuilding,
  LayoutRoad,
} from '../features/city-layout';

/**
 * 建筑碰撞盒（世界坐标 AABB）。
 *
 * 模型加载后会就地更新，因此不是 readonly；读取方（人物碰撞、摄像机遮挡、交互距离）
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

export interface BuildingHandle {
  /**
   * 布局建筑快照。几何不变而业务字段（交互 id / shopId / companyId / 可用性）变化时，
   * 场景保留实例并更新该引用；几何变化则整个 handle 被替换。
   */
  building: LayoutBuilding;
  readonly collider: Collider;
  readonly group: THREE.Group;
  /** 灰盒几何体。模型加载成功后隐藏，加载失败时继续使用。 */
  readonly placeholder: THREE.Group;
  readonly label: THREE.Sprite;
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

/** 门朝向主轴：以入口点相对建筑中心的方向决定正面。 */
function facadeAxis(building: LayoutBuilding): { axis: 'x' | 'z'; sign: number } {
  const dx = building.entrance.x - building.position.x;
  const dz = building.entrance.z - building.position.z;
  if (Math.abs(dx) >= Math.abs(dz)) {
    return { axis: 'x', sign: Math.sign(dx) || 1 };
  }
  return { axis: 'z', sign: Math.sign(dz) || 1 };
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
  const { axis, sign } = facadeAxis(building);
  const normal = new THREE.Vector3(axis === 'x' ? sign : 0, 0, axis === 'z' ? sign : 0);
  // 本地正面为 -Z，旋转到入口点所在的正面方向
  const rotationY = Math.atan2(-normal.x, -normal.z);

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

  // 碰撞体严格等于配置包围盒：装饰不参与阻挡
  const collider: Collider = {
    minX: building.position.x - width / 2,
    maxX: building.position.x + width / 2,
    minZ: building.position.z - depth / 2,
    maxZ: building.position.z + depth / 2,
    minY: 0,
    maxY: height,
  };

  return { building, collider, group, placeholder, label };
}

function buildBuilding(building: LayoutBuilding): BuildingHandle {
  if (building.kind === 'shop') return buildShopBuilding(building);

  const { width, height, depth } = building.size;
  const { axis, sign } = facadeAxis(building);

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

  const collider: Collider = {
    minX: building.position.x - width / 2,
    maxX: building.position.x + width / 2,
    minZ: building.position.z - depth / 2,
    maxZ: building.position.z + depth / 2,
    minY: 0,
    maxY: height,
  };

  return { building, collider, group, placeholder, label };
}

/**
 * 用外部模型替换灰盒表现，并让碰撞体与实际模型对齐。
 *
 * 视觉：优先按 scene-scale 的实测参照做**等比**缩放（target / source，setScalar），
 * 比例键用 `modelScaleKey ?? building.id`（与实例 id 分开）；没有参照的模型保留
 * 旧的「三边约束取最小比例」回退。
 * 碰撞：把模型的**最终世界包围盒**写回现有的 handle.collider 对象（不替换对象，
 * 保证 World 保存的引用继续有效）。
 * 业务逻辑完全不知道模型的存在；模型加载失败时保留原灰盒碰撞。
 */
export function applyBuildingModel(handle: BuildingHandle, model: THREE.Object3D): void {
  const { building } = handle;
  const rawBox = new THREE.Box3().setFromObject(model);
  const rawSize = rawBox.getSize(new THREE.Vector3());
  if (rawSize.x <= 0.001 || rawSize.y <= 0.001 || rawSize.z <= 0.001) return;

  const reference = scaleReferenceFor(building.modelScaleKey ?? building.id);
  const scale = reference
    ? reference.targetReferenceHeightMeters / reference.sourceReferenceHeight
    : Math.min(
        building.size.height / rawSize.y,
        building.size.width / rawSize.x,
        building.size.depth / rawSize.z,
      );
  if (!Number.isFinite(scale) || scale <= 0) return;

  model.scale.setScalar(scale);
  model.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.x += building.position.x - center.x;
  model.position.z += building.position.z - center.z;
  model.position.y -= box.min.y;

  model.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = false;
      mesh.receiveShadow = true;
    }
  });

  handle.group.add(model);
  handle.placeholder.visible = false;

  // 位置调整完成后重新计算，且只针对模型本身（不含标签、广场、灰盒）
  model.updateMatrixWorld(true);
  const worldBox = new THREE.Box3().setFromObject(model);
  const collider = handle.collider;
  collider.minX = worldBox.min.x;
  collider.maxX = worldBox.max.x;
  collider.minZ = worldBox.min.z;
  collider.maxZ = worldBox.max.z;
  collider.minY = worldBox.min.y;
  collider.maxY = worldBox.max.y;

  handle.label.position.y = worldBox.max.y + 2.4;
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

/** 建筑几何指纹：位置/尺寸/外观/模型变了才重建实例；交互 id 等业务字段不重建。 */
function buildingVisualKey(building: LayoutBuilding): string {
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
    building.name,
    building.subtitle,
    building.available ? 1 : 0,
  ].join('|');
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
    { readonly handle: BuildingHandle; readonly key: string }
  >();
  private readonly roadHandles = new Map<string, RoadHandle>();
  private currentBuildings: BuildingHandle[] = [];

  constructor() {
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
      this.buildingsGroup.remove(entry.handle.group);
      disposeObject(entry.handle.group);
      this.buildingHandles.delete(id);
    }

    const ordered: BuildingHandle[] = [];
    for (const building of buildings) {
      const key = buildingVisualKey(building);
      const existing = this.buildingHandles.get(building.id);
      if (existing && existing.key === key) {
        // 几何不变：只刷新业务字段（interactionId / shopId / companyId / available 等）。
        existing.handle.building = building;
        ordered.push(existing.handle);
        continue;
      }
      if (existing) {
        this.buildingsGroup.remove(existing.handle.group);
        disposeObject(existing.handle.group);
        this.buildingHandles.delete(building.id);
      }
      const handle = buildBuilding(building);
      this.buildingsGroup.add(handle.group);
      this.buildingHandles.set(building.id, { handle, key });
      ordered.push(handle);
    }
    this.currentBuildings = ordered;
  }

  dispose(): void {
    disposeObject(this.scene);
    this.buildingHandles.clear();
    this.roadHandles.clear();
    this.currentBuildings = [];
  }
}

/**
 * 按逻辑布局建立城市场景（灯光、地面、道路、建筑）。
 *
 * 只创建布局里存在的实例；模型加载由 world 负责（本文件只提供 `applyBuildingModel`）。
 */
export function buildCityScene(layout: CityLayoutView): CityScene {
  const city = new CitySceneImpl();
  city.syncLayout(layout);
  return city;
}
