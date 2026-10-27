/**
 * 几何构件与合批 —— 建筑原型里所有程序化构件都从这里产出。
 *
 * 规则：
 *  - 米制 UV：所有盒体的贴图坐标按「真实米数 ÷ 贴图循环米数」写入，
 *    因此 3 米的墙板和 0.3 米的窗台不会共用同一段贴图，也不会被拉伸；
 *  - 按材质合批：同一材质的全部构件合并成一个网格 = 一个 draw call，
 *    不用「每扇窗一个 Mesh」，也不为每栋楼单独建大材质；
 *  - 外部模型构件（GLB）走 InstancedMesh，几何与材质来自共享模板，
 *    每栋楼只持有自己的实例矩阵，因此删一栋楼不会影响别栋。
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** 6 个面的 (u, v) 真实尺寸对应的盒体边长。顺序与 BoxGeometry 的面顺序一致。 */
function faceDimensions(sx: number, sy: number, sz: number): Array<[number, number]> {
  return [
    [sz, sy], // +x
    [sz, sy], // -x
    [sx, sz], // +y
    [sx, sz], // -y
    [sx, sy], // +z
    [sx, sy], // -z
  ];
}

/**
 * 生成米制 UV 的盒体。
 *
 * `tileMeters` 是一次贴图循环覆盖的米数；`uvOffset` 用来避免相邻构件出现完全相同的纹理相位。
 */
export function metricBox(
  size: readonly [number, number, number],
  tileMeters: number,
  uvOffset: readonly [number, number] = [0, 0],
): THREE.BoxGeometry {
  const [sx, sy, sz] = size;
  const geometry = new THREE.BoxGeometry(sx, sy, sz);
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  const array = uv.array as Float32Array;
  const dims = faceDimensions(sx, sy, sz);
  for (let face = 0; face < 6; face += 1) {
    const [du, dv] = dims[face];
    const su = du / tileMeters;
    const sv = dv / tileMeters;
    for (let corner = 0; corner < 4; corner += 1) {
      const index = (face * 4 + corner) * 2;
      array[index] = array[index] * su + uvOffset[0];
      array[index + 1] = array[index + 1] * sv + uvOffset[1];
    }
  }
  uv.needsUpdate = true;
  return geometry;
}

/** 三角面数：优先用索引数，退化到位置属性。 */
export function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  if (index) return index.count / 3;
  const position = geometry.getAttribute('position');
  return position ? position.count / 3 : 0;
}

export interface AssemblyStats {
  drawCalls: number;
  triangles: number;
}

/**
 * 一栋楼的构件装配器。
 *
 * 生命周期约定：
 *  - 合批几何体由本实例**拥有**，`dispose()` 时释放；
 *  - 外部模型实例只持有 instanceMatrix，`dispose()` 只释放实例属性，不碰共享几何/材质；
 *  - 材质一律由材质库提供，本类不创建也不释放材质。
 */
export class BuildingAssembly {
  private readonly buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private readonly props: THREE.InstancedMesh[] = [];
  private triangles = 0;
  private mergedMeshes = 0;

  /** 放一个米制 UV 盒体：`center` 为盒体中心（局部坐标）。 */
  box(
    material: THREE.Material,
    size: readonly [number, number, number],
    center: readonly [number, number, number],
    tileMeters: number,
    uvOffset: readonly [number, number] = [0, 0],
  ): void {
    const geometry = metricBox(size, tileMeters, uvOffset);
    geometry.translate(center[0], center[1], center[2]);
    this.push(material, geometry);
  }

  /** 放一个已经处理好变换的几何体（调用方交出所有权）。 */
  geometry(material: THREE.Material, geometry: THREE.BufferGeometry): void {
    this.push(material, geometry);
  }

  /** 放入一个共享几何 + 共享材质的实例网格（如外部模型的栏杆）。 */
  instanced(mesh: THREE.InstancedMesh): void {
    this.props.push(mesh);
    this.triangles += triangleCount(mesh.geometry) * mesh.count;
  }

  private push(material: THREE.Material, geometry: THREE.BufferGeometry): void {
    const list = this.buckets.get(material);
    if (list) list.push(geometry);
    else this.buckets.set(material, [geometry]);
    this.triangles += triangleCount(geometry);
  }

  /**
   * 产出场景节点：每个材质一个合批网格，外加外部模型实例。
   * 调用后本装配器继续可用（增量追加后再 build 会得到新的网格），
   * 但旧网格与几何仍归调用方释放 —— 原型里每栋楼只 build 一次。
   */
  build(): THREE.Group {
    const group = new THREE.Group();
    for (const [material, geometries] of this.buckets) {
      const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
      if (!merged) continue;
      if (geometries.length > 1) {
        for (const item of geometries) item.dispose();
      }
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      group.add(mesh);
      this.mergedMeshes += 1;
    }
    for (const prop of this.props) group.add(prop);
    this.buckets.clear();
    return group;
  }

  stats(): AssemblyStats {
    // 合批后每个材质一个 draw call；外部模型实例每个也算一次。
    return { drawCalls: this.mergedMeshes + this.props.length, triangles: Math.round(this.triangles) };
  }
}

/**
 * 释放一栋楼的场景资源。
 *
 * 只释放本楼拥有的几何体与实例矩阵；共享材质与贴图由材质库按引用计数释放，
 * 因此「删一栋楼」不会把别栋楼正在用的材质/贴图一起释放。
 */
export function disposeBuildingGroup(group: THREE.Object3D): void {
  group.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
      (mesh as THREE.InstancedMesh).dispose();
      return;
    }
    mesh.geometry.dispose();
  });
  group.clear();
}
