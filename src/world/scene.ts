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
import { CAMERA, CITY } from '../content/config';
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
import { BuildingAssembly } from './buildings/geometry';
import { disposeBlockGroup } from './blocks/scene';
import type { SceneryAssetLibrary } from './scenery/assets';

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
  /**
   * 由城市边界推导的基础雾距离（不含天气修饰）。
   * 雾的颜色与远近由环境系统按天气调整，这里只提供城市规模带来的基数。
   */
  readonly fogBase: { readonly near: number; readonly far: number };
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

export function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    /**
     * 街景分支：材质与贴图归 `SceneryAssetLibrary` 所有，这里**一律不释放**。
     *
     * `userData.scenery` 取两个值，必须分开处理：
     *  - `'shared-geometry'`：几何来自资产库（树木/家具/装饰楼体），只释放实例缓冲；
     *  - `'owned-geometry'`：几何由本块/本路网合并生成，几何可以释放。
     */
    const scenery = mesh.userData?.scenery as 'shared-geometry' | 'owned-geometry' | undefined;
    if (scenery) {
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
        (mesh as THREE.InstancedMesh).dispose();
      } else if (scenery === 'owned-geometry') {
        mesh.geometry?.dispose();
      }
      return;
    }
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
 * 实体网格的阴影参与规则 —— 只在实例创建或模型挂载时调用一次。
 *
 * 只对**不透明 Mesh** 开启投影：Sprite 标签、透明玻璃、道路虚线等装饰不参与投影，
 * 避免标签在路上投出方块、玻璃投出实心影子；所有实体表面都接收阴影，
 * 因此地面、路面、墙面能被建筑、树木与人物投下影子。
 * **不在渲染循环里遍历场景重设这些标记。**
 */
export function applySolidShadowFlags(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material;
    const materials = Array.isArray(material) ? material : [material];
    const transparent = materials.some((item) => item.transparent || item.opacity < 1);
    mesh.castShadow = !transparent && mesh.userData.shadowCaster !== false;
    mesh.receiveShadow = true;
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

  // 盒体与构件参与投影；招牌面是贴在墙面上的贴花，只接收不投影
  applySolidShadowFlags(placeholder);
  signFace.castShadow = false;

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
  applySolidShadowFlags(placeholder);
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
  // 正式挂载时统一设置一次，覆盖合批网格和实例构件，不在每帧遍历。
  applySolidShadowFlags(visual.group);
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

/**
 * 车行道矩形（世界坐标）。
 *
 * 路面、人行道、路缘与标线全部由**矩形求交**推导，不再假设路口固定在某个 z。
 * 旧实现用 `CROSS_ROAD_Z = 0` 断虚线，新区条带的路口位置不同就会画错。
 */
interface RoadRect {
  readonly id: string;
  readonly rect: { x0: number; x1: number; z0: number; z1: number };
  readonly horizontal: boolean;
}

/** 路口：两条方向不同的车行道矩形之交，同时记住产生它的两条路。 */
interface Junction {
  readonly rect: { x0: number; x1: number; z0: number; z1: number };
  readonly horizontalRoad: RoadRect;
  readonly verticalRoad: RoadRect;
}

function roadRectOf(road: LayoutRoad): RoadRect {
  return {
    id: road.id,
    rect: {
      x0: road.center.x - road.size.width / 2,
      x1: road.center.x + road.size.width / 2,
      z0: road.center.z - road.size.depth / 2,
      z1: road.center.z + road.size.depth / 2,
    },
    horizontal: road.size.width >= road.size.depth,
  };
}

function junctionsOf(roads: readonly RoadRect[]): Junction[] {
  const result: Junction[] = [];
  for (let i = 0; i < roads.length; i += 1) {
    for (let j = i + 1; j < roads.length; j += 1) {
      if (roads[i].horizontal === roads[j].horizontal) continue;
      const x0 = Math.max(roads[i].rect.x0, roads[j].rect.x0);
      const x1 = Math.min(roads[i].rect.x1, roads[j].rect.x1);
      const z0 = Math.max(roads[i].rect.z0, roads[j].rect.z0);
      const z1 = Math.min(roads[i].rect.z1, roads[j].rect.z1);
      if (x1 - x0 > 0.1 && z1 - z0 > 0.1) {
        const horizontalRoad = roads[i].horizontal ? roads[i] : roads[j];
        const verticalRoad = roads[i].horizontal ? roads[j] : roads[i];
        result.push({ rect: { x0, x1, z0, z1 }, horizontalRoad, verticalRoad });
      }
    }
  }
  return result;
}

type FlatRect = { x0: number; x1: number; z0: number; z1: number };

function overlapsRect(a: FlatRect, b: FlatRect): boolean {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 1e-6 && Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) > 1e-6;
}

/**
 * 轴对齐矩形相减：`base` 减去 `cut`，结果最多四块。
 *
 * 用途一：路口处裁掉覆盖其他车行道的**人行道**（否则人行道会横铺在另一条路上）；
 * 用途二：让车行道按优先级让出重叠区，**每个点只有一张路面**，
 * 消除交叉区域的共面重复铺装（z-fighting 与无谓的 overdraw）。
 */
function subtractRect(base: FlatRect, cut: FlatRect): FlatRect[] {
  if (!overlapsRect(base, cut)) return [base];
  const pieces: FlatRect[] = [];
  if (cut.z0 > base.z0) pieces.push({ x0: base.x0, x1: base.x1, z0: base.z0, z1: cut.z0 });
  if (cut.z1 < base.z1) pieces.push({ x0: base.x0, x1: base.x1, z0: cut.z1, z1: base.z1 });
  const z0 = Math.max(base.z0, cut.z0);
  const z1 = Math.min(base.z1, cut.z1);
  if (cut.x0 > base.x0) pieces.push({ x0: base.x0, x1: cut.x0, z0, z1 });
  if (cut.x1 < base.x1) pieces.push({ x0: cut.x1, x1: base.x1, z0, z1 });
  return pieces.filter((item) => item.x1 - item.x0 > 1e-3 && item.z1 - item.z0 > 1e-3);
}

function subtractAll(base: FlatRect, cuts: readonly FlatRect[]): FlatRect[] {
  let pieces: FlatRect[] = [base];
  for (const cut of cuts) pieces = pieces.flatMap((piece) => subtractRect(piece, cut));
  return pieces;
}

function insideJunction(junctions: readonly Junction[], x: number, z: number, pad: number): boolean {
  return junctions.some(
    (item) => x > item.rect.x0 - pad && x < item.rect.x1 + pad && z > item.rect.z0 - pad && z < item.rect.z1 + pad,
  );
}

/**
 * 道路网络指纹：道路集合或边界变化才重建。
 *
 * 道路是"整网一次成型"的对象（路口要一起算），因此不做逐条增量；
 * 它只在城区完工、道路集合真正变化时重建，代价是几条合并网格。
 */
function roadNetworkKey(roads: readonly LayoutRoad[], bounds: LayoutBounds): string {
  const body = roads
    .map((road) => [road.id, road.center.x, road.center.z, road.size.width, road.size.depth].join(','))
    .join('|');
  return `${body}#${bounds.minX},${bounds.maxX},${bounds.minZ},${bounds.maxZ}`;
}

interface RoadBuild {
  readonly group: THREE.Group;
  /** 需要异步换成真实 PBR 的合并网格（先用素色占位，避免首帧卡在纹理加载）。 */
  readonly swaps: { readonly mesh: THREE.Mesh; readonly key: 'asphalt' | 'paving' }[];
  readonly triangles: number;
}

/**
 * 生成整个路网：车行道、人行道、路缘石条、车行道虚线、斑马线与停止线。
 *
 * 约定：
 *  - 所有面都在 `y ≈ 0`（顶面 10–16 mm），人物不做垂直采样，路缘只是**颜色分界**；
 *  - 人行道只向道路两侧外扩，**不沿道路末端延伸**（旧实现 `depth + 4` 会压住便利店）；
 *  - 标线按真实路口断开，路缘在路口与斑马线处断开（落平路缘）。
 */
function buildRoadNetwork(
  roads: readonly LayoutRoad[],
  library: { getSolidMaterial(key: 'curb' | 'marking' | 'wall' | 'hedge' | 'soil'): THREE.Material },
): RoadBuild {
  const group = new THREE.Group();
  group.name = 'roads';
  const surfaces = roads.map(roadRectOf);
  const junctions = junctionsOf(surfaces);
  const swaps: { mesh: THREE.Mesh; key: 'asphalt' | 'paving' }[] = [];
  let triangles = 0;

  const curbMaterial = library.getSolidMaterial('curb');
  const markingMaterial = library.getSolidMaterial('marking');
  const placeholder = library.getSolidMaterial('soil');
  const top = CITY.surfaceTop;

  const push = (assembly: BuildingAssembly, material: THREE.Material, size: readonly [number, number, number], center: readonly [number, number, number], tile: number): void => {
    assembly.box(material, size, center, tile);
  };

  // ---- 车行道
  // 每条路让出**已在前面铺过的**路口区域：交叉处只有一张路面，
  // 既不会有共面重复（z-fighting），也不会对同一块像素重复着色。
  const roadAssembly = new BuildingAssembly();
  surfaces.forEach((item, index) => {
    const taken = surfaces.slice(0, index).map((other) => other.rect);
    for (const piece of subtractAll(item.rect, taken)) {
      push(
        roadAssembly,
        placeholder,
        [piece.x1 - piece.x0, 0.06, piece.z1 - piece.z0],
        [(piece.x0 + piece.x1) / 2, top.road - 0.03, (piece.z0 + piece.z1) / 2],
        4,
      );
    }
  });
  triangles += (roadAssembly as unknown as { stats(): { triangles: number } }).stats().triangles;

  // ---- 人行道（只向两侧外扩，不沿末端延伸；路口处被其他车行道切开）
  const walkAssembly = new BuildingAssembly();
  const sw = CITY.sidewalkWidth;
  surfaces.forEach((item, index) => {
    // 其他人行道的车行道：任何一条横穿过去，都必须把人行道在这里断开
    const others = surfaces.filter((_, i) => i !== index).map((other) => other.rect);
    const bands: FlatRect[] = item.horizontal
      ? [
          { x0: item.rect.x0, x1: item.rect.x1, z0: item.rect.z0 - sw, z1: item.rect.z0 },
          { x0: item.rect.x0, x1: item.rect.x1, z0: item.rect.z1, z1: item.rect.z1 + sw },
        ]
      : [
          { x0: item.rect.x0 - sw, x1: item.rect.x0, z0: item.rect.z0, z1: item.rect.z1 },
          { x0: item.rect.x1, x1: item.rect.x1 + sw, z0: item.rect.z0, z1: item.rect.z1 },
        ];
    for (const band of bands) {
      for (const piece of subtractAll(band, others)) {
        push(
          walkAssembly,
          placeholder,
          [piece.x1 - piece.x0, 0.06, piece.z1 - piece.z0],
          [(piece.x0 + piece.x1) / 2, top.paving - 0.03, (piece.z0 + piece.z1) / 2],
          2.4,
        );
      }
    }
  });

  // ---- 路缘石条 + 标线（共享实色材质，不需要换贴图）
  const solidAssembly = new BuildingAssembly();
  const markingAssembly = new BuildingAssembly();
  const curbW = CITY.curbStripWidth;

  // 路缘：沿每条道路的两条长边，铺在人行道靠近车行道的一侧；路口与斑马线处断开
  for (const item of surfaces) {
    if (item.horizontal) {
      for (const z of [item.rect.z0, item.rect.z1]) {
        const sign = z === item.rect.z0 ? -1 : 1;
        let x = item.rect.x0;
        while (x < item.rect.x1 - 0.2) {
          const len = Math.min(4, item.rect.x1 - x);
          const midX = x + len / 2;
          if (!insideJunction(junctions, midX, z, 4.5)) {
            push(solidAssembly, curbMaterial, [len, 0.04, curbW], [midX, top.paving - 0.018, z + (sign * curbW) / 2], 1);
          }
          x += len;
        }
      }
    } else {
      for (const x of [item.rect.x0, item.rect.x1]) {
        const sign = x === item.rect.x0 ? -1 : 1;
        let z = item.rect.z0;
        while (z < item.rect.z1 - 0.2) {
          const len = Math.min(4, item.rect.z1 - z);
          const midZ = z + len / 2;
          if (!insideJunction(junctions, x, midZ, 4.5)) {
            push(solidAssembly, curbMaterial, [curbW, 0.04, len], [x + (sign * curbW) / 2, top.paving - 0.018, midZ], 1);
          }
          z += len;
        }
      }
    }
  }

  // 车行道中心虚线：沿道路长轴，路口前后各留 1 m 断开
  for (const item of surfaces) {
    const span = item.horizontal ? item.rect.x1 - item.rect.x0 : item.rect.z1 - item.rect.z0;
    const steps = Math.max(1, Math.floor(span / 6));
    for (let i = 0; i < steps; i += 1) {
      const offset = (span / steps) * (i + 0.5);
      const x = item.horizontal ? item.rect.x0 + offset : (item.rect.x0 + item.rect.x1) / 2;
      const z = item.horizontal ? (item.rect.z0 + item.rect.z1) / 2 : item.rect.z0 + offset;
      if (insideJunction(junctions, x, z, 1.2)) continue;
      push(
        markingAssembly,
        markingMaterial,
        item.horizontal ? [2.6, 0.02, 0.16] : [0.16, 0.02, 2.6],
        [x, top.marking, z],
        1,
      );
    }
  }

  // 斑马线：每个路口四条边各一组。
  // 条带必须落在**本路口参与的**那条路上，不能用"第一条横/纵向道路"顶替。
  for (const junction of junctions) {
    const armPad = 0.6;
    const crossingWidth = 3.6;
    const barWidth = 0.45;
    const h = junction.horizontalRoad.rect;
    const v = junction.verticalRoad.rect;
    for (const side of ['west', 'east'] as const) {
      const x = side === 'west' ? junction.rect.x0 - armPad - crossingWidth / 2 : junction.rect.x1 + armPad + crossingWidth / 2;
      let z = h.z0 + 0.4;
      while (z < h.z1 - 0.4) {
        push(markingAssembly, markingMaterial, [crossingWidth, 0.02, barWidth], [x, top.marking, z + barWidth / 2], 1);
        z += barWidth * 2;
      }
    }
    for (const side of ['south', 'north'] as const) {
      const z = side === 'south' ? junction.rect.z0 - armPad - crossingWidth / 2 : junction.rect.z1 + armPad + crossingWidth / 2;
      let x = v.x0 + 0.4;
      while (x < v.x1 - 0.4) {
        push(markingAssembly, markingMaterial, [barWidth, 0.02, crossingWidth], [x + barWidth / 2, top.marking, z], 1);
        x += barWidth * 2;
      }
    }
  }

  // 合并成网格：每个材质一个 draw call
  const place = (assembly: BuildingAssembly, surfaceKey?: 'asphalt' | 'paving'): void => {
    const built = assembly.build();
    for (const child of built.children) {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) continue;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      // 路面/人行道的几何由本组拥有，材质由街景库共享
      mesh.userData.scenery = 'owned-geometry';
      group.add(mesh);
      if (surfaceKey) swaps.push({ mesh, key: surfaceKey });
    }
  };
  place(roadAssembly, 'asphalt');
  place(walkAssembly, 'paving');
  place(solidAssembly);
  place(markingAssembly);

  return { group, swaps, triangles };
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

class CitySceneImpl implements CityScene {
  readonly scene = new THREE.Scene();
  private readonly ground: THREE.Mesh;
  private readonly buildingsGroup = new THREE.Group();
  private readonly buildingHandles = new Map<
    string,
    { readonly handle: BuildingHandle; readonly key: string; labelKey: string }
  >();
  /** 路网整网一次成型（路口要一起算），按指纹整体重建。 */
  private roadGroup: THREE.Group | null = null;
  private roadKey = '';
  private readonly library: SceneryAssetLibrary;
  private currentBuildings: BuildingHandle[] = [];
  /** 工厂由 World 持有；scene 只负责单栋释放，不销毁共享资产库。 */
  private readonly factory: BuildingVisualFactory;
  private fogBaseValue: { near: number; far: number } = { near: 70, far: 165 };

  constructor(factory: BuildingVisualFactory, library: SceneryAssetLibrary) {
    this.factory = factory;
    this.library = library;
    // 太阳、天空与雾由 EnvironmentRig 唯一管理，场景只维护几何与雾距离基数。
    const groundMaterial = new THREE.MeshStandardMaterial({ color: PALETTE.ground, roughness: 1 });
    // 单位盒按 bounds 缩放：城区扩张时只改缩放与位置，不重建地面几何体。
    this.ground = new THREE.Mesh(new THREE.BoxGeometry(1, 0.4, 1), groundMaterial);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground, this.buildingsGroup);
  }

  get buildings(): readonly BuildingHandle[] {
    return this.currentBuildings;
  }

  get fogBase(): { readonly near: number; readonly far: number } {
    return this.fogBaseValue;
  }

  syncLayout(layout: CityLayoutView): void {
    this.updateGround(layout.bounds);
    this.syncRoadNetwork(layout.roads, layout.bounds);
    this.syncBuildings(layout.buildings);
  }

  private updateGround(bounds: LayoutBounds): void {
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const depth = Math.max(1, bounds.maxZ - bounds.minZ);
    this.ground.scale.set(width, 1, depth);
    this.ground.position.set((bounds.minX + bounds.maxX) / 2, -0.2, (bounds.minZ + bounds.maxZ) / 2);

    // 雾距离随城市规模：远端仍落在摄像机 far 之内，扩张后不出现「突然出现」的地块。
    // 这里只记录**基础**距离；实际颜色与远近再由环境系统按昼夜与天气修饰。
    const span = Math.max(width, depth);
    const fogFar = Math.min(CAMERA.far - 20, Math.max(165, span * 1.35));
    this.fogBaseValue = { near: Math.min(70, fogFar * 0.45), far: fogFar };
  }

  /**
   * 路网同步：指纹不变就跳过；变化时整网重建。
   *
   * 重建只释放本路网自己的合并几何（`disposeBlockGroup`），材质与贴图归街景库，
   * 绝不再走 `disposeObject`（那会把共享沥青贴图从别处抽走）。
   */
  private syncRoadNetwork(roads: readonly LayoutRoad[], bounds: LayoutBounds): void {
    const key = roadNetworkKey(roads, bounds);
    if (this.roadGroup && this.roadKey === key) return;
    if (this.roadGroup) {
      this.roadGroup.removeFromParent();
      disposeBlockGroup(this.roadGroup);
      this.roadGroup = null;
    }
    const built = buildRoadNetwork(roads, this.library);
    this.roadGroup = built.group;
    this.roadKey = key;
    this.scene.add(built.group);
    for (const item of built.swaps) {
      const mesh = item.mesh;
      const surface = item.key;
      void this.library
        .getSurfaceMaterial(surface)
        .then((material) => {
          if (!mesh.parent) return;
          mesh.material = material;
        })
        .catch((error: unknown) => {
          console.warn(`[scene] 路面材质加载失败，保留素色：${surface}`, error);
        });
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
    if (this.roadGroup) {
      this.roadGroup.removeFromParent();
      disposeBlockGroup(this.roadGroup);
      this.roadGroup = null;
      this.roadKey = '';
    }
    disposeObject(this.scene);
    this.currentBuildings = [];
  }
}

/**
 * 按逻辑布局建立城市场景（灯光、地面、道路、建筑占位）。
 *
 * 只创建布局里存在的实例；模块化楼体由 World 向工厂请求后经 `attachBuildingVisual` 挂载，
 * 本文件不发起任何异步加载。
 */
export function buildCityScene(
  layout: CityLayoutView,
  factory: BuildingVisualFactory,
  library: SceneryAssetLibrary,
): CityScene {
  const city = new CitySceneImpl(factory, library);
  city.syncLayout(layout);
  return city;
}
