/**
 * 场景比例参照 —— 建筑与人物模型的「原始实测高度 → 目标世界高度」对照。
 *
 * 这里的数值只用于表现层的等比缩放，不参与任何业务逻辑，也不是存档契约。
 * 原始高度来自对 GLB 文件实际包围盒的测量（GLB 自身节点变换已生效、
 * 尚未乘游戏缩放、minY = 0），不是美术文件里的名义尺寸。
 *
 * 如实说明：既有五栋建筑的 GLB 都是**单 mesh**，没有门洞、也没有楼层节点，
 * 因此只能以「整栋包围盒高度」作为等比参照；不能据此声称测量过门洞高度。
 * 便利店是程序化几何（无 GLB），所以不在模型参照表里。
 */

import { findBuilding } from './config';

export type ScaleReferenceKind = 'door' | 'storey' | 'total-height';

export interface ModelScaleReference {
  readonly buildingId: string;
  readonly referenceKind: ScaleReferenceKind;
  readonly sourceReferenceHeight: number;
  readonly targetReferenceHeightMeters: number;
  readonly measuredPart: string;
  readonly note: string;
}

/** 目标高度只从 config.size.height 读取，避免参照表与建筑配置各写一份数字。 */
function targetHeightOf(buildingId: string): number {
  const building = findBuilding(buildingId);
  if (!building) {
    throw new Error(`[scene-scale] 配置中不存在建筑：${buildingId}`);
  }
  return building.size.height;
}

/**
 * 旧五栋建筑：均为整栋高度参照。
 *
 * 目标值等于 `BuildingConfig.size.height`：
 * home 12、bank 8、office 16、securities 9、government 9（米）。
 * 等比系数 = targetReferenceHeightMeters / sourceReferenceHeight。
 */
export const MODEL_SCALE_REFERENCES: Readonly<Record<string, ModelScaleReference>> = {
  home: {
    buildingId: 'home',
    referenceKind: 'total-height',
    sourceReferenceHeight: 2.0,
    targetReferenceHeightMeters: targetHeightOf('home'),
    measuredPart: '整栋模型包围盒高度（单 mesh，无门洞/楼层节点）',
    note: 'low-detail-building-a.glb 实测 0.5×2.0×0.5；只能按整栋高度等比缩放，门洞高度未测量。',
  },
  bank: {
    buildingId: 'bank',
    referenceKind: 'total-height',
    sourceReferenceHeight: 1.293,
    targetReferenceHeightMeters: targetHeightOf('bank'),
    measuredPart: '整栋模型包围盒高度（单 mesh，无门洞/楼层节点）',
    note: 'building-a.glb 实测 0.8836×1.293×0.94；只能按整栋高度等比缩放，门洞高度未测量。',
  },
  office: {
    buildingId: 'office',
    referenceKind: 'total-height',
    sourceReferenceHeight: 2.88,
    targetReferenceHeightMeters: targetHeightOf('office'),
    measuredPart: '整栋模型包围盒高度（单 mesh，无门洞/楼层节点）',
    note: 'building-skyscraper-a.glb 实测 1.36×2.88×1.36；只能按整栋高度等比缩放，门洞高度未测量。',
  },
  securities: {
    buildingId: 'securities',
    referenceKind: 'total-height',
    sourceReferenceHeight: 0.893,
    targetReferenceHeightMeters: targetHeightOf('securities'),
    measuredPart: '整栋模型包围盒高度（单 mesh，无门洞/楼层节点）',
    note: 'building-c.glb 实测 0.8836×0.893×1.09；只能按整栋高度等比缩放，门洞高度未测量。',
  },
  government: {
    buildingId: 'government',
    referenceKind: 'total-height',
    sourceReferenceHeight: 1.1,
    targetReferenceHeightMeters: targetHeightOf('government'),
    measuredPart: '整栋模型包围盒高度（单 mesh，无门洞/楼层节点）',
    note: 'low-detail-building-wide-a.glb 实测 1.0×1.1×0.5；只能按整栋高度等比缩放，门洞高度未测量。',
  },
};

export function scaleReferenceFor(buildingId: string): ModelScaleReference | null {
  // 显式放宽为可能 undefined，避免把 Record 的下标访问当成「一定存在」。
  const reference: ModelScaleReference | undefined = MODEL_SCALE_REFERENCES[buildingId];
  return reference ?? null;
}

/**
 * 人物模型参照。
 *
 * Casual_Male.glb 在 rest pose 下的原始包围盒高度为 3.325（米）。
 * `world/character.ts` 已按「包围盒高度等比归一化」处理：
 * scale = targetHeightMeters / rawHeight，脚底贴地、水平居中；
 * 目标高度取 `PLAYER.model.height = 1.78` 米，与建筑参照同一套世界尺度。
 */
export const CHARACTER_SCALE_REFERENCE: {
  rawHeight: number;
  targetHeightMeters: number;
  note: string;
} = {
  rawHeight: 3.325,
  targetHeightMeters: 1.78,
  note: 'Casual_Male.glb rest pose 原始包围盒高 3.325；character.ts 按包围盒高度等比缩放到 1.78 米，脚底贴地。本次不新增人物代码。',
};
