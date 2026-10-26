/**
 * 资本查询 —— 只读视图与预览，不修改正式状态。
 *
 * 这里的函数全部接受只读状态（ReadonlyGameState）：
 * 融资展示、上市条件、控制权摘要、宣传摘要、投资者可用资金与回购预览。
 * 不处理 DOM、不发通知、不提交，也不依赖玩家命令或 AI 模拟。
 */

import type { DeepReadonly } from '../core/readonly';
import { EQUITY_RULES, LIQUIDITY_RULES, VALUATION_RULES } from '../content/capital';
import { bookOfCompany, sharesOf, votingPower } from '../features/equity';
import { isClosed, payablesOf, type Enterprise } from '../features/enterprise';
import { availableSubjectBalance, subjectBalance } from '../features/finance';
import {
  activeApplication,
  cooldownRemaining,
  type FinancingApplication,
} from '../features/financing';
import { type ProposalKind } from '../features/governance';
import { investorHolderId, investorProfiles } from '../features/investors';
import { recordOf } from '../features/promotion';
import { techViewOf } from '../features/technology';
import { forSaleShares, marketOf } from '../features/stock';
import {
  DESK_ACCOUNT_ID,
  MARKET_MAKER_HOLDER,
  executionPrice,
  impactOfShares,
  maxSharesWithinBudget,
} from './securities-settlement';
import { managedCompanies, type ReadonlyGameState } from './state';

export interface QuoteView {
  readonly quoteId: string;
  readonly investorId: string;
  readonly investorName: string;
  readonly amountCents: number;
  readonly shares: number;
  readonly pricePerShareCents: number;
  readonly preMoneyCents: number;
  readonly postMoneyCents: number;
  /** 融资后玩家持股比例与表决权。 */
  readonly postRatio: number;
  readonly postVoting: number;
  /** 融资后投资者持股比例。 */
  readonly investorRatio: number;
  readonly losesControl: boolean;
  readonly expiresAtMinute: number;
}


/* ------------------------------------------------------------ 回购 */

export interface BuybackPreview {
  readonly companyId: string;
  readonly requestedShares: number;
  /** 实际可成交股数（不会超过请求量、做市库存、现金与单笔上限）。 */
  readonly executableShares: number;
  /** 含冲击的成交均价（分/股）。 */
  readonly priceCents: number;
  readonly amountCents: number;
  readonly impactPct: number;
  /** 无法成交或只能部分成交时的说明。 */
  readonly reason: string | null;
}

/**
 * 回购预览。公司现金用**实际可用现金**，不额外扣除应付作为储备门槛，
 * 也不增加盈利、无欠薪或董事会审批要求；技术单笔上限只作为明确的硬约束展示。
 */
export function previewBuyback(
  state: ReadonlyGameState,
  companyId: string,
  requestedShares: number,
): BuybackPreview {
  const base = (reason: string): BuybackPreview => ({
    companyId,
    requestedShares,
    executableShares: 0,
    priceCents: marketOf(state.securities, bookOfCompany(state.equity, companyId)?.securityId ?? '')?.price ?? 0,
    amountCents: 0,
    impactPct: 0,
    reason,
  });

  const company = state.enterprises.companies[companyId];
  if (!company) return base('公司不存在');
  if (isClosed(company)) return base('公司已清算');
  const book = bookOfCompany(state.equity, companyId);
  if (!book) return base('公司没有股权簿');
  if (!book.listed) return base('未上市公司没有可回购的市场股份');
  if (!Number.isSafeInteger(requestedShares) || requestedShares <= 0) {
    return base('请输入正整数股数');
  }
  const market = marketOf(state.securities, book.securityId);
  if (!market) return base('该证券没有行情');

  const deskShares = sharesOf(book, MARKET_MAKER_HOLDER);
  // 只有做市商挂出来卖的那部分库存才是可回购的「市场股份」，
  // 与证券交易预览、最大可买数量、公司详情饼图使用同一份口径。
  const deskForSale = forSaleShares(market, deskShares);
  const cash = state.finance.businessAccounts[companyId] ?? 0;
  // 请求量、在售库存与技术单笔上限一起构成求解区间；库存股不参与回购（它已经是公司自己的股份）
  const executable = maxSharesWithinBudget(
    market.price,
    cash,
    'buy',
    Math.min(requestedShares, deskForSale, LIQUIDITY_RULES.maxOrderShares),
  );

  if (executable <= 0) {
    if (deskForSale <= 0) {
      return base(
        deskShares <= 0
          ? '市场上没有可回购的股份（做市商库存为空）'
          : '做市商当前没有挂出可卖股份（库存在手但未在售）',
      );
    }
    if (cash <= 0) return base('公司可用现金为 0，无法回购');
    return base('公司现金不足以按含冲击价格回购，请减少股数');
  }

  const price = executionPrice(market.price, executable, 'buy');
  return {
    companyId,
    requestedShares,
    executableShares: executable,
    priceCents: price,
    amountCents: price * executable,
    // 与二级市场买卖共用同一个冲击公式，避免回购和交易各算一套
    impactPct: impactOfShares(executable),
    reason:
      executable < requestedShares
        ? `受库存、现金或单笔上限限制，最多可回购 ${executable} 股`
        : null,
  };
}

/**
 * 执行回购 —— 玩家与 AI 共用。
 * 资金、股份（转入库存股）、回购记录与价格影响整体提交；总发行股数不变。
 */

export function voteContextOf(state: ReadonlyGameState, company: Enterprise) {
  const last = company.reports[company.reports.length - 1] ?? null;
  const accrual = company.accrual;
  const current =
    accrual.revenue - accrual.cogs - accrual.wages - accrual.research - accrual.marketing - accrual.opex;
  const profitable = (last?.profit ?? 0) > 0 || current > 0;
  const tech = techViewOf(state.technology, company.id);
  return {
    profitable,
    payablesPressure: payablesOf(company) > 0,
    techLevel: tech.accumulation,
  };
}




/** 界面用：当前融资申请的可读快照。 */
export function applicationViewOf(
  state: ReadonlyGameState,
  company: Enterprise | DeepReadonly<Enterprise>,
): {
  status: FinancingApplication['status'];
  requestedCents: number;
  respondAtMinute: number;
  quotes: QuoteView[];
  acceptedQuoteId: string | null;
  cooldownMinutes: number;
} | null {
  const application = activeApplication(state.financing, company.id);
  if (!application) {
    return null;
  }
  const book = bookOfCompany(state.equity, company.id);
  return {
    status: application.status,
    requestedCents: application.requestedCents,
    respondAtMinute: application.respondAtMinute,
    acceptedQuoteId: application.acceptedQuoteId,
    cooldownMinutes: cooldownRemaining(state.financing, company.id, state.clock.totalMinute),
    quotes: application.quotes.map((quote) => {
      const playerLine = quote.postHoldings.find((item) => item.holderId === 'player');
      const investorLine = quote.postHoldings.find(
        (item) => item.holderId === investorHolderId(quote.investorId),
      );
      return {
        quoteId: quote.id,
        investorId: quote.investorId,
        investorName:
          investorProfiles().find((item) => item.id === quote.investorId)?.name ?? quote.investorId,
        amountCents: quote.amountCents,
        shares: quote.shares,
        pricePerShareCents: quote.pricePerShareCents,
        preMoneyCents: quote.preMoneyCents,
        postMoneyCents: quote.postMoneyCents,
        postRatio:
          playerLine?.ratio ??
          (book ? sharesOf(book, 'player') / Math.max(1, book.totalShares) : 0),
        postVoting: playerLine?.voting ?? 0,
        investorRatio: investorLine?.ratio ?? 0,
        losesControl: (playerLine?.voting ?? 0) <= EQUITY_RULES.controlThreshold,
        expiresAtMinute: quote.expiresAtMinute,
      };
    }),
  };
}

/** 上市门槛与提示，供视图与界面复用。 */
export function listingReadinessOf(
  state: ReadonlyGameState,
  company: Enterprise | DeepReadonly<Enterprise>,
): { canList: boolean; reason: string } {
  const book = bookOfCompany(state.equity, company.id);
  if (!book) return { canList: false, reason: '公司没有股权簿' };
  if (book.listed) return { canList: false, reason: '公司已经上市' };
  if (!book.hasExternalFinancing) {
    return { canList: false, reason: '上市前需要先完成一轮外部股权融资' };
  }
  return { canList: true, reason: '已具备上市资格：融资记录真实存在，上市不改变公司现金' };
}

/** 当前控制权摘要。 */
export function controlSummaryOf(
  state: ReadonlyGameState,
  company: Enterprise | DeepReadonly<Enterprise>,
): { ratio: number; voting: number; isCeo: boolean; isMajority: boolean; isShareholder: boolean } {
  const book = bookOfCompany(state.equity, company.id);
  if (!book) return { ratio: 0, voting: 0, isCeo: false, isMajority: false, isShareholder: false };
  const shares = sharesOf(book, 'player');
  const ratio = shares / Math.max(1, book.totalShares);
  const voting = votingPower(book, 'player');
  return {
    ratio,
    voting,
    isCeo: book.ceoId === 'player',
    isMajority: voting > EQUITY_RULES.controlThreshold,
    isShareholder: shares > 0,
  };
}

/** 某投资者可用（未预留）资金，供界面展示。 */
export function investorAvailable(state: ReadonlyGameState, investorId: string): number {
  return availableSubjectBalance(state.finance, 'investor', investorId);
}

/** 某公司的宣传记录摘要。 */
export function promotionOf(state: ReadonlyGameState, companyId: string) {
  return recordOf(state.promotion, companyId);
}

/** 估值参数集中说明，避免界面散落数字。 */
export const CAPITAL_TUNING = {
  profitMultiple: VALUATION_RULES.profitMultiple,
  pullPerTick: VALUATION_RULES.pullPerTick,
  maxTickChangePct: VALUATION_RULES.maxTickChangePct,
} as const;

/** 便利：当前价。 */
export function currentPrice(state: ReadonlyGameState, securityId: string): number {
  return marketOf(state.securities, securityId)?.price ?? 0;
}

/** 内部工具导出，供结算与视图复用。 */
export { DESK_ACCOUNT_ID, MARKET_MAKER_HOLDER, subjectBalance };

/* ------------------------------------------------------------ 治理辅助 */

/**
 * 任命生效前的额外限制（首轮最多同时管理一家公司）。
 *
 * 只读判断：票数通过也不一定生效，因此命令与 AI 模拟共用这一条规则。
 */
export function effectBlockReason(
  state: ReadonlyGameState,
  company: Enterprise,
  kind: ProposalKind,
  targetHolderId: string,
): string | null {
  if (kind !== 'appoint-ceo' || targetHolderId !== 'player') return null;
  const others = managedCompanies(state).filter((item) => item.id !== company.id);
  if (others.length >= EQUITY_RULES.maxManagedCompanies) {
    return `首轮最多同时管理一家公司，你已管理「${others[0]?.name ?? '另一家公司'}」，本次任命未生效`;
  }
  return null;
}
