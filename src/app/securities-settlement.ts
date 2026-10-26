/**
 * 证券结算 —— 经营估值、行情推进与市场流动性。
 *
 * 这里是「经营驱动股价」的唯一入口：
 *   合理价值 = 账面权益 + 资本化利润 + 技术潜力（各有上限），再乘宣传溢价；
 *   每个行情节点让价格向合理价值靠拢一小步，再叠加有界随机波动。
 * 因此销量增长不会直接等于价格上涨，亏损经营也不会被当成永续利润。
 *
 * 交易采用「做市商报价 + 有限库存/资金」的简化模型：
 * 不建订单簿，但每一股都来自真实持股，每一分钱都来自真实账户。
 */

import { dateAtMinute } from '../core/calendar';
import { BusinessError } from '../core/errors';
import { assertMoneyRange } from '../core/money';
import type { DeepReadonly } from '../core/readonly';
import { EQUITY_RULES, LIQUIDITY_RULES, PRODUCT_STOCK_RULES, VALUATION_RULES } from '../content/capital';
import { PRODUCT_MARKET } from '../content/business';
import { TIME } from '../content/config';
import type { Enterprise } from '../features/enterprise';
import { isClosed } from '../features/enterprise';
import { bookOfCompany, effectiveShares, sharesOf, transferShares, type ShareBook } from '../features/equity';
import {
  subjectBalance,
  subjectRef,
  transferFunds,
  businessAccountRef,
  externalAccount,
  PERSONAL_SAVINGS,
  type FinanceState,
} from '../features/finance';
import {
  adjustPrice,
  advanceMarket,
  applyBuy,
  applySell,
  driftForSaleRatio,
  forSaleShares,
  holdingOf,
  marketOf,
  metaOf,
  pushTrade,
  type MarketState,
  type SecuritiesState,
  type TradeSide,
} from '../features/stock';
import {
  averageAttributeOf,
  latestReleasedProduct,
  recentDailyAverage,
  techViewOf,
  type Product,
} from '../features/technology';
import { playerHoldingOf, type GameState, type ReadonlyGameState } from './state';
import { recordCashDistribution } from './population-market';
import { recordCityDividend } from './city-stock-index';

/** 做市商的股权簿 holderId（同一主体给所有标的做市）。 */
export const MARKET_MAKER_HOLDER = 'market-maker';
/** 做市商的资金账户 id（market 主体下唯一）。 */
export const DESK_ACCOUNT_ID = 'desk';

/* ---------------------------------------------------------------- 估值 */

export interface Fundamentals {
  readonly cash: number;
  readonly payables: number;
  /** 账面权益 = 现金 − 全部已发生应付；负数按 0 处理（不把亏损当资产）。 */
  readonly bookEquity: number;
  /** 平滑后的月度利润（分），只取非负部分计入估值。 */
  readonly monthlyProfit: number;
  readonly techLevel: number;
  readonly researchBudget: number;
  readonly crisis: boolean;
}

export function fundamentalsOf(
  state: ReadonlyGameState, company: Enterprise | DeepReadonly<Enterprise>): Fundamentals {
  const cash = state.finance.businessAccounts[company.id] ?? 0;
  const payables =
    company.payrollDue + company.cogsDue + company.marketingDue + company.opexDue + company.supplyDue;
  const book = Math.max(0, cash - payables);

  const last = company.reports[company.reports.length - 1] ?? null;
  const accrual = company.accrual;
  const currentProfit =
    accrual.revenue - accrual.cogs - accrual.wages - accrual.research - accrual.marketing - accrual.opex;
  const date = dateAtMinute(state.clock.totalMinute, TIME.calendar);
  const scale = 30 / Math.max(1, date.day);
  const normalizedCurrent = Math.round(currentProfit * scale);
  const monthlyProfit = Math.max(last?.profit ?? 0, normalizedCurrent, 0);

  const tech = techViewOf(state.technology, company.id);
  const projectBudget = tech.project?.budgetCents ?? 0;

  return {
    cash,
    payables,
    bookEquity: book,
    monthlyProfit,
    techLevel: tech.accumulation,
    researchBudget: projectBudget,
    crisis: company.status === 'crisis',
  };
}

/** 公司整体合理价值（分）。所有分项都有上限，避免数值失控。 */
export function fairValueCents(
  state: ReadonlyGameState, company: Enterprise | DeepReadonly<Enterprise>): number {
  const f = fundamentalsOf(state, company);
  const capitalized = Math.min(
    f.monthlyProfit * VALUATION_RULES.profitMultiple,
    Math.max(f.bookEquity, 1) * VALUATION_RULES.profitCapVsBook,
  );
  const techValue = Math.min(
    VALUATION_RULES.techValueCapCents,
    f.techLevel * VALUATION_RULES.techValuePerPoint +
      f.researchBudget * VALUATION_RULES.researchInProgressWeight,
  );
  const base = f.bookEquity + Math.max(0, capitalized) + techValue;
  const boost = promotionBoostOf(state, company.id);
  const value = Math.max(1, Math.round(base * (1 + boost)));
  if (company.status === 'closed') return 0;
  return value;
}

/** 每股合理价值（分）。分母是有效股份，库存股不参与。 */
export function fairPriceOf(
  state: ReadonlyGameState, company: Enterprise | DeepReadonly<Enterprise>): number {
  const book = bookOfCompany(state.equity, company.id);
  if (!book) return 1;
  const base = effectiveShares(book);
  if (base <= 0) return 1;
  const factor = salesPerformanceFactorOf(state, company);
  return Math.max(1, Math.round((fairValueCents(state, company) * factor) / base));
}

/* -------------------------------------------------- 产品与股价联动 */

/**
 * 销量表现因子（1 ± salesWeight），只影响**上市公司**的行情锚点。
 *
 * 观察最新发布产品的最近 salesWindowDays 个完整游戏日的实际日销量：
 *   s = clamp(日均实际日销 ÷ baseDailyUnits − 1, −1, 1)
 *   因子 = 1 + salesWeight × s
 *
 * 它是「当前一份」因子，直接乘在锚点上，不做逐日连乘，因此不会复利叠加；
 * 没有完整日记录、未上市或已终止时都返回 1（中性）。
 */
export function salesPerformanceFactorOf(
  state: ReadonlyGameState,
  company: Enterprise | DeepReadonly<Enterprise>,
): number {
  const book = bookOfCompany(state.equity, company.id);
  if (!book || !book.listed) return 1;
  if (company.status === 'closed') return 1;
  const market = book.securityId ? marketOf(state.securities, book.securityId) : null;
  if (!market || metaOf(state.securities, book.securityId)?.terminatedAtMinute !== null) return 1;

  // 只读查询：不在读取路径上顺手创建科技切片
  const tech = state.technology.companies[company.id];
  if (!tech) return 1;
  const product = latestReleasedProduct(tech);
  if (!product) return 1;
  const average = recentDailyAverage(product, PRODUCT_STOCK_RULES.salesWindowDays);
  if (average === null) return 1;

  const baseline = Math.max(1, PRODUCT_MARKET.baseDailyUnits);
  const signal = clampNumber(average / baseline - 1, -1, 1);
  return 1 + PRODUCT_STOCK_RULES.salesWeight * signal;
}

/** 最新发布产品的日均销量与信号，供界面说明（不给业务用）。 */
export function salesSignalOf(
  state: ReadonlyGameState,
  company: Enterprise | DeepReadonly<Enterprise>,
): { averageUnits: number | null; days: number; signal: number; factor: number } {
  const tech = state.technology.companies[company.id];
  const product = tech ? latestReleasedProduct(tech) : null;
  const average = product ? recentDailyAverage(product, PRODUCT_STOCK_RULES.salesWindowDays) : null;
  const baseline = Math.max(1, PRODUCT_MARKET.baseDailyUnits);
  const signal = average === null ? 0 : clampNumber(average / baseline - 1, -1, 1);
  return {
    averageUnits: average,
    days: product
      ? Math.min(PRODUCT_STOCK_RULES.salesWindowDays, product.dailySales.length)
      : 0,
    signal,
    factor: 1 + PRODUCT_STOCK_RULES.salesWeight * signal,
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface ProductReleaseImpact {
  /** 三项属性的算术平均 A（原始精度）。 */
  readonly averageAttribute: number;
  readonly thresholdUpper: number;
  readonly thresholdLower: number;
  /** 已施加的价格影响（−maxImpactPct ～ +maxImpactPct，0 表示无额外影响）。 */
  readonly deltaPct: number;
  /** 发布前的股价（分）。 */
  readonly priceBeforeCents: number;
  /** 调整后的股价（分）；未上市/无行情时等于发布前。 */
  readonly priceAfterCents: number;
  /** 是否真的施加了非零影响。 */
  readonly applied: boolean;
}

/**
 * 产品**首次成功发布**对股价的一次性反应。
 *
 * 玩家命令与 AI 决策共用这一个入口，且必须与发布本身在同一次状态提交里调用。
 * 只触发一次：`product.releaseImpactPct` 一旦是数值（含 0）就不再计算，
 * 因此重复点击、刷新、读档与日结都不会二次施加。
 *
 * 未上市公司没有证券：不创建证券，也不补发历史股价奖励。
 */
export function applyProductReleaseImpact(
  state: GameState,
  company: Enterprise,
  product: Product,
  atMinute: number,
): ProductReleaseImpact | null {
  if (product.releaseImpactPct !== null) return null;
  const average = averageAttributeOf(product);

  const book = bookOfCompany(state.equity, company.id);
  const market =
    book && book.listed && book.securityId ? marketOf(state.securities, book.securityId) : null;
  const terminated =
    book && book.securityId ? metaOf(state.securities, book.securityId)?.terminatedAtMinute !== null : true;

  if (!book || !book.listed || !market || terminated || company.status === 'closed') {
    // 没有可交易的证券：记录「已结算、无影响」，避免以后补发
    product.releaseImpactPct = 0;
    return {
      averageAttribute: average,
      thresholdUpper: thresholdBands(market?.price ?? 0).upper,
      thresholdLower: thresholdBands(market?.price ?? 0).lower,
      deltaPct: 0,
      priceBeforeCents: market?.price ?? 0,
      priceAfterCents: market?.price ?? 0,
      applied: false,
    };
  }

  const priceBefore = market.price;
  const bands = thresholdBands(priceBefore);
  let deltaPct = 0;
  if (average > bands.upper) {
    deltaPct = Math.min(
      PRODUCT_STOCK_RULES.maxImpactPct,
      (average - bands.upper) * PRODUCT_STOCK_RULES.perPointPct,
    );
  } else if (average < bands.lower) {
    deltaPct = -Math.min(
      PRODUCT_STOCK_RULES.maxImpactPct,
      (bands.lower - average) * PRODUCT_STOCK_RULES.perPointPct,
    );
  }

  const priceAfter = Math.max(1, Math.round(priceBefore * (1 + deltaPct)));
  product.releaseImpactPct = deltaPct;
  if (priceAfter !== priceBefore) {
    // 走统一行情与 K 线，不另写第二份图表价格
    adjustPrice(market, priceAfter, atMinute);
  }

  return {
    averageAttribute: average,
    thresholdUpper: bands.upper,
    thresholdLower: bands.lower,
    deltaPct,
    priceBeforeCents: priceBefore,
    priceAfterCents: priceAfter,
    applied: priceAfter !== priceBefore,
  };
}

/**
 * 发布门槛：P 为发布前股价（元）。
 *   t = clamp((P − 100) ÷ 900, 0, 1)
 *   U = 20 + 60t；L = U ÷ 2
 */
export function thresholdBands(priceCents: number): { upper: number; lower: number } {
  const priceYuan = Math.max(0, priceCents) / 100;
  const t = clampNumber(
    (priceYuan - PRODUCT_STOCK_RULES.priceBaseYuan) / PRODUCT_STOCK_RULES.priceSpanYuan,
    0,
    1,
  );
  const upper = PRODUCT_STOCK_RULES.upperBase + PRODUCT_STOCK_RULES.upperSpan * t;
  return { upper, lower: upper * PRODUCT_STOCK_RULES.lowerRatio };
}


/** 上市公司当前宣传带来的估值溢价（0～maxBoostPct），随时间线性衰减。 */
export function promotionBoostOf(
  state: ReadonlyGameState, companyId: string): number {
  const promo = state.promotion.byCompany[companyId];
  if (!promo || !promo.active) return 0;
  if (state.clock.totalMinute >= promo.expireMinute) return 0;
  const total = Math.max(1, promo.expireMinute - promo.startMinute);
  const left = Math.max(0, promo.expireMinute - state.clock.totalMinute) / total;
  return promo.strength * left;
}

/* ---------------------------------------------------------------- 行情 */

/**
 * 推进所有证券的行情。上市公司按合理价值锚定，旧独立标的保持纯随机。
 * 返回总更新次数。
 */
export function advanceSecurities(state: GameState, upToMinute: number): number {
  let updates = 0;
  for (const [securityId, market] of Object.entries(state.securities.markets)) {
    const meta = state.securities.meta[securityId];
    const company = meta?.companyId ? state.enterprises.companies[meta.companyId] : null;
    if (company && isClosed(company)) {
      // 已清算公司的证券停牌：不再生成行情，也不作为普通标的继续波动
      continue;
    }
    if (company && company.status !== 'closed') {
      const anchorPrice = () => fairPriceOf(state, company);
      const ticked = advanceMarket(market, upToMinute, {
        anchorPrice,
        pull: VALUATION_RULES.pullPerTick,
        maxTickChange: VALUATION_RULES.maxTickChangePct,
      });
      updates += ticked;
      // 愿售比例随行情微调（<= 0.5 个百分点/节点）：只改比例，不动股份与资金
      if (ticked > 0) {
        driftForSaleRatio(
          market,
          market.price > market.previousPrice
            ? 'up'
            : market.price < market.previousPrice
              ? 'down'
              : 'flat',
        );
      }
    } else {
      const ticked = advanceMarket(market, upToMinute);
      updates += ticked;
      if (ticked > 0) {
        driftForSaleRatio(
          market,
          market.price > market.previousPrice
            ? 'up'
            : market.price < market.previousPrice
              ? 'down'
              : 'flat',
        );
      }
    }
  }
  return updates;
}

/* ---------------------------------------------------------------- 交易 */

export interface TradePreview {
  readonly securityId: string;
  readonly side: TradeSide;
  readonly requestedShares: number;
  /** 实际可成交股数（不会超过请求量，也不会超过流动性）。 */
  readonly executableShares: number;
  /** 成交均价（分/股），已含冲击成本。 */
  readonly priceCents: number;
  readonly amountCents: number;
  readonly impactPct: number;
  /** 无法成交时的原因；可成交时为 null。 */
  readonly reason: string | null;
}

export function impactOfShares(shares: number): number {
  const ratio = shares / LIQUIDITY_RULES.impactReferenceShares;
  return Math.min(LIQUIDITY_RULES.maxImpactPct, LIQUIDITY_RULES.maxImpactPct * ratio);
}

/** 按股数计算含冲击的成交价。买入向上、卖出向下。 */
export function executionPrice(basePrice: number, shares: number, side: TradeSide): number {
  const impact = impactOfShares(shares);
  const factor = side === 'buy' ? 1 + impact : 1 - impact;
  return Math.max(1, Math.round(basePrice * factor));
}

/**
 * 在「付款方预算」与「数量上限」共同限定的区间里，求真正可成交的最大整数股数。
 *
 * 约束始终是：`n × executionPrice(base, n, side) ≤ budget`，且 `1 ≤ n ≤ limit`。
 *
 * 买入：成交价随股数单调不减 → `n × 价` 严格递增，上界 `floor(budget / 原价)` 可证明，
 *      二分即得精确解（保留原有逻辑，不做无关改动）。
 *
 * 卖出：成交价随股数单调**不增**，取整后「某个数量付不起」并不推出「更大的数量也付不起」：
 *      价格从 97 分跳到 96 分时，总额会先跌一段再继续上涨。因此不能对股数直接二分，
 *      改为按「成交价的取整档位」求解：
 *        1. 同一档内成交价是常数 p，总额 = n × p 严格递增 → 档内最优是 min(档末, floor(budget / p))；
 *        2. 档起点 × 档价 ≈ 该股数处的连续成交额，随股数递增（相邻档之间增加约
 *           `档价 × 档宽`，档宽 = 参考股数 ÷ 最大冲击 ×（1/基准价 的倒数）… 在当前配置下
 *           远大于取整带来的 ±n/2 偏差），因此「档起点付得起吗」沿股数单调；
 *        3. 于是可以对股数二分，定位**最后一个付得起的档**，再在该档内取精确最优解。
 *      整个过程只调用 `executionPrice`（不复制冲击公式），并对结果再做一次成交额校验。
 */
export function maxSharesWithinBudget(
  basePrice: number,
  budget: number,
  side: TradeSide,
  limit: number,
): number {
  const budgetCents = Math.floor(budget);
  const maxShares = Math.floor(limit);
  if (!Number.isSafeInteger(budgetCents) || budgetCents <= 0) return 0;
  if (!Number.isSafeInteger(maxShares) || maxShares <= 0) return 0;

  const price = Math.max(1, basePrice);
  const priceOf = (shares: number): number => executionPrice(price, shares, side);

  if (side === 'buy') {
    let low = 0;
    let high = Math.min(maxShares, Math.floor(budgetCents / price));
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (mid * priceOf(mid) <= budgetCents) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  if (maxShares * priceOf(maxShares) <= budgetCents) return maxShares;

  // 成交价随股数单调不增，因此可以用二分求档位边界
  const firstAtMost = (p: number): number => {
    let lo = 1;
    let hi = maxShares;
    let found = maxShares + 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (priceOf(mid) <= p) {
        found = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return found;
  };
  const lastAtLeast = (p: number): number => {
    let lo = 1;
    let hi = maxShares;
    let found = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (priceOf(mid) >= p) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };

  // 档起点：同一档内最便宜的一笔；只有它付得起，这一档才可能成交
  const plateauStart = (shares: number): number => firstAtMost(priceOf(shares));
  const affordablePlateau = (shares: number): boolean =>
    plateauStart(shares) * priceOf(shares) <= budgetCents;

  let lo = 1;
  let hi = maxShares;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (affordablePlateau(mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best <= 0) return 0;

  // 在最后一个付得起的档内取精确最优：档末与「预算 ÷ 档价」取小
  const plateauPrice = priceOf(best);
  const plateauStartShare = plateauStart(best);
  const candidate = Math.min(
    maxShares,
    lastAtLeast(plateauPrice),
    Math.floor(budgetCents / plateauPrice),
  );
  // candidate ≥ 档起点 是该档「付得起」的直接推论；成立时 candidate 仍在同一档，成交额必然 ≤ 预算
  if (candidate < plateauStartShare) return 0;
  return candidate;
}

/**
 * 预览一笔交易。买卖都受四重约束：
 * 请求股数、玩家可用资金/持股、做市商库存/资金、技术单笔上限。
 *
 * 数量与价格都在这里确定，执行时必须用同一份预览，不允许悄悄改变数量或价格。
 */
export function previewTrade(
  state: ReadonlyGameState,
  securityId: string,
  side: TradeSide,
  requestedShares: number,
): TradePreview {
  const empty = (reason: string): TradePreview => ({
    securityId,
    side,
    requestedShares,
    executableShares: 0,
    priceCents: marketOf(state.securities, securityId)?.price ?? 0,
    amountCents: 0,
    impactPct: 0,
    reason,
  });

  const market = marketOf(state.securities, securityId);
  if (!market) return empty('没有这个证券');
  if (!Number.isSafeInteger(requestedShares) || requestedShares <= 0) {
    return empty('请输入正整数股数');
  }

  const meta = state.securities.meta[securityId];
  const issuer = meta?.companyId ? state.enterprises.companies[meta.companyId] : null;
  if (meta?.terminatedAtMinute !== null && meta?.terminatedAtMinute !== undefined) {
    return empty('该证券已随发行公司清算而终止，不能继续交易');
  }
  if (issuer && isClosed(issuer)) {
    return empty('该发行公司已清算，证券停牌，不能继续交易');
  }

  const book = state.equity.books[securityId];
  const deskInventory = book ? sharesOf(book, MARKET_MAKER_HOLDER) : 0;
  // 能被买走的只有做市商**挂出来卖**的那部分库存，不是它的全部持股
  const deskForSale = forSaleShares(market, deskInventory);
  const deskCash = subjectBalance(state.finance, 'market', DESK_ACCOUNT_ID);

  // 请求量、单笔上限、对手方在售库存/自身持股共同构成求解区间；
  // 求解必须在这个区间内完成，不能先求一个全局最大值再假定更小的数量一定付得起。
  const orderCap = Math.min(requestedShares, LIQUIDITY_RULES.maxOrderShares);
  let executable = 0;
  if (side === 'buy') {
    executable = maxSharesWithinBudget(
      market.price,
      state.finance.accounts.savings,
      'buy',
      Math.min(orderCap, deskForSale),
    );
  } else {
    const holding = playerHoldingOf(state, securityId);
    if (holding.terminatedAtMinute !== null) {
      return empty('该持仓已随清算终止，不能卖出');
    }
    // 对手方（做市商）的钱也必须够付这一笔含冲击成交额
    executable = maxSharesWithinBudget(
      market.price,
      deskCash,
      'sell',
      Math.min(orderCap, holding.shares),
    );
  }

  if (executable <= 0) {
    if (side === 'buy') {
      if (deskForSale <= 0) {
        return empty(
          deskInventory <= 0
            ? '做市商暂时没有可卖股份（需要有人先卖出）'
            : '做市商当前没有挂出可卖股份（库存在手但未在售）',
        );
      }
      return empty('银行存款不足以按含冲击价格买入');
    }
    if (playerHoldingOf(state, securityId).shares <= 0) return empty('你没有可卖出的股份');
    return empty('对手方资金不足，无法按当前价格买入你卖出的股份');
  }

  const price = executionPrice(market.price, executable, side);
  const amount = price * executable;
  assertMoneyRange(amount, '成交金额');
  // assertMoneyRange 只校验金额数值范围，不能代替「付款方余额是否够」的比较：
  // 这里显式再核一次，避免求解口径出错时预览放行一笔付不起的交易。
  const payerBudget =
    side === 'buy' ? state.finance.accounts.savings : deskCash;
  if (amount > payerBudget) {
    return empty('成交金额超过付款方可用资金，请刷新预览后重试');
  }
  return {
    securityId,
    side,
    requestedShares,
    executableShares: executable,
    priceCents: price,
    amountCents: amount,
    impactPct: impactOfShares(executable),
    reason: executable < requestedShares ? '受流动性、资金或单笔上限限制，只能成交这个数量' : null,
  };
}

/**
 * 执行交易：资金、股份、持仓成本、成交记录与行情冲击在同一次提交里完成。
 * 二级市场交易不增加发行公司的现金。
 *
 * `expectedPriceCents` 是玩家在界面上确认过的成交均价。若此时行情或可成交数量
 * 已让价格变化，必须明确要求刷新确认，不能悄悄按另一个价格成交。
 */
export function executeTrade(
  state: GameState,
  input: {
    readonly securityId: string;
    readonly side: TradeSide;
    readonly shares: number;
    readonly atMinute: number;
    readonly monthKey: string;
    readonly operationId: string;
    readonly expectedPriceCents?: number;
  },
): { preview: TradePreview; realized: number } {
  const preview = previewTrade(state, input.securityId, input.side, input.shares);
  if (preview.executableShares <= 0) {
    throw new BusinessError('NO_LIQUIDITY', preview.reason ?? '无法成交');
  }
  if (preview.executableShares !== input.shares) {
    throw new BusinessError(
      'QUANTITY_CHANGED',
      `实际只能成交 ${preview.executableShares} 股，请按预览数量重新提交`,
    );
  }
  if (
    input.expectedPriceCents !== undefined &&
    input.expectedPriceCents !== preview.priceCents
  ) {
    throw new BusinessError(
      'PREVIEW_STALE',
      `成交均价已从 ${(input.expectedPriceCents / 100).toFixed(2)} 元变为 ${(
        preview.priceCents / 100
      ).toFixed(2)} 元，请刷新预览后再确认`,
    );
  }

  const book = state.equity.books[input.securityId];
  if (!book) throw new BusinessError('NO_BOOK', '该证券没有股权簿');
  const holding = holdingOf(state.securities, input.securityId);
  const ctx = { atMinute: input.atMinute, monthKey: input.monthKey, operationId: input.operationId };

  let realized = 0;
  if (input.side === 'buy') {
    // 玩家存款 → 做市商，股份由做市商转给玩家
    transferFunds(state.finance, {
      ...ctx,
      from: PERSONAL_SAVINGS,
      to: subjectRef('market', DESK_ACCOUNT_ID),
      amount: preview.amountCents,
      category: 'stock-buy',
      memo: `买入 ${input.securityId} ${preview.executableShares} 股`,
    });
    transferShares(book, MARKET_MAKER_HOLDER, 'player', preview.executableShares);
    applyBuy(holding, preview.executableShares, preview.amountCents);
  } else {
    // 玩家股份 → 做市商，资金反向
    transferFunds(state.finance, {
      ...ctx,
      from: subjectRef('market', DESK_ACCOUNT_ID),
      to: PERSONAL_SAVINGS,
      amount: preview.amountCents,
      category: 'stock-sell',
      memo: `卖出 ${input.securityId} ${preview.executableShares} 股`,
    });
    transferShares(book, 'player', MARKET_MAKER_HOLDER, preview.executableShares);
    realized = applySell(holding, preview.executableShares, preview.amountCents).realized;
    // 卖光股份不撤职：CEO 职位只由董事会表决改变（见 features/governance）。
    // 持股与经营权是两件事，这里不再顺手清空 ceoId。
  }

  pushTrade(state.securities, {
    securityId: input.securityId,
    minute: input.atMinute,
    side: input.side,
    shares: preview.executableShares,
    priceCents: preview.priceCents,
    amountCents: preview.amountCents,
    counterparty: MARKET_MAKER_HOLDER,
  });

  // 成交价进入同一份行情与 K 线，不另写第二份图表价格
  const market = marketOf(state.securities, input.securityId);
  if (market) adjustPrice(market, preview.priceCents, input.atMinute);

  return { preview, realized };
}

/* ---------------------------------------------------------------- 分红 */

export interface DividendResult {
  readonly totalCents: number;
  readonly perShareCents: number;
  readonly paidToPlayer: number;
  readonly holderCount: number;
}

/**
 * 把股东 holderId 映射到收款账户：
 *  - 玩家 → 个人存款；
 *  - 做市商 → 做市资金账户；
 *  - 投资者（inv:*）→ 对应投资者真实账户；
 *  - AI 创始股东（ai:*）等其余主体 → 系统外部（不虚构投资者账户）。
 */
export function dividendRecipient(holderId: string): ReturnType<typeof subjectRef> | ReturnType<typeof externalAccount> {
  if (holderId === 'player') return PERSONAL_SAVINGS;
  if (holderId === MARKET_MAKER_HOLDER) return subjectRef('market', DESK_ACCOUNT_ID);
  if (holderId.startsWith('inv:')) return subjectRef('investor', holderId.slice(4));
  return externalAccount(holderId);
}

/**
 * 现金分红：按持股比例付给所有有分红权的股东（库存股除外）。
 * 金额取整后有余数时，留给公司（不凭空消失，也不补给个人）。
 */
export function distributeDividend(
  state: GameState,
  company: Enterprise,
  amountCents: number,
  atMinute: number,
  monthKey: string,
  operationId: string,
): DividendResult {
  const book = bookOfCompany(state.equity, company.id);
  if (!book) throw new BusinessError('NO_BOOK', '公司没有股权簿');
  const base = effectiveShares(book);
  if (base <= 0) throw new BusinessError('NO_SHARES', '没有可分配的有效股份');
  assertMoneyRange(amountCents, '分红金额');

  let paid = 0;
  let paidToPlayer = 0;
  let holders = 0;
  for (const [holderId, shares] of Object.entries(book.holdings)) {
    if (shares <= 0) continue;
    const cut = Math.floor((amountCents * shares) / base);
    if (cut <= 0) continue;
    transferFunds(state.finance, {
      atMinute,
      monthKey,
      operationId: `${operationId}:${holderId}`,
      from: businessAccountRef(company.id),
      to: dividendRecipient(holderId),
      amount: cut,
      category: 'business-dividend',
      memo: '股东分红',
    });
    paid += cut;
    holders += 1;
    if (holderId === 'player') paidToPlayer = cut;
  }
  book.dividendTotalCents += paid;

  // 除息：价格按每股分红下调，避免「钱到账、股价不动」的机械套利
  const market = book.securityId ? state.securities.markets[book.securityId] : null;
  if (market) {
    const perShare = paid / base;
    adjustPrice(market, Math.max(1, Math.round(market.price - perShare)), atMinute);
  }

  // 人口月结的证券观察窗口：分红是真实的现金收益，只累计每股分配，
  // 不再叠加除息偏移（避免把同一笔钱记两次）
  if (book.securityId && paid > 0) {
    recordCashDistribution(state, book.securityId, paid / base);
    // 城市统计的连续指数是**另一份独立窗口**：同一笔真实每股现金也要记进去，
    // 但两份窗口各自维护，不共用会互相重置的可变状态。
    recordCityDividend(state, book.securityId, paid / base);
  }

  return { totalCents: paid, perShareCents: Math.round(paid / base), paidToPlayer, holderCount: holders };
}

/** 分红上限：扣除全部已发生应付后的现金（回购不使用这个口径）。 */
export function distributableCashOf(
  state: ReadonlyGameState, company: Enterprise | DeepReadonly<Enterprise>): number {
  const cash = state.finance.businessAccounts[company.id] ?? 0;
  const payables =
    company.payrollDue + company.cogsDue + company.marketingDue + company.opexDue + company.supplyDue;
  return Math.max(0, cash - payables);
}

/** 某个证券的可交易股本快照，供界面显示流动性。 */
export function liquidityOf(
  state: ReadonlyGameState,
  securityId: string,
): { deskShares: number; deskForSale: number; forSaleRatio: number; deskCash: number; playerShares: number } {
  const book = state.equity.books[securityId];
  const market = marketOf(state.securities, securityId);
  const deskShares = book ? sharesOf(book, MARKET_MAKER_HOLDER) : 0;
  return {
    deskShares,
    deskForSale: forSaleShares(market, deskShares),
    forSaleRatio: market ? market.forSaleRatio : 0,
    deskCash: subjectBalance(state.finance, 'market', DESK_ACCOUNT_ID),
    playerShares: playerHoldingOf(state, securityId).shares,
  };
}

/** 上市公司是否还满足「有外部融资 + 有股权簿」的上市前提。 */
export function canBeListed(book: ShareBook): boolean {
  return book.companyId !== null && book.hasExternalFinancing && !book.listed;
}

export function requiresMajorityWarning(book: ShareBook): boolean {
  return sharesOf(book, 'player') / Math.max(1, effectiveShares(book)) <= EQUITY_RULES.controlThreshold;
}

/** 供估值/行情类型导出，便于其它模块引用。 */
export type { MarketState, SecuritiesState };

/** 便利函数：某个证券的当前价。 */
export function priceOf(
  state: ReadonlyGameState, securityId: string): number {
  return marketOf(state.securities, securityId)?.price ?? 0;
}

/** 便利函数：证券名称（找不到时回退到 id）。 */
export function nameOf(
  state: ReadonlyGameState, securityId: string): string {
  return metaOf(state.securities, securityId)?.name ?? securityId;
}

/** 未使用的财务类型引用，保持导入整洁。 */
export type { FinanceState };
