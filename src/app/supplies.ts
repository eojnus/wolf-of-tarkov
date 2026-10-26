/**
 * 生活补给命令 —— 便利店购买与背包使用。
 *
 * 请求协议（与 features/inventory 共用同一实现，不复制序号判定）：
 *  - requestId 必须是 `supplies:<operationEpoch>:<sequence>`；
 *  - 每个成功操作只推进一次 `nextOperationSeq`；
 *  - sequence 小于当前高水位：有收据则按内容核对后判为重放，没有收据则为已过期，绝不再次执行；
 *  - sequence 大于当前高水位：乱序拒绝；
 *  - 只有 sequence === nextOperationSeq 才进入真实业务校验与写入。
 *
 * 所有写操作都在一次 GameStore.run 内完成；购买/使用的业务写入失败会整体回滚，
 * 序号也不会推进。通知与自动保存放在提交之外。
 */

import { dateAtMinute } from '../core/calendar';
import { BusinessError, describeError, isBusinessError } from '../core/errors';
import { formatMoney } from '../core/money';
import { GameStore } from '../core/store';
import { TIME } from '../content/config';
import { findItemOrThrow } from '../content/items';
import { findOffer } from '../content/shops';
import { externalAccount, PERSONAL_CASH, transferFunds } from '../features/finance';
import {
  addItem,
  classifySupplyRequest,
  commitSupplyOperation,
  countOf,
  receiptMatchesExpectation,
  removeItem,
  type SupplyRequestKind,
} from '../features/inventory';
import { quotePurchase } from '../features/shop';
import { previewRestoreOf, restoreSurvival } from '../features/survival';
import type { GameState } from './state';

export type SuppliesNotifyKind = 'info' | 'success' | 'error';

export interface SuppliesHooks {
  notify(kind: SuppliesNotifyKind, message: string): void;
  requestAutoSave(): void;
  /** 当前合法商店交互上下文；未打开/不在店内时为 null。 */
  currentShopId(): string | null;
}

/** 明确的结果码，保留 ok/message 兼容原有调用。 */
export type SuppliesResultCode =
  | 'APPLIED'
  | 'REPLAYED'
  | 'REQUEST_EXPIRED'
  | 'REQUEST_OUT_OF_ORDER'
  | 'REQUEST_MISMATCH'
  | 'INVALID_REQUEST'
  | 'REQUEST_SEQUENCE_EXHAUSTED'
  | string;

export interface SuppliesOutcome {
  readonly ok: boolean;
  readonly code: SuppliesResultCode;
  readonly message: string | null;
}

/** 商店作为外部对手方：购买支出是消费，不是第二份钱包。 */
const SHOP_ACCOUNT = externalAccount('shop');

interface ExpectedOperation {
  readonly kind: SupplyRequestKind;
  readonly shopId: string | null;
  readonly itemId: string;
  readonly quantity: number;
}

/**
 * 统一处理请求协议的前置判定。
 *
 * 返回 `replayedMessage` 表示这是已成功请求的重放：调用方必须直接返回该提示，
 * 不能再检查商店上下文、现金、背包或恢复条件，也不能产生任何副作用。
 */
function resolveRequest(
  draft: GameState,
  requestId: string,
  expected: ExpectedOperation,
  replayMessage: string,
): { readonly replayed: true; readonly message: string } | { readonly replayed: false } {
  const decision = classifySupplyRequest(draft.inventory, requestId);
  switch (decision.kind) {
    case 'invalid':
      throw new BusinessError('INVALID_REQUEST', decision.reason);
    case 'expired':
      throw new BusinessError(
        'REQUEST_EXPIRED',
        '该补给请求已处理或已过期，不能再次执行；请重新操作',
      );
    case 'out-of-order':
      throw new BusinessError(
        'REQUEST_OUT_OF_ORDER',
        '补给请求序号与当前进度不一致，请刷新后重新操作',
      );
    case 'replay':
      if (!receiptMatchesExpectation(decision.receipt, expected)) {
        throw new BusinessError(
          'REQUEST_MISMATCH',
          '同一请求序号已用于另一笔内容不同的补给操作，已拒绝',
        );
      }
      return { replayed: true, message: replayMessage };
    case 'new':
      return { replayed: false };
  }
}

export class SuppliesCommands {
  constructor(
    private readonly store: GameStore<GameState>,
    private readonly hooks: SuppliesHooks,
  ) {}

  /** 在便利店购买商品。`requestId` 由界面用当前 cursor 生成，同一次重试复用。 */
  purchase(
    shopId: string,
    itemId: string,
    quantity: number,
    requestId: string,
  ): SuppliesOutcome {
    try {
      let resultCode: 'APPLIED' | 'REPLAYED' = 'APPLIED';
      const message = this.store.run((draft) => {
        const replay = resolveRequest(
          draft,
          requestId,
          { kind: 'purchase', shopId, itemId, quantity },
          `该笔购买已处理（${findItemOrThrow(itemId).name} × ${quantity}），未重复扣款`,
        );
        if (replay.replayed) {
          resultCode = 'REPLAYED';
          return replay.message;
        }

        // 购买必须有真实的当前商店上下文，不能仅凭界面存在远程购物
        if (!shopId || this.hooks.currentShopId() !== shopId) {
          throw new BusinessError('NO_SHOP_CONTEXT', '请到便利店柜台前再购买');
        }
        if (!findOffer(shopId, itemId)) {
          throw new BusinessError('ITEM_NOT_SOLD', '这家店不售卖该商品');
        }
        const quote = quotePurchase(shopId, itemId, quantity);
        if (draft.finance.accounts.cash < quote.totalCents) {
          throw new BusinessError(
            'INSUFFICIENT_CASH',
            `现金不足：需要 ${formatMoney(quote.totalCents)}，当前现金 ${formatMoney(draft.finance.accounts.cash)}`,
          );
        }
        const nowMinute = draft.clock.totalMinute;
        const monthKey = dateAtMinute(nowMinute, TIME.calendar).monthKey;
        const item = findItemOrThrow(itemId);

        transferFunds(draft.finance, {
          atMinute: nowMinute,
          monthKey,
          operationId: `supply-purchase:${requestId}`,
          from: PERSONAL_CASH,
          to: SHOP_ACCOUNT,
          amount: quote.totalCents,
          category: 'supplies',
          memo: `便利店购买：${item.name} × ${quantity}`,
        });
        addItem(draft.inventory, itemId, quantity);
        // 业务写入完成后最后落收据并推进序号；任一步抛错整份草稿回滚
        commitSupplyOperation(draft.inventory, {
          requestId,
          kind: 'purchase',
          shopId,
          itemId,
          quantity,
          atMinute: nowMinute,
        });
        return `已购买 ${item.name} × ${quantity}，支出 ${formatMoney(quote.totalCents)}（现金余额 ${formatMoney(draft.finance.accounts.cash)}）`;
      });
      this.hooks.notify('success', message);
      if (resultCode === 'APPLIED') this.hooks.requestAutoSave();
      return { ok: true, code: resultCode, message };
    } catch (error) {
      const message = describeError(error);
      this.hooks.notify('error', message);
      const code = isBusinessError(error) ? error.code : 'ERROR';
      // 重放是成功状态，只是没有写入；上层据此清理 pending
      return { ok: false, code, message };
    }
  }

  /** 从背包使用一件消耗品，立即恢复生存值；不推进游戏时间。 */
  useItem(itemId: string, requestId: string): SuppliesOutcome {
    try {
      let resultCode: 'APPLIED' | 'REPLAYED' = 'APPLIED';
      const message = this.store.run((draft) => {
        const replay = resolveRequest(
          draft,
          requestId,
          { kind: 'use', shopId: null, itemId, quantity: 1 },
          `该次使用已处理（${findItemOrThrow(itemId).name}），未重复消耗`,
        );
        if (replay.replayed) {
          resultCode = 'REPLAYED';
          return replay.message;
        }

        const item = findItemOrThrow(itemId);
        if (!item.usable || !item.effect) {
          throw new BusinessError('ITEM_NOT_USABLE', '该物品不能使用');
        }
        const owned = countOf(draft.inventory, itemId);
        if (owned <= 0) {
          throw new BusinessError('INSUFFICIENT_ITEMS', `背包里没有${item.name}`);
        }
        const preview = previewRestoreOf(draft.survival, item.effect);
        if (preview.hungerRestoredPoints <= 0 && preview.waterRestoredPoints <= 0) {
          throw new BusinessError(
            'NO_RESTORE_EFFECT',
            '当前生存状态已满，使用会全部浪费，已拒绝',
          );
        }
        const nowMinute = draft.clock.totalMinute;
        removeItem(draft.inventory, itemId, 1);
        restoreSurvival(draft.survival, item.effect);
        commitSupplyOperation(draft.inventory, {
          requestId,
          kind: 'use',
          shopId: null,
          itemId,
          quantity: 1,
          atMinute: nowMinute,
        });

        const parts: string[] = [];
        if (preview.hungerRestoredPoints > 0) {
          parts.push(`饱食度 +${preview.hungerRestoredPoints.toFixed(1)}`);
        }
        if (preview.waterRestoredPoints > 0) {
          parts.push(`水分 +${preview.waterRestoredPoints.toFixed(1)}`);
        }
        if (preview.hungerWastedPoints > 0) {
          parts.push(`溢出浪费饱食度 ${preview.hungerWastedPoints.toFixed(1)}`);
        }
        if (preview.waterWastedPoints > 0) {
          parts.push(`溢出浪费水分 ${preview.waterWastedPoints.toFixed(1)}`);
        }
        return `已使用 ${item.name}：${parts.join('，')}`;
      });
      this.hooks.notify('success', message);
      if (resultCode === 'APPLIED') this.hooks.requestAutoSave();
      return { ok: true, code: resultCode, message };
    } catch (error) {
      const message = describeError(error);
      this.hooks.notify('error', message);
      const code = isBusinessError(error) ? error.code : 'ERROR';
      return { ok: false, code, message };
    }
  }
}
