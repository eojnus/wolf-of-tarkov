/**
 * 证券模块 —— 按证券 ID 管理行情、K 线、玩家持仓与成交记录。
 *
 * 职责边界：
 *  - 行情只由「经过的游戏分钟」驱动：每 tickMinutes 分钟更新一次价格，
 *    不使用 setInterval，打开面板不补算、不重抽。
 *  - 随机数使用可序列化的 32 位状态（每个证券一份），存档恢复后沿同一时间路径得到同一行情。
 *  - 本模块不判断「值多少钱」：合理价值由 app/securities-settlement 传入锚价，
 *    这里只负责把价格按有界规则走过去。
 *  - 交易撮合与资金在 app 层协调；这里只提供持仓成本与成交记录的纯计算。
 */

import { BusinessError } from '../../core/errors';
import type { DeepReadonly } from '../../core/readonly';
import { assertMoneyRange, safeAddMoney } from '../../core/money';
import { LIQUIDITY_RULES, MARKET_MAKING_RULES } from '../../content/capital';
import { MARKET } from '../../content/config';

export interface PricePoint {
  readonly minute: number;
  readonly price: number;
}

/** 一根 K 线。minute 是周期开始时刻（对齐到 candleMinutes 的整数倍）。 */
export interface Candle {
  readonly minute: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface MarketState {
  /** 当前价格（分/股）。 */
  price: number;
  /** 下一次更新的游戏分钟。 */
  nextTickMinute: number;
  /** 32 位伪随机状态（mulberry32）。 */
  rng: number;
  /** 有上限的近期价格，供走势图使用。 */
  history: PricePoint[];
  /** 累计更新次数，仅用于展示与调试。 */
  ticks: number;
  /** 已收盘 K 线，按时间升序、有上限。 */
  candles: Candle[];
  /** 当前未收盘的 K 线；行情不够时可能为 null。 */
  candleCurrent: Candle | null;
  /** 上一节点的价格，用于界面显示瞬时涨跌。 */
  previousPrice: number;
  /**
   * 做市商把这部分库存挂出来卖的比例（0～1）。
   *
   * 愿售股数 = floor(做市库存 × 该比例)，因此永远受真实库存约束：
   * 调整它不转移股份、不创造资金、不增发，也不自动卖出任何人的持仓。
   */
  forSaleRatio: number;
}

/** 证券静态信息：代码、名称、发行公司（旧独立标的为 null）。 */
export interface SecurityMeta {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly companyId: string | null;
  /**
   * 证券终止时刻。发行公司清算后证券终止：不再生成行情、不能交易、
   * 持仓按 0 价值计入，但历史成交与成本记录必须保留。
   */
  terminatedAtMinute: number | null;
}

/** 玩家在单个证券上的持仓。股数与股权簿中的 'player' 持股保持一致。 */
export interface PlayerHolding {
  shares: number;
  totalCost: number;
  realizedPnl: number;
  trades: number;
  /**
   * 该持仓的终止时刻（发行公司清算）。终止后：
   * 市值按 0 计，清算回收款与成本差额一次性结转到 realizedPnl，
   * 但股数、成本与成交记录保留，不删除记录冒充「已结清」。
   */
  terminatedAtMinute: number | null;
}

export type TradeSide = 'buy' | 'sell';

export interface TradeRecord {
  readonly id: string;
  readonly securityId: string;
  readonly minute: number;
  readonly side: TradeSide;
  readonly shares: number;
  readonly priceCents: number;
  readonly amountCents: number;
  /** 对手方 holderId，便于审计资金与股份流向。 */
  readonly counterparty: string;
}

export interface SecuritiesState {
  meta: Record<string, SecurityMeta>;
  markets: Record<string, MarketState>;
  holdings: Record<string, PlayerHolding>;
  trades: Record<string, TradeRecord[]>;
  nextTradeSeq: number;
}

export function createSecuritiesState(): SecuritiesState {
  return { meta: {}, markets: {}, holdings: {}, trades: {}, nextTradeSeq: 1 };
}

export function createHolding(): PlayerHolding {
  return { shares: 0, totalCost: 0, realizedPnl: 0, trades: 0, terminatedAtMinute: null };
}

export function createMarket(
  priceCents: number,
  nowMinute: number,
  seed: number,
  forSaleRatio: number = MARKET_MAKING_RULES.initialForSaleRatio,
): MarketState {
  const price = Math.max(1, Math.round(priceCents));
  return {
    price,
    previousPrice: price,
    nextTickMinute: nowMinute + MARKET.tickMinutes,
    rng: seed >>> 0,
    history: [{ minute: nowMinute, price }],
    ticks: 0,
    // 不从过去伪造：初始只有种子价，第一根 K 线从第一次行情更新开始积累
    candles: [],
    candleCurrent: null,
    forSaleRatio: clampRatio(forSaleRatio),
  };
}

/** 愿售比例统一夹在配置范围内；缺失或非法值回落到首轮默认值。 */
export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return MARKET_MAKING_RULES.initialForSaleRatio;
  return Math.min(
    MARKET_MAKING_RULES.maxForSaleRatio,
    Math.max(MARKET_MAKING_RULES.minForSaleRatio, ratio),
  );
}

/**
 * 当前愿售股数：做市库存 × 愿售比例，向下取整并夹在 [0, 库存] 内。
 *
 * 这是「在售股份」的唯一口径：证券交易预览、最大可买数量、公司回购与
 * 公司详情的饼图都必须走这里，不允许各自再算一套。
 */
export function forSaleShares(
  market: DeepReadonly<MarketState> | MarketState | null,
  deskShares: number,
): number {
  if (!market || deskShares <= 0) return 0;
  const ratio = clampRatio(market.forSaleRatio);
  // 比例是小数，直接乘再取整会在整边界上出现 0.7 × 10 = 6.999999… 这类误差；
  // 加一个远小于 1 股的容差，避免因为浮点误差少挂出 1 股。
  const shares = Math.floor(deskShares * ratio + 1e-6);
  return Math.min(deskShares, Math.max(0, shares));
}

/**
 * 行情节点上的愿售比例微调：上涨小幅提高、下跌小幅降低，单次不超过 maxStepPerTick。
 * 平盘不动。只改比例，不碰任何股份与资金。
 */
export function driftForSaleRatio(market: MarketState, direction: 'up' | 'down' | 'flat'): void {
  if (direction === 'flat') return;
  const step = MARKET_MAKING_RULES.maxStepPerTick;
  const next =
    direction === 'up' ? market.forSaleRatio + step : market.forSaleRatio - step;
  market.forSaleRatio = clampRatio(next);
}

export function registerSecurity(
  state: SecuritiesState,
  meta: Omit<SecurityMeta, 'terminatedAtMinute'> & { terminatedAtMinute?: number | null },
  market: MarketState,
): void {
  state.meta[meta.id] = { ...meta, terminatedAtMinute: meta.terminatedAtMinute ?? null };
  state.markets[meta.id] = market;
  if (!state.holdings[meta.id]) state.holdings[meta.id] = createHolding();
  if (!state.trades[meta.id]) state.trades[meta.id] = [];
}

/** 只读状态切片：查询路径接受它，写入路径仍用可写的 SecuritiesState。 */
type ReadonlySecurities = DeepReadonly<SecuritiesState>;

/** 证券是否已经终止（发行公司清算），终止后不计市值、不能交易。 */
export function isSecurityTerminated(
  state: SecuritiesState | ReadonlySecurities,
  securityId: string,
): boolean {
  const meta = state.meta[securityId];
  if (!meta) return true;
  return meta.terminatedAtMinute !== null;
}

export function hasSecurity(state: SecuritiesState | ReadonlySecurities, securityId: string): boolean {
  return state.markets[securityId] !== undefined;
}

export function metaOf(state: SecuritiesState, securityId: string): SecurityMeta | null;
export function metaOf(
  state: ReadonlySecurities,
  securityId: string,
): DeepReadonly<SecurityMeta> | null;
export function metaOf(
  state: SecuritiesState | ReadonlySecurities,
  securityId: string,
): SecurityMeta | DeepReadonly<SecurityMeta> | null {
  return state.meta[securityId] ?? null;
}

export function marketOf(state: SecuritiesState, securityId: string): MarketState | null;
export function marketOf(
  state: ReadonlySecurities,
  securityId: string,
): DeepReadonly<MarketState> | null;
export function marketOf(
  state: SecuritiesState | ReadonlySecurities,
  securityId: string,
): MarketState | DeepReadonly<MarketState> | null {
  return state.markets[securityId] ?? null;
}

/** 写入路径：缺失时补建持仓。只能在草稿或初始化里调用。 */
export function holdingOf(state: SecuritiesState, securityId: string): PlayerHolding {
  let holding = state.holdings[securityId];
  if (!holding) {
    holding = createHolding();
    state.holdings[securityId] = holding;
  }
  return holding;
}

/** 共享的空持仓：只读查询用它表示「这只证券没有持仓」，不写入状态。 */
const EMPTY_HOLDING: DeepReadonly<PlayerHolding> = Object.freeze({
  shares: 0,
  totalCost: 0,
  realizedPnl: 0,
  trades: 0,
  terminatedAtMinute: null,
});

/**
 * 只读查询：取玩家在某个证券上的持仓视图。
 *
 * 与 `holdingOf` 的区别是**不补建**：缺失时返回共享的空持仓，
 * 因此视图、估值、交易预览都可以安全调用它而不改动正式状态。
 */
export function holdingViewOf(
  state: SecuritiesState | ReadonlySecurities,
  securityId: string,
): DeepReadonly<PlayerHolding> {
  return state.holdings[securityId] ?? EMPTY_HOLDING;
}

export function tradesOf(state: SecuritiesState, securityId: string): readonly TradeRecord[];
export function tradesOf(
  state: ReadonlySecurities,
  securityId: string,
): readonly DeepReadonly<TradeRecord>[];
export function tradesOf(
  state: SecuritiesState | ReadonlySecurities,
  securityId: string,
): readonly TradeRecord[] | readonly DeepReadonly<TradeRecord>[] {
  return state.trades[securityId] ?? [];
}

/** 按证券 ID 排序的列表，保证界面顺序稳定。 */
export function securityIds(state: SecuritiesState | ReadonlySecurities): string[] {
  return Object.keys(state.markets).sort();
}

export function securitiesOfCompany(
  state: SecuritiesState | ReadonlySecurities,
  companyId: string,
): string[] {
  return Object.values(state.meta)
    .filter((meta) => meta.companyId === companyId)
    .map((meta) => meta.id);
}

/* ---------------------------------------------------------------- 随机 */

/** mulberry32：状态是一个 32 位整数，可完整进存档。 */
function nextRandom(state: { rng: number }): number {
  let t = (state.rng = (state.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/* ---------------------------------------------------------------- 行情 */

/** K 线周期起点。 */
export function candleBucketStart(minute: number): number {
  return Math.floor(minute / MARKET.candleMinutes) * MARKET.candleMinutes;
}

/**
 * 把一次行情更新并入 K 线。
 *
 * - 开盘价取「周期开始时的有效价格」（即本次更新前的价格）；
 * - 最高/最低包含本周期内的所有有效价格；
 * - 收盘价是本周期最后一次更新的价格；
 * - 跨越周期时先把上一根收盘入库，再开新的一根，边界价格只归属一个周期。
 */
function foldCandle(market: MarketState, tickAt: number, priceBefore: number, priceAfter: number): void {
  const bucket = candleBucketStart(tickAt);
  const current = market.candleCurrent;
  if (!current || current.minute !== bucket) {
    if (current) {
      market.candles.push(current);
      if (market.candles.length > MARKET.candleLimit) {
        market.candles.splice(0, market.candles.length - MARKET.candleLimit);
      }
    }
    market.candleCurrent = {
      minute: bucket,
      open: priceBefore,
      high: Math.max(priceBefore, priceAfter),
      low: Math.min(priceBefore, priceAfter),
      close: priceAfter,
    };
    return;
  }
  if (priceAfter > current.high) current.high = priceAfter;
  if (priceAfter < current.low) current.low = priceAfter;
  current.close = priceAfter;
}

export interface MarketAdvanceOptions {
  /**
   * 合理价值锚（分/股）。给了锚就会在随机波动之外向锚缓慢靠拢，
   * 这是「经营驱动股价」的唯一入口；不传则保持纯零趋势随机（旧独立标的）。
   */
  readonly anchorPrice?: () => number;
  /** 每个节点向锚靠拢的比例。 */
  readonly pull?: number;
  /** 单节点相对锚的最大变动。 */
  readonly maxTickChange?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function advanceMarket(
  market: MarketState,
  upToMinute: number,
  options: MarketAdvanceOptions = {},
): number {
  if (market.nextTickMinute <= 0) {
    throw new BusinessError('INVALID_MARKET_STATE', '行情状态异常：下一次更新时间非法');
  }
  let updates = 0;
  let guard = 0;
  while (market.nextTickMinute <= upToMinute) {
    guard += 1;
    if (guard > 200_000) {
      throw new BusinessError('MARKET_OVERFLOW', '行情更新次数异常，已中止');
    }
    const tickAt = market.nextTickMinute;
    const priceBefore = market.price;
    const roll = nextRandom(market);
    const noise = (roll * 2 - 1) * MARKET.maxChangePct;

    let pct = noise;
    if (options.anchorPrice) {
      const anchor = Math.max(1, options.anchorPrice());
      const pull = options.pull ?? 0.06;
      const cap = options.maxTickChange ?? 0.02;
      const gap = anchor / priceBefore - 1;
      pct = clamp(gap * pull + noise, -cap, cap);
    }

    market.previousPrice = priceBefore;
    market.price = Math.max(1, Math.round(priceBefore * (1 + pct)));
    foldCandle(market, tickAt, priceBefore, market.price);

    market.history.push({ minute: tickAt, price: market.price });
    if (market.history.length > MARKET.historyLimit) {
      market.history.splice(0, market.history.length - MARKET.historyLimit);
    }

    market.nextTickMinute = tickAt + MARKET.tickMinutes;
    market.ticks += 1;
    updates += 1;
  }
  return updates;
}

/**
 * 资本行为造成的机械调整（分红除息、增发摊薄）。
 * 走同一份行情记录与 K 线，不另写第二份图表价格。
 */
export function adjustPrice(
  market: MarketState,
  targetPriceCents: number,
  atMinute: number,
): void {
  const next = Math.max(1, Math.round(targetPriceCents));
  if (next === market.price) return;
  const before = market.price;
  market.previousPrice = before;
  market.price = next;
  foldCandle(market, atMinute, before, next);
  const last = market.history[market.history.length - 1];
  if (last && last.minute === atMinute) {
    market.history[market.history.length - 1] = { minute: atMinute, price: next };
  } else {
    market.history.push({ minute: atMinute, price: next });
    if (market.history.length > MARKET.historyLimit) {
      market.history.splice(0, market.history.length - MARKET.historyLimit);
    }
  }
}

/* ---------------------------------------------------------------- 查询 */

export function marketValue(holding: DeepReadonly<PlayerHolding>, price: number): number {
  return holding.shares * price;
}

export function unrealizedPnl(holding: DeepReadonly<PlayerHolding>, price: number): number {
  return marketValue(holding, price) - holding.totalCost;
}

export function averageCost(holding: DeepReadonly<PlayerHolding>): number {
  if (holding.shares <= 0) return 0;
  return holding.totalCost / holding.shares;
}

export function priceChangeOf(market: DeepReadonly<MarketState>): { change: number; pct: number } {
  const first = market.history[0]?.price ?? market.price;
  const change = market.price - first;
  const pct = first > 0 ? change / first : 0;
  return { change, pct };
}

export function changeSpanMinutes(market: DeepReadonly<MarketState>): number {
  const first = market.history[0]?.minute;
  if (first === undefined) return 0;
  return Math.max(0, market.nextTickMinute - MARKET.tickMinutes - first);
}

export function candlesOf(market: DeepReadonly<MarketState>): {
  closed: readonly DeepReadonly<Candle>[];
  current: DeepReadonly<Candle> | null;
} {
  return { closed: market.candles, current: market.candleCurrent };
}

/* ---------------------------------------------------------------- 持仓 */

/** 买入后更新持仓成本。资金与股份由 app 层在同一次提交里处理。 */
export function applyBuy(holding: PlayerHolding, shares: number, amountCents: number): void {
  if (!Number.isSafeInteger(shares) || shares <= 0) {
    throw new BusinessError('INVALID_SHARES', '买入股数必须是正整数');
  }
  assertMoneyRange(amountCents, '买入金额');
  holding.shares += shares;
  holding.totalCost = safeAddMoney(holding.totalCost, amountCents, '持仓成本');
  holding.trades += 1;
}

/**
 * 卖出后结转成本：收入不等于利润，二者分开记录。
 * 按比例结转，全部卖出时清零，避免浮点残差。
 */
export function applySell(
  holding: PlayerHolding,
  shares: number,
  amountCents: number,
): { costBasis: number; realized: number } {
  if (!Number.isSafeInteger(shares) || shares <= 0) {
    throw new BusinessError('INVALID_SHARES', '卖出股数必须是正整数');
  }
  if (shares > holding.shares) {
    throw new BusinessError('INSUFFICIENT_SHARES', '持股不足，无法卖出');
  }
  assertMoneyRange(amountCents, '卖出金额');
  const costBasis =
    shares === holding.shares
      ? holding.totalCost
      : Math.round((holding.totalCost * shares) / holding.shares);
  const realized = amountCents - costBasis;
  holding.shares -= shares;
  holding.totalCost -= costBasis;
  if (holding.shares === 0) holding.totalCost = 0;
  holding.realizedPnl += realized;
  holding.trades += 1;
  return { costBasis, realized };
}

/** 追加一条成交记录（有上限，旧的丢弃）。 */
export function pushTrade(state: SecuritiesState, record: Omit<TradeRecord, 'id'>): TradeRecord {
  const entry: TradeRecord = { id: `trade-${state.nextTradeSeq}`, ...record };
  state.nextTradeSeq += 1;
  const list = state.trades[record.securityId] ?? [];
  list.push(entry);
  if (list.length > LIQUIDITY_RULES.tradeLogLimit) {
    list.splice(0, list.length - LIQUIDITY_RULES.tradeLogLimit);
  }
  state.trades[record.securityId] = list;
  return entry;
}

/**
 * 终止一只证券（发行公司清算）。
 *
 * 只标记状态，不删除任何记录：股数、成本、成交明细都保留，
 * 但此后不再计市值、不能再交易、也不再生成行情。
 */
export function terminateSecurity(
  state: SecuritiesState,
  securityId: string,
  atMinute: number,
): void {
  const meta = state.meta[securityId];
  if (meta && meta.terminatedAtMinute === null) meta.terminatedAtMinute = atMinute;
}

/**
 * 结算玩家在终止证券上的最终投资结果：回收款 − 剩余持仓成本。
 * 只在持仓尚未终止时执行一次，避免清算回款与已实现盈亏重复计算。
 */
export function settleTerminatedHolding(
  holding: PlayerHolding,
  proceedsCents: number,
  atMinute: number,
): number {
  if (holding.terminatedAtMinute !== null) return 0;
  const realized = holding.shares > 0 ? proceedsCents - holding.totalCost : proceedsCents;
  holding.realizedPnl += realized;
  holding.terminatedAtMinute = atMinute;
  return realized;
}
