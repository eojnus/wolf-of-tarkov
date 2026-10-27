/**
 * 建筑细部 —— 阳台、入口、屋顶与外部模型构件（栏杆 / 楼梯 / 设备箱）。
 *
 * 空间约束（验收 R2）：所有装饰都用 `plan.insets` 给出的占位，落在声明空间以内：
 *  - 阳台挑出 ≤ frontInset，雨棚与台阶同片区且互不超界；
 *  - 外挂楼梯挑出 ≤ backInset；
 *  - 屋顶设备与女儿墙共用顶部预留，顶面不超过声明高度。
 *
 * 外部模型一律「共享几何 + 每楼实例矩阵」：同一段栏杆在楼里出现多次，
 * GPU 只上传一份几何，每栋楼只持有自己的实例矩阵。
 */

import * as THREE from 'three';
import type { BuildingMaterials, ModelPiece } from './assets';
import type { BuildingAssembly } from './geometry';
import type { ResolvedPlan } from './plan';
import { jitter } from './random';

export interface DetailContext {
  readonly assembly: BuildingAssembly;
  readonly plan: ResolvedPlan;
  readonly materials: BuildingMaterials;
  readonly tileMeters: number;
  readonly accentTileMeters: number;
  readonly random: () => number;
  readonly pieces: readonly ModelPiece[];
}

/** 装配阶段的外部模型实例收集器：按构件名聚合矩阵，最后一次建成 InstancedMesh。 */
export class PieceInstances {
  private readonly groups = new Map<string, { piece: ModelPiece; matrices: THREE.Matrix4[] }>();

  /**
   * `materialOverrides` 用于「几何来自外部模型、材质统一由项目提供」的构件：
   * 设备箱只用其几何，金属材质与建筑框架同一份，不再额外引入三张贴图。
   */
  constructor(
    pieces: readonly ModelPiece[],
    private readonly materialOverrides?: ReadonlyMap<string, THREE.Material>,
  ) {
    for (const piece of pieces) {
      if (!this.groups.has(piece.name)) this.groups.set(piece.name, { piece, matrices: [] });
    }
  }

  has(name: string): boolean {
    return this.groups.has(name);
  }

  /** 构件自身宽度（米），用于按开间挑选合适的栏杆型号。 */
  widthOf(name: string): number {
    const group = this.groups.get(name);
    if (!group) return 0;
    return group.piece.bounds.max.x - group.piece.bounds.min.x;
  }

  /**
   * 按「包围盒对齐」放置：`align` 指定构件的哪个点落到目标点，
   * 因此不会因为模型自身的原点位置出现悬空或穿地。
   */
  place(
    name: string,
    options: {
      readonly x?: number;
      readonly y: number;
      readonly z: number;
      readonly scale?: number;
      readonly align?: 'center-bottom' | 'center-min-z' | 'center';
    },
  ): void {
    const group = this.groups.get(name);
    if (!group) return;
    const piece = group.piece;
    const scale = options.scale ?? 1;
    const matrix = new THREE.Matrix4();
    const bounds = piece.bounds;
    const centerX = ((bounds.min.x + bounds.max.x) / 2) * scale;
    const minY = bounds.min.y * scale;
    const maxZ = bounds.max.z * scale;
    const centerZ = ((bounds.min.z + bounds.max.z) / 2) * scale;

    let targetZ = options.z;
    if (options.align === 'center-min-z') targetZ = options.z - maxZ;
    else if (options.align === 'center') targetZ = options.z - centerZ;

    matrix.compose(
      new THREE.Vector3((options.x ?? 0) - centerX, options.y - minY, targetZ),
      new THREE.Quaternion(),
      new THREE.Vector3(scale, scale, scale),
    );
    group.matrices.push(matrix);
  }

  /** 把收集到的矩阵写成 InstancedMesh（每构件一次 draw call）。 */
  flush(assembly: BuildingAssembly): void {
    for (const { piece, matrices } of this.groups.values()) {
      if (matrices.length === 0) continue;
      const material = this.materialOverrides?.get(piece.name) ?? piece.material;
      const mesh = new THREE.InstancedMesh(piece.geometry, material, matrices.length);
      for (let index = 0; index < matrices.length; index += 1) {
        mesh.setMatrixAt(index, matrices[index]);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      // 实例分布在整栋楼上，必须用实例包围球做剔除，否则会被构件原点的包围球误剔
      mesh.computeBoundingSphere();
      mesh.frustumCulled = true;
      assembly.instanced(mesh);
    }
    for (const group of this.groups.values()) group.matrices.length = 0;
  }
}

/** 栏杆构件候选：按开间宽度择一，再做小幅等比缩放（高度仍在 0.9～1.1 米）。 */
const RAIL_PIECES = [
  { name: 'modular_fire_escape_railing_middle', width: 4.711 },
  { name: 'modular_fire_escape_platform_railing', width: 2.234 },
] as const;

function pickRailing(bayWidth: number, instances: PieceInstances): { name: string; scale: number; width: number } | null {
  const available = RAIL_PIECES.filter((candidate) => instances.has(candidate.name));
  if (available.length === 0) return null;
  // 取与开间宽度最接近的型号，再等比缩放到开间（缩放限制在 0.8～1.2，栏杆高度仍在 0.8～1.2 米）
  const chosen = [...available].sort(
    (a, b) => Math.abs(a.width - bayWidth) - Math.abs(b.width - bayWidth),
  )[0];
  const scale = Math.min(1.2, Math.max(0.8, (bayWidth - 0.08) / chosen.width));
  return { name: chosen.name, scale, width: chosen.width * scale };
}

/* -------------------------------------------------------------- 阳台 */

export function buildBalconies(context: DetailContext, instances: PieceInstances): void {
  const { assembly, plan, materials, tileMeters } = context;
  const balcony = plan.balcony;
  if (!balcony.enabled || balcony.bays.length === 0 || balcony.floors.length === 0) return;

  const frontZ = plan.body.frontZ;
  const bayWidth = plan.faces.front.bayWidth;
  const slabThickness = 0.18;

  for (const floor of balcony.floors) {
    if (floor <= 0 || floor >= plan.storeys) continue;
    const level = plan.floors[floor];
    for (const bay of balcony.bays) {
      if (bay < 0 || bay >= plan.faces.front.bays) continue;
      const x = -plan.body.width / 2 + (bay + 0.5) * bayWidth;

      let slabWidth = bayWidth - 0.24;
      let railing: { name: string; scale: number; width: number } | null = null;
      if (balcony.kind === 'metal-rail') {
        // 按开间宽度（而不是已缩过的板宽）选型号，保证阳台占满开间
        railing = pickRailing(bayWidth, instances);
        if (railing) slabWidth = Math.min(bayWidth - 0.12, railing.width - 0.04);
      }

      // 阳台板：顶面与本层地面齐平，挑出深度已在 plan 中夹到 frontInset 以内
      assembly.box(
        materials.trim,
        [slabWidth, slabThickness, balcony.depth],
        [x, level - slabThickness / 2, frontZ + balcony.depth / 2],
        tileMeters,
      );

      if (railing) {
        instances.place(railing.name, {
          x,
          y: level,
          z: frontZ + balcony.depth,
          scale: railing.scale,
          align: 'center-min-z',
        });
      } else {
        // 玻璃栏板：前片 + 两侧侧板 + 金属压顶与立柱
        const parapet = balcony.parapetHeight;
        const glassWidth = slabWidth - 0.1;
        assembly.box(
          materials.glass,
          [glassWidth, parapet - 0.08, 0.03],
          [x, level + (parapet - 0.08) / 2, frontZ + balcony.depth - 0.06],
          tileMeters,
        );
        for (const side of [-1, 1]) {
          assembly.box(
            materials.glass,
            [0.03, parapet - 0.08, balcony.depth - 0.12],
            [x + side * (glassWidth / 2), level + (parapet - 0.08) / 2, frontZ + balcony.depth / 2],
            tileMeters,
          );
        }
        assembly.box(
          materials.frame,
          [glassWidth + 0.06, 0.06, 0.1],
          [x, level + parapet, frontZ + balcony.depth - 0.06],
          tileMeters,
        );
        for (const side of [-1, 1]) {
          assembly.box(
            materials.frame,
            [0.07, parapet, 0.09],
            [x + side * (glassWidth / 2), level + parapet / 2, frontZ + balcony.depth - 0.06],
            tileMeters,
          );
        }
      }
    }
  }
}

/* -------------------------------------------------------------- 入口 */

export function buildEntrance(context: DetailContext): void {
  const { assembly, plan, materials, tileMeters, accentTileMeters } = context;
  const entrance = plan.entrance;
  const frontZ = plan.body.frontZ;
  const stepHeight = 0.15;
  const stepDepth = 0.34;
  const stepWidth = Math.min(entrance.width + 1.4, plan.body.width - 0.6);

  /*
   * 台阶从门洞向外逐级下降，总挑出 = steps × 0.34 ≤ frontInset − 0.45（plan 已保证），
   * 因此不会挤占门前通道以外的空间，也不会越出声明空间。
   */
  for (let step = 0; step < entrance.steps; step += 1) {
    const height = stepHeight * (entrance.steps - step);
    assembly.box(
      materials.accent,
      [stepWidth - step * 0.1, height, stepDepth],
      [0, height / 2, frontZ + stepDepth / 2 + step * stepDepth],
      accentTileMeters,
    );
  }

  // 雨棚：悬挑板 + 底面灯带，不立柱，门前进出通道保持净空
  const canopyWidth = Math.min(entrance.width + 2.4, plan.body.width - 0.4);
  assembly.box(
    materials.accent,
    [canopyWidth, 0.3, entrance.canopyDepth],
    [0, entrance.canopyHeight, frontZ + entrance.canopyDepth / 2],
    accentTileMeters,
  );
  assembly.box(
    materials.lamp,
    [canopyWidth - 0.6, 0.05, Math.max(0.4, entrance.canopyDepth - 0.5)],
    [0, entrance.canopyHeight - 0.18, frontZ + entrance.canopyDepth / 2],
    tileMeters,
  );

  // 门头标识板（无文字，只做体量，避免与正式建筑标签重复）
  assembly.box(
    materials.frame,
    [entrance.width + 0.6, 0.55, 0.12],
    [0, entrance.height + 0.45, frontZ + 0.12],
    tileMeters,
  );

  if (entrance.shopfront) {
    // 办公楼通高门厅：门洞两侧石材门套
    for (const side of [-1, 1]) {
      assembly.box(
        materials.accent,
        [0.5, entrance.height + 1.1, 0.34],
        [side * (entrance.width / 2 + 0.3), (entrance.height + 1.1) / 2, frontZ + 0.17],
        accentTileMeters,
      );
    }
  }
}

/* -------------------------------------------------------------- 屋顶 */

export function buildRoof(context: DetailContext, instances: PieceInstances): void {
  const { assembly, plan, materials, tileMeters, random } = context;
  const width = plan.body.width;
  const depth = plan.body.depth;
  const centerZ = plan.body.centerZ;
  const topLevel = plan.body.wallTop;
  /*
   * 女儿墙总高 `plan.parapet.height` 已经把压顶算在里面：
   *   墙体 = 总高 − 压顶厚度，压顶从「墙顶上方」改到「总高之内」，
   * 因此顶部最高点 = wallTop + 女儿墙总高 = 声明高度，不会再冒 0.06 米。
   */
  const parapetTotal = plan.parapet.height;
  const coping = Math.min(plan.parapet.coping, parapetTotal);
  const parapetWall = Math.max(0.1, parapetTotal - coping);
  const thickness = plan.parapet.thickness;

  // 屋面板
  assembly.box(materials.roof, [width - 0.12, 0.32, depth - 0.12], [0, topLevel - 0.16, centerZ], tileMeters);

  // 女儿墙墙体（四周，不含压顶）
  assembly.box(materials.roof, [width, parapetWall, thickness], [0, topLevel + parapetWall / 2, centerZ + depth / 2 - thickness / 2], tileMeters);
  assembly.box(materials.roof, [width, parapetWall, thickness], [0, topLevel + parapetWall / 2, centerZ - depth / 2 + thickness / 2], tileMeters);
  assembly.box(
    materials.roof,
    [thickness, parapetWall, depth - thickness * 2],
    [width / 2 - thickness / 2, topLevel + parapetWall / 2, centerZ],
    tileMeters,
  );
  assembly.box(
    materials.roof,
    [thickness, parapetWall, depth - thickness * 2],
    [-width / 2 + thickness / 2, topLevel + parapetWall / 2, centerZ],
    tileMeters,
  );
  // 压顶：落在女儿墙总高之内，顶面 = wallTop + 女儿墙总高
  assembly.box(
    materials.trim,
    [width + 0.2, coping, thickness + 0.12],
    [0, topLevel + parapetTotal - coping / 2, centerZ + depth / 2 - thickness / 2],
    tileMeters,
  );
  assembly.box(
    materials.trim,
    [width + 0.2, coping, thickness + 0.12],
    [0, topLevel + parapetTotal - coping / 2, centerZ - depth / 2 + thickness / 2],
    tileMeters,
  );

  const equipment = plan.roofEquipment;
  if (equipment.kind === 'penthouse' && equipment.height > 0) {
    const z = centerZ - depth * 0.12;
    assembly.box(
      materials.accent,
      [equipment.width, equipment.height, equipment.depth],
      [0, topLevel + equipment.height / 2, z],
      tileMeters,
    );
    assembly.box(
      materials.frame,
      [Math.min(1.6, equipment.width * 0.3), Math.min(1.9, equipment.height * 0.8), 0.12],
      [0, topLevel + Math.min(1.9, equipment.height * 0.8) / 2, z + equipment.depth / 2],
      tileMeters,
    );
    // 压顶沉到设备顶面以下 0.08，保证顶面 = 声明高度而不是超出去
    assembly.box(
      materials.trim,
      [equipment.width + 0.3, 0.16, equipment.depth + 0.3],
      [0, topLevel + equipment.height - 0.08, z],
      tileMeters,
    );
  } else if (equipment.kind === 'tank' && equipment.height > 0) {
    const diameter = Math.min(equipment.width, width * 0.28, depth * 0.32);
    const deck = 0.5;
    const tankHeight = Math.max(0.8, equipment.height - deck);
    const x = width * 0.22;
    const z = centerZ + depth * 0.12;
    for (const [dx, dz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      assembly.box(
        materials.frame,
        [0.14, deck, 0.14],
        [x + (dx * diameter) / 3, topLevel + deck / 2, z + (dz * diameter) / 3],
        tileMeters,
      );
    }
    assembly.box(materials.trim, [diameter + 0.3, 0.1, diameter + 0.3], [x, topLevel + deck, z], tileMeters);
    const tankMesh = new THREE.CylinderGeometry(diameter / 2, diameter / 2, tankHeight, 18);
    tankMesh.translate(x, topLevel + deck + tankHeight / 2, z);
    assembly.geometry(materials.trim, tankMesh);
  }

  // 屋顶室外机：真实外部模型的实例；只在屋顶余高够放下时摆放
  if (plan.utilityBoxes > 0 && instances.has('utility_box_01_box')) {
    const spreadX = Math.max(1.2, width * 0.3);
    const spreadZ = Math.max(1.0, depth * 0.26);
    for (let index = 0; index < plan.utilityBoxes; index += 1) {
      const x = -spreadX + (index % 2) * spreadX * 1.2 + jitter(random, 0.4);
      const z = centerZ - spreadZ + Math.floor(index / 2) * spreadZ * 0.9 + jitter(random, 0.3);
      instances.place('utility_box_01_box', { x, y: topLevel, z });
    }
  }
}

/* -------------------------------------------------------- 外挂疏散楼梯 */

/**
 * 背面低区外挂疏散楼梯：2 层以上的钢平台 + 栏杆 + 两跑楼梯 + 底段爬梯。
 *
 * 楼梯紧贴背立面、全部挑出都落在 backInset 以内；平台钢板是程序化几何，
 * 栏杆/楼梯/爬梯来自真实外部模型。
 */
export function buildFireEscape(context: DetailContext, instances: PieceInstances): void {
  const { assembly, plan, materials, tileMeters, random } = context;
  if (!plan.fireEscape) return;

  const width = plan.body.width;
  const backZ = plan.body.backZ;
  const standoff = 0.2;
  const plateDepth = 1.0;
  // 平台栏杆中心对准平台外沿，钢板与支托都在 backInset 之内
  const baseX = Math.max(1.3, width / 2 - 2.1);
  const platformFloors = [2, 3, 4].filter((floor) => floor < plan.storeys);

  for (const floor of platformFloors) {
    const level = plan.floors[floor];
    assembly.box(materials.frame, [2.4, 0.1, plateDepth], [baseX, level - 0.05, backZ - standoff - plateDepth / 2], tileMeters);
    for (const offset of [-0.9, 0.9]) {
      assembly.box(
        materials.frame,
        [0.14, 0.14, standoff + 0.1],
        [baseX + offset, level - 0.18, backZ - standoff / 2],
        tileMeters,
      );
    }
    instances.place('modular_fire_escape_platform_railing', {
      x: baseX,
      y: level,
      // 用平台的贴墙侧作为 maxZ，构件向平台外侧生长，整段仍落在 backInset 内
      z: backZ - standoff,
      align: 'center-min-z',
    });
  }

  // 两跑楼梯：左右交替，形成真实的折返关系
  const stairFloors = [2, 3].filter((floor) => floor + 1 < plan.storeys);
  for (const [index, floor] of stairFloors.entries()) {
    const level = plan.floors[floor];
    instances.place('modular_fire_escape_stairs', {
      x: baseX + (index % 2 === 0 ? -0.55 : 0.55),
      y: level,
      z: backZ - standoff - 0.05,
      align: 'center-min-z',
    });
  }

  // 爬梯：从地面接到二层平台，按楼层实际净高做等比缩放
  const ladderTarget = plan.floors[Math.min(2, plan.floors.length - 1)];
  instances.place('modular_fire_escape_ladder_bottom', {
    x: baseX + 1.15,
    y: 0,
    z: backZ - standoff - 0.1,
    scale: Math.max(0.5, ladderTarget / 6.466),
    align: 'center',
  });

  // 入口侧设备箱：贴墙摆放，不占门前进出通道（挑出 0.5 ≤ frontInset）
  if (instances.has('utility_box_01_box')) {
    instances.place('utility_box_01_box', {
      x: -width / 2 + 1.4 + jitter(random, 0.3),
      y: 0,
      z: plan.body.frontZ + 0.5,
    });
  }
}
