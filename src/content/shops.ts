/**
 * 商店目录 —— 商品清单与售价。
 *
 * 职责边界：只提供「哪家店卖什么、单价多少」，**不模拟库存与供货上限**。
 * 余额校验、扣款与背包写入都由应用层编排，这里既没有钱包也没有 GameState。
 * 价格单位为「分」，避免浮点误差。
 */

import { CONVENIENCE_SHOP_ID, CONVENIENCE_STORE_NAME } from './config';

export interface ShopOffer {
  readonly itemId: string;
  readonly priceCents: number;
}

export interface ShopConfig {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** 出售清单；数组顺序即界面显示顺序。 */
  readonly offers: readonly ShopOffer[];
}

export const SHOPS: readonly ShopConfig[] = [
  {
    id: CONVENIENCE_SHOP_ID,
    name: CONVENIENCE_STORE_NAME,
    description: '24 小时营业的生活补给点，供应即食食品与饮用水。',
    offers: [
      { itemId: 'bread', priceCents: 500 },
      { itemId: 'bento', priceCents: 1_500 },
      { itemId: 'water', priceCents: 300 },
      { itemId: 'sports-drink', priceCents: 800 },
    ],
  },
];

export function findShop(shopId: string): ShopConfig | null {
  return SHOPS.find((shop) => shop.id === shopId) ?? null;
}

/** 某家店是否出售该物品；不存在时返回 null（由调用方决定错误码）。 */
export function findOffer(shopId: string, itemId: string): ShopOffer | null {
  const shop = findShop(shopId);
  if (!shop) return null;
  return shop.offers.find((offer) => offer.itemId === itemId) ?? null;
}
