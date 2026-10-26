/**
 * 企业经营命令 —— 玩家操作的跨模块协调。
 *
 * 每个命令都在一次 GameStore 提交内完成：改价前先结清旧规则下的销量，
 * 费用与流水同步写入，任一步失败整体回滚。
 * 这里不实现业务公式（在 features 内），也不渲染界面（在 ui 内）。
 */

import { dateAtMinute } from '../core/calendar';
import { BusinessError, describeError } from '../core/errors';
import { formatMoney } from '../core/money';
import { GameStore } from '../core/store';
import {
  ENTERPRISE_RULES,
  PRODUCT_MARKET,
  TECH,
  type FocusKey,
} from '../content/business';
import { TIME } from '../content/config';
import { EQUITY_RULES } from '../content/capital';
import {
  createEnterprise,
  payablesOf,
  STATUS_LABELS,
  type Enterprise,
} from '../features/enterprise';
import { bookOfCompany, createCompanyBook } from '../features/equity';
import {
  businessBalance,
  openBusinessAccount,
  transferPersonalSavingsToBusiness,
} from '../features/finance';
import {
  ensureTechCompany,
  findProduct,
  isPublishBlockedThisYear,
  releaseProduct,
  startProject,
  stopSelling,
} from '../features/technology';
import { assignmentOf, candidateOf, fire, hire } from '../features/talent';
import { managedCompany, type GameState } from './state';
import {
  liquidateCompany,
  payResearch,
  settleCompanyExpensesTo,
  settleCompanySales,
  tryPayPayables,
} from './business-settlement';
import { advanceGameTime, type AdvanceResult } from './timeAdvance';
import { applyProductReleaseImpact } from './securities-settlement';
import { activePolicyEffects } from './policy';

export type NotifyKind = 'info' | 'success' | 'error';

export interface BusinessHooks {
  notify(kind: NotifyKind, message: string): void;
  requestAutoSave(): void;
}

export interface CommandOutcome {
  readonly ok: boolean;
  readonly message: string | null;
}

function operationId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}:${random}`;
}

function clampName(raw: string, min: number, max: number, label: string): string {
  const name = raw.trim();
  if (name.length < min || name.length > max) {
    throw new BusinessError('INVALID_NAME', `${label}需要 ${min}–${max} 个字符`);
  }
  return name;
}

export class BusinessCommands {
  constructor(
    private readonly store: GameStore<GameState>,
    private readonly hooks: BusinessHooks,
  ) {}

  /* ------------------------------------------------------------ 公司 */

  createCompany(name: string, capitalCents: number): CommandOutcome {
    return this.execute((draft) => {
      const existing = managedCompany(draft);
      if (existing) {
        throw new BusinessError('COMPANY_EXISTS', '你已经有一家在营公司（首轮最多管理一家）');
      }
      const companyName = clampName(
        name,
        ENTERPRISE_RULES.nameMinLength,
        ENTERPRISE_RULES.nameMaxLength,
        '公司名称',
      );
      if (!Number.isSafeInteger(capitalCents)) {
        throw new BusinessError('INVALID_AMOUNT', '初始出资必须是整数（分）');
      }
      if (capitalCents < ENTERPRISE_RULES.minCapitalCents) {
        throw new BusinessError(
          'CAPITAL_TOO_SMALL',
          `初始出资不能低于 ${formatMoney(ENTERPRISE_RULES.minCapitalCents)}`,
        );
      }
      if (capitalCents > ENTERPRISE_RULES.maxCapitalCents) {
        throw new BusinessError('CAPITAL_TOO_LARGE', '初始出资超出允许范围');
      }
      if (draft.finance.accounts.savings < capitalCents) {
        throw new BusinessError('INSUFFICIENT_SAVINGS', '银行存款不足，无法出资');
      }

      const now = dateAtMinute(draft.clock.totalMinute, TIME.calendar);
      // 清算后再次创业使用新 id，历史公司与其报表保留
      const seq = Object.keys(draft.enterprises.companies).filter((id) =>
        id.startsWith('player-'),
      ).length + 1;
      const companyId = `player-${seq}`;

      const company = createEnterprise({
        id: companyId,
        role: 'player',
        name: companyName,
        nowMinute: draft.clock.totalMinute,
        monthKey: now.monthKey,
      });
      draft.enterprises.companies[companyId] = company;

      const tech = ensureTechCompany(draft.technology, companyId);
      tech.accumulation = TECH.initialAccumulation;

      // 股权：初始股份 100% 归创始玩家。
      // 做市商不是无偿股东——上市后的做市库存只能通过真实股份转让取得，
      // 因此这里**不**给做市商任何免费股份（sponsorRatio 默认为 0）。
      createCompanyBook(draft.equity, {
        companyId,
        securityId: `sec-${companyId}`,
        founderId: 'player',
        marketMakerId: 'market-maker',
        founderRatio: EQUITY_RULES.playerFounderRatio,
        sponsorRatio: 0,
      });

      openBusinessAccount(draft.finance, companyId, {
        atMinute: draft.clock.totalMinute,
        monthKey: now.monthKey,
      });
      transferPersonalSavingsToBusiness(draft.finance, companyId, {
        atMinute: draft.clock.totalMinute,
        monthKey: now.monthKey,
        operationId: operationId('capital'),
        amount: capitalCents,
        memo: '初始出资',
      });

      // 记录创始股东实缴出资，作为上市后同步证券持仓的成本口径
      const book = bookOfCompany(draft.equity, companyId);
      if (book) book.founderContributionCents += capitalCents;

      return `已创立「${companyName}」，出资 ${formatMoney(capitalCents)}`;
    }, true);
  }

  fundCompany(cents: number): CommandOutcome {
    return this.execute((draft) => {
      const company = this.requireCompany(draft);
      if (!Number.isSafeInteger(cents) || cents <= 0) {
        throw new BusinessError('INVALID_AMOUNT', '请输入有效的出资金额');
      }
      if (cents > ENTERPRISE_RULES.maxCapitalCents) {
        throw new BusinessError('CAPITAL_TOO_LARGE', '单次出资超出允许范围');
      }
      if (draft.finance.accounts.savings < cents) {
        throw new BusinessError('INSUFFICIENT_SAVINGS', '银行存款不足');
      }
      const now = dateAtMinute(draft.clock.totalMinute, TIME.calendar);
      transferPersonalSavingsToBusiness(draft.finance, company.id, {
        atMinute: draft.clock.totalMinute,
        monthKey: now.monthKey,
        operationId: operationId('capital'),
        amount: cents,
        memo: '追加出资',
      });
      // 追加出资不增发股份，但增加创始股东在上市时的成本口径
      const book = bookOfCompany(draft.equity, company.id);
      if (book) book.founderContributionCents += cents;
      tryPayPayables(draft, company, draft.clock.totalMinute);
      return `已追加出资 ${formatMoney(cents)}`;
    }, true);
  }

  pauseCompany(): CommandOutcome {
    return this.execute((draft) => {
      const company = this.requireCompany(draft);
      if (company.status === 'closed') throw new BusinessError('COMPANY_CLOSED', '公司已清算');
      if (company.status === 'paused') throw new BusinessError('ALREADY_PAUSED', '公司已是暂停状态');
      settleCompanySales(draft, company, draft.clock.totalMinute);
      settleCompanyExpensesTo(draft, company, draft.clock.totalMinute);
      company.status = 'paused';
      company.crisisSinceMinute = null;
      return `「${company.name}」已暂停经营：不再产生销售，也不再计营销与运营费`;
    }, true);
  }

  /**
   * 恢复经营。
   *
   * 关键点：先把销售与费用检查点推到「当前时刻」，此时公司仍是 paused / crisis，
   * 所以停业期间既不产生销售、也不计营销与运营费；随后才切换到 active。
   * 否则同一天暂停后恢复，停业时间会在下一次销售结算里被当作正常经营补算。
   */
  resumeCompany(): CommandOutcome {
    return this.execute((draft) => {
      const company = this.requireCompany(draft);
      if (company.status === 'active') {
        // 不能借「恢复」把检查点重置，那会丢掉这段已经发生的合法销售
        return `「${company.name}」已经在正常经营，无需恢复`;
      }

      settleCompanySales(draft, company, draft.clock.totalMinute);
      settleCompanyExpensesTo(draft, company, draft.clock.totalMinute);
      tryPayPayables(draft, company, draft.clock.totalMinute);

      const remaining = payablesOf(company);
      if (remaining > 0) {
        throw new BusinessError(
          'PAYABLES_OUTSTANDING',
          `仍有未付应付 ${formatMoney(remaining)}，请先追加出资补足`,
        );
      }

      company.status = 'active';
      company.crisisSinceMinute = null;
      return `「${company.name}」恢复经营`;
    }, true);
  }

  liquidateCompany(): CommandOutcome {
    return this.execute((draft) => {
      const company = this.requireCompany(draft);
      if (company.status === 'closed') throw new BusinessError('COMPANY_CLOSED', '公司已清算');
      liquidateCompany(draft, company, draft.clock.totalMinute, '股东决定清算');
      const note = company.liquidationNote ?? '';
      return `「${company.name}」已清算。${note}`;
    }, true);
  }

  /* ------------------------------------------------------------ 人才 */

  hireTalent(candidateId: string): CommandOutcome {
    return this.execute((draft) => {
      const company = this.requireOperating(draft);
      const assignment = hire(
        draft.talent,
        company.id,
        candidateId,
        draft.clock.totalMinute,
      );
      const candidate = candidateOf(assignment);
      return `已聘用 ${candidate?.name ?? ''}，月薪 ${formatMoney(candidate?.monthlySalaryCents ?? 0)}`;
    }, true);
  }

  fireTalent(): CommandOutcome {
    return this.execute((draft) => {
      const company = this.requireCompany(draft);
      const assignment = assignmentOf(draft.talent, company.id);
      if (!assignment) throw new BusinessError('NO_TALENT', '当前没有科研高管');
      const candidate = candidateOf(assignment);
      // 工资已按任职分钟逐分钟计入企业应付，这里不需要再补算一次。
      // 先尝试支付（此时任职关系还在，才能把实付记到该员工头上），再释放关系；
      // 付不出的部分继续留在企业负债里，解雇不会消除它。
      const owedBefore = company.payrollDue;
      tryPayPayables(draft, company, draft.clock.totalMinute);
      const paid = owedBefore - company.payrollDue;
      fire(draft.talent, company.id);
      return `已解雇 ${candidate?.name ?? ''}，已付工资 ${formatMoney(paid)}，${
        company.payrollDue > 0 ? `未付 ${formatMoney(company.payrollDue)} 仍计为应付` : '工资已结清'
      }`;
    }, true);
  }

  /* ------------------------------------------------------------ 科技 */

  investTech(cents: number): CommandOutcome {
    return this.execute((draft) => {
      const company = this.requireCompany(draft);
      const range = TECH.accumulationInvestment;
      if (!Number.isSafeInteger(cents) || cents < range.minCents || cents > range.maxCents) {
        throw new BusinessError(
          'INVALID_AMOUNT',
          `技术积累投入需在 ${formatMoney(range.minCents)} ～ ${formatMoney(range.maxCents)} 之间`,
        );
      }
      if (businessBalance(draft.finance, company.id) < cents) {
        throw new BusinessError('INSUFFICIENT_BUSINESS_FUNDS', '企业现金不足');
      }
      // payResearch 内部已计入当月研发费用，这里不再重复累计
      payResearch(draft, company, cents, '技术积累投入', draft.clock.totalMinute);

      const tech = ensureTechCompany(draft.technology, company.id);
      const gain = Math.round(
        range.growthCoefficient * (cents / (cents + range.referenceBudgetCents)),
      );
      const actual = Math.max(1, gain);
      tech.accumulation += actual;
      return `技术积累 +${actual}，当前永久积累 ${tech.accumulation}`;
    }, true);
  }

  startResearch(focus: FocusKey, days: number, budgetCents: number): CommandOutcome {
    return this.execute((draft) => {
      const company = this.requireOperating(draft);
      const tech = ensureTechCompany(draft.technology, company.id);
      if (tech.project) throw new BusinessError('PROJECT_EXISTS', '已有进行中的研发项目');
      if (!Number.isSafeInteger(days) || days < 1 || days > TECH.maxPlannedDays) {
        throw new BusinessError('INVALID_DAYS', `研发天数需在 1 ～ ${TECH.maxPlannedDays} 天之间`);
      }
      if (!Number.isSafeInteger(budgetCents) || budgetCents < TECH.minResearchBudgetCents) {
        throw new BusinessError(
          'INVALID_BUDGET',
          `研发预算不能低于 ${formatMoney(TECH.minResearchBudgetCents)}`,
        );
      }
      if (businessBalance(draft.finance, company.id) < budgetCents) {
        throw new BusinessError('INSUFFICIENT_BUSINESS_FUNDS', '企业现金不足以支付研发预算');
      }
      const now = dateAtMinute(draft.clock.totalMinute, TIME.calendar);
      payResearch(draft, company, budgetCents, '产品研发投入', draft.clock.totalMinute);

      const ability = candidateOf(assignmentOf(draft.talent, company.id))?.ability ?? 0;
      tech.project = startProject(tech, {
        focus,
        days,
        budgetCents,
        effectiveBase: tech.accumulation + ability,
        // 立项时固定本次政策效果：只乘在研发增量部分，之后换届不再改变
        researchGrowthMultiplier: activePolicyEffects(draft).researchGrowthMultiplier,
        startMinute: draft.clock.totalMinute,
        monthKey: now.monthKey,
      });

      const warning =
        days > TECH.capDays ? '（超过 720 天不再增加属性）' : '';
      return `已立项：${days} 天，预算 ${formatMoney(budgetCents)}${warning}`;
    }, true);
  }

  cancelResearch(): CommandOutcome {
    return this.execute((draft) => {
      const company = this.requireCompany(draft);
      const tech = ensureTechCompany(draft.technology, company.id);
      if (!tech.project) throw new BusinessError('NO_PROJECT', '当前没有进行中的研发项目');
      tech.project = null;
      return '已取消研发项目，已投入的研发费用不退还';
    }, true);
  }

  /* ------------------------------------------------------------ 产品 */

  releaseProduct(
    productId: string,
    name: string,
    priceCents: number,
    marketingDailyCents: number,
  ): CommandOutcome {
    return this.execute((draft) => {
      const company = this.requireOperating(draft);
      const tech = ensureTechCompany(draft.technology, company.id);
      const product = findProduct(tech, productId);
      if (!product || product.releasedAtMinute !== null) {
        throw new BusinessError('NO_PENDING_PRODUCT', '没有可发布的待上市产品');
      }
      const now = dateAtMinute(draft.clock.totalMinute, TIME.calendar);
      if (isPublishBlockedThisYear(tech, now.year)) {
        throw new BusinessError('ANNUAL_PUBLISH_LIMIT', '每个游戏年最多发布一款产品');
      }
      const productName = clampName(
        name,
        ENTERPRISE_RULES.productNameMinLength,
        ENTERPRISE_RULES.productNameMaxLength,
        '产品名称',
      );
      if (
        !Number.isSafeInteger(priceCents) ||
        priceCents < ENTERPRISE_RULES.minPriceCents ||
        priceCents > ENTERPRISE_RULES.maxPriceCents
      ) {
        throw new BusinessError('INVALID_PRICE', '售价超出允许范围');
      }
      if (
        !Number.isSafeInteger(marketingDailyCents) ||
        marketingDailyCents < 0 ||
        marketingDailyCents > PRODUCT_MARKET.maxMarketingDailyCents
      ) {
        throw new BusinessError('INVALID_BUDGET', '营销预算超出允许范围');
      }
      settleCompanySales(draft, company, draft.clock.totalMinute);
      settleCompanyExpensesTo(draft, company, draft.clock.totalMinute);
      releaseProduct(tech, product, {
        name: productName,
        priceCents,
        marketingDailyCents,
        nowMinute: draft.clock.totalMinute,
        year: now.year,
      });
      // 首次发布对股价的一次性反应：与发布在同一次提交内完成，且只记一次
      const impact = applyProductReleaseImpact(draft, company, product, draft.clock.totalMinute);
      const impactText = impact?.applied
        ? `，首发属性 A=${impact.averageAttribute.toFixed(1)}（门槛 ${impact.thresholdLower.toFixed(
            0,
          )}–${impact.thresholdUpper.toFixed(0)}），股价 ${impact.deltaPct > 0 ? '+' : ''}${(
            impact.deltaPct * 100
          ).toFixed(2)}%`
        : '，本次首发未触发额外股价影响';
      return `「${productName}」已上市，售价 ${formatMoney(priceCents)}${impactText}`;
    }, true);
  }

  setPrice(productId: string, priceCents: number): CommandOutcome {
    return this.execute((draft) => {
      const company = this.requireCompany(draft);
      const tech = ensureTechCompany(draft.technology, company.id);
      const product = findProduct(tech, productId);
      if (!product || product.releasedAtMinute === null) {
        throw new BusinessError('NO_PRODUCT', '没有该在售产品');
      }
      if (
        !Number.isSafeInteger(priceCents) ||
        priceCents < ENTERPRISE_RULES.minPriceCents ||
        priceCents > ENTERPRISE_RULES.maxPriceCents
      ) {
        throw new BusinessError('INVALID_PRICE', '售价超出允许范围');
      }
      // 先按旧价格结清到当前时刻，再启用新价格
      settleCompanySales(draft, company, draft.clock.totalMinute);
      product.priceCents = priceCents;
      return `「${product.name}」售价调整为 ${formatMoney(priceCents)}`;
    }, true);
  }

  setMarketing(productId: string, dailyCents: number): CommandOutcome {
    return this.execute((draft) => {
      const company = this.requireCompany(draft);
      const tech = ensureTechCompany(draft.technology, company.id);
      const product = findProduct(tech, productId);
      if (!product || product.releasedAtMinute === null) {
        throw new BusinessError('NO_PRODUCT', '没有该在售产品');
      }
      if (
        !Number.isSafeInteger(dailyCents) ||
        dailyCents < 0 ||
        dailyCents > PRODUCT_MARKET.maxMarketingDailyCents
      ) {
        throw new BusinessError('INVALID_BUDGET', '营销预算超出允许范围');
      }
      settleCompanySales(draft, company, draft.clock.totalMinute);
      settleCompanyExpensesTo(draft, company, draft.clock.totalMinute);
      product.marketingDailyCents = dailyCents;
      return `「${product.name}」每日营销预算调整为 ${formatMoney(dailyCents)}`;
    }, true);
  }

  stopProduct(productId: string): CommandOutcome {
    return this.execute((draft) => {
      const company = this.requireCompany(draft);
      const tech = ensureTechCompany(draft.technology, company.id);
      const product = findProduct(tech, productId);
      if (!product || product.releasedAtMinute === null) {
        throw new BusinessError('NO_PRODUCT', '没有该在售产品');
      }
      settleCompanySales(draft, company, draft.clock.totalMinute);
      settleCompanyExpensesTo(draft, company, draft.clock.totalMinute);
      stopSelling(product);
      return `「${product.name}」已停止销售（不会自动恢复）`;
    }, true);
  }

  /* ------------------------------------------------------------ 时间 */

  /**
   * 推进到下一个企业事件（研发完成或月界）。
   * 与其他时间入口共用 advanceGameTime，不会额外累计一次自然时间。
   */
  advanceToNextEvent(): CommandOutcome {
    return this.execute((draft) => {
      const company = this.requireCompany(draft);
      const tech = ensureTechCompany(draft.technology, company.id);
      const now = draft.clock.totalMinute;

      const candidates: Array<{ minute: number; label: string }> = [];
      if (tech.project) {
        candidates.push({ minute: tech.project.endMinute, label: '研发完成' });
      }
      const date = dateAtMinute(now, TIME.calendar);
      const monthEnd = (TIME.calendar.daysPerMonth - date.day + 1) * TIME.calendar.minutesPerDay
        - date.minuteOfDay;
      candidates.push({ minute: now + monthEnd, label: '月末结算' });

      let target = candidates[0]!;
      for (const item of candidates) if (item.minute < target.minute) target = item;
      const delta = Math.max(1, target.minute - now);
      const result = advanceGameTime(draft, delta);
      const hours = Math.max(1, Math.round(result.advancedMinutes / 60));
      return summarizeAdvance(result, `推进约 ${hours} 小时（目标：${target.label}）`);
    }, true);
  }

  /* ------------------------------------------------------------ 内部 */

  /**
   * 管理权限：必须是「玩家当前管理的公司」。
   * 单纯持股（失去 CEO 职位）不能改产品、预算、招聘或调用公司资金。
   */
  private requireCompany(draft: GameState): Enterprise {
    const company = managedCompany(draft);
    if (!company) {
      throw new BusinessError('NO_PERMISSION', '你不是任何公司的现任 CEO，无法执行该操作');
    }
    if (company.status === 'closed') throw new BusinessError('COMPANY_CLOSED', '公司已清算');
    return company;
  }

  private requireOperating(draft: GameState): Enterprise {
    const company = this.requireCompany(draft);
    if (company.status !== 'active') {
      throw new BusinessError(
        'COMPANY_NOT_OPERATING',
        `公司当前状态为「${STATUS_LABELS[company.status]}」，无法执行该操作`,
      );
    }
    return company;
  }

  private execute(mutate: (draft: GameState) => string, autoSave = false): CommandOutcome {
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

function summarizeAdvance(result: AdvanceResult, main: string): string {
  const parts = [main];
  if (result.monthsSettled > 0) parts.push(`完成 ${result.monthsSettled} 次月度结算`);
  if (result.researchCompletions.length > 0) parts.push('有研发项目完成');
  if (result.stopReason) parts.push(result.stopReason);
  return parts.join('；');
}
