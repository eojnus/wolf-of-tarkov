/**
 * 资本命令 —— 玩家侧入口：权限校验、通知与自动保存协调。
 *
 * 每个命令都在一次 GameStore 提交内完成；真正的共享写操作在
 * `capital-operations`（玩家与 AI 共用），只读展示在 `capital-query`，
 * 时间驱动的模拟在 `capital-simulation`。
 *
 * 权限：
 *  - 「管理权」= 该公司现任 CEO 是玩家（`managedCompany`），与是否持股无关；
 *  - 「股东权」= 玩家仍持有该公司股份（提案与投票），卖光后只剩交易与分红权。
 */

import { BusinessError, describeError } from '../core/errors';
import { formatMoney } from '../core/money';
import { GameStore } from '../core/store';
import { dateAtMinute } from '../core/calendar';
import { FINANCING_RULES } from '../content/capital';
import { TIME } from '../content/config';
import { bookOfCompany, sharesOf, type ShareBook } from '../features/equity';
import { accrue, isClosed, type Enterprise } from '../features/enterprise';
import { businessAccountRef, releaseFunds, transferFunds } from '../features/finance';
import { activeApplication, cooldownRemaining, hasOpenApplication, rejectAll, submitApplication } from '../features/financing';
import { assertManageLimit, assertProposalValid, findProposal, openProposalOf, pushProposal, resolveProposal, type VoteChoice } from '../features/governance';
import { createMarket, hasSecurity, registerSecurity } from '../features/stock';
import { isPromotionActive, rollPromotion, validateBudget } from '../features/promotion';
import { MARKET_MAKER_HOLDER, distributeDividend, distributableCashOf, fairPriceOf } from './securities-settlement';
import { managedCompanies, managedCompany, shareholderCompanies, type GameState } from './state';
import type { NotifyKind } from './business';
import { processFinancingResponses, releaseStaleReservations } from './capital-simulation';
import { effectBlockReason, previewBuyback, voteContextOf } from './capital-query';
import { acceptFinancingQuote, executeBuyback } from './capital-operations';
import { operationId } from './capital-operations';

export interface CapitalHooks {
  notify(kind: NotifyKind, message: string): void;
  requestAutoSave(): void;
}

export interface CapitalOutcome {
  readonly ok: boolean;
  readonly message: string | null;
}

/* ------------------------------------------------------------ 权限 */

/** 当前玩家管理的公司；没有管理权时给出明确原因。 */
export function requireManagedCompany(state: GameState): Enterprise {
  const company = managedCompany(state);
  if (!company) {
    throw new BusinessError('NO_PERMISSION', '你不是任何公司的现任 CEO，无法执行该操作');
  }
  return company;
}

/** 指定公司的管理权校验（经营命令在 app 层再次核对，不只依赖界面隐藏按钮）。 */
export function requireManagedCompanyById(state: GameState, companyId: string): Enterprise {
  const company = state.enterprises.companies[companyId];
  if (!company) throw new BusinessError('NO_COMPANY', '公司不存在');
  if (isClosed(company)) throw new BusinessError('COMPANY_CLOSED', '公司已清算');
  const book = bookOfCompany(state.equity, companyId);
  if (book?.ceoId !== 'player') {
    throw new BusinessError('NO_PERMISSION', '你不是该公司的现任 CEO，无法执行该操作');
  }
  return company;
}

/**
 * 股东身份校验：提案与投票要求玩家**仍持有股份**。
 * 这与管理权是两件事——被撤职但保留股份仍可投票；卖光股份则只剩交易与分红。
 */
export function requireShareholderPosition(
  state: GameState,
  companyId: string | null,
): { company: Enterprise; book: ShareBook } {
  const company =
    (companyId ? state.enterprises.companies[companyId] : null) ??
    managedCompany(state) ??
    shareholderCompanies(state)[0] ??
    null;
  if (!company) throw new BusinessError('NO_COMPANY', '你没有可以参与治理的公司');
  const book = bookOfCompany(state.equity, company.id);
  if (!book) throw new BusinessError('NO_BOOK', '公司没有股权簿');
  if (sharesOf(book, 'player') <= 0) {
    throw new BusinessError(
      'NOT_A_SHAREHOLDER',
      '你已经不持有该公司股份：不再拥有提案与投票权，但仍可交易并领取分红',
    );
  }
  return { company, book };
}


/* ------------------------------------------------------------ 命令 */

export class CapitalCommands {
  constructor(
    private readonly store: GameStore<GameState>,
    private readonly hooks: CapitalHooks,
  ) {}

  requestFinancing(amountCents: number): CapitalOutcome {
    return this.execute((draft) => {
      const company = requireManagedCompany(draft);
      const book = bookOfCompany(draft.equity, company.id);
      if (!book) throw new BusinessError('NO_BOOK', '公司没有股权簿');
      if (hasOpenApplication(draft.financing, company.id)) {
        throw new BusinessError('APPLICATION_EXISTS', '已经有一份进行中的融资申请');
      }
      const wait = cooldownRemaining(draft.financing, company.id, draft.clock.totalMinute);
      if (wait > 0) {
        throw new BusinessError(
          'COOLDOWN',
          `刚结束一轮融资，还需 ${Math.ceil(wait / 1440)} 个游戏日才能再次申请`,
        );
      }
      submitApplication(draft.financing, {
        companyId: company.id,
        requestedCents: amountCents,
        nowMinute: draft.clock.totalMinute,
      });
      const days = Math.round(FINANCING_RULES.respondDays);
      return `融资申请已提交（期望 ${formatMoney(amountCents)}），投资者将在 ${days} 个游戏日内回应`;
    });
  }

  /** 立刻结算「已经到回应时间」的申请；用于界面上的「让时间走一下」之后。 */
  pollFinancing(): CapitalOutcome {
    return this.execute((draft) => {
      const count = processFinancingResponses(draft, draft.clock.totalMinute);
      releaseStaleReservations(draft, draft.clock.totalMinute);
      if (count === 0) return '目前没有新的报价';
      return '投资者已回应，请查看报价';
    }, false);
  }

  acceptQuote(quoteId: string): CapitalOutcome {
    return this.execute((draft) => {
      // 玩家命令先校验管理权限，再走与 AI 完全相同的接受流程
      const company = requireManagedCompany(draft);
      const result = acceptFinancingQuote(draft, {
        companyId: company.id,
        quoteId,
        atMinute: draft.clock.totalMinute,
        operationPrefix: 'equity-financing',
      });
      const diluted = `你的持股比例 ${(result.playerRatio * 100).toFixed(2)}%，表决权 ${(
        result.playerVoting * 100
      ).toFixed(2)}%`;
      const priceNote =
        result.priceAfter !== null
          ? `；公开市场参考价按加权公式调整为 ${formatMoney(result.priceAfter)}`
          : '';
      return `已完成融资 ${formatMoney(result.quote.amountCents)}，发行 ${
        result.quote.shares
      } 股；${diluted}${priceNote}`;
    }, true);
  }

  rejectQuotes(): CapitalOutcome {
    return this.execute((draft) => {
      const company = requireManagedCompany(draft);
      const application = activeApplication(draft.financing, company.id);
      if (!application || (application.status !== 'quoted' && application.status !== 'pending')) {
        throw new BusinessError('NO_QUOTES', '当前没有可以拒绝的申请');
      }
      for (const quote of application.quotes) {
        releaseFunds(draft.finance, 'investor', quote.investorId, quote.amountCents, quote.id);
      }
      const nowMinute = draft.clock.totalMinute;
      rejectAll(application, nowMinute);
      draft.financing.lastDecidedMinute[company.id] = nowMinute;
      return '已拒绝全部报价，股权与资金都没有变化';
    }, true);
  }

  /* ------------------------------------------------------------ 上市 */

  listCompany(): CapitalOutcome {
    return this.execute((draft) => {
      const company = requireManagedCompany(draft);
      const book = bookOfCompany(draft.equity, company.id);
      if (!book) throw new BusinessError('NO_BOOK', '公司没有股权簿');
      if (book.listed) throw new BusinessError('ALREADY_LISTED', '公司已经上市');
      if (!book.hasExternalFinancing) {
        throw new BusinessError('NEED_FINANCING', '上市前必须完成一轮外部股权融资');
      }
      if (hasSecurity(draft.securities, book.securityId)) {
        throw new BusinessError('SECURITY_EXISTS', '该证券已经存在');
      }

      const issued = Object.keys(draft.securities.meta).filter((id) => id.startsWith('TK-')).length + 1;
      const price = Math.max(1, fairPriceOf(draft, company));
      const nowMinute = draft.clock.totalMinute;
      // 上市本身不注资、不生成无偿股份：做市库存只能来自真实的股份转让
      registerSecurity(
        draft.securities,
        {
          id: book.securityId,
          symbol: `TK-${String(issued).padStart(2, '0')}`,
          name: company.name,
          companyId: company.id,
        },
        createMarket(price, nowMinute, fairSeed(book.securityId)),
      );
      // 把股权簿里玩家的既有持股同步进证券持仓，并保留实缴出资成本；
      // 否则上市瞬间会出现「股权簿有股、证券持仓为零」的矛盾
      const playerShares = sharesOf(book, 'player');
      const holding = draft.securities.holdings[book.securityId];
      if (holding) {
        holding.shares = playerShares;
        holding.totalCost = book.founderContributionCents;
        holding.realizedPnl = 0;
        holding.trades = 0;
        holding.terminatedAtMinute = null;
      }
      book.listed = true;
      book.listedAtMinute = nowMinute;
      const desk = sharesOf(book, MARKET_MAKER_HOLDER);
      const liquidityNote =
        desk > 0
          ? `做市库存 ${desk} 股`
          : '做市库存为 0：需要你（或其他股东）先卖出股份，二级市场才能买入';
      return `「${company.name}」已上市（${book.securityId}），上市本身不改变公司现金；${liquidityNote}`;
    }, true);
  }

  /* ------------------------------------------------------------ 分红 / 回购 / 宣传 */

  payDividend(amountCents: number): CapitalOutcome {
    return this.execute((draft) => {
      const company = requireManagedCompany(draft);
      const book = bookOfCompany(draft.equity, company.id);
      if (!book) throw new BusinessError('NO_BOOK', '公司没有股权簿');
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
        throw new BusinessError('INVALID_AMOUNT', '请输入有效的分红金额');
      }
      const available = distributableCashOf(draft, company);
      if (amountCents > available) {
        throw new BusinessError(
          'NOT_DISTRIBUTABLE',
          `可分配现金只有 ${formatMoney(available)}（需先扣除全部企业应付）`,
        );
      }
      const result = distributeDividend(
        draft,
        company,
        amountCents,
        draft.clock.totalMinute,
        dateAtMinute(draft.clock.totalMinute, TIME.calendar).monthKey,
        operationId('dividend'),
      );
      return `分红 ${formatMoney(result.totalCents)} 已按持股比例发放给 ${result.holderCount} 位股东，你收到 ${formatMoney(
        result.paidToPlayer,
      )}（股价已除息）`;
    }, true);
  }

  /**
   * 回购：先按**本次输入的具体股数**生成预览，数量或价格与玩家确认过的预览不一致时明确拒绝。
   *
   * `expectedPriceCents` 是界面上这次预览显示的含冲击均价；它是「玩家确认过这次成交」的依据，
   * 行情在确认与提交之间变化时不能悄悄按另一个价格成交。
   */
  buyback(
    companyId: string | null,
    shares: number,
    expectedPriceCents?: number | null,
  ): CapitalOutcome {
    return this.execute((draft) => {
      const company = companyId
        ? requireManagedCompanyById(draft, companyId)
        : requireManagedCompany(draft);
      if (!Number.isSafeInteger(shares) || shares <= 0) {
        throw new BusinessError('INVALID_SHARES', '请输入正整数股数');
      }
      const preview = previewBuyback(draft, company.id, shares);
      if (preview.executableShares <= 0) {
        throw new BusinessError('NO_LIQUIDITY', preview.reason ?? '无法回购');
      }
      if (preview.executableShares !== shares) {
        throw new BusinessError(
          'QUANTITY_CHANGED',
          `最多可回购 ${preview.executableShares} 股（约 ${formatMoney(
            preview.executableShares * preview.priceCents,
          )}，市场影响 ${(preview.impactPct * 100).toFixed(2)}%）。` +
            '回购不会自动缩量，请刷新预览并确认新的数量',
        );
      }
      if (expectedPriceCents !== null && expectedPriceCents !== undefined) {
        if (expectedPriceCents !== preview.priceCents) {
          throw new BusinessError(
            'PREVIEW_STALE',
            `回购均价已从 ${(expectedPriceCents / 100).toFixed(2)} 元变为 ${(
              preview.priceCents / 100
            ).toFixed(2)} 元，请刷新预览后再确认`,
          );
        }
      } else {
        throw new BusinessError(
          'PREVIEW_REQUIRED',
          '回购需要先在预览里确认本次股数与成交均价；未确认的提交不会执行',
        );
      }
      const result = executeBuyback(draft, {
        companyId: company.id,
        shares,
        atMinute: draft.clock.totalMinute,
        operationPrefix: 'business-buyback',
      });
      return `已回购 ${result.executableShares} 股（${formatMoney(
        result.amountCents,
      )}，均价 ${formatMoney(result.priceCents)}，市场影响 ${(result.impactPct * 100).toFixed(
        2,
      )}%），转入库存股；总发行股数不变`;
    }, true);
  }

  promote(budgetCents: number): CapitalOutcome {
    return this.execute((draft) => {
      const company = requireManagedCompany(draft);
      validateBudget(budgetCents);
      const nowMinute = draft.clock.totalMinute;
      if (isPromotionActive(draft.promotion, company.id, nowMinute)) {
        throw new BusinessError('PROMOTION_ACTIVE', '已有一次宣传正在进行中，不能叠加');
      }
      const cash = draft.finance.businessAccounts[company.id] ?? 0;
      if (cash < budgetCents) {
        throw new BusinessError('INSUFFICIENT_BUSINESS_FUNDS', '企业现金不足以支付宣传预算');
      }
      // 成本无论成败都支付，且记为独立的宣传费用
      transferFunds(draft.finance, {
        atMinute: nowMinute,
        monthKey: dateAtMinute(nowMinute, TIME.calendar).monthKey,
        operationId: operationId('promotion'),
        from: businessAccountRef(company.id),
        to: { owner: 'external', id: 'advertiser' },
        amount: budgetCents,
        category: 'equity-promotion',
        memo: '投资者宣传',
      });
      accrue(company, 'opex', budgetCents);

      const record = rollPromotion(draft.promotion, company.id, budgetCents, nowMinute);
      if (record.lastOutcome === 'success') {
        return `宣传成功：估值溢价约 ${(record.strength * 100).toFixed(1)}%，持续 ${
          Math.round((record.expireMinute - record.startMinute) / 1440)
        } 个游戏日后衰减完毕`;
      }
      return '宣传没有达到预期效果：费用已支付，但不产生正向预期（不会额外暴跌）';
    }, true);
  }

  /* ------------------------------------------------------------ 治理 */

  /** 任命 CEO：显式接收 companyId，不再自动选「第一家持股公司」。 */
  appointCeo(companyId: string | null, targetHolderId: string): CapitalOutcome {
    return this.execute((draft) => {
      const { company, book } = requireShareholderPosition(draft, companyId);
      assertProposalValid(book, 'appoint-ceo', targetHolderId);
      if (openProposalOf(draft.governance, company.id)) {
        throw new BusinessError('PROPOSAL_OPEN', '该公司已有未决提案，请先等它表决完成');
      }
      if (targetHolderId === 'player') {
        assertManageLimit(
          managedCompanies(draft).some((item) => item.id !== company.id),
        );
      }
      const proposal = pushProposal(draft.governance, {
        companyId: company.id,
        kind: 'appoint-ceo',
        targetHolderId,
        proposedBy: 'player',
        origin: 'player',
        nowMinute: draft.clock.totalMinute,
        deadlineMinute: null,
      });
      resolveProposal(proposal, book, voteContextOf(draft, company), draft.clock.totalMinute, {
        allowEffect: (item) => effectBlockReason(draft, company, item.kind, item.targetHolderId),
      });
      return proposal.note;
    }, true);
  }

  removeCeo(companyId: string | null, targetHolderId: string): CapitalOutcome {
    return this.execute((draft) => {
      const { company, book } = requireShareholderPosition(draft, companyId);
      const target = targetHolderId || book.ceoId || '';
      if (!target) throw new BusinessError('NO_CEO', '该公司目前没有 CEO');
      assertProposalValid(book, 'remove-ceo', target);
      if (openProposalOf(draft.governance, company.id)) {
        throw new BusinessError('PROPOSAL_OPEN', '该公司已有未决提案，请先等它表决完成');
      }
      const proposal = pushProposal(draft.governance, {
        companyId: company.id,
        kind: 'remove-ceo',
        targetHolderId: target,
        proposedBy: 'player',
        origin: 'player',
        nowMinute: draft.clock.totalMinute,
        deadlineMinute: null,
      });
      resolveProposal(proposal, book, voteContextOf(draft, company), draft.clock.totalMinute, {
        allowEffect: (item) => effectBlockReason(draft, company, item.kind, item.targetHolderId),
      });
      return proposal.note;
    }, true);
  }

  /** 外部股东提案的表决：未投票按弃权处理，不会把玩家股份自动算成赞成。 */
  voteOnProposal(
    companyId: string | null,
    proposalId: string,
    choice: VoteChoice,
  ): CapitalOutcome {
    return this.execute((draft) => {
      const { company, book } = requireShareholderPosition(draft, companyId);
      const proposal = findProposal(draft.governance, company.id, proposalId);
      if (!proposal) throw new BusinessError('NO_PROPOSAL', '提案不存在');
      if (proposal.status !== 'open') throw new BusinessError('PROPOSAL_CLOSED', '提案已经结束');
      if (proposal.origin !== 'shareholder') {
        throw new BusinessError('NOT_EXTERNAL', '这是你自己提出的提案，提交时已默认投赞成');
      }
      proposal.playerVote = choice;
      const due =
        proposal.deadlineMinute !== null && draft.clock.totalMinute >= proposal.deadlineMinute;
      if (due) {
        resolveProposal(
          proposal,
          book,
          voteContextOf(draft, company),
          draft.clock.totalMinute,
          { allowEffect: (item) => effectBlockReason(draft, company, item.kind, item.targetHolderId) },
        );
      }
      const label = choice === 'yes' ? '赞成' : choice === 'no' ? '反对' : '弃权';
      return due ? `已投${label}并完成表决：${proposal.note}` : `已投${label}，等待表决窗口结束`;
    }, true);
  }

  /* ------------------------------------------------------------ 内部 */

  private execute(mutate: (draft: GameState) => string, autoSave = false): CapitalOutcome {
    try {
      const message = this.store.run(mutate);
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

/**
 * 票数通过后的业务限制检查。
 * 首轮最多管理一家：任命玩家为第二家公司的 CEO 不能静默生效。
 */
function fairSeed(securityId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < securityId.length; i += 1) {
    hash ^= securityId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

