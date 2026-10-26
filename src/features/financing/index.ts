/**
 * 融资模块 —— 申请、报价、有效期与轮次状态。
 *
 * 职责边界：
 *  - 只记录「谁申请了多少钱、谁给了什么报价、报价何时失效」；
 *  - 不动资金（financing 只描述金额，扣款由 app 调用 finance 完成）；
 *  - 不发股份（由 app 调用 equity.issueShares）；
 *  - 报价一经生成即固化：读档、开界面、反复点击都不会重抽。
 *
 * 报价的股数按「实际到账金额 ÷ 每股价格」取整，因此金额与股数永远自洽，
 * 界面显示的比例就是真实比例，不会承诺兑现不了的数字。
 */

import type { DeepReadonly } from '../../core/readonly';
import { BusinessError } from '../../core/errors';
import {
  FINANCING_RULES,
  type InvestorConfig,
} from '../../content/capital';
import type { ShareBook } from '../equity';

export type FinancingStatus = 'pending' | 'quoted' | 'accepted' | 'rejected' | 'expired';

export interface QuoteHoldingLine {
  readonly holderId: string;
  readonly shares: number;
  /** 融资后的持股比例（0～1）。 */
  readonly ratio: number;
  /** 融资后的表决权比例（0～1，库存股不计入分母）。 */
  readonly voting: number;
}

export interface FinancingQuote {
  readonly id: string;
  readonly investorId: string;
  /** 实际到账金额（分）= 股数 × 每股价格。 */
  readonly amountCents: number;
  readonly shares: number;
  readonly pricePerShareCents: number;
  readonly preMoneyCents: number;
  readonly postMoneyCents: number;
  readonly expiresAtMinute: number;
  /**
   * 报价生效时的股份基数快照（总股数与有效股份）。
   * 有效期内的增发、回购会改变基数，接受时必须重新核对：
   * 基数变了就不能继续沿用旧比例，只能拒绝这份报价并重新申请。
   */
  readonly totalSharesAtQuote: number;
  readonly effectiveSharesAtQuote: number;
  /** 报价后各股东的比例快照，只用于界面比较，不参与计算。 */
  readonly postHoldings: QuoteHoldingLine[];
}

export interface FinancingApplication {
  readonly id: string;
  readonly companyId: string;
  readonly requestedCents: number;
  readonly submittedMinute: number;
  readonly respondAtMinute: number;
  status: FinancingStatus;
  quotes: FinancingQuote[];
  decidedAtMinute: number | null;
  /** 接受时记录的报价 id，供界面与存档核对。 */
  acceptedQuoteId: string | null;
}

export interface FinancingState {
  /** 每家公司最多一份在途申请。 */
  applications: Record<string, FinancingApplication | null>;
  /** 上一次「全部拒绝」的时刻，用于再申请冷却。 */
  lastDecidedMinute: Record<string, number | null>;
  nextSeq: number;
}

export function createFinancingState(): FinancingState {
  return { applications: {}, lastDecidedMinute: {}, nextSeq: 1 };
}

/* ---------------------------------------------------------------- 申请 */

export function activeApplication(
  state: FinancingState,
  companyId: string,
): FinancingApplication | null;
export function activeApplication(
  state: DeepReadonly<FinancingState>,
  companyId: string,
): DeepReadonly<FinancingApplication> | null;
export function activeApplication(
  state: FinancingState | DeepReadonly<FinancingState>,
  companyId: string,
): FinancingApplication | DeepReadonly<FinancingApplication> | null {
  return state.applications[companyId] ?? null;
}

/** 是否有「还没结束」的申请（pending 或 quoted）。 */
export function hasOpenApplication(state: FinancingState, companyId: string): boolean {
  const application = activeApplication(state, companyId);
  return application !== null && (application.status === 'pending' || application.status === 'quoted');
}

/** 拒绝后的冷却是否已过；返回还差多少分钟（0 表示可以申请）。 */
export function cooldownRemaining(
  state: FinancingState | DeepReadonly<FinancingState>,
  companyId: string,
  nowMinute: number,
): number {
  const last = state.lastDecidedMinute[companyId] ?? null;
  if (last === null) return 0;
  const gate = last + FINANCING_RULES.reapplyCooldownDays * 1440;
  return Math.max(0, gate - nowMinute);
}

export function submitApplication(
  state: FinancingState,
  input: {
    readonly companyId: string;
    readonly requestedCents: number;
    readonly nowMinute: number;
  },
): FinancingApplication {
  if (!Number.isSafeInteger(input.requestedCents)) {
    throw new BusinessError('INVALID_AMOUNT', '融资金额必须是整数（分）');
  }
  if (
    input.requestedCents < FINANCING_RULES.minRequestCents ||
    input.requestedCents > FINANCING_RULES.maxRequestCents
  ) {
    throw new BusinessError(
      'INVALID_AMOUNT',
      `期望融资金额需在 ${(FINANCING_RULES.minRequestCents / 100).toFixed(0)} ～ ${(
        FINANCING_RULES.maxRequestCents / 100
      ).toFixed(0)} 元之间`,
    );
  }
  if (hasOpenApplication(state, input.companyId)) {
    throw new BusinessError('APPLICATION_EXISTS', '已经有一份进行中的融资申请');
  }
  if (cooldownRemaining(state, input.companyId, input.nowMinute) > 0) {
    throw new BusinessError('COOLDOWN', '刚拒绝过一轮报价，还需等待一段时间才能再次申请');
  }

  const application: FinancingApplication = {
    id: `fin-${state.nextSeq}`,
    companyId: input.companyId,
    requestedCents: input.requestedCents,
    submittedMinute: input.nowMinute,
    respondAtMinute: input.nowMinute + FINANCING_RULES.respondDays * 1440,
    status: 'pending',
    quotes: [],
    decidedAtMinute: null,
    acceptedQuoteId: null,
  };
  state.nextSeq += 1;
  state.applications[input.companyId] = application;
  return application;
}

/* ---------------------------------------------------------------- 报价 */

export interface QuoteCandidate {
  readonly investor: InvestorConfig;
  readonly amountCents: number;
  readonly valuationPremium: number;
}

function holdingLines(
  book: ShareBook,
  issuerShares: Array<{ holderId: string; extraShares: number }>,
): QuoteHoldingLine[] {
  const extra = new Map<string, number>();
  let issued = 0;
  for (const item of issuerShares) {
    extra.set(item.holderId, (extra.get(item.holderId) ?? 0) + item.extraShares);
    issued += item.extraShares;
  }
  const total = book.totalShares + issued;
  const effective = total - book.treasuryShares;
  const lines: QuoteHoldingLine[] = [];
  const ids = new Set<string>([...Object.keys(book.holdings), ...extra.keys()]);
  for (const holderId of ids) {
    const shares = (book.holdings[holderId] ?? 0) + (extra.get(holderId) ?? 0);
    if (shares <= 0) continue;
    lines.push({
      holderId,
      shares,
      ratio: total > 0 ? shares / total : 0,
      voting: effective > 0 ? shares / effective : 0,
    });
  }
  return lines.sort((left, right) => right.shares - left.shares);
}

/**
 * 由候选投资者生成报价。
 *
 * 每份报价的价格 = 融资前估值 × 该投资者的溢价 / 有效股份；
 * 股数向下取整，然后把「股数 × 价格」作为实际到账金额，
 * 因此 amountCents 与 shares 永远精确对应。
 */
export function buildQuotes(
  book: ShareBook,
  input: {
    readonly preMoneyCents: number;
    readonly candidates: readonly QuoteCandidate[];
    readonly nowMinute: number;
    /**
     * 申请标识：报价 id 必须**全局**区分公司与轮次。
     * 只按「投资者 + 发行股数」生成会让不同公司的报价撞成同一个 id，
     * 它们的资金预留也会共用一个键，接受时分不清是谁的承诺。
     */
    readonly applicationId: string;
  },
): FinancingQuote[] {
  const effective = book.totalShares - book.treasuryShares;
  if (effective <= 0 || input.preMoneyCents <= 0) return [];

  const quotes: FinancingQuote[] = [];
  for (const candidate of input.candidates) {
    if (quotes.length >= FINANCING_RULES.maxQuotes) break;
    const price = Math.max(
      1,
      Math.floor((input.preMoneyCents * candidate.valuationPremium) / effective),
    );
    const shares = Math.floor(candidate.amountCents / price);
    if (shares <= 0) continue;
    const amount = shares * price;
    if (amount < FINANCING_RULES.minQuoteCents) continue;

    const postTotal = book.totalShares + shares;
    const postEffective = postTotal - book.treasuryShares;
    quotes.push({
      id: `quote-${input.applicationId}-${candidate.investor.id}-${shares}`,
      investorId: candidate.investor.id,
      amountCents: amount,
      shares,
      pricePerShareCents: price,
      preMoneyCents: input.preMoneyCents,
      postMoneyCents: input.preMoneyCents + amount,
      expiresAtMinute: input.nowMinute + FINANCING_RULES.quoteValidDays * 1440,
      totalSharesAtQuote: book.totalShares,
      effectiveSharesAtQuote: effective,
      postHoldings: holdingLines(book, [
        { holderId: `inv:${candidate.investor.id}`, extraShares: shares },
      ]).map((line) => ({
        ...line,
        ratio: postTotal > 0 ? line.shares / postTotal : 0,
        voting: postEffective > 0 ? line.shares / postEffective : 0,
      })),
    });
  }
  return quotes;
}

/** 把报价写进申请并标记为「已报价」。 */
export function attachQuotes(
  application: FinancingApplication,
  quotes: FinancingQuote[],
): void {
  application.quotes = quotes;
  application.status = 'quoted';
}

export function findQuote(
  application: FinancingApplication,
  quoteId: string,
): FinancingQuote | null {
  return application.quotes.find((quote) => quote.id === quoteId) ?? null;
}

export function isQuoteExpired(quote: FinancingQuote, nowMinute: number): boolean {
  return nowMinute > quote.expiresAtMinute;
}

/** 全部报价都过期时，本轮作废。 */
export function expireIfStale(application: FinancingApplication, nowMinute: number): boolean {
  if (application.status !== 'quoted') return false;
  if (application.quotes.some((quote) => !isQuoteExpired(quote, nowMinute))) return false;
  application.status = 'expired';
  application.decidedAtMinute = nowMinute;
  return true;
}

export function acceptQuote(
  application: FinancingApplication,
  quoteId: string,
  nowMinute: number,
): FinancingQuote {
  if (application.status !== 'quoted') {
    throw new BusinessError('NO_QUOTES', '当前没有可接受的报价');
  }
  const quote = findQuote(application, quoteId);
  if (!quote) throw new BusinessError('NO_QUOTE', '报价不存在或已被取消');
  if (isQuoteExpired(quote, nowMinute)) {
    throw new BusinessError('QUOTE_EXPIRED', '该报价已过期');
  }
  application.status = 'accepted';
  application.acceptedQuoteId = quote.id;
  application.decidedAtMinute = nowMinute;
  return quote;
}

/** 全部拒绝：不改变股权与资金，只记录冷却起点。 */
export function rejectAll(application: FinancingApplication, nowMinute: number): void {
  if (application.status !== 'quoted' && application.status !== 'pending') {
    throw new BusinessError('NO_QUOTES', '当前没有可以拒绝的申请');
  }
  application.status = 'rejected';
  application.decidedAtMinute = nowMinute;
  application.quotes = [];
}
