/**
 * 背包模块 —— 玩家持有的物品数量，以及补给操作的持久化请求协议。
 *
 * 职责边界：
 *  - 只管「有几件」「加减几件」「这条请求是否处理过」；
 *  - 不扣钱、不恢复生存、不读 GameState；购买扣款与使用效果由应用层编排；
 *  - 请求去重使用「命名空间 + 单调序号」协议：`operationEpoch` 是本存档的命名空间，
 *    `nextOperationSeq` 是下一个可执行序号；最多保留 64 条完整收据用于重放核对，
 *    被裁剪掉的旧序号由高水位拒绝重放，而不是误判为新请求。
 */

import { BusinessError } from '../../core/errors';
import type { DeepReadonly } from '../../core/readonly';
import { safeAddMoney } from '../../core/money';

/** 请求日志条数上限；超出后丢弃最旧的收据。存档校验也复用它。 */
export const MAX_REQUEST_RECORDS = 64;
/** 新协议版本。legacy 收据固定为 0，只作历史，不授权再次执行。 */
export const SUPPLY_PROTOCOL_VERSION = 1;
export const LEGACY_PROTOCOL_VERSION = 0;
/** requestId 前缀：`supplies:<epoch>:<sequence>`。 */
const REQUEST_PREFIX = 'supplies';

export type SupplyRequestKind = 'purchase' | 'use';

/** 旧版本（v14 及以前）随机 UUID 请求，只保留为历史收据。 */
export interface LegacyInventoryRequest {
  readonly protocolVersion: typeof LEGACY_PROTOCOL_VERSION;
  readonly sequence: null;
  readonly requestId: string;
  readonly kind: SupplyRequestKind;
  readonly itemId: string;
  readonly quantity: number;
  readonly shopId: null;
  readonly atMinute: number;
}

/** 新协议收据：命名空间 + 序号 + 完整业务内容，用于重放核对。 */
export interface SupplyRequestReceipt {
  readonly protocolVersion: typeof SUPPLY_PROTOCOL_VERSION;
  readonly sequence: number;
  readonly requestId: string;
  readonly kind: SupplyRequestKind;
  readonly itemId: string;
  readonly quantity: number;
  /** 购买为实际商店 id；使用为 null。 */
  readonly shopId: string | null;
  readonly atMinute: number;
}

export type InventoryRequestRecord = LegacyInventoryRequest | SupplyRequestReceipt;

export interface InventoryState {
  /** itemId → 持有数量；为零的物品直接删除，不保留空键。 */
  items: Record<string, number>;
  /**
   * 本存档的补给操作命名空间。新游戏/旧档迁移时生成一次；
   * 当前版本读档必须保留，不得由查询或界面重新生成。
   */
  operationEpoch: string;
  /** 下一个可执行序号（从 1 开始，只在新购买/使用成功后 +1）。 */
  nextOperationSeq: number;
  /** 去重/重放收据，最多 64 条，先进先出裁剪；裁剪不影响高水位序号。 */
  requests: InventoryRequestRecord[];
}

/** 生成一次新的操作命名空间。不含冒号，保证 requestId 可被完整解析。 */
export function createSupplyOperationEpoch(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `epoch-${random}`;
}

export function createInventoryState(operationEpoch = createSupplyOperationEpoch()): InventoryState {
  if (!operationEpoch) {
    throw new BusinessError('INVALID_EPOCH', '补给操作命名空间不能为空');
  }
  return { items: {}, operationEpoch, nextOperationSeq: 1, requests: [] };
}

/* ---------------------------------------------------------------- 数量 */

export function countOf(
  state: InventoryState | DeepReadonly<InventoryState>,
  itemId: string,
): number {
  return state.items[itemId] ?? 0;
}

export function hasItem(
  state: InventoryState | DeepReadonly<InventoryState>,
  itemId: string,
): boolean {
  return countOf(state, itemId) > 0;
}

/**
 * 增加物品数量。
 *
 * 数量必须是正安全整数；累加后超出可处理范围（`safeAddMoney` 的统一上限）时
 * 拒绝写入，绝不静默截断或溢出成不安全整数。
 */
export function addItem(state: InventoryState, itemId: string, quantity: number): void {
  assertItemId(itemId);
  assertQuantity(quantity);
  const current = state.items[itemId] ?? 0;
  state.items[itemId] = safeAddMoney(current, quantity, '物品数量');
}

/** 减少物品数量；不足时整体拒绝，不会扣成负数或只扣一部分。 */
export function removeItem(state: InventoryState, itemId: string, quantity: number): void {
  assertItemId(itemId);
  assertQuantity(quantity);
  const current = state.items[itemId] ?? 0;
  if (current < quantity) {
    throw new BusinessError('INSUFFICIENT_ITEMS', '背包里的物品数量不足');
  }
  const next = current - quantity;
  if (next === 0) {
    delete state.items[itemId];
  } else {
    state.items[itemId] = next;
  }
}

export function totalQuantity(state: InventoryState | DeepReadonly<InventoryState>): number {
  let total = 0;
  for (const itemId of Object.keys(state.items)) {
    total = safeAddMoney(total, state.items[itemId] ?? 0, '物品总数');
  }
  return total;
}

/* ---------------------------------------------------------------- 请求协议 */

export interface SupplyRequestRef {
  readonly epoch: string;
  readonly sequence: number;
}

export type SupplyRequestParse =
  | { readonly ok: true; readonly ref: SupplyRequestRef }
  | { readonly ok: false; readonly reason: string };

export interface SupplyRequestCursor {
  readonly operationEpoch: string;
  readonly nextOperationSeq: number;
  /** 由当前 cursor 生成的规范 requestId；只读生成，不消耗序号。 */
  readonly requestId: string;
}

/** `supplies:<epoch>:<sequence>`；sequence 必须无前导零的正安全整数。 */
export function formatSupplyRequestId(epoch: string, sequence: number): string {
  if (!epoch || epoch.includes(':')) {
    throw new BusinessError('INVALID_EPOCH', '补给操作命名空间格式非法');
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new BusinessError('INVALID_SEQUENCE', '补给请求序号必须是正整数');
  }
  return `${REQUEST_PREFIX}:${epoch}:${sequence}`;
}

/**
 * 完整解析 requestId。
 *
 * 只接受确定格式 `supplies:<epoch>:<sequence>`；旧随机 UUID 或其他前缀
 * 一律返回 invalid，调用方不得猜测、不得补分配当前序号。
 */
export function parseSupplyRequestId(requestId: string): SupplyRequestParse {
  if (typeof requestId !== 'string') return { ok: false, reason: '请求标识不是字符串' };
  const match = /^supplies:([^:]+):([1-9]\d*)$/.exec(requestId);
  if (!match) return { ok: false, reason: '请求标识不是本轮的补给协议格式' };
  const epoch = match[1]!;
  const sequenceText = match[2]!;
  const sequence = Number(sequenceText);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    return { ok: false, reason: '补给请求序号超出安全整数范围' };
  }
  if (sequenceText !== String(sequence)) return { ok: false, reason: '补给请求序号格式非法' };
  return { ok: true, ref: { epoch, sequence } };
}

/** 只读 cursor：视图用它生成 requestId，不能预留或推进序号。 */
export function supplyCursorOf(
  state: InventoryState | DeepReadonly<InventoryState>,
): SupplyRequestCursor {
  return {
    operationEpoch: state.operationEpoch,
    nextOperationSeq: state.nextOperationSeq,
    requestId: formatSupplyRequestId(state.operationEpoch, state.nextOperationSeq),
  };
}

export function findSupplyReceipt(
  state: InventoryState | DeepReadonly<InventoryState>,
  sequence: number,
): SupplyRequestReceipt | null {
  for (const record of state.requests) {
    if (record.protocolVersion === SUPPLY_PROTOCOL_VERSION && record.sequence === sequence) {
      return record;
    }
  }
  return null;
}

export type SupplyRequestDecision =
  | { readonly kind: 'new'; readonly ref: SupplyRequestRef }
  | { readonly kind: 'replay'; readonly ref: SupplyRequestRef; readonly receipt: SupplyRequestReceipt }
  | { readonly kind: 'expired'; readonly ref: SupplyRequestRef }
  | { readonly kind: 'out-of-order'; readonly ref: SupplyRequestRef }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * 判定一次请求属于：新操作 / 可重放 / 已过期 / 乱序 / 非法。
 *
 * 关键规则：
 *  - 命名空间必须与当前存档一致，否则明确拒绝；
 *  - sequence < nextOperationSeq 但找不到收据时，是「已被裁剪的历史操作」，
 *    返回 expired，绝不放行为新操作；
 *  - sequence > nextOperationSeq 返回乱序，不修改状态；
 *  - 只有 sequence === nextOperationSeq 才是新操作。
 */
export function classifySupplyRequest(
  state: InventoryState | DeepReadonly<InventoryState>,
  requestId: string,
): SupplyRequestDecision {
  const parsed = parseSupplyRequestId(requestId);
  if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason };
  if (parsed.ref.epoch !== state.operationEpoch) {
    return { kind: 'invalid', reason: '请求不属于当前存档的操作命名空间' };
  }
  if (!Number.isSafeInteger(state.nextOperationSeq) || state.nextOperationSeq < 1) {
    return { kind: 'invalid', reason: '当前存档的补给序号已损坏' };
  }
  if (parsed.ref.sequence < state.nextOperationSeq) {
    const receipt = findSupplyReceipt(state, parsed.ref.sequence);
    if (receipt) return { kind: 'replay', ref: parsed.ref, receipt };
    return { kind: 'expired', ref: parsed.ref };
  }
  if (parsed.ref.sequence > state.nextOperationSeq) {
    return { kind: 'out-of-order', ref: parsed.ref };
  }
  return { kind: 'new', ref: parsed.ref };
}

export interface SupplyReceiptExpectation {
  readonly kind: SupplyRequestKind;
  readonly shopId: string | null;
  readonly itemId: string;
  readonly quantity: number;
}

/** 重放核对：操作种类、商店、商品、数量必须全部一致。 */
export function receiptMatchesExpectation(
  receipt: SupplyRequestReceipt,
  expected: SupplyReceiptExpectation,
): boolean {
  return (
    receipt.kind === expected.kind &&
    receipt.shopId === expected.shopId &&
    receipt.itemId === expected.itemId &&
    receipt.quantity === expected.quantity
  );
}

export interface SupplyReceiptInput extends SupplyReceiptExpectation {
  readonly requestId: string;
  readonly atMinute: number;
}

/**
 * 写入一条新协议收据并推进高水位序号。
 *
 * 调用方必须已完成全部业务写入；本函数在最后执行。序号越界或不是下一个
 * 可执行序号时明确拒绝（整个 GameStore 草稿会回滚）。
 */
export function commitSupplyOperation(
  state: InventoryState,
  input: SupplyReceiptInput,
): SupplyRequestReceipt {
  const parsed = parseSupplyRequestId(input.requestId);
  if (!parsed.ok) throw new BusinessError('INVALID_REQUEST', parsed.reason);
  if (parsed.ref.epoch !== state.operationEpoch) {
    throw new BusinessError('INVALID_REQUEST', '请求不属于当前存档的操作命名空间');
  }
  if (parsed.ref.sequence !== state.nextOperationSeq) {
    throw new BusinessError(
      parsed.ref.sequence > state.nextOperationSeq ? 'REQUEST_OUT_OF_ORDER' : 'REQUEST_EXPIRED',
      '补给请求序号与当前进度不一致',
    );
  }
  if (!Number.isSafeInteger(state.nextOperationSeq + 1)) {
    throw new BusinessError('REQUEST_SEQUENCE_EXHAUSTED', '补给请求序号已到安全整数边界');
  }
  if (!Number.isSafeInteger(input.atMinute) || input.atMinute < 0) {
    throw new BusinessError('INVALID_REQUEST', '补给请求时间必须是非负整数（游戏分钟）');
  }
  assertItemId(input.itemId);
  assertQuantity(input.quantity);
  if (input.shopId !== null && input.shopId.trim().length === 0) {
    throw new BusinessError('INVALID_REQUEST', '购买收据必须带合法商店标识');
  }

  const receipt: SupplyRequestReceipt = {
    protocolVersion: SUPPLY_PROTOCOL_VERSION,
    sequence: state.nextOperationSeq,
    requestId: input.requestId,
    kind: input.kind,
    itemId: input.itemId,
    quantity: input.quantity,
    shopId: input.shopId,
    atMinute: input.atMinute,
  };
  state.requests.push(receipt);
  const overflow = state.requests.length - MAX_REQUEST_RECORDS;
  if (overflow > 0) state.requests.splice(0, overflow);
  state.nextOperationSeq += 1;
  return receipt;
}

/* ---------------------------------------------------------------- 校验辅助 */

function assertItemId(itemId: string): void {
  if (itemId.trim().length === 0) {
    throw new BusinessError('INVALID_ITEM_ID', '物品标识不能为空');
  }
}

function assertQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new BusinessError('INVALID_QUANTITY', '物品数量必须是正整数');
  }
}
