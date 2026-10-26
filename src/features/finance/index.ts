/**
 * 财务模块 —— 个人账户余额与资金流水。
 *
 * 职责边界：
 *  - 账户余额只能通过本模块的公开函数修改，流水与余额在同一份状态中同步写入。
 *  - 每笔资金操作都需要唯一 operationId，重复提交会被拒绝（防重复入账）。
 *  - 一次支付可能拆成「现金 + 存款」两条 posting，共享同一个 operationId，
 *    余额足够即整体成功；余额不足属于业务预期（返回 shortfall，由应用层形成欠款）。
 *  - 资金从哪个账户到哪个账户用 AccountRef 表达，首版只有个人现金 / 个人存款，
 *    外部对手方用 external 账户表示；为企业账户预留 owner 字段。
 *  - 本模块不读游戏时间，不读其他业务状态：时间与月份由调用方作为上下文传入。
 */

import { BRANDING } from '../../content/config';
import { BusinessError } from '../../core/errors';
import type { DeepReadonly } from '../../core/readonly';
import {
  assertBalance,
  assertMoneyRange,
  safeAddMoney,
} from '../../core/money';

/**
 * 账户归属。personal / business / investor / market 都是**真实资金主体**，
 * 有余额、受同一份流水约束；external 只表示「系统外部对手方」，没有余额。
 */
export type AccountOwner = 'personal' | 'business' | 'investor' | 'market' | 'external';

export interface AccountRef {
  readonly owner: AccountOwner;
  readonly id: string;
}

export const PERSONAL_CASH: AccountRef = { owner: 'personal', id: 'cash' };
export const PERSONAL_SAVINGS: AccountRef = { owner: 'personal', id: 'savings' };

export function externalAccount(id: string): AccountRef {
  return { owner: 'external', id };
}

export function describeAccount(account: AccountRef): string {
  if (account.owner === 'personal') {
    return account.id === 'cash' ? '现金' : account.id === 'savings' ? '银行存款' : `个人·${account.id}`;
  }
  if (account.owner === 'business') return `企业·${account.id}`;
  return EXTERNAL_LABELS[account.id] ?? account.id;
}

const EXTERNAL_LABELS: Record<string, string> = {
  employer: '雇主',
  landlord: '房东',
  utilities: '生活服务',
  creditor: '欠款',
  opening: '初始资金',
  market: '证券市场',
  lender: `${BRANDING.cityStem}银行`,
  customer: '产品客户',
  supplier: '供应商',
  staff: '员工',
  advertiser: '营销渠道',
  operator: '运营服务',
  investor: '外部投资人',
  tax: '税费',
  campaign: '竞选机构',
};

/** 业务类别：决定流水展示与月报归类。 */
export type TransactionCategory =
  | 'initial'
  | 'salary'
  | 'rent'
  | 'living'
  | 'deposit'
  | 'withdrawal'
  | 'debt-repayment'
  | 'stock-buy'
  | 'stock-sell'
  | 'loan-drawdown'
  | 'loan-principal'
  | 'loan-interest'
  | 'business-capital'
  | 'business-dividend'
  | 'business-liquidation'
  | 'business-revenue'
  | 'business-cogs'
  | 'business-wages'
  | 'business-research'
  | 'business-marketing'
  | 'business-opex'
  | 'equity-financing'
  | 'business-buyback'
  | 'equity-promotion'
  | 'election-sponsorship'
  | 'supplies';

export const CATEGORY_LABELS: Record<TransactionCategory, string> = {
  initial: '初始资金',
  salary: '工资',
  rent: '房租',
  living: '生活费',
  deposit: '存入银行',
  withdrawal: '银行取现',
  'debt-repayment': '偿还欠款',
  'stock-buy': '买入股票',
  'stock-sell': '卖出股票',
  'loan-drawdown': '贷款放款',
  'loan-principal': '偿还贷款本金',
  'loan-interest': '贷款利息',
  'business-capital': '企业出资',
  'business-dividend': '企业分红',
  'business-liquidation': '企业清算分配',
  'business-revenue': '销售收入',
  'business-cogs': '销售成本',
  'business-wages': '企业工资',
  'business-research': '研发投入',
  'business-marketing': '营销费用',
  'business-opex': '运营费用',
  'equity-financing': '外部股权融资',
  'business-buyback': '股份回购',
  'equity-promotion': '投资者宣传',
  'election-sponsorship': '竞选赞助',
  supplies: '生活补给',
};

/**
 * 不计入「个人收支」的类别：内部转移、开局注资，以及资产形态转换。
 * 买入/卖出股票是资金与持仓互换，借款与还本是资金与负债互换；
 * 对外出资与清算分配是资本进出，都不属于生活收支，不能计入月报。
 */
const NON_FLOW_CATEGORIES = new Set<TransactionCategory>([
  'initial',
  'deposit',
  'withdrawal',
  'stock-buy',
  'stock-sell',
  'loan-drawdown',
  'loan-principal',
  'business-capital',
  'business-liquidation',
  'business-buyback',
  'equity-financing',
]);

/** 不计入「企业经营收支」的类别：出资、分红、清算、融资与回购属于资本行为。 */
const NON_OPERATING_CATEGORIES = new Set<TransactionCategory>([
  'business-capital',
  'business-dividend',
  'business-liquidation',
  'business-buyback',
  'equity-financing',
]);

export interface LedgerEntry {
  readonly id: string;
  /** 同一次业务操作的所有 posting 共享此 ID。 */
  readonly operationId: string;
  readonly atMinute: number;
  /** 归属月份 "YYYY-MM"。 */
  readonly monthKey: string;
  /** 正数，单位：分。 */
  readonly amount: number;
  readonly from: AccountRef;
  readonly to: AccountRef;
  readonly category: TransactionCategory;
  readonly memo: string;
}

export interface PersonalAccounts {
  cash: number;
  savings: number;
}

export interface FinanceState {
  /** 账户归属主体。个人账户始终属于 personal；企业账户以 companyId 寻址。 */
  readonly owner: 'personal';
  accounts: PersonalAccounts;
  /**
   * 企业账户余额，按稳定 companyId 寻址。
   * 与个人账户同在一份状态里，保证「资金 + 流水」同一次提交变更，
   * 同时避免把银行、就业、股票、贷款全部重写成多主体账本。
   */
  businessAccounts: Record<string, number>;
  /**
   * 投资者与做市商的真实资金账户，key = `${owner}:${id}`。
   * 与个人/企业账户共用同一份流水与提交机制，不复制第二套账本。
   */
  subjectAccounts: Record<string, number>;
  /**
   * 资金预留（分）：融资报价的承诺资金。预留不是支出、不写流水，
   * 只是把余额的一部分锁住，避免同一笔钱同时支撑多份可接受报价。
   *
   * key = `${owner}:${id}::${ref}`，`ref` 是业务单据标识（当前为报价 id）。
   * 按单据记账，才能保证「接受某份报价时只消费它自己的资金承诺」，
   * 而不是拿同一投资者在另一家公司报价上的预留来冒充。
   */
  reservations: Record<string, number>;
  entries: LedgerEntry[];
  /** 流水编号计数器，随存档保留，保证恢复后 ID 不重复。 */
  nextSeq: number;
}

export interface PostingContext {
  readonly atMinute: number;
  readonly monthKey: string;
}

export interface PaymentResult {
  readonly requested: number;
  readonly paid: number;
  readonly cashPaid: number;
  readonly savingsPaid: number;
  readonly shortfall: number;
}

const MAX_ENTRIES = 2000;

export function createFinanceState(initial: PersonalAccounts): FinanceState {
  assertBalance(initial.cash, '初始现金');
  assertBalance(initial.savings, '初始存款');
  const state: FinanceState = {
    owner: 'personal',
    accounts: { cash: initial.cash, savings: initial.savings },
    businessAccounts: {},
    subjectAccounts: {},
    reservations: {},
    entries: [],
    nextSeq: 1,
  };
  if (initial.cash + initial.savings > 0) {
    postEntry(state, { atMinute: 0, monthKey: '' }, {
      operationId: 'opening-balance',
      amount: initial.cash,
      from: externalAccount('opening'),
      to: PERSONAL_CASH,
      category: 'initial',
      memo: '开局现金',
    });
    if (initial.savings > 0) {
      postEntry(state, { atMinute: 0, monthKey: '' }, {
        operationId: 'opening-balance',
        amount: initial.savings,
        from: externalAccount('opening'),
        to: PERSONAL_SAVINGS,
        category: 'initial',
        memo: '开局存款',
      });
    }
  }
  return state;
}

/* ---------------------------------------------------------------- 查询 */

export function businessAccountRef(companyId: string): AccountRef {
  return { owner: 'business', id: companyId };
}

export function balanceOf(state: FinanceState, account: AccountRef): number {
  if (account.owner === 'business') return state.businessAccounts[account.id] ?? 0;
  if (account.owner === 'investor' || account.owner === 'market') {
    return state.subjectAccounts[`${account.owner}:${account.id}`] ?? 0;
  }
  if (account.owner !== 'personal') return 0;
  if (account.id === 'cash') return state.accounts.cash;
  if (account.id === 'savings') return state.accounts.savings;
  return 0;
}

/** 企业账户余额（分）。未开户返回 0。 */
export function businessBalance(
  state: FinanceState | DeepReadonly<FinanceState>,
  companyId: string,
): number {
  return state.businessAccounts[companyId] ?? 0;
}

export function hasBusinessAccount(
  state: FinanceState | DeepReadonly<FinanceState>,
  companyId: string,
): boolean {
  return state.businessAccounts[companyId] !== undefined;
}

/** 个人可用资金 = 现金 + 银行存款（不含未发工资）。 */
export function personalTotal(state: FinanceState): number {
  return state.accounts.cash + state.accounts.savings;
}

export function recentEntries(state: FinanceState, limit = 12): LedgerEntry[] {
  if (limit <= 0) return [];
  return state.entries.slice(Math.max(0, state.entries.length - limit)).reverse();
}

/**
 * 个人流水：只取「至少一端是个人账户」的记录，按时间倒序。
 * 企业之间、AI 与客户之间的经营记录不会出现在个人界面；
 * 个人出资、企业分红这类真实往来会保留（分红是个人流入）。
 */
export function recentPersonalEntries(
  state: FinanceState | DeepReadonly<FinanceState>,
  limit = 12,
): readonly DeepReadonly<LedgerEntry>[] {
  if (limit <= 0) return [];
  const rows: DeepReadonly<LedgerEntry>[] = [];
  for (let i = state.entries.length - 1; i >= 0 && rows.length < limit; i -= 1) {
    const entry = state.entries[i];
    if (!entry) continue;
    if (entry.from.owner === 'personal' || entry.to.owner === 'personal') rows.push(entry);
  }
  return rows;
}

export interface LedgerQuery {
  readonly monthKey?: string | null;
  readonly category?: TransactionCategory | null;
}

/**
 * 按条件列出**个人**流水（时间倒序）。
 * 先按个人账户过滤，再按月/类别筛选；调用方自行分页。
 * 企业之间与 AI 的经营记录永远不会出现在这里。
 */
export function listPersonalEntries(
  state: FinanceState | DeepReadonly<FinanceState>,
  query: LedgerQuery = {},
): LedgerEntry[] {
  const monthKey = query.monthKey ?? null;
  const category = query.category ?? null;
  const rows: LedgerEntry[] = [];
  for (let i = state.entries.length - 1; i >= 0; i -= 1) {
    const entry = state.entries[i];
    if (!entry) continue;
    if (entry.from.owner !== 'personal' && entry.to.owner !== 'personal') continue;
    if (monthKey !== null && entry.monthKey !== monthKey) continue;
    if (category !== null && entry.category !== category) continue;
    rows.push(entry);
  }
  return rows;
}

/** 某家企业的流水，按时间倒序。企业界面据此追踪自己的资金来往。 */
export function recentBusinessEntries(
  state: FinanceState | DeepReadonly<FinanceState>,
  companyId: string,
  limit = 12,
): LedgerEntry[] {
  if (limit <= 0) return [];
  const rows: DeepReadonly<LedgerEntry>[] = [];
  for (let i = state.entries.length - 1; i >= 0 && rows.length < limit; i -= 1) {
    const entry = state.entries[i];
    if (!entry) continue;
    const touches =
      (entry.from.owner === 'business' && entry.from.id === companyId) ||
      (entry.to.owner === 'business' && entry.to.id === companyId);
    if (touches) rows.push(entry);
  }
  return rows;
}

export interface MonthTotals {
  readonly income: number;
  readonly expense: number;
  readonly net: number;
  readonly byCategory: ReadonlyArray<{ category: TransactionCategory; income: number; expense: number }>;
}

/**
 * 按月聚合「个人」收支。只统计一端是个人账户的资金流动：
 * 存取款、股票买卖、贷款本息、企业出资/清算分配属于内部转移或资本进出，
 * 不计入个人月报；企业收支一律不计入个人月报（另有 businessMonthlyTotals）。
 */
export function monthlyTotals(
  state: FinanceState | DeepReadonly<FinanceState>,
  monthKey: string,
): MonthTotals {
  const buckets = new Map<TransactionCategory, { income: number; expense: number }>();
  let income = 0;
  let expense = 0;
  for (const entry of state.entries) {
    if (entry.monthKey !== monthKey) continue;
    if (NON_FLOW_CATEGORIES.has(entry.category)) continue;
    const isIncome = entry.to.owner === 'personal' && entry.from.owner !== 'personal';
    const isExpense = entry.from.owner === 'personal' && entry.to.owner !== 'personal';
    if (!isIncome && !isExpense) continue;
    const bucket = buckets.get(entry.category) ?? { income: 0, expense: 0 };
    if (isIncome) {
      income += entry.amount;
      bucket.income += entry.amount;
    } else {
      expense += entry.amount;
      bucket.expense += entry.amount;
    }
    buckets.set(entry.category, bucket);
  }
  return {
    income,
    expense,
    net: income - expense,
    byCategory: [...buckets.entries()].map(([category, value]) => ({ category, ...value })),
  };
}

/**
 * 按月聚合某家企业的经营收支。只统计该企业账户的对外流动，
 * 出资、分红、清算分配不计入经营收支。
 * 注意：经营报表的权威口径是企业状态中的当月累计，这里只用于展示与追踪。
 */
export function businessMonthlyTotals(
  state: FinanceState,
  companyId: string,
  monthKey: string,
): MonthTotals {
  const buckets = new Map<TransactionCategory, { income: number; expense: number }>();
  let income = 0;
  let expense = 0;
  for (const entry of state.entries) {
    if (entry.monthKey !== monthKey) continue;
    if (NON_OPERATING_CATEGORIES.has(entry.category)) continue;
    const touchesCompany =
      (entry.from.owner === 'business' && entry.from.id === companyId) ||
      (entry.to.owner === 'business' && entry.to.id === companyId);
    if (!touchesCompany) continue;
    const isIncome = entry.from.owner === 'external';
    const isExpense = entry.to.owner === 'external';
    if (!isIncome && !isExpense) continue;
    const bucket = buckets.get(entry.category) ?? { income: 0, expense: 0 };
    if (isIncome) {
      income += entry.amount;
      bucket.income += entry.amount;
    } else {
      expense += entry.amount;
      bucket.expense += entry.amount;
    }
    buckets.set(entry.category, bucket);
  }
  return {
    income,
    expense,
    net: income - expense,
    byCategory: [...buckets.entries()].map(([category, value]) => ({ category, ...value })),
  };
}

export function hasOperation(state: FinanceState, operationId: string): boolean {
  return state.entries.some((entry) => entry.operationId === operationId);
}

/* ------------------------------------------------------------ 写入原语 */

function assertOperationFresh(state: FinanceState, operationId: string): void {
  if (!operationId) {
    throw new BusinessError('MISSING_OPERATION_ID', '资金操作缺少唯一标识');
  }
  if (hasOperation(state, operationId)) {
    throw new BusinessError('DUPLICATE_OPERATION', '该资金操作已入账，不能重复提交');
  }
}

interface PostingInput {
  operationId: string;
  amount: number;
  from: AccountRef;
  to: AccountRef;
  category: TransactionCategory;
  memo: string;
}

function postEntry(state: FinanceState, ctx: PostingContext, input: PostingInput): LedgerEntry {
  assertMoneyRange(input.amount);
  const entry: LedgerEntry = {
    id: `txn-${state.nextSeq}`,
    operationId: input.operationId,
    atMinute: ctx.atMinute,
    monthKey: ctx.monthKey,
    amount: input.amount,
    from: input.from,
    to: input.to,
    category: input.category,
    memo: input.memo,
  };
  state.nextSeq += 1;
  state.entries.push(entry);
  if (state.entries.length > MAX_ENTRIES) {
    state.entries.splice(0, state.entries.length - MAX_ENTRIES);
  }
  return entry;
}

/** 从指定个人账户扣款；不足即抛错（用于必须足额成功的内部转移）。 */
function debit(state: FinanceState, account: AccountRef, amount: number, label: string): void {
  const balance = balanceOf(state, account);
  if (balance < amount) {
    throw new BusinessError('INSUFFICIENT_FUNDS', `${label}不足`);
  }
  if (account.id === 'cash') {
    state.accounts.cash = balance - amount;
  } else {
    state.accounts.savings = balance - amount;
  }
}

function credit(state: FinanceState, account: AccountRef, amount: number): void {
  if (account.id === 'cash') {
    state.accounts.cash = safeAddMoney(state.accounts.cash, amount, '现金余额');
  } else {
    state.accounts.savings = safeAddMoney(state.accounts.savings, amount, '存款余额');
  }
}

/* ------------------------------------------------------------ 公开操作 */

export interface IncomeInput extends PostingContext {
  operationId: string;
  amount: number;
  category: TransactionCategory;
  memo: string;
  from: AccountRef;
}

/** 外部资金入账到现金（工资发放等）。 */
export function receiveIncome(state: FinanceState, input: IncomeInput): LedgerEntry {
  assertMoneyRange(input.amount);
  assertOperationFresh(state, input.operationId);
  credit(state, PERSONAL_CASH, input.amount);
  return postEntry(state, input, {
    operationId: input.operationId,
    amount: input.amount,
    from: input.from,
    to: PERSONAL_CASH,
    category: input.category,
    memo: input.memo,
  });
}

/** 外部资金入账到银行存款（贷款放款、股票卖出等）。 */
export function receiveToSavings(state: FinanceState, input: IncomeInput): LedgerEntry {
  assertMoneyRange(input.amount);
  assertOperationFresh(state, input.operationId);
  state.accounts.savings = safeAddMoney(state.accounts.savings, input.amount, '存款余额');
  return postEntry(state, input, {
    operationId: input.operationId,
    amount: input.amount,
    from: input.from,
    to: PERSONAL_SAVINGS,
    category: input.category,
    memo: input.memo,
  });
}

export interface PaymentInput extends PostingContext {
  operationId: string;
  amount: number;
  category: TransactionCategory;
  memo: string;
  to: AccountRef;
}

type Wallet = 'cash' | 'savings';

/**
 * 按给定钱包顺序支付，不足部分返回 shortfall（不透支、不抛错）。
 * 一次支付最多产生两条 posting，共享 operationId。
 */
function payWithWallets(
  state: FinanceState,
  input: PaymentInput,
  order: readonly Wallet[],
): PaymentResult {
  if (input.amount < 0) {
    throw new BusinessError('INVALID_AMOUNT', '支付金额不能为负');
  }
  if (input.amount === 0) {
    return { requested: 0, paid: 0, cashPaid: 0, savingsPaid: 0, shortfall: 0 };
  }
  assertMoneyRange(input.amount);
  assertOperationFresh(state, input.operationId);

  let remaining = input.amount;
  let cashPaid = 0;
  let savingsPaid = 0;

  for (const wallet of order) {
    if (remaining <= 0) break;
    const balance = wallet === 'cash' ? state.accounts.cash : state.accounts.savings;
    const take = Math.min(balance, remaining);
    if (take <= 0) continue;
    if (wallet === 'cash') {
      state.accounts.cash = balance - take;
      cashPaid = take;
    } else {
      state.accounts.savings = balance - take;
      savingsPaid = take;
    }
    remaining -= take;
    postEntry(state, input, {
      operationId: input.operationId,
      amount: take,
      from: wallet === 'cash' ? PERSONAL_CASH : PERSONAL_SAVINGS,
      to: input.to,
      category: input.category,
      memo: input.memo,
    });
  }

  const paid = cashPaid + savingsPaid;
  return {
    requested: input.amount,
    paid,
    cashPaid,
    savingsPaid,
    shortfall: input.amount - paid,
  };
}

/** 普通生活支出：现金优先，银行存款补足。 */
export function payFromPersonal(state: FinanceState, input: PaymentInput): PaymentResult {
  return payWithWallets(state, input, ['cash', 'savings']);
}

/** 只能用银行存款支付（股票买入、贷款还款等）。 */
export function payFromSavings(state: FinanceState, input: PaymentInput): PaymentResult {
  return payWithWallets(state, input, ['savings']);
}

export interface TransferInput extends PostingContext {
  operationId: string;
  amount: number;
  memo: string;
}

/** 现金存入银行。不改变净资产。 */
export function transferCashToSavings(state: FinanceState, input: TransferInput): LedgerEntry {
  assertMoneyRange(input.amount);
  assertOperationFresh(state, input.operationId);
  debit(state, PERSONAL_CASH, input.amount, '现金');
  state.accounts.savings = safeAddMoney(state.accounts.savings, input.amount, '存款余额');
  return postEntry(state, input, {
    operationId: input.operationId,
    amount: input.amount,
    from: PERSONAL_CASH,
    to: PERSONAL_SAVINGS,
    category: 'deposit',
    memo: input.memo,
  });
}

/** 银行取现。不改变净资产。 */
export function transferSavingsToCash(state: FinanceState, input: TransferInput): LedgerEntry {
  assertMoneyRange(input.amount);
  assertOperationFresh(state, input.operationId);
  debit(state, PERSONAL_SAVINGS, input.amount, '银行存款');
  state.accounts.cash = safeAddMoney(state.accounts.cash, input.amount, '现金余额');
  return postEntry(state, input, {
    operationId: input.operationId,
    amount: input.amount,
    from: PERSONAL_SAVINGS,
    to: PERSONAL_CASH,
    category: 'withdrawal',
    memo: input.memo,
  });
}

/* ------------------------------------------------------------ 企业账户 */

export interface BusinessContext extends PostingContext {
  operationId: string;
  memo: string;
}

function assertBusinessAccount(state: FinanceState, companyId: string): void {
  if (state.businessAccounts[companyId] === undefined) {
    throw new BusinessError('NO_BUSINESS_ACCOUNT', '该公司尚未开设企业账户');
  }
}

function creditBusiness(state: FinanceState, companyId: string, amount: number): void {
  assertBusinessAccount(state, companyId);
  state.businessAccounts[companyId] = safeAddMoney(
    state.businessAccounts[companyId] ?? 0,
    amount,
    '企业账户余额',
  );
}

function debitBusiness(state: FinanceState, companyId: string, amount: number): void {
  assertBusinessAccount(state, companyId);
  const balance = state.businessAccounts[companyId] ?? 0;
  if (balance < amount) {
    throw new BusinessError('INSUFFICIENT_BUSINESS_FUNDS', '企业账户余额不足');
  }
  state.businessAccounts[companyId] = balance - amount;
}

/**
 * 开户。openingCents 只用于「世界初始化时的明确注资」（本轮仅三家 AI 公司），
 * 会留下一条来源为外部投资人的出资流水，绝不是凭空改余额。
 * 玩家创建公司必须走 transferPersonalSavingsToBusiness，真实扣个人存款。
 */
export function openBusinessAccount(
  state: FinanceState,
  companyId: string,
  ctx: PostingContext,
  openingCents = 0,
): void {
  if (state.businessAccounts[companyId] !== undefined) {
    throw new BusinessError('BUSINESS_ACCOUNT_EXISTS', '该公司已经开设过企业账户');
  }
  if (openingCents < 0) {
    throw new BusinessError('INVALID_AMOUNT', '开办资金不能为负');
  }
  state.businessAccounts[companyId] = 0;
  if (openingCents === 0) return;
  assertMoneyRange(openingCents);
  creditBusiness(state, companyId, openingCents);
  postEntry(state, ctx, {
    operationId: `business-opening:${companyId}`,
    amount: openingCents,
    from: externalAccount('investor'),
    to: businessAccountRef(companyId),
    category: 'business-capital',
    memo: '开局注资',
  });
}

/** 个人存款 → 企业账户：真实扣个人资金，不改变净资产。 */
export function transferPersonalSavingsToBusiness(
  state: FinanceState,
  companyId: string,
  input: BusinessContext & { amount: number },
): LedgerEntry {
  assertMoneyRange(input.amount);
  assertOperationFresh(state, input.operationId);
  assertBusinessAccount(state, companyId);
  debit(state, PERSONAL_SAVINGS, input.amount, '银行存款');
  creditBusiness(state, companyId, input.amount);
  return postEntry(state, input, {
    operationId: input.operationId,
    amount: input.amount,
    from: PERSONAL_SAVINGS,
    to: businessAccountRef(companyId),
    category: 'business-capital',
    memo: input.memo,
  });
}

/**
 * 企业账户 → 个人存款。只允许经过规则校验后的分红或清算分配，
 * 调用方必须先确认企业现金扣掉应付费用后足够支付。
 */
export function transferBusinessToPersonalSavings(
  state: FinanceState,
  companyId: string,
  input: BusinessContext & {
    amount: number;
    category: 'business-dividend' | 'business-liquidation';
  },
): LedgerEntry {
  assertMoneyRange(input.amount);
  assertOperationFresh(state, input.operationId);
  debitBusiness(state, companyId, input.amount);
  state.accounts.savings = safeAddMoney(state.accounts.savings, input.amount, '存款余额');
  return postEntry(state, input, {
    operationId: input.operationId,
    amount: input.amount,
    from: businessAccountRef(companyId),
    to: PERSONAL_SAVINGS,
    category: input.category,
    memo: input.memo,
  });
}

/** 销售收入入账：外部客户 → 企业账户。 */
export function receiveBusinessRevenue(
  state: FinanceState,
  companyId: string,
  input: BusinessContext & { amount: number },
): LedgerEntry {
  assertMoneyRange(input.amount);
  assertOperationFresh(state, input.operationId);
  creditBusiness(state, companyId, input.amount);
  return postEntry(state, input, {
    operationId: input.operationId,
    amount: input.amount,
    from: externalAccount('customer'),
    to: businessAccountRef(companyId),
    category: 'business-revenue',
    memo: input.memo,
  });
}

export interface BusinessPaymentResult {
  readonly requested: number;
  readonly paid: number;
  readonly shortfall: number;
}

/**
 * 企业支出：余额不足不抛错，返回 shortfall 由应用层记为企业应付。
 * 允许负余额之外的任何情况；绝不透支，也不取消已经发生的业务。
 */
export function payBusinessExpense(
  state: FinanceState,
  companyId: string,
  input: BusinessContext & {
    amount: number;
    to: AccountRef;
    category: TransactionCategory;
  },
): BusinessPaymentResult {
  if (!Number.isSafeInteger(input.amount) || input.amount < 0) {
    throw new BusinessError('INVALID_AMOUNT', '企业支出金额必须是非负整数（分）');
  }
  if (input.amount === 0) return { requested: 0, paid: 0, shortfall: 0 };
  assertMoneyRange(input.amount);
  assertOperationFresh(state, input.operationId);
  assertBusinessAccount(state, companyId);

  const balance = state.businessAccounts[companyId] ?? 0;
  const paid = Math.min(balance, input.amount);
  if (paid > 0) {
    state.businessAccounts[companyId] = balance - paid;
    postEntry(state, input, {
      operationId: input.operationId,
      amount: paid,
      from: businessAccountRef(companyId),
      to: input.to,
      category: input.category,
      memo: input.memo,
    });
  }
  return { requested: input.amount, paid, shortfall: input.amount - paid };
}

/* ------------------------------------------------- 外部主体（投资者 / 做市） */

export interface SubjectContext extends PostingContext {
  readonly operationId: string;
  readonly memo: string;
}

export function subjectKey(owner: 'investor' | 'market', id: string): string {
  return `${owner}:${id}`;
}

export function subjectRef(owner: 'investor' | 'market', id: string): AccountRef {
  return { owner, id };
}

export function subjectBalance(
  state: FinanceState | DeepReadonly<FinanceState>,
  owner: 'investor' | 'market',
  id: string,
): number {
  return state.subjectAccounts[subjectKey(owner, id)] ?? 0;
}

/** 预留明细的 key：主体 + 业务单据标识。 */
function reservationKey(owner: 'investor' | 'market', id: string, ref: string): string {
  return `${subjectKey(owner, id)}::${ref}`;
}

/** 从预留 key 还原主体 key；旧档里没有 `::` 的 key 视为整体预留。 */
function subjectKeyOfReservation(key: string): string {
  const index = key.indexOf('::');
  return index >= 0 ? key.slice(0, index) : key;
}

/** 已被预留（融资报价承诺）的金额，按主体汇总。 */
export function reservedOf(
  state: FinanceState | DeepReadonly<FinanceState>,
  owner: 'investor' | 'market',
  id: string,
): number {
  const prefix = `${subjectKey(owner, id)}::`;
  let total = 0;
  for (const [key, amount] of Object.entries(state.reservations)) {
    if (key === subjectKey(owner, id) || key.startsWith(prefix)) total += amount;
  }
  return total;
}

/** 指定业务单据（报价 id）还挂着多少预留。 */
export function reservedFor(
  state: FinanceState,
  owner: 'investor' | 'market',
  id: string,
  ref: string,
): number {
  return state.reservations[reservationKey(owner, id, ref)] ?? 0;
}

/** 可用余额 = 余额 − 预留。预留只影响可用性，不减少余额、不写流水。 */
export function availableSubjectBalance(
  state: FinanceState | DeepReadonly<FinanceState>,
  owner: 'investor' | 'market',
  id: string,
): number {
  return Math.max(0, subjectBalance(state, owner, id) - reservedOf(state, owner, id));
}

/** 给外部主体开户并注资。`openingCents` 必须来自外部投资人，会留下真实流水。 */
export function openSubjectAccount(
  state: FinanceState,
  owner: 'investor' | 'market',
  id: string,
  openingCents: number,
  ctx: PostingContext,
  memo: string,
): void {
  if (state.subjectAccounts[subjectKey(owner, id)] !== undefined) {
    throw new BusinessError('SUBJECT_ACCOUNT_EXISTS', '该主体已经有资金账户');
  }
  if (!Number.isSafeInteger(openingCents) || openingCents < 0) {
    throw new BusinessError('INVALID_AMOUNT', '初始资金非法');
  }
  state.subjectAccounts[subjectKey(owner, id)] = 0;
  if (openingCents === 0) return;
  assertMoneyRange(openingCents);
  creditSubject(state, owner, id, openingCents);
  postEntry(state, ctx, {
    operationId: `subject-opening:${owner}:${id}`,
    amount: openingCents,
    from: externalAccount('investor'),
    to: subjectRef(owner, id),
    category: 'initial',
    memo,
  });
}

function creditSubject(
  state: FinanceState,
  owner: 'investor' | 'market',
  id: string,
  amount: number,
): void {
  const key = subjectKey(owner, id);
  state.subjectAccounts[key] = safeAddMoney(state.subjectAccounts[key] ?? 0, amount, '主体余额');
}

function debitSubject(
  state: FinanceState,
  owner: 'investor' | 'market',
  id: string,
  amount: number,
): void {
  const key = subjectKey(owner, id);
  const balance = state.subjectAccounts[key] ?? 0;
  if (balance < amount) {
    throw new BusinessError('INSUFFICIENT_SUBJECT_FUNDS', '该主体资金不足');
  }
  state.subjectAccounts[key] = balance - amount;
}

/**
 * 预留资金：不能超过当前可用余额。预留不写流水。
 * `ref` 用于把预留归属到具体业务单据（这里是报价 id）。
 */
export function reserveFunds(
  state: FinanceState,
  owner: 'investor' | 'market',
  id: string,
  amount: number,
  ref = 'general',
): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new BusinessError('INVALID_AMOUNT', '预留金额必须为正整数（分）');
  }
  if (availableSubjectBalance(state, owner, id) < amount) {
    throw new BusinessError('INSUFFICIENT_SUBJECT_FUNDS', '该主体可用资金不足以承诺这笔报价');
  }
  const key = reservationKey(owner, id, ref);
  state.reservations[key] = (state.reservations[key] ?? 0) + amount;
}

/**
 * 释放预留（拒绝、过期、被同轮其他报价取代、或成交后消费）。
 *
 * 只释放**指定单据**的承诺：该单据不存在或余额不足时，不会去别的报价的预留里补扣。
 * 重复释放同一单据是无副作用的（预留已为 0，直接返回）。
 * 需要整体释放某个主体的全部承诺时，用 `releaseAllFor`，不要靠这里的兜底。
 */
export function releaseFunds(
  state: FinanceState,
  owner: 'investor' | 'market',
  id: string,
  amount: number,
  ref: string,
): void {
  const left = Math.max(0, amount);
  if (left <= 0) return;
  const key = reservationKey(owner, id, ref);
  const current = state.reservations[key] ?? 0;
  if (current <= 0) return;
  const take = Math.min(current, left);
  const remaining = current - take;
  if (remaining > 0) state.reservations[key] = remaining;
  else delete state.reservations[key];
}

/** 某主体是否还有指定单据的预留（迁移核对用）。 */
export function hasReservation(
  state: FinanceState,
  owner: 'investor' | 'market',
  id: string,
  ref: string,
): boolean {
  return (state.reservations[reservationKey(owner, id, ref)] ?? 0) > 0;
}

/** 列出某主体全部预留单据，供迁移与核对。 */
export function reservationRefsOf(
  state: FinanceState,
  owner: 'investor' | 'market',
  id: string,
): Array<{ ref: string; amount: number }> {
  const prefix = `${subjectKey(owner, id)}::`;
  const rows: Array<{ ref: string; amount: number }> = [];
  for (const [key, amount] of Object.entries(state.reservations)) {
    if (!key.startsWith(prefix)) continue;
    rows.push({ ref: key.slice(prefix.length), amount });
  }
  return rows;
}

/** 释放某主体全部预留（公司清算、报价轮次整体作废时使用）。 */
export function releaseAllFor(
  state: FinanceState,
  owner: 'investor' | 'market',
  id: string,
): void {
  const subject = subjectKey(owner, id);
  for (const key of Object.keys(state.reservations)) {
    if (subjectKeyOfReservation(key) !== subject) continue;
    delete state.reservations[key];
  }
}

/** 通用资金划转：唯一的跨主体扣款入口，余额不足直接拒绝。 */
export function transferFunds(
  state: FinanceState,
  input: SubjectContext & {
    readonly from: AccountRef;
    readonly to: AccountRef;
    readonly amount: number;
    readonly category: TransactionCategory;
  },
): LedgerEntry {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new BusinessError('INVALID_AMOUNT', '划转金额必须为正整数（分）');
  }
  assertMoneyRange(input.amount);
  assertOperationFresh(state, input.operationId);
  assertSubjectSpendable(state, input.from, input.amount);

  if (input.from.owner !== 'external') {
    withdraw(state, input.from, input.amount);
  }
  if (input.to.owner !== 'external') {
    deposit(state, input.to, input.amount);
  }

  return postEntry(state, input, {
    operationId: input.operationId,
    amount: input.amount,
    from: input.from,
    to: input.to,
    category: input.category,
    memo: input.memo,
  });
}

/**
 * 从 investor / market 主体扣款时，支出上限是「余额 − 该主体全部预留」。
 *
 * 预留代表仍然有效的资金承诺（未决融资报价），普通划转不得侵占它；
 * 个人与企业账户的既有支付语义不变（它们没有预留）。
 */
function assertSubjectSpendable(state: FinanceState, account: AccountRef, amount: number): void {
  if (account.owner !== 'investor' && account.owner !== 'market') return;
  const available = availableSubjectBalance(state, account.owner, account.id);
  if (amount > available) {
    throw new BusinessError(
      'RESERVED_FUNDS',
      `该主体可用资金不足：余额 ${subjectBalance(state, account.owner, account.id)}，其中 ${reservedOf(
        state,
        account.owner,
        account.id,
      )} 已被有效报价预留`,
    );
  }
}

/**
 * 受预留支持的划转：消费**指定单据**的预留并把钱划走。
 *
 * 只允许 investor / market 主体使用（只有它们有预留），并且：
 *  - 该单据的预留必须足额覆盖本次金额；
 *  - 真实余额也必须足够；
 *  - 只消费这一个单据，不使用、也不补扣其他单据。
 *
 * 划款、流水与预留消费都发生在同一次状态提交内（调用方已在 store.run 中）。
 */
export function transferReservedFunds(
  state: FinanceState,
  input: SubjectContext & {
    readonly from: AccountRef;
    readonly to: AccountRef;
    readonly amount: number;
    readonly category: TransactionCategory;
    /** 这笔钱消费的是哪个业务单据的预留（例如融资报价 id）。 */
    readonly reservationRef: string;
  },
): LedgerEntry {
  if (input.from.owner !== 'investor' && input.from.owner !== 'market') {
    throw new BusinessError('INVALID_RESERVED_TRANSFER', '受预留支持的划转只能从投资者或做市账户支出');
  }
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new BusinessError('INVALID_AMOUNT', '划转金额必须为正整数（分）');
  }
  const reserved = reservedFor(state, input.from.owner, input.from.id, input.reservationRef);
  if (reserved < input.amount) {
    throw new BusinessError(
      'NO_RESERVATION',
      `单据 ${input.reservationRef} 的资金承诺不足（剩余 ${reserved}），不能完成本次划转`,
    );
  }
  if (subjectBalance(state, input.from.owner, input.from.id) < input.amount) {
    throw new BusinessError('INSUFFICIENT_SUBJECT_FUNDS', '该主体真实余额不足以完成本次划转');
  }

  // 先消费自己这一份承诺，再划款：普通划转的「不得侵占预留」检查不会误伤本次支出
  releaseFunds(state, input.from.owner, input.from.id, input.amount, input.reservationRef);
  return transferFunds(state, input);
}

/** 从任意真实账户扣款（预留检查统一在 transferFunds / transferReservedFunds 内）。 */
function withdraw(state: FinanceState, account: AccountRef, amount: number): void {
  switch (account.owner) {
    case 'personal':
      debit(state, account, amount, account.id === 'cash' ? '现金' : '银行存款');
      return;
    case 'business':
      debitBusiness(state, account.id, amount);
      return;
    case 'investor':
    case 'market':
      debitSubject(state, account.owner, account.id, amount);
      return;
    default:
      throw new BusinessError('INVALID_ACCOUNT', '不能从外部账户扣款');
  }
}

function deposit(state: FinanceState, account: AccountRef, amount: number): void {
  switch (account.owner) {
    case 'personal':
      credit(state, account, amount);
      return;
    case 'business':
      creditBusiness(state, account.id, amount);
      return;
    case 'investor':
    case 'market':
      creditSubject(state, account.owner, account.id, amount);
      return;
    default:
      throw new BusinessError('INVALID_ACCOUNT', '不能向外部账户入账');
  }
}
