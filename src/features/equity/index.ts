/**
 * 股权模块 —— 股份发行、股东持股、库存股、表决权与所有权不变量。
 *
 * 职责边界：
 *  - 只维护「谁持有多少股」，不碰资金、不碰行情、不碰界面。
 *  - 每只证券有一本股权簿（share book）：上市公司由某家公司发行，
 *    旧独立标的没有发行公司（companyId = null），但仍需一本簿子供交易结算。
 *  - 不变量：总发行股数 = 所有股东持股之和 + 库存股。
 *  - 库存股既没有表决权也没有分红权；比例分母用「有效股份」（总股数 − 库存股）。
 *  - 公司角色（玩家 / AI）与股东身份、CEO 职位完全分开：持股不等于管理权。
 */

import { BusinessError } from '../../core/errors';
import type { DeepReadonly } from '../../core/readonly';
import { EQUITY_RULES } from '../../content/capital';

/** 股东身份类型。id 才是稳定标识，名称只用于界面。 */
export type HolderKind = 'player' | 'investor' | 'market-maker';

export interface FinancingRoundRecord {
  readonly roundId: string;
  readonly atMinute: number;
  readonly investorId: string;
  readonly amountCents: number;
  readonly shares: number;
  readonly pricePerShareCents: number;
  /** 该轮之前的已发行股数，用于复盘稀释。 */
  readonly sharesBefore: number;
}

export interface ShareBook {
  readonly securityId: string;
  /** 发行公司；旧独立标的（无发行公司）为 null。 */
  readonly companyId: string | null;
  /** 已发行总股数（含库存股）。 */
  totalShares: number;
  /** 库存股：公司自己持有，不投票、不分红。 */
  treasuryShares: number;
  /** 股东持股（不含库存股）。key 是稳定 holderId。 */
  holdings: Record<string, number>;
  /**
   * 现任 CEO 的 holderId；没有则为 null（由 AI 代管经营）。
   * CEO 与持股完全解耦：任职后卖光股份不会自动失去职位，职位只由治理流程改变。
   */
  ceoId: string | null;
  listed: boolean;
  listedAtMinute: number | null;
  /** 是否完成过外部股权融资（上市资格的前提）。 */
  hasExternalFinancing: boolean;
  rounds: FinancingRoundRecord[];
  /** 累计回购股数（转入库存股）。 */
  buybackTotalShares: number;
  /** 累计现金分红（分），仅用于展示。 */
  dividendTotalCents: number;
  /**
   * 创始股东累计实缴出资（分）。与增发无关，用于上市公司把创始持股
   * 同步到证券持仓时保留成本口径，避免上市后成本凭空变成 0 或市价。
   */
  founderContributionCents: number;
  /**
   * 初始「无偿配给非创始股东」的股数，记录仍留在他方手里的无偿份额。
   * 玩家公司必须为 0（做市商只能通过真实转让取得股份）；
   * 三家 AI 公司的历史配置允许非零，但必须写明来源。
   */
  sponsorGrantShares: number;
  /**
   * 历史说明：迁移或开局时「本来就已完成」的融资/上市关系。
   * 这类关系没有对应的现金流水，必须写明来源，不能伪装成刚发生的交易。
   */
  historyNote: string | null;
}

export interface EquityState {
  books: Record<string, ShareBook>;
  nextRoundSeq: number;
}

export function createEquityState(): EquityState {
  return { books: {}, nextRoundSeq: 1 };
}

/* ---------------------------------------------------------------- 查询 */

export function bookOf(equity: EquityState, securityId: string): ShareBook | null {
  return equity.books[securityId] ?? null;
}

type ReadonlyEquity = DeepReadonly<EquityState>;
/** 只读股权簿：查询路径用它，写入仍用 ShareBook。 */
export type ReadonlyShareBook = DeepReadonly<ShareBook>;

export function bookOfCompany(equity: EquityState, companyId: string): ShareBook | null;
export function bookOfCompany(
  equity: ReadonlyEquity,
  companyId: string,
): ReadonlyShareBook | null;
export function bookOfCompany(
  equity: EquityState | ReadonlyEquity,
  companyId: string,
): ShareBook | ReadonlyShareBook | null {
  for (const book of Object.values(equity.books)) {
    if (book.companyId === companyId) return book;
  }
  return null;
}

export function sharesOf(
  book: ShareBook | ReadonlyShareBook,
  holderId: string,
): number {
  return book.holdings[holderId] ?? 0;
}

/** 有效股份 = 总股数 − 库存股。表决权与分红的唯一分母。 */
export function effectiveShares(
  book: ShareBook | ReadonlyShareBook,
): number {
  return Math.max(0, book.totalShares - book.treasuryShares);
}

/** 表决权比例（0～1）。库存股不投票，因此分母是有效股份。 */
export function votingPower(
  book: ShareBook | ReadonlyShareBook,
  holderId: string,
): number {
  const base = effectiveShares(book);
  if (base <= 0) return 0;
  return sharesOf(book, holderId) / base;
}

/** 持股比例（0～1）：按总发行股数计算，库存股会稀释所有股东。 */
export function ownershipRatio(book: ShareBook, holderId: string): number {
  if (book.totalShares <= 0) return 0;
  return sharesOf(book, holderId) / book.totalShares;
}

/** 股东列表，按持股从多到少；同股数按 id 排序，保证稳定。 */
export function holdersSorted(book: ShareBook): Array<{ holderId: string; shares: number }> {
  return Object.entries(book.holdings)
    .filter(([, shares]) => shares > 0)
    .map(([holderId, shares]) => ({ holderId, shares }))
    .sort((left, right) =>
      right.shares === left.shares
        ? left.holderId.localeCompare(right.holderId)
        : right.shares - left.shares,
    );
}

/** 所有股东持股之和（校验用）。 */
export function holdingsTotal(
  book: ShareBook | ReadonlyShareBook,
): number {
  let sum = 0;
  for (const shares of Object.values(book.holdings)) sum += shares;
  return sum;
}

export function isControlHolder(book: ShareBook, holderId: string): boolean {
  return votingPower(book, holderId) > EQUITY_RULES.controlThreshold;
}

/* ---------------------------------------------------------------- 创建 */

function assertShares(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BusinessError('INVALID_SHARES', `${label}必须是非负整数股`);
  }
  if (value > 1_000_000_000_000) {
    throw new BusinessError('SHARES_OVERFLOW', `${label}超出允许范围`);
  }
}

export interface CompanyBookInput {
  readonly companyId: string;
  readonly securityId: string;
  /** 创始股东：玩家公司为 'player'，AI 公司为 'ai:<companyId>'。 */
  readonly founderId: string;
  /** 做市商 holderId。玩家公司的初始配股为 0，AI 历史配置才允许非零。 */
  readonly marketMakerId: string;
  readonly totalShares?: number;
  /**
   * 创始股东初始持股比例。玩家新建公司传 `EQUITY_RULES.playerFounderRatio`（100%）；
   * 三家 AI 的历史股权才传 `EQUITY_RULES.founderRatio`。
   */
  readonly founderRatio?: number;
  /**
   * 非创始股东（做市商）的初始配股比例。默认 0：
   * 做市库存必须通过真实股份转让取得，不能在建簿时凭空生成。
   */
  readonly sponsorRatio?: number;
  /** 建立这本簿时的来源说明（迁移、AI 历史配置等），没有现金对应关系时必须写。 */
  readonly historyNote?: string | null;
}

/**
 * 为一家公司建立股权簿。
 *
 * 初始股份全部是「发行」出来的账面份额，不对应任何现金：
 * 发行股票本身绝不产生资金流水（钱只能通过融资或经营进入公司）。
 * 默认只把股份发给创始股东；给第三方无偿配股必须显式传 `sponsorRatio`，
 * 并会被记录为 `sponsorGrantShares` 以便日后审计与受控修复。
 */
export function createCompanyBook(equity: EquityState, input: CompanyBookInput): ShareBook {
  if (equity.books[input.securityId]) {
    throw new BusinessError('BOOK_EXISTS', '该证券已经有股权簿');
  }
  const total = input.totalShares ?? EQUITY_RULES.initialShares;
  assertShares(total, '初始发行股数');
  if (total <= 0) throw new BusinessError('INVALID_SHARES', '初始发行股数必须大于 0');

  const sponsorRatio = input.sponsorRatio ?? 0;
  const treasury = Math.floor(total * EQUITY_RULES.treasuryRatio);
  const sponsor = Math.floor(total * sponsorRatio);
  const founder = total - treasury - sponsor;
  if (founder <= 0) {
    throw new BusinessError('INVALID_SHARES', '创始股东持股必须大于 0');
  }
  if (input.founderRatio !== undefined) {
    const expected = Math.floor(total * input.founderRatio);
    if (expected !== founder) {
      throw new BusinessError('INVALID_SHARES', '创始持股比例与配股比例不一致');
    }
  }

  const book: ShareBook = {
    securityId: input.securityId,
    companyId: input.companyId,
    totalShares: total,
    treasuryShares: treasury,
    holdings: { [input.founderId]: founder },
    ceoId: input.founderId,
    listed: false,
    listedAtMinute: null,
    hasExternalFinancing: false,
    rounds: [],
    buybackTotalShares: 0,
    dividendTotalCents: 0,
    founderContributionCents: 0,
    sponsorGrantShares: sponsor,
    historyNote: input.historyNote ?? null,
  };
  if (sponsor > 0) book.holdings[input.marketMakerId] = sponsor;
  equity.books[input.securityId] = book;
  return book;
}

/**
 * 旧独立标的的股权簿：没有发行公司，股份全部来自既有的场内流通量。
 * `holderShares` 是迁移前玩家已持有的股数，其余归做市商。
 */
export function createStandaloneBook(
  equity: EquityState,
  input: {
    readonly securityId: string;
    readonly holderId: string;
    readonly holderShares: number;
    readonly marketMakerId: string;
  },
): ShareBook {
  const held = Math.max(0, Math.trunc(input.holderShares));
  const total = Math.max(EQUITY_RULES.standaloneFloat, held * 4);
  const book: ShareBook = {
    securityId: input.securityId,
    companyId: null,
    totalShares: total,
    treasuryShares: 0,
    holdings: { [input.holderId]: held, [input.marketMakerId]: total - held },
    ceoId: null,
    listed: true,
    listedAtMinute: 0,
    hasExternalFinancing: false,
    rounds: [],
    buybackTotalShares: 0,
    dividendTotalCents: 0,
    founderContributionCents: 0,
    // 旧独立标的没有发行公司，流通量本来就全部来自场内（含做市库存），不属于无偿配股
    sponsorGrantShares: 0,
    historyNote: '旧独立标的：没有发行公司，股份来自既有场内流通量',
  };
  equity.books[input.securityId] = book;
  return book;
}

/* ---------------------------------------------------------------- 变更 */

/** 增发：总股数增加，原股东持股数量不变（比例被稀释）。 */
export function issueShares(book: ShareBook, holderId: string, shares: number): void {
  assertShares(shares, '增发股数');
  if (shares <= 0) throw new BusinessError('INVALID_SHARES', '增发股数必须大于 0');
  book.totalShares += shares;
  book.holdings[holderId] = sharesOf(book, holderId) + shares;
}

/** 股东之间转让股份。总量不变。 */
export function transferShares(
  book: ShareBook,
  fromHolderId: string,
  toHolderId: string,
  shares: number,
): void {
  assertShares(shares, '转让股数');
  if (shares <= 0) throw new BusinessError('INVALID_SHARES', '转让股数必须大于 0');
  const from = sharesOf(book, fromHolderId);
  if (from < shares) {
    throw new BusinessError('INSUFFICIENT_SHARES', '持股不足，无法转让');
  }
  book.holdings[fromHolderId] = from - shares;
  book.holdings[toHolderId] = sharesOf(book, toHolderId) + shares;
}

/** 从股东手里回购进库存股：总股数不变。 */
export function moveToTreasury(book: ShareBook, fromHolderId: string, shares: number): void {
  assertShares(shares, '回购股数');
  if (shares <= 0) throw new BusinessError('INVALID_SHARES', '回购股数必须大于 0');
  const from = sharesOf(book, fromHolderId);
  if (from < shares) {
    throw new BusinessError('INSUFFICIENT_SHARES', '股东持股不足，无法回购');
  }
  book.holdings[fromHolderId] = from - shares;
  book.treasuryShares += shares;
  book.buybackTotalShares += shares;
}

/**
 * 受控修复：把仍属于「无偿配股」的股份从赞助方收回给创始股东。
 * 只修 `sponsorGrantShares` 记录里的部分，绝不越过它去拿别的主体真实买入的股份。
 */
export function recallSponsorShares(
  book: ShareBook,
  sponsorHolderId: string,
  founderHolderId: string,
  shares: number,
): number {
  assertShares(shares, '收回无偿配股');
  const capped = Math.min(shares, sharesOf(book, sponsorHolderId), book.sponsorGrantShares);
  if (capped <= 0) return 0;
  transferShares(book, sponsorHolderId, founderHolderId, capped);
  book.sponsorGrantShares -= capped;
  return capped;
}

/**
 * CEO 身份的合法形式。**不要求持股**：持股与经营权是两件事，
 * 任职后把股份卖光不会让职位字段变得非法；职位只由治理流程改变。
 */
export function isValidCeoIdentity(holderId: string): boolean {
  if (holderId === 'player') return true;
  if (holderId.startsWith('ai:') && holderId.length > 3) return true;
  if (holderId.startsWith('inv:') && holderId.length > 4) return true;
  return false;
}

/** 校验股权簿的基本不变量；返回问题是给人看的说明，null 表示正常。 */
export function checkBookIntegrity(book: ShareBook): string | null {
  if (!Number.isSafeInteger(book.totalShares) || book.totalShares <= 0) {
    return '总发行股数必须是正整数';
  }
  if (!Number.isSafeInteger(book.treasuryShares) || book.treasuryShares < 0) {
    return '库存股必须是非负整数';
  }
  if (!Number.isSafeInteger(book.sponsorGrantShares) || book.sponsorGrantShares < 0) {
    return '无偿配股记录必须是非负整数';
  }
  for (const [holderId, shares] of Object.entries(book.holdings)) {
    if (!Number.isSafeInteger(shares) || shares < 0) return `股东 ${holderId} 持股非法`;
  }
  const sum = holdingsTotal(book) + book.treasuryShares;
  if (sum !== book.totalShares) {
    return `股份合计 ${sum} 与总发行股数 ${book.totalShares} 不一致`;
  }
  // CEO 只校验身份形式；持股数量不是任职前提
  if (book.ceoId !== null && !isValidCeoIdentity(book.ceoId)) {
    return `CEO 身份非法：${book.ceoId}`;
  }
  return null;
}

/** 记录一轮融资；超出上限时丢弃最旧的。 */
export function pushRound(equity: EquityState, book: ShareBook, record: Omit<FinancingRoundRecord, 'roundId'>): FinancingRoundRecord {
  const round: FinancingRoundRecord = {
    roundId: `round-${equity.nextRoundSeq}`,
    ...record,
  };
  equity.nextRoundSeq += 1;
  book.rounds.push(round);
  if (book.rounds.length > EQUITY_RULES.maxRounds) {
    book.rounds.splice(0, book.rounds.length - EQUITY_RULES.maxRounds);
  }
  book.hasExternalFinancing = true;
  return round;
}
