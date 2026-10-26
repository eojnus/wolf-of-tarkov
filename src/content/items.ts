/**
 * 物品目录 —— 稳定的 itemId、名称、说明与恢复效果。
 *
 * 只描述「物品是什么、吃了/喝了恢复多少点」，**不含价格**（价格在 `content/shops`）
 * 与库存逻辑（库存在 `features/inventory`）。订单、存档都只认 itemId，
 * 因此 id 一旦发布不得改名。
 */

import { BusinessError } from '../core/errors';

export type ItemCategory = 'food' | 'drink' | 'quest';

/** 可使用物品对生存值的恢复量（点）。任务物品没有效果时为 null。 */
export interface ItemEffect {
  readonly hungerPoints: number;
  readonly waterPoints: number;
}

export interface ItemConfig {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: ItemCategory;
  /** 是否可主动使用；不可使用的物品只作为任务物品存在。 */
  readonly usable: boolean;
  readonly effect: ItemEffect | null;
}

export const ITEM_CATEGORY_LABELS: Record<ItemCategory, string> = {
  food: '食物',
  drink: '饮料',
  quest: '任务物品',
};

/** 商店与背包的固定显示顺序即此数组顺序。 */
export const ITEMS: readonly ItemConfig[] = [
  {
    id: 'bread',
    name: '面包',
    description: '便利店现烤的简易面包，填肚子应急很合适。',
    category: 'food',
    usable: true,
    effect: { hungerPoints: 15, waterPoints: 0 },
  },
  {
    id: 'bento',
    name: '便当',
    description: '荤素搭配的盒饭，一顿顶大半天，适合长时间工作前吃。',
    category: 'food',
    usable: true,
    effect: { hungerPoints: 45, waterPoints: 0 },
  },
  {
    id: 'water',
    name: '矿泉水',
    description: '普通瓶装饮用水，解渴的同时补充水分。',
    category: 'drink',
    usable: true,
    effect: { hungerPoints: 0, waterPoints: 25 },
  },
  {
    id: 'sports-drink',
    name: '运动饮料',
    description: '含电解质的运动饮料，补水效果比矿泉水更好。',
    category: 'drink',
    usable: true,
    effect: { hungerPoints: 0, waterPoints: 40 },
  },
];

export function findItem(itemId: string): ItemConfig | null {
  return ITEMS.find((item) => item.id === itemId) ?? null;
}

/** 供命令层使用：未知 itemId 直接拒绝，避免静默忽略。 */
export function findItemOrThrow(itemId: string): ItemConfig {
  const item = findItem(itemId);
  if (!item) {
    throw new BusinessError('UNKNOWN_ITEM', `未知物品：${itemId}`);
  }
  return item;
}
