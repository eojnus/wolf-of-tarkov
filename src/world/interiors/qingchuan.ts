/**
 * 晴川公寓首套室内场景 —— 壳体、固定设施与四类外部家具。
 *
 * 只在玩家点击「进入个人住宅」后由 World 动态 import；模块本身不创建 renderer、
 * 不启动 RAF、不读写业务状态。退出时由 World 调用 `dispose()` 释放本场景独有资源。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { INTERIOR, type InteriorFurnitureSpec } from '../../content/interior';
import type { PlayerBounds, PlayerPose } from '../player';
import type { Collider } from '../scene';

export interface InteriorRuntime {
  readonly scene: THREE.Scene;
  /** 人物移动碰撞（2D AABB）。 */
  readonly colliders: readonly Collider[];
  /** 相机遮挡：移动碰撞 + 天花板/门洞封口等只对相机生效的盒体。 */
  readonly occluders: readonly Collider[];
  readonly bounds: PlayerBounds;
  readonly spawn: PlayerPose;
  readonly exit: { readonly x: number; readonly z: number; readonly radius: number };
  dispose(): void;
}

const COLORS = {
  wall: 0xf3efe7,
  wallShade: 0xe7e0d4,
  floor: 0xd9c3a3,
  ceiling: 0xfbf9f5,
  wood: 0xb98d63,
  woodDark: 0x8d6848,
  counter: 0xe9e6df,
  stone: 0xcfcac1,
  metal: 0x8f9397,
  dark: 0x3d3f42,
  fabric: 0xece5d8,
  fabricSoft: 0xf5f0e6,
  accent: 0x6f8574,
  tile: 0xdedbd4,
  glass: 0xbfd9de,
} as const;

function material(color: number, roughness = 0.85, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function box(
  scene: THREE.Scene,
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  mat: THREE.Material,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

function addCollider(
  colliders: Collider[],
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  maxY: number = INTERIOR.room.height,
): void {
  colliders.push({ minX, maxX, minZ, maxZ, minY: 0, maxY });
}

function plankTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#d8c2a2';
    ctx.fillRect(0, 0, 512, 512);
    const plankHeight = 64;
    for (let row = 0; row < 8; row += 1) {
      const y = row * plankHeight;
      ctx.fillStyle = row % 2 === 0 ? '#d3bc9b' : '#ddc8aa';
      ctx.fillRect(0, y, 512, plankHeight - 2);
      ctx.strokeStyle = 'rgba(120, 92, 62, 0.28)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(512, y);
      ctx.stroke();
      // 错缝
      const offset = row % 2 === 0 ? 0 : 128;
      ctx.strokeStyle = 'rgba(120, 92, 62, 0.18)';
      ctx.beginPath();
      ctx.moveTo(offset + 192, y);
      ctx.lineTo(offset + 192, y + plankHeight);
      ctx.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 4);
  return texture;
}

function skylineTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, '#cfe0e8');
    gradient.addColorStop(0.55, '#e8eef0');
    gradient.addColorStop(1, '#f4efe6');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 512, 256);
    ctx.fillStyle = 'rgba(150, 165, 172, 0.55)';
    const heights = [82, 120, 64, 148, 96, 132, 74, 110, 58, 138, 88, 104];
    for (let i = 0; i < heights.length; i += 1) {
      const w = 34 + (i % 3) * 12;
      const h = heights[i] ?? 80;
      ctx.fillRect(i * 44 - 6, 256 - h, w, h);
    }
    ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
    for (let i = 0; i < heights.length; i += 1) {
      const h = heights[i] ?? 80;
      for (let row = 0; row < Math.floor(h / 18); row += 1) {
        for (let col = 0; col < 2; col += 1) {
          ctx.fillRect(i * 44 + 4 + col * 14, 256 - h + 8 + row * 18, 7, 8);
        }
      }
    }
    ctx.fillStyle = 'rgba(120, 140, 120, 0.35)';
    ctx.fillRect(0, 236, 512, 20);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 按配置加载四类外部模型；任一失败由调用方整体回退，不用占位几何顶替。 */
async function loadFurniture(
  scene: THREE.Scene,
  spec: InteriorFurnitureSpec,
  loader: GLTFLoader,
): Promise<void> {
  const gltf = await loader.loadAsync(spec.url);
  const model = gltf.scene;
  model.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });

  const group = new THREE.Group();
  group.position.set(spec.x, 0, spec.z);
  group.rotation.y = spec.rotationY;
  group.add(model);
  group.userData.assetId = spec.assetId;
  group.userData.assetName = spec.name;
  scene.add(group);
}

/** 床垫与被褥：外部床架负责结构，软装用简单几何补齐干净床品。 */
function addBedding(scene: THREE.Scene): void {
  const bed = INTERIOR.furniture.bed;
  const mattressMat = material(0xe9e2d4, 1);
  const duvetMat = material(0xf6f1e6, 0.98);
  const pillowMat = material(0xfbf7ee, 0.98);
  const throwMat = material(0x9c9184, 0.98);

  const mattress = box(scene, 0.8, 0.16, 1.86, bed.x, 0.43, bed.z, mattressMat);
  mattress.name = 'bedding-mattress';
  // 被子比床垫略宽，盖住床垫中后段；枕头留在床头
  const duvet = box(scene, 0.9, 0.09, 1.36, bed.x, 0.54, bed.z + 0.38, duvetMat);
  duvet.name = 'bedding-duvet';
  const pillow = box(scene, 0.58, 0.13, 0.32, bed.x, 0.55, bed.z - 0.74, pillowMat);
  pillow.name = 'bedding-pillow';
  // 床尾搭一条薄毯，压住被子边缘
  const throwBlanket = box(scene, 0.88, 0.045, 0.34, bed.x, 0.6, bed.z + 0.86, throwMat);
  throwBlanket.name = 'bedding-throw';
}

function addRoomShell(scene: THREE.Scene, colliders: Collider[], occluders: Collider[]): void {
  const { width, depth, height, wall } = INTERIOR.room;
  const floorTexture = plankTexture();
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: floorTexture,
    roughness: 0.82,
    metalness: 0,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(width / 2, 0, depth / 2);
  floor.receiveShadow = true;
  scene.add(floor);

  const ceilingMat = material(COLORS.ceiling, 0.95);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), ceilingMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(width / 2, height, depth / 2);
  scene.add(ceiling);

  const wallMat = material(COLORS.wall, 0.9);
  const wallY = height / 2;

  // 北墙：保留入户门洞
  const { entrance } = INTERIOR.openings;
  box(scene, entrance.minX, height, wall, entrance.minX / 2, wallY, 0, wallMat);
  box(
    scene,
    width - entrance.maxX,
    height,
    wall,
    (width + entrance.maxX) / 2,
    wallY,
    0,
    wallMat,
  );
  box(scene, entrance.maxX - entrance.minX, height - entrance.height, wall, (entrance.minX + entrance.maxX) / 2, height - (height - entrance.height) / 2, 0, wallMat);
  addCollider(colliders, 0, entrance.minX, -wall / 2, wall / 2);
  addCollider(colliders, entrance.maxX, width, -wall / 2, wall / 2);

  // 南墙：窗洞
  const { window: win } = INTERIOR.openings;
  box(scene, win.minX, height, wall, win.minX / 2, wallY, depth, wallMat);
  box(scene, width - win.maxX, height, wall, (width + win.maxX) / 2, wallY, depth, wallMat);
  box(scene, win.maxX - win.minX, win.minY, wall, (win.minX + win.maxX) / 2, win.minY / 2, depth, wallMat);
  box(scene, win.maxX - win.minX, height - win.maxY, wall, (win.minX + win.maxX) / 2, height - (height - win.maxY) / 2, depth, wallMat);
  // 窗不是门：整面南墙都阻挡移动与相机，窗洞只影响外观
  addCollider(colliders, 0, width, depth - wall / 2, depth + wall / 2);

  // 西、东外墙
  box(scene, wall, height, depth, 0, wallY, depth / 2, wallMat);
  box(scene, wall, height, depth, width, wallY, depth / 2, wallMat);
  addCollider(colliders, -wall / 2, wall / 2, 0, depth);
  addCollider(colliders, width - wall / 2, width + wall / 2, 0, depth);

  // 入户门框
  const frameMat = material(COLORS.woodDark, 0.7);
  box(scene, 0.06, entrance.height, 0.14, entrance.minX, entrance.height / 2, 0.02, frameMat);
  box(scene, 0.06, entrance.height, 0.14, entrance.maxX, entrance.height / 2, 0.02, frameMat);
  box(scene, entrance.maxX - entrance.minX + 0.12, 0.06, 0.14, (entrance.minX + entrance.maxX) / 2, entrance.height, 0.02, frameMat);

  // 南窗框与玻璃
  const glass = new THREE.MeshPhysicalMaterial({
    color: COLORS.glass,
    transparent: true,
    opacity: 0.22,
    roughness: 0.08,
    metalness: 0,
    transmission: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const glassMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(win.maxX - win.minX, win.maxY - win.minY),
    glass,
  );
  glassMesh.position.set((win.minX + win.maxX) / 2, (win.minY + win.maxY) / 2, depth - 0.02);
  scene.add(glassMesh);
  const winFrame = material(COLORS.dark, 0.55, 0.2);
  box(scene, win.maxX - win.minX + 0.08, 0.06, 0.1, (win.minX + win.maxX) / 2, win.minY, depth - 0.03, winFrame);
  box(scene, win.maxX - win.minX + 0.08, 0.06, 0.1, (win.minX + win.maxX) / 2, win.maxY, depth - 0.03, winFrame);
  box(scene, 0.06, win.maxY - win.minY, 0.1, win.minX, (win.minY + win.maxY) / 2, depth - 0.03, winFrame);
  box(scene, 0.06, win.maxY - win.minY, 0.1, win.maxX, (win.minY + win.maxY) / 2, depth - 0.03, winFrame);
  box(scene, 0.05, win.maxY - win.minY, 0.1, (win.minX + win.maxX) / 2, (win.minY + win.maxY) / 2, depth - 0.03, winFrame);

  // 窗外低成本都市背景：不二次渲染城市。平面默认朝 +Z，需转向室内。
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 7),
    new THREE.MeshBasicMaterial({ map: skylineTexture() }),
  );
  backdrop.position.set(width / 2, 2.6, depth + 4.2);
  backdrop.rotation.y = Math.PI;
  scene.add(backdrop);

  // 天花灯槽与吸顶灯
  const lightDisc = new THREE.Mesh(
    new THREE.CircleGeometry(0.26, 28),
    new THREE.MeshStandardMaterial({ color: 0xfff6e6, emissive: 0xffe6b8, emissiveIntensity: 0.9 }),
  );
  lightDisc.rotation.x = Math.PI / 2;
  lightDisc.position.set(1.66, height - 0.01, 3.25);
  scene.add(lightDisc);

  // 相机专用遮挡：门洞封口与天花板。
  // 人物碰撞不使用它们 —— 门洞必须可通行，而 2D 碰撞不读 Y，天花板会挡住整个房间。
  occluders.push({
    minX: -wall / 2,
    maxX: width + wall / 2,
    minZ: -wall / 2,
    maxZ: wall / 2,
    minY: 0,
    maxY: height,
  });
  occluders.push({
    minX: -wall / 2,
    maxX: width + wall / 2,
    minZ: -wall / 2,
    maxZ: depth + wall / 2,
    minY: height - 0.06,
    maxY: height + 0.06,
  });
}

function addEntry(scene: THREE.Scene, colliders: Collider[]): void {
  const { wall } = INTERIOR.room;
  // 鞋柜：西墙北端
  const cabinetMat = material(COLORS.wood, 0.72);
  box(scene, 0.42, 0.86, 0.7, wall + 0.21, 0.43, 0.47, cabinetMat);
  box(scene, 0.44, 0.04, 0.72, wall + 0.21, 0.88, 0.47, material(COLORS.woodDark, 0.6));
  addCollider(colliders, wall, wall + 0.42, 0.12, 0.82, 0.9);

  // 地垫（玄关落尘区，仅材质变化）
  const mat = new THREE.Mesh(
    new THREE.PlaneGeometry(0.8, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x9a9384, roughness: 1 }),
  );
  mat.rotation.x = -Math.PI / 2;
  mat.position.set(1.66, 0.002, 0.42);
  scene.add(mat);
}

function addBathroom(scene: THREE.Scene, colliders: Collider[]): void {
  const { wall } = INTERIOR.room;
  const bathMat = material(COLORS.wall, 0.92);
  const tileMat = material(COLORS.tile, 0.6);

  // 卫浴范围：x 0–1.5，z 0.9–2.4；东墙留门洞
  const { bathroomDoor } = INTERIOR.openings;
  box(scene, 1.5, INTERIOR.room.height, wall, 0.75, INTERIOR.room.height / 2, 0.9, bathMat);
  addCollider(colliders, 0, 1.5, 0.9 - wall / 2, 0.9 + wall / 2);
  box(scene, 1.5, INTERIOR.room.height, wall, 0.75, INTERIOR.room.height / 2, 2.4, bathMat);
  addCollider(colliders, 0, 1.5, 2.4 - wall / 2, 2.4 + wall / 2);
  // 东墙分段
  box(scene, wall, INTERIOR.room.height, bathroomDoor.minZ - 0.9, 1.5, INTERIOR.room.height / 2, (0.9 + bathroomDoor.minZ) / 2, bathMat);
  box(scene, wall, INTERIOR.room.height, 2.4 - bathroomDoor.maxZ, 1.5, INTERIOR.room.height / 2, (bathroomDoor.maxZ + 2.4) / 2, bathMat);
  box(scene, wall, INTERIOR.room.height - bathroomDoor.height, bathroomDoor.maxZ - bathroomDoor.minZ, 1.5, INTERIOR.room.height - (INTERIOR.room.height - bathroomDoor.height) / 2, (bathroomDoor.minZ + bathroomDoor.maxZ) / 2, bathMat);
  addCollider(colliders, 1.5 - wall / 2, 1.5 + wall / 2, 0.9, bathroomDoor.minZ);
  addCollider(colliders, 1.5 - wall / 2, 1.5 + wall / 2, bathroomDoor.maxZ, 2.4);

  // 卫浴地砖
  const tileFloor = new THREE.Mesh(new THREE.PlaneGeometry(1.42, 1.42), tileMat);
  tileFloor.rotation.x = -Math.PI / 2;
  tileFloor.position.set(0.75, 0.004, 1.65);
  scene.add(tileFloor);

  // 淋浴区：北侧
  box(scene, 0.58, 0.06, 0.56, 1.14, 0.03, 1.24, material(COLORS.stone, 0.5));
  const showerGlass = new THREE.Mesh(
    new THREE.PlaneGeometry(0.56, 1.85),
    new THREE.MeshPhysicalMaterial({ color: 0xd9ecef, transparent: true, opacity: 0.2, roughness: 0.05, depthWrite: false }),
  );
  showerGlass.rotation.y = Math.PI / 2;
  showerGlass.position.set(0.85, 0.95, 1.24);
  scene.add(showerGlass);
  addCollider(colliders, 0.83, 0.87, 0.96, 1.52, 1.9);

  // 马桶：西墙
  box(scene, 0.4, 0.42, 0.56, 0.32, 0.21, 1.34, material(0xf4f2ec, 0.35));
  box(scene, 0.16, 0.62, 0.42, 0.14, 0.31, 1.34, material(0xf4f2ec, 0.4));
  const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.06, 24), material(0xffffff, 0.3));
  seat.position.set(0.42, 0.45, 1.34);
  scene.add(seat);
  addCollider(colliders, 0.06, 0.56, 1.05, 1.62, 0.8);

  // 洗手台：南墙（略窄，给门口留出可站立空间）
  box(scene, 0.76, 0.8, 0.5, 0.55, 0.4, 2.12, material(COLORS.wood, 0.7));
  box(scene, 0.8, 0.06, 0.54, 0.55, 0.83, 2.12, material(0xf7f6f2, 0.4));
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.17, 0.12, 24), material(0xffffff, 0.25));
  basin.position.set(0.55, 0.9, 2.12);
  scene.add(basin);
  box(scene, 0.04, 0.22, 0.04, 0.55, 1.0, 2.3, material(COLORS.metal, 0.3, 0.7));
  addCollider(colliders, 0.1, 0.95, 1.85, 2.4, 0.9);

  // 镜面
  const mirror = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.62), material(0xb9c6c9, 0.15, 0.6));
  mirror.position.set(0.55, 1.58, 2.37);
  mirror.rotation.y = Math.PI;
  scene.add(mirror);

  // 推拉门：完全推开、贴在北侧墙段上，门洞保持可通行（不做门动画）
  const door = box(
    scene,
    0.035,
    bathroomDoor.height,
    0.42,
    1.56,
    bathroomDoor.height / 2,
    (0.9 + bathroomDoor.minZ) / 2,
    material(COLORS.woodDark, 0.65),
  );
  door.name = 'bathroom-sliding-door';
}

function addKitchen(scene: THREE.Scene, colliders: Collider[]): void {
  const { width } = INTERIOR.room;
  const counterMat = material(COLORS.counter, 0.8);
  const cabinetMat = material(COLORS.wood, 0.72);
  const darkMat = material(COLORS.dark, 0.45, 0.2);

  // 冰箱：功能带北端
  box(scene, 0.54, 1.78, 0.56, width - 0.35, 0.89, 1.24, material(0xe7e9e8, 0.5, 0.1));
  box(scene, 0.02, 0.5, 0.04, width - 0.62, 1.2, 1.24, material(COLORS.metal, 0.3, 0.7));
  addCollider(colliders, width - 0.62, width - 0.08, 0.96, 1.52, 1.8);

  // 下柜与台面
  box(scene, 0.56, 0.86, 0.8, width - 0.36, 0.43, 1.94, cabinetMat);
  box(scene, 0.6, 0.05, 0.84, width - 0.36, 0.885, 1.94, counterMat);
  addCollider(colliders, width - 0.64, width - 0.08, 1.54, 2.36, 0.95);

  // 水槽
  box(scene, 0.4, 0.03, 0.42, width - 0.38, 0.9, 2.08, darkMat);
  box(scene, 0.04, 0.24, 0.04, width - 0.2, 1.02, 2.18, material(COLORS.metal, 0.25, 0.8));

  // 灶台与两个灶眼
  box(scene, 0.46, 0.02, 0.34, width - 0.38, 0.91, 1.72, darkMat);
  for (const offset of [-0.11, 0.11]) {
    const burner = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.09, 0.012, 20),
      material(COLORS.metal, 0.35, 0.7),
    );
    burner.position.set(width - 0.38 + offset, 0.925, 1.72);
    scene.add(burner);
  }

  // 吊柜：水槽上方，浅进深，避免与灶台上方烟机相撞
  box(scene, 0.26, 0.62, 0.42, width - 0.21, 1.95, 2.05, cabinetMat);
  // 抽油烟机：灶台正上方，薄烟机
  box(scene, 0.4, 0.12, 0.44, width - 0.3, 1.55, 1.72, material(COLORS.metal, 0.35, 0.55));

  // 台面下柜门缝
  for (let i = 0; i < 2; i += 1) {
    box(scene, 0.005, 0.72, 0.36, width - 0.641, 0.44, 1.76 + i * 0.4, material(COLORS.woodDark, 0.8));
  }
}

function addLivingDetails(scene: THREE.Scene, colliders: Collider[]): void {
  // 地毯：床与书桌之间
  const rug = new THREE.Mesh(
    new THREE.PlaneGeometry(1.35, 1.9),
    new THREE.MeshStandardMaterial({ color: 0xc9c2b3, roughness: 1 }),
  );
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(1.52, 0.006, 4.3);
  scene.add(rug);

  // 床头小几：放在床北侧墙角，不占用床与椅之间的通道
  box(scene, 0.38, 0.48, 0.38, 0.29, 0.24, 2.85, material(COLORS.wood, 0.7));
  addCollider(colliders, 0.1, 0.48, 2.66, 3.04, 0.5);
  // 台灯
  const lamp = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.16, 0.18, 20),
    new THREE.MeshStandardMaterial({ color: 0xfff0d2, emissive: 0xffd79a, emissiveIntensity: 0.55, roughness: 0.8 }),
  );
  lamp.position.set(0.29, 0.62, 2.85);
  scene.add(lamp);

  // 南窗绿植：避开沙发与床的落位
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.1, 0.28, 18), material(0xb08d70, 0.9));
  pot.position.set(1.22, 0.14, 5.88);
  scene.add(pot);
  const leafMat = material(COLORS.accent, 0.95);
  const leafSpecs: readonly [number, number, number, number][] = [
    [0, 0.44, 0, 0.2],
    [-0.12, 0.38, 0.06, 0.13],
    [0.11, 0.4, -0.07, 0.14],
    [0.03, 0.52, 0.05, 0.11],
  ];
  for (const [dx, y, dz, radius] of leafSpecs) {
    const leaves = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 10), leafMat);
    leaves.position.set(1.22 + dx, y, 5.88 + dz);
    leaves.scale.set(1, 0.82, 1);
    scene.add(leaves);
  }
  addCollider(colliders, 1.09, 1.35, 5.75, 6.01, 0.6);
}

function addLights(scene: THREE.Scene): void {
  scene.add(new THREE.AmbientLight(0xfff4e4, 0.28));
  const hemi = new THREE.HemisphereLight(0xfff7ea, 0x8c8278, 0.5);
  scene.add(hemi);

  // 南窗方向的日光；不启用实时阴影，避免小房间阴影开销
  const sun = new THREE.DirectionalLight(0xffeed3, 1.2);
  sun.position.set(1.6, 3.2, 7.6);
  sun.target.position.set(1.6, 0.8, 3.8);
  scene.add(sun, sun.target);

  const warm = new THREE.PointLight(0xffd9a8, 8, 6, 2);
  warm.position.set(1.66, 2.36, 3.25);
  scene.add(warm);

  // 卫浴与厨房局部补光
  const bath = new THREE.PointLight(0xfff2dc, 3.5, 3, 2);
  bath.position.set(0.75, 2.2, 1.65);
  scene.add(bath);
  const kitchen = new THREE.PointLight(0xfff2dc, 3.5, 3, 2);
  kitchen.position.set(2.95, 2.2, 1.9);
  scene.add(kitchen);
}

function furnitureCollider(spec: InteriorFurnitureSpec): Collider {
  const halfW = spec.footprint.width / 2;
  const halfD = spec.footprint.depth / 2;
  return {
    minX: spec.x - halfW,
    maxX: spec.x + halfW,
    minZ: spec.z - halfD,
    maxZ: spec.z + halfD,
    minY: 0,
    maxY: 1.2,
  };
}

function disposeScene(scene: THREE.Scene): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const mat = mesh.material;
    if (!mat) return;
    const list = Array.isArray(mat) ? mat : [mat];
    for (const item of list) {
      materials.add(item);
      for (const value of Object.values(item)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const texture of textures) texture.dispose();
  for (const mat of materials) mat.dispose();
  scene.clear();
}

export async function loadQingchuanInterior(): Promise<InteriorRuntime> {
  const scene = new THREE.Scene();
  scene.name = 'qingchuan-home-interior';
  scene.background = new THREE.Color(0xf4f1ea);

  const colliders: Collider[] = [];
  const occluders: Collider[] = [];
  addRoomShell(scene, colliders, occluders);
  addEntry(scene, colliders);
  addBathroom(scene, colliders);
  addKitchen(scene, colliders);
  addLivingDetails(scene, colliders);
  addLights(scene);

  const loader = new GLTFLoader();
  const specs = Object.values(INTERIOR.furniture);
  try {
    await Promise.all(specs.map((spec) => loadFurniture(scene, spec, loader)));
    addBedding(scene);
    for (const spec of specs) colliders.push(furnitureCollider(spec));
  } catch (error) {
    disposeScene(scene);
    throw error;
  }
  // 家具与墙体同时参与相机遮挡
  occluders.push(...colliders);

  const { wall, width, depth } = INTERIOR.room;
  return {
    scene,
    colliders,
    occluders,
    bounds: { minX: wall, maxX: width - wall, minZ: wall, maxZ: depth - wall },
    spawn: INTERIOR.spawn,
    exit: INTERIOR.exit,
    dispose: () => disposeScene(scene),
  };
}
