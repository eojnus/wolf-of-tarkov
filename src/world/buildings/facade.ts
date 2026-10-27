/**
 * 立面生成 —— 用「窗下墙 + 窗间墙 + 过梁 + 凹窗玻璃」搭出真实洞口，不靠贴图假装窗户。
 *
 * 坐标约定：局部原点在**声明空间**的底面中心，+Y 向上，+Z 为正立面。
 * 墙体、线脚、基座全部落在 `plan.body` 范围内（主体已从声明空间退让出装饰占位），
 * 所有构件按米制 UV 生成，贴图密度统一，不出现「同一材质在不同构件上被拉伸」。
 */

import * as THREE from 'three';
import type { BuildingMaterials } from './assets';
import type { BuildingAssembly } from './geometry';
import type { FacePlan, ResolvedPlan } from './plan';

interface Face {
  /** 窗洞沿哪个轴排布（'x' 表示沿 x 展开的正面/背面）。 */
  readonly axis: 'x' | 'z';
  /** 外法线方向。 */
  readonly sign: 1 | -1;
  /** 沿切线方向的长度（米）。 */
  readonly length: number;
  /** 切线方向上该立面中心相对局部原点的偏移。 */
  readonly center: number;
  /** 外表面所在的 z（axis='x'）或 x（axis='z'）坐标。 */
  readonly plane: number;
  readonly plan: FacePlan;
}

function facesOf(plan: ResolvedPlan): readonly Face[] {
  const halfWidth = plan.body.width / 2;
  return [
    {
      axis: 'x',
      sign: 1,
      length: plan.body.width,
      center: 0,
      plane: plan.body.frontZ,
      plan: plan.faces.front,
    },
    {
      axis: 'x',
      sign: -1,
      length: plan.body.width,
      center: 0,
      plane: plan.body.backZ,
      plan: plan.faces.back,
    },
    {
      axis: 'z',
      sign: 1,
      length: plan.body.depth,
      center: plan.body.centerZ,
      plane: halfWidth,
      plan: plan.faces.right,
    },
    {
      axis: 'z',
      sign: -1,
      length: plan.body.depth,
      center: plan.body.centerZ,
      plane: -halfWidth,
      plan: plan.faces.left,
    },
  ];
}

/** 每层楼板标高（含地面层）。 */
export function floorLevels(plan: ResolvedPlan): readonly number[] {
  return plan.floors;
}

export function floorHeightOf(plan: ResolvedPlan, floor: number): number {
  if (floor <= 0) return plan.groundHeight;
  const next = plan.floors[floor + 1];
  return next === undefined ? plan.upperHeight : next - plan.floors[floor];
}

/**
 * 在某个立面上放一块墙体构件。
 *
 * `alongCenter` / `alongSize` 是切线方向的中心与尺寸（相对该立面中心）；
 * 法线方向按墙厚向内生长，因此外墙外表面精确落在 `face.plane` 上。
 */
function facePiece(
  assembly: BuildingAssembly,
  face: Face,
  material: THREE.Material,
  tileMeters: number,
  alongCenter: number,
  alongSize: number,
  yCenter: number,
  ySize: number,
  thickness: number,
  inset = 0,
): void {
  const normalCenter = face.plane - face.sign * (inset + thickness / 2);
  const along = face.center + alongCenter;
  if (face.axis === 'x') {
    assembly.box(material, [alongSize, ySize, thickness], [along, yCenter, normalCenter], tileMeters);
  } else {
    assembly.box(material, [thickness, ySize, alongSize], [normalCenter, yCenter, along], tileMeters);
  }
}

/** 凹窗：玻璃 + 上下横挺 + 两侧竖挺 + 中挺，玻璃退进墙面。 */
function windowUnit(
  assembly: BuildingAssembly,
  face: Face,
  materials: BuildingMaterials,
  tileMeters: number,
  alongCenter: number,
  width: number,
  yBottom: number,
  height: number,
  inset: number,
  frameWidth: number,
): void {
  const glassThickness = 0.05;
  facePiece(
    assembly,
    face,
    materials.glass,
    tileMeters,
    alongCenter,
    width,
    yBottom + height / 2,
    height,
    glassThickness,
    inset,
  );

  const frameDepth = 0.1;
  const frameInset = Math.max(0, inset - 0.02);
  facePiece(assembly, face, materials.frame, tileMeters, alongCenter, width, yBottom + frameWidth / 2, frameWidth, frameDepth, frameInset);
  facePiece(
    assembly,
    face,
    materials.frame,
    tileMeters,
    alongCenter,
    width,
    yBottom + height - frameWidth / 2,
    frameWidth,
    frameDepth,
    frameInset,
  );
  for (const side of [-1, 1]) {
    facePiece(
      assembly,
      face,
      materials.frame,
      tileMeters,
      alongCenter + (side * (width - frameWidth)) / 2,
      frameWidth,
      yBottom + height / 2,
      height,
      frameDepth,
      frameInset,
    );
  }
  // 中挺：宽窗分两扇，避免整面玻璃像一块塑料板
  if (width > 1.9) {
    facePiece(
      assembly,
      face,
      materials.frame,
      tileMeters,
      alongCenter,
      frameWidth * 0.8,
      yBottom + height / 2,
      height,
      frameDepth,
      frameInset,
    );
  }
}

export interface ShellOptions {
  readonly assembly: BuildingAssembly;
  readonly plan: ResolvedPlan;
  readonly materials: BuildingMaterials;
  readonly tileMeters: number;
  readonly accentTileMeters: number;
}

/**
 * 生成墙体、窗洞、层间线脚与地面层基座。
 *
 * 地面层正面留出入口洞口（左右墙段 + 过梁），其余立面按标准层处理；
 * 办公楼的地面层做连续商业橱窗（基座 + 通高玻璃 + 竖挺 + 过梁）。
 */
export function buildShell(options: ShellOptions): void {
  const { assembly, plan, materials, tileMeters, accentTileMeters } = options;
  const facade = plan.facade;
  const t = facade.wallThickness;
  const faces = facesOf(plan);

  for (let floor = 0; floor < plan.storeys; floor += 1) {
    const y0 = plan.floors[floor];
    const h = floorHeightOf(plan, floor);
    const ground = floor === 0;

    for (const face of faces) {
      const isFront = face.axis === 'x' && face.sign === 1;
      const { bays, bayWidth } = face.plan;
      const pier = Math.min(facade.pierWidth, bayWidth * 0.34);
      // 地面层的窗洞比标准层高一点，但始终留出窗下墙与过梁
      const openBottom = ground ? Math.min(facade.sillHeight + 0.55, h * 0.35) : facade.sillHeight;
      const openTop = ground ? Math.min(facade.headHeight + 0.5, h - 0.5) : facade.headHeight;

      if (ground && plan.entrance.shopfront) {
        buildShopfront(assembly, face, materials, tileMeters, accentTileMeters, plan, bayWidth, pier);
        continue;
      }

      if (ground && isFront) {
        buildGroundFront(assembly, face, materials, tileMeters, plan, bayWidth, pier, h);
        continue;
      }

      // 窗下墙 / 过梁：整面贯通，洞口由竖挺切出
      facePiece(assembly, face, materials.wall, tileMeters, 0, face.length, y0 + openBottom / 2, openBottom, t);
      facePiece(
        assembly,
        face,
        materials.wall,
        tileMeters,
        0,
        face.length,
        y0 + (openTop + h) / 2,
        Math.max(0.12, h - openTop),
        t,
      );

      // 窗间墙（含两端）
      for (let index = 0; index <= bays; index += 1) {
        let along = -face.length / 2 + index * bayWidth;
        if (index === 0) along = -face.length / 2 + pier / 2;
        else if (index === bays) along = face.length / 2 - pier / 2;
        facePiece(
          assembly,
          face,
          materials.wall,
          tileMeters,
          along,
          pier,
          y0 + (openBottom + openTop) / 2,
          openTop - openBottom,
          t,
        );
      }

      // 凹窗玻璃与窗框
      for (let index = 0; index < bays; index += 1) {
        const along = -face.length / 2 + (index + 0.5) * bayWidth;
        const width = bayWidth - pier - 0.06;
        if (width < 0.6) continue;
        windowUnit(
          assembly,
          face,
          materials,
          tileMeters,
          along,
          width,
          y0 + openBottom,
          openTop - openBottom,
          facade.glassInset,
          facade.frameWidth,
        );
      }
    }

    // 层间线脚：横贯四周的浅挑檐（挑出量远小于 sideInset / frontInset）
    if (facade.bandedFloors && floor > 0) {
      const bandHeight = 0.26;
      const y = y0 - bandHeight / 2;
      for (const face of faces) {
        facePiece(assembly, face, materials.trim, tileMeters, 0, face.length + 0.24, y, bandHeight, t + 0.16, -0.08);
      }
    }
  }

  // 基座：地面层外圈一道深色石材，压住建筑与地面的接缝
  const plinthHeight = Math.min(0.45, plan.groundHeight * 0.15);
  for (const face of faces) {
    facePiece(
      assembly,
      face,
      materials.accent,
      accentTileMeters,
      0,
      face.length + 0.16,
      plinthHeight / 2,
      plinthHeight,
      t + 0.1,
      -0.05,
    );
  }
}

/** 地面层正面：左右墙段 + 门洞 + 过梁，形成真实入口凹龛。 */
function buildGroundFront(
  assembly: BuildingAssembly,
  face: Face,
  materials: BuildingMaterials,
  tileMeters: number,
  plan: ResolvedPlan,
  bayWidth: number,
  pier: number,
  floorHeight: number,
): void {
  const entrance = plan.entrance;
  const doorWidth = Math.min(entrance.width, face.length * 0.3);
  const doorTop = Math.min(entrance.height, floorHeight - 0.4);
  const sideWidth = (face.length - doorWidth) / 2;
  const sill = Math.min(0.9, floorHeight * 0.25);

  for (const side of [-1, 1]) {
    const along = side * (doorWidth / 2 + sideWidth / 2);
    facePiece(assembly, face, materials.wall, tileMeters, along, sideWidth, sill / 2, sill, plan.facade.wallThickness);
    facePiece(
      assembly,
      face,
      materials.wall,
      tileMeters,
      along,
      sideWidth,
      (doorTop + floorHeight) / 2,
      Math.max(0.2, floorHeight - doorTop),
      plan.facade.wallThickness,
    );
    const windowWidth = Math.min(sideWidth - pier * 1.6, bayWidth - pier);
    if (windowWidth > 0.9) {
      windowUnit(
        assembly,
        face,
        materials,
        tileMeters,
        along,
        windowWidth,
        sill,
        doorTop - sill,
        plan.facade.glassInset,
        plan.facade.frameWidth,
      );
    }
  }

  // 门洞过梁与两侧门垛
  facePiece(
    assembly,
    face,
    materials.wall,
    tileMeters,
    0,
    doorWidth,
    (doorTop + floorHeight) / 2,
    Math.max(0.2, floorHeight - doorTop),
    plan.facade.wallThickness,
  );
  for (const side of [-1, 1]) {
    facePiece(
      assembly,
      face,
      materials.frame,
      tileMeters,
      side * (doorWidth / 2 - 0.06),
      0.12,
      doorTop / 2,
      doorTop,
      0.2,
      -0.1,
    );
  }
  // 凹进的门厅玻璃门 + 顶部压条
  facePiece(assembly, face, materials.glass, tileMeters, 0, doorWidth - 0.2, doorTop / 2, doorTop - 0.1, 0.06, 0.35);
  facePiece(assembly, face, materials.frame, tileMeters, 0, doorWidth - 0.1, doorTop - 0.03, 0.1, 0.22, -0.12);
}

/** 商业裙房：基座 + 通高橱窗 + 竖挺 + 过梁 + 主入口洞口。 */
function buildShopfront(
  assembly: BuildingAssembly,
  face: Face,
  materials: BuildingMaterials,
  tileMeters: number,
  accentTileMeters: number,
  plan: ResolvedPlan,
  bayWidth: number,
  pier: number,
): void {
  const h = plan.groundHeight;
  const glassBottom = 0.5;
  const glassTop = h - 0.7;
  const isFront = face.sign === 1 && face.axis === 'x';
  const entrance = plan.entrance;
  const doorWidth = isFront ? Math.min(entrance.width, face.length * 0.28) : 0;

  facePiece(
    assembly,
    face,
    materials.accent,
    accentTileMeters,
    0,
    face.length,
    glassBottom / 2,
    glassBottom,
    plan.facade.wallThickness + 0.08,
    -0.04,
  );
  facePiece(
    assembly,
    face,
    materials.accent,
    accentTileMeters,
    0,
    face.length,
    (glassTop + h) / 2,
    Math.max(0.2, h - glassTop),
    plan.facade.wallThickness + 0.08,
    -0.04,
  );

  const { bays } = face.plan;
  for (let index = 0; index < bays; index += 1) {
    const along = -face.length / 2 + (index + 0.5) * bayWidth;
    const width = bayWidth - pier;
    if (isFront && Math.abs(along) < doorWidth / 2 + bayWidth * 0.25) {
      facePiece(
        assembly,
        face,
        materials.glass,
        tileMeters,
        along,
        width,
        glassBottom + (entrance.height - glassBottom) / 2,
        entrance.height - glassBottom,
        0.06,
        0.32,
      );
      continue;
    }
    windowUnit(assembly, face, materials, tileMeters, along, width, glassBottom, glassTop - glassBottom, 0.14, 0.09);
  }

  // 竖挺：把连续橱窗切成真实开间
  for (let index = 0; index <= bays; index += 1) {
    let along = -face.length / 2 + index * bayWidth;
    if (index === 0) along = -face.length / 2 + pier / 2;
    else if (index === bays) along = face.length / 2 - pier / 2;
    facePiece(
      assembly,
      face,
      materials.frame,
      tileMeters,
      along,
      pier * 0.6,
      (glassBottom + glassTop) / 2,
      glassTop - glassBottom,
      0.24,
      -0.06,
    );
  }

  if (isFront) {
    for (const side of [-1, 1]) {
      facePiece(
        assembly,
        face,
        materials.frame,
        tileMeters,
        side * (doorWidth / 2 + 0.06),
        0.14,
        entrance.height / 2,
        entrance.height,
        0.24,
        -0.08,
      );
    }
    facePiece(assembly, face, materials.frame, tileMeters, 0, doorWidth + 0.28, entrance.height + 0.05, 0.12, 0.26, -0.08);
  }
}
