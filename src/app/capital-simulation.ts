/**
 * 资本模拟 —— 只在时间推进节点运行的非玩家决策。
 *
 * 融资回应、报价过期与预留释放、到期提案结算、外部股东提案、AI 资本决策。
 * 所有写入都发生在传入的草稿上（调用方已在 store.run 内）。
 */

import { BusinessError } from '../core/errors';
import { dateAtMinute, daySerialAtMinute } from '../core/calendar';
import { FINANCING_RULES, GOVERNANCE_RULES, LIQUIDITY_RULES, PROMOTION_RULES } from '../content/capital';
import { ENTERPRISE_RULES } from '../content/business';
import { TIME } from '../content/config';
import { bookOfCompany, effectiveShares, sharesOf } from '../features/equity';
import { accrue, isClosed, payablesOf, type Enterprise } from '../features/enterprise';
import { availableSubjectBalance, businessAccountRef, releaseFunds, reservedFor, transferFunds } from '../features/finance';
import { activeApplication, attachQuotes, buildQuotes, cooldownRemaining, hasOpenApplication, rejectAll, submitApplication, type FinancingQuote } from '../features/financing';
import { openProposalOf, pushProposal, resolveProposal, type ProposalKind } from '../features/governance';
import { investorProfiles, willingnessOf } from '../features/investors';
import { forSaleShares, marketOf } from '../features/stock';
import { ensureTechCompany } from '../features/technology';
import { isPromotionActive, recordOf, rollPromotion } from '../features/promotion';
import { MARKET_MAKER_HOLDER, fairValueCents, maxSharesWithinBudget } from './securities-settlement';
import { shareholderCompanies, type GameState } from './state';
import {
  acceptFinancingQuote,
  cancelApplication,
  executeBuyback,
  operationId,
  reserveAll,
} from './capital-operations';
import { effectBlockReason, voteContextOf } from './capital-query';

/** 报价在时间上到期后释放预留，避免资金被永久锁住。 */
export function releaseStaleReservations(state: GameState, nowMinute: number): void {
  for (const application of Object.values(state.financing.applications)) {
    if (!application || application.status !== 'quoted') continue;
    const alive = application.quotes.some((quote) => nowMinute <= quote.expiresAtMinute);
    if (alive) continue;
    for (const quote of application.quotes) {
      releaseFunds(state.finance, 'investor', quote.investorId, quote.amountCents, quote.id);
    }
    application.status = 'expired';
    application.decidedAtMinute = nowMinute;
    state.financing.lastDecidedMinute[application.companyId] = nowMinute;
  }
}

/**
 * 到回应时间后生成报价并预留资金。由时间推进调用，打开界面不会触发。
 * 同一份状态与时间只会生成一次报价（状态落盘后不再重算）。
 */
export function processFinancingResponses(state: GameState, nowMinute: number): number {
  let generated = 0;
  for (const application of Object.values(state.financing.applications)) {
    if (!application || application.status !== 'pending') continue;
    if (nowMinute < application.respondAtMinute) continue;

    const company = state.enterprises.companies[application.companyId];
    const book = bookOfCompany(state.equity, application.companyId);
    if (!company || !book || isClosed(company)) {
      cancelApplication(state, application, nowMinute, 'rejected');
      continue;
    }

    const preMoney = Math.max(
      FINANCING_RULES.preMoneyFloorCents,
      fairValueCents(state, company),
    );
    const tech = ensureTechCompany(state.technology, company.id);
    const hasRevenueProduct = tech.products.some(
      (product) => product.releasedAtMinute !== null && product.onSale,
    );

    const candidates = [];
    for (const investor of investorProfiles()) {
      const available = availableSubjectBalance(state.finance, 'investor', investor.id);
      const willingness = willingnessOf(investor, {
        preMoneyCents: preMoney,
        requestedCents: application.requestedCents,
        availableCents: available,
        hasRevenueProduct,
      });
      if (!willingness) continue;
      candidates.push({
        investor,
        amountCents: willingness.amountCents,
        valuationPremium: willingness.valuationPremium,
      });
    }

    const quotes = buildQuotes(book, {
      preMoneyCents: preMoney,
      candidates,
      nowMinute,
      applicationId: application.id,
    });

    // 报价生成后立即预留资金：同一笔钱不能同时保证两份可接受报价。
    // 预留走 finance 接口，并按报价 id 记账，避免不同公司的承诺互相冒充。
    attachQuotes(application, reserveAll(state, quotes));
    generated += 1;
    if (application.quotes.length === 0) {
      application.status = 'rejected';
      application.decidedAtMinute = nowMinute;
      state.financing.lastDecidedMinute[application.companyId] = nowMinute;
    }
  }
  return generated;
}


/* ------------------------------------------------------------ 外部股东提案 */

/**
 * 外部股东提案：在固定游戏时间节点检查一次，满足条件就提出罢免或任命建议。
 *
 * 只使用现有经营结果与持股比例判断，不新建董事人物与派系；
 * 有集中配置的检查周期与提案冷却，一家公司同时最多一个未决任免提案。
 */
export function processShareholderProposals(state: GameState, nowMinute: number): number {
  const date = dateAtMinute(nowMinute, TIME.calendar);
  // 游戏从 08:00 起算，日界并不落在「累计分钟整除 1440」上：
  // 只能按统一日历判断真实游戏日界，否则这个检查永远不会触发。
  if (date.minuteOfDay !== 0) return 0;
  // 日序号同样取自同一份日历（core/calendar.daySerialAtMinute），
  // 与日界一一对应，不另建一套日期体系。
  const dayIndex = daySerialAtMinute(nowMinute, TIME.calendar);
  if (dayIndex % GOVERNANCE_RULES.checkIntervalDays !== 0) return 0;

  let created = 0;
  const companies = shareholderCompanies(state).sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  for (const company of companies) {
    if (isClosed(company)) continue;
    const book = bookOfCompany(state.equity, company.id);
    if (!book) continue;
    if (openProposalOf(state.governance, company.id)) continue;

    const last = state.governance.lastExternalProposalMinute[company.id] ?? null;
    if (
      last !== null &&
      nowMinute < last + GOVERNANCE_RULES.proposalCooldownDays * TIME.calendar.minutesPerDay
    ) {
      continue;
    }

    const base = effectiveShares(book);
    if (base <= 0) continue;
    // 机构股东里持股最多、且达到最低门槛的那一位作为提案人
    let sponsor: string | null = null;
    let sponsorVoting = 0;
    for (const [holderId, shares] of Object.entries(book.holdings)) {
      if (shares <= 0 || !holderId.startsWith('inv:')) continue;
      const voting = shares / base;
      if (voting < GOVERNANCE_RULES.minSponsorStake) continue;
      if (voting > sponsorVoting) {
        sponsor = holderId;
        sponsorVoting = voting;
      }
    }
    if (!sponsor) continue;

    const context = voteContextOf(state, company);
    const unhealthy = !context.profitable || context.payablesPressure || company.status === 'crisis';

    let kind: ProposalKind;
    let target: string;
    if (book.ceoId === 'player') {
      if (!unhealthy) continue;
      kind = 'remove-ceo';
      target = 'player';
    } else {
      // 经营健康但长期没有 CEO（AI 代管）时，达到任命门槛的机构会尝试接管
      if (unhealthy) continue;
      if (sponsorVoting < GOVERNANCE_RULES.minAppointStake) continue;
      if (book.ceoId === sponsor) continue;
      kind = 'appoint-ceo';
      target = sponsor;
    }

    pushProposal(state.governance, {
      companyId: company.id,
      kind,
      targetHolderId: target,
      proposedBy: sponsor,
      origin: 'shareholder',
      nowMinute,
      // 现在就是日界，因此截止时刻同样落在日界上，由同一个检查点结算
      deadlineMinute: nowMinute + GOVERNANCE_RULES.voteWindowDays * TIME.calendar.minutesPerDay,
    });
    created += 1;
  }
  return created;
}

/** 结算到期未决的提案（表决窗口结束，玩家未投票按弃权）。 */
export function resolveDueProposals(state: GameState, nowMinute: number): number {
  let resolved = 0;
  for (const company of Object.values(state.enterprises.companies)) {
    if (isClosed(company)) continue;
    const book = bookOfCompany(state.equity, company.id);
    if (!book) continue;
    const list = state.governance.proposals[company.id] ?? [];
    for (const proposal of list) {
      if (proposal.status !== 'open') continue;
      if (proposal.deadlineMinute === null) continue;
      if (nowMinute < proposal.deadlineMinute) continue;
      resolveProposal(proposal, book, voteContextOf(state, company), nowMinute, {
        allowEffect: (item) => effectBlockReason(state, company, item.kind, item.targetHolderId),
      });
      resolved += 1;
    }
  }
  return resolved;
}


/* ------------------------------------------------------------ AI 资本决策 */

/**
 * AI 资本决策：先处理已有报价（接受或全部拒绝），再考虑新申请与现金使用。
 *
 * 顺序很重要：这一步必须排在该时刻的日结/月结之后、AI 经营决策（可能清算）之前，
 * 否则刚拿到的有效报价会被「先清算」吃掉。
 */
export function runAiCapitalDecisions(state: GameState, nowMinute: number): void {
  for (const company of Object.values(state.enterprises.companies)) {
    if (isClosed(company)) continue;
    const book = bookOfCompany(state.equity, company.id);
    if (!book) continue;
    // 玩家自己在管的公司不做自动决策
    if (book.ceoId === 'player') continue;

    respondToQuotes(state, company, nowMinute);

    const cash = state.finance.businessAccounts[company.id] ?? 0;
    const dailyCost = ENTERPRISE_RULES.operatingCostDailyCents;
    const hasApp = hasOpenApplication(state.financing, company.id);
    const cooldown = cooldownRemaining(state.financing, company.id, nowMinute);

    // 1) 资金紧张：尝试融资（不保证有人投）
    if (!hasApp && cooldown === 0 && (company.status === 'crisis' || cash < dailyCost * 30)) {
      const requested = Math.max(FINANCING_RULES.minRequestCents, dailyCost * 120);
      if (requested <= FINANCING_RULES.maxRequestCents) {
        try {
          submitApplication(state.financing, {
            companyId: company.id,
            requestedCents: requested,
            nowMinute,
          });
        } catch {
          /* 已有申请或冷却中，忽略 */
        }
      }
    }

    // 2) 现金充裕：做一次宣传（30 天冷却，避免每天烧钱）
    const promotion = recordOf(state.promotion, company.id);
    const lastAttempt = promotion?.lastAttemptMinute ?? null;
    const canRetry = lastAttempt === null || nowMinute - lastAttempt >= 30 * 1440;
    if (
      book.listed &&
      canRetry &&
      cash > dailyCost * 200 &&
      !isPromotionActive(state.promotion, company.id, nowMinute)
    ) {
      const budget = Math.min(PROMOTION_RULES.maxCents, Math.floor(cash / 40));
      if (budget >= PROMOTION_RULES.minCents) {
        try {
          transferFunds(state.finance, {
            atMinute: nowMinute,
            monthKey: dateAtMinute(nowMinute, TIME.calendar).monthKey,
            operationId: operationId('ai-promotion'),
            from: businessAccountRef(company.id),
            to: { owner: 'external', id: 'advertiser' },
            amount: budget,
            category: 'equity-promotion',
            memo: '投资者宣传（AI）',
          });
          accrue(company, 'opex', budget);
          rollPromotion(state.promotion, company.id, budget, nowMinute);
        } catch {
          /* 资金不足或状态异常时跳过 */
        }
      }
    }

    // 3) 现金非常充裕：小额回购（与玩家共用同一份执行函数）
    if (book.listed && canRetry && cash > dailyCost * 400) {
      const market = marketOf(state.securities, book.securityId);
      const deskShares = sharesOf(book, MARKET_MAKER_HOLDER);
      if (market && deskShares > 0) {
        // 与玩家回购共用同一份预算求解：区间 = 在售库存、总股本 1%、单笔上限
        const shares = maxSharesWithinBudget(
          market.price,
          Math.floor(cash / 2),
          'buy',
          Math.min(
            forSaleShares(market, deskShares),
            Math.floor(book.totalShares * 0.01),
            LIQUIDITY_RULES.maxOrderShares,
          ),
        );
        if (shares > 0) {
          try {
            executeBuyback(state, {
              companyId: company.id,
              shares,
              atMinute: nowMinute,
              operationPrefix: 'ai-buyback',
            });
          } catch {
            /* 忽略单次失败（库存或现金在计算后变化） */
          }
        }
      }
    }
  }
}

/**
 * AI 对已有报价的处置：按资金缺口、报价金额与稀释程度选一份可兑现的报价，或全部拒绝。
 * 接受后立刻按现有规则偿付应付并判断能否恢复经营。
 */
function respondToQuotes(state: GameState, company: Enterprise, nowMinute: number): void {
  const application = activeApplication(state.financing, company.id);
  if (!application || application.status !== 'quoted') return;
  const usable = application.quotes.filter(
    (quote) =>
      nowMinute <= quote.expiresAtMinute &&
      reservedFor(state.finance, 'investor', quote.investorId, quote.id) >= quote.amountCents,
  );
  if (usable.length === 0) {
    cancelApplication(state, application, nowMinute, 'expired');
    return;
  }

  const cash = state.finance.businessAccounts[company.id] ?? 0;
  const gap = Math.max(
    0,
    payablesOf(company) + ENTERPRISE_RULES.operatingCostDailyCents * 30 - cash,
  );

  const ratioOf = (quote: FinancingQuote): number =>
    quote.shares / Math.max(1, quote.totalSharesAtQuote + quote.shares);

  const viable = usable.filter((quote) => quote.amountCents >= gap);
  const pool = viable.length > 0 ? viable : usable;
  const best = pool.reduce((left, right) =>
    ratioOf(right) === ratioOf(left)
      ? right.amountCents > left.amountCents
        ? right
        : left
      : ratioOf(right) < ratioOf(left)
        ? right
        : left,
  );

  // 缺口较大而所有报价都明显不够时，宁可全部拒绝也不接受一笔无意义的稀释
  if (gap > 0 && best.amountCents * 2 < gap) {
    for (const quote of application.quotes) {
      releaseFunds(state.finance, 'investor', quote.investorId, quote.amountCents, quote.id);
    }
    rejectAll(application, nowMinute);
    state.financing.lastDecidedMinute[company.id] = nowMinute;
    return;
  }

  try {
    acceptFinancingQuote(state, {
      companyId: company.id,
      quoteId: best.id,
      atMinute: nowMinute,
      operationPrefix: 'ai-equity-financing',
    });
  } catch (error) {
    // 只有「报价在核对时失效」才就地作废本轮；其他异常必须让整次推进回滚，
    // 不能把同一份草稿上已经发生的部分改动当成成功继续往下走。
    const staleCodes = ['QUOTE_STALE', 'NO_RESERVATION', 'QUOTE_EXPIRED', 'NO_QUOTE'];
    if (error instanceof BusinessError && staleCodes.includes(error.code)) {
      cancelApplication(state, application, nowMinute, 'expired');
      return;
    }
    throw error;
  }
}
