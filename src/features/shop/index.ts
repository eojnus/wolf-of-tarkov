/**
 * 商店模块 —— 购买报价的纯计算与校验。
 *
 * 职责边界：
 *  - 只回答「这家店这件东西买 N 个要多少钱」，不持有钱包、不写背包、不建库存；
 *  - 扣款与背包写入由应用层依次调用 `features/finance` 与 `features/inventory`；
 *  - 价格只能来自 `content/shops`，本模块不内联任何数字。
 */

import { BusinessError } from '../../core/errors';
import { assertMoneyRange } from '../../core/money';
import { findItem } from '../../content/items';
import { findOffer, findShop } from '../../content/shops';

export interface PurchaseQuote {
  readonly shopId: string;
  readonly itemId: string;
  readonly unitPriceCents: number;
  readonly quantity: number;
  readonly totalCents: number;
}

/**
 * 生成购买报价。
 *
 * 校验顺序与错误码：店不存在 → `UNKNOWN_SHOP`；物品不存在 → `UNKNOWN_ITEM`；
 * 店不卖该物品 → `ITEM_NOT_SOLD`；数量非正安全整数 → `INVALID_QUANTITY`；
 * 总价溢出/超出金额范围 → `AMOUNT_RANGE`。
 */
export function quotePurchase(shopId: string, itemId: string, quantity: number): PurchaseQuote {
  const shop = findShop(shopId);
  if (!shop) {
    throw new BusinessError('UNKNOWN_SHOP', `未知商店：${shopId}`);
  }
  const item = findItem(itemId);
  if (!item) {
    throw new BusinessError('UNKNOWN_ITEM', `未知物品：${itemId}`);
  }
  const offer = findOffer(shopId, itemId);
  if (!offer) {
    throw new BusinessError('ITEM_NOT_SOLD', `${shop.name} 不出售${item.name}`);
  }
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new BusinessError('INVALID_QUANTITY', '购买数量必须是正整数');
  }

  const totalCents = quoteTotalCents(offer.priceCents, quantity);

  return {
    shopId: shop.id,
    itemId: item.id,
    unitPriceCents: offer.priceCents,
    quantity,
    totalCents,
  };
}

/** 乘法可能先产生不安全整数，因此统一交给金额校验，并把错误码归一为 AMOUNT_RANGE。 */
function quoteTotalCents(unitPriceCents: number, quantity: number): number {
  const raw = unitPriceCents * quantity;
  try {
    assertMoneyRange(raw, '商品总价');
  } catch {
    throw new BusinessError('AMOUNT_RANGE', '购买总价超出可处理范围');
  }
  return raw;
}
