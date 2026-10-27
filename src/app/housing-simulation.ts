/**
 * 宏观住房月度编排 —— 收入/消费入账、需求累积、供需匹配成交、AI 投资与指标固化。
 *
 * 只在 `app/timeAdvance` 的唯一月界路径里被调用（人口月结之后、政治满意度之前）：
 *   1. 同步家庭数（人口是唯一权威）；
 *   2. 群组收入入账与消费支出（真实资金，稳定月度单据，重复推进不重复入账）；
 *   3. 刷新估值（住宅供需与土地规划因子，全部有界、确定性）；
 *   4. 累积购房意愿；
 *   5. 匹配成交（居民轮换起点 + 单价升序 + 资金与保护期每次重新校验）；
 *   6. AI 机构买入挂牌住宅；
 *   7. 土地报价生成；
 *   8. 月度指标固化（供政治满意度读取）。
 *
 * 成交只通过 `app/real-estate.executePurchase` 写入：资金、产权、挂牌、记录同一次提交。
 * 预先跳过无法收款或资金不足的资产；意外异常向外传播并回滚整个月结。
 */

import { monthStartMinute } from '../core/calendar';
import { MAX_MONEY_CENTS } from '../core/money';
import { BusinessError } from '../core/errors';
import { TIME } from '../content/config';
import {
  HOUSING_GROUPS,
  HOME_LAYOUTS,
  PROPERTY_ENTITIES,
  REAL_ESTATE_RULES,
  homeLayoutOf,
  type HousingGroupConfig,
  type HousingIncomeTier,
} from '../content/real-estate';
import { availableSubjectBalance, balanceOf, externalAccount, subjectBalance, transferFunds } from '../features/finance';
import {
  accrueMonthlyDemand,
  affordableHouseholds,
  affordabilityRatio,
  consumeDemand,
  createHousingState,
  groupConfig,
  housingPressure,
  markOwnershipGained,
  recordMonth,
  rentedOf,
  syncHouseholds,
  type HousingGroupState,
  type HousingIncomeTriple,
  type HousingMonthMetrics,
  type HousingState,
} from '../features/housing';
import {
  homeValuationCents,
  protectionActive,
  setListing,
  type PropertyRecord,
} from '../features/real-estate';
import { activeTermOf } from '../features/government';
import { POLICY_TO_DEVELOPMENT_DIRECTION } from '../content/city-economy';
import { liveCityEconomyOf } from './city-statistics';
import {
  createLandOffers,
  districtFactorOf,
  ownerAccountRef,
  purchaseHomeByHousehold,
  purchaseHomeByInvestor,
  refreshLandAskPrices,
  refreshSellerListings,
} from './real-estate';
import type { GameState } from './state';

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/* ------------------------------------------------------------ 家庭与资金 */

function groupStateOf(draft: GameState, groupId: string): HousingGroupState | null {
  for (const group of draft.housing.groups) {
    if (group.id === groupId) return group;
  }
  return null;
}

/**
 * 群组储蓄上限：开局储蓄池 × 配置倍数（随家庭数同比缩放）。
 * 超过上限后不再入账 —— 这是宏观模型的边界，不是「居民没有收入」。
 */
function groupCashCeiling(config: HousingGroupConfig, households: number): number {
  const pool = households * config.initialSavingsPerHouseholdCents;
  return Math.round(pool * REAL_ESTATE_RULES.groupCashCeilingMultiple);
}

/**
 * 本月群组收入与消费。
 *
 * - 收入是**明确的宏观外部输入**（配置的户均收入 × 家庭数），不从企业工资重复注入；
 * - 单据 id 含月份与群组，重复调用会被财务模块判重，不会重复累计储蓄；
 * - 消费在收入之后、购房之前扣除，扣不出的部分不形成债务（首版不做居民欠款）。
 */
function settleGroupIncome(
  draft: GameState,
  group: HousingGroupState,
  config: HousingGroupConfig,
  ctx: { monthKey: string; atMinute: number },
): void {
  const balance = subjectBalance(draft.finance, 'household', group.id);
  const income = config.monthlyHouseholdIncomeCents * group.households;
  if (income > 0) {
    const ceiling = groupCashCeiling(config, group.households);
    const headroom = Math.max(0, ceiling - balance);
    const credit = Math.min(income, headroom);
    if (credit > 0) {
      transferFunds(draft.finance, {
        operationId: `housing-income:${ctx.monthKey}:${group.id}`,
        atMinute: ctx.atMinute,
        monthKey: ctx.monthKey,
        from: externalAccount('household-income'),
        to: { owner: 'household', id: group.id },
        amount: credit,
        category: 'housing-income',
        memo: `${ctx.monthKey} ${config.name}收入`,
      });
    }
  }
  const afterIncome = subjectBalance(draft.finance, 'household', group.id);
  const consumption = config.monthlyHouseholdConsumptionCents * group.households;
  const paid = Math.min(afterIncome, consumption);
  if (paid > 0) {
    transferFunds(draft.finance, {
      operationId: `housing-consume:${ctx.monthKey}:${group.id}`,
      atMinute: ctx.atMinute,
      monthKey: ctx.monthKey,
      from: { owner: 'household', id: group.id },
      to: externalAccount('household-consumption'),
      amount: paid,
      category: 'housing-consumption',
      memo: `${ctx.monthKey} ${config.name}生活消费`,
    });
  }
}

/* -------------------------------------------------------------- 估值刷新 */

/**
 * 住宅估值：地段系数 × 供需系数（未满足意愿与空置率），并限制单月相对变化。
 * 估值与挂牌价、成交价互相独立：卖方可以挂高，成交可以低于估值。
 */
function refreshHomeValuations(draft: GameState): void {
  const homes = draft.realEstate.properties.filter((property) => property.kind === 'home');
  if (homes.length === 0) return;
  const vacant = homes.filter((property) => property.occupancy === 'vacant').length;
  const vacancy = vacant / homes.length;
  const maxIntent = draft.housing.groups.reduce((sum, group) => {
    const config = groupConfig(group.id);
    return sum + group.households * config.maxIntentShare;
  }, 0);
  const unmet = draft.housing.groups.reduce(
    (sum, group) => sum + group.wantFirstTime + group.wantUpgrade,
    0,
  );
  const demandIndex = maxIntent > 0 ? clamp(unmet / maxIntent, 0, 1) : 0;
  const factorRules = REAL_ESTATE_RULES.homeMarketFactor;
  const marketFactor = clamp(
    1 + factorRules.demandWeight * demandIndex - factorRules.vacancyPenalty * vacancy,
    REAL_ESTATE_RULES.homeValuationFactor.min,
    REAL_ESTATE_RULES.homeValuationFactor.max,
  );
  const step = REAL_ESTATE_RULES.valuationMonthlyStep;
  for (const property of homes) {
    if (property.freeResidenceFor === 'player') continue;
    const layoutId = property.layoutId;
    if (!layoutId) continue;
    const target = homeValuationCents(
      layoutId,
      property.areaSqm,
      districtFactorOf(property.districtId),
      marketFactor,
    );
    const lower = Math.round(property.valuationCents * (1 - step));
    const upper = Math.round(property.valuationCents * (1 + step));
    property.valuationCents = Math.min(upper, Math.max(lower, target));
  }
}

/**
 * 土地估值因子：已结算 GDP 增长 + 已完成建设阶段 + 已生效的执政方向（不预知选举）。
 *
 * 用 GDP 相对开局基础 GDP 的增长率而不是房价或玩家交易：土地价值跟随城市经济，
 * 并且这一项只影响**参考估值**，不产生任何现金流。
 */
function landValuationFactor(draft: GameState, nowMinute: number): number {
  const rules = REAL_ESTATE_RULES.landValuation;
  const economy = liveCityEconomyOf(draft, nowMinute);
  const base = Math.max(1, economy.baseGdpCents);
  const growth = clamp(economy.gdpCents / base - 1, -0.3, 0.3);
  const indexTerm = rules.indexWeight * growth;
  const stages = Math.min(
    rules.completedStageCap,
    draft.cityDevelopment.completedStages.length,
  );
  const stageTerm = rules.completedStageBonus * stages;
  const term = activeTermOf(draft.government);
  const policy = term?.policy ?? null;
  const direction = policy === null ? null : POLICY_TO_DEVELOPMENT_DIRECTION[policy];
  const directionTerm = direction === null ? 0 : rules.directionBonus[direction];
  return clamp(1 + indexTerm + stageTerm + directionTerm, 0.7, 1.6);
}

/* -------------------------------------------------------------- 供需匹配 */

interface MatchCandidate {
  readonly property: PropertyRecord;
  readonly priceCents: number;
  /** 偏好序号：0 表示该群组的首选户型。 */
  readonly preference: number;
}

/** 可成交的挂牌住宅：有挂牌、未在保护期、不是买方自己持有的。 */
function listedHomes(draft: GameState, nowMinute: number): PropertyRecord[] {
  const rows: PropertyRecord[] = [];
  for (const property of draft.realEstate.properties) {
    if (property.kind !== 'home') continue;
    if (!property.listing) continue;
    if (property.occupancy === 'free-residence') continue;
    if (protectionActive(property, nowMinute)) continue;
    rows.push(property);
  }
  // 确定性排序：单价升序、再按 id，保证同一状态得到同一成交集合
  rows.sort((left, right) => {
    const leftPrice = left.listing?.priceCents ?? 0;
    const rightPrice = right.listing?.priceCents ?? 0;
    if (leftPrice !== rightPrice) return leftPrice - rightPrice;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return rows;
}

function candidatesForGroup(
  config: HousingGroupConfig,
  homes: readonly PropertyRecord[],
  groupId: string,
): MatchCandidate[] {
  const rows: MatchCandidate[] = [];
  for (const property of homes) {
    if (property.owner.kind === 'household' && property.owner.id === groupId) continue;
    const priceCents = property.listing?.priceCents ?? 0;
    if (priceCents <= 0) continue;
    const layoutIndex = property.layoutId
      ? config.preferredLayouts.indexOf(property.layoutId)
      : -1;
    // 不偏好的户型仍然可能被买（价格更低），但排在后面
    const preference = layoutIndex >= 0 ? layoutIndex : config.preferredLayouts.length;
    const districtWeight =
      config.districtWeights[property.districtId] ??
      config.districtWeights.expansion ??
      0;
    if (districtWeight <= 0) continue;
    rows.push({ property, priceCents, preference });
  }
  rows.sort((left, right) => {
    if (left.preference !== right.preference) return left.preference - right.preference;
    if (left.priceCents !== right.priceCents) return left.priceCents - right.priceCents;
    return left.property.id < right.property.id ? -1 : 1;
  });
  return rows;
}

/**
 * 改善置换：家庭买下新房后旧房释放为空置并挂牌。
 *
 * 一个家庭始终只算「一套自住」：旧房不再是自住占用，但产权仍属于该群组，
 * 直到真正卖出才产生资金流入（不提前使用尚未到账的卖房款）。
 */
function releasePreviousHome(
  draft: GameState,
  group: HousingGroupState,
  newPropertyId: string,
  atMinute: number,
): void {
  let oldest: PropertyRecord | null = null;
  for (const property of draft.realEstate.properties) {
    if (property.kind !== 'home') continue;
    if (property.id === newPropertyId) continue;
    if (property.owner.kind !== 'household' || property.owner.id !== group.id) continue;
    if (property.occupancy !== 'owner-occupied') continue;
    if (!oldest || property.acquiredAtMinute < oldest.acquiredAtMinute) oldest = property;
  }
  if (!oldest) return;
  oldest.occupancy = 'vacant';
  setListing(oldest, Math.max(REAL_ESTATE_RULES.minListingPriceCents, oldest.valuationCents), atMinute);
}

/**
 * 居民成交：按「轮换起点 + 群组上限 + 总上限」逐步成交。
 *
 * 每次成交都重新读取群组真实储蓄、需求与当前挂牌价；不设「每月必卖 N 套」，
 * 允许整月没有成交（买不起、无需求、没有合适房源）。
 */
function runHouseholdMatching(
  draft: GameState,
  ctx: { monthKey: string; atMinute: number; monthIndex: number },
): { householdSales: number } {
  let totalSales = 0;
  const homes = listedHomes(draft, ctx.atMinute);
  if (homes.length === 0) return { householdSales: 0 };

  const groups = draft.housing.groups;
  const start = groups.length > 0 ? ctx.monthIndex % groups.length : 0;
  let householdSales = 0;

  for (let offset = 0; offset < groups.length; offset += 1) {
    const group = groups[(start + offset) % groups.length];
    if (!group) continue;
    const config = groupConfig(group.id);
    let soldThisGroup = 0;
    while (
      soldThisGroup < REAL_ESTATE_RULES.monthlyGroupSaleCap &&
      totalSales < REAL_ESTATE_RULES.monthlyTotalSaleCap
    ) {
      const savings = subjectBalance(draft.finance, 'household', group.id);
      const order: Array<'first-time' | 'upgrade'> =
        group.wantFirstTime >= group.wantUpgrade
          ? ['first-time', 'upgrade']
          : ['upgrade', 'first-time'];
      let executed = false;
      for (const kind of order) {
        const want = kind === 'first-time' ? group.wantFirstTime : group.wantUpgrade;
        if (want < 1) continue;
        // 仅有可追踪旧房时才允许置换，不能消费宏观家庭意愿却无房可释放。
        if (kind === 'upgrade' && !draft.realEstate.properties.some((property) =>
          property.kind === 'home' && property.owner.kind === 'household' &&
          property.owner.id === group.id && property.occupancy === 'owner-occupied'
        )) continue;
        const candidates = candidatesForGroup(config, homes, group.id);
        const pick = candidates.find(
          (candidate) =>
            balanceOf(draft.finance, ownerAccountRef(candidate.property.owner)) <= MAX_MONEY_CENTS - candidate.priceCents &&
            affordableHouseholds(group, config, {
              savingsCents: savings,
              priceCents: candidate.priceCents,
              want,
            }) >= 1,
        );
        if (!pick) continue;
        // 异常必须向外传播，让 GameStore.run 回滚整个月结。
        purchaseHomeByHousehold(draft, {
          groupId: group.id,
          propertyId: pick.property.id,
          atMinute: ctx.atMinute,
          monthKey: ctx.monthKey,
          operationId: `housing-sale:${ctx.monthKey}:${pick.property.id}`,
        });
        consumeDemand(group, kind);
        if (kind === 'first-time') markOwnershipGained(group);
        else releasePreviousHome(draft, group, pick.property.id, ctx.atMinute);
        soldThisGroup += 1;
        householdSales += 1;
        totalSales += 1;
        executed = true;
        homes.splice(homes.indexOf(pick.property), 1);
        break;
      }
      if (!executed) break;
    }
  }
  return { householdSales };
}

/** AI 机构买入：每月最多各买一套，价格不超过自身出价上限与单笔上限。 */
function runInvestorPurchases(
  draft: GameState,
  ctx: { monthKey: string; atMinute: number },
): { investorSales: number } {
  let sales = 0;
  const homes = listedHomes(draft, ctx.atMinute);
  for (const entity of PROPERTY_ENTITIES) {
    if (!entity.buysHomes) continue;
    for (const property of homes) {
      const priceCents = property.listing?.priceCents ?? 0;
      if (priceCents <= 0) continue;
      if (priceCents > entity.maxTicketCents) continue;
      if (priceCents > Math.round(property.valuationCents * entity.bidPremium)) continue;
      if (availableSubjectBalance(draft.finance, 'investor', entity.id) < priceCents) continue;
      if (balanceOf(draft.finance, ownerAccountRef(property.owner)) > MAX_MONEY_CENTS - priceCents) continue;
      purchaseHomeByInvestor(draft, {
        investorId: entity.id,
        propertyId: property.id,
        atMinute: ctx.atMinute,
        monthKey: ctx.monthKey,
        operationId: `housing-ai:${ctx.monthKey}:${property.id}`,
      });
      sales += 1;
      break;
    }
  }
  return { investorSales: sales };
}

/* -------------------------------------------------------------- 月度指标 */

function averageOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return Math.round(sum / values.length);
}

function typicalPriceOf(draft: GameState, income: HousingIncomeTier): number {
  const config = HOUSING_GROUPS.find((group) => group.income === income);
  const layoutId = config?.typicalLayoutId ?? HOME_LAYOUTS[0]!.id;
  const rows: number[] = [];
  for (const property of draft.realEstate.properties) {
    if (property.kind !== 'home') continue;
    if (property.layoutId !== layoutId) continue;
    if (property.freeResidenceFor === 'player') continue;
    rows.push(property.valuationCents);
  }
  if (rows.length > 0) return averageOf(rows);
  const layout = homeLayoutOf(layoutId);
  return layout ? layout.pricePerSqmCents * layout.areaSqm : 1;
}

function affordabilityTriple(draft: GameState): HousingIncomeTriple {
  const result: Record<HousingIncomeTier, number> = { low: 0, mid: 0, high: 0 };
  for (const config of HOUSING_GROUPS) {
    result[config.income] = Number(
      affordabilityRatio(config, typicalPriceOf(draft, config.income)).toFixed(3),
    );
  }
  return result;
}

function pressureTriple(draft: GameState): HousingIncomeTriple {
  const result: Record<HousingIncomeTier, number> = { low: 0.5, mid: 0.5, high: 0.5 };
  for (const config of HOUSING_GROUPS) {
    const group = groupStateOf(draft, config.id);
    if (!group) continue;
    const maxIntent = group.households * config.maxIntentShare;
    const unmet = group.wantFirstTime + group.wantUpgrade;
    result[config.income] = housingPressure(config, {
      priceCents: typicalPriceOf(draft, config.income),
      unmetShare: maxIntent > 0 ? unmet / maxIntent : 0,
    });
  }
  return result;
}

/**
 * 对账人口月结的四条实际转层流：按来源人数比例同步资金、居住分配和具体产权。
 * 自然增长不会触发资金划拨；同月各流向均使用转层前快照，避免连续转两次。
 * 家庭和房屋为整数，向下取整，余额按分向下取整，剩余留在来源群组。
 */
function reconcilePopulationFlows(
  draft: GameState,
  ctx: { monthKey: string; atMinute: number },
): void {
  const record = draft.population.records.find((item) => item.monthKey === ctx.monthKey);
  if (!record) return;
  const flows = [
    { from: 'low', to: 'mid', people: record.flow.lm, base: record.classesBefore.low },
    { from: 'mid', to: 'low', people: record.flow.ml, base: record.classesBefore.mid },
    { from: 'mid', to: 'high', people: record.flow.mh, base: record.classesBefore.mid },
    { from: 'high', to: 'mid', people: record.flow.hm, base: record.classesBefore.high },
  ] as const;
  const snapshots = new Map(draft.housing.groups.map((group) => [group.id, {
    balance: subjectBalance(draft.finance, 'household', group.id),
    owned: group.ownedHouseholds,
    first: group.wantFirstTime,
    upgrade: group.wantUpgrade,
    properties: draft.realEstate.properties.filter((property) =>
      property.owner.kind === 'household' && property.owner.id === group.id
    ).sort((left, right) => left.id.localeCompare(right.id)),
  }]));
  const offsets = new Map<string, number>();
  for (const flow of flows) {
    const from = groupStateOf(draft, flow.from);
    const to = groupStateOf(draft, flow.to);
    const snapshot = snapshots.get(flow.from);
    if (!from || !to || !snapshot || flow.base <= 0 || flow.people <= 0) continue;
    const ratio = clamp(flow.people / flow.base, 0, 1);
    const amount = Math.floor(snapshot.balance * ratio);
    if (amount > 0) {
      transferFunds(draft.finance, {
        operationId: `housing-reclassification:${ctx.monthKey}:${flow.from}:${flow.to}`,
        atMinute: ctx.atMinute, monthKey: ctx.monthKey,
        from: { owner: 'household', id: flow.from },
        to: { owner: 'household', id: flow.to },
        amount, category: 'housing-reclassification', memo: '居民阶层变动随家庭转移储蓄',
      });
    }
    const owned = Math.floor(snapshot.owned * ratio);
    const first = snapshot.first * ratio;
    const upgrade = snapshot.upgrade * ratio;
    from.ownedHouseholds -= owned;
    to.ownedHouseholds += owned;
    from.wantFirstTime -= first;
    to.wantFirstTime += first;
    from.wantUpgrade -= upgrade;
    to.wantUpgrade += upgrade;
    const offset = offsets.get(flow.from) ?? 0;
    const count = Math.floor(snapshot.properties.length * ratio);
    for (const property of snapshot.properties.slice(offset, offset + count)) {
      property.owner = { kind: 'household', id: flow.to };
    }
    offsets.set(flow.from, offset + count);
  }
}

/** 家庭数取整为零时，不能让剩余储蓄或住宅永久滞留在空群组。 */
function reconcileEmptyGroups(draft: GameState, ctx: { monthKey: string; atMinute: number }): void {
  const record = draft.population.records.find((item) => item.monthKey === ctx.monthKey);
  for (const source of draft.housing.groups) {
    if (source.households !== 0) continue;
    const balance = subjectBalance(draft.finance, 'household', source.id);
    const properties = draft.realEstate.properties.filter((property) =>
      property.owner.kind === 'household' && property.owner.id === source.id
    );
    if (balance === 0 && properties.length === 0) continue;
    const preferred = source.id === 'low' ? ['mid', 'high'] :
      source.id === 'high' ? ['mid', 'low'] :
      (record && record.flow.mh > record.flow.ml ? ['high', 'low'] : ['low', 'high']);
    const target = preferred.map((id) => groupStateOf(draft, id)).find((group) => group && group.households > 0);
    if (!target) throw new BusinessError('HOUSING_NO_RECIPIENT', '没有可接收空群组资产的家庭，住房月结已回滚');
    if (balance > 0) transferFunds(draft.finance, {
      operationId: `housing-reclassification:${ctx.monthKey}:${source.id}:remainder`,
      atMinute: ctx.atMinute, monthKey: ctx.monthKey,
      from: { owner: 'household', id: source.id }, to: { owner: 'household', id: target.id },
      amount: balance, category: 'housing-reclassification', memo: '空群组剩余家庭资产对账',
    });
    for (const property of properties) {
      property.owner = { kind: 'household', id: target.id };
      if (property.occupancy !== 'owner-occupied') continue;
      if (target.ownedHouseholds < target.households) target.ownedHouseholds += 1;
      else property.occupancy = 'vacant';
    }
  }
}

/* -------------------------------------------------------------- 月结入口 */

/**
 * 住房月结（月界第 4.5 步）。幂等：同一 monthKey 重复调用直接返回已固化指标。
 */
export function settleHousingMonth(
  draft: GameState,
  input: { monthKey: string; monthIndex: number; boundaryMinute: number },
): HousingMonthMetrics {
  const existing = draft.housing.monthly.find((row) => row.monthKey === input.monthKey);
  if (existing) return existing;

  const ctx = { monthKey: input.monthKey, atMinute: input.boundaryMinute };
  reconcilePopulationFlows(draft, ctx);
  syncHouseholds(draft.housing, draft.population.classes);
  reconcileEmptyGroups(draft, ctx);
  for (const group of draft.housing.groups) {
    settleGroupIncome(draft, group, groupConfig(group.id), ctx);
    accrueMonthlyDemand(group);
  }

  refreshHomeValuations(draft);
  refreshLandAskPrices(draft, landValuationFactor(draft, input.boundaryMinute));
  refreshSellerListings(draft, input.boundaryMinute);

  const { householdSales } = runHouseholdMatching(draft, {
    monthKey: input.monthKey,
    atMinute: input.boundaryMinute,
    monthIndex: input.monthIndex,
  });
  const { investorSales } = runInvestorPurchases(draft, ctx);
  createLandOffers(draft, input.boundaryMinute, input.monthIndex);

  const monthTrades = draft.realEstate.trades.filter(
    (trade) => trade.monthKey === input.monthKey,
  );
  const playerSales = monthTrades.filter((trade) => trade.channel === 'player').length;
  const homes = draft.realEstate.properties.filter((property) => property.kind === 'home');
  const vacantUnits = homes.filter((property) => property.occupancy === 'vacant').length;
  const listedUnits = homes.filter((property) => property.listing !== null).length;
  const unmetDemand = Math.round(
    draft.housing.groups.reduce(
      (sum, group) => sum + group.wantFirstTime + group.wantUpgrade,
      0,
    ),
  );
  const monthStart = monthStartMinute(input.monthIndex, TIME.calendar);
  const metrics: HousingMonthMetrics = {
    monthKey: input.monthKey,
    settledAtMinute: input.boundaryMinute,
    marketSales: householdSales + investorSales,
    householdSales,
    investorSales,
    playerSales,
    avgSalePriceCents: averageOf(monthTrades.map((trade) => trade.priceCents)),
    avgValuationCents: averageOf(
      homes.filter((property) => property.freeResidenceFor === null).map((p) => p.valuationCents),
    ),
    vacantUnits,
    listedUnits,
    unmetDemand,
    affordability: affordabilityTriple(draft),
    pressure: pressureTriple(draft),
    complete: draft.housing.observationStartMinute <= monthStart,
  };

  recordMonth(draft.housing, metrics);
  draft.housing.lastSettledMonthKey = input.monthKey;
  draft.realEstate.lastMarketMonthKey = input.monthKey;
  return metrics;
}

/**
 * 新游戏 / 迁移后的住房切片初始化（不含资金，资金由 `seedRealEstateWorld` 处理）。
 */
export function initializeHousing(draft: GameState, nowMinute: number): HousingState {
  return createHousingState(draft.population.classes, nowMinute);
}

/** 供迁移与视图使用：某群组的租住家庭数（派生）。 */
export function rentedHouseholdsOf(group: HousingGroupState): number {
  return rentedOf(group);
}
