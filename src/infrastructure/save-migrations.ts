/**
 * 存档迁移 —— v1 → v18 的完整版本链与受控旧数据修复。
 *
 * 这里保留历史上所有迁移步骤，顺序与数据保留行为不得改变；
 * 旧的修复规则（无偿配股回收、失效报价与预留清理、缺失股权簿补建）也集中在此。
 *
 * 依赖说明：迁移需要复用 app/state 的世界初始化辅助函数（AI 开局、资本世界、玩家公司股权簿），
 * 以及城市统计/城区的建立辅助。这是**有意的例外**，集中在本文件里，不扩散到其它基础设施代码，
 * 也不在本轮重新设计世界初始化。
 */

import { CALENDAR, MARKET, SAVE } from '../content/config';
import { CITY_ECONOMY_RULE_VERSION } from '../content/city-economy';
import { CANDIDATES, CAMPAIGN_RULES, ELECTION_RULES } from '../content/government';
import type { CandidateId, PolicyId } from '../content/government';
import { EARLY_ELECTION_RULES } from '../content/politics';
import { TALENT_CANDIDATES, AI_COMPANIES } from '../content/business';
import { EQUITY_RULES, LIQUIDITY_RULES, MARKET_MAKING_RULES, PRODUCT_STOCK_RULES } from '../content/capital';
import { createEnterpriseState, isClosed } from '../features/enterprise';
import { WAGE_EFFICIENCY_PERCENT_SCALE } from '../features/employment';
import { createInventoryState, createSupplyOperationEpoch } from '../features/inventory';
import { createSurvivalState } from '../features/survival';
import { createPopulationState } from '../features/population';
import { createPoliticsState, createPoliticsStateFromLegacy, noteNewTerm } from '../features/politics';
import { createElectionState } from '../features/elections';
import {
  GOVERNMENT_CONFIG_VERSION,
  GOVERNMENT_OFFICE_TITLE,
  createGovernmentState,
  policyEffectsFor,
} from '../features/government';
import { createBaseLayout } from '../features/city-layout';
import { createHousingState } from '../features/housing';
import { createRealEstateState } from '../features/real-estate';
import { createCityDevelopmentState } from '../features/city-development';
import { MINUTES_PER_MONTH, createTalentState } from '../features/talent';
import { createTechnologyState } from '../features/technology';
import { releaseFunds } from '../features/finance';
import { createFinancingState } from '../features/financing';
import { createGovernanceState } from '../features/governance';
import { createPromotionState } from '../features/promotion';
import { bookOfCompany, createEquityState, createStandaloneBook, recallSponsorShares, sharesOf } from '../features/equity';
import { createSecuritiesState, registerSecurity } from '../features/stock';
import { ensurePlayerCompanyBook, seedBusinessWorld, seedCapitalWorld, seedListedCompanyCapital, type GameState } from '../app/state';
import {
  computeSalesPlan,
  createCityStatisticsState,
  estimateStandardBaseGdpCents,
  setBaselinePending,
} from '../app/city-statistics';
import { beginCityIndexMonth } from '../app/city-stock-index';
import { adoptLegacyDevelopment, deliverDistrictHousing } from '../app/city-development';
import { seedRealEstateWorld } from '../app/real-estate';
import { dateAtMinute } from '../core/calendar';
import { isValidSpeed } from '../core/clock';
import { fail } from './save-validation';

/** v6 只有按投资者汇总的预留：改写成按单据记账时，无法归属的金额统一挂在这个单据上。 */
const LEGACY_REF = 'legacy';


function upgradeV1toV2(state: Record<string, unknown>): Record<string, unknown> {
  // 深拷贝：迁移会往 state 里写新切片与新流水，绝不能就地改写传入的原始存档，
  // 否则同一份旧档解析两次会叠加注资。
  const next = structuredClone(state);
  const clock = next.clock as Record<string, unknown> | undefined;
  const nowMinute = typeof clock?.totalMinute === 'number' ? clock.totalMinute : 0;
  next.market = {
    price: MARKET.initialPriceCents,
    nextTickMinute: nowMinute + MARKET.tickMinutes,
    rng: MARKET.initialSeed >>> 0,
    history: [{ minute: nowMinute, price: MARKET.initialPriceCents }],
    ticks: 0,
  };
  next.stock = { shares: 0, totalCost: 0, realizedPnl: 0, trades: 0 };
  next.loan = { contract: null };
  return next;
}

function upgradeV2toV3(state: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(state);
  const clock = next.clock as Record<string, unknown> | undefined;
  const nowMinute = typeof clock?.totalMinute === 'number' ? clock.totalMinute : 0;
  const finance = (next.finance ?? {}) as Record<string, unknown>;
  next.finance = { ...finance, businessAccounts: {} };
  next.population = createPopulationState();
  next.enterprises = createEnterpriseState();
  next.technology = createTechnologyState();
  next.talent = createTalentState();
  next.businessAi = { companies: {} };
  // AI 从迁移时刻开始经营；玩家不获得公司
  seedBusinessWorld(next as unknown as GameState, nowMinute);
  return next;
}

/**
 * v3 → v4：企业费用改为「按分钟计提 + 分类应付」。
 *
 * - 新增费用检查点（expenseMinute / 营销与运营余量）从**当前时间**起算，
 *   不追溯估算无法恢复的历史预算；
 * - v3 的 supplyDue 已混合成本/营销/运营，无法可靠拆分类，保留为「历史经营应付」原额；
 * - 旧档已累计但尚未结算的任职分钟能准确折算成工资：一次性转入 payrollDue 与当月费用，
 *   原有 payrollDue 是此前未付部分，直接保留，不覆盖、不重复累计；
 * - 不重建 AI 公司、不重复注资。
 */
function upgradeV3toV4(state: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(state);
  const clock = (next.clock ?? {}) as Record<string, unknown>;
  const nowMinute = typeof clock.totalMinute === 'number' ? clock.totalMinute : 0;
  const enterprises = (next.enterprises ?? {}) as Record<string, unknown>;
  const companies = (enterprises.companies ?? {}) as Record<string, Record<string, unknown>>;
  const talent = (next.talent ?? {}) as Record<string, unknown>;
  const assignments = (talent.assignments ?? {}) as Record<string, Record<string, unknown> | null>;

  for (const [companyId, company] of Object.entries(companies)) {
    company.cogsDue = 0;
    company.marketingDue = 0;
    company.opexDue = 0;
    company.expenseMinute = nowMinute;
    company.marketingRemainder = 0;
    company.opexRemainder = 0;
    if (typeof company.payrollDue !== 'number') company.payrollDue = 0;
    if (typeof company.supplyDue !== 'number') company.supplyDue = 0;

    const assignment = assignments[companyId];
    if (!assignment) continue;
    const minutes = typeof assignment.accruedMinutes === 'number' ? assignment.accruedMinutes : 0;
    if (minutes > 0) {
      const candidate = TALENT_CANDIDATES.find((item) => item.id === assignment.candidateId);
      const wages = candidate
        ? Math.floor((candidate.monthlySalaryCents * minutes) / MINUTES_PER_MONTH)
        : 0;
      if (wages > 0) {
        company.payrollDue = (company.payrollDue as number) + wages;
        const accrual = (company.accrual ?? {}) as Record<string, unknown>;
        accrual.wages = (typeof accrual.wages === 'number' ? accrual.wages : 0) + wages;
        company.accrual = accrual;
      }
    }
    delete assignment.accruedMinutes;
    assignment.wageNumerator = 0;
    if (typeof assignment.paidTotalCents !== 'number') assignment.paidTotalCents = 0;
  }
  return next;
}

/**
 * v4 → v5：行情新增 K 线。
 *
 * 不从旧数据反推：旧档只有稀疏的价格点，无法还原历史开高低收，
 * 因此从当前时刻重新积累，明确不恢复已丢失的历史。
 * 现价、持仓、随机状态、下次更新时间一律不动。
 */
function upgradeV4toV5(state: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(state);
  const market = (next.market ?? {}) as Record<string, unknown>;
  market.candles = [];
  market.candleCurrent = null;
  next.market = market;
  return next;
}

/**
 * v5 → v6：单证券升级为多证券，并补齐股权、融资、治理、宣传与真实资金主体账户。
 *
 * 关键不变量：
 *  - 旧独立证券保留原证券 ID（MARKET.symbol）、现价、历史、K 线、随机状态、持仓、成本与已实现盈亏，
 *    不把它强制转换成某家 AI 公司；其股权簿 companyId 为 null，股份来自既有场内流通量；
 *  - 三家 AI 公司已存在于 v3 之后的企业里，这里只补「历史融资已完成的上市股权 + 证券」，
 *    不重建企业、不重复注资、不重放历史现金流水；
 *  - 投资者与做市商只注入一次真实资金账户（seed 函数幂等）。
 */
function upgradeV5toV6(state: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(state);
  const clock = (next.clock ?? {}) as Record<string, unknown>;
  const nowMinute = typeof clock.totalMinute === 'number' ? clock.totalMinute : 0;

  const finance = (next.finance ?? {}) as Record<string, unknown>;
  finance.subjectAccounts = {};
  finance.reservations = {};
  next.finance = finance;

  // 1) 旧单证券 → 多证券切片：逐字段搬运，不重新初始化
  const oldMarket = (next.market ?? {}) as Record<string, unknown>;
  const oldStock = (next.stock ?? {}) as Record<string, unknown>;
  const securities = createSecuritiesState();
  const legacyId = MARKET.symbol;
  const legacyMarket = {
    price: typeof oldMarket.price === 'number' ? oldMarket.price : MARKET.initialPriceCents,
    previousPrice:
      typeof oldMarket.previousPrice === 'number' ? oldMarket.previousPrice : (oldMarket.price as number),
    nextTickMinute:
      typeof oldMarket.nextTickMinute === 'number'
        ? oldMarket.nextTickMinute
        : nowMinute + MARKET.tickMinutes,
    rng: (typeof oldMarket.rng === 'number' ? oldMarket.rng : MARKET.initialSeed) >>> 0,
    history: Array.isArray(oldMarket.history) ? oldMarket.history : [{ minute: nowMinute, price: MARKET.initialPriceCents }],
    ticks: typeof oldMarket.ticks === 'number' ? oldMarket.ticks : 0,
    candles: Array.isArray(oldMarket.candles) ? oldMarket.candles : [],
    candleCurrent: (oldMarket.candleCurrent ?? null) as null,
    forSaleRatio: MARKET_MAKING_RULES.initialForSaleRatio,
  };
  registerSecurity(
    securities,
    { id: legacyId, symbol: MARKET.symbol, name: MARKET.name, companyId: null },
    legacyMarket as never,
  );
  const holding = securities.holdings[legacyId];
  holding.shares = typeof oldStock.shares === 'number' ? oldStock.shares : 0;
  holding.totalCost = typeof oldStock.totalCost === 'number' ? oldStock.totalCost : 0;
  holding.realizedPnl = typeof oldStock.realizedPnl === 'number' ? oldStock.realizedPnl : 0;
  holding.trades = typeof oldStock.trades === 'number' ? oldStock.trades : 0;
  next.securities = securities;

  // 2) 旧独立标的的股权簿
  const equity = createEquityState();
  createStandaloneBook(equity, {
    securityId: legacyId,
    holderId: 'player',
    holderShares: holding.shares,
    marketMakerId: 'market-maker',
  });
  next.equity = equity;

  // 3) 融资 / 治理 / 宣传切片
  next.financing = createFinancingState();
  next.governance = createGovernanceState();
  next.promotion = createPromotionState();

  // 4) 真实资金主体账户 + 三家 AI 的上市股权与证券（幂等，不重复注资）
  const migrated = next as unknown as GameState;
  seedCapitalWorld(migrated, nowMinute);
  seedBusinessWorld(migrated, nowMinute);
  AI_COMPANIES.forEach((config, index) => {
    seedListedCompanyCapital(migrated, config.id, index, nowMinute);
  });
  // 5) 旧玩家公司：补建未上市股权簿（100% 归玩家，不具备直接上市资格）
  migratePlayerCompanyBooks(migrated);

  // 6) 移除旧切片，避免校验与业务层再读到单证券字段
  delete next.market;
  delete next.stock;

  return next;
}

/**
 * 旧档迁移：为已存在的玩家公司补建未上市股权簿。
 *
 * - 旧版玩家公司是玩家独资：初始股份 100% 归玩家、CEO 保留玩家身份；
 * - 没有完成外部股权融资，因此不具备直接上市资格；
 * - 公司现金、产品、研发、人才、费用与报表原样保留，不增不减；
 * - 已清算公司保持关闭，不恢复经营，也不产生可交易资产；
 * - 幂等：已有股权簿的公司直接跳过，重复解析不会重复建簿或注资。
 */
function migratePlayerCompanyBooks(state: GameState): void {
  for (const company of Object.values(state.enterprises.companies)) {
    if (company.role !== 'player') continue;
    if (company.status === 'closed') continue;
    if (bookOfCompany(state.equity, company.id)) continue;
    const contribution = founderContributionFromEntries(state, company.id);
    const note =
      contribution > 0
        ? '旧档迁移：玩家独资公司补建未上市股权簿，初始股份全部归玩家；创始出资按历史出资流水恢复'
        : '旧档迁移：玩家独资公司补建未上市股权簿，初始股份全部归玩家；旧档没有可确认的出资流水，创始出资成本记为 0（未用当前现金冒充历史出资）';
    ensurePlayerCompanyBook(state, company, contribution, note);
  }
}

/**
 * 从真实流水确认的创始出资（分）。
 * 只统计「个人 → 该企业」的出资流水；企业账户的开局注资（外部投资人）不算。
 */
function founderContributionFromEntries(state: GameState, companyId: string): number {
  let total = 0;
  for (const entry of state.finance.entries) {
    if (entry.category !== 'business-capital') continue;
    if (entry.from.owner !== 'personal') continue;
    if (entry.to.owner !== 'business' || entry.to.id !== companyId) continue;
    total += entry.amount;
  }
  return total;
}

/**
 * v6 → v7：资本系统修复所需的真实字段变化与「已保存错误状态」的受控规范化。
 *
 * 1. 资金预留改为「按报价 id 记账」，旧的整体预留键补上 `::legacy` 后缀；
 * 2. 治理提案补 `origin` / `deadlineMinute` / `playerVote`，外部提案补冷却记录；
 * 3. 报价补股份基数快照；旧档无法确认基数的在途报价一律作废并释放预留
 *    （宁可让玩家重新申请，也不沿用可能已经变化的稀释比例）；
 * 4. 证券与持仓补终止标记；
 * 5. 玩家公司曾经被无偿配给做市商的 30%：只收回能可靠识别的部分；
 * 6. 旧玩家公司缺股权簿的先补建（与 v7→v8 共用同一个幂等函数）。
 */
function upgradeV6toV7(state: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(state);
  const clock = (next.clock ?? {}) as Record<string, unknown>;
  const nowMinute = typeof clock.totalMinute === 'number' ? clock.totalMinute : 0;
  const migrated = next as unknown as GameState;

  // 先补建股权簿，后面「无偿配股修复」才有正确的簿子可判断
  migratePlayerCompanyBooks(migrated);
  normalizeReservationKeys(migrated);
  normalizeGovernance(next);
  expireUnverifiedQuotes(migrated, nowMinute);
  normalizeTermination(migrated);
  repairUnpaidSponsorShares(migrated);
  // 旧报价全部作废后，`legacy` 预留不再对应任何承诺，必须一并释放
  releaseOrphanLegacyReservations(migrated);

  return next;
}

/**
 * v7 → v8：第二轮验收修复引入的两类规范化（都在持久数据里真实存在，必须处理已保存的 v7 档）。
 *
 * 1. 报价 id 只按「投资者 + 股数」生成，跨公司/跨轮次可能撞车，撞车的报价无法确定预留归属
 *    → 明确作废并释放其承诺，不猜测归属；
 * 2. v6→v7 遗留的 `legacy` 预留可能已经成为孤儿（对应报价已作废）
 *    → 释放，不减少主体现金、不重新注资；
 * 3. 已保存为 v7 但缺少股权簿的旧玩家公司 → 走同一个补建函数（幂等）。
 */
function upgradeV7toV8(state: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(state);
  const clock = (next.clock ?? {}) as Record<string, unknown>;
  const nowMinute = typeof clock.totalMinute === 'number' ? clock.totalMinute : 0;
  const migrated = next as unknown as GameState;

  migratePlayerCompanyBooks(migrated);
  expireUnverifiedQuotes(migrated, nowMinute);
  invalidateDuplicateQuoteIds(migrated, nowMinute);
  expireUnderReservedQuotes(migrated, nowMinute);
  releaseOrphanLegacyReservations(migrated);
  // 无偿配股修复以字段存在为准，重复执行不会二次收回
  repairUnpaidSponsorShares(migrated);

  return next;
}

/**
 * v8 → v9：只有本轮**真实新增的持久字段**需要规范化，不改已有口径。
 *
 * 1. 行情新增「做市愿售比例」：旧档没有该字段（或越界）时按首轮默认值初始化，
 *    只影响可售数量，不改变任何真实股权与资金；
 * 2. 产品新增「首发股价影响」「日销量窗口」「日销量快照」：
 *    - 已发布产品标记为「已结算、无影响」，绝不追溯触发发布冲击；
 *    - 未发布产品保持 null（真正发布时才结算一次）；
 *    - 日销量从迁移后开始累计（快照 = 当前累计销量），不伪造历史销量。
 */
function upgradeV8toV9(state: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(state);
  const migrated = next as unknown as GameState;
  normalizeForSaleRatios(migrated);
  normalizeProductSalesWindows(migrated);
  return next;
}

/** 愿售比例缺失或越界时回落到首轮默认值；不影响股份与资金。 */
function normalizeForSaleRatios(state: GameState): void {
  const markets = state.securities?.markets ?? {};
  for (const market of Object.values(markets)) {
    const raw = Number(market.forSaleRatio);
    market.forSaleRatio = Number.isFinite(raw)
      ? Math.min(
          MARKET_MAKING_RULES.maxForSaleRatio,
          Math.max(MARKET_MAKING_RULES.minForSaleRatio, raw),
        )
      : MARKET_MAKING_RULES.initialForSaleRatio;
  }
}

/** 产品新增字段的规范化：已发布产品不追溯触发首发冲击，日销量从迁移后开始累计。 */
function normalizeProductSalesWindows(state: GameState): void {
  const companies = state.technology?.companies ?? {};
  for (const company of Object.values(companies)) {
    const products = Array.isArray(company.products) ? company.products : [];
    for (const item of products) {
      const product = item as unknown as Record<string, unknown>;
      const released =
        product.releasedAtMinute !== null && product.releasedAtMinute !== undefined;
      if (product.releaseImpactPct === undefined) {
        // 迁移前就已发布的产品属于「历史既成事实」：标记为已结算、无影响
        product.releaseImpactPct = released ? 0 : null;
      }
      if (!Array.isArray(product.dailySales)) {
        product.dailySales = [];
      } else {
        product.dailySales = (product.dailySales as Record<string, unknown>[])
          .filter(
            (entry) =>
              entry &&
              typeof entry.day === 'number' &&
              Number.isSafeInteger(entry.day) &&
              entry.day >= 0 &&
              typeof entry.units === 'number' &&
              Number.isFinite(entry.units) &&
              entry.units >= 0,
          )
          .map((entry) => ({ day: entry.day as number, units: Math.floor(entry.units as number) }))
          .sort((left, right) => left.day - right.day)
          .slice(-PRODUCT_STOCK_RULES.maxDailyRecords);
      }
      if (product.daySnapshotUnits === undefined) {
        // 不伪造历史日销量：把快照对齐到当前累计销量，只统计迁移之后的日界增量
        product.daySnapshotUnits =
          typeof product.totalUnits === 'number' && product.totalUnits > 0
            ? product.totalUnits
            : 0;
      }
    }
  }
}

/**
 * v9 → v10：产品新增「日销量观察起点」。
 *
 * v9 的分母口径无法区分「完整日样本」与「不足一天的样本」（中途发布、中途迁移都会产生），
 * 因此迁移时**只重建这一小段派生窗口**：
 *  - 清空 `dailySales`（派生数据，可随时从后续日界重建）；
 *  - `daySnapshotUnits` 对齐当前累计销量；
 *  - `dailyObservationStartMinute` 设为存档当前游戏分钟，从此刻重新观察。
 *
 * 不改产品累计销量/收入/成本/属性/发布时间/发布影响，也不改企业财务与历史行情。
 * 该重建只在版本迁移时执行一次；正常读取 v10 不会再次清空（版本相同就不迁移）。
 */
function upgradeV9toV10(state: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(state);
  const clock = (next.clock ?? {}) as Record<string, unknown>;
  const nowMinute = typeof clock.totalMinute === 'number' ? clock.totalMinute : 0;
  const migrated = next as unknown as GameState;

  const companies = migrated.technology?.companies ?? {};
  for (const company of Object.values(companies)) {
    const products = Array.isArray(company.products) ? company.products : [];
    for (const item of products) {
      const product = item as unknown as Record<string, unknown>;
      const total =
        typeof product.totalUnits === 'number' && product.totalUnits > 0
          ? product.totalUnits
          : 0;
      product.dailySales = [];
      product.daySnapshotUnits = total;
      product.dailyObservationStartMinute = Math.max(0, nowMinute);
    }
  }
  return next;
}

/**
 * v10 → v11：动态人口 + 政治 / 选举 / 政府切片。
 *
 * 关键口径：
 *  - 人口以「迁移时刻」为基准初始化 10 万人（低 50% / 中 35% / 高 15%），
 *    **不**从旧档开局时间追溯增长，也不伪造历史人口；
 *  - 经营与证券观察从迁移时刻开始建立：首个不完整统计月的经营与股市冲击保持中性，
 *    等获得完整观察月再启用；
 *  - 旧档从迁移时刻起安排一届完整竞选（30 天后投票），不补演过去的选举；
 *  - 研发项目补政策快照倍率 1，产品补销售成本余量 0。
 */
function upgradeV10toV11(state: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(state);
  const clock = (next.clock ?? {}) as Record<string, unknown>;
  const nowMinute = typeof clock.totalMinute === 'number' ? clock.totalMinute : 0;

  // 1) 人口：保留原有消费偏好，只补权威阶层人数与增长基准
  const population = (next.population ?? {}) as Record<string, unknown>;
  const template = createPopulationState(nowMinute);
  population.classes = { ...template.classes };
  population.growthAnchorMinute = nowMinute;
  population.growthSyncedMinute = nowMinute;
  population.growthAnchorTotal = template.growthAnchorTotal;
  population.businessObservationStartMinute = nowMinute;
  population.businessMonths = [];
  population.marketMonths = [];
  population.marketWindow = {
    monthKey: '',
    fixedAtMinute: nowMinute,
    fixedAtMonthStart: false,
    samples: {},
    history: [],
  };
  population.records = [];
  next.population = population;

  // 2) 政治 / 选举 / 政府：全部从迁移时刻开始
  next.politics = createPoliticsState();
  next.elections = createElectionState(
    nowMinute,
    nowMinute + ELECTION_RULES.campaignDays * 1440,
  );
  next.government = createGovernmentState(nowMinute);

  // 3) 研发政策快照与销售成本余量
  normalizeResearchPolicyAndCostRemainder(next);

  return next;
}

/** 在研项目补研发增长倍率 1，产品补销售成本余量 0（不改动任何已有数值）。 */
function normalizeResearchPolicyAndCostRemainder(state: Record<string, unknown>): void {
  const technology = (state.technology ?? {}) as Record<string, unknown>;
  const companies = (technology.companies ?? {}) as Record<string, Record<string, unknown>>;
  for (const company of Object.values(companies)) {
    const project = company.project as Record<string, unknown> | null | undefined;
    if (project && typeof project.researchGrowthMultiplier !== 'number') {
      project.researchGrowthMultiplier = 1;
    }
    const products = Array.isArray(company.products) ? company.products : [];
    for (const item of products) {
      const product = item as Record<string, unknown>;
      if (typeof product.salesCostRemainder !== 'number') product.salesCostRemainder = 0;
    }
  }
}

/**
 * v11 → v12：证券观察窗口的机械调整由「绝对价差」改为「乘法参考因子」，
 * 并修正 v11 首届竞选的资源与投票日程。
 *
 * 1) 市场样本 `mechanicalOffset`（绝对价差）无法无损换算成价格比例：
 *    若本月样本曾发生机械调整，把**剩余的不完整观察月**降级为中性
 *    （`fixedAtMonthStart = false`），下个完整月（`beginMarketMonth` 重建样本）恢复；
 *    没有机械调整的样本只需补 `referenceFactor = 1`，数值完全保留。
 * 2) v11 新游戏首次 `createElectionState` 错误地以 0 初始化基础资源：
 *    仅对「首届竞选且 base 为 0」的候选人补到配置值；同时把资源使用锚点移到
 *    迁移时刻，避免补发的资源被追溯用于读档前的整段时间。迁移幂等：
 *    base 已等于配置值时不再改动，不会重复发放。
 * 3) v11 新游戏的首届投票日程误加了 08:00 偏移（第 30 天 16:00）。
 *    只修正「第 1 届、尚未结算、竞选开始于开局 0 分钟」的旧日程；
 *    若修正后的投票时刻已经过去，则安排到迁移后的下一分钟立即开票，
 *    绝不制造「投票时间早于当前时间」的非法状态；已经完成的历史选举不重演。
 */
function upgradeV11toV12(state: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(state);
  const clock = (next.clock ?? {}) as Record<string, unknown>;
  const nowMinute = typeof clock.totalMinute === 'number' ? clock.totalMinute : 0;

  // 1) 机械偏移 → 乘法参考因子
  const population = (next.population ?? {}) as Record<string, unknown>;
  const window = (population.marketWindow ?? {}) as Record<string, unknown>;
  const samples = (window.samples ?? {}) as Record<string, Record<string, unknown>>;
  let hadMechanicalShift = false;
  for (const sample of Object.values(samples)) {
    const oldOffset =
      typeof sample.mechanicalOffset === 'number' ? sample.mechanicalOffset : 0;
    if (oldOffset !== 0) hadMechanicalShift = true;
    delete sample.mechanicalOffset;
    if (typeof sample.referenceFactor !== 'number') sample.referenceFactor = 1;
  }
  if (hadMechanicalShift) {
    // 无法从绝对价差还原当时的价格比例：本月剩余观察降级为中性
    window.fixedAtMonthStart = false;
  }

  // 2) 首届基础资源（只补 0 = 明显未初始化的情况）
  const elections = (next.elections ?? {}) as Record<string, unknown>;
  const candidates = (elections.candidates ?? {}) as Record<string, Record<string, unknown>>;
  let grantedBase = false;
  for (const row of Object.values(candidates)) {
    if (row && typeof row === 'object' && row.base === 0) {
      row.base = CAMPAIGN_RULES.baseResources;
      grantedBase = true;
    }
  }
  if (grantedBase && elections.phase === 'campaign') {
    // 补发的资源只能用于迁移之后的区间
    elections.lastUsageAnchorMinute = nowMinute;
    for (const row of Object.values(candidates)) {
      if (row && typeof row === 'object') row.useNumerator = 0;
    }
  }

  // 3) 首届投票日程（只修新游戏旧公式生成的、尚未投票的那一届）
  if (
    elections.phase === 'campaign' &&
    elections.termSeq === 1 &&
    Array.isArray(elections.settledTerms) &&
    elections.settledTerms.length === 0 &&
    elections.campaignStartMinute === 0
  ) {
    const oldDeadline =
      (ELECTION_RULES.firstElectionDay - 1) * CALENDAR.minutesPerDay +
      ELECTION_RULES.firstElectionMinuteOfDay;
    if (elections.deadlineMinute === oldDeadline) {
      const correctedDeadline =
        (ELECTION_RULES.firstElectionDay - 1) * CALENDAR.minutesPerDay +
        (ELECTION_RULES.firstElectionMinuteOfDay - CALENDAR.start.minuteOfDay);
      elections.deadlineMinute =
        correctedDeadline > nowMinute ? correctedDeadline : nowMinute + 1;
    }
  }

  return next;
}

/**
 * v12 → v13：累计分红现金的计量尺度修正。
 *
 * v12 的月回报公式把「期末价值 + 累计分红」直接除以「月初价 × 参考因子」。
 * 分红发生在机械调整之前时会少缩放现金，产生虚假正收益；v13 起现金在每次
 * 机械事件时随参考因子同比例换算到当前价格尺度。
 *
 * 旧存档里只保存了累计现金与最终参考因子，**没有**每笔分红与机械事件的先后顺序：
 * 当参考因子 ≠ 1 且累计现金 > 0 时无法无损换算。按既定降级策略，把剩余的不完整
 * 观察月标记为中性（`fixedAtMonthStart = false`），下个完整月自动恢复；
 * 其余样本（无机械调整，或没有累计现金）旧口径本身正确，原样保留。
 * 历史已结算的市场摘要属于既成事实，不重算、不伪造。
 */
function upgradeV12toV13(state: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(state);
  const population = (next.population ?? {}) as Record<string, unknown>;
  const window = (population.marketWindow ?? {}) as Record<string, unknown>;
  if (window.fixedAtMonthStart === true) {
    const samples = (window.samples ?? {}) as Record<string, Record<string, unknown>>;
    let ambiguous = false;
    for (const sample of Object.values(samples)) {
      const factor =
        typeof sample.referenceFactor === 'number' ? sample.referenceFactor : 1;
      const cash = typeof sample.cashPerShare === 'number' ? sample.cashPerShare : 0;
      if (factor !== 1 && cash > 0) ambiguous = true;
    }
    if (ambiguous) window.fixedAtMonthStart = false;
  }
  return next;
}

/**
 * v13 → v14：人物生存、背包与生活补给。
 *
 * 1) 新增 `survival`：旧档从迁移时刻起饱食度/水分均为满值 100，**不**追溯旧游戏时间扣减；
 * 2) 新增 `inventory`：背包为空、无请求去重记录，不赠送任何物品；
 * 3) 工资余数单位变化：v13 的 `accrualRemainder` 以 1/60 分为单位（时薪×分钟直接除 60），
 *    v14 起以 1/6000 分为单位（额外乘效率百分比 0～100）。两种单位是精确换算：
 *    新余数 = 旧余数 × 100，不丢分、不改变已赚工资与未发工资。
 *
 * 原有现金、存款、就业、工时、工资、投资、企业与人口数据全部保留。
 */
function upgradeV13toV14(state: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(state);
  next.survival = createSurvivalState();
  next.inventory = createInventoryState();

  const employment = (next.employment ?? {}) as Record<string, unknown>;
  const oldRemainder =
    typeof employment.accrualRemainder === 'number' ? employment.accrualRemainder : 0;
  employment.accrualRemainder = Math.max(0, Math.trunc(oldRemainder)) * WAGE_EFFICIENCY_PERCENT_SCALE;
  next.employment = employment;

  return next;
}

/**
 * v14 → v15：补给请求去重协议。
 *
 * v14 只有最多 64 条随机 UUID 请求记录，超过 64 笔后旧请求会被裁剪并可被再次执行。
 * v15 引入持久化命名空间 `operationEpoch` 与单调序号 `nextOperationSeq`：
 *  - 旧记录原样保留为 legacy 收据（protocolVersion=0、sequence=null、shopId=null），
 *    只用于历史展示/审计，**不授权旧协议再次执行**，也不猜测其序号；
 *  - 迁移时生成一次新的 operationEpoch，序号从 1 开始；
 *  - 原物品数量、现金、生存、工资等全部保持，不清空背包、不补扣钱。
 */
function upgradeV14toV15(state: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(state);
  const inventory = (next.inventory ?? {}) as Record<string, unknown>;
  const items = (inventory.items ?? {}) as Record<string, number>;
  const oldRequests = Array.isArray(inventory.requests)
    ? (inventory.requests as Array<Record<string, unknown>>)
    : [];
  const epoch =
    typeof inventory.operationEpoch === 'string' && inventory.operationEpoch.length > 0
      ? inventory.operationEpoch
      : createSupplyOperationEpoch();

  const legacy = oldRequests.map((record) => ({
    protocolVersion: 0 as const,
    sequence: null,
    requestId: typeof record.requestId === 'string' ? record.requestId : '',
    kind: record.kind === 'use' ? ('use' as const) : ('purchase' as const),
    itemId: typeof record.itemId === 'string' ? record.itemId : '',
    quantity:
      typeof record.quantity === 'number' && Number.isSafeInteger(record.quantity)
        ? record.quantity
        : 1,
    shopId: null,
    atMinute:
      typeof record.atMinute === 'number' && Number.isSafeInteger(record.atMinute)
        ? record.atMinute
        : 0,
  }));
  next.inventory = {
    items,
    operationEpoch: epoch,
    nextOperationSeq: 1,
    requests: legacy.slice(-64),
  };
  return next;
}

/** 旧的整体预留键 `${owner}:${id}` → 按单据记账的 `${owner}:${id}::legacy`。 */
function normalizeReservationKeys(state: GameState): void {
  const source = (state.finance.reservations ?? {}) as Record<string, number>;
  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!Number.isSafeInteger(value) || value <= 0) continue;
    const target = key.includes('::') ? key : `${key}::${LEGACY_REF}`;
    normalized[target] = (normalized[target] ?? 0) + value;
  }
  state.finance.reservations = normalized;
}

function normalizeGovernance(state: Record<string, unknown>): void {
  const governance = (state.governance ?? createGovernanceState()) as Record<string, unknown>;
  const proposals = (governance.proposals ?? {}) as Record<string, Array<Record<string, unknown>>>;
  const lastExternal = (governance.lastExternalProposalMinute ?? {}) as Record<string, number | null>;
  for (const [companyId, list] of Object.entries(proposals)) {
    for (const proposal of list) {
      if (proposal.origin !== 'player' && proposal.origin !== 'shareholder') {
        proposal.origin = proposal.proposedBy === 'player' ? 'player' : 'shareholder';
      }
      if (proposal.deadlineMinute === undefined) proposal.deadlineMinute = null;
      if (proposal.playerVote === undefined) proposal.playerVote = null;
      // 旧档里的外部提案没有表决窗口，按「已按旧口径结算」处理：直接标记为结束
      if (proposal.status === 'open' && proposal.origin === 'shareholder') {
        proposal.status = 'rejected';
        proposal.resolvedAtMinute = proposal.resolvedAtMinute ?? proposal.createdAtMinute;
        proposal.note = '旧档迁移：外部提案缺少表决窗口，按失效处理';
      }
    }
    if (lastExternal[companyId] === undefined) lastExternal[companyId] = null;
  }
  governance.proposals = proposals;
  governance.lastExternalProposalMinute = lastExternal;
  state.governance = governance;
}

/**
 * 作废「缺少股份基数快照」的旧报价，并释放它们各自承诺的资金。
 *
 * 旧 v6 的报价没有基数快照，无法证明稀释比例仍然成立，因此不做静默补齐；
 * 这些报价的预留都记在迁移后的 `legacy` 单据上（v6 只有按投资者汇总的预留），
 * 所以按 `legacy` 逐笔释放，不触碰其他仍在有效单据上的承诺。
 */
function expireUnverifiedQuotes(state: GameState, nowMinute: number): void {
  for (const application of Object.values(state.financing.applications)) {
    if (!application) continue;
    const stale = application.quotes.some(
      (quote) =>
        typeof quote.effectiveSharesAtQuote !== 'number' ||
        typeof quote.totalSharesAtQuote !== 'number',
    );
    if (!stale) continue;
    for (const quote of application.quotes) {
      // 只释放一个单据：v6 的承诺在 `legacy` 上，v7 之后在报价自己的 id 上。
      // 两者互斥，绝不重复释放同一笔承诺。
      const ownKey = `investor:${quote.investorId}::${quote.id}`;
      const ref = (state.finance.reservations[ownKey] ?? 0) > 0 ? quote.id : LEGACY_REF;
      releaseFunds(state.finance, 'investor', quote.investorId, quote.amountCents, ref);
    }
    if (application.status === 'quoted') {
      application.status = 'expired';
      application.decidedAtMinute = nowMinute;
      state.financing.lastDecidedMinute[application.companyId] = nowMinute;
    }
    application.quotes = [];
  }
}

/**
 * 报价 id 撞车（同一投资者、同一股数被不同公司/轮次共用）时无法判断预留归属：
 * 这些报价明确作废并释放它们共用的那份承诺，不猜测归属。
 * 唯一 id 的报价保持原样，读档不会重新生成 id。
 */
function invalidateDuplicateQuoteIds(state: GameState, nowMinute: number): void {
  const owners = new Map<string, number>();
  for (const application of Object.values(state.financing.applications)) {
    if (!application) continue;
    for (const quote of application.quotes) {
      owners.set(quote.id, (owners.get(quote.id) ?? 0) + 1);
    }
  }
  const duplicated = new Set(
    [...owners.entries()].filter(([, count]) => count > 1).map(([id]) => id),
  );
  if (duplicated.size === 0) return;

  for (const application of Object.values(state.financing.applications)) {
    if (!application) continue;
    const dropped = application.quotes.filter((quote) => duplicated.has(quote.id));
    if (dropped.length === 0) continue;
    for (const quote of dropped) {
      releaseFunds(state.finance, 'investor', quote.investorId, quote.amountCents, quote.id);
    }
    application.quotes = application.quotes.filter((quote) => !duplicated.has(quote.id));
    if (application.status === 'quoted' && application.quotes.length === 0) {
      application.status = 'expired';
      application.decidedAtMinute = nowMinute;
      state.financing.lastDecidedMinute[application.companyId] = nowMinute;
    }
  }
}

/**
 * 兜底：未决报价的资金承诺缺失或不足时，这轮报价已无法兑现。
 *
 * 不猜测补齐、也不让校验器直接拒绝整个存档：明确作废该轮报价并释放剩余承诺，
 * 玩家重新申请即可（与「报价过期」的处理完全一致）。
 */
function expireUnderReservedQuotes(state: GameState, nowMinute: number): void {
  for (const application of Object.values(state.financing.applications)) {
    if (!application || application.status !== 'quoted') continue;
    const short = application.quotes.some((quote) => {
      const key = `investor:${quote.investorId}::${quote.id}`;
      const reserved = state.finance.reservations[key] ?? 0;
      return reserved < quote.amountCents;
    });
    if (!short) continue;
    for (const quote of application.quotes) {
      releaseFunds(state.finance, 'investor', quote.investorId, quote.amountCents, quote.id);
    }
    application.quotes = [];
    application.status = 'expired';
    application.decidedAtMinute = nowMinute;
    state.financing.lastDecidedMinute[application.companyId] = nowMinute;
  }
}

/**
 * 释放已经没有业务承诺的 `legacy` 预留。
 *
 * `legacy` 只会由「把 v6 汇总预留改写成按单据记账」这一步产生；v6 的报价在迁移中
 * 全部作废，v7 起有效报价都用自己的 id 记账，因此剩下的 legacy 金额没有对应承诺。
 * 只删预留、不动余额，也不重新注资。
 */
function releaseOrphanLegacyReservations(state: GameState): void {
  for (const key of Object.keys(state.finance.reservations ?? {})) {
    if (!key.endsWith(`::${LEGACY_REF}`)) continue;
    delete state.finance.reservations[key];
  }
}

/** 证券与持仓补终止标记；发行公司已关闭的证券直接标记为终止。 */
function normalizeTermination(state: GameState): void {
  for (const [securityId, meta] of Object.entries(state.securities.meta)) {
    if (typeof meta.terminatedAtMinute !== 'number') {
      const company = meta.companyId ? state.enterprises.companies[meta.companyId] : null;
      meta.terminatedAtMinute = company && company.status === 'closed' ? (company.closedAtMinute ?? 0) : null;
    }
    const holding = state.securities.holdings[securityId];
    if (holding && typeof holding.terminatedAtMinute !== 'number') {
      holding.terminatedAtMinute =
        meta.terminatedAtMinute === null ? null : meta.terminatedAtMinute;
    }
  }
}

/**
 * 受控修复：玩家公司在旧版初始化时曾无偿把 30% 股份配给做市商。
 *
 * 只收回**能可靠识别**的无偿部分：
 *  - 无偿基数 = 初始发行股数 × 历史做市配比（旧版 createCompanyBook 的固定规则）；
 *  - 已回购进库存股的部分、玩家主动买回的部分，都算已经消化，不再收回；
 *  - 成交记录被截断（达到保留上限）时无法确认买卖，保留现状并写明数据缺口；
 *  - 只动 `sponsorGrantShares` 记录内的份额，绝不拿走其他主体真实买入的股份，
 *    也不重置任何人的持仓成本。
 */
function repairUnpaidSponsorShares(state: GameState): void {
  const grant = Math.floor(EQUITY_RULES.initialShares * EQUITY_RULES.marketMakerRatio);
  for (const book of Object.values(state.equity.books)) {
    if (book.companyId === null) {
      // 旧独立标的没有发行公司，流通量本来就来自场内
      book.sponsorGrantShares = 0;
      continue;
    }
    const company = state.enterprises.companies[book.companyId];
    if (!company) continue;
    // 已经规范化过的簿子（含本轮补建的新簿）不再参与修复，避免重复收回
    if (typeof book.sponsorGrantShares === 'number') continue;
    const deskShares = sharesOf(book, 'market-maker');

    if (company.role !== 'player') {
      // 三家 AI 的历史股权是既定配置，允许保留做市库存；只记录无偿份额以便审计
      book.sponsorGrantShares = Math.min(deskShares, grant);
      continue;
    }

    const trades = state.securities.trades[book.securityId] ?? [];
    const logComplete = trades.length < LIQUIDITY_RULES.tradeLogLimit;
    if (!logComplete) {
      book.sponsorGrantShares = Math.min(deskShares, grant);
      book.historyNote = appendNote(
        book.historyNote,
        '无偿配股修复未执行：成交记录已达保留上限，无法确认哪些股份来自真实买卖（数据缺口）',
      );
      continue;
    }

    // 先按旧版固定规则记录「无偿份额」，再在它的范围内收回，避免越界拿走真实买入的股份
    book.sponsorGrantShares = Math.min(deskShares, grant);
    let boughtByPlayer = 0;
    for (const trade of trades) {
      if (trade.side === 'buy') boughtByPlayer += trade.shares;
    }
    const reclaimable = Math.max(
      0,
      book.sponsorGrantShares - book.buybackTotalShares - boughtByPlayer,
    );
    const recalled = recallSponsorShares(book, 'market-maker', 'player', reclaimable);
    if (recalled > 0) {
      // 股权簿与证券持仓必须一致：退回的股份同步进玩家持仓，成本口径不变
      const holding = state.securities.holdings[book.securityId];
      if (holding) holding.shares += recalled;
      book.historyNote = appendNote(
        book.historyNote,
        `受控修复：收回无偿配给做市商的 ${recalled} 股给创始股东（未改动任何人的持仓成本）`,
      );
    }
    if (book.sponsorGrantShares > 0) {
      book.historyNote = appendNote(
        book.historyNote,
        `仍有 ${book.sponsorGrantShares} 股无偿份额无法与真实买入区分，保留现状并记录缺口`,
      );
    }
  }
}

/**
 * v15 旧政治群体的历史权重：只用于把 4 个旧群体的满意度折叠成一个整体值。
 * 旧「综合务实」不等于新「生活成本与消费」，迁移不靠改名伪装完成。
 */
const LEGACY_POLITICAL_GROUP_RATIOS: Readonly<Record<string, number>> = {
  innovation: 0.22,
  employment: 0.3,
  service: 0.28,
  pragmatic: 0.2,
};

/** 从 `term-<序号>` 解析单调任期序号；非法返回 0（0 永远不会被当作已判断任期）。 */
function termOrdinalOf(termId: string): number {
  const match = /^term-(\d+)$/.exec(termId);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** 当前在任任期（endMinute === null 的最后一条）。 */
function currentTermRecordOf(
  government: Record<string, unknown>,
): Record<string, unknown> | null {
  const terms = Array.isArray(government.terms)
    ? (government.terms as Array<Record<string, unknown>>)
    : [];
  for (let index = terms.length - 1; index >= 0; index -= 1) {
    const term = terms[index]!;
    if (term.endMinute === null || term.endMinute === undefined) return term;
  }
  return null;
}

function policyIdOf(value: unknown): PolicyId | null {
  return value === 'innovation' || value === 'employment' || value === 'infrastructure'
    ? value
    : null;
}

function candidateIdOf(value: unknown): CandidateId | null {
  if (typeof value !== 'string') return null;
  return CANDIDATES.some((candidate) => candidate.id === value) ? (value as CandidateId) : null;
}

/**
 * v15 → v16：城市统计与指数、12 交叉政治群体、任期属性快照、逻辑城区与建设阶段。
 *
 * 保留要求（逐条）：
 *  - 金钱、股份、公司、工资、生存、背包、赞助资源、选举日程与人物坐标全部保持原值；
 *  - 原六栋建筑迁为稳定基础布局（不随机重建、不改交互 id、不动模型路径）；
 *  - 不追溯触发过去任期的建设：当前在任任期标记为「接入前任期、不补做建设判断」；
 *  - 当前负责人不变，按其现有效果建立任期快照；
 *  - 旧政治满意度先按原群体权重求整体值，再用 50 × (旧值 + 1) 映射为新群体初值；
 *    保留旧选举历史，不重算历史票数；提前选举连续计数从零开始；
 *  - 基础 GDP 用本版本标准开局条件生成背景估算，不把玩家当前高价产品反推为过去一年产出；
 *  - 接入前不可恢复的历史真实经营累计不凭空追记（累计产出从 0 开始）；
 *  - 观察起点之前尚未入账的销售区间写入同源销售投影基线，之后首次结算/预览时扣除；
 *  - 指数从迁移时刻 100 开始，后续保持连续。
 */
function upgradeV15toV16(state: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(state);
  const clock = (next.clock ?? {}) as Record<string, unknown>;
  const rawMinute = typeof clock.totalMinute === 'number' ? clock.totalMinute : 0;
  const nowMinute = Number.isSafeInteger(rawMinute) && rawMinute > 0 ? rawMinute : 0;
  const monthKey = dateAtMinute(nowMinute, CALENDAR).monthKey;

  // 1) 逻辑地图：基础城区由既有 CITY 配置建立，不随机
  next.cityLayout = createBaseLayout();

  // 2) 政府任期属性快照（保留负责人，按现有效果建立快照，当前任期标记接入）
  normalizeGovernmentTermsV16(next);

  // 3) 政治：旧 4 群体 → 整体值 → 12 个新群体初值；提前选举计数从零开始
  next.politics = createPoliticsStateFromLegacy(legacyOverallSatisfaction(next.politics));

  // 4) 统计与指数：基础 GDP 用标准开局条件；指数从迁移时刻 100 开始
  const baseGdpCents = estimateStandardBaseGdpCents();
  next.cityStatistics = createCityStatisticsState({
    base: {
      gdpCents: baseGdpCents,
      ruleVersion: CITY_ECONOMY_RULE_VERSION,
      generatedAtMinute: nowMinute,
      source: 'migration',
      note:
        '旧档接入：基础 GDP 使用本版本标准开局条件（AI 开局在售产品与标准人口偏好）生成背景估算，' +
        '不使用玩家当前产品反推；接入前不可恢复的历史真实经营累计不追记',
    },
    nowMinute,
    monthKey,
  });

  // 5) 建设：接入前任期，不补做建设判断
  next.cityDevelopment = createCityDevelopmentState(baseGdpCents);

  // 6) 世界存档版本随布局结构升级（布局本体在独立切片里，不写 Three.js 对象）
  const world = (next.world ?? {}) as Record<string, unknown>;
  world.revision = 3;
  next.world = world;

  const draft = next as unknown as GameState;

  // 7) 迁移前待结算基线：同源销售投影，之后首次结算/实时投影时扣除；
  //    不提前收付款、不修改企业销售游标。
  for (const company of Object.values(draft.enterprises.companies)) {
    if (isClosed(company)) continue;
    const plan = computeSalesPlan(draft, company.id, nowMinute);
    if (plan.revenueCents > 0) {
      setBaselinePending(draft.cityStatistics, company.id, plan.revenueCents, nowMinute);
    }
  }

  // 8) 指数窗口从迁移时刻固定样本（之后月中新上市的下个月才进样本）
  beginCityIndexMonth(draft, monthKey, nowMinute);

  // 9) 当前任期写高水位：下一次真实成功选举才进入新机制
  const government = (next.government ?? {}) as Record<string, unknown>;
  const currentTerm = currentTermRecordOf(government);
  const currentTermId = currentTerm && typeof currentTerm.id === 'string' ? currentTerm.id : '';
  adoptLegacyDevelopment(draft, termOrdinalOf(currentTermId), nowMinute);

  // 10) 提前选举保护期从接入时刻起算，计数为 0（不伪造过去不满月份）
  if (currentTermId) {
    noteNewTerm(
      draft.politics,
      currentTermId,
      nowMinute,
      EARLY_ELECTION_RULES.protectionDays,
    );
  }

  return next;
}

/** 旧 4 群体满意度的权重整体值（[-1,1]）。 */
function legacyOverallSatisfaction(politics: unknown): number {
  const groups =
    politics && typeof politics === 'object'
      ? ((politics as Record<string, unknown>).groups as Record<string, unknown> | undefined)
      : undefined;
  let weighted = 0;
  let weightSum = 0;
  for (const [groupId, ratio] of Object.entries(LEGACY_POLITICAL_GROUP_RATIOS)) {
    const row =
      groups && typeof groups[groupId] === 'object'
        ? (groups[groupId] as Record<string, unknown>)
        : null;
    const raw = row && typeof row.satisfaction === 'number' ? row.satisfaction : 0;
    const value = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
    weighted += ratio * value;
    weightSum += ratio;
  }
  return weightSum > 0 ? weighted / weightSum : 0;
}

/**
 * 任期属性快照补齐：历史记录补 direction/effects/configVersion/source，
 * 当前在任记录标记为接入前任期（不补做建设判断），当前负责人不变。
 */
function normalizeGovernmentTermsV16(state: Record<string, unknown>): void {
  const government = (state.government ?? {}) as Record<string, unknown>;
  const terms = Array.isArray(government.terms)
    ? (government.terms as Array<Record<string, unknown>>)
    : [];

  let currentTermId = '';
  for (const term of terms) {
    const personId = typeof term.personId === 'string' ? term.personId : 'caretaker';
    const direction = candidateIdOf(personId);
    const policy = policyIdOf(term.policy);
    term.direction = direction;
    term.effects = policyEffectsFor(policy);
    term.configVersion = GOVERNMENT_CONFIG_VERSION;
    const ended = term.endMinute !== null && term.endMinute !== undefined;
    if (!ended) {
      currentTermId = typeof term.id === 'string' ? term.id : '';
      term.source = 'migration';
      term.note = appendNote(
        typeof term.note === 'string' ? term.note : null,
        '接入前任期：不补做建设判断（下一次真实成功选举才进入新机制）',
      );
    } else {
      term.source = direction ? 'election' : 'caretaker';
    }
  }

  const holder = government.currentHolder as Record<string, unknown> | null | undefined;
  if (holder && typeof holder === 'object') {
    holder.termId = currentTermId;
    holder.direction = candidateIdOf(holder.candidateId);
    holder.effects = policyEffectsFor(policyIdOf(holder.policy));
  }

  government.offices = [
    {
      id: 'chief-executive',
      title: GOVERNMENT_OFFICE_TITLE,
      holderPersonId:
        holder && typeof holder.personId === 'string' ? holder.personId : null,
    },
  ];
  state.government = government;
}

function appendNote(current: string | null, extra: string): string {
  return current ? `${current}；${extra}` : extra;
}

export /**
 * v16 → v17：房地产与宏观住房切片。
 *
 * 保留要求（逐条）：
 *  - 金钱、股份、公司、工资、生存、背包、赞助、选举、政府任期、建设历史、人物坐标全部保持原值；
 *  - 群组家庭数由**迁移时刻**的阶层人数派生，不追溯过去增长、不伪造历史成交；
 *  - 卖方与 AI 的资金一次性注入（真实主体账户 + 明确流水），只在迁移时发生一次；
 *  - 晴川公寓 100 套（1 套永久居住权 + 99 套可售）、4 块储备土地一次性建立；
 *  - 初始 99 套的保护期使用「开局第 7 个月月初」的绝对时刻：已经过了该时刻的旧档
 *    不会重新获得整段保护期；
 *  - 已完成的住房新区按实际布局补齐住宅单元，幂等，不重复交房；
 *  - 不重写历史月报、不追溯退款、不减免旧房租；旧生活欠款原样保留。
 */
function upgradeV16toV17(state: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(state);
  const clock = (next.clock ?? {}) as Record<string, unknown>;
  const rawMinute = typeof clock.totalMinute === 'number' ? clock.totalMinute : 0;
  const nowMinute = Number.isSafeInteger(rawMinute) && rawMinute > 0 ? rawMinute : 0;
  const draft = next as unknown as GameState;

  draft.housing = createHousingState(draft.population.classes, nowMinute);
  draft.realEstate = createRealEstateState();

  // 真实主体账户 + 存量 + 卖方挂牌：按账户/建筑/地块 id 判重，重复解析同一份旧档不会重复注资
  seedRealEstateWorld(draft, nowMinute);

  // 已完成的住房新区补齐单元（幂等）：来源是真实布局与永久完成记录，不虚构不存在的建设
  for (const district of draft.cityLayout.districts) {
    if (district.stage < 0) continue;
    deliverDistrictHousing(draft, district.id, district.completedAtMinute);
  }

  return next;
}

/** v17 → v18：为每处资产保留挂牌版本高水位，既有挂牌保持原版本。 */
export function upgradeV17toV18(state: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(state);
  const estate = next.realEstate as { properties: Array<{ listing: { version: number } | null; listingVersion?: number }> };
  for (const property of estate.properties) property.listingVersion = property.listing?.version ?? 0;
  return next;
}

export function migrateIfNeeded(
  root: Record<string, unknown>,
  version: number,
): { state: unknown; migratedFrom: number | null } {
  if (version === SAVE.formatVersion) {
    return { state: root.state, migratedFrom: null };
  }
  if (version > SAVE.formatVersion) {
    fail(`存档版本 ${version} 高于当前版本 ${SAVE.formatVersion}，无法读取`);
  }

  let state = root.state as Record<string, unknown>;
  let cursor = version;
  if (cursor === 1) {
    state = upgradeV1toV2(state);
    cursor = 2;
  }
  if (cursor === 2) {
    state = upgradeV2toV3(state);
    cursor = 3;
  }
  if (cursor === 3) {
    state = upgradeV3toV4(state);
    cursor = 4;
  }
  if (cursor === 4) {
    state = upgradeV4toV5(state);
    cursor = 5;
  }
  if (cursor === 5) {
    state = upgradeV5toV6(state);
    cursor = 6;
  }
  if (cursor === 6) {
    state = upgradeV6toV7(state);
    cursor = 7;
  }
  if (cursor === 7) {
    state = upgradeV7toV8(state);
    cursor = 8;
  }
  if (cursor === 8) {
    state = upgradeV8toV9(state);
    cursor = 9;
  }
  if (cursor === 9) {
    state = upgradeV9toV10(state);
    cursor = 10;
  }
  if (cursor === 10) {
    state = upgradeV10toV11(state);
    cursor = 11;
  }
  if (cursor === 11) {
    state = upgradeV11toV12(state);
    cursor = 12;
  }
  if (cursor === 12) {
    state = upgradeV12toV13(state);
    cursor = 13;
  }
  if (cursor === 13) {
    state = upgradeV13toV14(state);
    cursor = 14;
  }
  if (cursor === 14) {
    state = upgradeV14toV15(state);
    cursor = 15;
  }
  if (cursor === 15) {
    state = upgradeV15toV16(state);
    cursor = 16;
  }
  if (cursor === 16) {
    state = upgradeV16toV17(state);
    cursor = 17;
  }
  if (cursor === 17) {
    state = upgradeV17toV18(state);
    cursor = 18;
  }
  if (cursor !== SAVE.formatVersion) {
    fail(`不支持的存档版本 ${version}`);
  }
  return { state, migratedFrom: version };
}

/**
 * 读档后的兼容性规范化（与版本迁移分开，每次读档都执行）。
 *
 * 目前只处理游戏速度：
 *  - `clock.speed` 是运行与展示的唯一权威，`settings.speed` 只是历史兼容镜像（字段保留、不参与运行）；
 *  - 时钟本身非法时**不**用镜像去掩盖，交给校验器拒绝；
 *  - 时钟合法但两值不一致时，用时钟对齐镜像。
 *
 * 这不是格式变化，因此不升级存档版本。
 */
export function normalizeLoadedState(state: Record<string, unknown>): void {
  const clock = state.clock;
  if (!clock || typeof clock !== 'object') return;
  const speed = (clock as Record<string, unknown>).speed;
  if (typeof speed !== 'number' || !isValidSpeed(speed)) return;
  const settings = state.settings;
  if (!settings || typeof settings !== 'object') return;
  (settings as Record<string, unknown>).speed = speed;
}
