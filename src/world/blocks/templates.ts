/**
 * 三套标准街区模板的**对外规划入口** —— 纯函数，不 import Three.js。
 *
 * 完整模板与全城推广用的是同一个生成器（`generate.ts`），差别只在输入：
 *  - 这里给定标称的 45×45 矩形 → `variant: 'full'`；
 *  - 全城推广按真实可用矩形 → `variant: 'clipped' | 'row'`。
 *
 * 版本语义：`familyId` + `templateVersion` 必须成对解析（见 `blockFamilyById`）。
 * 版本不匹配时返回带 `skip` 的空计划，**绝不回落到最新版**——否则存档里记录的
 * 老版本模板会在读档时悄悄换成新几何。
 */

import {
  BLOCK_FAMILIES,
  blockFamilyById,
  type BlockFamilyDef,
  type BlockFamilyId,
  type DecorFront,
} from '../../content/city-blocks';
import { CITY } from '../../content/config';
import { generatePerimeterBlock } from './generate';
import type { BlockPlan } from './types';

/**
 * 两个完整模板**隔街相邻**时，中间这条街的走廊宽度（米）。
 *
 * 口径 = 人行道 + 车行道 + 人行道（`CITY.sidewalkWidth × 2 + CITY.roadWidth` = 18 m）。
 * 因此相邻模板的中心距 = `nominalSize + STREET_CORRIDOR` = 45 + 18 = **63 m**。
 *
 * 外围道路仍由调用方生成：本模块只保证端口落在净用地边界上、宽度与朝向明确，
 * 不生成也不修改任何道路。
 */
export const STREET_CORRIDOR = CITY.sidewalkWidth * 2 + CITY.roadWidth;

export interface TemplateRequest {
  /** 街区族 id：`residential-courtyard` / `commercial-mixed` / `tech-office`。 */
  readonly familyId: BlockFamilyId | string;
  /** 必须与族定义一致。 */
  readonly templateVersion: number;
  /** 稳定块 id；缺省为 `template-${familyId}-v${version}`。 */
  readonly blockId?: string;
  /** 模板中心（世界坐标），缺省原点。 */
  readonly center?: { readonly x: number; readonly z: number };
  /** 正面朝向（朝向街道），缺省朝南。 */
  readonly front?: DecorFront;
  /** 追加到种子里的稳定后缀：同模板换种子可得到不同的楼体组合。 */
  readonly seedSuffix?: string;
}

export interface TemplateResult {
  /** 规划结果。`skip` 非空表示没有生成任何几何。 */
  readonly plan: BlockPlan;
  /** 标称边长（米）。 */
  readonly size: number;
  /** 实际使用的族定义（解析失败时为 null）。 */
  readonly family: BlockFamilyDef | null;
}

export interface TemplateCatalogEntry {
  readonly id: BlockFamilyId;
  readonly version: number;
  readonly name: string;
  readonly note: string;
  readonly nominalSize: number;
  readonly heightRange: readonly [number, number];
  readonly unitWidths: readonly number[];
  readonly styles: readonly string[];
}

/** 供文档与预览页展示的模板目录（只读快照）。 */
export const TEMPLATE_CATALOG: readonly TemplateCatalogEntry[] = BLOCK_FAMILIES.map((family) => ({
  id: family.id,
  version: family.version,
  name: family.name,
  note: family.note,
  nominalSize: family.nominalSize,
  heightRange: family.heightRange,
  unitWidths: family.unitWidths,
  styles: family.styles,
}));

/**
 * 生成一套完整模板（四面围合的方形街区）。
 *
 * 与全城推广的 `generateBlock()` 是**两条不同的路径**：这里要求四侧街墙、四个对外端口、
 * 内部庭院与四条巷道同时成立，任一条不满足就返回带 `skip` 的空计划，不会被误标成 `full`。
 *
 * @example
 * const { plan } = generateTemplateBlock({
 *   familyId: 'residential-courtyard',
 *   templateVersion: 1,
 *   center: { x: 0, z: 0 },
 * });
 * // plan.decor / plan.paving / plan.trees / plan.colliders 可直接交给 CityBlocks.sync()
 * // plan.portals 给出四个巷口的中心、宽度与朝外方向
 *
 * @example 隔街拼接
 * // A 的中心在原点（x ∈ −22.5…22.5），B 紧邻 A 的东侧隔一条 18 m 的街：
 * const a = generateTemplateBlock({ familyId: 'residential-courtyard', templateVersion: 1, center: { x: 0, z: 0 } });
 * const b = generateTemplateBlock({
 *   familyId: 'commercial-mixed',
 *   templateVersion: 1,
 *   center: { x: 45 + STREET_CORRIDOR, z: 0 }, // = 63
 * });
 * // A 的东端口 center.x = 22.5，B 的西端口 center.x = 63 − 22.5 = 40.5，
 * // 两者相距 18 m = STREET_CORRIDOR，且 z 相同 → 人行道与车行道走廊正好接上。
 */
export function generateTemplateBlock(request: TemplateRequest): TemplateResult {
  const family = blockFamilyById(request.familyId, request.templateVersion);
  const size = family?.nominalSize ?? 45;
  const center = request.center ?? { x: 0, z: 0 };
  const blockId =
    request.blockId ??
    `template-${request.familyId}-v${request.templateVersion}${request.seedSuffix ? `-${request.seedSuffix}` : ''}`;

  const plan = generatePerimeterBlock({
    blockId,
    familyId: request.familyId,
    templateVersion: request.templateVersion,
    rect: {
      x0: center.x - size / 2,
      x1: center.x + size / 2,
      z0: center.z - size / 2,
      z1: center.z + size / 2,
    },
    front: request.front ?? 'south',
    districtId: 'template-preview',
    nominalSize: size,
  });

  return { plan, size, family };
}
