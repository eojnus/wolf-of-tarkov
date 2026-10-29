/**
 * 家具操作图标 —— 三个有厚度的 Three.js Mesh，不是字符或 2D 图片。
 *
 * 仅由编辑器创建/销毁；不使用共享材质，便于 hover 高亮与释放。
 * 本实现使用项目内程序化几何，不引入第三方图标资产。
 */

import * as THREE from 'three';

export type FurnitureIconAction = 'rotate-left' | 'store' | 'rotate-right';

interface IconEntry {
  readonly action: FurnitureIconAction;
  readonly group: THREE.Group;
  readonly material: THREE.MeshStandardMaterial;
  readonly pickables: THREE.Mesh[];
}

const ICON_SPACING = 0.29;
const ICON_SIZE = 0.2;

function iconMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x1b222a,
    emissive: 0x4fb3c4,
    emissiveIntensity: 0.32,
    roughness: 0.55,
    metalness: 0.2,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
  });
}

function arrowGeometry(direction: -1 | 1): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  const x = (value: number): number => value * direction;
  shape.moveTo(x(-0.09), 0.035);
  shape.lineTo(x(0.02), 0.035);
  shape.lineTo(x(0.02), 0.09);
  shape.lineTo(x(0.105), 0);
  shape.lineTo(x(0.02), -0.09);
  shape.lineTo(x(0.02), -0.035);
  shape.lineTo(x(-0.09), -0.035);
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, {
    depth: 0.045,
    bevelEnabled: true,
    bevelSize: 0.012,
    bevelThickness: 0.012,
    bevelSegments: 2,
    curveSegments: 2,
  });
}

function storeGeometry(): THREE.BufferGeometry[] {
  return [
    new THREE.BoxGeometry(0.2, 0.16, 0.045),
    new THREE.BoxGeometry(0.22, 0.035, 0.055),
    new THREE.BoxGeometry(0.11, 0.024, 0.012),
  ];
}

function buildIcon(action: FurnitureIconAction): IconEntry {
  const group = new THREE.Group();
  group.userData.furnitureIconAction = action;
  const material = iconMaterial();
  const pickables: THREE.Mesh[] = [];
  const add = (geometry: THREE.BufferGeometry, offsetY = 0): void => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = offsetY;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 20;
    mesh.userData.furnitureIconAction = action;
    group.add(mesh);
    pickables.push(mesh);
  };
  if (action === 'store') {
    const [body, lid, handle] = storeGeometry();
    add(body!, 0);
    add(lid!, 0.095);
    add(handle!, 0.12);
  } else {
    add(arrowGeometry(action === 'rotate-left' ? -1 : 1));
  }
  return { action, group, material, pickables };
}

export class FurnitureIconSet {
  readonly root = new THREE.Group();
  private readonly entries: IconEntry[];

  constructor() {
    this.root.name = 'furniture-operation-icons';
    this.entries = [
      buildIcon('rotate-left'),
      buildIcon('store'),
      buildIcon('rotate-right'),
    ];
    for (const entry of this.entries) this.root.add(entry.group);
    this.root.visible = false;
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  setHover(action: FurnitureIconAction | null): void {
    for (const entry of this.entries) {
      entry.material.emissiveIntensity = entry.action === action ? 0.95 : 0.32;
    }
  }

  pick(raycaster: THREE.Raycaster): FurnitureIconAction | null {
    if (!this.root.visible) return null;
    this.root.updateMatrixWorld(true);
    const hits = raycaster.intersectObjects(
      this.entries.flatMap((entry) => entry.group.children),
      false,
    );
    for (const hit of hits) {
      const action = hit.object.userData.furnitureIconAction;
      if (
        action === 'rotate-left' ||
        action === 'store' ||
        action === 'rotate-right'
      ) {
        return action;
      }
    }
    return null;
  }

  /**
   * 排列在选中家具下方（屏幕下方），沿相机右向排列；
   * 图标自身朝向相机，俯视时形成可辨认的平面轮廓。
   */
  placeAt(anchor: THREE.Vector3, camera: THREE.Camera): void {
    camera.updateMatrixWorld(true);
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    right.y = 0;
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const scale = ICON_SIZE / 0.2;
    this.entries.forEach((entry, index) => {
      entry.group.position
        .copy(anchor)
        .addScaledVector(right, (index - 1) * ICON_SPACING);
      entry.group.quaternion.copy(camera.quaternion);
      entry.group.scale.setScalar(scale);
    });
    this.root.visible = true;
  }

  dispose(): void {
    this.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) for (const item of material) item.dispose();
      else material?.dispose();
    });
    this.root.clear();
  }
}
