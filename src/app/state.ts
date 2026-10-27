/**
 * 应用层状态定义 —— 把各业务切片组装成一份完整、可序列化的游戏状态。
 *
 * 只有本文件与 app 层知道所有业务切片的存在；core 保持业务无关，
 * 各业务模块只认识自己的切片。
 *
 * 股权是「谁持有多少股」的唯一权威；玩家持仓（成本/已实现盈亏）另存于证券切片，
 * 两边的股数由交易函数在同一提交里同步，并在存档校验时核对一致。
 */

import type { DeepReadonly } from '../core/readonly';
import { dateAtMinute } from '../core/calendar';
import { createClockState, type ClockState } from '../core/clock';
import { AI_COMPANIES } from '../content/business';
import {
  EQUITY_RULES,
  INVESTORS,
  LIQUIDITY_RULES,
  VALUATION_RULES,
} from '../content/capital';
import { ECONOMY, MARKET, TIME } from '../content/config';
import { CITY_ECONOMY_RULE_VERSION } from '../content/city-economy';
import {
  createCityStatisticsState,
  type CityStatisticsState,
} from '../features/city-statistics';
import { createBaseLayout, type CityLayoutState } from '../features/city-layout';
import {
  createCityDevelopmentState,
  type CityDevelopmentState,
} from '../features/city-development';
import { computeBaseGdpCents } from './city-statistics';
import { seedRealEstateWorld } from './real-estate';
import { beginCityIndexMonth } from './city-stock-index';
import { noteTermStarted } from './politics-simulation';
import { createEmploymentState, type EmploymentState } from '../features/employment';
import {
  createEnvironmentState,
  type EnvironmentState,
} from '../features/environment';
import { createHousingState, type HousingState } from '../features/housing';
import {
  createRealEstateState,
  playerPropertyValueOf,
  type RealEstateState,
} from '../features/real-estate';
import {
  bookOfCompany,
  createCompanyBook,
  createEquityState,
  createStandaloneBook,
  effectiveShares,
  sharesOf,
  type EquityState,
  type ShareBook,
} from '../features/equity';
import {
  createEnterprise,
  createEnterpriseState,
  playerEnterprise,
  type Enterprise,
  type EnterpriseState,
} from '../features/enterprise';
import {
  createFinanceState,
  openBusinessAccount,
  openSubjectAccount,
  type FinanceState,
  type TransactionCategory,
} from '../features/finance';
import {
  createFinancingState,
  type FinancingState,
} from '../features/financing';
import { createGovernanceState, type GovernanceState } from '../features/governance';
import { investorAccountId } from '../features/investors';
import { createLivingState, type LivingState } from '../features/living';
import { createInventoryState, type InventoryState } from '../features/inventory';
import { createSurvivalState, type SurvivalState } from '../features/survival';
import { createLoanState, type LoanState } from '../features/loan';
import { createPopulationState, type PopulationState } from '../features/population';
import { createPoliticsState, type PoliticsState } from '../features/politics';
import { createElectionState, type ElectionState } from '../features/elections';
import { createGovernmentState, type GovernmentState } from '../features/government';
import { ELECTION_RULES } from '../content/government';
import { createPromotionState, type PromotionState } from '../features/promotion';
import {
  createHolding,
  createMarket,
  createSecuritiesState,
  marketOf,
  registerSecurity,
  type PlayerHolding,
  type SecuritiesState,
} from '../features/stock';
import { createTalentState, type TalentState } from '../features/talent';
import {
  addSeedProduct,
  createTechnologyState,
  ensureTechCompany,
  type TechnologyState,
} from '../features/technology';

/** AI 决策记忆：只保存「上次决策时刻」与产品命名序号，不保存未来信息。 */
export interface BusinessAiState {
  companies: Record<string, { lastDecisionMinute: number | null; productSeq: number }>;
}

export interface SettlementState {
  /** 已完成结算的月份（YYYY-MM），防止重复结算。 */
  settledMonths: string[];
  lastSettledMonth: string | null;
}

export interface MonthReportLine {
  readonly category: TransactionCategory;
  readonly income: number;
  readonly expense: number;
}

export interface MonthReport {
  readonly monthKey: string;
  readonly settledAtMinute: number;
  readonly income: number;
  readonly expense: number;
  readonly net: number;
  readonly salary: number;
  readonly rent: number;
  readonly living: number;
  readonly debtRepaid: number;
  readonly newDebt: number;
  readonly endCash: number;
  readonly endSavings: number;
  readonly endWagesOwed: number;
  readonly endDebt: number;
  readonly breakdown: MonthReportLine[];
}

export interface GameSettings {
  speed: number;
}

/** 只读视图类型：查询、视图与估值只能拿到这个，不能写正式状态。 */
export type ReadonlyGameState = DeepReadonly<GameState>;

export interface GameState {
  clock: ClockState;
  finance: FinanceState;
  employment: EmploymentState;
  living: LivingState;
  /** 人物饱食度/水分（内部单位整数，唯一权威）。 */
  survival: SurvivalState;
  /** 背包物品数量与购买/使用去重记录。 */
  inventory: InventoryState;
  /** 所有证券的行情、持仓与成交记录（含旧的独立标的）。 */
  securities: SecuritiesState;
  equity: EquityState;
  financing: FinancingState;
  governance: GovernanceState;
  promotion: PromotionState;
  loan: LoanState;
  population: PopulationState;
  /** 政治群体比例、偏好与满意度（与经济阶层分开）。 */
  politics: PoliticsState;
  /** 竞选状态机、候选人资源、赞助单据与选举结果。 */
  elections: ElectionState;
  /** 政府机构、职位、任职记录与当前生效政策。 */
  government: GovernmentState;
  enterprises: EnterpriseState;
  technology: TechnologyState;
  talent: TalentState;
  businessAi: BusinessAiState;
  settlement: SettlementState;
  reports: MonthReport[];
  settings: GameSettings;
  /** 经营产出统计、基础 GDP、全市场指数观察与月度快照（不控制企业/人口/股票）。 */
  cityStatistics: CityStatisticsState;
  /** 逻辑地图：边界、道路、地块、建筑与稳定标识（不含 Three.js / DOM / 经济结算）。 */
  cityLayout: CityLayoutState;
  /** 建设门槛、每任期一次建设判断、项目与永久建设历史（不创建 Three.js 对象）。 */
  cityDevelopment: CityDevelopmentState;
  /** 产权、入住、挂牌、AI 土地报价与成交记录（不保存余额）。 */
  realEstate: RealEstateState;
  /** 3 个收入群组的家庭数、居住分配、购房意愿与月度住房指标（不保存余额与人口权威）。 */
  housing: HousingState;
  /**
   * 天气切片：当前天气、过渡起点、下次调度时刻与天气专用随机游标。
   * 太阳方向、天空颜色、雾距离与环境光都由游戏时间推导，不在这里重复保存。
   */
  environment: EnvironmentState;
}

const MAX_REPORTS = 24;

export function createInitialState(): GameState {
  const clock = createClockState();
  // 人口先建立：住房群组的家庭数由阶层人数派生，不另存第二份人口
  const population = createPopulationState(clock.totalMinute);
  const state: GameState = {
    clock,
    finance: createFinanceState({
      cash: ECONOMY.initialCash,
      savings: ECONOMY.initialSavings,
    }),
    employment: createEmploymentState(),
    living: createLivingState(),
    survival: createSurvivalState(),
    inventory: createInventoryState(),
    securities: createSecuritiesState(),
    equity: createEquityState(),
    financing: createFinancingState(),
    governance: createGovernanceState(),
    promotion: createPromotionState(),
    loan: createLoanState(),
    population,
    politics: createPoliticsState(),
    // 首次投票在第 30 天 08:00。开局是第 1 天 08:00（totalMinute = 0），
    // 两者时刻相同，所以相对开局是「第 30 天 − 第 1 天」= 29 个游戏日，
    // 不能再额外加一次 08:00 偏移（那会变成第 30 天 16:00）。
    // 这里用日历配置表达「同月同日时刻」，不写第二套日历。
    elections: createElectionState(
      clock.totalMinute,
      (ELECTION_RULES.firstElectionDay - 1) * TIME.calendar.minutesPerDay +
        (ELECTION_RULES.firstElectionMinuteOfDay - TIME.calendar.start.minuteOfDay),
    ),
    government: createGovernmentState(clock.totalMinute),
    enterprises: createEnterpriseState(),
    technology: createTechnologyState(),
    talent: createTalentState(),
    businessAi: { companies: {} },
    settlement: { settledMonths: [], lastSettledMonth: null },
    reports: [],
    settings: { speed: 1 },
    // 基础 GDP 依赖「初始企业与在售产品」，因此在下面 seed 完成后填入真实值；
    // 逻辑地图与建设切片不依赖企业，直接建立。
    cityStatistics: createCityStatisticsState({
      base: {
        gdpCents: 0,
        ruleVersion: CITY_ECONOMY_RULE_VERSION,
        generatedAtMinute: 0,
        source: 'new-game',
        note: '正在初始化',
      },
      nowMinute: 0,
      monthKey: '1970-01',
    }),
    cityLayout: createBaseLayout(),
    cityDevelopment: createCityDevelopmentState(0),
    realEstate: createRealEstateState(),
    housing: createHousingState(population.classes, 0),
    environment: createEnvironmentState(clock.totalMinute),
  };
  // 房地产世界：产权主体账户（真实资金）、晴川公寓存量、储备土地与卖方挂牌。
  // 只在初始化时执行一次；重复调用按账户/建筑/地块 id 判重，不会重复注资或重复发房。
  seedRealEstateWorld(state, clock.totalMinute);
  seedLegacySecurity(state, clock.totalMinute);
  seedCapitalWorld(state, clock.totalMinute);
  // 三家 AI 公司从开局起独立经营、已完成历史融资并上市；玩家不获得公司或资金
  seedBusinessWorld(state, clock.totalMinute);
  AI_COMPANIES.forEach((config, index) => {
    seedListedCompanyCapital(state, config.id, index, clock.totalMinute);
  });
  // 企业初始化完成之后才估算基础 GDP：G0 只生成一次，读档不重算
  const monthKey = dateAtMinute(clock.totalMinute, TIME.calendar).monthKey;
  state.cityStatistics = createCityStatisticsState({
    base: {
      gdpCents: computeBaseGdpCents(state),
      ruleVersion: CITY_ECONOMY_RULE_VERSION,
      generatedAtMinute: clock.totalMinute,
      source: 'new-game',
      note:
        '开局基础 GDP：用既有 estimateSales 口径估算各本地在售产品的预计日产出 × 360；' +
        '不推进时间、不发钱、不写产品历史、不伪造经营月报',
    },
    nowMinute: clock.totalMinute,
    monthKey,
  });
  state.cityDevelopment = createCityDevelopmentState(state.cityStatistics.base.gdpCents);
  // 首个指数观察窗口从开局时刻固定样本（否则首月没有任何样本、指数停在 100 且无意义）
  beginCityIndexMonth(state, monthKey, clock.totalMinute);
  // 新政府的提前选举保护期从开局过渡任期开始计算（不是从「没有任期」开始）
  const firstTerm = state.government.terms[0];
  if (firstTerm) noteTermStarted(state, firstTerm.id, clock.totalMinute);
  return state;
}

export function trimReports(state: GameState): void {
  if (state.reports.length > MAX_REPORTS) {
    state.reports.splice(0, state.reports.length - MAX_REPORTS);
  }
}

/* ------------------------------------------------------------ 派生查询 */

/**
 * 玩家在某只证券上的持股数量 —— **唯一**只读口径。
 *
 * 所有权的权威记录是 `equity` 股权簿（键就是证券 id）；`securities.holdings.shares`
 * 只是同次提交同步的兼容镜像。因此展示、汇总、交易预览都从这里取股数，
 * 不再自己读副本，避免出现「卡片显示 A 股、股权表显示 B 股」。
 *
 * 纯读取：不补建持股、不改任何状态。真正的缺失（有持仓却无股权簿）由读档校验拒绝，
 * 这里返回 0 只是查询语义上的「没有股份」。
 */
export function playerSharesOf(
  state: GameState | ReadonlyGameState,
  securityId: string,
): number {
  const book = state.equity.books[securityId];
  if (!book) return 0;
  return sharesOf(book, 'player');
}

/**
 * 玩家在某只证券上的持仓视图：**股数取股权簿**，成本/已实现盈亏/成交笔数/终止标记取证券切片。
 *
 * 返回新建的只读快照，不是状态里的对象，所以调用方无法借它改状态；
 * 两边股数不一致时也不会在此处静默覆盖任何一方 —— 由读档校验负责拒绝。
 */
export function playerHoldingOf(
  state: GameState | ReadonlyGameState,
  securityId: string,
): DeepReadonly<PlayerHolding> {
  const holding = state.securities.holdings[securityId];
  return {
    shares: playerSharesOf(state, securityId),
    totalCost: holding?.totalCost ?? 0,
    realizedPnl: holding?.realizedPnl ?? 0,
    trades: holding?.trades ?? 0,
    terminatedAtMinute: holding?.terminatedAtMinute ?? null,
  };
}

/**
 * 单只证券的个人持仓市值（分）。
 *
 * 统一口径：股数取股权簿；证券终止（发行公司已清算）或持仓已终止时为 0。
 * 个人财务、卡片与浮窗都从这里取值，不允许各自再写例外。
 */
export function securityValueOf(
  state: GameState | ReadonlyGameState,
  securityId: string,
): number {
  const shares = playerSharesOf(state, securityId);
  if (shares <= 0) return 0;
  const holding = state.securities.holdings[securityId];
  if ((holding?.terminatedAtMinute ?? null) !== null) return 0;
  const meta = state.securities.meta[securityId];
  if ((meta?.terminatedAtMinute ?? null) !== null) return 0;
  const market = marketOf(state.securities, securityId);
  if (!market) return 0;
  return shares * market.price;
}

/** 全部证券的持仓市值（分）。上市公司的股份价值只在这里计一次。 */
export function stockValue(
  state: GameState | ReadonlyGameState): number {
  let total = 0;
  for (const securityId of Object.keys(state.securities.markets)) {
    total += securityValueOf(state, securityId);
  }
  return total;
}

/** 未偿贷款本息合计（分）。已结清或无贷款时为 0。 */
export function loanLiability(
  state: GameState | ReadonlyGameState): number {
  const contract = state.loan.contract;
  if (!contract || contract.status === 'settled') return 0;
  return contract.outstanding + contract.accruedInterest;
}

/** 玩家持有股份的所有公司（含已清算，界面按状态区分）。 */
export function playerCompanies(state: GameState): Enterprise[];
export function playerCompanies(state: ReadonlyGameState): readonly DeepReadonly<Enterprise>[];
export function playerCompanies(
  state: GameState | ReadonlyGameState,
): (Enterprise | DeepReadonly<Enterprise>)[] {
  const rows: (Enterprise | DeepReadonly<Enterprise>)[] = [];
  for (const company of Object.values(state.enterprises.companies)) {
    const book = bookOfCompany(state.equity, company.id);
    if (book && sharesOf(book, 'player') > 0) rows.push(company);
  }
  return rows;
}

/**
 * 玩家当前**有管理权**的公司：CEO 身份是玩家、且公司未清算。
 *
 * 刻意不以「玩家仍持股」为前提：卖光股份不会自动撤职，
 * 职位只能由治理流程（董事会表决）改变。持股比例另由股权簿回答。
 */
export function managedCompany(state: GameState): Enterprise | null;
export function managedCompany(state: ReadonlyGameState): DeepReadonly<Enterprise> | null;
export function managedCompany(
  state: GameState | ReadonlyGameState,
): Enterprise | null | DeepReadonly<Enterprise> | null {
  for (const company of Object.values(state.enterprises.companies)) {
    if (company.status === 'closed') continue;
    const book = bookOfCompany(state.equity, company.id);
    if (book?.ceoId === 'player') return company;
  }
  return null;
}

/** 玩家以 CEO 身份管理的全部公司（首轮最多一家，用列表表达限制而不是隐藏第二家）。 */
export function managedCompanies(state: GameState): Enterprise[];
export function managedCompanies(state: ReadonlyGameState): readonly DeepReadonly<Enterprise>[];
export function managedCompanies(
  state: GameState | ReadonlyGameState,
): (Enterprise | DeepReadonly<Enterprise>)[] {
  const rows: (Enterprise | DeepReadonly<Enterprise>)[] = [];
  for (const company of Object.values(state.enterprises.companies)) {
    if (company.status === 'closed') continue;
    const book = bookOfCompany(state.equity, company.id);
    if (book?.ceoId === 'player') rows.push(company);
  }
  return rows;
}

/** 玩家股东身份可访问的公司：持股或任职（任免与投票用）。 */
export function shareholderCompanies(state: GameState): Enterprise[];
export function shareholderCompanies(state: ReadonlyGameState): readonly DeepReadonly<Enterprise>[];
export function shareholderCompanies(
  state: GameState | ReadonlyGameState,
): (Enterprise | DeepReadonly<Enterprise>)[] {
  const rows: (Enterprise | DeepReadonly<Enterprise>)[] = [];
  for (const company of Object.values(state.enterprises.companies)) {
    const book = bookOfCompany(state.equity, company.id);
    if (!book) continue;
    if (sharesOf(book, 'player') > 0 || book.ceoId === 'player') rows.push(company);
  }
  return rows;
}

/**
 * 玩家在**未上市公司**上的账面权益：持股比例 × 非负净资产。
 * 已上市公司不在这里计（其价值通过证券市场价值计算，避免重复）。
 * 已清算公司计 0：未清偿部分不追索个人资金。
 */
export function unlistedEquity(
  state: GameState | ReadonlyGameState): number {
  let total = 0;
  for (const company of playerCompanies(state)) {
    if (company.status === 'closed') continue;
    const book = bookOfCompany(state.equity, company.id);
    if (!book || book.listed) continue;
    const shares = sharesOf(book, 'player');
    const base = effectiveShares(book);
    if (base <= 0) continue;
    const cash = state.finance.businessAccounts[company.id] ?? 0;
    const payables =
      company.payrollDue + company.cogsDue + company.marketingDue + company.opexDue + company.supplyDue;
    const net = Math.max(0, cash - payables);
    total += Math.round((net * shares) / base);
  }
  return total;
}

/**
 * 玩家持有物业（住宅 + 土地）的参考估值合计。
 *
 * 只计**产权属于玩家**的物业：永久居住权不属于玩家产权，因此不计入个人净资产；
 * 估值只在这里计一次，不额外加「未来出售收入」或重复加房屋本身。
 */
export function propertyValueOf(state: GameState | ReadonlyGameState): number {
  return playerPropertyValueOf(state.realEstate);
}

/**
 * 净资产 = 现金 + 银行存款 + 未发工资 + 证券市值 + 未上市股权账面权益 + 持有物业估值
 *          − 生活欠款 − 未偿贷款本息。
 *
 * 上市公司股份只在证券市值里计一次；未上市股权只在账面权益里计一次；
 * 物业只在估值里计一次（永久居住权不计）。
 */
export function netWorth(
  state: GameState | ReadonlyGameState): number {
  return (
    state.finance.accounts.cash +
    state.finance.accounts.savings +
    state.employment.accruedWages +
    stockValue(state) +
    unlistedEquity(state) +
    propertyValueOf(state) -
    state.living.debt -
    loanLiability(state)
  );
}

/** 可用资金 = 现金 + 银行存款（未发工资、股票市值不可直接支付）。 */
export function availableFunds(
  state: GameState | ReadonlyGameState): number {
  return state.finance.accounts.cash + state.finance.accounts.savings;
}

/* ------------------------------------------------------------ 世界组装 */

/** 稳定伪随机种子：同一 id 永远得到同一初始随机状态。 */
function seedFromId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 证券代码：AI 公司按固定前缀编号，保证稳定。 */
function symbolFor(index: number): string {
  return `TK-${String.fromCharCode(65 + index)}1`;
}

/**
 * 旧独立标的部分：保留原证券 ID、价格、随机状态、持仓与 K 线。
 * 它没有发行公司，所以股权簿的 companyId 为 null，股份来自既有场内流通量。
 */
export function seedLegacySecurity(state: GameState, nowMinute: number): void {
  const securityId = MARKET.symbol;
  if (state.securities.markets[securityId]) return;
  registerSecurity(
    state.securities,
    { id: securityId, symbol: MARKET.symbol, name: MARKET.name, companyId: null },
    createMarket(MARKET.initialPriceCents, nowMinute, MARKET.initialSeed),
  );
  if (!state.equity.books[securityId]) {
    createStandaloneBook(state.equity, {
      securityId,
      holderId: 'player',
      holderShares: state.securities.holdings[securityId]?.shares ?? 0,
      marketMakerId: 'market-maker',
    });
  }
}

/** 投资者与做市商的真实资金账户：只在第一次调用时注入，重复调用不会再加钱。 */
export function seedCapitalWorld(state: GameState, nowMinute: number): void {
  const now = dateAtMinute(nowMinute, TIME.calendar);
  const ctx = { atMinute: nowMinute, monthKey: now.monthKey };
  for (const investor of INVESTORS) {
    const id = investorAccountId(investor.id);
    if (state.finance.subjectAccounts[`investor:${id}`] !== undefined) continue;
    openSubjectAccount(state.finance, 'investor', id, investor.initialCashCents, ctx, '机构投资者初始资金');
  }
  if (state.finance.subjectAccounts[`market:${'desk'}`] === undefined) {
    openSubjectAccount(
      state.finance,
      'market',
      'desk',
      LIQUIDITY_RULES.deskCashCents,
      ctx,
      '做市商初始资金',
    );
  }
}

/**
 * 初始化三家 AI 公司：独立企业账户、明确的开局注资流水、固定科技水平、首款在售产品，
 * 以及「本来就已完成历史融资并上市」的股权与证券关系。
 *
 * 历史融资只写说明与股权，不对应任何新现金流水 —— 这些公司的现金来自开局注资，
 * 不能因为「补造一轮融资」再免费注资一次。
 */
export function seedBusinessWorld(state: GameState, nowMinute: number): void {
  const now = dateAtMinute(nowMinute, TIME.calendar);
  const ctx = { atMinute: nowMinute, monthKey: now.monthKey };

  AI_COMPANIES.forEach((config) => {
    if (state.enterprises.companies[config.id]) return;
    const company = createEnterprise({
      id: config.id,
      role: 'ai',
      name: config.name,
      nowMinute,
      monthKey: now.monthKey,
    });
    state.enterprises.companies[config.id] = company;

    const tech = ensureTechCompany(state.technology, config.id);
    tech.accumulation = config.techLevel;

    openBusinessAccount(state.finance, config.id, ctx, config.initialCashCents);

    addSeedProduct(tech, {
      name: config.firstProduct.name,
      attributes: config.firstProduct.attributes,
      priceCents: config.firstProduct.priceCents,
      marketingDailyCents: config.marketingDailyCents,
      nowMinute,
    });

    // 只负责「企业 + 科技 + 现金 + 产品」：股权与上市证券由 seedListedCompanyCapital 单独补齐，
    // 这样 v2→v3 迁移（当时还没有股权/证券切片）不会提前触碰这些字段。
    state.businessAi.companies[config.id] = { lastDecisionMinute: null, productSeq: 1 };
  });
}

/**
 * 为一家已存在的公司补齐「历史融资已完成的上市股权 + 证券」。
 * 不重复创建企业、不重复注资、不重放历史现金流水——只补账面关系。
 * 开局种子与 v5→v6 迁移都走这里，保证同一家公司只会建立一本股权簿、一只证券。
 */
export function seedListedCompanyCapital(
  state: GameState,
  companyId: string,
  index: number,
  nowMinute: number,
): void {
  const company = state.enterprises.companies[companyId];
  if (!company) return;
  const securityId = `sec-${companyId}`;
  if (state.equity.books[securityId]) return;

  const book = createCompanyBook(state.equity, {
    companyId,
    securityId,
    founderId: `ai:${companyId}`,
    marketMakerId: 'market-maker',
    // 三家 AI 的历史股权是「开局前就已完成」的既定事实，与玩家公司的初始化规则不同：
    // 它们本来就带着做市库存，不重放当时的现金交易，但必须写明来源。
    founderRatio: EQUITY_RULES.founderRatio,
    sponsorRatio: EQUITY_RULES.marketMakerRatio,
    historyNote: '开局前已完成私募融资并上市：股权与做市库存为历史既定配置，本轮不重放当时的现金交易',
  });
  book.hasExternalFinancing = true;
  book.listed = true;
  book.listedAtMinute = nowMinute;

  registerSecurity(
    state.securities,
    { id: securityId, symbol: symbolFor(index), name: company.name, companyId },
    // 以合理价值作为开盘价：不伪造过去，也不从 1 分钱开始
    createMarket(fairPriceSeed(state, company, book), nowMinute, seedFromId(securityId)),
  );

  if (!state.businessAi.companies[companyId]) {
    state.businessAi.companies[companyId] = { lastDecisionMinute: null, productSeq: 1 };
  }
}

/**
 * 为一家**已存在的玩家公司**补建未上市股权簿（旧档迁移用）。
 *
 * - 旧版玩家公司原本是玩家独资：初始股份 100% 归玩家，CEO 保留玩家身份；
 * - 未完成外部融资，因此不具备直接上市资格（`hasExternalFinancing = false`）；
 * - 不增发、不注资、不伪造融资：资金与产品、研发、人才、报表都由原档保留；
 * - 已清算公司不建簿：保持关闭，不恢复经营，也不产生可交易资产；
 * - 幂等：已经有簿的公司直接返回，不会被重复建簿。
 *
 * `founderContributionCents` 只能来自能可靠确认的出资流水；
 * 无法确认时传 0 并通过 `historyNote` 明确标注，绝不把当前现金冒充历史出资。
 */
export function ensurePlayerCompanyBook(
  state: GameState,
  company: Enterprise,
  founderContributionCents: number,
  historyNote: string,
): ShareBook | null {
  if (company.status === 'closed') return null;
  const existing = bookOfCompany(state.equity, company.id);
  if (existing) return existing;
  const book = createCompanyBook(state.equity, {
    companyId: company.id,
    securityId: `sec-${company.id}`,
    founderId: 'player',
    marketMakerId: 'market-maker',
    founderRatio: EQUITY_RULES.playerFounderRatio,
    sponsorRatio: 0,
    historyNote,
  });
  book.ceoId = 'player';
  book.founderContributionCents = Math.max(0, Math.trunc(founderContributionCents));
  return book;
}

/** 开盘价：账面权益 + 技术潜力，按有效股份折算；与后续估值口径一致。 */
function fairPriceSeed(
  state: GameState,
  company: Enterprise,
  book: { totalShares: number; treasuryShares: number },
): number {
  const cash = state.finance.businessAccounts[company.id] ?? 0;
  const tech = ensureTechCompany(state.technology, company.id);
  const bookValue = Math.max(0, cash);
  const techValue = Math.min(
    VALUATION_RULES.techValueCapCents,
    tech.accumulation * VALUATION_RULES.techValuePerPoint,
  );
  const effective = Math.max(1, book.totalShares - book.treasuryShares);
  return Math.max(1, Math.round((bookValue + techValue) / effective));
}

/** 供需要「每股参考价值」的调用方复用，避免两处口径不一致。 */export function shareOfPlayer(state: GameState, companyId: string): number {
  const book = bookOfCompany(state.equity, companyId);
  return book ? sharesOf(book, 'player') : 0;
}

/** 兼容旧调用：玩家创建的第一家未清算公司（不代表管理权）。 */
export function playerOwnedCompany(state: GameState): Enterprise | null;
export function playerOwnedCompany(state: ReadonlyGameState): DeepReadonly<Enterprise> | null;
export function playerOwnedCompany(
  state: GameState | ReadonlyGameState,
): Enterprise | null | DeepReadonly<Enterprise> | null {
  return playerEnterprise(state.enterprises);
}

/** 一个空的持仓对象，供新的证券初始化时使用。 */
export const EMPTY_HOLDING = createHolding();

/** 初始股本常量，供界面提示复用。 */
export const INITIAL_SHARES = EQUITY_RULES.initialShares;
