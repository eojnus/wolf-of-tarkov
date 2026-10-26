/**
 * 局部冒烟验证（不是完整测试体系）。
 *
 * 覆盖本轮资本系统改造最需要确认的疑点：
 *   1. 多证券初始化：旧独立标的保留原 ID，三家 AI 公司各自上市；
 *   2. 行情按时间路径推进的一致性（分段与一次推进相同）；
 *   3. 交易与借款的整体提交（失败回滚）与净资产不变性；
 *   4. 融资 → 预留资金 → 接受报价 → 稀释 → 上市 → 持仓/成本同步 → 清仓后仍保留 CEO；
 *   5. 分红收款账户（AI 创始股东走外部，不污染投资者账户）；
 *   6. v1 与 v5 → v7 的存档迁移与关系校验。
 *
 * 运行：npx tsx scripts/smoke.ts
 */

import { advanceGameTime } from '../src/app/timeAdvance';
import { createInitialState, netWorth } from '../src/app/state';
import { dateAtMinute } from '../src/core/calendar';
import { GameStore } from '../src/core/store';
import { AI_COMPANIES } from '../src/content/business';
import { MARKET, SAVE, TIME } from '../src/content/config';
import { accrueInterest, borrow, interestDenominator, totalOwed } from '../src/features/loan';
import { bookOfCompany, effectiveShares, sharesOf } from '../src/features/equity';
import { subjectBalance } from '../src/features/finance';
import { BusinessCommands } from '../src/app/business';
import { CapitalCommands } from '../src/app/capital';
import { distributeDividend, executeTrade, previewTrade } from '../src/app/securities-settlement';
import { buildSnapshot, parseSnapshot } from '../src/infrastructure/storage';

declare const process: { readonly exit: (code?: number) => void };

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `（实际 ${String(actual)} ≠ 期望 ${String(expected)}）`}`,
  );
}

function cents(value: number): string {
  return (value / 100).toFixed(2);
}

const hooks = {
  notify: (): void => undefined,
  requestAutoSave: (): void => undefined,
};

const monthKeyAt = (minute: number): string => dateAtMinute(minute, TIME.calendar).monthKey;

/* ------------------------------------------- 1. 多证券初始化与行情路径 */

{
  const s = createInitialState();
  const ids = Object.keys(s.securities.markets).sort();
  check('多证券：旧独立标的保留原 ID', ids.includes(MARKET.symbol), true);
  check('多证券：三家 AI 公司各自上市', AI_COMPANIES.every((c) => ids.includes(`sec-${c.id}`)), true);
  check('多证券：独立标的无发行公司', s.securities.meta[MARKET.symbol]?.companyId, null);
  for (const id of ids) {
    check(`多证券：${id} 有行情`, s.securities.markets[id] !== undefined, true);
    check(`多证券：${id} 有持仓`, s.securities.holdings[id] !== undefined, true);
    check(`多证券：${id} 有股权簿`, s.equity.books[id] !== undefined, true);
  }

  const once = createInitialState();
  advanceGameTime(once, 24 * 20);
  const chunked = createInitialState();
  for (let i = 0; i < 20; i += 1) advanceGameTime(chunked, 24);
  const legacyOnce = once.securities.markets[MARKET.symbol]!;
  const legacyChunked = chunked.securities.markets[MARKET.symbol]!;
  check('行情：一次推进 = 分 20 次推进', legacyOnce.price, legacyChunked.price);
  check('行情：更新次数', legacyOnce.ticks, 20);
  check('行情：下次更新指针一致', legacyOnce.nextTickMinute, legacyChunked.nextTickMinute);
  check('行情：价格不低于 1 分', legacyOnce.price >= 1, true);
  check('行情：历史不超过上限', legacyOnce.history.length <= MARKET.historyLimit, true);

  const t = createInitialState();
  advanceGameTime(t, 24);
  const market = t.securities.markets[MARKET.symbol]!;
  const last = market.history[market.history.length - 1]!;
  check('行情：第 24 分钟更新记为第 24 分钟', last.minute, 24);
  check('行情：下次更新为第 48 分钟', market.nextTickMinute, 48);
  check('行情：历史最后一点等于现价', last.price, market.price);
}

/* -------------------------------------- 2. 贷款计息余量与到期顺序 */

{
  const s = createInitialState();
  s.clock.totalMinute = 1000;
  borrow(s.loan, s.finance, 1_000_000, {
    operationId: 'loan-a',
    atMinute: 1000,
    monthKey: monthKeyAt(1000),
  });
  check('贷款：放款进入存款', s.finance.accounts.savings, 800_000 + 1_000_000);
  check('贷款：合同金额', s.loan.contract?.outstanding, 1_000_000);
  check('贷款：计息分母', interestDenominator(), 4_320_000);
  accrueInterest(s.loan, 30 * 1440);
  check(
    `贷款：30 天利息 = 本金 1%（${cents(s.loan.contract!.accruedInterest)} 元）`,
    s.loan.contract!.accruedInterest,
    10_000,
  );
  check('贷款：待还总额 = 本息', totalOwed(s.loan.contract!), 1_010_000);
}

{
  const s = createInitialState();
  s.clock.totalMinute = 40_000;
  borrow(s.loan, s.finance, 1_000_000, {
    operationId: 'loan-due-test',
    atMinute: 40_000,
    monthKey: monthKeyAt(40_000),
  });
  const monthBoundary = 42_720;
  s.loan.contract!.dueMinute = monthBoundary;
  const result = advanceGameTime(s, 2_800);
  check('顺序：发生一次月结', result.monthsSettled, 1);
  check('顺序：贷款已处理', result.loanDueEvents.length, 1);
  const entries = s.finance.entries;
  const rentIndex = entries.findIndex((entry) => entry.category === 'rent');
  const loanIndex = entries.findIndex((entry) => entry.operationId.startsWith('loan-expiry'));
  check('顺序：房租扣款在贷款到期之前', rentIndex >= 0 && loanIndex > rentIndex, true);
  check('顺序：贷款已结清', s.loan.contract?.status, 'settled');
}

/* -------------------------------------- 3. 交易整体提交与净资产不变性 */

{
  const store = new GameStore(createInitialState());
  const beforeSavings = store.state.finance.accounts.savings;
  const beforeShares = store.state.securities.holdings[MARKET.symbol]!.shares;
  let rejected = false;
  try {
    store.run((draft) => {
      executeTrade(draft, {
        securityId: MARKET.symbol,
        side: 'buy',
        shares: 999_999,
        atMinute: 0,
        monthKey: monthKeyAt(0),
        operationId: 'buy-fail',
      });
    });
  } catch {
    rejected = true;
  }
  check('交易：超量买入被拒绝', rejected, true);
  check('交易：失败后存款未变', store.state.finance.accounts.savings, beforeSavings);
  check('交易：失败后持仓未变', store.state.securities.holdings[MARKET.symbol]!.shares, beforeShares);
}

{
  const s = createInitialState();
  const base = netWorth(s);

  borrow(s.loan, s.finance, 1_000_000, {
    operationId: 'loan-nw',
    atMinute: 0,
    monthKey: monthKeyAt(0),
  });
  check('净资产：借款不增加净资产', netWorth(s), base);

  const buyPreview = previewTrade(s, MARKET.symbol, 'buy', 100);
  executeTrade(s, {
    securityId: MARKET.symbol,
    side: 'buy',
    shares: buyPreview.executableShares,
    atMinute: 0,
    monthKey: monthKeyAt(0),
    operationId: 'buy-nw',
  });
  check('净资产：买入不改变净资产', netWorth(s), base);
  check('净资产：持股数量', s.securities.holdings[MARKET.symbol]!.shares, 100);
  check('净资产：股权簿与持仓同步', sharesOf(s.equity.books[MARKET.symbol]!, 'player'), 100);

  executeTrade(s, {
    securityId: MARKET.symbol,
    side: 'sell',
    shares: 100,
    atMinute: 1,
    monthKey: monthKeyAt(1),
    operationId: 'sell-nw',
  });
  check('净资产：卖出不改变净资产', netWorth(s), base);
  check('净资产：卖出后清空持仓', s.securities.holdings[MARKET.symbol]!.shares, 0);

  accrueInterest(s.loan, 1440);
  check('净资产：计提利息立即形成负债', netWorth(s) < base, true);
}

/* ---------------------- 4. 融资 → 预留 → 稀释 → 上市 → 持仓同步 → CEO 清仓 */

{
  const store = new GameStore(createInitialState());
  const business = new BusinessCommands(store, hooks);
  const capital = new CapitalCommands(store, hooks);

  const created = business.createCompany('测试科技', 200_000);
  check('融资：创建公司成功', created.ok, true);
  const companyId = 'player-1';

  const book0 = bookOfCompany(store.state.equity, companyId)!;
  const founderShares = sharesOf(book0, 'player');
  // v0.4：新玩家公司初始股份 100% 归创始股东，做市商不再获得无偿股份
  check('融资：创始股东持股 100%', founderShares, 100_000);

  const request = capital.requestFinancing(5_000_000);
  check('融资：申请提交', request.ok, true);

  store.run((draft) => {
    advanceGameTime(draft, 1440);
  });

  const application = store.state.financing.applications[companyId];
  check('融资：回应后产生报价', application !== null && application.quotes.length > 0, true);
  const quote = application!.quotes[0]!;
  check('融资：报价已预留资金', quote.amountCents > 0, true);

  const investorBalanceBefore = subjectBalance(
    store.state.finance,
    'investor',
    quote.investorId,
  );

  const accept = capital.acceptQuote(quote.id);
  check('融资：接受报价成功', accept.ok, true);

  const book1 = bookOfCompany(store.state.equity, companyId)!;
  check('融资：增发后总股数增加', book1.totalShares > 100_000, true);
  check(
    '融资：创始持股比例被稀释',
    sharesOf(book1, 'player') / book1.totalShares < 1,
    true,
  );
  check(
    '融资：资金真实到账（公司现金增加）',
    (store.state.finance.businessAccounts[companyId] ?? 0) >= 200_000 + quote.amountCents,
    true,
  );
  check(
    '融资：投资者账户真实扣款',
    subjectBalance(store.state.finance, 'investor', quote.investorId),
    investorBalanceBefore - quote.amountCents,
  );

  const listed = capital.listCompany();
  check('融资：上市成功', listed.ok, true);
  const book2 = bookOfCompany(store.state.equity, companyId)!;
  const securityId = book2.securityId;
  const holding = store.state.securities.holdings[securityId]!;
  check('融资：上市后证券持仓同步', holding.shares, sharesOf(book2, 'player'));
  check('融资：上市后持仓保留创始成本', holding.totalCost, book2.founderContributionCents);
  check('融资：上市后 CEO 仍是玩家', book2.ceoId, 'player');

  // 卖光全部股份 → 保留 CEO 席位（v0.4：职位只由治理流程改变）
  const sellShares = holding.shares;
  const sellPreview = previewTrade(store.state, securityId, 'sell', sellShares);
  store.run((draft) => {
    executeTrade(draft, {
      securityId,
      side: 'sell',
      shares: sellPreview.executableShares,
      atMinute: draft.clock.totalMinute,
      monthKey: monthKeyAt(draft.clock.totalMinute),
      operationId: 'ceo-clear',
    });
  });
  const book3 = bookOfCompany(store.state.equity, companyId)!;
  check('治理：清仓后持股归零', sharesOf(book3, 'player'), 0);
  check('治理：清仓后仍保留 CEO 席位', book3.ceoId, 'player');
}

/* ----------------------------------------- 5. 分红收款账户（AI 创始股东） */

{
  const s = createInitialState();
  const aiCompany = s.enterprises.companies[AI_COMPANIES[0]!.id]!;
  const before = Object.fromEntries(
    Object.entries(s.finance.subjectAccounts).filter(([key]) => key.startsWith('investor:')),
  );
  distributeDividend(
    s,
    aiCompany,
    100_000,
    s.clock.totalMinute,
    monthKeyAt(s.clock.totalMinute),
    'dividend-smoke',
  );
  const after = Object.fromEntries(
    Object.entries(s.finance.subjectAccounts).filter(([key]) => key.startsWith('investor:')),
  );
  check('分红：AI 创始股东不走投资者账户', JSON.stringify(before), JSON.stringify(after));
  const book = bookOfCompany(s.equity, aiCompany.id)!;
  check('分红：累计分红已记录', book.dividendTotalCents >= 100_000, true);
}

/* ------------------------------------------------- 6. v1 → v6 存档迁移 */

{
  const s = createInitialState();
  const legacy = {
    format: SAVE.formatTag,
    version: 1,
    savedAt: new Date().toISOString(),
    reason: 'manual',
    state: {
      clock: s.clock,
      finance: s.finance,
      employment: s.employment,
      living: s.living,
      settlement: s.settlement,
      reports: s.reports,
      settings: s.settings,
      world: { player: { x: 3, z: 4, facing: 1 }, revision: 1 },
    },
  };

  const parsed = parseSnapshot(legacy);
  check('迁移：版本升级到最新', parsed.version, SAVE.formatVersion);
  check('迁移：记录来源版本', parsed.migratedFrom, 1);
  check('迁移：旧独立标的保留原 ID', parsed.state.securities.markets[MARKET.symbol] !== undefined, true);
  check('迁移：持仓为空', parsed.state.securities.holdings[MARKET.symbol]!.shares, 0);
  check('迁移：无贷款', parsed.state.loan.contract, null);
  check('迁移：保留玩家位置', parsed.state.world.player.x, 3);

  const again = buildSnapshot(parsed.state, 'manual');
  const roundTrip = parseSnapshot(JSON.parse(JSON.stringify(again)) as unknown);
  check('迁移：迁移后可再次保存读取', roundTrip.version, SAVE.formatVersion);
  check('迁移：再次读取不再标记迁移', roundTrip.migratedFrom, undefined);

  let rejected = false;
  try {
    const higher = { ...(JSON.parse(JSON.stringify(again)) as Record<string, unknown>), version: 99 };
    parseSnapshot(higher);
  } catch {
    rejected = true;
  }
  check('迁移：更高版本被拒绝', rejected, true);
}

/* ----------------------------------------- 7. v5 → v6 迁移（旧单证券不丢） */

{
  const s = createInitialState();
  advanceGameTime(s, 24 * 5);
  const legacyMarket = s.securities.markets[MARKET.symbol]!;
  const legacyHolding = s.securities.holdings[MARKET.symbol]!;
  // 伪造一个 v5 形态的存档：单证券 + 无资本切片
  const v5 = {
    format: SAVE.formatTag,
    version: 5,
    savedAt: new Date().toISOString(),
    reason: 'manual',
    state: {
      ...s,
      market: {
        price: legacyMarket.price,
        previousPrice: legacyMarket.previousPrice,
        nextTickMinute: legacyMarket.nextTickMinute,
        rng: legacyMarket.rng,
        history: legacyMarket.history,
        ticks: legacyMarket.ticks,
        candles: legacyMarket.candles,
        candleCurrent: legacyMarket.candleCurrent,
      },
      stock: {
        shares: legacyHolding.shares,
        totalCost: legacyHolding.totalCost,
        realizedPnl: legacyHolding.realizedPnl,
        trades: legacyHolding.trades,
      },
    },
  };
  delete (v5.state as Record<string, unknown>).securities;
  delete (v5.state as Record<string, unknown>).equity;
  delete (v5.state as Record<string, unknown>).financing;
  delete (v5.state as Record<string, unknown>).governance;
  delete (v5.state as Record<string, unknown>).promotion;

  const parsed = parseSnapshot(v5);
  check('迁移 v5：升级到 v6', parsed.version, 6);
  check('迁移 v5：记录来源版本', parsed.migratedFrom, 5);
  const migratedLegacy = parsed.state.securities.markets[MARKET.symbol]!;
  check('迁移 v5：旧证券价格保留', migratedLegacy.price, legacyMarket.price);
  check('迁移 v5：旧证券随机状态保留', migratedLegacy.rng, legacyMarket.rng);
  check('迁移 v5：旧证券历史保留', migratedLegacy.history.length, legacyMarket.history.length);
  check('迁移 v5：旧证券 K 线保留', migratedLegacy.candles.length, legacyMarket.candles.length);
  check('迁移 v5：玩家持仓保留', parsed.state.securities.holdings[MARKET.symbol]!.shares, legacyHolding.shares);
  check('迁移 v5：独立标的仍无发行公司', parsed.state.securities.meta[MARKET.symbol]!.companyId, null);
  check('迁移 v5：三家 AI 已补上市证券', AI_COMPANIES.every((c) => parsed.state.securities.markets[`sec-${c.id}`] !== undefined), true);
}

/* -------------------------------------- 8. 存档字段关系校验（矛盾状态） */

{
  const baseRaw = (): Record<string, unknown> =>
    JSON.parse(
      JSON.stringify(
        buildSnapshot(
          { ...createInitialState(), world: { player: { x: 0, z: 0, facing: 0 }, revision: 2 } },
          'manual',
        ),
      ),
    ) as Record<string, unknown>;

  const rejects = (label: string, mutate: (raw: Record<string, unknown>) => void): void => {
    const raw = baseRaw();
    mutate(raw);
    let rejected = false;
    try {
      parseSnapshot(raw);
    } catch {
      rejected = true;
    }
    check(label, rejected, true);
  };

  rejects('校验：证券持仓与股权簿不一致被拒绝', (raw) => {
    const state = raw.state as Record<string, unknown>;
    const securities = state.securities as Record<string, unknown>;
    const holdings = securities.holdings as Record<string, Record<string, unknown>>;
    holdings[MARKET.symbol]!.shares = 5;
  });
  rejects('校验：股权簿股份合计与总股数不一致被拒绝', (raw) => {
    const state = raw.state as Record<string, unknown>;
    const equity = state.equity as Record<string, unknown>;
    const books = equity.books as Record<string, Record<string, unknown>>;
    const book = books[MARKET.symbol]!;
    const holdings = book.holdings as Record<string, number>;
    holdings['market-maker'] = holdings['market-maker']! + 1;
  });
  rejects('校验：CEO 不持股被拒绝', (raw) => {
    const state = raw.state as Record<string, unknown>;
    const equity = state.equity as Record<string, unknown>;
    const books = equity.books as Record<string, Record<string, unknown>>;
    const book = books[`sec-${AI_COMPANIES[0]!.id}`]!;
    book.ceoId = 'player';
  });
  rejects('校验：行情历史与现价不一致被拒绝', (raw) => {
    const state = raw.state as Record<string, unknown>;
    const securities = state.securities as Record<string, unknown>;
    const markets = securities.markets as Record<string, Record<string, unknown>>;
    const market = markets[MARKET.symbol]!;
    const history = market.history as Array<{ minute: number; price: number }>;
    history[history.length - 1]!.price = 1;
  });

  const legal = baseRaw();
  let legalAccepted = false;
  try {
    parseSnapshot(legal);
    legalAccepted = true;
  } catch {
    legalAccepted = false;
  }
  check('校验：合法的初始状态通过', legalAccepted, true);
}

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
