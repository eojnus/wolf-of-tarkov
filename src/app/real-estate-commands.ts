/**
 * 房地产命令 —— 界面唯一的房地产写入口。
 *
 * 每条命令都在一次 `GameStore` 提交里完成：付款、产权、挂牌、报价与流水同进同退。
 * 确认过的价格与挂牌版本会带进命令，执行时重新校验；不一致即明确拒绝，
 * 不静默换价、不缩量、不替换资产。
 */

import { dateAtMinute } from '../core/calendar';
import { describeError } from '../core/errors';
import { formatMoney } from '../core/money';
import { GameStore } from '../core/store';
import { TIME } from '../content/config';
import type { GameState } from './state';
import type { CommandOutcome } from './commands';
import {
  acceptLandOffer,
  buyHomeByPlayer,
  buyLandByPlayer,
  cancelListingByPlayer,
  listHomeByPlayer,
  rejectLandOffer,
} from './real-estate';

export interface EstateCommandHooks {
  notify(kind: 'info' | 'success' | 'error', message: string): void;
  requestAutoSave(): void;
}

function nextOperationId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}:${random}`;
}

export class EstateCommands {
  constructor(
    private readonly store: GameStore<GameState>,
    private readonly hooks: EstateCommandHooks,
  ) {}

  /** 现场买入住宅：价格与挂牌版本必须是玩家确认过的那一份。 */
  buyHome(propertyId: string, priceCents: number, listingVersion: number): CommandOutcome {
    if (!propertyId) return { ok: false, message: '没有指定房源' };
    return this.execute((draft, monthKey) => {
      const trade = buyHomeByPlayer(draft, {
        propertyId,
        expectedPriceCents: priceCents,
        expectedListingVersion: listingVersion,
        atMinute: draft.clock.totalMinute,
        monthKey,
        operationId: nextOperationId('home-buy'),
      });
      return `买入 ${trade.propertyId}，成交价 ${formatMoney(trade.priceCents)}（个人银行存款支付）`;
    });
  }

  /** 受让城市储备土地。 */
  buyLand(propertyId: string, priceCents: number): CommandOutcome {
    if (!propertyId) return { ok: false, message: '没有指定地块' };
    return this.execute((draft, monthKey) => {
      const trade = buyLandByPlayer(draft, {
        propertyId,
        expectedPriceCents: priceCents,
        expectedListingVersion: null,
        atMinute: draft.clock.totalMinute,
        monthKey,
        operationId: nextOperationId('land-buy'),
      });
      return `受让 ${trade.propertyId}，价格 ${formatMoney(trade.priceCents)}`;
    });
  }

  /** 挂牌或改价：版本号不一致时明确拒绝。 */
  listHome(propertyId: string, priceCents: number, expectedVersion: number): CommandOutcome {
    if (!propertyId) return { ok: false, message: '没有指定房源' };
    if (!Number.isSafeInteger(priceCents) || priceCents <= 0) {
      return { ok: false, message: '请输入有效的挂牌价（元）' };
    }
    return this.execute((draft) => {
      const result = listHomeByPlayer(draft, {
        propertyId,
        priceCents,
        expectedVersion,
        atMinute: draft.clock.totalMinute,
      });
      return `已挂牌 ${formatMoney(priceCents)}（第 ${result.version} 版）；由月度市场按真实需求成交`;
    });
  }

  /** 撤销挂牌。 */
  cancelListing(propertyId: string, expectedVersion: number): CommandOutcome {
    if (!propertyId) return { ok: false, message: '没有指定房源' };
    return this.execute((draft) => {
      cancelListingByPlayer(draft, { propertyId, expectedVersion });
      return '已撤销挂牌';
    });
  }

  /** 接受土地收购报价（只消费该报价自己的预留资金）。 */
  acceptOffer(offerId: string, priceCents: number): CommandOutcome {
    if (!offerId) return { ok: false, message: '没有指定报价' };
    return this.execute((draft, monthKey) => {
      const trade = acceptLandOffer(draft, {
        offerId,
        expectedPriceCents: priceCents,
        atMinute: draft.clock.totalMinute,
        monthKey,
        operationId: nextOperationId('land-offer'),
      });
      return `已接受报价，卖出 ${trade.propertyId}，到账 ${formatMoney(trade.priceCents)}`;
    });
  }

  /** 拒绝报价并释放对方预留。 */
  rejectOffer(offerId: string): CommandOutcome {
    if (!offerId) return { ok: false, message: '没有指定报价' };
    return this.execute((draft) => {
      rejectLandOffer(draft, offerId);
      return '已拒绝该报价';
    });
  }

  private execute(
    mutate: (draft: GameState, monthKey: string) => string,
    autoSave = true,
  ): CommandOutcome {
    try {
      const message = this.store.run((draft) => {
        const monthKey = dateAtMinute(draft.clock.totalMinute, TIME.calendar).monthKey;
        return mutate(draft, monthKey);
      });
      this.hooks.notify('success', message);
      if (autoSave) this.hooks.requestAutoSave();
      return { ok: true, message };
    } catch (error) {
      const message = describeError(error);
      this.hooks.notify('error', message);
      return { ok: false, message };
    }
  }
}
