/**
 * 证券与资本视图 —— 只读数据，界面直接消费，不做任何业务计算。
 *
 * 覆盖三块：
 *  - 人物界面的持仓卡片（按 securityId 组织，多只证券各自独立）；
 *  - 证券中心的标的列表与交易预览；
 *  - 公司管理的资本与治理子页。
 */

import { dateAtMinute, formatDuration } from '../core/calendar';
import { formatMoney } from '../core/money';
import {
  FINANCING_RULES,
  GOVERNANCE_RULES,
  LIQUIDITY_RULES,
  PROMOTION_RULES,
  VALUATION_RULES,
} from '../content/capital';
import { TIME } from '../content/config';
import { STATUS_LABELS } from '../features/enterprise';
import {
  bookOfCompany,
  holdingsTotal,
  sharesOf,
  votingPower,
  type ReadonlyShareBook,
  type ShareBook,
} from '../features/equity';
import { investorName, investorProfiles } from '../features/investors';
import { proposalsOf } from '../features/governance';
import {
  averageCost,
  candlesOf,
  changeSpanMinutes,
  forSaleShares,
  marketOf,
  priceChangeOf,
  tradesOf,
  unrealizedPnl,
  type Candle,
} from '../features/stock';
import { techViewOf } from '../features/technology';
import {
  applicationViewOf,
  controlSummaryOf,
  investorAvailable,
  listingReadinessOf,
  previewBuyback,
  promotionOf,
} from './capital-query';
import { fairPriceOf, fairValueCents, previewTrade } from './securities-settlement';
import {
  managedCompany,
  playerCompanies,
  playerHoldingOf,
  securityValueOf,
  stockValue,
  unlistedEquity,
  type ReadonlyGameState,
} from './state';

export interface TradeRowView {
  readonly id: string;
  readonly dateText: string;
  readonly label: string;
  readonly amountText: string;
  readonly kind: 'buy' | 'sell';
}

export interface StockCardView {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly priceText: string;
  readonly changeText: string;
  readonly changePctText: string;
  readonly direction: 'up' | 'down' | 'flat';
  readonly shares: number;
  readonly sharesText: string;
  readonly avgCostText: string;
  readonly valueText: string;
  readonly pnlText: string;
  readonly pnlPctText: string;
  readonly pnlPositive: boolean;
  readonly totalCostText: string;
  readonly realizedText: string;
  readonly realizedPositive: boolean;
  readonly tradesText: string;
  /** 证券是否已随发行公司清算终止：终止后市值按 0 计，只显示历史结果。 */
  readonly terminated: boolean;
  readonly statusText: string;
  readonly candles: readonly Candle[];
  readonly current: Candle | null;
  readonly trades: TradeRowView[];
}

export interface StocksSectionView {
  readonly totalValueText: string;
  readonly totalCostText: string;
  readonly totalPnlText: string;
  readonly totalPnlPctText: string;
  readonly totalPnlPositive: boolean;
  readonly realizedText: string;
  readonly realizedPositive: boolean;
  readonly spanText: string;
  readonly cards: StockCardView[];
  readonly empty: boolean;
}

function signed(amount: number): string {
  return `${amount >= 0 ? '+' : '−'}${formatMoney(Math.abs(amount))}`;
}

function percentText(value: number, base: number): string {
  if (base <= 0) return '—';
  const pct = (value / base) * 100;
  return `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%`;
}

function directionOf(change: number): 'up' | 'down' | 'flat' {
  return change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
}

function tradeRowsOf(state: ReadonlyGameState, securityId: string): TradeRowView[] {
  return tradesOf(state.securities, securityId)
    .slice(-12)
    .reverse()
    .map((trade) => ({
      id: trade.id,
      dateText: formatGameDate(dateAtMinute(trade.minute, TIME.calendar)),
      label: `${trade.side === 'buy' ? '买入' : '卖出'} ${trade.shares} 股 @${(trade.priceCents / 100).toFixed(2)}`,
      amountText: formatMoney(trade.amountCents),
      kind: trade.side,
    }));
}

function formatGameDate(date: { year: number; month: number; day: number }): string {
  return `${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

/** 单只证券的持仓卡片；没有持仓时也可以用于「仅查看」。 */
export function cardOf(state: ReadonlyGameState, securityId: string): StockCardView | null {
  const market = marketOf(state.securities, securityId);
  const meta = state.securities.meta[securityId];
  if (!market || !meta) return null;
  const holding = playerHoldingOf(state, securityId);
  const { change, pct } = priceChangeOf(market);
  const terminated = meta.terminatedAtMinute !== null || holding.terminatedAtMinute !== null;
  // 统一口径：终止后不再按最后成交价计市值
  const value = securityValueOf(state, securityId);
  const floating = terminated ? 0 : unrealizedPnl(holding, market.price);
  const { closed, current } = candlesOf(market);
  return {
    id: securityId,
    symbol: meta.symbol,
    name: meta.name,
    priceText: terminated ? '已终止' : formatMoney(market.price),
    changeText: terminated ? '—' : signed(change),
    changePctText: terminated ? '—' : `${pct >= 0 ? '+' : '−'}${(Math.abs(pct) * 100).toFixed(2)}%`,
    direction: terminated ? 'flat' : directionOf(change),
    shares: holding.shares,
    sharesText: `${holding.shares} 股`,
    avgCostText: holding.shares > 0 ? formatMoney(Math.round(averageCost(holding))) : '—',
    valueText: formatMoney(value),
    pnlText: terminated ? '已清算' : signed(floating),
    pnlPctText: terminated ? '—' : percentText(floating, holding.totalCost),
    pnlPositive: floating >= 0,
    totalCostText: formatMoney(holding.totalCost),
    realizedText: signed(holding.realizedPnl),
    realizedPositive: holding.realizedPnl >= 0,
    tradesText: `${holding.trades} 笔`,
    terminated,
    statusText: terminated ? '已清算 · 证券终止' : '正常交易',
    candles: closed,
    current,
    trades: tradeRowsOf(state, securityId),
  };
}

/**
 * 人物界面「股票投资」栏目：只展示真实持仓。
 * 已终止（清算）的持仓单独列出，其成本不计入浮动盈亏，避免与已实现盈亏重复计算。
 */
export function buildStocksSection(state: ReadonlyGameState): StocksSectionView {
  const ids = Object.keys(state.securities.markets).sort();
  const cards: StockCardView[] = [];
  let totalCost = 0;
  let realized = 0;
  for (const id of ids) {
    const holding = playerHoldingOf(state, id);
    if (holding.shares <= 0) continue;
    const card = cardOf(state, id);
    if (!card) continue;
    cards.push(card);
    realized += holding.realizedPnl;
    if (!card.terminated) totalCost += holding.totalCost;
  }
  const value = stockValue(state);
  const floating = value - totalCost;
  return {
    totalValueText: formatMoney(value),
    totalCostText: formatMoney(totalCost),
    totalPnlText: signed(floating),
    totalPnlPctText: percentText(floating, totalCost),
    totalPnlPositive: floating >= 0,
    realizedText: signed(realized),
    realizedPositive: realized >= 0,
    spanText: cards.length > 0 ? '按各标的最新行情（已清算持仓不计市值）' : '',
    cards,
    empty: cards.length === 0,
  };
}

/* ---------------------------------------------------------------- 证券中心 */

export interface SecurityRowView {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly priceText: string;
  readonly changePctText: string;
  readonly direction: 'up' | 'down' | 'flat';
  readonly holdingText: string;
  readonly statusText: string;
  readonly detailText: string;
  readonly selected: boolean;
}

/** 针对玩家实际输入的数量算出的交易预览；成交价就是执行时会用的价。 */
export interface TradePreviewView {
  readonly requestedShares: number;
  readonly executableShares: number;
  readonly priceCents: number;
  readonly priceText: string;
  readonly amountText: string;
  readonly impactText: string;
  /** 只能部分成交（数量受流动性/资金/单笔上限限制）。 */
  readonly partial: boolean;
  readonly note: string;
}

export interface SecuritiesOrderQuery {
  readonly buyShares?: number;
  readonly sellShares?: number;
}

/**
 * 公司详情：股份供给结构。
 *
 * 口径（与交易预览、最大可买数量、公司回购完全一致）：
 *  - 在售股份   = 做市商当前愿意出售的真实库存 = floor(做市库存 × 愿售比例)；
 *  - 未在售股份 = 总发行股份 − 在售股份；
 *  - 库存股计入未在售，并单独注明（它不投票、不分红、也不在市场流通）。
 * 玩家与其他股东的持仓**不**默认算成在售。
 */
export interface CompanyDetailView {
  readonly available: boolean;
  readonly companyName: string;
  readonly priceText: string;
  readonly listedText: string;
  /** 发行公司当前经营状态（正常经营 / 危机 / 已清算）；独立标的为「无发行公司」。 */
  readonly statusText: string;
  readonly totalShares: number;
  readonly totalSharesText: string;
  readonly forSaleShares: number;
  readonly forSaleText: string;
  readonly notForSaleShares: number;
  readonly notForSaleText: string;
  readonly treasuryShares: number;
  readonly treasuryText: string;
  /** 饼图用的百分比（0～100，保留两位小数）。 */
  readonly forSalePct: number;
  readonly notForSalePct: number;
  readonly forSalePctText: string;
  readonly notForSalePctText: string;
  readonly forSaleRatioText: string;
  readonly deskInventoryText: string;
  readonly playerSharesText: string;
  readonly note: string;
  /** 证券已终止或公司已清算：不提供交易入口，只显示历史状态。 */
  readonly terminated: boolean;
}

export interface SecuritiesPanelView {
  readonly rows: SecurityRowView[];
  readonly selected: StockCardView | null;
  readonly selectedId: string | null;
  readonly maxBuy: number;
  readonly maxSell: number;
  readonly buyNote: string;
  readonly sellNote: string;
  readonly buyPreview: TradePreviewView | null;
  readonly sellPreview: TradePreviewView | null;
  readonly tickMinutes: number;
  readonly spanText: string;
  readonly nextTickText: string;
  readonly companyNote: string;
  readonly companyDetail: CompanyDetailView;
}

function previewViewOf(
  preview: ReturnType<typeof previewTrade> | null,
): TradePreviewView | null {
  if (!preview || preview.requestedShares <= 0) return null;
  const partial = preview.executableShares > 0 && preview.executableShares < preview.requestedShares;
  const note =
    preview.executableShares <= 0
      ? (preview.reason ?? '当前无法成交')
      : partial
        ? `只能部分成交 ${preview.executableShares} 股（${preview.reason ?? '受限'}）`
        : '数量与价格已确认，可直接提交';
  return {
    requestedShares: preview.requestedShares,
    executableShares: preview.executableShares,
    priceCents: preview.priceCents,
    priceText: formatMoney(preview.priceCents),
    amountText: formatMoney(preview.amountCents),
    impactText: `${(preview.impactPct * 100).toFixed(2)}%`,
    partial,
    note,
  };
}

function statusOf(state: ReadonlyGameState, securityId: string): { statusText: string; detailText: string } {
  const meta = state.securities.meta[securityId];
  if (meta?.terminatedAtMinute !== null && meta?.terminatedAtMinute !== undefined) {
    return { statusText: '已清算 · 终止交易', detailText: '发行公司已关闭，证券终止，持仓不再计市值' };
  }
  const company = meta?.companyId ? state.enterprises.companies[meta.companyId] : null;
  if (!company) return { statusText: '独立标的', detailText: '没有发行公司，仅作为场内交易标的' };
  const book = bookOfCompany(state.equity, company.id);
  const tech = techViewOf(state.technology, company.id);
  const payables =
    company.payrollDue + company.cogsDue + company.marketingDue + company.opexDue + company.supplyDue;
  const products = tech.products.filter((item) => item.releasedAtMinute !== null).length;
  return {
    statusText: STATUS_LABELS[company.status],
    detailText: `产品 ${products} 款 · 应付 ${formatMoney(payables)} · 总股数 ${
      book ? book.totalShares.toLocaleString('en-US') : '—'
    }`,
  };
}

/** 公司详情：总发行 / 在售 / 未在售 / 库存股，供饼图与图例使用。 */
export function companyDetailOf(state: ReadonlyGameState, securityId: string | null): CompanyDetailView {
  const empty: CompanyDetailView = {
    available: false,
    companyName: '—',
    priceText: '—',
    listedText: '未上市',
    statusText: '无发行公司',
    totalShares: 0,
    totalSharesText: '—',
    forSaleShares: 0,
    forSaleText: '—',
    notForSaleShares: 0,
    notForSaleText: '—',
    treasuryShares: 0,
    treasuryText: '—',
    forSalePct: 0,
    notForSalePct: 0,
    forSalePctText: '—',
    notForSalePctText: '—',
    forSaleRatioText: '—',
    deskInventoryText: '—',
    playerSharesText: '—',
    note: '选中一只证券后查看股份供给',
    terminated: false,
  };
  if (!securityId) return empty;
  const meta = state.securities.meta[securityId];
  const market = marketOf(state.securities, securityId);
  const book = state.equity.books[securityId];
  if (!meta || !market || !book) return empty;

  const company = meta.companyId ? state.enterprises.companies[meta.companyId] : null;
  const terminated = meta.terminatedAtMinute !== null || (company ? company.status === 'closed' : false);
  // 总发行、库存股、股东持股都来自股权簿：三者之和必须等于总发行
  const total = book.totalShares;
  const treasury = book.treasuryShares;
  const deskInventory = sharesOf(book, 'market-maker');
  const forSale = forSaleShares(market, deskInventory);
  const notForSale = Math.max(0, total - forSale);
  const ratio = market.forSaleRatio;
  const forSalePct = total > 0 ? (forSale / total) * 100 : 0;
  const notForSalePct = total > 0 ? 100 - forSalePct : 0;

  const noteParts: string[] = [];
  if (terminated) {
    noteParts.push('该证券已终止交易：以下为历史股份结构，不构成可买入口');
  } else if (!book.listed) {
    noteParts.push('未上市：没有公开市场，股份只存在于股权簿');
  } else if (deskInventory <= 0) {
    noteParts.push('做市商库存为 0，需要现有股东先卖出才有可买股份');
  }
  noteParts.push(
    `在售 = 做市库存 ${deskInventory.toLocaleString('en-US')} 股 × 愿售比例 ${(ratio * 100).toFixed(
      1,
    )}%，随时受真实库存约束`,
  );
  noteParts.push('库存股计入未在售：不投票、不分红、不在市场流通');
  if (playerHoldingOf(state, securityId).shares > 0) {
    noteParts.push('你自己的持股属于未在售，不会自动变成卖单');
  }

  return {
    available: true,
    companyName: company?.name ?? meta.name,
    priceText: terminated ? '已终止' : formatMoney(market.price),
    listedText: terminated ? '已清算 · 终止交易' : book.listed ? '已上市' : '未上市',
    statusText: company ? STATUS_LABELS[company.status] : '无发行公司（独立标的）',
    totalShares: total,
    totalSharesText: total.toLocaleString('en-US'),
    forSaleShares: forSale,
    forSaleText: `${forSale.toLocaleString('en-US')} 股`,
    notForSaleShares: notForSale,
    notForSaleText: `${notForSale.toLocaleString('en-US')} 股`,
    treasuryShares: treasury,
    treasuryText: `${treasury.toLocaleString('en-US')} 股`,
    forSalePct,
    notForSalePct,
    forSalePctText: `${forSalePct.toFixed(2)}%`,
    notForSalePctText: `${notForSalePct.toFixed(2)}%`,
    forSaleRatioText: `${(ratio * 100).toFixed(1)}%`,
    deskInventoryText: `${deskInventory.toLocaleString('en-US')} 股`,
    playerSharesText: `${playerHoldingOf(state, securityId).shares.toLocaleString('en-US')} 股`,
    note: noteParts.join('；'),
    terminated,
  };
}

export function buildSecuritiesPanel(
  state: ReadonlyGameState,
  selectedId: string | null,
  order: SecuritiesOrderQuery = {},
): SecuritiesPanelView {
  const ids = Object.keys(state.securities.markets).sort();
  const effectiveSelected = selectedId && state.securities.markets[selectedId] ? selectedId : (ids[0] ?? null);

  const rows: SecurityRowView[] = ids.map((id) => {
    const meta = state.securities.meta[id]!;
    const market = state.securities.markets[id]!;
    const holding = playerHoldingOf(state, id);
    const { change, pct } = priceChangeOf(market);
    const info = statusOf(state, id);
    return {
      id,
      symbol: meta.symbol,
      name: meta.name,
      priceText: formatMoney(market.price),
      changePctText: `${pct >= 0 ? '+' : '−'}${(Math.abs(pct) * 100).toFixed(2)}%`,
      direction: directionOf(change),
      holdingText: holding.shares > 0 ? `${holding.shares} 股` : '—',
      statusText: info.statusText,
      detailText: info.detailText,
      selected: id === effectiveSelected,
    };
  });

  const selected = effectiveSelected ? cardOf(state, effectiveSelected) : null;
  const market = effectiveSelected ? marketOf(state.securities, effectiveSelected) : null;
  const buyPreview = effectiveSelected
    ? previewTrade(state, effectiveSelected, 'buy', LIQUIDITY_RULES.maxOrderShares)
    : null;
  const holding = effectiveSelected ? playerHoldingOf(state, effectiveSelected) : null;
  const sellPreview = effectiveSelected
    ? previewTrade(state, effectiveSelected, 'sell', Math.max(1, holding?.shares ?? 1))
    : null;

  // 针对玩家实际输入的数量做一次预览：数量、成交均价、总额、价格影响、是否只能部分成交
  const orderBuy = effectiveSelected
    ? previewViewOf(
        previewTrade(state, effectiveSelected, 'buy', Math.max(0, Math.trunc(order.buyShares ?? 0))),
      )
    : null;
  const orderSell = effectiveSelected
    ? previewViewOf(
        previewTrade(state, effectiveSelected, 'sell', Math.max(0, Math.trunc(order.sellShares ?? 0))),
      )
    : null;

  const spanMinutes = market ? changeSpanMinutes(market) : 0;
  const meta = effectiveSelected ? state.securities.meta[effectiveSelected] : null;
  const issuer = meta?.companyId ? state.enterprises.companies[meta.companyId] : null;

  return {
    rows,
    selected,
    selectedId: effectiveSelected,
    maxBuy: buyPreview?.executableShares ?? 0,
    maxSell: sellPreview?.executableShares ?? 0,
    buyNote:
      buyPreview && buyPreview.executableShares > 0
        ? `按当前价、冲击成本与做市在售库存，最多可买 ${buyPreview.executableShares} 股（约 ${formatMoney(
            buyPreview.amountCents,
          )}）`
        : (buyPreview?.reason ?? '当前无法买入'),
    sellNote:
      sellPreview && sellPreview.executableShares > 0
        ? `最多可卖 ${sellPreview.executableShares} 股（对手方资金与你的持股共同决定）`
        : (sellPreview?.reason ?? '当前无法卖出'),
    buyPreview: orderBuy,
    sellPreview: orderSell,
    tickMinutes: MARKET_TICK,
    spanText: spanMinutes > 0 ? `较约 ${formatDuration(spanMinutes)} 前` : '暂无足够历史',
    nextTickText: market ? formatGameDate(dateAtMinute(market.nextTickMinute, TIME.calendar)) : '—',
    companyNote: issuer
      ? `发行公司「${issuer.name}」：${STATUS_LABELS[issuer.status]}。二级市场交易不改变公司现金。`
      : '独立标的：没有发行公司，交易不影响任何企业的现金。',
    companyDetail: companyDetailOf(state, effectiveSelected),
  };
}

/** 行情更新间隔（与 features/stock 的 MARKET.tickMinutes 一致）。 */
const MARKET_TICK = 24;

/* ---------------------------------------------------------------- 资本与治理 */

export interface CapTableRow {
  readonly holderId: string;
  readonly label: string;
  readonly sharesText: string;
  readonly ratioText: string;
  readonly votingText: string;
  readonly roleText: string;
  readonly isPlayer: boolean;
}

export interface CapitalCompanyOption {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly selected: boolean;
}

export interface CapitalView {
  readonly hasCompany: boolean;
  readonly companyId: string;
  readonly companyName: string;
  readonly canManage: boolean;
  /** 仍是股东：卖光股份后失去提案与投票权，但保留交易与分红权。 */
  readonly isShareholder: boolean;
  readonly permissionText: string;
  readonly canPropose: boolean;
  readonly ceoHolderId: string;
  readonly companies: CapitalCompanyOption[];
  readonly totalSharesText: string;
  readonly treasuryText: string;
  readonly ceoText: string;
  readonly playerRatioText: string;
  readonly playerVotingText: string;
  readonly controlText: string;
  readonly capTable: CapTableRow[];
  readonly listed: boolean;
  readonly listingText: string;
  readonly canList: boolean;
  readonly securityId: string | null;
  readonly priceText: string;
  readonly fairValueText: string;
  readonly perShareValueText: string;
  readonly financingStatusText: string;
  readonly financingRequestedText: string;
  readonly respondInText: string;
  readonly quotes: QuoteRow[];
  readonly cooldownText: string;
  readonly investors: InvestorRow[];
  readonly promotionText: string;
  readonly promotionActive: boolean;
  readonly dividendPoolText: string;
  readonly cashText: string;
  readonly payablesText: string;
  /** 参考上限：输入前展示「最多可回购多少」，不代替本次预览。 */
  readonly buybackMaxText: string;
  readonly buybackNote: string;
  /** 本次预览：严格按玩家输入的股数计算，未输入时为 0 / 空。 */
  readonly buybackRequestShares: number;
  readonly buybackPreviewExecutable: number;
  readonly buybackPreviewPrice: number;
  readonly buybackPreviewPriceText: string;
  readonly buybackPreviewAmountText: string;
  readonly buybackPreviewImpactText: string;
  readonly buybackPreviewNote: string;
  readonly buybackPreviewText: string;
  readonly proposals: ProposalRow[];
  readonly openProposalText: string;
  readonly passiveHoldings: PassiveHoldingRow[];
  readonly limits: {
    readonly minRequestText: string;
    readonly maxRequestText: string;
    readonly minPromotionText: string;
    readonly maxPromotionText: string;
    readonly failRateText: string;
    readonly profitMultiple: number;
    readonly pullPct: string;
    readonly maxOrderSharesText: string;
    readonly voteWindowDays: number;
  };
}

export interface QuoteRow {
  readonly quoteId: string;
  readonly investorName: string;
  readonly amountText: string;
  readonly sharesText: string;
  readonly priceText: string;
  readonly preMoneyText: string;
  readonly postMoneyText: string;
  readonly investorRatioText: string;
  readonly playerRatioText: string;
  readonly votingText: string;
  readonly expiresText: string;
  readonly losesControl: boolean;
}

export interface InvestorRow {
  readonly id: string;
  readonly name: string;
  readonly note: string;
  readonly availableText: string;
}

export interface ProposalRow {
  readonly id: string;
  readonly title: string;
  readonly resultText: string;
  readonly note: string;
  readonly originText: string;
  readonly deadlineText: string;
  readonly open: boolean;
  readonly canVote: boolean;
  readonly playerVoteText: string;
}

export interface PassiveHoldingRow {
  readonly companyName: string;
  readonly ratioText: string;
  readonly valueText: string;
  readonly note: string;
}

function holderLabel(holderId: string): string {
  if (holderId === 'player') return '你';
  if (holderId === 'market-maker') return '做市商';
  if (holderId.startsWith('inv:')) return investorName(holderId.slice(4));
  if (holderId.startsWith('ai:')) return 'AI 创始股东';
  return holderId;
}

function capTableOf(book: ShareBook | ReadonlyShareBook): CapTableRow[] {
  const base = Math.max(1, book.totalShares - book.treasuryShares);
  const rows: CapTableRow[] = Object.entries(book.holdings)
    .filter(([, shares]) => shares > 0)
    .sort((left, right) => right[1] - left[1])
    .map(([holderId, shares]) => ({
      holderId,
      label: holderLabel(holderId),
      sharesText: shares.toLocaleString('en-US'),
      ratioText: `${((shares / Math.max(1, book.totalShares)) * 100).toFixed(2)}%`,
      votingText: `${((shares / base) * 100).toFixed(2)}%`,
      roleText: book.ceoId === holderId ? 'CEO' : holderId === 'market-maker' ? '做市' : '股东',
      isPlayer: holderId === 'player',
    }));
  if (book.treasuryShares > 0) {
    rows.push({
      holderId: 'treasury',
      label: '库存股',
      sharesText: book.treasuryShares.toLocaleString('en-US'),
      ratioText: `${((book.treasuryShares / Math.max(1, book.totalShares)) * 100).toFixed(2)}%`,
      votingText: '无表决权',
      roleText: '不分红不投票',
      isPlayer: false,
    });
  }
  return rows;
}

/**
 * 公司管理的资本与治理视图。
 *
 * `selectedCompanyId` 是界面当前选择（只存在内存里）；没有任何选择时退回
 * 「玩家管理的公司」，再退回「玩家持股的第一家」。三者是不同概念，不能混用：
 *  - 持股 → 股东权（提案/投票）；
 *  - CEO → 管理权（经营/资本命令）；
 *  - 界面选择 → 你正在看的公司。
 */
export function buildCapitalView(
  state: ReadonlyGameState,
  selectedCompanyId?: string | null,
  buybackShares = 0,
): CapitalView {
  const managed = managedCompany(state);
  const companies = capitalCompanyOptions(state, managed?.id ?? null, selectedCompanyId ?? null);
  const selected =
    (selectedCompanyId ? state.enterprises.companies[selectedCompanyId] : null) ??
    managed ??
    playerCompanies(state).find((item) => item.status !== 'closed') ??
    null;
  const held = selected && selected.status !== 'closed' ? selected : null;
  const book = held ? bookOfCompany(state.equity, held.id) : null;

  const empty: CapitalView = {
    hasCompany: false,
    companyId: '',
    companyName: '',
    canManage: false,
    isShareholder: false,
    permissionText: '你不是任何公司的 CEO：可以买卖股份，但不能改变公司经营',
    canPropose: false,
    ceoHolderId: '',
    companies,
    totalSharesText: '—',
    treasuryText: '—',
    ceoText: '—',
    playerRatioText: '—',
    playerVotingText: '—',
    controlText: '—',
    capTable: [],
    listed: false,
    listingText: '先完成一轮外部股权融资，才能申请上市',
    canList: false,
    securityId: null,
    priceText: '—',
    fairValueText: '—',
    perShareValueText: '—',
    financingStatusText: '无进行中的申请',
    financingRequestedText: '—',
    respondInText: '—',
    quotes: [],
    cooldownText: '',
    investors: investorProfiles().map((investor) => ({
      id: investor.id,
      name: investor.name,
      note: investor.note,
      availableText: formatMoney(investorAvailable(state, investor.id)),
    })),
    promotionText: '尚未进行过宣传',
    promotionActive: false,
    dividendPoolText: '—',
    cashText: '—',
    payablesText: '—',
    buybackMaxText: '—',
    buybackNote: '未上市公司没有可回购的市场股份',
    buybackRequestShares: 0,
    buybackPreviewExecutable: 0,
    buybackPreviewPrice: 0,
    buybackPreviewPriceText: '—',
    buybackPreviewAmountText: '—',
    buybackPreviewImpactText: '—',
    buybackPreviewNote: '输入股数后显示本次回购预览',
    buybackPreviewText: '输入股数后显示本次回购预览',
    proposals: [],
    openProposalText: '',
    passiveHoldings: passiveOf(state),
    limits: limitsOf(),
  };

  if (!held || !book) return empty;

  const control = controlSummaryOf(state, held);
  const listing = listingReadinessOf(state, held);
  const application = applicationViewOf(state, held);
  const market = book.securityId ? marketOf(state.securities, book.securityId) : null;
  const fair = fairValueCents(state, held);
  const perShare = fairPriceOf(state, held);
  const promotion = promotionOf(state, held.id);
  const payables =
    held.payrollDue + held.cogsDue + held.marketingDue + held.opexDue + held.supplyDue;

  const quotes: QuoteRow[] = (application?.quotes ?? []).map((quote) => ({
    quoteId: quote.quoteId,
    investorName: quote.investorName,
    amountText: formatMoney(quote.amountCents),
    sharesText: quote.shares.toLocaleString('en-US'),
    priceText: formatMoney(quote.pricePerShareCents),
    preMoneyText: formatMoney(quote.preMoneyCents),
    postMoneyText: formatMoney(quote.postMoneyCents),
    investorRatioText: `${(quote.investorRatio * 100).toFixed(2)}%`,
    playerRatioText: `${(quote.postRatio * 100).toFixed(2)}%`,
    votingText: `${(quote.postVoting * 100).toFixed(2)}%`,
    expiresText: formatGameDate(dateAtMinute(quote.expiresAtMinute, TIME.calendar)),
    losesControl: quote.losesControl,
  }));

  const financedAt = book.rounds[book.rounds.length - 1]?.atMinute ?? null;
  const financingStatusText = application
    ? application.status === 'pending'
      ? `已提交，等待投资者回应（${formatGameDate(dateAtMinute(application.respondAtMinute, TIME.calendar))}）`
      : application.status === 'quoted'
        ? `收到 ${quotes.length} 份报价`
        : application.status === 'accepted'
          ? '本轮融资已完成'
          : application.status === 'expired'
            ? '本轮报价已过期'
            : '本轮没有报价'
    : book.listed
      ? '已上市：可发起新一轮增发'
      : financedAt !== null
        ? '已完成外部融资，具备上市资格'
        : book.historyNote ?? '尚未进行外部股权融资';

  // 参考上限：用「单笔上限」求出最多能回购多少，只作提示，不代替本次预览
  const buyback = previewBuyback(state, held.id, LIQUIDITY_RULES.maxOrderShares);
  // 本次预览：严格按玩家输入的股数计算，界面确认的就是这一次的数量与均价
  const requestedBuyback =
    Number.isSafeInteger(buybackShares) && buybackShares > 0 ? buybackShares : 0;
  const buybackPreview =
    requestedBuyback > 0 ? previewBuyback(state, held.id, requestedBuyback) : null;
  const openProposal = proposalsOf(state.governance, held.id).find(
    (proposal) => proposal.status === 'open',
  );

  return {
    hasCompany: true,
    companyId: held.id,
    companyName: held.name,
    canManage: control.isCeo,
    isShareholder: control.isShareholder,
    permissionText: control.isCeo
      ? '你是现任 CEO，可以改变经营与资本'
      : control.isShareholder
        ? '你不是 CEO：仍可以买卖股份、提出任免提案并投票，但不能改变经营'
        : '你已不持有该公司股份：只剩交易与分红权，不能提案或投票',
    canPropose: control.isShareholder,
    ceoHolderId: book.ceoId ?? '',
    companies,
    totalSharesText: book.totalShares.toLocaleString('en-US'),
    treasuryText: `${book.treasuryShares.toLocaleString('en-US')} 股`,
    ceoText: book.ceoId ? holderLabel(book.ceoId) : '空缺（由 AI 代管经营）',
    playerRatioText: `${(control.ratio * 100).toFixed(2)}%`,
    playerVotingText: `${(control.voting * 100).toFixed(2)}%`,
    controlText: control.isMajority
      ? '拥有多数表决权'
      : control.isCeo
        ? '未过半：普通提案可能被其他股东否决'
        : control.isShareholder
          ? '未过半，且不是 CEO'
          : '无表决权（已不持股）',
    capTable: capTableOf(book),
    listed: book.listed,
    listingText: listing.reason,
    canList: listing.canList && control.isCeo,
    securityId: book.securityId,
    priceText: market ? formatMoney(market.price) : '未上市',
    fairValueText: formatMoney(fair),
    perShareValueText: formatMoney(perShare),
    financingStatusText,
    financingRequestedText: application ? formatMoney(application.requestedCents) : '—',
    respondInText: application
      ? `${Math.max(0, Math.ceil((application.respondAtMinute - state.clock.totalMinute) / 1440))} 个游戏日`
      : '—',
    quotes,
    cooldownText:
      application?.cooldownMinutes && application.cooldownMinutes > 0
        ? `再申请还需 ${Math.ceil(application.cooldownMinutes / 1440)} 个游戏日`
        : '',
    investors: investorProfiles().map((investor) => ({
      id: investor.id,
      name: investor.name,
      note: investor.note,
      availableText: formatMoney(investorAvailable(state, investor.id)),
    })),
    promotionText: promotion
      ? promotion.active
        ? `宣传生效中，剩余 ${Math.max(0, Math.ceil((promotion.expireMinute - state.clock.totalMinute) / 1440))} 个游戏日`
        : promotion.lastOutcome === 'success'
          ? '上次宣传已结束'
          : promotion.lastOutcome === 'failure'
            ? '上次宣传失败（费用已支付）'
            : '尚未进行过宣传'
      : '尚未进行过宣传',
    promotionActive: promotion?.active ?? false,
    dividendPoolText: formatMoney(Math.max(0, (state.finance.businessAccounts[held.id] ?? 0) - payables)),
    cashText: formatMoney(state.finance.businessAccounts[held.id] ?? 0),
    payablesText: formatMoney(payables),
    buybackMaxText:
      buyback.executableShares > 0
        ? `${buyback.executableShares.toLocaleString('en-US')} 股（约 ${formatMoney(buyback.amountCents)}）`
        : '—',
    buybackNote:
      buyback.executableShares > 0
        ? `可执行上限：${buyback.executableShares.toLocaleString('en-US')} 股 · 均价约 ${formatMoney(
            buyback.priceCents,
          )} · 总额约 ${formatMoney(buyback.amountCents)} · 市场影响 ${(
            buyback.impactPct * 100
          ).toFixed(2)}%；受公司现金、做市库存与技术单笔上限（${LIQUIDITY_RULES.maxOrderShares.toLocaleString(
            'en-US',
          )} 股）约束，超出会直接拒绝而不是缩量`
        : (buyback.reason ?? '当前无法回购'),
    buybackRequestShares: requestedBuyback,
    buybackPreviewExecutable: buybackPreview?.executableShares ?? 0,
    buybackPreviewPrice: buybackPreview?.executableShares ? buybackPreview.priceCents : 0,
    buybackPreviewPriceText:
      buybackPreview && buybackPreview.executableShares > 0
        ? formatMoney(buybackPreview.priceCents)
        : '—',
    buybackPreviewAmountText:
      buybackPreview && buybackPreview.executableShares > 0
        ? formatMoney(buybackPreview.amountCents)
        : '—',
    buybackPreviewImpactText:
      buybackPreview && buybackPreview.executableShares > 0
        ? `${(buybackPreview.impactPct * 100).toFixed(2)}%`
        : '—',
    buybackPreviewNote: buybackPreviewNoteOf(buybackPreview),
    buybackPreviewText: buybackPreviewTextOf(buybackPreview),
    proposals: proposalsOf(state.governance, held.id)
      .slice(-6)
      .reverse()
      .map((proposal) => ({
        id: proposal.id,
        title:
          proposal.kind === 'appoint-ceo'
            ? `任命 ${holderLabel(proposal.targetHolderId)} 为 CEO`
            : `罢免 ${holderLabel(proposal.targetHolderId)} 的 CEO 职位`,
        resultText:
          proposal.status === 'passed' ? '通过' : proposal.status === 'rejected' ? '未通过' : '进行中',
        note: proposal.note,
        originText: proposal.origin === 'player' ? '你提出' : `${holderLabel(proposal.proposedBy)} 提出`,
        deadlineText:
          proposal.deadlineMinute !== null
            ? `${formatGameDate(dateAtMinute(proposal.deadlineMinute, TIME.calendar))} 截止`
            : '提交即表决',
        open: proposal.status === 'open',
        canVote: proposal.status === 'open' && proposal.origin === 'shareholder',
        playerVoteText:
          proposal.playerVote === 'yes'
            ? '你已投赞成'
            : proposal.playerVote === 'no'
              ? '你已投反对'
              : proposal.playerVote === 'abstain'
                ? '你已投弃权'
                : proposal.origin === 'player'
                  ? '你默认赞成'
                  : '你尚未投票（按弃权计）',
      })),
    openProposalText: openProposal
      ? `已有未决提案：${openProposal.kind === 'appoint-ceo' ? '任命' : '罢免'} ${holderLabel(
          openProposal.targetHolderId,
        )}；一家公司同时最多一个未决任免提案`
      : '',
    passiveHoldings: passiveOf(state),
    limits: limitsOf(),
  };
}

/**
 * 本次回购预览的说明：请求量、实际可成交量、均价、总额、价格影响与不可执行原因。
 * 部分可执行时明确写出「不会自动缩量」，让玩家先确认新数量。
 */
function buybackPreviewNoteOf(preview: BuybackPreviewLike | null): string {
  if (!preview) return '输入股数后显示本次回购预览';
  if (preview.executableShares <= 0) return preview.reason ?? '当前无法回购';
  if (preview.executableShares < preview.requestedShares) {
    return `请求 ${preview.requestedShares.toLocaleString('en-US')} 股，只能成交 ${preview.executableShares.toLocaleString(
      'en-US',
    )} 股：${preview.reason ?? '数量受限'}。不会自动缩量，请确认新的数量`;
  }
  return '数量与价格已确认，可提交回购';
}

function buybackPreviewTextOf(preview: BuybackPreviewLike | null): string {
  if (!preview) return '输入股数后显示本次回购预览';
  if (preview.executableShares <= 0) return preview.reason ?? '当前无法回购';
  const parts = [
    `请求 ${preview.requestedShares.toLocaleString('en-US')} 股`,
    `可成交 ${preview.executableShares.toLocaleString('en-US')} 股`,
    `均价 ${formatMoney(preview.priceCents)}`,
    `总额 ${formatMoney(preview.amountCents)}`,
    `价格影响 ${(preview.impactPct * 100).toFixed(2)}%`,
  ];
  if (preview.executableShares < preview.requestedShares) parts.push('只能部分成交，不会自动缩量');
  return parts.join(' · ');
}

interface BuybackPreviewLike {
  readonly requestedShares: number;
  readonly executableShares: number;
  readonly priceCents: number;
  readonly amountCents: number;
  readonly impactPct: number;
  readonly reason: string | null;
}

/** 资本子页的公司选择项：管理中的、持股的都列出来，顺序稳定。 */
function capitalCompanyOptions(
  state: ReadonlyGameState,
  managedId: string | null,
  selectedId: string | null,
): CapitalCompanyOption[] {
  const rows: CapitalCompanyOption[] = [];
  const seen = new Set<string>();
  const sorted = [...Object.values(state.enterprises.companies)].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  for (const company of sorted) {
    if (company.status === 'closed') continue;
    const book = bookOfCompany(state.equity, company.id);
    if (!book) continue;
    const holds = sharesOf(book, 'player') > 0;
    const isManaged = book.ceoId === 'player';
    if (!holds && !isManaged) continue;
    if (seen.has(company.id)) continue;
    seen.add(company.id);
    const label = isManaged && holds ? '管理 + 持股' : isManaged ? '仅管理' : '仅持股';
    rows.push({
      id: company.id,
      name: company.name,
      label,
      selected: selectedId !== null ? company.id === selectedId : company.id === managedId,
    });
  }
  return rows;
}

function limitsOf(): CapitalView['limits'] {
  return {
    minRequestText: formatMoney(FINANCING_RULES.minRequestCents),
    maxRequestText: formatMoney(FINANCING_RULES.maxRequestCents),
    minPromotionText: formatMoney(PROMOTION_RULES.minCents),
    maxPromotionText: formatMoney(PROMOTION_RULES.maxCents),
    failRateText: `${Math.round(PROMOTION_RULES.failRate * 100)}%`,
    profitMultiple: VALUATION_RULES.profitMultiple,
    pullPct: `${(VALUATION_RULES.pullPerTick * 100).toFixed(0)}%`,
    maxOrderSharesText: `${LIQUIDITY_RULES.maxOrderShares.toLocaleString('en-US')} 股`,
    voteWindowDays: GOVERNANCE_RULES.voteWindowDays,
  };
}

/** 玩家只持股、不管理的公司（含已上市公司），用于提示「你还持有什么」。 */
function passiveOf(state: ReadonlyGameState): PassiveHoldingRow[] {
  const rows: PassiveHoldingRow[] = [];
  for (const company of playerCompanies(state)) {
    const book = bookOfCompany(state.equity, company.id);
    if (!book) continue;
    const shares = sharesOf(book, 'player');
    const ratio = shares / Math.max(1, book.totalShares);
    if (book.ceoId === 'player') continue;
    rows.push({
      companyName: company.name,
      ratioText: `${(ratio * 100).toFixed(2)}%`,
      // 证券终止（清算）后按统一口径计 0，不再沿用最后成交价
      valueText:
        book.listed && book.securityId
          ? formatMoney(securityValueOf(state, book.securityId))
          : formatMoney(0),
      note: book.listed
        ? '已上市，按市价计入证券市值'
        : '未上市，按持股比例计入账面权益（不可立即变现）',
    });
  }
  return rows;
}

/** 供个人界面「企业账面权益」使用：未上市股权 + 库存股说明。 */
export function unlistedEquityText(state: ReadonlyGameState): string {
  return formatMoney(unlistedEquity(state));
}

/** 股东人数与股数合计，供校验与界面。 */
export function equitySummaryOf(state: ReadonlyGameState, companyId: string): {
  holders: number;
  shares: number;
} {
  const book = bookOfCompany(state.equity, companyId);
  if (!book) return { holders: 0, shares: 0 };
  return { holders: Object.keys(book.holdings).length, shares: holdingsTotal(book) };
}

/** 投票权比例（供个人界面展示控制权）。 */
export function votingOf(state: ReadonlyGameState, companyId: string): number {
  const book = bookOfCompany(state.equity, companyId);
  return book ? votingPower(book, 'player') : 0;
}

/** 兼容导出：人物界面需要按证券取卡片。 */
export { cardOf as buildStockCard };

/** 常量导出，避免界面散落数字。 */
export const SHARE_LIMITS = {
  maxOrderShares: LIQUIDITY_RULES.maxOrderShares,
  maxImpactPct: LIQUIDITY_RULES.maxImpactPct,
} as const;
