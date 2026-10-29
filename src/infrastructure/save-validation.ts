/**
 * 存档校验 —— 字段合法性与跨切片一致性。
 *
 * 全部是「读 + 断言」，不修复、不补建、不写库：
 * 迁移后的规范化在 save-migrations，读写与回退在 storage。
 */

import { CALENDAR, JOBS, LOAN, MARKET } from '../content/config';
import { ITEMS } from '../content/items';
import { SURVIVAL } from '../content/survival';
import { ENTERPRISE_RULES, PRODUCT_MARKET, TALENT_CANDIDATES, TECH } from '../content/business';
import {
  CANDIDATES,
  CAMPAIGN_RULES,
  ELECTION_RULES,
  POLICY_EFFECTS,
  candidateConfig,
  type CandidateId,
  type PolicyId,
} from '../content/government';
import {
  EARLY_ELECTION_RULES,
  MARGIN_DEFINITIONS,
  POLITICS_GROUPS,
  SATISFACTION_RULES,
} from '../content/politics';
import {
  CITY_DEVELOPMENT_RULES,
  CITY_ECONOMY_RULES,
  CITY_STATISTICS_LIMITS,
  CONSTRUCTION_OUTCOME_LABELS,
} from '../content/city-economy';
import { DISTRICT_LAYOUT } from '../content/districts';
import { HOME_LAYOUTS, HOUSING_GROUPS, REAL_ESTATE_RULES } from '../content/real-estate';
import { POPULATION_RULES } from '../content/population';
import {
  FURNITURE_DEFINITIONS,
  FURNITURE_LAYOUT_VERSION,
  FURNITURE_RESIDENCE_ID,
  instanceIdOf,
} from '../content/interior';
import { footprintForRotation, isCellPlacementValid } from '../features/furniture';
import { MARKET_MAKING_RULES, PRODUCT_STOCK_RULES, PROMOTION_RULES, findInvestor } from '../content/capital';
import { BusinessError } from '../core/errors';
import { MINUTES_PER_MONTH } from '../features/talent';
import { WAGE_ACCRUAL_DENOMINATOR } from '../features/employment';
import {
  LEGACY_PROTOCOL_VERSION,
  MAX_REQUEST_RECORDS,
  SUPPLY_PROTOCOL_VERSION,
  formatSupplyRequestId,
} from '../features/inventory';
import { checkBookIntegrity, isValidCeoIdentity, type ShareBook } from '../features/equity';
import { isWeatherKind } from '../features/environment';
import { CARETAKER_PERSON_ID, GOVERNMENT_CONFIG_VERSION } from '../features/government';

/* ---------------------------------------------------------------- 校验 */

/** 本轮新增切片的合法 id 集合：校验「集合完整」而不是只检查已有键。 */
const CANDIDATE_IDS: ReadonlySet<string> = new Set(CANDIDATES.map((candidate) => candidate.id));
const POLITICAL_GROUP_IDS: ReadonlySet<string> = new Set(
  POLITICS_GROUPS.map((group) => group.id),
);
const MARGIN_IDS: ReadonlySet<string> = new Set(MARGIN_DEFINITIONS.map((row) => row.id));
const POLICY_IDS: ReadonlySet<string> = new Set(
  Object.keys(POLICY_EFFECTS) as PolicyId[],
);
const ITEM_IDS: ReadonlySet<string> = new Set(ITEMS.map((item) => item.id));
const JOB_IDS: ReadonlySet<string> = new Set(JOBS.map((job) => job.id));

export function fail(message: string): never {
  throw new BusinessError('INVALID_SAVE', message);
}

export function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} 结构不正确`);
  }
  return value as Record<string, unknown>;
}

function assertNonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${label} 必须是非负整数`);
  }
  return value;
}

export function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} 必须是字符串`);
  return value;
}

function assertAccountRef(value: unknown, label: string): void {
  const account = assertObject(value, label);
  const owner = assertString(account.owner, `${label}.owner`);
  if (
    owner !== 'personal' &&
    owner !== 'business' &&
    owner !== 'investor' &&
    owner !== 'market' &&
    owner !== 'household' &&
    owner !== 'external'
  ) {
    fail(`${label}.owner 取值非法`);
  }
  assertString(account.id, `${label}.id`);
}

const CATEGORIES = new Set([
  'initial',
  'salary',
  'rent',
  'living',
  'deposit',
  'withdrawal',
  'debt-repayment',
  'stock-buy',
  'stock-sell',
  'loan-drawdown',
  'loan-principal',
  'loan-interest',
  'business-capital',
  'business-dividend',
  'business-liquidation',
  'business-revenue',
  'business-cogs',
  'business-wages',
  'business-research',
  'business-marketing',
  'business-opex',
  'equity-financing',
  'business-buyback',
  'equity-promotion',
  'election-sponsorship',
  'supplies',
  'home-purchase',
  'home-sale',
  'land-purchase',
  'land-sale',
  'housing-income',
  'housing-consumption',
  'housing-reclassification',
]);

function assertNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} 必须是数字`);
  return value;
}

function assertOptionalNonNegativeInt(value: unknown, label: string): void {
  if (value === null || value === undefined) return;
  assertNonNegativeInt(value, label);
}

function assertSignedInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail(`${label} 必须是整数`);
  return value;
}

/** 与贷款模块同一口径的计息分母，用于校验余量是否越界（不引入业务模块依赖）。 */
function interestDenominatorOf(): number {
  return Math.round((LOAN.termDays * CALENDAR.minutesPerDay) / LOAN.interestRatePerTerm);
}

/**
 * 版本迁移。真实发生过的格式变化才会出现在这里，不为「将来可能改」预埋空壳。
 *
 * v1 → v2：新增行情、持仓、贷款三个切片。
 *   - 旧资金、就业、生活欠款、位置与游戏时间原样保留；
 *   - 股票从空持仓开始；
 *   - 行情从「迁移时的游戏时间」开始，不追溯生成旧时期价格。
 *
 * v2 → v3：新增人口、企业、科技、人才与 AI 五个切片。
 *   - 个人资金、贷款、股票、就业、时间与位置原样保留；
 *   - 玩家初始没有公司，也不获得任何企业资金；
 *   - 三家 AI 从「迁移时刻」开始经营：不追溯销售、工资与研发；
 *   - 同一份 v2 存档每次迁移都得到相同结果（固定 id、固定注资），不会重复注资。
 */

/* ---------------------------------------------------------- K 线校验 */

function assertCandle(value: unknown, label: string, periodMinutes: number): void {
  const candle = assertObject(value, label);
  const minute = assertNonNegativeInt(candle.minute, `${label}时间`);
  if (minute % periodMinutes !== 0) fail(`${label}时间未对齐到 K 线周期`);
  const { open, high, low, close } = candle;
  for (const [key, price] of Object.entries({ open, high, low, close })) {
    const value = assertNonNegativeInt(price, `${label}${key}`);
    if (value < 1) fail(`${label}价格不能低于 1 分`);
  }
  const o = open as number;
  const h = high as number;
  const l = low as number;
  const c = close as number;
  if (h < o || h < c) fail(`${label}最高价低于开盘或收盘`);
  if (l > o || l > c) fail(`${label}最低价高于开盘或收盘`);
}

function validateCandles(market: Record<string, unknown>): void {
  if (!Array.isArray(market.candles)) fail('K 线数据非法');
  if (market.candles.length > MARKET.candleLimit) fail('K 线数量超出上限');
  let lastMinute = -1;
  for (const [index, item] of market.candles.entries()) {
    assertCandle(item, `第 ${index + 1} 根 K 线`, MARKET.candleMinutes);
    const minute = (item as Record<string, unknown>).minute as number;
    // 已收盘 K 线必须严格递增且不重复，否则图表会画错
    if (minute <= lastMinute) fail('K 线时间顺序非法');
    lastMinute = minute;
  }
  if (market.candleCurrent !== null && market.candleCurrent !== undefined) {
    assertCandle(market.candleCurrent, '未收盘 K 线', MARKET.candleMinutes);
    const minute = (market.candleCurrent as Record<string, unknown>).minute as number;
    if (minute <= lastMinute) fail('未收盘 K 线早于最后一根已收盘 K 线');
  }
}

/* ------------------------------------------------------ 经营相关校验 */

function validatePopulation(state: Record<string, unknown>): void {
  const population = assertObject(state.population, 'state.population');
  if (!Array.isArray(population.groups) || population.groups.length === 0) {
    fail('人口群体数据非法');
  }
  let weightSum = 0;
  for (const [index, item] of population.groups.entries()) {
    const group = assertObject(item, `第 ${index + 1} 个人口群体`);
    assertString(group.id, `第 ${index + 1} 个群体标识`);
    assertString(group.name, `第 ${index + 1} 个群体名称`);
    const weight = assertNumber(group.weight, `第 ${index + 1} 个群体权重`);
    if (weight < 0 || weight > 1) fail('人口权重必须在 0～1 之间');
    weightSum += weight;
    const pref = assertObject(group.preferences, `第 ${index + 1} 个群体偏好`);
    for (const key of ['performance', 'reliability', 'usability'] as const) {
      const value = assertNumber(pref[key], `第 ${index + 1} 个群体偏好`);
      if (value < 0) fail('品质偏好不能为负');
    }
  }
  if (Math.abs(weightSum - 1) > 0.001) fail('人口权重合计必须为 1');
}

/** 市场月度摘要的公共结构（观察样本、窗口历史、人口记录都用它）。 */
function validateMarketSummaryShape(value: unknown, label: string): void {
  const summary = assertObject(value, label);
  // returnRate 是原始市场收益率，不是标准化经营指标：只拒绝 NaN / Infinity，
  // 合法大涨（如 +120%）必须原样读回，不能按 [-1,1] 截断。
  assertNumber(summary.returnRate, `${label}回报`);
  for (const key of ['downRatio', 'upRatio'] as const) {
    const ratio = assertNumber(summary[key], `${label}${key}`);
    if (ratio < 0 || ratio > 1) fail(`${label}${key} 必须在 0～1 之间`);
  }
  if (typeof summary.valid !== 'boolean') fail(`${label}缺少有效标记`);
}

/**
 * 动态人口校验：阶层人数、增长锚点、观察样本与月度记录。
 * 只读不修：越界一律拒绝，不静默改写人口。
 */
function validatePopulationDynamics(
  population: Record<string, unknown>,
  totalMinute: number,
): void {
  const classes = assertObject(population.classes, 'state.population.classes');
  let sum = 0;
  for (const key of ['low', 'mid', 'high'] as const) {
    const value = assertNumber(classes[key], `人口阶层 ${key}`);
    if (value < 0) fail('人口阶层人数不能为负');
    sum += value;
  }
  if (sum <= 0) fail('城市总人口必须大于 0');

  const anchor = assertNonNegativeInt(population.growthAnchorMinute, '人口增长锚点');
  const synced = assertNonNegativeInt(population.growthSyncedMinute, '人口增长同步点');
  if (synced < anchor) fail('人口增长同步点早于锚点');
  if (synced > totalMinute) fail('人口增长同步点晚于当前时间');
  if (anchor > totalMinute) fail('人口增长锚点晚于当前时间');
  const anchorTotal = assertNumber(population.growthAnchorTotal, '人口锚点总数');
  if (anchorTotal <= 0) fail('人口锚点总数必须大于 0');

  const observationStart = assertNonNegativeInt(
    population.businessObservationStartMinute,
    '人口经营观察起点',
  );
  if (observationStart > totalMinute) fail('人口经营观察起点晚于当前时间');

  const weight = POPULATION_RULES.businessWeight;
  const businessMonths = population.businessMonths;
  if (!Array.isArray(businessMonths)) fail('人口经营观察样本非法');
  if (businessMonths.length > 4) fail('人口经营观察样本过多');
  for (const [index, item] of businessMonths.entries()) {
    const sample = assertObject(item, `第 ${index + 1} 个人口经营观察样本`);
    assertString(sample.monthKey, `第 ${index + 1} 个人口经营观察月份`);
    for (const key of ['j', 'i', 'p'] as const) {
      const value = assertNumber(sample[key], `第 ${index + 1} 个人口经营观察 ${key}`);
      // 观察样本保存的是企业等权的**原始有界值**（0.30 权重在人口模块结算时乘一次）
      if (key === 'p' ? value < 0 || value > 1 : value < -1 || value > 1) {
        fail(`第 ${index + 1} 个人口经营观察 ${key} 越界`);
      }
    }
    if (typeof sample.complete !== 'boolean') fail('人口经营观察样本缺少完整标记');
  }

  const marketMonths = population.marketMonths;
  if (!Array.isArray(marketMonths)) fail('人口市场观察样本非法');
  if (marketMonths.length > 4) fail('人口市场观察样本过多');
  for (const [index, item] of marketMonths.entries()) {
    const sample = assertObject(item, `第 ${index + 1} 个人口市场观察样本`);
    assertString(sample.monthKey, `第 ${index + 1} 个人口市场观察月份`);
    validateMarketSummaryShape(sample, `第 ${index + 1} 个人口市场观察样本`);
  }

  const window = assertObject(population.marketWindow, 'state.population.marketWindow');
  assertString(window.monthKey, '人口市场观察窗口月份');
  const fixedAt = assertNonNegativeInt(window.fixedAtMinute, '人口市场观察窗口固定时刻');
  if (fixedAt > totalMinute) fail('人口市场观察窗口固定时刻晚于当前时间');
  if (typeof window.fixedAtMonthStart !== 'boolean') fail('人口市场观察窗口缺少完整月标记');
  if (!Array.isArray(window.history)) fail('人口市场观察窗口历史非法');
  if (window.history.length > POPULATION_RULES.historyLimit) fail('人口市场观察窗口历史过多');
  for (const [index, item] of window.history.entries()) {
    validateMarketSummaryShape(item, `第 ${index + 1} 条人口市场窗口历史`);
  }
  const samples = assertObject(window.samples, '人口市场观察样本集');
  for (const [securityId, item] of Object.entries(samples)) {
    const sample = assertObject(item, `市场样本 ${securityId}`);
    if (assertString(sample.securityId, `市场样本 ${securityId} 标识`) !== securityId) {
      fail(`市场样本 ${securityId} 的 id 与键不一致`);
    }
    const baseline = assertNumber(sample.baselinePrice, `市场样本 ${securityId} 基准价`);
    if (baseline < 1) fail(`市场样本 ${securityId} 基准价非法`);
    const cash = assertNumber(sample.cashPerShare, `市场样本 ${securityId} 每股现金分配`);
    if (cash < 0) fail(`市场样本 ${securityId} 每股现金分配不能为负`);
    // 机械调整改为乘法参考因子：必须为正的有限数（v11 的绝对偏移由 v12 迁移转换）
    const factor = assertNumber(sample.referenceFactor, `市场样本 ${securityId} 参考因子`);
    if (!(factor > 0)) fail(`市场样本 ${securityId} 参考因子必须大于 0`);
    if (typeof sample.terminated !== 'boolean') fail(`市场样本 ${securityId} 缺少终止标记`);
    if (sample.terminated) {
      const recovery = assertNumber(
        sample.recoveryPerShare,
        `市场样本 ${securityId} 每股回收价值`,
      );
      if (recovery < 0) fail(`市场样本 ${securityId} 每股回收价值不能为负`);
    } else if (sample.recoveryPerShare !== null) {
      fail(`市场样本 ${securityId} 未终止却带有回收价值`);
    }
  }

  const records = population.records;
  if (!Array.isArray(records)) fail('人口月度记录非法');
  if (records.length > POPULATION_RULES.historyLimit) fail('人口月度记录过多');
  let lastMonthKey = '';
  for (const [index, item] of records.entries()) {
    const record = assertObject(item, `第 ${index + 1} 条人口月度记录`);
    const monthKey = assertString(record.monthKey, `第 ${index + 1} 条人口月度记录月份`);
    if (monthKey <= lastMonthKey) fail('人口月度记录月份必须严格递增');
    lastMonthKey = monthKey;
    const settled = assertNonNegativeInt(
      record.settledAtMinute,
      `第 ${index + 1} 条人口记录的结算时刻`,
    );
    if (settled > totalMinute) fail(`第 ${index + 1} 条人口记录的结算时刻晚于当前时间`);
    assertNumber(record.growthPeople, `第 ${index + 1} 条人口记录的自然增长`);
    const before = assertObject(record.classesBefore, `第 ${index + 1} 条人口记录的结算前人数`);
    const after = assertObject(record.classesAfter, `第 ${index + 1} 条人口记录的结算后人数`);
    for (const key of ['low', 'mid', 'high'] as const) {
      const a = assertNumber(before[key], `第 ${index + 1} 条人口记录结算前 ${key}`);
      const b = assertNumber(after[key], `第 ${index + 1} 条人口记录结算后 ${key}`);
      if (a < 0 || b < 0) fail('人口月度记录人数不能为负');
    }
    const flow = assertObject(record.flow, `第 ${index + 1} 条人口记录的流动人数`);
    for (const key of ['lm', 'ml', 'mh', 'hm'] as const) {
      const value = assertNumber(flow[key], `第 ${index + 1} 条人口记录流动 ${key}`);
      if (value < 0) fail('人口月度记录的流动人数不能为负');
    }
    const business = assertObject(record.business, `第 ${index + 1} 条人口记录的经营指标`);
    for (const key of ['j', 'i', 'p'] as const) {
      const value = assertNumber(business[key], `第 ${index + 1} 条人口记录经营 ${key}`);
      const min = key === 'p' ? 0 : -weight;
      if (value < min - 1e-9 || value > weight + 1e-9) {
        fail(`第 ${index + 1} 条人口记录的经营 ${key} 越界`);
      }
    }
    validateMarketSummaryShape(record.market, `第 ${index + 1} 条人口记录的市场摘要`);
  }
}

/**
 * 政治交叉群体与满意度校验。
 *
 * 人数不在政治切片里存权威副本（只由经济阶层人数派生），因此这里只校验：
 *  - 12 个群体齐全、id 与键一致、满意度在 0～100；
 *  - 提前选举监测的连续月计数、保护期与本任期一次性标记合法；
 *  - 满意度历史月份严格递增且条数有限。
 */
function validatePolitics(state: Record<string, unknown>): void {
  const politics = assertObject(state.politics, 'state.politics');
  const groups = assertObject(politics.groups, 'state.politics.groups');
  for (const [groupId, item] of Object.entries(groups)) {
    if (!POLITICAL_GROUP_IDS.has(groupId)) fail(`政治群体标识非法：${groupId}`);
    const group = assertObject(item, `政治群体 ${groupId}`);
    if (assertString(group.id, `政治群体 ${groupId} 标识`) !== groupId) {
      fail(`政治群体 ${groupId} 的 id 与键不一致`);
    }
    const satisfaction = assertNumber(group.satisfaction, `政治群体 ${groupId} 满意度`);
    if (satisfaction < SATISFACTION_RULES.min || satisfaction > SATISFACTION_RULES.max) {
      fail(`政治群体 ${groupId} 满意度越界（必须在 0～100）`);
    }
  }
  for (const groupId of POLITICAL_GROUP_IDS) {
    if (groups[groupId] === undefined) fail(`缺少政治群体：${groupId}`);
  }
  if (politics.lastUpdatedMonthKey !== null && politics.lastUpdatedMonthKey !== undefined) {
    assertString(politics.lastUpdatedMonthKey, '政治群体最近更新月份');
  }
  const lastSummary = politics.lastSummary;
  if (lastSummary !== null && lastSummary !== undefined) {
    const summary = assertObject(lastSummary, '政治群体最近经济摘要');
    // 满意度输入使用**显式还原尺度后**的原始 J/I/P，因此与 0.30 权重后的值不同界：
    // J/I ∈ [-1,1]，P ∈ [0,1]；这里只校验还原后的合法范围。
    for (const key of ['j', 'i'] as const) {
      const value = assertNumber(summary[key], `政治群体最近经济摘要 ${key}`);
      if (value < -1 - 1e-9 || value > 1 + 1e-9) fail(`政治群体最近经济摘要 ${key} 越界`);
    }
    const pressure = assertNumber(summary.p, '政治群体最近经济摘要 p');
    if (pressure < 0 || pressure > 1) fail('政治群体最近经济摘要 p 越界');
    const average = assertNumber(summary.averageSatisfaction, '政治群体最近经济摘要平均满意度');
    if (
      average < SATISFACTION_RULES.min - 1e-9 ||
      average > SATISFACTION_RULES.max + 1e-9
    ) {
      fail('政治群体最近经济摘要平均满意度越界');
    }
    assertString(summary.monthKey, '政治群体最近经济摘要月份');
  }

  const monitor = assertObject(politics.earlyElection, '提前选举监测');
  const cityMonths = assertNonNegativeInt(monitor.cityMonths, '提前选举全市连续月计数');
  if (cityMonths > EARLY_ELECTION_RULES.consecutiveMonths) {
    fail('提前选举全市连续月计数越界');
  }
  const groupMonths = assertObject(monitor.groupMonths, '提前选举主要群体连续月计数');
  for (const [marginId, value] of Object.entries(groupMonths)) {
    if (!MARGIN_IDS.has(marginId)) fail(`提前选举主要群体标识非法：${marginId}`);
    const months = assertNonNegativeInt(value, `提前选举 ${marginId} 连续月计数`);
    if (months > EARLY_ELECTION_RULES.consecutiveMonths) {
      fail(`提前选举 ${marginId} 连续月计数越界`);
    }
  }
  for (const margin of MARGIN_DEFINITIONS) {
    if (groupMonths[margin.id] === undefined) fail(`缺少提前选举主要群体计数：${margin.id}`);
  }
  if (monitor.lastEvaluatedMonthKey !== null && monitor.lastEvaluatedMonthKey !== undefined) {
    assertString(monitor.lastEvaluatedMonthKey, '提前选举最近检查月份');
  }
  if (monitor.lastTriggeredTermId !== null && monitor.lastTriggeredTermId !== undefined) {
    assertString(monitor.lastTriggeredTermId, '提前选举已触发任期');
  }
  assertNonNegativeInt(monitor.protectionUntilMinute, '提前选举保护期结束时刻');

  const history = politics.history;
  if (!Array.isArray(history)) fail('满意度历史非法');
  if (history.length > SATISFACTION_RULES.historyLimit) fail('满意度历史过多');
  let previousMonth = '';
  for (const [index, item] of history.entries()) {
    const point = assertObject(item, `第 ${index + 1} 条满意度历史`);
    const monthKey = assertString(point.monthKey, `第 ${index + 1} 条满意度历史月份`);
    if (monthKey <= previousMonth) fail('满意度历史月份必须严格递增');
    previousMonth = monthKey;
    const average = assertNumber(point.average, `第 ${index + 1} 条满意度历史平均值`);
    if (
      average < SATISFACTION_RULES.min - 1e-9 ||
      average > SATISFACTION_RULES.max + 1e-9
    ) {
      fail(`第 ${index + 1} 条满意度历史平均值越界`);
    }
    if (typeof point.cityBelowThreshold !== 'boolean') fail('满意度历史缺少全市阈值标记');
    const margins = point.triggeredMargins;
    if (!Array.isArray(margins)) fail('满意度历史缺少主要群体标记');
    for (const marginId of margins) {
      if (!MARGIN_IDS.has(assertString(marginId, '满意度历史主要群体标识'))) {
        fail('满意度历史主要群体标识非法');
      }
    }
  }
}

function assertCandidateIdValue(value: unknown, label: string): CandidateId {
  const id = assertString(value, label);
  if (!CANDIDATE_IDS.has(id)) fail(`${label} 非法：${id}`);
  return id as CandidateId;
}

function assertPolicyIdValue(value: unknown, label: string): PolicyId {
  const id = assertString(value, label);
  if (!POLICY_IDS.has(id)) fail(`${label} 非法：${id}`);
  return id as PolicyId;
}

/**
 * 竞选状态机、赞助单据与选举结果校验。
 *
 * 日程按阶段分别校验：
 *  - `campaign`：竞选已经开始、投票时刻在未来；资源锚点在竞选开始之后；
 *  - `between`：下一届竞选开始与投票都在未来（正常读档时的合法未来日程），
 *    且竞选开始 = 投票时刻 − 竞选期；`campaignStart > now` 是合法状态，不能拒绝。
 */
function validateElections(state: Record<string, unknown>, totalMinute: number): void {
  const elections = assertObject(state.elections, 'state.elections');
  const phase = assertString(elections.phase, '竞选阶段');
  if (phase !== 'campaign' && phase !== 'between') fail('竞选阶段非法');
  const campaignStart = assertNonNegativeInt(elections.campaignStartMinute, '竞选开始时间');
  const deadline = assertNonNegativeInt(elections.deadlineMinute, '投票时间');
  if (deadline <= campaignStart) fail('投票时间必须晚于竞选开始时间');
  if (deadline - campaignStart > ELECTION_RULES.campaignDays * CALENDAR.minutesPerDay) {
    fail('竞选时长超过配置的竞选期');
  }
  const termSeq = assertNonNegativeInt(elections.termSeq, '选举届次');
  if (termSeq < 1) fail('选举届次必须从 1 开始');

  const lastUsageAnchor = assertNonNegativeInt(
    elections.lastUsageAnchorMinute,
    '竞选资源使用锚点',
  );
  if (lastUsageAnchor > totalMinute) fail('竞选资源使用锚点晚于当前时间');
  const tieRng = assertNonNegativeInt(elections.tieRng, '平票抽签状态');
  if (tieRng > 0xffffffff) fail('平票抽签状态超出 32 位范围');

  if (phase === 'campaign') {
    if (campaignStart > totalMinute) fail('竞选阶段但竞选开始时间晚于当前时间');
    if (deadline <= totalMinute) fail('竞选阶段但投票时间已经过去');
    if (lastUsageAnchor < campaignStart) fail('竞选资源使用锚点早于本届竞选开始时间');
  } else {
    if (campaignStart <= totalMinute) fail('任期之间阶段但下一届竞选已经开始');
    if (deadline <= totalMinute) fail('任期之间阶段但投票时间已经过去');
    if (deadline - campaignStart !== ELECTION_RULES.campaignDays * CALENDAR.minutesPerDay) {
      fail('任期之间阶段的竞选开始时间与投票时间不是完整的竞选期');
    }
  }

  // 已结算届次必须存在且与历史一致
  const settledTerms = elections.settledTerms;
  if (!Array.isArray(settledTerms)) fail('选举已结算届次记录缺失');
  if (settledTerms.length > ELECTION_RULES.maxHistory) fail('选举已结算届次记录过多');
  let previousTerm = 0;
  for (const item of settledTerms) {
    const value = assertNonNegativeInt(item, '已结算届次');
    if (value <= previousTerm) fail('已结算届次必须严格递增');
    previousTerm = value;
  }

  const history = elections.history;
  if (!Array.isArray(history)) fail('选举结果历史非法');
  if (history.length > ELECTION_RULES.maxHistory) fail('选举结果历史过多');
  if (history.length !== settledTerms.length) {
    fail('选举结果历史与已结算届次数量不一致');
  }
  for (const [index, item] of history.entries()) {
    const result = assertObject(item, `第 ${index + 1} 条选举结果`);
    const resultTerm = assertNonNegativeInt(result.termSeq, `第 ${index + 1} 条选举结果届次`);
    if (resultTerm !== settledTerms[index]) {
      fail(`第 ${index + 1} 条选举结果的届次与已结算届次不一致`);
    }
    if (index > 0) {
      const before = assertObject(history[index - 1], `第 ${index} 条选举结果`);
      const beforeTerm = assertNonNegativeInt(before.termSeq, `第 ${index} 条选举结果届次`);
      if (resultTerm <= beforeTerm) fail('选举结果历史届次必须严格递增');
    }
    const atMinute = assertNonNegativeInt(result.atMinute, `第 ${index + 1} 条选举结果时间`);
    if (atMinute > totalMinute) fail(`第 ${index + 1} 条选举结果时间晚于当前时间`);
    assertString(result.monthKey, `第 ${index + 1} 条选举结果月份`);
    const totalPopulation = assertNumber(
      result.totalPopulation,
      `第 ${index + 1} 条选举结果投票时人口`,
    );
    if (totalPopulation <= 0) fail(`第 ${index + 1} 条选举结果投票时人口必须大于 0`);
    const eligible = assertNonNegativeInt(
      result.eligiblePeople,
      `第 ${index + 1} 条选举结果合格人数`,
    );
    if (eligible > Math.ceil(totalPopulation) + 1) {
      fail(`第 ${index + 1} 条选举结果的合格人数超过总人口`);
    }
    const participants = assertNonNegativeInt(
      result.participatingPeople,
      `第 ${index + 1} 条选举结果参与人数`,
    );
    if (participants > eligible) fail(`第 ${index + 1} 条选举结果参与人数超过合格人数`);
    const votes = result.votes;
    if (!Array.isArray(votes) || votes.length !== CANDIDATES.length) {
      fail(`第 ${index + 1} 条选举结果票数结构非法`);
    }
    const seen = new Set<string>();
    let sum = 0;
    let topVotes = -1;
    for (const voteItem of votes) {
      const vote = assertObject(voteItem, '选举票数');
      const candidateId = assertCandidateIdValue(vote.candidateId, '选举票数候选人');
      if (seen.has(candidateId)) fail(`第 ${index + 1} 条选举结果候选人票数重复`);
      seen.add(candidateId);
      const value = assertNonNegativeInt(vote.votes, '选举票数');
      sum += value;
      topVotes = Math.max(topVotes, value);
    }
    if (sum !== participants) fail(`第 ${index + 1} 条选举结果票数与参与人数不守恒`);

    const winner = result.winnerId;
    if (winner === null || winner === undefined) {
      if (participants !== 0) fail(`第 ${index + 1} 条选举结果有参与人数却没有当选人`);
      if (result.tie === true) fail(`第 ${index + 1} 条选举结果零票却标记平票`);
    } else {
      const winnerId = assertCandidateIdValue(winner, `第 ${index + 1} 条选举结果当选人`);
      const winnerVotes = votes.find(
        (voteItem) => (voteItem as Record<string, unknown>).candidateId === winnerId,
      ) as Record<string, unknown> | undefined;
      if (!winnerVotes) fail(`第 ${index + 1} 条选举结果的当选人不在票数列表中`);
      if (winnerVotes.votes !== topVotes) fail(`第 ${index + 1} 条选举结果的当选人不是最高票`);
      if (participants === 0) fail(`第 ${index + 1} 条选举结果没有参与人数却有当选人`);
    }
    if (typeof result.tie !== 'boolean') fail(`第 ${index + 1} 条选举结果缺少平票标记`);
    assertString(result.tieBreakNote, `第 ${index + 1} 条选举结果抽签说明`);
    if (typeof result.lowTurnout !== 'boolean') fail(`第 ${index + 1} 条选举结果缺少低投票率标记`);
  }

  // 届次与阶段关系
  if (settledTerms.length === 0) {
    if (phase !== 'campaign') fail('没有已结算届次却处于任期之间阶段');
    if (termSeq !== 1) fail('首届选举的届次必须为 1');
  } else {
    const lastSettled = settledTerms[settledTerms.length - 1]!;
    const expected = phase === 'between' ? lastSettled : lastSettled + 1;
    if (termSeq !== expected) fail('当前届次与已结算届次不一致');
    if (phase === 'between') {
      const lastResult = assertObject(history[history.length - 1], '最近一次选举结果');
      const lastAt = assertNonNegativeInt(lastResult.atMinute, '最近一次选举结果时间');
      if (lastUsageAnchor !== lastAt) fail('任期之间阶段的资源锚点与最近一次投票时间不一致');
    }
  }

  const candidates = assertObject(elections.candidates, '竞选候选人状态');
  for (const candidateId of CANDIDATE_IDS) {
    if (candidates[candidateId] === undefined) fail(`缺少候选人竞选状态：${candidateId}`);
  }
  for (const [candidateId, item] of Object.entries(candidates)) {
    if (!CANDIDATE_IDS.has(candidateId)) fail(`候选人竞选状态标识非法：${candidateId}`);
    const row = assertObject(item, `候选人 ${candidateId} 竞选状态`);
    if (assertString(row.id, `候选人 ${candidateId} 竞选状态标识`) !== candidateId) {
      fail(`候选人 ${candidateId} 竞选状态的 id 与键不一致`);
    }
    const base = assertNonNegativeInt(row.base, `候选人 ${candidateId} 基础资源`);
    if (base !== CAMPAIGN_RULES.baseResources) {
      fail(`候选人 ${candidateId} 的基础资源不等于每届配置值`);
    }
    const sponsored = assertNonNegativeInt(row.sponsored, `候选人 ${candidateId} 赞助资源`);
    const used = assertNonNegativeInt(row.used, `候选人 ${candidateId} 已使用资源`);
    if (used > base + sponsored) {
      fail(`候选人 ${candidateId} 的已使用资源超过基础与赞助之和`);
    }
    const numerator = assertNonNegativeInt(row.useNumerator, `候选人 ${candidateId} 资源使用余量`);
    if (numerator >= CALENDAR.minutesPerDay) {
      fail(`候选人 ${candidateId} 的资源使用余量越界`);
    }
  }

  const records = elections.sponsorshipRecords;
  if (!Array.isArray(records)) fail('竞选赞助单据非法');
  if (records.length > ELECTION_RULES.maxSponsorshipRecords) fail('竞选赞助单据过多');
  const requestIds = new Set<string>();
  for (const [index, item] of records.entries()) {
    const record = assertObject(item, `第 ${index + 1} 条竞选赞助单据`);
    const requestId = assertString(record.requestId, `第 ${index + 1} 条竞选赞助单据标识`);
    if (requestIds.has(requestId)) fail(`竞选赞助单据标识重复：${requestId}`);
    requestIds.add(requestId);
    assertCandidateIdValue(record.candidateId, `第 ${index + 1} 条竞选赞助单据候选人`);
    const amount = assertNonNegativeInt(record.amountCents, `第 ${index + 1} 条竞选赞助金额`);
    if (amount <= 0) fail('竞选赞助金额必须大于 0');
    const atMinute = assertNonNegativeInt(record.atMinute, `第 ${index + 1} 条竞选赞助时间`);
    if (atMinute > totalMinute) fail(`第 ${index + 1} 条竞选赞助时间晚于当前时间`);
    assertString(record.monthKey, `第 ${index + 1} 条竞选赞助月份`);
  }
}

/** 政府机构、任职记录与当前负责人校验。 */
function validateGovernment(state: Record<string, unknown>, totalMinute: number): void {
  const government = assertObject(state.government, 'state.government');
  assertString(government.institution, '政府机构名称');
  const holder = government.currentHolder;
  if (holder === null || holder === undefined) fail('政府缺少当前负责人');
  const current = assertObject(holder, '政府当前负责人');
  const holderPersonId = assertString(current.personId, '政府当前负责人标识');
  assertString(current.name, '政府当前负责人名称');
  const since = assertNonNegativeInt(current.sinceMinute, '政府当前负责人上任时间');
  if (since > totalMinute) fail('政府当前负责人上任时间晚于当前时间');
  const holderCandidate =
    current.candidateId === null || current.candidateId === undefined
      ? null
      : assertCandidateIdValue(current.candidateId, '政府当前负责人候选人');
  const holderPolicy =
    current.policy === null || current.policy === undefined
      ? null
      : assertPolicyIdValue(current.policy, '政府当前政策');
  if (holderCandidate === null) {
    if (holderPersonId !== CARETAKER_PERSON_ID) {
      fail('没有候选人身份的当前负责人必须是过渡负责人');
    }
    if (holderPolicy !== null) fail('过渡负责人不能带有产业政策');
  } else {
    if (holderPersonId !== holderCandidate) fail('当前负责人标识与候选人身份不一致');
    if (holderPolicy !== candidateConfig(holderCandidate).policy) {
      fail('当前政策与当前负责人的候选人政策不一致');
    }
  }

  const terms = government.terms;
  if (!Array.isArray(terms)) fail('政府任职记录非法');
  if (terms.length === 0) fail('政府缺少任职记录');
  if (terms.length > 24) fail('政府任职记录过多');
  let previousStart = -1;
  let previousTermNumber = 0;
  for (const [index, item] of terms.entries()) {
    const term = assertObject(item, `第 ${index + 1} 条任职记录`);
    const id = assertString(term.id, `第 ${index + 1} 条任职记录标识`);
    const match = /^term-(\d+)$/.exec(id);
    if (!match) fail(`第 ${index + 1} 条任职记录标识格式非法`);
    const termNumber = Number(match[1]);
    if (!Number.isSafeInteger(termNumber) || termNumber <= previousTermNumber) {
      fail(`第 ${index + 1} 条任职记录序号必须递增`);
    }
    previousTermNumber = termNumber;
    const personId = assertString(term.personId, `第 ${index + 1} 条任职记录人物`);
    assertString(term.name, `第 ${index + 1} 条任职记录姓名`);
    const start = assertNonNegativeInt(term.startMinute, `第 ${index + 1} 条任职记录开始时间`);
    if (start < previousStart) fail(`第 ${index + 1} 条任职记录开始时间早于上一条`);
    if (start > totalMinute) fail(`第 ${index + 1} 条任职记录开始时间晚于当前时间`);
    previousStart = start;
    const termPolicy =
      term.policy === null || term.policy === undefined
        ? null
        : assertPolicyIdValue(term.policy, `第 ${index + 1} 条任职记录政策`);
    if (personId === CARETAKER_PERSON_ID) {
      if (termPolicy !== null) fail(`第 ${index + 1} 条过渡任职记录不能带有产业政策`);
    } else {
      const candidateId = assertCandidateIdValue(personId, `第 ${index + 1} 条任职记录人物`);
      if (termPolicy !== candidateConfig(candidateId).policy) {
        fail(`第 ${index + 1} 条任职记录的政策与人物不一致`);
      }
    }
    const end = term.endMinute;
    const isLast = index === terms.length - 1;
    if (isLast) {
      if (end !== null && end !== undefined) fail('最新任职记录不应有结束时间');
    } else {
      if (end === null || end === undefined) fail('历史任职记录缺少结束时间');
      const endMinute = assertNonNegativeInt(end, `第 ${index + 1} 条任职记录结束时间`);
      if (endMinute < start) fail(`第 ${index + 1} 条任职记录结束时间早于开始时间`);
      if (endMinute > totalMinute) fail(`第 ${index + 1} 条任职记录结束时间晚于当前时间`);
    }
  }

  const latest = assertObject(terms[terms.length - 1], '最新任职记录');
  if (
    latest.personId !== current.personId ||
    latest.name !== current.name ||
    latest.policy !== current.policy ||
    latest.startMinute !== current.sinceMinute
  ) {
    fail('当前负责人与最新任职记录不一致');
  }

  // v16：每届任期保存「方向 + 政策效果快照 + 配置版本 + 来源」，
  // 效果只从快照读取（旧任期被整体替换，不累乘企业基础数据）。
  const checkEffects = (value: unknown, label: string): Record<string, number> => {
    const effects = assertObject(value, label);
    const result: Record<string, number> = {};
    for (const key of [
      'researchGrowthMultiplier',
      'operatingCostMultiplier',
      'salesCostMultiplier',
    ] as const) {
      const multiplier = assertNumber(effects[key], `${label} ${key}`);
      if (!(multiplier > 0)) fail(`${label} ${key} 必须大于 0`);
      result[key] = multiplier;
    }
    return result;
  };
  const expectEffectsOf = (policy: PolicyId | null): Record<string, number> =>
    policy ? { ...POLICY_EFFECTS[policy] } : {
      researchGrowthMultiplier: 1,
      operatingCostMultiplier: 1,
      salesCostMultiplier: 1,
    };

  for (const [index, item] of terms.entries()) {
    const term = assertObject(item, `第 ${index + 1} 条任职记录`);
    const label = `第 ${index + 1} 条任职记录`;
    const termPolicy =
      term.policy === null || term.policy === undefined
        ? null
        : assertPolicyIdValue(term.policy, `${label}政策`);
    const direction =
      term.direction === null || term.direction === undefined
        ? null
        : assertCandidateIdValue(term.direction, `${label}方向`);
    if (direction === null) {
      if (termPolicy !== null) fail(`${label} 没有方向却带有产业政策`);
    } else if (candidateConfig(direction).policy !== termPolicy) {
      fail(`${label} 的方向与政策不一致`);
    }
    const effects = checkEffects(term.effects, `${label}政策效果快照`);
    const configVersion = assertNonNegativeInt(term.configVersion, `${label}配置版本`);
    const source = assertString(term.source, `${label}来源`);
    if (source !== 'election' && source !== 'caretaker' && source !== 'migration') {
      fail(`${label} 来源非法`);
    }
    // 当前配置版本下生成的效果必须与配置完全一致；更早版本只要求是正数快照
    if (configVersion === GOVERNMENT_CONFIG_VERSION) {
      const expected = expectEffectsOf(termPolicy);
      for (const [key, value] of Object.entries(expected)) {
        const actual = effects[key]!;
        if (Math.abs(actual - value) > 1e-9) fail(`${label} 的政策效果与配置不一致`);
      }
    }
    // 来源只是历史标记：接入前任期在之后的选举里正常结束（endMinute 非空）是合法状态
  }

  const holderEffects = checkEffects(current.effects, '政府当前负责人政策效果');
  const holderDirection =
    current.direction === null || current.direction === undefined
      ? null
      : assertCandidateIdValue(current.direction, '政府当前负责人方向');
  const holderTermId = assertString(current.termId, '政府当前任期标识');
  if (holderTermId !== latest.id) fail('当前负责人任期标识与最新任职记录不一致');
  if (holderDirection !== holderCandidate) fail('当前负责人方向与候选人身份不一致');
  const latestEffects = checkEffects(latest.effects, '最新任职记录政策效果快照');
  for (const key of Object.keys(holderEffects)) {
    if (Math.abs((holderEffects[key] ?? 0) - (latestEffects[key] ?? 0)) > 1e-9) {
      fail('当前负责人政策效果与最新任职记录不一致');
    }
  }

  const offices = government.offices;
  if (!Array.isArray(offices) || offices.length === 0) fail('政府职位数据缺失');
  for (const [index, item] of offices.entries()) {
    const office = assertObject(item, `第 ${index + 1} 个政府职位`);
    assertString(office.id, `第 ${index + 1} 个政府职位标识`);
    assertString(office.title, `第 ${index + 1} 个政府职位名称`);
    if (office.holderPersonId !== null && office.holderPersonId !== undefined) {
      assertString(office.holderPersonId, `第 ${index + 1} 个政府职位在任人`);
    }
  }

  const nextTermSeq = assertNonNegativeInt(government.nextTermSeq, '下一个任职记录序号');
  if (nextTermSeq !== previousTermNumber + 1) {
    fail('下一个任职记录序号与已有记录不连续');
  }
}

function validateEnterprises(state: Record<string, unknown>, totalMinute: number): Set<string> {
  const enterprises = assertObject(state.enterprises, 'state.enterprises');
  const companies = assertObject(enterprises.companies, 'state.enterprises.companies');
  const ids = new Set<string>();
  for (const [companyId, rawCompany] of Object.entries(companies)) {
    const company = assertObject(rawCompany, `企业 ${companyId}`);
    if (assertString(company.id, `企业 ${companyId} 标识`) !== companyId) {
      fail(`企业 ${companyId} 的 id 与键不一致`);
    }
    const role = assertString(company.role, `企业 ${companyId} 归属`);
    if (role !== 'player' && role !== 'ai') fail(`企业 ${companyId} 归属非法`);
    assertString(company.name, `企业 ${companyId} 名称`);
    const status = assertString(company.status, `企业 ${companyId} 状态`);
    if (!['active', 'paused', 'crisis', 'closed'].includes(status)) {
      fail(`企业 ${companyId} 状态非法`);
    }
    assertNonNegativeInt(company.createdAtMinute, `企业 ${companyId} 成立时间`);
    assertOptionalNonNegativeInt(company.closedAtMinute, `企业 ${companyId} 清算时间`);
    assertOptionalNonNegativeInt(company.crisisSinceMinute, `企业 ${companyId} 危机起点`);
    assertNonNegativeInt(company.payrollDue, `企业 ${companyId} 应付工资`);
    assertNonNegativeInt(company.cogsDue, `企业 ${companyId} 应付销售成本`);
    assertNonNegativeInt(company.marketingDue, `企业 ${companyId} 应付营销费`);
    assertNonNegativeInt(company.opexDue, `企业 ${companyId} 应付运营费`);
    assertNonNegativeInt(company.supplyDue, `企业 ${companyId} 历史经营应付`);
    const expenseMinute = assertNonNegativeInt(company.expenseMinute, `企业 ${companyId} 费用检查点`);
    if (expenseMinute > totalMinute) fail(`企业 ${companyId} 的费用检查点晚于当前时间`);
    for (const key of ['marketingRemainder', 'opexRemainder'] as const) {
      const remainder = assertNonNegativeInt(company[key], `企业 ${companyId} 费用计算余量`);
      if (remainder >= CALENDAR.minutesPerDay) fail(`企业 ${companyId} 的费用计算余量越界`);
    }
    const settled = assertNonNegativeInt(company.lastSettledMinute, `企业 ${companyId} 结算时刻`);
    if (settled > totalMinute) fail(`企业 ${companyId} 的销售结算时刻晚于当前时间`);
    const ops = assertNonNegativeInt(company.salesOps, `企业 ${companyId} 操作序号`);
    if (ops < 1) fail(`企业 ${companyId} 操作序号必须从 1 开始`);
    assertNonNegativeInt(company.dividendTotal, `企业 ${companyId} 累计分红`);
    if (company.liquidationNote !== null && company.liquidationNote !== undefined) {
      assertString(company.liquidationNote, `企业 ${companyId} 清算说明`);
    }
    if (status === 'closed' && (company.closedAtMinute === null || company.closedAtMinute === undefined)) {
      fail(`企业 ${companyId} 已清算但缺少清算时间`);
    }

    const accrual = assertObject(company.accrual, `企业 ${companyId} 当月累计`);
    assertString(accrual.monthKey, `企业 ${companyId} 累计月份`);
    for (const key of ['revenue', 'cogs', 'wages', 'research', 'marketing', 'opex', 'units'] as const) {
      assertNonNegativeInt(accrual[key], `企业 ${companyId} 累计${key}`);
    }
    if (!Array.isArray(company.reports)) fail(`企业 ${companyId} 报表非法`);
    if (company.reports.length > ENTERPRISE_RULES.maxReports) {
      fail(`企业 ${companyId} 报表数量超出上限`);
    }
    ids.add(companyId);
  }
  return ids;
}

function validateBusinessAccounts(
  finance: Record<string, unknown>,
  enterpriseIds: Set<string>,
): void {
  const accounts = assertObject(finance.businessAccounts, 'state.finance.businessAccounts');
  for (const [companyId, value] of Object.entries(accounts)) {
    assertNonNegativeInt(value, `企业 ${companyId} 账户余额`);
    // 主体账户一致：每个企业账户必须有对应的企业实体
    if (!enterpriseIds.has(companyId)) {
      fail(`企业账户 ${companyId} 没有对应的企业`);
    }
  }
  // 反过来：每家企业都必须有账户（清算后余额为 0 也必须存在）
  for (const companyId of enterpriseIds) {
    if (accounts[companyId] === undefined) fail(`企业 ${companyId} 缺少企业账户`);
  }
}

function validateTechnology(
  state: Record<string, unknown>,
  enterpriseIds: Set<string>,
  nowMinute: number,
): void {
  const technology = assertObject(state.technology, 'state.technology');
  const companies = assertObject(technology.companies, 'state.technology.companies');
  for (const [companyId, rawCompany] of Object.entries(companies)) {
    if (!enterpriseIds.has(companyId)) fail(`科技数据 ${companyId} 没有对应的企业`);
    const company = assertObject(rawCompany, `企业 ${companyId} 科技`);
    assertNonNegativeInt(company.accumulation, `企业 ${companyId} 永久科技`);
    assertOptionalNonNegativeInt(company.publishedYear, `企业 ${companyId} 发布年份`);
    const seq = assertNonNegativeInt(company.nextProductSeq, `企业 ${companyId} 产品序号`);
    if (seq < 1) fail(`企业 ${companyId} 产品序号必须从 1 开始`);

    if (company.project !== null && company.project !== undefined) {
      const project = assertObject(company.project, `企业 ${companyId} 研发项目`);
      const days = assertNonNegativeInt(project.plannedDays, `企业 ${companyId} 研发天数`);
      if (days < 1 || days > TECH.maxPlannedDays) fail(`企业 ${companyId} 研发天数越界`);
      assertNonNegativeInt(project.budgetCents, `企业 ${companyId} 研发预算`);
      assertNonNegativeInt(project.effectiveBase, `企业 ${companyId} 立项科技`);
      // 研发增长倍率快照：必须为正数（政策倍率 1 ～ 1.05）
      const growthMultiplier = assertNumber(
        project.researchGrowthMultiplier,
        `企业 ${companyId} 研发增长倍率`,
      );
      if (growthMultiplier <= 0 || growthMultiplier > 1.2) {
        fail(`企业 ${companyId} 的研发增长倍率越界`);
      }
      const start = assertNonNegativeInt(project.startMinute, `企业 ${companyId} 立项时刻`);
      const end = assertNonNegativeInt(project.endMinute, `企业 ${companyId} 计划完成时刻`);
      // 研发时长与计划天数必须自洽，避免读入一个永远完不成的项目
      if (end !== start + days * CALENDAR.minutesPerDay) {
        fail(`企业 ${companyId} 研发起止时间与计划天数不符`);
      }
    }

    if (!Array.isArray(company.products)) fail(`企业 ${companyId} 产品列表非法`);
    for (const [index, item] of company.products.entries()) {
      const product = assertObject(item, `企业 ${companyId} 第 ${index + 1} 款产品`);
      assertString(product.id, `企业 ${companyId} 第 ${index + 1} 款产品标识`);
      assertString(product.name, `企业 ${companyId} 第 ${index + 1} 款产品名称`);
      const attributes = assertObject(product.attributes, `产品属性`);
      for (const key of ['performance', 'reliability', 'usability'] as const) {
        const value = assertNumber(attributes[key], `产品${key}`);
        if (value < 0 || value > TECH.attributeScale) fail('产品属性必须在 0～100 之间');
      }
      assertNonNegativeInt(product.unitCostCents, `企业 ${companyId} 单位成本`);
      const generation = assertNonNegativeInt(product.generation, `企业 ${companyId} 产品代次`);
      const released = product.releasedAtMinute;
      const price = assertNonNegativeInt(product.priceCents, `企业 ${companyId} 产品售价`);
      const marketing = assertNonNegativeInt(product.marketingDailyCents, `企业 ${companyId} 产品营销预算`);
      if (marketing > PRODUCT_MARKET.maxMarketingDailyCents) {
        fail(`企业 ${companyId} 产品营销预算超出上限`);
      }
      if (typeof product.onSale !== 'boolean') fail('产品销售状态非法');
      const remainder = assertNumber(product.salesRemainder, '销量余量');
      if (remainder < 0 || remainder >= 1) fail('销量余量必须在 [0, 1) 之间');
      assertNonNegativeInt(product.totalUnits, '累计销量');
      assertNonNegativeInt(product.totalRevenueCents, '累计收入');
      assertNonNegativeInt(product.totalCostCents, '累计成本');

      // 首次发布对股价的一次性反应：null = 未结算；数值必须在 ±上限内
      const impact = product.releaseImpactPct;
      if (impact !== null && impact !== undefined) {
        const value = assertNumber(impact, '首发股价影响');
        if (Math.abs(value) > PRODUCT_STOCK_RULES.maxImpactPct + 1e-9) {
          fail(`企业 ${companyId} 首发股价影响超出上限`);
        }
      }
      // 日销量窗口：只保留最近若干条，且同一天不得重复
      if (!Array.isArray(product.dailySales)) fail(`企业 ${companyId} 产品日销量记录非法`);
      if (product.dailySales.length > PRODUCT_STOCK_RULES.maxDailyRecords) {
        fail(`企业 ${companyId} 产品日销量记录超出上限`);
      }
      let lastDay = -1;
      for (const [dayIndex, record] of product.dailySales.entries()) {
        const entry = assertObject(record, `企业 ${companyId} 第 ${dayIndex + 1} 条日销量`);
        const day = assertNonNegativeInt(entry.day, `企业 ${companyId} 日销量日序号`);
        if (day <= lastDay) fail(`企业 ${companyId} 的日销量记录顺序或日序号非法`);
        lastDay = day;
        assertNonNegativeInt(entry.units, `企业 ${companyId} 第 ${dayIndex + 1} 天销量`);
      }
      const daySnapshot = assertNonNegativeInt(product.daySnapshotUnits, '日销量快照');
      if (daySnapshot > (product.totalUnits as number)) {
        fail(`企业 ${companyId} 的日销量快照不能超过累计销量`);
      }
      // 日销量观察起点：合法游戏分钟，且不得晚于存档当前时间（不能来自未来）
      const observationStart = assertNonNegativeInt(
        product.dailyObservationStartMinute,
        '日销量观察起点',
      );
      if (observationStart > nowMinute) {
        fail(`企业 ${companyId} 的日销量观察起点晚于当前游戏时间`);
      }
      // 销售成本余量：非负，且不应超过一件产品的成本量级
      const costRemainder = assertNumber(product.salesCostRemainder, '销售成本余量');
      if (costRemainder < 0 || costRemainder >= 1) fail('销售成本余量必须在 [0, 1) 之间');

      if (released === null || released === undefined) {
        // 未发布：不得有代次、不得在售
        if (generation !== 0) fail(`未发布产品不得有发布代次`);
        if (product.onSale !== false) fail(`未发布产品不得在售`);
      } else {
        assertNonNegativeInt(released, `企业 ${companyId} 产品发布时间`);
        if (generation < 1) fail(`已发布产品的代次必须从 1 开始`);
        if (price < 1) fail(`已发布产品必须有正售价`);
      }
    }
  }
  // 反向：每家企业都应有科技切片（玩家未创建公司时不存在，AI 必须存在）
  for (const companyId of enterpriseIds) {
    if (companies[companyId] === undefined) fail(`企业 ${companyId} 缺少科技数据`);
  }
}

function validateTalent(state: Record<string, unknown>, enterpriseIds: Set<string>): void {
  const talent = assertObject(state.talent, 'state.talent');
  const assignments = assertObject(talent.assignments, 'state.talent.assignments');
  const seen = new Set<string>();
  for (const [companyId, rawAssignment] of Object.entries(assignments)) {
    if (!enterpriseIds.has(companyId)) fail(`任职数据 ${companyId} 没有对应的企业`);
    if (rawAssignment === null || rawAssignment === undefined) continue;
    const assignment = assertObject(rawAssignment, `企业 ${companyId} 任职`);
    const candidateId = assertString(assignment.candidateId, `企业 ${companyId} 高管标识`);
    if (!TALENT_CANDIDATES.some((candidate) => candidate.id === candidateId)) {
      fail(`企业 ${companyId} 的高管不在候选名单中`);
    }
    // 一个候选人只能被一家企业雇佣
    if (seen.has(candidateId)) fail(`候选人 ${candidateId} 被多家企业同时雇佣`);
    seen.add(candidateId);
    assertNonNegativeInt(assignment.hiredAtMinute, `企业 ${companyId} 入职时刻`);
    // 工资余量必须是一个计薪周期以内，否则说明累计逻辑被破坏
    const numerator = assertNonNegativeInt(
      assignment.wageNumerator,
      `企业 ${companyId} 工资计算余量`,
    );
    if (numerator >= MINUTES_PER_MONTH) fail(`企业 ${companyId} 的工资计算余量越界`);
    assertNonNegativeInt(assignment.paidTotalCents, `企业 ${companyId} 已发工资`);
  }
}

function validateBusinessAi(state: Record<string, unknown>, enterpriseIds: Set<string>): void {
  const businessAi = assertObject(state.businessAi, 'state.businessAi');
  const companies = assertObject(businessAi.companies, 'state.businessAi.companies');
  for (const [companyId, raw] of Object.entries(companies)) {
    if (!enterpriseIds.has(companyId)) fail(`AI 决策数据 ${companyId} 没有对应的企业`);
    const memory = assertObject(raw, `AI ${companyId} 决策记忆`);
    assertOptionalNonNegativeInt(memory.lastDecisionMinute, `AI ${companyId} 上次决策时刻`);
    const seq = assertNonNegativeInt(memory.productSeq, `AI ${companyId} 产品序号`);
    if (seq < 1) fail(`AI ${companyId} 产品序号必须从 1 开始`);
  }
}

function validateSubjectAccounts(finance: Record<string, unknown>): void {
  const subjectAccounts = assertObject(finance.subjectAccounts, 'state.finance.subjectAccounts');
  for (const [key, value] of Object.entries(subjectAccounts)) {
    assertNonNegativeInt(value, `主体账户 ${key}`);
  }
  const reservations = assertObject(finance.reservations, 'state.finance.reservations');
  const totals = new Map<string, number>();
  for (const [key, value] of Object.entries(reservations)) {
    const reserved = assertNonNegativeInt(value, `预留 ${key}`);
    // 预留键 = `主体::单据`；主体必须是真实存在的外部资金账户
    const split = key.indexOf('::');
    if (split < 0) fail(`预留 ${key} 缺少业务单据标识`);
    if (key.slice(split + 2) === 'legacy') {
      fail(`预留 ${key} 是无法归属的 legacy 承诺，规范化阶段应已释放`);
    }
    const subject = key.slice(0, split);
    if (subjectAccounts[subject] === undefined) fail(`预留 ${key} 没有对应的资金主体`);
    // 预留只属于投资者/做市商主体；居民群组账户没有资金承诺语义
    if (!subject.startsWith('investor:') && !subject.startsWith('market:')) {
      fail(`预留 ${key} 的主体不支持资金预留`);
    }
    totals.set(subject, (totals.get(subject) ?? 0) + reserved);
  }
  for (const [subject, total] of totals) {
    const balance = subjectAccounts[subject];
    if (balance !== undefined && total > (balance as number)) {
      fail(`预留 ${subject} 超过对应主体余额`);
    }
  }
}

function validateSecurities(
  state: Record<string, unknown>,
  equity: Record<string, unknown>,
  nowMinute: number,
): void {
  const securities = assertObject(state.securities, 'state.securities');
  const meta = assertObject(securities.meta, 'state.securities.meta');
  const markets = assertObject(securities.markets, 'state.securities.markets');
  const holdings = assertObject(securities.holdings, 'state.securities.holdings');
  const nextTradeSeq = assertNonNegativeInt(securities.nextTradeSeq, '成交序号');
  if (nextTradeSeq < 1) fail('成交序号必须从 1 开始');
  const companies = ((state.enterprises as Record<string, unknown> | undefined)?.companies ?? {}) as Record<
    string,
    Record<string, unknown>
  >;

  for (const [id, rawMeta] of Object.entries(meta)) {
    const info = assertObject(rawMeta, `证券 ${id} 元信息`);
    if (assertString(info.id, `证券 ${id} 标识`) !== id) fail(`证券 ${id} 的 id 与键不一致`);
    assertString(info.symbol, `证券 ${id} 代码`);
    assertString(info.name, `证券 ${id} 名称`);
    if (info.companyId !== null && info.companyId !== undefined) {
      assertString(info.companyId, `证券 ${id} 发行公司`);
    }
    assertOptionalNonNegativeInt(info.terminatedAtMinute, `证券 ${id} 终止时间`);
  }

  for (const [id, rawMarket] of Object.entries(markets)) {
    if (!meta[id]) fail(`行情 ${id} 缺少元信息`);
    const market = assertObject(rawMarket, `行情 ${id}`);
    const price = assertNonNegativeInt(market.price, `行情 ${id} 现价`);
    if (price < 1) fail(`行情 ${id} 现价不能低于 1 分`);
    const nextTick = assertNonNegativeInt(market.nextTickMinute, `行情 ${id} 下次更新时间`);
    if (nextTick <= 0) fail(`行情 ${id} 下次更新时间非法`);
    const rng = assertNonNegativeInt(market.rng, `行情 ${id} 随机状态`);
    if (rng > 0xffffffff) fail(`行情 ${id} 随机状态越界`);
    assertNonNegativeInt(market.ticks, `行情 ${id} 更新次数`);
    if (!Array.isArray(market.history) || market.history.length === 0) fail(`行情 ${id} 历史为空`);
    if (market.history.length > MARKET.historyLimit) fail(`行情 ${id} 历史超出上限`);
    let lastMinute = -1;
    let lastPrice = 0;
    for (const [index, point] of market.history.entries()) {
      const entry = assertObject(point, `行情 ${id} 第 ${index + 1} 个点`);
      const minute = assertNonNegativeInt(entry.minute, `行情 ${id} 第 ${index + 1} 个点时间`);
      const pointPrice = assertNonNegativeInt(entry.price, `行情 ${id} 第 ${index + 1} 个点价格`);
      if (pointPrice < 1) fail(`行情 ${id} 第 ${index + 1} 个点价格不能低于 1 分`);
      if (minute <= lastMinute) fail(`行情 ${id} 历史时间顺序非法`);
      lastMinute = minute;
      lastPrice = pointPrice;
    }
    if (lastPrice !== price) fail(`行情 ${id} 历史与现价不一致`);
    // 价格历史不得晚于当前游戏时间（即时价格事件一定发生在「现在」或更早）
    if (lastMinute > nowMinute) fail(`行情 ${id} 的价格历史晚于当前游戏时间`);

    // 行情调度与价格历史是两条不同的时间序列：
    //  - history 记录任何一次价格变化（定时节点 + 交易/回购/分红/增发/发布的即时调整）；
    //  - nextTickMinute 只记录下一次**定时**行情。
    // 因此不能用「最后一条历史时间 + 间隔」推调度，否则第 1 分钟成交一笔就会把
    // 下一次 24 分钟的定时行情误判成 25 分钟，正常存档被判损坏。
    const info = meta[id] as Record<string, unknown>;
    const terminated =
      info.terminatedAtMinute !== null && info.terminatedAtMinute !== undefined;
    const issuerId = info.companyId;
    const issuerClosed =
      typeof issuerId === 'string' && companies[issuerId]?.status === 'closed';
    if (!terminated && !issuerClosed) {
      // 仍在正常运行的证券：下一次定时更新必须落在当前时间之后、且不超过一个间隔
      if (nextTick <= nowMinute) {
        fail(`行情 ${id} 的下次定时更新已过期（应当晚于当前游戏时间）`);
      }
      if (nextTick - nowMinute > MARKET.tickMinutes) {
        fail(`行情 ${id} 的下次定时更新距离当前时间超过一个行情间隔`);
      }
    }
    // 已终止 / 已清算的证券不再推进行情：只要求 nextTickMinute 是合法时刻（上面已校验 > 0），
    // 不要求它继续追赶当前时间。
    // 愿售比例是比例而非货币：允许小数，但必须落在配置范围内
    const ratio = market.forSaleRatio;
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) fail(`行情 ${id} 愿售比例非法`);
    if (
      (ratio as number) < MARKET_MAKING_RULES.minForSaleRatio ||
      (ratio as number) > MARKET_MAKING_RULES.maxForSaleRatio
    ) {
      fail(`行情 ${id} 愿售比例超出范围`);
    }
    validateCandles(market);
  }

  const books = assertObject(equity.books, 'state.equity.books');
  for (const [id, rawHolding] of Object.entries(holdings)) {
    if (!markets[id]) fail(`持仓 ${id} 缺少行情`);
    const holding = assertObject(rawHolding, `持仓 ${id}`);
    const shares = assertNonNegativeInt(holding.shares, `持仓 ${id} 股数`);
    const cost = assertNonNegativeInt(holding.totalCost, `持仓 ${id} 成本`);
    const terminated =
      holding.terminatedAtMinute !== null && holding.terminatedAtMinute !== undefined;
    assertOptionalNonNegativeInt(holding.terminatedAtMinute, `持仓 ${id} 终止时间`);
    // 已终止的持仓保留历史成本，不再要求「有股必有余成本」的常规口径
    if (!terminated) {
      if (shares === 0 && cost !== 0) fail(`持仓 ${id} 无持仓时成本必须为 0`);
      if (shares > 0 && cost === 0) fail(`持仓 ${id} 有持仓时成本不能为 0`);
    }
    assertSignedInt(holding.realizedPnl, `持仓 ${id} 已实现盈亏`);
    assertNonNegativeInt(holding.trades, `持仓 ${id} 成交笔数`);
    const book = books[id] as Record<string, unknown> | undefined;
    const bookHoldings = book ? (book.holdings as Record<string, unknown>) : undefined;
    const bookShares = bookHoldings ? ((bookHoldings.player as number) ?? 0) : 0;
    if (bookShares !== shares) fail(`持仓 ${id} 与股权簿的玩家持股不一致`);
  }
  for (const id of Object.keys(meta)) {
    if (!markets[id]) fail(`证券 ${id} 缺少行情`);
    if (!holdings[id]) fail(`证券 ${id} 缺少持仓`);
    const info = meta[id] as Record<string, unknown>;
    const companyId = info.companyId;
    if (typeof companyId === 'string') {
      const company = companies[companyId];
      if (!company) fail(`证券 ${id} 的发行公司不存在`);
      // 已清算公司的证券必须明确终止，否则会继续按最后价计入个人资产
      const terminated = info.terminatedAtMinute;
      if (company.status === 'closed' && (terminated === null || terminated === undefined)) {
        fail(`证券 ${id} 的发行公司已清算，但没有标记证券终止`);
      }
    }
  }
}

function validateEquity(state: Record<string, unknown>, enterpriseIds: Set<string>): Record<string, unknown> {
  const equity = assertObject(state.equity, 'state.equity');
  const books = assertObject(equity.books, 'state.equity.books');
  const nextRoundSeq = assertNonNegativeInt(equity.nextRoundSeq, '融资轮次序号');
  if (nextRoundSeq < 1) fail('融资轮次序号必须从 1 开始');

  for (const [securityId, rawBook] of Object.entries(books)) {
    const book = assertObject(rawBook, `股权簿 ${securityId}`);
    if (assertString(book.securityId, `股权簿 ${securityId} 标识`) !== securityId) {
      fail(`股权簿 ${securityId} 的 securityId 与键不一致`);
    }
    const companyId = book.companyId;
    if (companyId !== null && companyId !== undefined) {
      const cid = assertString(companyId, `股权簿 ${securityId} 发行公司`);
      if (!enterpriseIds.has(cid)) fail(`股权簿 ${securityId} 的发行公司不存在`);
    }
    const total = assertNonNegativeInt(book.totalShares, `股权簿 ${securityId} 总股数`);
    if (total <= 0) fail(`股权簿 ${securityId} 总股数必须大于 0`);
    const treasury = assertNonNegativeInt(book.treasuryShares, `股权簿 ${securityId} 库存股`);
    if (treasury > total) fail(`股权簿 ${securityId} 库存股超过总股数`);
    assertNonNegativeInt(book.buybackTotalShares, `股权簿 ${securityId} 累计回购`);
    assertNonNegativeInt(book.dividendTotalCents, `股权簿 ${securityId} 累计分红`);
    assertNonNegativeInt(book.founderContributionCents, `股权簿 ${securityId} 创始出资`);
    assertOptionalNonNegativeInt(book.sponsorGrantShares, `股权簿 ${securityId} 无偿配股`);
    const holdings = assertObject(book.holdings, `股权簿 ${securityId} 持股`);
    let sum = 0;
    for (const [holderId, value] of Object.entries(holdings)) {
      sum += assertNonNegativeInt(value, `股权簿 ${securityId} 股东 ${holderId}`);
    }
    if (sum + treasury !== total) fail(`股权簿 ${securityId} 股份合计与总股数不一致`);

    // CEO 与持股解耦：只校验身份形式与引用关系，不要求持股（卖光股份不撤职）
    if (book.ceoId !== null && book.ceoId !== undefined) {
      const ceo = assertString(book.ceoId, `股权簿 ${securityId} CEO`);
      if (!isValidCeoIdentity(ceo)) {
        fail(`股权簿 ${securityId} 的 CEO 身份非法：${ceo}`);
      }
      if (ceo.startsWith('ai:') && !enterpriseIds.has(ceo.slice(3))) {
        fail(`股权簿 ${securityId} 的 CEO 指向不存在的企业`);
      }
      if (ceo.startsWith('inv:') && !findInvestor(ceo.slice(4))) {
        fail(`股权簿 ${securityId} 的 CEO 指向未知投资者`);
      }
    }

    // 股权簿自检复用业务模块的同一份口径，避免这里再写一套互相矛盾的规则
    const integrity = checkBookIntegrity(rawBook as unknown as ShareBook);
    if (integrity !== null) fail(`股权簿 ${securityId}：${integrity}`);
    if (typeof book.listed !== 'boolean') fail(`股权簿 ${securityId} 上市状态非法`);
    if (book.listedAtMinute !== null && book.listedAtMinute !== undefined) {
      assertNonNegativeInt(book.listedAtMinute, `股权簿 ${securityId} 上市时间`);
    }
    if (typeof book.hasExternalFinancing !== 'boolean') {
      fail(`股权簿 ${securityId} 融资标记非法`);
    }
    if (!Array.isArray(book.rounds)) fail(`股权簿 ${securityId} 融资轮次非法`);
    for (const [index, rawRound] of book.rounds.entries()) {
      const round = assertObject(rawRound, `股权簿 ${securityId} 第 ${index + 1} 轮`);
      assertString(round.roundId, `股权簿 ${securityId} 轮次标识`);
      assertNonNegativeInt(round.atMinute, `股权簿 ${securityId} 轮次时间`);
      assertString(round.investorId, `股权簿 ${securityId} 轮次投资者`);
      assertNonNegativeInt(round.amountCents, `股权簿 ${securityId} 轮次金额`);
      assertNonNegativeInt(round.shares, `股权簿 ${securityId} 轮次股数`);
      assertNonNegativeInt(round.pricePerShareCents, `股权簿 ${securityId} 轮次价格`);
      assertNonNegativeInt(round.sharesBefore, `股权簿 ${securityId} 轮次前股数`);
    }
    if (book.historyNote !== null && book.historyNote !== undefined) {
      assertString(book.historyNote, `股权簿 ${securityId} 历史说明`);
    }
  }
  return books;
}

function validateFinancing(state: Record<string, unknown>, enterpriseIds: Set<string>): void {
  const financing = assertObject(state.financing, 'state.financing');
  const applications = assertObject(financing.applications, 'state.financing.applications');
  const lastDecided = assertObject(financing.lastDecidedMinute, 'state.financing.lastDecidedMinute');
  const nextSeq = assertNonNegativeInt(financing.nextSeq, '融资申请序号');
  if (nextSeq < 1) fail('融资申请序号必须从 1 开始');
  const finance = assertObject(state.finance, 'state.finance');
  const reservations = assertObject(finance.reservations, 'state.finance.reservations');
  const quoteIds = new Set<string>();

  for (const [companyId, rawApp] of Object.entries(applications)) {
    if (!enterpriseIds.has(companyId)) fail(`融资申请 ${companyId} 没有对应的企业`);
    const app = assertObject(rawApp, `融资申请 ${companyId}`);
    assertString(app.id, `融资申请 ${companyId} 标识`);
    assertString(app.companyId, `融资申请 ${companyId} 企业`);
    assertNonNegativeInt(app.requestedCents, `融资申请 ${companyId} 金额`);
    assertNonNegativeInt(app.submittedMinute, `融资申请 ${companyId} 提交时间`);
    assertNonNegativeInt(app.respondAtMinute, `融资申请 ${companyId} 回应时间`);
    const status = assertString(app.status, `融资申请 ${companyId} 状态`);
    if (!['pending', 'quoted', 'accepted', 'rejected', 'expired'].includes(status)) {
      fail(`融资申请 ${companyId} 状态非法`);
    }
    assertOptionalNonNegativeInt(app.decidedAtMinute, `融资申请 ${companyId} 决定时间`);
    if (app.acceptedQuoteId !== null && app.acceptedQuoteId !== undefined) {
      assertString(app.acceptedQuoteId, `融资申请 ${companyId} 接受报价`);
    }
    if (!Array.isArray(app.quotes)) fail(`融资申请 ${companyId} 报价非法`);
    for (const [index, rawQuote] of app.quotes.entries()) {
      const quote = assertObject(rawQuote, `融资申请 ${companyId} 第 ${index + 1} 份报价`);
      const quoteId = assertString(quote.id, `报价标识`);
      // 报价 id 必须全局唯一：预留键以它为单据标识，撞车就无法分辨归属
      if (quoteIds.has(quoteId)) fail(`报价标识 ${quoteId} 重复`);
      quoteIds.add(quoteId);
      if (quoteId.includes('::')) fail(`报价标识 ${quoteId} 含有预留键分隔符`);
      // 未决报价必须仍持有自己的那份资金承诺（不能为空或不足）
      if (status === 'quoted') {
        const investorId = assertString(quote.investorId, '报价投资者');
        const key = `investor:${investorId}::${quoteId}`;
        const reserved = assertNonNegativeInt(reservations[key] ?? 0, `预留 ${key}`);
        if (reserved < assertNonNegativeInt(quote.amountCents, '报价金额')) {
          fail(`报价 ${quoteId} 的资金预留不足`);
        }
      }
      assertString(quote.investorId, `报价投资者`);
      assertNonNegativeInt(quote.amountCents, `报价金额`);
      assertNonNegativeInt(quote.shares, `报价股数`);
      assertNonNegativeInt(quote.pricePerShareCents, `报价价格`);
      assertNonNegativeInt(quote.preMoneyCents, `报价融资前估值`);
      assertNonNegativeInt(quote.postMoneyCents, `报价融资后估值`);
      assertNonNegativeInt(quote.expiresAtMinute, `报价过期时间`);
      // 股份基数快照：没有它就无法核对稀释比例，因此必须存在
      assertNonNegativeInt(quote.totalSharesAtQuote, `报价股份基数`);
      assertNonNegativeInt(quote.effectiveSharesAtQuote, `报价有效股份基数`);
      if (!Array.isArray(quote.postHoldings)) fail(`报价持股快照非法`);
    }
  }
  for (const [companyId, value] of Object.entries(lastDecided)) {
    if (!enterpriseIds.has(companyId)) fail(`融资冷却 ${companyId} 没有对应的企业`);
    assertOptionalNonNegativeInt(value, `融资冷却 ${companyId}`);
  }
}

function validateGovernance(state: Record<string, unknown>, enterpriseIds: Set<string>): void {
  const governance = assertObject(state.governance, 'state.governance');
  const proposals = assertObject(governance.proposals, 'state.governance.proposals');
  const nextSeq = assertNonNegativeInt(governance.nextSeq, '提案序号');
  if (nextSeq < 1) fail('提案序号必须从 1 开始');
  const lastExternal = assertObject(
    governance.lastExternalProposalMinute ?? {},
    'state.governance.lastExternalProposalMinute',
  );
  for (const [companyId, value] of Object.entries(lastExternal)) {
    if (!enterpriseIds.has(companyId)) fail(`外部提案冷却 ${companyId} 没有对应的企业`);
    assertOptionalNonNegativeInt(value, `外部提案冷却 ${companyId}`);
  }
  for (const [companyId, rawList] of Object.entries(proposals)) {
    if (!enterpriseIds.has(companyId)) fail(`提案 ${companyId} 没有对应的企业`);
    if (!Array.isArray(rawList)) fail(`提案 ${companyId} 列表非法`);
    let openCount = 0;
    for (const [index, rawProposal] of rawList.entries()) {
      const proposal = assertObject(rawProposal, `提案 ${companyId} 第 ${index + 1} 项`);
      assertString(proposal.id, `提案标识`);
      assertString(proposal.companyId, `提案企业`);
      const kind = assertString(proposal.kind, `提案类型`);
      if (kind !== 'appoint-ceo' && kind !== 'remove-ceo') fail('提案类型非法');
      assertString(proposal.targetHolderId, `提案目标`);
      assertString(proposal.proposedBy, `提案人`);
      const origin = assertString(proposal.origin, `提案来源`);
      if (origin !== 'player' && origin !== 'shareholder') fail('提案来源非法');
      assertNonNegativeInt(proposal.createdAtMinute, `提案创建时间`);
      assertOptionalNonNegativeInt(proposal.deadlineMinute, `提案截止时间`);
      if (proposal.playerVote !== null && proposal.playerVote !== undefined) {
        const vote = assertString(proposal.playerVote, `提案投票`);
        if (vote !== 'yes' && vote !== 'no' && vote !== 'abstain') fail('提案投票取值非法');
      }
      assertOptionalNonNegativeInt(proposal.resolvedAtMinute, `提案决议时间`);
      const status = assertString(proposal.status, `提案状态`);
      if (status !== 'open' && status !== 'passed' && status !== 'rejected') fail('提案状态非法');
      if (status === 'open') {
        openCount += 1;
        // 外部提案必须有表决窗口，否则玩家无法在截止前投票
        if (origin === 'shareholder' && (proposal.deadlineMinute === null || proposal.deadlineMinute === undefined)) {
          fail(`提案 ${proposal.id} 缺少表决截止时间`);
        }
      }
      assertNonNegativeInt(proposal.yesShares, `提案赞成股`);
      assertNonNegativeInt(proposal.noShares, `提案反对股`);
      assertNonNegativeInt(proposal.abstainShares, `提案弃权股`);
      assertString(proposal.note, `提案说明`);
    }
    if (openCount > 1) fail(`提案 ${companyId} 同时存在多个未决提案`);
  }
}

function validatePromotion(state: Record<string, unknown>, enterpriseIds: Set<string>): void {
  const promotion = assertObject(state.promotion, 'state.promotion');
  const byCompany = assertObject(promotion.byCompany, 'state.promotion.byCompany');
  const rng = assertNonNegativeInt(promotion.rng, '宣传随机状态');
  if (rng > 0xffffffff) fail('宣传随机状态越界');
  for (const [companyId, rawRecord] of Object.entries(byCompany)) {
    if (!enterpriseIds.has(companyId)) fail(`宣传记录 ${companyId} 没有对应的企业`);
    const record = assertObject(rawRecord, `宣传记录 ${companyId}`);
    if (typeof record.active !== 'boolean') fail(`宣传记录 ${companyId} 状态非法`);
    assertNonNegativeInt(record.startMinute, `宣传记录 ${companyId} 起始时间`);
    assertNonNegativeInt(record.expireMinute, `宣传记录 ${companyId} 过期时间`);
    // 强度是公式算出的小数（不是货币），只要求有限、非负、不超过配置上限；
    // 取整强度会篡改结算结果，因此这里不按整数校验。
    const strength = assertNumber(record.strength, `宣传记录 ${companyId} 强度`);
    if (strength < 0 || strength > PROMOTION_RULES.maxBoostPct) {
      fail(`宣传记录 ${companyId} 强度越界`);
    }
    assertOptionalNonNegativeInt(record.lastAttemptMinute, `宣传记录 ${companyId} 上次尝试`);
    assertNonNegativeInt(record.lastBudgetCents, `宣传记录 ${companyId} 上次预算`);
    const outcome = record.lastOutcome;
    if (outcome !== null && outcome !== undefined && outcome !== 'success' && outcome !== 'failure') {
      fail(`宣传记录 ${companyId} 结果非法`);
    }
    // 失败行动不产生溢价：强度必须为 0，避免「失败也带着强度」这种矛盾状态
    if (outcome === 'failure' && strength !== 0) {
      fail(`宣传记录 ${companyId} 失败却带有强度`);
    }
  }
}

/**
 * 校验并返回快照。校验不通过即抛错，绝不返回半成品。
 * 首版只有 v1，没有真实格式变化，因此不写空的迁移框架；版本不符直接拒绝。
 */

  /**
 * 读档校验入口：逐字段检查完整状态，并做跨切片一致性核对。
 *
 * 只读不修：缺字段、越界、账目不平都直接拒绝，绝不静默覆盖其中一份数据。
 * 通过后返回同一份状态对象（调用方据此构造快照）。
 */
/* -------------------------------------- 城市统计 / 逻辑地图 / 建设（v16） */

const BUILDING_KINDS = new Set(['home', 'bank', 'office', 'securities', 'government', 'shop']);
const DISTRICT_DIRECTIONS = new Set(['technology', 'commercial', 'housing']);

function assertAggregateCents(value: unknown, label: string): number {
  // 长期统计不能套用单笔交易上限（1e12），但必须是有限的安全整数且非负
  const amount = assertNonNegativeInt(value, label);
  if (amount > CITY_STATISTICS_LIMITS.maxAggregateCents) fail(`${label} 超出安全整数范围`);
  return amount;
}

/**
 * 城市统计校验：基础 GDP、累计经营产出与游标、连续指数窗口与月度快照。
 * 只读不修：不重算 G0、不重新链结指数。
 */
function validateCityStatistics(state: Record<string, unknown>, totalMinute: number): void {
  const statistics = assertObject(state.cityStatistics, 'state.cityStatistics');
  const base = assertObject(statistics.base, '基础 GDP');
  assertAggregateCents(base.gdpCents, '基础 GDP');
  const ruleVersion = assertNonNegativeInt(base.ruleVersion, '基础 GDP 规则版本');
  if (ruleVersion < 1) fail('基础 GDP 规则版本必须从 1 开始');
  const generatedAt = assertNonNegativeInt(base.generatedAtMinute, '基础 GDP 生成时刻');
  if (generatedAt > totalMinute) fail('基础 GDP 生成时刻晚于当前时间');
  if (base.source !== 'new-game' && base.source !== 'migration') fail('基础 GDP 来源非法');
  assertString(base.note, '基础 GDP 来源说明');
  const registeredAt = assertNonNegativeInt(statistics.registeredAtMinute, '统计接入时刻');
  if (registeredAt > totalMinute) fail('统计接入时刻晚于当前时间');

  const output = assertObject(statistics.output, '累计经营产出');
  const cumulative = assertAggregateCents(output.cumulativeCents, '累计经营产出');
  assertString(output.monthKey, '经营产出统计月份');
  const monthCents = assertAggregateCents(output.monthCents, '本月经营产出');
  if (monthCents > cumulative) fail('本月经营产出不能超过累计产出');
  // byCompany 是**当前统计窗口（本月）**的各企业产出拆分，与 monthCents 同尺度
  const byCompany = assertObject(output.byCompany, '分企业经营产出');
  let monthSum = 0;
  for (const [companyId, value] of Object.entries(byCompany)) {
    monthSum += assertAggregateCents(value, `企业 ${companyId} 本月经营产出`);
  }
  if (monthSum !== monthCents) fail('分企业本月经营产出之和与本月经营产出不一致');
  const cursors = assertObject(output.cursors, '经营产出结算游标');
  let cursorTotalSum = 0;
  for (const [companyId, item] of Object.entries(cursors)) {
    const cursor = assertObject(item, `企业 ${companyId} 产出游标`);
    if (assertNonNegativeInt(cursor.outputSeq, `企业 ${companyId} 产出操作高水位`) < 0) {
      fail(`企业 ${companyId} 产出操作高水位非法`);
    }
    const through = assertNonNegativeInt(
      cursor.settledThroughMinute,
      `企业 ${companyId} 产出结算游标时刻`,
    );
    if (through > totalMinute) fail(`企业 ${companyId} 产出结算游标晚于当前时间`);
    assertAggregateCents(cursor.baselinePendingCents, `企业 ${companyId} 待结算基线`);
    // totalCents 是该企业**全期**已登记产出（长期累计），与月度拆分不同口径
    cursorTotalSum += assertAggregateCents(cursor.totalCents, `企业 ${companyId} 累计产出`);
  }
  if (cursorTotalSum !== cumulative) fail('分企业累计产出之和与城市累计经营产出不一致');

  const index = assertObject(statistics.index, '全市场指数');
  const monthStart = assertNumber(index.monthStartValue, '指数窗口起始值');
  if (monthStart < 0) fail('指数窗口起始值不能为负');
  const lastClosed = assertNumber(index.lastClosedValue, '最近固化指数');
  if (lastClosed < 0) fail('最近固化指数不能为负');
  if (index.lastClosedMonthKey !== null && index.lastClosedMonthKey !== undefined) {
    assertString(index.lastClosedMonthKey, '最近固化指数月份');
  }
  const window = assertObject(index.window, '指数观察窗口');
  assertString(window.monthKey, '指数观察窗口月份');
  const fixedAt = assertNonNegativeInt(window.fixedAtMinute, '指数观察窗口固定时刻');
  if (fixedAt > totalMinute) fail('指数观察窗口固定时刻晚于当前时间');
  if (typeof window.fixedAtMonthStart !== 'boolean') fail('指数观察窗口缺少完整月标记');
  const samples = assertObject(window.samples, '指数观察样本');
  for (const [securityId, item] of Object.entries(samples)) {
    const sample = assertObject(item, `指数样本 ${securityId}`);
    if (assertString(sample.securityId, `指数样本 ${securityId} 标识`) !== securityId) {
      fail(`指数样本 ${securityId} 的 id 与键不一致`);
    }
    const baseline = assertNumber(sample.baselinePrice, `指数样本 ${securityId} 基准价`);
    if (!(baseline >= 1)) fail(`指数样本 ${securityId} 基准价非法`);
    const cash = assertNumber(sample.cashPerShare, `指数样本 ${securityId} 每股现金`);
    if (cash < 0) fail(`指数样本 ${securityId} 每股现金不能为负`);
    const factor = assertNumber(sample.referenceFactor, `指数样本 ${securityId} 参考因子`);
    if (!(factor > 0)) fail(`指数样本 ${securityId} 参考因子必须大于 0`);
    if (typeof sample.terminated !== 'boolean') fail(`指数样本 ${securityId} 缺少终止标记`);
    if (sample.terminated) {
      const recovery = assertNumber(
        sample.recoveryPerShare,
        `指数样本 ${securityId} 每股回收价值`,
      );
      if (recovery < 0) fail(`指数样本 ${securityId} 每股回收价值不能为负`);
    } else if (sample.recoveryPerShare !== null) {
      fail(`指数样本 ${securityId} 未终止却带有回收价值`);
    }
    const securities = assertObject(state.securities, 'state.securities');
    const markets = assertObject(securities.markets, 'state.securities.markets');
    if (markets[securityId] === undefined) fail(`指数样本 ${securityId} 对应的证券不存在`);
  }
  const history = index.history;
  if (!Array.isArray(history)) fail('指数历史非法');
  if (history.length > CITY_ECONOMY_RULES.indexHistoryLimit) fail('指数历史过多');
  let previousMonth = '';
  for (const [index_, item] of history.entries()) {
    const summary = assertObject(item, `第 ${index_ + 1} 条指数历史`);
    const monthKey = assertString(summary.monthKey, `第 ${index_ + 1} 条指数历史月份`);
    if (monthKey <= previousMonth) fail('指数历史月份必须严格递增');
    previousMonth = monthKey;
    const value = assertNumber(summary.value, `第 ${index_ + 1} 条指数历史值`);
    if (value < 0) fail(`第 ${index_ + 1} 条指数历史值不能为负`);
    const startValue = assertNumber(summary.startValue, `第 ${index_ + 1} 条指数历史起始值`);
    if (startValue < 0) fail(`第 ${index_ + 1} 条指数历史起始值不能为负`);
    assertNumber(summary.returnRate, `第 ${index_ + 1} 条指数历史回报`);
    assertNonNegativeInt(summary.sampleCount, `第 ${index_ + 1} 条指数历史样本数`);
    if (typeof summary.valid !== 'boolean') fail(`第 ${index_ + 1} 条指数历史缺少有效标记`);
    const linkedAt = assertNonNegativeInt(summary.linkedAtMinute, `第 ${index_ + 1} 条指数历史固化时刻`);
    if (linkedAt > totalMinute) fail(`第 ${index_ + 1} 条指数历史固化时刻晚于当前时间`);
  }
  const lastHistory = history[history.length - 1];
  if (lastHistory) {
    const summary = assertObject(lastHistory, '最近一条指数历史');
    if (index.lastClosedMonthKey !== summary.monthKey) {
      fail('最近固化指数月份与指数历史不一致');
    }
  }

  const months = statistics.months;
  if (!Array.isArray(months)) fail('城市统计月度快照非法');
  if (months.length > CITY_ECONOMY_RULES.monthSnapshotLimit) fail('城市统计月度快照过多');
  let previousSnapshotMonth = '';
  for (const [index_, item] of months.entries()) {
    const snapshot = assertObject(item, `第 ${index_ + 1} 条城市统计快照`);
    const monthKey = assertString(snapshot.monthKey, `第 ${index_ + 1} 条统计快照月份`);
    if (monthKey <= previousSnapshotMonth) fail('城市统计快照月份必须严格递增');
    previousSnapshotMonth = monthKey;
    const settledAt = assertNonNegativeInt(
      snapshot.settledAtMinute,
      `第 ${index_ + 1} 条统计快照结算时刻`,
    );
    if (settledAt > totalMinute) fail(`第 ${index_ + 1} 条统计快照结算时刻晚于当前时间`);
    assertAggregateCents(snapshot.baseGdpCents, `第 ${index_ + 1} 条统计快照基础 GDP`);
    assertAggregateCents(snapshot.outputCumulativeCents, `第 ${index_ + 1} 条统计快照累计产出`);
    assertAggregateCents(snapshot.outputMonthCents, `第 ${index_ + 1} 条统计快照本月产出`);
    const adjust = assertSignedInt(snapshot.stockAdjustCents, `第 ${index_ + 1} 条统计快照股市调整`);
    const gdp = assertAggregateCents(snapshot.gdpCents, `第 ${index_ + 1} 条统计快照 GDP`);
    if (
      gdp !==
      (snapshot.baseGdpCents as number) +
        (snapshot.outputCumulativeCents as number) +
        adjust
    ) {
      fail(`第 ${index_ + 1} 条统计快照的 GDP 三部分不守恒`);
    }
    const indexValue = assertNumber(snapshot.indexValue, `第 ${index_ + 1} 条统计快照指数`);
    if (indexValue < 0) fail(`第 ${index_ + 1} 条统计快照指数不能为负`);
    assertNonNegativeInt(snapshot.indexSampleCount, `第 ${index_ + 1} 条统计快照指数样本数`);
    if (typeof snapshot.indexValid !== 'boolean') fail(`第 ${index_ + 1} 条统计快照缺少指数有效标记`);
    if (!Array.isArray(snapshot.industries)) fail(`第 ${index_ + 1} 条统计快照产业结构非法`);
    for (const industryItem of snapshot.industries) {
      const industry = assertObject(industryItem, '统计快照产业');
      assertString(industry.id, '统计快照产业标识');
      assertString(industry.label, '统计快照产业名称');
      assertAggregateCents(industry.cents, '统计快照产业产出');
    }
  }
}

/**
 * 逻辑地图校验：边界、道路、地块、建筑稳定标识与动态业务引用。
 * 只读不修：不重新随机、不重排老城区。
 */
function validateCityLayout(
  state: Record<string, unknown>,
  enterpriseIds: Set<string>,
): Record<string, unknown> {
  const layout = assertObject(state.cityLayout, 'state.cityLayout');
  const layoutVersion = assertNonNegativeInt(layout.layoutVersion, '逻辑地图版本');
  if (layoutVersion !== DISTRICT_LAYOUT.layoutVersion) fail('逻辑地图版本与当前配置不一致');
  assertNonNegativeInt(layout.revision, '逻辑地图 revision');
  const bounds = assertObject(layout.bounds, '逻辑地图边界');
  const minX = assertNumber(bounds.minX, '逻辑地图边界 minX');
  const maxX = assertNumber(bounds.maxX, '逻辑地图边界 maxX');
  const minZ = assertNumber(bounds.minZ, '逻辑地图边界 minZ');
  const maxZ = assertNumber(bounds.maxZ, '逻辑地图边界 maxZ');
  if (!(minX < maxX && minZ < maxZ)) fail('逻辑地图边界非法');

  const districts = layout.districts;
  if (!Array.isArray(districts) || districts.length === 0) fail('逻辑地图缺少城区');
  const districtIds = new Set<string>();
  const stages = new Set<number>();
  let hasBase = false;
  for (const [index, item] of districts.entries()) {
    const district = assertObject(item, `第 ${index + 1} 个城区`);
    const id = assertString(district.id, `第 ${index + 1} 个城区标识`);
    if (districtIds.has(id)) fail(`城区标识重复：${id}`);
    districtIds.add(id);
    assertString(district.templateId, `第 ${index + 1} 个城区模板`);
    const templateVersion = assertNonNegativeInt(
      district.templateVersion,
      `第 ${index + 1} 个城区模板版本`,
    );
    if (templateVersion < 1) fail(`第 ${index + 1} 个城区模板版本必须从 1 开始`);
    const stage = assertSignedInt(district.stage, `第 ${index + 1} 个城区阶段`);
    if (stage < -1 || stage >= CITY_DEVELOPMENT_RULES.stageCount) fail('城区阶段越界');
    if (stages.has(stage)) fail('城区阶段重复');
    stages.add(stage);
    const direction = district.direction;
    if (direction === null || direction === undefined) {
      if (stage !== -1 || id !== 'district-base') fail('只有基础城区可以没有方向主题');
      hasBase = true;
    } else {
      const directionId = assertString(direction, `第 ${index + 1} 个城区方向`);
      if (!DISTRICT_DIRECTIONS.has(directionId)) fail(`第 ${index + 1} 个城区方向非法`);
      if (stage < 0) fail(`第 ${index + 1} 个扩建城区缺少阶段`);
      if (id !== `district-stage-${stage + 1}`) fail(`第 ${index + 1} 个城区标识与阶段不一致`);
    }
    assertString(district.sourceTermId, `第 ${index + 1} 个城区来源任期`);
    assertString(district.sourceProjectId, `第 ${index + 1} 个城区来源项目`);
    const completedAt = assertNonNegativeInt(
      district.completedAtMinute,
      `第 ${index + 1} 个城区完成时刻`,
    );
    if (completedAt > 0) {
      const clock = assertObject(state.clock, 'state.clock');
      const totalMinute = assertNonNegativeInt(clock.totalMinute, '游戏时间');
      if (completedAt > totalMinute) fail(`第 ${index + 1} 个城区完成时刻晚于当前时间`);
    }
    const districtBounds = assertObject(district.bounds, `第 ${index + 1} 个城区边界`);
    for (const key of ['minX', 'maxX', 'minZ', 'maxZ'] as const) {
      assertNumber(districtBounds[key], `第 ${index + 1} 个城区边界 ${key}`);
    }
    if (!((districtBounds.minX as number) < (districtBounds.maxX as number))) {
      fail(`第 ${index + 1} 个城区边界非法`);
    }
  }
  if (!hasBase) fail('逻辑地图缺少基础城区');

  const roads = layout.roads;
  if (!Array.isArray(roads)) fail('逻辑地图道路非法');
  const roadIds = new Set<string>();
  for (const [index, item] of roads.entries()) {
    const road = assertObject(item, `第 ${index + 1} 条道路`);
    const id = assertString(road.id, `第 ${index + 1} 条道路标识`);
    if (roadIds.has(id)) fail(`道路标识重复：${id}`);
    roadIds.add(id);
    const districtId = assertString(road.districtId, `第 ${index + 1} 条道路所属城区`);
    if (!districtIds.has(districtId)) fail(`第 ${index + 1} 条道路的城区不存在`);
    const center = assertObject(road.center, `第 ${index + 1} 条道路中心`);
    assertNumber(center.x, `第 ${index + 1} 条道路中心 x`);
    assertNumber(center.z, `第 ${index + 1} 条道路中心 z`);
    const size = assertObject(road.size, `第 ${index + 1} 条道路尺寸`);
    const width = assertNumber(size.width, `第 ${index + 1} 条道路宽`);
    const depth = assertNumber(size.depth, `第 ${index + 1} 条道路深`);
    if (!(width > 0 && depth > 0)) fail(`第 ${index + 1} 条道路尺寸非法`);
    assertNumber(road.width, `第 ${index + 1} 条道路宽度`);
  }

  const plots = layout.plots;
  if (!Array.isArray(plots)) fail('逻辑地图地块非法');
  const plotIds = new Set<string>();
  for (const [index, item] of plots.entries()) {
    const plot = assertObject(item, `第 ${index + 1} 个地块`);
    const id = assertString(plot.id, `第 ${index + 1} 个地块标识`);
    if (plotIds.has(id)) fail(`地块标识重复：${id}`);
    plotIds.add(id);
    const districtId = assertString(plot.districtId, `第 ${index + 1} 个地块所属城区`);
    if (!districtIds.has(districtId)) fail(`第 ${index + 1} 个地块的城区不存在`);
    assertString(plot.use, `第 ${index + 1} 个地块用途`);
    const center = assertObject(plot.center, `第 ${index + 1} 个地块中心`);
    assertNumber(center.x, `第 ${index + 1} 个地块中心 x`);
    assertNumber(center.z, `第 ${index + 1} 个地块中心 z`);
    const size = assertObject(plot.size, `第 ${index + 1} 个地块尺寸`);
    const width = assertNumber(size.width, `第 ${index + 1} 个地块宽`);
    const depth = assertNumber(size.depth, `第 ${index + 1} 个地块深`);
    if (!(width > 0 && depth > 0)) fail(`第 ${index + 1} 个地块尺寸非法`);
  }

  const buildings = layout.buildings;
  if (!Array.isArray(buildings) || buildings.length === 0) fail('逻辑地图缺少建筑');
  const buildingIds = new Set<string>();
  for (const [index, item] of buildings.entries()) {
    const building = assertObject(item, `第 ${index + 1} 栋逻辑建筑`);
    const id = assertString(building.id, `第 ${index + 1} 栋逻辑建筑标识`);
    if (buildingIds.has(id)) fail(`逻辑建筑标识重复：${id}`);
    buildingIds.add(id);
    const districtId = assertString(building.districtId, `第 ${index + 1} 栋逻辑建筑城区`);
    if (!districtIds.has(districtId)) fail(`第 ${index + 1} 栋逻辑建筑的城区不存在`);
    const plotId = assertString(building.plotId, `第 ${index + 1} 栋逻辑建筑地块`);
    if (plotId !== '' && !plotIds.has(plotId)) fail(`第 ${index + 1} 栋逻辑建筑的地块不存在`);
    assertString(building.type, `第 ${index + 1} 栋逻辑建筑类型`);
    const kind = assertString(building.kind, `第 ${index + 1} 栋逻辑建筑类别`);
    if (!BUILDING_KINDS.has(kind)) fail(`第 ${index + 1} 栋逻辑建筑类别非法`);
    assertString(building.name, `第 ${index + 1} 栋逻辑建筑名称`);
    assertString(building.subtitle, `第 ${index + 1} 栋逻辑建筑副标题`);
    const position = assertObject(building.position, `第 ${index + 1} 栋逻辑建筑位置`);
    assertNumber(position.x, `第 ${index + 1} 栋逻辑建筑位置 x`);
    assertNumber(position.z, `第 ${index + 1} 栋逻辑建筑位置 z`);
    const size = assertObject(building.size, `第 ${index + 1} 栋逻辑建筑尺寸`);
    for (const key of ['width', 'height', 'depth'] as const) {
      const value = assertNumber(size[key], `第 ${index + 1} 栋逻辑建筑尺寸 ${key}`);
      if (!(value > 0)) fail(`第 ${index + 1} 栋逻辑建筑尺寸必须大于 0`);
    }
    const entrance = assertObject(building.entrance, `第 ${index + 1} 栋逻辑建筑入口`);
    assertNumber(entrance.x, `第 ${index + 1} 栋逻辑建筑入口 x`);
    assertNumber(entrance.z, `第 ${index + 1} 栋逻辑建筑入口 z`);
    const interactionDistance = assertNumber(
      building.interactionDistance,
      `第 ${index + 1} 栋逻辑建筑交互距离`,
    );
    if (interactionDistance < 0) fail(`第 ${index + 1} 栋逻辑建筑交互距离不能为负`);
    assertString(building.interactionId, `第 ${index + 1} 栋逻辑建筑交互标识`);
    if (building.shopId !== null && building.shopId !== undefined) {
      assertString(building.shopId, `第 ${index + 1} 栋逻辑建筑商店标识`);
    }
    assertNonNegativeInt(building.color, `第 ${index + 1} 栋逻辑建筑颜色`);
    if (building.model !== null && building.model !== undefined) {
      assertString(building.model, `第 ${index + 1} 栋逻辑建筑模型`);
    }
    if (building.modelScaleKey !== null && building.modelScaleKey !== undefined) {
      assertString(building.modelScaleKey, `第 ${index + 1} 栋逻辑建筑比例键`);
    }
    if (typeof building.available !== 'boolean') fail(`第 ${index + 1} 栋逻辑建筑缺少可用标记`);
    if (building.companyId !== null && building.companyId !== undefined) {
      const companyId = assertString(building.companyId, `第 ${index + 1} 栋逻辑建筑企业引用`);
      if (!enterpriseIds.has(companyId)) fail(`第 ${index + 1} 栋逻辑建筑的企业不存在`);
    }
    const collision = assertObject(building.collision, `第 ${index + 1} 栋逻辑建筑碰撞盒`);
    for (const key of ['minX', 'maxX', 'minZ', 'maxZ', 'minY', 'maxY'] as const) {
      assertNumber(collision[key], `第 ${index + 1} 栋逻辑建筑碰撞盒 ${key}`);
    }
    if (
      !((collision.minX as number) <= (collision.maxX as number)) ||
      !((collision.minZ as number) <= (collision.maxZ as number))
    ) {
      fail(`第 ${index + 1} 栋逻辑建筑碰撞盒非法`);
    }
  }

  return layout;
}

/**
 * 建设阶段校验：门槛公式、永久防重复高水位、阶段预留、项目与永久历史，
 * 以及「项目 A ⇄ 完成记录/阶段 B ⇄ 实际城区 C」的三向双向一致性。
 *
 * 只读不修：缺城区、缺完成记录、阶段无来源都直接拒绝，不补造城区、不释放阶段、
 * 不删完成历史。永久关联只依赖项目/完成记录/城区与高水位，
 * **不依赖**会被裁剪的政府任期历史（24 条）与判断展示历史。
 */
function validateCityDevelopment(
  state: Record<string, unknown>,
  layout: Record<string, unknown>,
): void {
  const development = assertObject(state.cityDevelopment, 'state.cityDevelopment');
  const statistics = assertObject(state.cityStatistics, 'state.cityStatistics');
  const base = assertObject(statistics.base, '基础 GDP');
  const baseGdp = assertAggregateCents(base.gdpCents, '基础 GDP');

  const highWater = assertNonNegativeInt(
    development.judgedTermHighWater,
    '建设判断任期高水位',
  );
  const judgements = development.judgements;
  if (!Array.isArray(judgements)) fail('建设判断记录非法');
  if (judgements.length > CITY_DEVELOPMENT_RULES.judgementHistoryLimit) {
    fail('建设判断记录过多');
  }
  const outcomeKeys = new Set(Object.keys(CONSTRUCTION_OUTCOME_LABELS));
  for (const [index, item] of judgements.entries()) {
    const record = assertObject(item, `第 ${index + 1} 条建设判断`);
    const termId = assertString(record.termId, `第 ${index + 1} 条建设判断任期`);
    if (!/^term-\d+$/.test(termId)) fail(`第 ${index + 1} 条建设判断任期格式非法`);
    const ordinal = assertNonNegativeInt(record.termOrdinal, `第 ${index + 1} 条建设判断任期序号`);
    if (ordinal > highWater) fail(`第 ${index + 1} 条建设判断超过永久高水位`);
    const judgedAt = assertNonNegativeInt(record.judgedAtMinute, `第 ${index + 1} 条建设判断时刻`);
    const clock = assertObject(state.clock, 'state.clock');
    if (judgedAt > assertNonNegativeInt(clock.totalMinute, '游戏时间')) {
      fail(`第 ${index + 1} 条建设判断时刻晚于当前时间`);
    }
    assertAggregateCents(record.gdpCents, `第 ${index + 1} 条建设判断 GDP`);
    assertAggregateCents(record.thresholdCents, `第 ${index + 1} 条建设判断门槛`);
    const stage = record.stage;
    if (stage !== null && stage !== undefined) {
      const value = assertSignedInt(stage, `第 ${index + 1} 条建设判断阶段`);
      if (value < 0 || value >= CITY_DEVELOPMENT_RULES.stageCount) {
        fail(`第 ${index + 1} 条建设判断阶段越界`);
      }
    }
    const outcome = assertString(record.outcome, `第 ${index + 1} 条建设判断结果`);
    if (!outcomeKeys.has(outcome)) fail(`第 ${index + 1} 条建设判断结果非法`);
    const projectId = record.projectId;
    if (outcome === 'approved') {
      if (stage === null || stage === undefined) fail('已批准建设必须记录阶段');
      assertString(projectId, '已批准建设必须记录项目标识');
    } else if (projectId !== null && projectId !== undefined) {
      fail(`第 ${index + 1} 条建设判断未批准却带有项目标识`);
    }
    assertString(record.note, `第 ${index + 1} 条建设判断说明`);
  }

  const readStageList = (value: unknown, label: string): number[] => {
    if (!Array.isArray(value)) fail(`${label}非法`);
    const rows: number[] = [];
    let previous = -1;
    for (const item of value) {
      const stage = assertSignedInt(item, label);
      if (stage < 0 || stage >= CITY_DEVELOPMENT_RULES.stageCount) fail(`${label}阶段越界`);
      if (stage <= previous) fail(`${label}必须严格递增且不重复`);
      previous = stage;
      rows.push(stage);
    }
    return rows;
  };
  const reservedStages = readStageList(development.reservedStages, '已预留建设阶段');
  const completedStages = readStageList(development.completedStages, '已完成建设阶段');
  for (const stage of completedStages) {
    if (!reservedStages.includes(stage)) fail('已完成阶段必须同时是已预留阶段');
  }

  /* ---- 三向一致性（只读对账）：A=项目、B=完成记录/阶段、C=实际城区 ---- */

  /** 项目行：只承载已校验字段的只读副本，供三向对账使用，不写回状态。 */
  type ProjectRow = {
    readonly id: string;
    readonly stage: number;
    readonly direction: string;
    readonly templateId: string;
    readonly templateVersion: number;
    readonly districtId: string;
    readonly sourceTermId: string;
    readonly completeAtMinute: number;
    readonly status: 'building' | 'completed';
  };
  /** 完成记录行：与 `CompletedDistrictRecord` 同字段，只用于对账。 */
  type CompletionRow = {
    readonly projectId: string;
    readonly districtId: string;
    readonly stage: number;
    readonly direction: string;
    readonly completedAtMinute: number;
    readonly templateId: string;
    readonly templateVersion: number;
  };
  /** 实际城区行：与 `LayoutDistrict` 同字段，只用于对账。 */
  type DistrictRow = {
    readonly id: string;
    readonly templateId: string;
    readonly templateVersion: number;
    readonly direction: string | null;
    readonly stage: number;
    readonly sourceTermId: string;
    readonly sourceProjectId: string;
    readonly completedAtMinute: number;
  };

  // C：实际城区。布局校验已保证字段类型，这里只读复制，用于与项目/完成记录双向对账。
  const layoutDistricts = layout.districts;
  if (!Array.isArray(layoutDistricts)) fail('逻辑地图城区非法');
  const districtById = new Map<string, DistrictRow>();
  const districtBySourceProject = new Map<string, DistrictRow>();
  for (const [index, item] of layoutDistricts.entries()) {
    const district = assertObject(item, `第 ${index + 1} 个城区`);
    const row: DistrictRow = {
      id: assertString(district.id, `第 ${index + 1} 个城区标识`),
      templateId: assertString(district.templateId, `第 ${index + 1} 个城区模板`),
      templateVersion: assertNonNegativeInt(
        district.templateVersion,
        `第 ${index + 1} 个城区模板版本`,
      ),
      direction:
        district.direction === null || district.direction === undefined
          ? null
          : assertString(district.direction, `第 ${index + 1} 个城区方向`),
      stage: assertSignedInt(district.stage, `第 ${index + 1} 个城区阶段`),
      sourceTermId: assertString(district.sourceTermId, `第 ${index + 1} 个城区来源任期`),
      sourceProjectId: assertString(district.sourceProjectId, `第 ${index + 1} 个城区来源项目`),
      completedAtMinute: assertNonNegativeInt(
        district.completedAtMinute,
        `第 ${index + 1} 个城区完成时刻`,
      ),
    };
    districtById.set(row.id, row);
    // 基础城区（stage -1）单独处理：不要求有选举建设项目，也不允许伪造来源项目引用。
    if (row.stage < 0) {
      if (row.sourceProjectId.length > 0) {
        fail(`基础城区 ${row.id} 不得带有来源项目 ${row.sourceProjectId}`);
      }
      continue;
    }
    if (row.sourceProjectId.length === 0) fail(`扩建城区 ${row.id} 缺少来源项目`);
    const duplicated = districtBySourceProject.get(row.sourceProjectId);
    if (duplicated) {
      fail(`扩建城区 ${duplicated.id} 与 ${row.id} 重复引用来源项目 ${row.sourceProjectId}`);
    }
    districtBySourceProject.set(row.sourceProjectId, row);
  }

  // A：建设项目。
  const projects = development.projects;
  if (!Array.isArray(projects)) fail('建设项目非法');
  const projectIds = new Set<string>();
  const projectById = new Map<string, ProjectRow>();
  const projectByStage = new Map<number, ProjectRow>();
  for (const [index, item] of projects.entries()) {
    const project = assertObject(item, `第 ${index + 1} 个建设项目`);
    const id = assertString(project.id, `第 ${index + 1} 个建设项目标识`);
    if (projectIds.has(id)) fail(`建设项目标识重复：${id}`);
    projectIds.add(id);
    const stage = assertSignedInt(project.stage, `第 ${index + 1} 个建设项目阶段`);
    if (!reservedStages.includes(stage)) fail(`第 ${index + 1} 个建设项目阶段未被预留`);
    if (projectByStage.has(stage)) fail('同一阶段不允许多个项目');
    const direction = assertString(project.direction, `第 ${index + 1} 个建设项目方向`);
    if (!DISTRICT_DIRECTIONS.has(direction)) fail(`第 ${index + 1} 个建设项目方向非法`);
    const templateId = assertString(project.templateId, `第 ${index + 1} 个建设项目模板`);
    const templateVersion = assertNonNegativeInt(
      project.templateVersion,
      `第 ${index + 1} 个建设项目模板版本`,
    );
    const districtId = assertString(project.districtId, `第 ${index + 1} 个建设项目城区`);
    if (districtId !== `district-stage-${stage + 1}`) fail('建设项目城区与阶段不一致');
    const sourceTermId = assertString(project.sourceTermId, `第 ${index + 1} 个建设项目来源任期`);
    if (!/^term-\d+$/.test(sourceTermId)) fail('建设项目来源任期格式非法');
    const approvedAt = assertNonNegativeInt(
      project.approvedAtMinute,
      `第 ${index + 1} 个建设项目批准时刻`,
    );
    const completeAt = assertNonNegativeInt(
      project.completeAtMinute,
      `第 ${index + 1} 个建设项目完成时刻`,
    );
    if (completeAt !== approvedAt + CITY_DEVELOPMENT_RULES.projectDays * CALENDAR.minutesPerDay) {
      fail(`第 ${index + 1} 个建设项目建设时长不等于配置值`);
    }
    const status = assertString(project.status, `第 ${index + 1} 个建设项目状态`);
    if (status !== 'building' && status !== 'completed') fail('建设项目状态非法');
    assertAggregateCents(project.gdpAtApprovalCents, `第 ${index + 1} 个建设项目批准时 GDP`);
    const threshold = assertAggregateCents(project.thresholdCents, `第 ${index + 1} 个建设项目门槛`);
    const expectedThreshold =
      baseGdp + Math.round(CITY_DEVELOPMENT_RULES.firstThresholdCents * Math.pow(CITY_DEVELOPMENT_RULES.thresholdGrowth, stage));
    if (threshold !== expectedThreshold) fail(`第 ${index + 1} 个建设项目门槛与阶段公式不一致`);
    if (project.enterpriseBuildingId !== null && project.enterpriseBuildingId !== undefined) {
      assertString(project.enterpriseBuildingId, `第 ${index + 1} 个建设项目招商建筑`);
    }
    if (direction === 'technology' && (project.enterpriseBuildingId === null || project.enterpriseBuildingId === undefined)) {
      fail(`第 ${index + 1} 个科技项目缺少招商建筑引用`);
    }
    const row: ProjectRow = {
      id,
      stage,
      direction,
      templateId,
      templateVersion,
      districtId,
      sourceTermId,
      completeAtMinute: completeAt,
      status,
    };
    projectById.set(id, row);
    projectByStage.set(stage, row);
  }

  const completions = development.completions;
  if (!Array.isArray(completions)) fail('永久建设历史非法');
  if (completions.length > CITY_DEVELOPMENT_RULES.completionHistoryLimit) {
    fail('永久建设历史过多');
  }
  // 首版 stageCount = 3 < completionHistoryLimit = 24：合法存档不会裁剪掉仍被阶段引用的完成记录。
  const completionsByProjectId = new Map<string, CompletionRow>();
  for (const [index, item] of completions.entries()) {
    const completion = assertObject(item, `第 ${index + 1} 条永久建设历史`);
    const projectId = assertString(completion.projectId, `第 ${index + 1} 条永久建设历史项目`);
    if (completionsByProjectId.has(projectId)) fail(`永久建设历史项目重复：${projectId}`);
    const districtId = assertString(completion.districtId, `第 ${index + 1} 条永久建设历史城区`);
    const stage = assertSignedInt(completion.stage, `第 ${index + 1} 条永久建设历史阶段`);
    if (districtId !== `district-stage-${stage + 1}`) fail('永久建设历史城区与阶段不一致');
    if (!completedStages.includes(stage)) fail('永久建设历史阶段未标记完成');
    const direction = assertString(completion.direction, `第 ${index + 1} 条永久建设历史方向`);
    if (!DISTRICT_DIRECTIONS.has(direction)) fail('永久建设历史方向非法');
    const completedAt = assertNonNegativeInt(
      completion.completedAtMinute,
      `第 ${index + 1} 条永久建设历史时刻`,
    );
    const templateId = assertString(completion.templateId, `第 ${index + 1} 条永久建设历史模板`);
    const templateVersion = assertNonNegativeInt(
      completion.templateVersion,
      `第 ${index + 1} 条永久建设历史模板版本`,
    );
    // B → A/C：每条完成记录都必须反向对应真实的已完成项目与实际城区，不允许孤立记录。
    const project = projectById.get(projectId);
    if (!project) fail(`永久完成记录 ${projectId} 没有对应的建设项目`);
    if (project.status !== 'completed') fail(`永久完成记录 ${projectId} 对应的项目尚未完成`);
    if (!districtById.has(districtId)) fail(`永久完成记录 ${projectId} 的城区 ${districtId} 不存在`);
    completionsByProjectId.set(projectId, {
      projectId,
      districtId,
      stage,
      direction,
      completedAtMinute: completedAt,
      templateId,
      templateVersion,
    });
  }

  // A → B/C：已完成项目必须同时拥有唯一完成记录与唯一实际扩建城区，且共有字段一致。
  for (const project of projectById.values()) {
    if (project.status === 'building') {
      // 建设中：不得提前拥有完成记录、已完成阶段标记或已建成城区。
      if (completionsByProjectId.has(project.id)) {
        fail(`建设中项目 ${project.id} 不得拥有永久完成记录`);
      }
      if (completedStages.includes(project.stage)) {
        fail(`建设中项目 ${project.id} 的阶段 ${project.stage} 不得出现在已完成阶段`);
      }
      const earlyDistrict = districtBySourceProject.get(project.id);
      if (earlyDistrict) {
        fail(`建设中项目 ${project.id} 不得对应已建成城区 ${earlyDistrict.id}`);
      }
      continue;
    }

    // 阶段必须同时存在于 completedStages 与 reservedStages（reserved 已在项目循环核对）。
    if (!completedStages.includes(project.stage)) {
      fail(`已完成项目 ${project.id} 的阶段 ${project.stage} 未出现在已完成阶段中`);
    }
    const completion = completionsByProjectId.get(project.id);
    if (!completion) fail(`已完成项目 ${project.id} 缺少永久完成记录`);
    const district = districtBySourceProject.get(project.id);
    if (!district) fail(`已完成项目 ${project.id} 缺少对应城区 ${project.districtId}`);

    // 项目 ↔ 完成记录
    if (completion.districtId !== project.districtId) {
      fail(
        `已完成项目 ${project.id} 的完成记录城区 ${completion.districtId} 与项目城区 ${project.districtId} 不一致`,
      );
    }
    if (completion.stage !== project.stage) {
      fail(`已完成项目 ${project.id} 的完成记录阶段与项目不一致`);
    }
    if (completion.direction !== project.direction) {
      fail(`已完成项目 ${project.id} 的完成记录方向与项目不一致`);
    }
    if (
      completion.templateId !== project.templateId ||
      completion.templateVersion !== project.templateVersion
    ) {
      fail(`已完成项目 ${project.id} 的完成记录模板与项目不一致`);
    }
    // 完成只能发生在计划完成时刻之后，允许同一分钟。
    if (completion.completedAtMinute < project.completeAtMinute) {
      fail(`已完成项目 ${project.id} 的完成记录时刻早于计划完成时刻`);
    }

    // 项目 ↔ 实际城区
    if (district.id !== project.districtId) {
      fail(
        `已完成项目 ${project.id} 对应的城区 ${district.id} 与项目城区 ${project.districtId} 不一致`,
      );
    }
    if (district.stage !== project.stage) {
      fail(`已完成项目 ${project.id} 对应城区的阶段与项目不一致`);
    }
    if (district.direction === null || district.direction !== project.direction) {
      fail(`已完成项目 ${project.id} 对应城区的方向与项目不一致`);
    }
    if (
      district.templateId !== project.templateId ||
      district.templateVersion !== project.templateVersion
    ) {
      fail(`已完成项目 ${project.id} 对应城区的模板与项目不一致`);
    }
    if (district.sourceTermId !== project.sourceTermId) {
      fail(`已完成项目 ${project.id} 对应城区的来源任期与项目不一致`);
    }
    // 完成记录 ↔ 实际城区：同一时刻，且都不早于计划完成时刻。
    if (district.completedAtMinute !== completion.completedAtMinute) {
      fail(`已完成项目 ${project.id} 的完成记录与城区完成时刻不一致`);
    }
    if (district.completedAtMinute < project.completeAtMinute) {
      fail(`已完成项目 ${project.id} 对应城区的完成时刻早于计划完成时刻`);
    }
  }

  // C → A/B：每个非基础扩建城区都必须反向对应一个已完成项目与一条完成记录。
  for (const district of districtById.values()) {
    if (district.stage < 0) continue;
    const project = projectById.get(district.sourceProjectId);
    if (!project) fail(`扩建城区 ${district.id} 缺少对应建设项目 ${district.sourceProjectId}`);
    if (project.status !== 'completed') {
      fail(`扩建城区 ${district.id} 对应的项目 ${project.id} 尚未完成`);
    }
    if (!completionsByProjectId.has(project.id)) {
      fail(`扩建城区 ${district.id} 缺少对应的永久完成记录`);
    }
  }

  // B → A/C：预留阶段必须能落到真实项目，完成阶段必须能落到已完成项目（其完成记录与城区已在上方核对）。
  for (const stage of reservedStages) {
    if (!projectByStage.has(stage)) fail(`已预留建设阶段 ${stage} 没有对应建设项目`);
  }
  for (const stage of completedStages) {
    const project = projectByStage.get(stage);
    if (!project) fail(`已完成建设阶段 ${stage} 没有对应建设项目`);
    if (project.status !== 'completed') {
      fail(`已完成建设阶段 ${stage} 对应的项目 ${project.id} 尚未完成`);
    }
  }

  const layoutBuildings = layout.buildings;
  const buildingIds = new Set<string>();
  if (Array.isArray(layoutBuildings)) {
    for (const item of layoutBuildings) {
      const building = assertObject(item, '逻辑建筑');
      buildingIds.add(assertString(building.id, '逻辑建筑标识'));
    }
  }
  const slots = development.enterpriseSlots;
  if (!Array.isArray(slots)) fail('新区招商槽位非法');
  const slotIds = new Set<string>();
  const slotDistricts = new Set<string>();
  for (const [index, item] of slots.entries()) {
    const slot = assertObject(item, `第 ${index + 1} 个招商槽位`);
    const id = assertString(slot.id, `第 ${index + 1} 个招商槽位标识`);
    if (slotIds.has(id)) fail(`招商槽位标识重复：${id}`);
    slotIds.add(id);
    const districtId = assertString(slot.districtId, `第 ${index + 1} 个招商槽位城区`);
    if (slotDistricts.has(districtId)) fail('同一城区最多一个招商槽位');
    slotDistricts.add(districtId);
    const buildingId = assertString(slot.buildingId, `第 ${index + 1} 个招商槽位建筑`);
    if (!buildingIds.has(buildingId)) fail(`第 ${index + 1} 个招商槽位建筑不存在`);
    const status = assertString(slot.status, `第 ${index + 1} 个招商槽位状态`);
    if (status !== 'pending' && status !== 'created') fail('招商槽位状态非法');
    if (status === 'created') {
      const companyId = assertString(slot.companyId, `第 ${index + 1} 个招商槽位企业`);
      if (!buildingIds.has(buildingId)) fail('招商槽位建筑不存在');
      const building = (layoutBuildings as Array<Record<string, unknown>>).find(
        (row) => row.id === buildingId,
      );
      if (!building || building.companyId !== companyId) {
        fail(`第 ${index + 1} 个招商槽位的企业引用与建筑不一致`);
      }
    } else if (slot.companyId !== null && slot.companyId !== undefined) {
      fail(`第 ${index + 1} 个招商槽位未创建却带有企业`);
    }
    assertNonNegativeInt(slot.attempts, `第 ${index + 1} 个招商槽位尝试次数`);
    if (slot.lastAttemptMinute !== null && slot.lastAttemptMinute !== undefined) {
      assertNonNegativeInt(slot.lastAttemptMinute, `第 ${index + 1} 个招商槽位最近尝试时刻`);
    }
  }

  const nextProjectSeq = assertNonNegativeInt(development.nextProjectSeq, '下一个建设项目序号');
  if (nextProjectSeq < 1) fail('下一个建设项目序号必须从 1 开始');
  if (highWater < 0) fail('建设判断任期高水位非法');
}

/**
 * 房地产切片校验（v17）。
 *
 * 只读、不修复：产权引用必须指向真实资金主体，产权与入住/挂牌/保护期彼此一致，
 * 永久居住权必须且只能有一处，晴川公寓单元数固定为 100，报价预留必须与报价金额相等。
 * 不一致的存档明确拒绝，不自动补造房产、不释放预留、不改写历史成交。
 */
function validateRealEstate(
  state: Record<string, unknown>,
  finance: Record<string, unknown>,
  totalMinute: number,
): void {
  const estate = assertObject(state.realEstate, 'state.realEstate');
  const subjectAccounts = assertObject(finance.subjectAccounts, 'state.finance.subjectAccounts');
  const groupIds = new Set(HOUSING_GROUPS.map((group) => group.id));
  const layoutIds = new Set<string>(HOME_LAYOUTS.map((layout) => String(layout.id)));

  const properties = estate.properties;
  if (!Array.isArray(properties)) fail('房产列表非法');
  const propertyIds = new Set<string>();
  let baseUnits = 0;
  let freeResidences = 0;

  for (const [index, item] of properties.entries()) {
    const label = `第 ${index + 1} 处房产`;
    const property = assertObject(item, label);
    const id = assertString(property.id, `${label}标识`);
    if (id.length === 0) fail(`${label}标识为空`);
    if (propertyIds.has(id)) fail(`房产标识重复：${id}`);
    propertyIds.add(id);
    assertString(property.name, `${label}名称`);

    const kind = assertString(property.kind, `${label}类型`);
    if (kind !== 'home' && kind !== 'land') fail(`${label}类型非法：${kind}`);
    assertString(property.districtId, `${label}城区`);
    const area = assertNonNegativeInt(property.areaSqm, `${label}面积`);
    if (area <= 0) fail(`${label}面积必须大于 0`);
    const deliveredAt = assertNonNegativeInt(property.deliveredAtMinute, `${label}交付时间`);
    if (deliveredAt > totalMinute) fail(`${label}交付时间晚于当前游戏时间`);
    const valuation = assertNonNegativeInt(property.valuationCents, `${label}参考估值`);
    if (valuation <= 0) fail(`${label}参考估值必须大于 0`);
    assertNonNegativeInt(property.costBasisCents, `${label}成本基础`);
    const acquiredAt = assertNonNegativeInt(property.acquiredAtMinute, `${label}取得时间`);
    if (acquiredAt > totalMinute) fail(`${label}取得时间晚于当前游戏时间`);
    assertOptionalNonNegativeInt(property.protectionUntilMinute, `${label}保护期`);
    assertOptionalNonNegativeInt(property.firstSoldAtMinute, `${label}首次成交时间`);

    const owner = assertObject(property.owner, `${label}产权主体`);
    const ownerKind = assertString(owner.kind, `${label}产权主体类型`);
    if (ownerKind !== 'player' && ownerKind !== 'household' && ownerKind !== 'investor') {
      fail(`${label}产权主体类型非法：${ownerKind}`);
    }
    const ownerId = assertString(owner.id, `${label}产权主体标识`);
    if (ownerId.length === 0) fail(`${label}产权主体标识为空`);
    if (ownerKind === 'player' && ownerId !== 'player') fail(`${label}玩家产权主体标识非法`);
    if (ownerKind === 'household' && !groupIds.has(ownerId)) {
      fail(`${label}居民群组不存在：${ownerId}`);
    }
    if (ownerKind === 'investor' && subjectAccounts[`investor:${ownerId}`] === undefined) {
      fail(`${label}机构产权主体没有资金账户：${ownerId}`);
    }

    if (kind === 'home') {
      const buildingId = assertString(property.buildingId, `${label}所在建筑`);
      if (buildingId.length === 0) fail(`${label}缺少所在建筑`);
      if (property.parcelId !== null) fail(`${label}住宅不应带地块标识`);
      const layoutId = assertString(property.layoutId, `${label}户型`);
      if (!layoutIds.has(layoutId)) fail(`${label}户型非法：${layoutId}`);
      const occupancy = assertString(property.occupancy, `${label}入住状态`);
      if (
        occupancy !== 'free-residence' &&
        occupancy !== 'owner-occupied' &&
        occupancy !== 'vacant'
      ) {
        fail(`${label}入住状态非法：${occupancy}`);
      }
      if (occupancy === 'free-residence') {
        if (property.freeResidenceFor !== 'player') fail(`${label}永久居住权缺少权利人`);
        if (ownerKind === 'player') fail(`${label}永久居住权不能由玩家持有产权`);
        freeResidences += 1;
      } else if (property.freeResidenceFor !== null && property.freeResidenceFor !== undefined) {
        fail(`${label}非永久居住权住宅不应带权利人标记`);
      }
      if (property.askPriceCents !== null && property.askPriceCents !== undefined) {
        fail(`${label}住宅不应带土地出让价`);
      }
      if (buildingId === 'home') baseUnits += 1;
    } else {
      if (property.layoutId !== null && property.layoutId !== undefined) {
        fail(`${label}土地不应带户型`);
      }
      if (property.occupancy !== null && property.occupancy !== undefined) {
        fail(`${label}土地不应带入住状态`);
      }
      if (property.freeResidenceFor !== null && property.freeResidenceFor !== undefined) {
        fail(`${label}土地不应带居住权标记`);
      }
      if (property.buildingId !== null && property.buildingId !== undefined) {
        fail(`${label}土地不应带建筑标识`);
      }
      const parcelId = assertString(property.parcelId, `${label}地块标识`);
      if (parcelId !== id) fail(`${label}地块标识与房产标识不一致`);
      // 出让价只在城市土地储备中心持有且正在出让时存在：玩家与机构持有都必须为 null，
      // 但存在时必须是正整数。
      if (property.askPriceCents !== null && property.askPriceCents !== undefined) {
        const ask = assertNonNegativeInt(property.askPriceCents, `${label}出让价`);
        if (ask <= 0) fail(`${label}出让价必须大于 0`);
        if (ownerKind === 'player') fail(`${label}玩家持有土地不应有出让价`);
      }
      if (property.listing !== null && property.listing !== undefined) {
        fail(`${label}土地不能挂牌`);
      }
    }

    const listingVersion = assertNonNegativeInt(property.listingVersion, `${label}挂牌版本高水位`);
    if (property.listing === undefined) fail(`${label}缺少挂牌字段`);
    if (property.listing !== null) {
      const listing = assertObject(property.listing, `${label}挂牌`);
      const price = assertNonNegativeInt(listing.priceCents, `${label}挂牌价`);
      if (price < REAL_ESTATE_RULES.minListingPriceCents) fail(`${label}挂牌价低于下限`);
      const version = assertNonNegativeInt(listing.version, `${label}挂牌版本`);
      if (version < 1 || version !== listingVersion) fail(`${label}挂牌版本与高水位不一致`);
      const listedAt = assertNonNegativeInt(listing.listedAtMinute, `${label}挂牌时间`);
      if (listedAt > totalMinute) fail(`${label}挂牌时间晚于当前游戏时间`);
    }
  }

  if (freeResidences !== 1) fail('永久居住权必须且只能有一处');
  if (baseUnits !== 100) fail('晴川公寓住宅单元必须为 100 套');

  // 土地报价：必须指向玩家持有的土地，且预留金额与报价相等
  const offers = estate.offers;
  if (!Array.isArray(offers)) fail('土地报价列表非法');
  const offerIds = new Set<string>();
  const reservations = assertObject(finance.reservations, 'state.finance.reservations');
  for (const [index, item] of offers.entries()) {
    const label = `第 ${index + 1} 份土地报价`;
    const offer = assertObject(item, label);
    const id = assertString(offer.id, `${label}标识`);
    if (offerIds.has(id)) fail(`土地报价标识重复：${id}`);
    offerIds.add(id);
    const propertyId = assertString(offer.propertyId, `${label}地块`);
    if (!propertyIds.has(propertyId)) fail(`${label}指向不存在的地块`);
    const investorId = assertString(offer.investorId, `${label}出价机构`);
    if (subjectAccounts[`investor:${investorId}`] === undefined) {
      fail(`${label}出价机构没有资金账户`);
    }
    const price = assertNonNegativeInt(offer.priceCents, `${label}报价金额`);
    if (price <= 0) fail(`${label}报价金额必须大于 0`);
    const created = assertNonNegativeInt(offer.createdAtMinute, `${label}创建时间`);
    if (created > totalMinute) fail(`${label}创建时间晚于当前游戏时间`);
    const expires = assertNonNegativeInt(offer.expiresAtMinute, `${label}到期时间`);
    if (expires <= created) fail(`${label}到期时间必须晚于创建时间`);
    const reserved = reservations[`investor:${investorId}::${id}`];
    if (reserved === undefined || reserved !== price) {
      fail(`${label}的资金预留与报价金额不一致`);
    }
  }

  // 成交记录：序号唯一、金额合法、玩家卖方才有已实现价差
  const trades = estate.trades;
  if (!Array.isArray(trades)) fail('成交记录非法');
  if (trades.length > REAL_ESTATE_RULES.tradeHistoryLimit) fail('成交记录超出上限');
  const tradeIds = new Set<string>();
  const nextTradeSeq = assertNonNegativeInt(estate.nextTradeSeq, '成交序号');
  if (nextTradeSeq < 1) fail('成交序号必须从 1 开始');
  let realizedCount = 0;
  for (const [index, item] of trades.entries()) {
    const label = `第 ${index + 1} 条成交记录`;
    const trade = assertObject(item, label);
    const id = assertString(trade.id, `${label}标识`);
    if (tradeIds.has(id)) fail(`成交记录标识重复：${id}`);
    tradeIds.add(id);
    const matched = /^trade-(\d+)$/.exec(id);
    if (!matched) fail(`${label}标识格式非法：${id}`);
    if (Number(matched[1]) >= nextTradeSeq) fail(`${label}序号不小于下一成交序号`);
    const propertyId = assertString(trade.propertyId, `${label}房产`);
    if (!propertyIds.has(propertyId)) fail(`${label}指向不存在的房产`);
    const price = assertNonNegativeInt(trade.priceCents, `${label}成交价`);
    if (price <= 0) fail(`${label}成交价必须大于 0`);
    assertNonNegativeInt(trade.valuationCents, `${label}成交时估值`);
    const atMinute = assertNonNegativeInt(trade.atMinute, `${label}成交时间`);
    if (atMinute > totalMinute) fail(`${label}成交时间晚于当前游戏时间`);
    assertString(trade.monthKey, `${label}月份`);
    assertString(trade.operationId, `${label}操作标识`);
    const buyer = assertObject(trade.buyer, `${label}买方`);
    const seller = assertObject(trade.seller, `${label}卖方`);
    assertString(buyer.kind, `${label}买方类型`);
    assertString(seller.kind, `${label}卖方类型`);
    if (trade.realizedCents === null || trade.realizedCents === undefined) {
      if (seller.kind === 'player') fail(`${label}玩家卖出必须记录已实现价差`);
    } else {
      assertSignedInt(trade.realizedCents, `${label}已实现价差`);
      if (seller.kind !== 'player') fail(`${label}非玩家卖出不应记录已实现价差`);
      realizedCount += 1;
    }
    if (
      trade.channel !== 'player' &&
      trade.channel !== 'market' &&
      trade.channel !== 'offer'
    ) {
      fail(`${label}成交渠道非法`);
    }
  }
  const realizedCents = assertSignedInt(estate.realizedCents, '累计已实现价差');
  void realizedCents;
  const realizedTrades = assertNonNegativeInt(estate.realizedTrades, '已实现成交笔数');
  if (realizedTrades < realizedCount) fail('已实现成交笔数少于保留的成交记录');
  const nextPropertySeq = assertNonNegativeInt(estate.nextPropertySeq, '房产序号');
  if (nextPropertySeq < 1) fail('房产序号必须从 1 开始');
  const nextOfferSeq = assertNonNegativeInt(estate.nextOfferSeq, '报价序号');
  if (nextOfferSeq < 1) fail('报价序号必须从 1 开始');
  if (estate.lastMarketMonthKey !== null && estate.lastMarketMonthKey !== undefined) {
    assertString(estate.lastMarketMonthKey, '住房市场最近结算月份');
  }
}

/**
 * 宏观住房切片校验（v17）：只保存家庭数、居住分配、意愿与月度指标。
 *
 * 不保存余额（余额在 finance 的 `household:<id>` 主体账户里）与人口权威，
 * 因此这里只核对「家庭数与意愿的互斥/上限关系」和「每个群组都有真实资金账户」。
 */
function validateHousing(
  state: Record<string, unknown>,
  finance: Record<string, unknown>,
  totalMinute: number,
): void {
  const housing = assertObject(state.housing, 'state.housing');
  const subjectAccounts = assertObject(finance.subjectAccounts, 'state.finance.subjectAccounts');
  const groups = housing.groups;
  if (!Array.isArray(groups)) fail('住房群组列表非法');
  if (groups.length !== HOUSING_GROUPS.length) fail('住房群组数量与配置不一致');
  const seen = new Set<string>();
  for (const [index, item] of groups.entries()) {
    const label = `第 ${index + 1} 个住房群组`;
    const group = assertObject(item, label);
    const id = assertString(group.id, `${label}标识`);
    const config = HOUSING_GROUPS.find((row) => row.id === id);
    if (!config) fail(`${label}标识不在配置中：${id}`);
    if (seen.has(id)) fail(`住房群组重复：${id}`);
    seen.add(id);
    if (group.income !== config.income) fail(`${label}收入阶层与配置不一致`);
    const households = assertNonNegativeInt(group.households, `${label}家庭数`);
    const owned = assertNonNegativeInt(group.ownedHouseholds, `${label}自有住房家庭数`);
    if (owned > households) fail(`${label}自有住房家庭数超过家庭数`);
    const wantFirst = assertNumber(group.wantFirstTime, `${label}首次购房意愿`);
    const wantUpgrade = assertNumber(group.wantUpgrade, `${label}改善意愿`);
    for (const [value, name] of [
      [wantFirst, '首次购房意愿'],
      [wantUpgrade, '改善意愿'],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) fail(`${label}${name}必须是非负数`);
      if (value > households) fail(`${label}${name}不能超过家庭数`);
    }
    if (subjectAccounts[`household:${id}`] === undefined) {
      fail(`${label}缺少居民资金账户`);
    }
  }

  if (housing.lastSettledMonthKey !== null && housing.lastSettledMonthKey !== undefined) {
    assertString(housing.lastSettledMonthKey, '住房最近结算月份');
  }
  const observationStart = assertNonNegativeInt(
    housing.observationStartMinute,
    '住房观察起点',
  );
  if (observationStart > totalMinute) fail('住房观察起点晚于当前游戏时间');

  const monthly = housing.monthly;
  if (!Array.isArray(monthly)) fail('住房月度指标非法');
  if (monthly.length > REAL_ESTATE_RULES.monthHistoryLimit) fail('住房月度指标超出上限');
  let previousMonth = '';
  for (const [index, item] of monthly.entries()) {
    const label = `第 ${index + 1} 条住房月度指标`;
    const row = assertObject(item, label);
    const monthKey = assertString(row.monthKey, `${label}月份`);
    if (previousMonth !== '' && monthKey <= previousMonth) fail('住房月度指标月份必须严格递增');
    previousMonth = monthKey;
    const settledAt = assertNonNegativeInt(row.settledAtMinute, `${label}结算时刻`);
    if (settledAt > totalMinute) fail(`${label}结算时刻晚于当前游戏时间`);
    for (const key of [
      'marketSales',
      'householdSales',
      'investorSales',
      'playerSales',
      'vacantUnits',
      'listedUnits',
      'unmetDemand',
    ] as const) {
      assertNonNegativeInt(row[key], `${label}${key}`);
    }
    for (const key of ['avgSalePriceCents', 'avgValuationCents'] as const) {
      assertNonNegativeInt(row[key], `${label}${key}`);
    }
    const affordability = assertObject(row.affordability, `${label}负担能力`);
    const pressure = assertObject(row.pressure, `${label}住房压力`);
    for (const tier of ['low', 'mid', 'high'] as const) {
      const ratio = assertNumber(affordability[tier], `${label}负担能力 ${tier}`);
      if (ratio < 0) fail(`${label}负担能力不能为负`);
      const value = assertNumber(pressure[tier], `${label}住房压力 ${tier}`);
      if (value < 0 || value > 1) fail(`${label}住房压力必须在 0～1`);
    }
    if (typeof row.complete !== 'boolean') fail(`${label}完整月标记非法`);
  }
}

/**
 * 环境（天气）切片校验。
 *
 * 只校验「不能由游戏时间推导」的字段：当前天气、过渡起点、下次调度与天气随机游标。
 * 太阳方向、天空颜色、雾距离与环境光都在运行时由时间与天气推导，存档里没有副本，
 * 因此也不存在需要核对的第二份数值。
 */
function validateFurniture(state: Record<string, unknown>): void {
  const furniture = assertObject(state.furniture, 'state.furniture');
  if (furniture.residenceId !== FURNITURE_RESIDENCE_ID) {
    fail('家具布局的住宅标识非法');
  }
  if (furniture.layoutVersion !== FURNITURE_LAYOUT_VERSION) {
    fail('家具布局版本非法');
  }
  const items = assertObject(furniture.items, 'state.furniture.items');
  const expected = new Set(FURNITURE_DEFINITIONS.map((definition) => instanceIdOf(definition)));
  const actual = Object.keys(items);
  if (actual.length !== expected.size || actual.some((id) => !expected.has(id))) {
    fail('家具实例集合不完整或包含未知实例');
  }
  for (const definition of FURNITURE_DEFINITIONS) {
    const id = instanceIdOf(definition);
    const item = assertObject(items[id], `家具 ${id}`);
    if (item.id !== id) fail(`家具实例 id 与键不一致：${id}`);
    if (item.definitionId !== definition.id) fail(`家具 ${id} 的定义不匹配`);
    const status = assertString(item.status, `家具 ${id} 状态`);
    if (status !== 'placed' && status !== 'stored') fail(`家具 ${id} 状态非法`);
    const quarterTurn = assertNonNegativeInt(item.quarterTurn, `家具 ${id} 朝向`);
    if (quarterTurn > 3) fail(`家具 ${id} 朝向越界`);
    const width = assertNonNegativeInt(item.footprintWidth, `家具 ${id} 占格宽度`);
    const depth = assertNonNegativeInt(item.footprintDepth, `家具 ${id} 占格深度`);
    if (width !== definition.footprintWidth || depth !== definition.footprintDepth) {
      fail(`家具 ${id} 的占格尺寸与定义不一致`);
    }
    const cellX = assertNonNegativeInt(item.cellX, `家具 ${id} X 格`);
    const cellZ = assertNonNegativeInt(item.cellZ, `家具 ${id} Z 格`);
    const span = footprintForRotation(
      definition.footprintWidth,
      definition.footprintDepth,
      quarterTurn as 0 | 1 | 2 | 3,
    );
    if (!isCellPlacementValid(cellX, cellZ, span)) {
      fail(`家具 ${id} 的格位超出允许范围`);
    }
  }
}

function validateEnvironment(state: Record<string, unknown>, totalMinute: number): void {
  const environment = assertObject(state.environment, 'state.environment');
  const weather = assertString(environment.weather, '当前天气');
  if (!isWeatherKind(weather)) fail(`天气种类非法：${weather}`);
  const previous = assertString(environment.previousWeather, '上一段天气');
  if (!isWeatherKind(previous)) fail(`上一段天气种类非法：${previous}`);
  const changedAt = assertNonNegativeInt(environment.changedAtMinute, '天气起点');
  if (changedAt > totalMinute) fail('天气起点晚于当前游戏时间');
  const endsAt = assertNonNegativeInt(environment.endsAtMinute, '下次天气调度时间');
  if (endsAt <= totalMinute) fail('下次天气调度时间必须晚于当前游戏时间');
  assertNonNegativeInt(environment.randomState, '天气随机状态');
}

export function validateSaveState(rawState: unknown): Record<string, unknown> {
  const state = assertObject(rawState, 'state');


  const clock = assertObject(state.clock, 'state.clock');
  const totalMinute = assertNonNegativeInt(clock.totalMinute, '游戏时间');
  if (typeof clock.paused !== 'boolean') fail('暂停状态非法');
  if (typeof clock.speed !== 'number' || !Number.isFinite(clock.speed) || clock.speed <= 0) {
    fail('游戏速度非法');
  }

  const finance = assertObject(state.finance, 'state.finance');
  if (finance.owner !== 'personal') fail('账户归属主体非法');
  const accounts = assertObject(finance.accounts, 'state.finance.accounts');
  assertNonNegativeInt(accounts.cash, '现金余额');
  assertNonNegativeInt(accounts.savings, '存款余额');
  assertNonNegativeInt(finance.nextSeq, '流水序号');
  if (!Array.isArray(finance.entries)) fail('流水数据非法');
  const seenIds = new Set<string>();
  for (const [index, item] of finance.entries.entries()) {
    const entry = assertObject(item, `第 ${index + 1} 条流水`);
    const id = assertString(entry.id, `第 ${index + 1} 条流水编号`);
    if (seenIds.has(id)) fail(`流水编号重复：${id}`);
    seenIds.add(id);
    assertString(entry.operationId, `第 ${index + 1} 条流水操作标识`);
    assertNonNegativeInt(entry.atMinute, `第 ${index + 1} 条流水时间`);
    assertString(entry.monthKey, `第 ${index + 1} 条流水月份`);
    const amount = assertNonNegativeInt(entry.amount, `第 ${index + 1} 条流水金额`);
    if (amount === 0) fail(`第 ${index + 1} 条流水金额不能为 0`);
    assertAccountRef(entry.from, `第 ${index + 1} 条流水来源`);
    assertAccountRef(entry.to, `第 ${index + 1} 条流水去向`);
    const category = assertString(entry.category, `第 ${index + 1} 条流水类别`);
    if (!CATEGORIES.has(category)) fail(`第 ${index + 1} 条流水类别非法`);
    assertString(entry.memo, `第 ${index + 1} 条流水备注`);
  }

  const employment = assertObject(state.employment, 'state.employment');
  if (employment.jobId !== null && employment.jobId !== undefined) {
    const jobId = assertString(employment.jobId, '任职信息');
    if (!JOB_IDS.has(jobId)) fail(`任职岗位非法：${jobId}`);
  }
  if (employment.hiredAtMinute !== null && employment.hiredAtMinute !== undefined) {
    const hiredAt = assertNonNegativeInt(employment.hiredAtMinute, '入职时间');
    if (hiredAt > totalMinute) fail('入职时间晚于当前游戏时间');
  }
  const accruedWages = assertNonNegativeInt(employment.accruedWages, '未发工资');
  const remainder = assertNonNegativeInt(employment.accrualRemainder, '工资余数');
  // v14 起余数单位为 1/6000 分；旧档由迁移精确换算，越界说明累计逻辑已被破坏
  if (remainder >= WAGE_ACCRUAL_DENOMINATOR) fail('工资余数越界');
  assertNonNegativeInt(employment.shiftsCompleted, '班次数');
  const workedDays = assertObject(employment.workedMinutesByDay, '工时记录');
  for (const [dayKey, value] of Object.entries(workedDays)) {
    assertString(dayKey, '工时记录日期');
    const minutes = assertNonNegativeInt(value, `工时记录 ${dayKey}`);
    if (minutes > CALENDAR.minutesPerDay) fail(`工时记录 ${dayKey} 超过一天`);
  }
  const accruedMonths = assertObject(employment.accruedByMonth, '月度应计');
  let accruedMonthSum = 0;
  for (const [monthKey, value] of Object.entries(accruedMonths)) {
    assertString(monthKey, '月度应计月份');
    const amount = assertNonNegativeInt(value, `月度应计 ${monthKey}`);
    accruedMonthSum += amount;
  }
  if (accruedMonthSum > accruedWages) fail('月度应计工资超过未发工资总额');

  const survival = assertObject(state.survival, 'state.survival');
  for (const key of ['hungerUnits', 'waterUnits'] as const) {
    const units = assertNonNegativeInt(survival[key], `生存值 ${key}`);
    if (units > SURVIVAL.fullUnits) fail(`生存值 ${key} 越界`);
  }

  validateFurniture(state);

  const inventory = assertObject(state.inventory, 'state.inventory');
  const operationEpoch = assertString(inventory.operationEpoch, 'state.inventory.operationEpoch');
  if (operationEpoch.length === 0 || operationEpoch.includes(':')) {
    fail('补给操作命名空间格式非法');
  }
  const nextOperationSeq = assertNonNegativeInt(
    inventory.nextOperationSeq,
    'state.inventory.nextOperationSeq',
  );
  if (nextOperationSeq < 1) fail('补给下一个操作序号必须从 1 开始');
  const items = assertObject(inventory.items, 'state.inventory.items');
  for (const [itemId, value] of Object.entries(items)) {
    if (!ITEM_IDS.has(itemId)) fail(`背包物品标识非法：${itemId}`);
    const quantity = assertNonNegativeInt(value, `背包物品 ${itemId} 数量`);
    if (quantity <= 0) fail(`背包物品 ${itemId} 数量必须大于 0（为 0 应删除条目）`);
  }
  const requests = inventory.requests;
  if (!Array.isArray(requests)) fail('背包请求记录非法');
  if (requests.length > MAX_REQUEST_RECORDS) fail('背包请求记录过多');
  const requestIds = new Set<string>();
  let lastNewSequence = 0;
  let newReceiptCount = 0;
  for (const [index, item] of requests.entries()) {
    const record = assertObject(item, `第 ${index + 1} 条背包请求`);
    const protocolVersion = assertNonNegativeInt(
      record.protocolVersion,
      `第 ${index + 1} 条背包请求协议版本`,
    );
    const requestId = assertString(record.requestId, `第 ${index + 1} 条背包请求标识`);
    if (requestId.length === 0) fail(`第 ${index + 1} 条背包请求标识为空`);
    if (requestIds.has(requestId)) fail(`背包请求标识重复：${requestId}`);
    requestIds.add(requestId);
    if (record.kind !== 'purchase' && record.kind !== 'use') {
      fail(`第 ${index + 1} 条背包请求类型非法`);
    }
    const kind = record.kind;
    const itemId = assertString(record.itemId, `第 ${index + 1} 条背包请求物品`);
    if (!ITEM_IDS.has(itemId)) fail(`第 ${index + 1} 条背包请求物品非法：${itemId}`);
    const quantity = assertNonNegativeInt(record.quantity, `第 ${index + 1} 条背包请求数量`);
    if (quantity <= 0) fail(`第 ${index + 1} 条背包请求数量必须大于 0`);
    const atMinute = assertNonNegativeInt(record.atMinute, `第 ${index + 1} 条背包请求时间`);
    if (atMinute > totalMinute) fail(`第 ${index + 1} 条背包请求时间晚于当前时间`);

    if (protocolVersion === SUPPLY_PROTOCOL_VERSION) {
      const sequence = assertNonNegativeInt(
        record.sequence,
        `第 ${index + 1} 条背包请求序号`,
      );
      if (sequence < 1) fail(`第 ${index + 1} 条背包请求序号必须为正整数`);
      if (sequence >= nextOperationSeq) {
        fail(`第 ${index + 1} 条背包请求序号必须小于下一个可执行序号`);
      }
      if (newReceiptCount > 0 && sequence <= lastNewSequence) {
        fail('新协议背包请求收据序号必须严格递增');
      }
      lastNewSequence = sequence;
      newReceiptCount += 1;
      if (requestId !== formatSupplyRequestId(operationEpoch, sequence)) {
        fail(`第 ${index + 1} 条背包请求标识与命名空间/序号不一致`);
      }
      if (kind === 'use') {
        if (record.shopId !== null) fail(`第 ${index + 1} 条使用请求的商店必须为 null`);
        if (quantity !== 1) fail(`第 ${index + 1} 条使用请求数量必须为 1`);
      } else {
        const shopId = record.shopId;
        if (typeof shopId !== 'string' || shopId.length === 0) {
          fail(`第 ${index + 1} 条购买请求缺少合法商店标识`);
        }
      }
    } else if (protocolVersion === LEGACY_PROTOCOL_VERSION) {
      if (record.sequence !== null) fail(`第 ${index + 1} 条 legacy 请求序号必须为 null`);
      if (record.shopId !== null) fail(`第 ${index + 1} 条 legacy 请求商店必须为 null`);
    } else {
      fail(`第 ${index + 1} 条背包请求协议版本非法`);
    }
  }
  // 高水位与最近成功收据一致：只要执行过新协议操作，最后一条新收据就必须是 next-1。
  if (nextOperationSeq > 1) {
    if (newReceiptCount === 0 || lastNewSequence !== nextOperationSeq - 1) {
      fail('补给请求高水位与保留收据不一致');
    }
  }

  const living = assertObject(state.living, 'state.living');
  assertNonNegativeInt(living.debt, '生活欠款');
  if (!Array.isArray(living.debtRecords)) fail('欠款记录非法');

  const settlement = assertObject(state.settlement, 'state.settlement');
  if (!Array.isArray(settlement.settledMonths)) fail('已结算月份非法');
  for (const month of settlement.settledMonths) {
    assertString(month, '已结算月份');
  }
  if (settlement.lastSettledMonth !== null) {
    assertString(settlement.lastSettledMonth, '最近结算月份');
  }

  if (!Array.isArray(state.reports)) fail('月报数据非法');

  const settings = assertObject(state.settings, 'state.settings');
  if (typeof settings.speed !== 'number' || settings.speed <= 0) fail('设置数据非法');

  validateSubjectAccounts(finance);

  const loan = assertObject(state.loan, 'state.loan');
  if (loan.contract !== null && loan.contract !== undefined) {
    const contract = assertObject(loan.contract, 'state.loan.contract');
    const principal = assertNonNegativeInt(contract.principal, '贷款本金');
    const outstanding = assertNonNegativeInt(contract.outstanding, '未偿本金');
    const accruedInterest = assertNonNegativeInt(contract.accruedInterest, '已计提利息');
    const numerator = assertNonNegativeInt(contract.interestNumerator, '利息计算余量');
    const paidInterest = assertNonNegativeInt(contract.totalInterestPaid, '已付利息');
    const paidPrincipal = assertNonNegativeInt(contract.totalPrincipalPaid, '已付本金');
    const startMinute = assertNonNegativeInt(contract.startMinute, '贷款起始时间');
    const dueMinute = assertNonNegativeInt(contract.dueMinute, '贷款到期时间');
    const status = assertString(contract.status, '贷款状态');

    if (status !== 'active' && status !== 'overdue' && status !== 'settled') {
      fail('贷款状态非法');
    }
    if (principal < 1) fail('贷款本金必须大于 0');
    if (outstanding > principal) fail('未偿本金不能超过原始本金');
    // 本金守恒：已还本金 + 未偿本金 必须等于原始本金
    if (paidPrincipal + outstanding !== principal) fail('贷款本金账目不平');
    if (paidInterest > principal * 100) fail('已付利息异常');
    // 计息余量必须小于一个计息单位，否则说明累计逻辑被破坏
    if (numerator >= interestDenominatorOf()) fail('利息计算余量越界');
    if (dueMinute < startMinute) fail('贷款到期时间早于起始时间');
    if (status === 'settled') {
      if (outstanding !== 0 || accruedInterest !== 0) fail('已结清贷款仍存在未偿本息');
    } else if (outstanding === 0 && accruedInterest === 0) {
      fail('未结清贷款没有余额');
    }
    // 逾期只可能是已过到期时间
    if (status === 'overdue' && totalMinute < dueMinute) {
      fail('逾期状态与到期时间矛盾');
    }
  }

  // ------------------------------------------------ 人口 / 企业 / 科技 / 人才 / AI / 资本
  validatePopulation(state);
  const population = assertObject(state.population, 'state.population');
  validatePopulationDynamics(population, totalMinute);
  validatePolitics(state);
  validateElections(state, totalMinute);
  validateGovernment(state, totalMinute);
  const enterpriseIds = validateEnterprises(state, totalMinute);
  validateBusinessAccounts(finance, enterpriseIds);
  validateTechnology(state, enterpriseIds, totalMinute);
  validateTalent(state, enterpriseIds);
  validateBusinessAi(state, enterpriseIds);
  const books = validateEquity(state, enterpriseIds);
  validateSecurities(state, { books }, totalMinute);
  validateFinancing(state, enterpriseIds);
  validateGovernance(state, enterpriseIds);
  validatePromotion(state, enterpriseIds);

  // 城市统计 / 逻辑地图 / 建设阶段（v16）。三者互相引用：布局先校验并返回，
  // 统计只做自身一致性，建设阶段再核对门槛公式、阶段预留与建筑企业引用。
  const layout = validateCityLayout(state, enterpriseIds);
  validateCityStatistics(state, totalMinute);
  validateCityDevelopment(state, layout);
  validateRealEstate(state, finance, totalMinute);
  validateHousing(state, finance, totalMinute);
  validateEnvironment(state, totalMinute);

  const world = assertObject(state.world, 'state.world');
  const player = assertObject(world.player, 'state.world.player');
  if (typeof player.x !== 'number' || typeof player.z !== 'number') fail('玩家位置非法');
  if (typeof player.facing !== 'number') fail('玩家朝向非法');
  if (world.camera !== undefined) {
    const camera = assertObject(world.camera, 'state.world.camera');
    for (const key of ['yaw', 'pitch', 'distance'] as const) {
      if (typeof camera[key] !== 'number' || !Number.isFinite(camera[key])) {
        fail('摄像机状态非法');
      }
    }
  }
  assertNonNegativeInt(world.revision, '世界状态版本');

  return state;
}
