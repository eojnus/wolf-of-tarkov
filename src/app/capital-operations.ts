/**
 * 资本共享写操作 —— 玩家命令与 AI 决策共用的唯一实现。
 *
 * 只做「在一次 GameStore 提交内改状态」：
 * 接受融资报价、执行回购。不处理 DOM、不发通知、不自动保存，
 * 也不自己再开一次 store.run（调用方已经处在提交中）。
 */

import { BusinessError } from '../core/errors';
import { formatMoney } from '../core/money';
import { dateAtMinute } from '../core/calendar';
import { TIME } from '../content/config';
import { bookOfCompany, effectiveShares, issueShares, moveToTreasury, pushRound, sharesOf, votingPower } from '../features/equity';
import { isClosed, type Enterprise } from '../features/enterprise';
import {
  availableSubjectBalance,
  businessAccountRef,
  releaseFunds,
  reserveFunds,
  subjectRef,
  transferFunds,
  transferReservedFunds,
} from '../features/finance';
import { acceptQuote, activeApplication, findQuote, type FinancingApplication, type FinancingQuote } from '../features/financing';
import { investorHolderId } from '../features/investors';
import { adjustPrice, marketOf } from '../features/stock';
import { DESK_ACCOUNT_ID, MARKET_MAKER_HOLDER } from './securities-settlement';
import { settleCrisisAfterCapital } from './business-settlement';
import { recordMechanicalPriceShift } from './population-market';
import { recordCityMechanicalShift } from './city-stock-index';
import { type GameState } from './state';
import { previewBuyback, type BuybackPreview } from './capital-query';

/**
 * 生成一次操作的唯一 id（用于流水与幂等审计）。
 *
 * 玩家命令与 AI 模拟都通过它取 id，因此放在共享写操作模块里。
 */
export function operationId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}:${random}`;
}


/** 预留所有报价；返回成功预留的报价列表。融资回应与 AI 决策共用。 */
export function reserveAll(state: GameState, quotes: readonly FinancingQuote[]): FinancingQuote[] {
  const kept: FinancingQuote[] = [];
  for (const quote of quotes) {
    const available = availableSubjectBalance(state.finance, 'investor', quote.investorId);
    if (available < quote.amountCents) continue;
    // 普通支出不得侵占已预留的资金：reserveFunds 内部按可用余额校验
    reserveFunds(state.finance, 'investor', quote.investorId, quote.amountCents, quote.id);
    kept.push(quote);
  }
  return kept;
}

export function cancelApplication(
  state: GameState,
  application: FinancingApplication,
  nowMinute: number,
  status: 'rejected' | 'expired',
): void {
  for (const quote of application.quotes) {
    releaseFunds(state.finance, 'investor', quote.investorId, quote.amountCents, quote.id);
  }
  application.quotes = [];
  application.status = status;
  application.decidedAtMinute = nowMinute;
  state.financing.lastDecidedMinute[application.companyId] = nowMinute;
}


export interface AcceptQuoteInput {
  readonly companyId: string;
  readonly quoteId: string;
  readonly atMinute: number;
  /** 资金来源/流水前缀，仅用于区分玩家命令与 AI 决策的 operationId。 */
  readonly operationPrefix?: string;
}

export interface AcceptQuoteResult {
  readonly company: Enterprise;
  readonly quote: FinancingQuote;
  readonly sharesBefore: number;
  readonly sharesAfter: number;
  readonly priceBefore: number | null;
  readonly priceAfter: number | null;
  readonly playerRatio: number;
  readonly playerVoting: number;
  /** 融资后公司是否已偿付到期应付并恢复经营。 */
  readonly recovered: boolean;
}

/**
 * 接受一份融资报价 —— 玩家与 AI 共用的唯一实现。
 *
 * 一次提交内完成：核对股份基数与报价承诺 → 投资者资金划入公司 → 消费该报价自己的预留
 * → 作废同轮其他报价并释放预留 → 发行新股并记录轮次 → 上市公司按加权参考调整行情。
 *
 * 显式接收 companyId：不依赖「当前管理公司」，因此 AI 也能调用同一份逻辑。
 */
export function acceptFinancingQuote(
  state: GameState,
  input: AcceptQuoteInput,
): AcceptQuoteResult {
  const company = state.enterprises.companies[input.companyId];
  if (!company) throw new BusinessError('NO_COMPANY', '公司不存在');
  if (isClosed(company)) throw new BusinessError('COMPANY_CLOSED', '公司已清算，不能接受报价');
  const book = bookOfCompany(state.equity, company.id);
  if (!book) throw new BusinessError('NO_BOOK', '公司没有股权簿');

  const application = activeApplication(state.financing, company.id);
  if (!application) throw new BusinessError('NO_APPLICATION', '没有进行中的融资申请');
  const quote = findQuote(application, input.quoteId);
  if (!quote) throw new BusinessError('NO_QUOTE', '报价不存在或已被取消');
  if (input.atMinute > quote.expiresAtMinute) {
    throw new BusinessError('QUOTE_EXPIRED', '该报价已过期');
  }

  // 报价有效期内的股权变化会改变稀释比例：不能继续按旧比例发行
  const effectiveBefore = effectiveShares(book);
  if (
    quote.effectiveSharesAtQuote !== effectiveBefore ||
    quote.totalSharesAtQuote !== book.totalShares
  ) {
    throw new BusinessError(
      'QUOTE_STALE',
      '报价后股本已经变化，原报价的稀释比例不再成立：请让这轮报价失效并重新申请',
    );
  }

  const monthKey = dateAtMinute(input.atMinute, TIME.calendar).monthKey;
  const accepted = acceptQuote(application, quote.id, input.atMinute);
  const prefix = input.operationPrefix ?? 'equity-financing';

  // 资金：投资者 → 公司（不是玩家个人，也不计经营收入）。
  // 走「受预留支持的划转」：只消费这份报价自己的承诺，划款与预留消费在同一次提交内完成。
  transferReservedFunds(state.finance, {
    atMinute: input.atMinute,
    monthKey,
    operationId: operationId(prefix),
    from: subjectRef('investor', accepted.investorId),
    to: businessAccountRef(company.id),
    amount: accepted.amountCents,
    category: 'equity-financing',
    memo: `外部股权融资 ${accepted.shares} 股`,
    reservationRef: accepted.id,
  });

  // 行情参考价必须在发行前取，且只用于「加权后」的参考，不能直接把市场价改成发行价
  const listedMarket = book.listed ? marketOf(state.securities, book.securityId) : null;
  const priceBefore = listedMarket ? listedMarket.price : null;

  const sharesBefore = book.totalShares;
  issueShares(book, investorHolderId(accepted.investorId), accepted.shares);
  pushRound(state.equity, book, {
    atMinute: input.atMinute,
    investorId: accepted.investorId,
    amountCents: accepted.amountCents,
    shares: accepted.shares,
    pricePerShareCents: accepted.pricePerShareCents,
    sharesBefore,
  });

  // 同轮其他报价全部作废并释放各自的预留
  for (const other of application.quotes) {
    if (other.id === accepted.id) continue;
    releaseFunds(state.finance, 'investor', other.investorId, other.amountCents, other.id);
  }

  let priceAfter: number | null = null;
  if (listedMarket && priceBefore !== null) {
    // 加权参考：发行价只决定本轮金额与新增股数；公开市场价按「旧有效股数 × 旧参考价 + 实际到账」摊薄
    const effectiveAfter = effectiveShares(book);
    const weighted = Math.round(
      (effectiveBefore * priceBefore + accepted.amountCents) / Math.max(1, effectiveAfter),
    );
    adjustPrice(listedMarket, Math.max(1, weighted), input.atMinute);
    priceAfter = listedMarket.price;
    // 摊薄造成的价格下调是机械重算，不是财富损失：按事件前后价格比例记录参考因子
    if (book.securityId) {
      recordMechanicalPriceShift(state, book.securityId, priceBefore, priceAfter);
      // 城市统计的连续指数是独立窗口：同一比例同时缩放参考因子与累计现金，
      // 不能把机械摊薄当成真实股灾（两份窗口各自维护）。
      recordCityMechanicalShift(state, book.securityId, priceBefore, priceAfter);
    }
  }

  // 融资成功后按既有规则偿付到期应付，再判断能否恢复经营（不无条件解除危机）
  const outcome = settleCrisisAfterCapital(state, company, input.atMinute);

  return {
    company,
    quote: accepted,
    sharesBefore,
    sharesAfter: book.totalShares,
    priceBefore,
    priceAfter,
    playerRatio: sharesOf(book, 'player') / Math.max(1, book.totalShares),
    playerVoting: votingPower(book, 'player'),
    recovered: outcome.recovered,
  };
}


export function executeBuyback(
  state: GameState,
  input: { companyId: string; shares: number; atMinute: number; operationPrefix?: string },
): BuybackPreview {
  const preview = previewBuyback(state, input.companyId, input.shares);
  if (preview.executableShares <= 0) {
    throw new BusinessError('NO_LIQUIDITY', preview.reason ?? '无法回购');
  }
  if (preview.executableShares !== input.shares) {
    // 不悄悄缩量：明确拒绝，让调用方确认新的数量
    throw new BusinessError(
      'QUANTITY_CHANGED',
      `最多可回购 ${preview.executableShares} 股（约 ${formatMoney(
        preview.executableShares * preview.priceCents,
      )}），请确认数量后重新提交`,
    );
  }

  const book = bookOfCompany(state.equity, input.companyId);
  if (!book) throw new BusinessError('NO_BOOK', '公司没有股权簿');
  const market = marketOf(state.securities, book.securityId);
  if (!market) throw new BusinessError('NO_MARKET', '该证券没有行情');

  transferFunds(state.finance, {
    atMinute: input.atMinute,
    monthKey: dateAtMinute(input.atMinute, TIME.calendar).monthKey,
    operationId: operationId(input.operationPrefix ?? 'buyback'),
    from: businessAccountRef(input.companyId),
    to: subjectRef('market', DESK_ACCOUNT_ID),
    amount: preview.amountCents,
    category: 'business-buyback',
    memo: `回购 ${preview.executableShares} 股`,
  });
  moveToTreasury(book, MARKET_MAKER_HOLDER, preview.executableShares);
  // 回购的价格影响走统一行情与 K 线，不另写第二份图表数据
  adjustPrice(market, preview.priceCents, input.atMinute);
  return preview;
}

