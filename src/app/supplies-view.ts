/**
 * 生活补给只读视图 —— 生存状态、背包、便利店商品与恢复预览。
 *
 * 只读：不补建背包、不修改生存值、不扣款。购买/使用仍走 app/supplies 命令。
 */

import { dateAtMinute } from '../core/calendar';
import { formatMoney } from '../core/money';
import { CONVENIENCE_JOB_ID, TIME, findJob } from '../content/config';
import { ITEMS, ITEM_CATEGORY_LABELS, type ItemConfig } from '../content/items';
import { SURVIVAL } from '../content/survival';
import { SHOPS, findShop } from '../content/shops';
import { planShift } from '../features/employment';
import { countOf, supplyCursorOf, type SupplyRequestCursor } from '../features/inventory';
import {
  hungerPointsOf,
  isLowHunger,
  isLowWater,
  moveMultiplierOf,
  previewRestoreOf,
  waterPointsOf,
  workEfficiencyOf,
} from '../features/survival';
import type { ReadonlyGameState } from './state';

export interface SurvivalStatusView {
  readonly hungerPoints: number;
  readonly waterPoints: number;
  /** 0～100，便于条状图直接使用（与点数同值）。 */
  readonly hungerPercent: number;
  readonly waterPercent: number;
  readonly hungerText: string;
  readonly waterText: string;
  readonly lowHunger: boolean;
  readonly lowWater: boolean;
  readonly zeroHunger: boolean;
  readonly zeroWater: boolean;
  /** 工作效率百分比（0～100 整数）。 */
  readonly efficiencyPercent: number;
  readonly efficiencyText: string;
  /** 移动倍率百分比（0～100 整数）。 */
  readonly movePercent: number;
  readonly moveText: string;
  /** 当前惩罚的可读说明；无惩罚时为空。 */
  readonly effectText: string;
  readonly note: string;
}

export interface InventoryItemView {
  readonly itemId: string;
  readonly name: string;
  readonly description: string;
  readonly categoryText: string;
  readonly count: number;
  readonly effectText: string;
  readonly restoreText: string;
  readonly canUse: boolean;
  readonly disabledReason: string;
}

export interface ShopOfferView {
  readonly itemId: string;
  readonly name: string;
  readonly description: string;
  readonly effectText: string;
  readonly priceCents: number;
  readonly priceText: string;
  readonly canAfford: boolean;
}

export interface ShopSectionView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly offers: ShopOfferView[];
  readonly note: string;
}

export interface ShopJobView {
  readonly jobId: string;
  readonly title: string;
  readonly wageText: string;
  /** 当前已在便利店岗位（可直接上班）。 */
  readonly hiredHere: boolean;
  /** 当前在职但属于其它岗位（切换需要保留已赚工资与工时）。 */
  readonly hiredElsewhere: boolean;
  readonly workAvailable: boolean;
  readonly workReason: string;
}

export interface SuppliesView {
  readonly cash: number;
  readonly cashText: string;
  readonly survival: SurvivalStatusView;
  readonly inventory: InventoryItemView[];
  readonly inventoryEmpty: boolean;
  readonly shop: ShopSectionView;
  readonly job: ShopJobView;
  /** 补给请求 cursor：UI 提交前用它生成规范 requestId；只读，不消耗序号。 */
  readonly requestCursor: SupplyRequestCursor;
}

function pointsText(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function effectTextOf(item: ItemConfig): string {
  if (!item.usable || !item.effect) return '不可使用';
  const parts: string[] = [];
  if (item.effect.hungerPoints > 0) parts.push(`饱食度 +${item.effect.hungerPoints}`);
  if (item.effect.waterPoints > 0) parts.push(`水分 +${item.effect.waterPoints}`);
  return parts.length > 0 ? parts.join(' · ') : '无恢复效果';
}

/** 当前生存状态与由它推导出的效率/移动倍率（唯一公式来自 features/survival）。 */
export function buildSurvivalStatus(state: ReadonlyGameState): SurvivalStatusView {
  const hungerUnits = state.survival.hungerUnits;
  const waterUnits = state.survival.waterUnits;
  const hungerPoints = hungerPointsOf(state.survival);
  const waterPoints = waterPointsOf(state.survival);
  const efficiencyPercent = Math.round(workEfficiencyOf(state.survival) * 100);
  const movePercent = Math.round(moveMultiplierOf(state.survival) * 100);
  const zeroHunger = hungerUnits <= 0;
  const zeroWater = waterUnits <= 0;
  const effects: string[] = [];
  if (zeroHunger) effects.push('饱食度归零：工作效率 −50%，移动 −15%');
  if (zeroWater) effects.push('水分归零：工作效率 −50%，移动 −15%');
  const lowParts: string[] = [];
  if (isLowHunger(state.survival)) lowParts.push('饱食度偏低');
  if (isLowWater(state.survival)) lowParts.push('水分偏低');

  return {
    hungerPoints,
    waterPoints,
    hungerPercent: Math.max(0, Math.min(100, hungerPoints)),
    waterPercent: Math.max(0, Math.min(100, waterPoints)),
    hungerText: `${pointsText(hungerPoints)} / ${SURVIVAL.maxPoints}`,
    waterText: `${pointsText(waterPoints)} / ${SURVIVAL.maxPoints}`,
    lowHunger: isLowHunger(state.survival),
    lowWater: isLowWater(state.survival),
    zeroHunger,
    zeroWater,
    efficiencyPercent,
    efficiencyText: `工作效率 ${efficiencyPercent}%`,
    movePercent,
    moveText: `移动 ${movePercent}%`,
    effectText: effects.join('；'),
    note:
      effects.length > 0
        ? '两项惩罚按加法叠加；不会死亡，仍可移动、购买与使用物品。'
        : lowParts.length > 0
          ? `${lowParts.join('、')}（低于 ${SURVIVAL.lowThresholdPoints}，暂无惩罚）`
          : '状态良好，无工作效率或移动惩罚。',
  };
}

function previewTextOf(
  state: ReadonlyGameState,
  item: ItemConfig,
  count: number,
): string {
  if (count <= 0) return '—';
  if (!item.usable || !item.effect) return '不可使用';
  const preview = previewRestoreOf(state.survival, item.effect);
  if (preview.hungerRestoredPoints <= 0 && preview.waterRestoredPoints <= 0) {
    return '已满，使用会全部浪费（将被拒绝）';
  }
  const parts: string[] = [];
  if (preview.hungerRestoredPoints > 0) {
    parts.push(`饱食度 +${pointsText(preview.hungerRestoredPoints)}`);
  }
  if (preview.waterRestoredPoints > 0) {
    parts.push(`水分 +${pointsText(preview.waterRestoredPoints)}`);
  }
  if (preview.hungerWastedPoints > 0) {
    parts.push(`溢出浪费饱食度 ${pointsText(preview.hungerWastedPoints)}`);
  }
  if (preview.waterWastedPoints > 0) {
    parts.push(`溢出浪费水分 ${pointsText(preview.waterWastedPoints)}`);
  }
  return `实际 ${parts.join('，')}`;
}

/** 背包行：只展示实际持有的物品；预览由当前生存值与物品效果推导。 */
export function buildInventoryItems(state: ReadonlyGameState): InventoryItemView[] {
  const rows: InventoryItemView[] = [];
  for (const item of ITEMS) {
    const count = countOf(state.inventory, item.id);
    if (count <= 0) continue;
    const preview = item.effect ? previewRestoreOf(state.survival, item.effect) : null;
    const usable = item.usable && item.effect !== null;
    const restorable =
      preview !== null &&
      (preview.hungerRestoredPoints > 0 || preview.waterRestoredPoints > 0);
    const canUse = usable && restorable;
    rows.push({
      itemId: item.id,
      name: item.name,
      description: item.description,
      categoryText: ITEM_CATEGORY_LABELS[item.category],
      count,
      effectText: effectTextOf(item),
      restoreText: previewTextOf(state, item, count),
      canUse,
      disabledReason: !usable
        ? '该物品不能使用'
        : !restorable
          ? '当前状态已满，使用会全部浪费'
          : '',
    });
  }
  return rows;
}

function buildShop(state: ReadonlyGameState, shopId: string | null): ShopSectionView {
  const shop = findShop(shopId ?? '') ?? SHOPS[0];
  if (!shop) {
    return {
      id: '',
      name: '便利店',
      description: '',
      offers: [],
      note: '当前没有可用的商店目录。',
    };
  }
  const offers: ShopOfferView[] = shop.offers.map((offer) => {
    const item = ITEMS.find((row) => row.id === offer.itemId);
    return {
      itemId: offer.itemId,
      name: item?.name ?? offer.itemId,
      description: item?.description ?? '',
      effectText: item ? effectTextOf(item) : '—',
      priceCents: offer.priceCents,
      priceText: formatMoney(offer.priceCents),
      canAfford: state.finance.accounts.cash >= offer.priceCents,
    };
  });
  return {
    id: shop.id,
    name: shop.name,
    description: shop.description,
    offers,
    note: '购买只使用个人现金；现金不足时整体拒绝，不会自动动用存款。商品无库存与补货模拟，购物 24 小时开放。',
  };
}

function buildShopJob(state: ReadonlyGameState): ShopJobView {
  const job = findJob(CONVENIENCE_JOB_ID);
  if (!job) {
    return {
      jobId: CONVENIENCE_JOB_ID,
      title: '便利店店员',
      wageText: '—',
      hiredHere: false,
      hiredElsewhere: false,
      workAvailable: false,
      workReason: '岗位配置缺失',
    };
  }
  const hiredHere = state.employment.jobId === job.id;
  const hiredElsewhere = state.employment.jobId !== null && !hiredHere;
  const now = dateAtMinute(state.clock.totalMinute, TIME.calendar);
  const plan = hiredHere ? planShift(state.employment, job, now) : null;
  return {
    jobId: job.id,
    title: `${job.employer} · ${job.title}`,
    wageText: `${formatMoney(job.hourlyWageCents)} / 小时`,
    hiredHere,
    hiredElsewhere,
    workAvailable: plan?.ok === true,
    workReason: hiredHere
      ? (plan?.reason ?? `现在可以上班，本次 ${plan?.minutes ?? 0} 分钟`)
      : hiredElsewhere
        ? '当前在职其它岗位：入职便利店会切换岗位，已赚工资与今日工时保留'
        : `尚未入职：${formatMoney(job.hourlyWageCents)} / 小时，每日最多 8 小时`,
  };
}

export function buildSuppliesView(
  state: ReadonlyGameState,
  shopId: string | null,
): SuppliesView {
  const inventory = buildInventoryItems(state);
  return {
    cash: state.finance.accounts.cash,
    cashText: formatMoney(state.finance.accounts.cash),
    survival: buildSurvivalStatus(state),
    inventory,
    inventoryEmpty: inventory.length === 0,
    shop: buildShop(state, shopId),
    job: buildShopJob(state),
    requestCursor: supplyCursorOf(state.inventory),
  };
}
