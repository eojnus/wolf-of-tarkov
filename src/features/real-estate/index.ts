/**
 * 房地产 —— 产权、居住状态、挂牌、AI 土地报价与成交记录。
 *
 * 职责边界（见 docs/architecture.md 第 14 节）：
 *  - 只保存「谁拥有哪一处房产/土地、是否可售、成交了什么」，不保存任何余额；
 *  - 不读写 finance / population / politics / cityStatistics：跨模块一律由 app 层编排；
 *  - 不计算月度需求与匹配（那是 `features/housing`），不创建 Three.js 对象。
 *
 * 三个维度严格分开：
 *  - 产权（`owner`）—— 谁拥有这套房子/这块地；
 *  - 入住（`occupancy`）—— 谁实际住在这里（含玩家永久居住权）；
 *  - 保护期（`protectionUntilMinute`）—— 未售新住宅在到期前禁止居民与 AI 买入。
 * 产权变更不会自动改变玩家的居住地点。
 */

import type { DeepReadonly } from '../../core/readonly';
import {
  BASE_HOUSING_BUILDING_ID,
  BASE_HOUSING_NAME,
  BASE_HOUSING_PLAN,
  DISTRICT_HOUSING_EXCLUDED_SUFFIXES,
  DISTRICT_HOUSING_PLANS,
  HOME_LAYOUTS,
  PROPERTY_OWNER_IDS,
  REAL_ESTATE_RULES,
  RESERVE_LAND_PARCELS,
  homeLayoutOf,
  initialAskingPriceCents,
  type HomeLayoutId,
} from '../../content/real-estate';
import { CALENDAR, TIME } from '../../content/config';
import { BusinessError } from '../../core/errors';
import { monthStartMinute } from '../../core/calendar';

/** 产权主体：玩家、宏观居民群组、机构（开发/储备/AI 投资者）。 */
export type PropertyOwnerKind = 'player' | 'household' | 'investor';

export interface PropertyOwner {
  readonly kind: PropertyOwnerKind;
  /** 玩家为 `player`；居民为群组 id；机构为 finance 里的 investor 账户 id。 */
  readonly id: string;
}

export const PLAYER_OWNER: PropertyOwner = { kind: 'player', id: 'player' };

export function householdOwner(groupId: string): PropertyOwner {
  return { kind: 'household', id: groupId };
}

export function investorOwner(investorId: string): PropertyOwner {
  return { kind: 'investor', id: investorId };
}

export function sameOwner(
  left: PropertyOwner | DeepReadonly<PropertyOwner>,
  right: PropertyOwner | DeepReadonly<PropertyOwner>,
): boolean {
  return left.kind === right.kind && left.id === right.id;
}

export type PropertyKind = 'home' | 'land';

/** 住宅入住状态。租住在首版只是宏观背景统计，不产生可追踪的租赁合同。 */
export type HomeOccupancy = 'free-residence' | 'owner-occupied' | 'vacant';

export interface PropertyListing {
  /** 挂牌价（分）。 */
  priceCents: number;
  listedAtMinute: number;
  /** 每次挂牌/改价 +1；命令必须带期望版本，不一致即明确拒绝。 */
  version: number;
}

export interface LandOffer {
  readonly id: string;
  readonly propertyId: string;
  /** 出价主体：真实 investor 账户 id，资金按本单据预留。 */
  readonly investorId: string;
  readonly priceCents: number;
  readonly createdAtMinute: number;
  readonly expiresAtMinute: number;
}

export type TradeChannel = 'player' | 'market' | 'offer';

export interface PropertyTrade {
  readonly id: string;
  readonly propertyId: string;
  readonly kind: PropertyKind;
  readonly priceCents: number;
  /** 成交时的参考估值，用于说明「成交价与估值是两件事」。 */
  readonly valuationCents: number;
  readonly buyer: PropertyOwner;
  readonly seller: PropertyOwner;
  readonly atMinute: number;
  readonly monthKey: string;
  readonly operationId: string;
  /** 卖方是玩家时的已实现价差（成交价 − 成本基础）；其他主体为 null。 */
  readonly realizedCents: number | null;
  readonly channel: TradeChannel;
}

export interface PropertyRecord {
  readonly id: string;
  readonly kind: PropertyKind;
  readonly name: string;
  readonly districtId: string;
  /** 住宅：布局建筑 id（如 `home` / `district-housing-0-block-a`）；土地为 null。 */
  readonly buildingId: string | null;
  /** 土地：储备地块 id；住宅为 null。 */
  readonly parcelId: string | null;
  readonly areaSqm: number;
  /** 住宅户型；土地为 null。 */
  readonly layoutId: HomeLayoutId | null;
  readonly deliveredAtMinute: number;
  /**
   * 居民/AI 的禁购期满时刻（未售新住宅才有意义）。
   * 一旦首次成交（`firstSoldAtMinute` 非空），保护期不再生效。
   */
  readonly protectionUntilMinute: number | null;
  owner: PropertyOwner;
  /** 住宅入住状态；土地为 null。 */
  occupancy: HomeOccupancy | null;
  /** 玩家永久居住权的唯一标记（只有一处房产为 `player`）。 */
  freeResidenceFor: 'player' | null;
  /** 参考估值（分），由月度模型更新；与挂牌价、成交价独立。 */
  valuationCents: number;
  /** 当前产权人的取得成本（分）：玩家卖出时用于计算已实现价差。 */
  costBasisCents: number;
  acquiredAtMinute: number;
  /** 首次成交时刻；为 null 表示仍是未售新房（保护期适用）。 */
  firstSoldAtMinute: number | null;
  listing: PropertyListing | null;
  /** 挂牌序号持久化；撤销或转让后也不回退。 */
  listingVersion: number;
  /** 城市储备土地对玩家的出让价（仅城市持有且可售时非空）。 */
  askPriceCents: number | null;
}

export interface RealEstateState {
  properties: PropertyRecord[];
  /** 仍然有效的 AI 土地收购报价（过期即释放预留并移除）。 */
  offers: LandOffer[];
  /** 成交记录（按时间正序，最多 `tradeHistoryLimit` 条）。 */
  trades: PropertyTrade[];
  nextPropertySeq: number;
  nextTradeSeq: number;
  nextOfferSeq: number;
  /** 玩家房地产已实现价差合计（分，可为负）与成交笔数。 */
  realizedCents: number;
  realizedTrades: number;
  /** 最近一次完成月度住房市场的月份（幂等标记）。 */
  lastMarketMonthKey: string | null;
}

export function createRealEstateState(): RealEstateState {
  return {
    properties: [],
    offers: [],
    trades: [],
    nextPropertySeq: 1,
    nextTradeSeq: 1,
    nextOfferSeq: 1,
    realizedCents: 0,
    realizedTrades: 0,
    lastMarketMonthKey: null,
  };
}

/* ------------------------------------------------------------ 只读查询 */

/**
 * 按 id 查房产（只读口径）。
 *
 * 可写草稿请用 `mutablePropertyById`：只读与可写分开，避免把只读快照当成可写状态。
 */
export function propertyById(
  state: RealEstateState | DeepReadonly<RealEstateState>,
  id: string,
): PropertyRecord | DeepReadonly<PropertyRecord> | null {
  const source: readonly (PropertyRecord | DeepReadonly<PropertyRecord>)[] = state.properties;
  for (const property of source) {
    if (property.id === id) return property;
  }
  return null;
}

/** 按 id 查房产（草稿/初始化/迁移专用）。 */
export function mutablePropertyById(state: RealEstateState, id: string): PropertyRecord | null {
  for (const property of state.properties) {
    if (property.id === id) return property;
  }
  return null;
}

export function propertiesOf(
  state: RealEstateState | DeepReadonly<RealEstateState>,
  owner: PropertyOwner,
): readonly (PropertyRecord | DeepReadonly<PropertyRecord>)[] {
  const rows: (PropertyRecord | DeepReadonly<PropertyRecord>)[] = [];
  const source: readonly (PropertyRecord | DeepReadonly<PropertyRecord>)[] = state.properties;
  for (const property of source) {
    if (sameOwner(property.owner, owner)) rows.push(property);
  }
  return rows;
}

/** 玩家持有的全部房产与土地（不计入永久居住权，它不属于玩家产权）。 */
export function playerPropertiesOf(
  state: RealEstateState | DeepReadonly<RealEstateState>,
): readonly (PropertyRecord | DeepReadonly<PropertyRecord>)[] {
  return propertiesOf(state, PLAYER_OWNER);
}

/** 玩家持有的物业估值合计（分）：净资产只在这里计一次。 */
export function playerPropertyValueOf(
  state: RealEstateState | DeepReadonly<RealEstateState>,
): number {
  let total = 0;
  for (const property of playerPropertiesOf(state)) total += property.valuationCents;
  return total;
}

/** 玩家的永久住所（唯一）。没有时返回 null（例如数据损坏，由校验拒绝）。 */
export function freeResidenceOf(
  state: RealEstateState | DeepReadonly<RealEstateState>,
): PropertyRecord | DeepReadonly<PropertyRecord> | null {
  const source: readonly (PropertyRecord | DeepReadonly<PropertyRecord>)[] = state.properties;
  for (const property of source) {
    if (property.freeResidenceFor === 'player') return property;
  }
  return null;
}

/** 保护期是否仍在生效：未售新房且当前时刻早于保护期结束。 */
export function protectionActive(
  property: PropertyRecord | DeepReadonly<PropertyRecord>,
  nowMinute: number,
): boolean {
  if (property.firstSoldAtMinute !== null) return false;
  if (property.protectionUntilMinute === null) return false;
  return nowMinute < property.protectionUntilMinute;
}

/** 保护期剩余天数（向上取整），已结束返回 0。 */
export function protectionDaysLeft(
  property: PropertyRecord | DeepReadonly<PropertyRecord>,
  nowMinute: number,
): number {
  if (!protectionActive(property, nowMinute) || property.protectionUntilMinute === null) return 0;
  return Math.ceil(
    (property.protectionUntilMinute - nowMinute) / TIME.calendar.minutesPerDay,
  );
}

/**
 * 新住宅保护期的统一口径。
 *
 * - 开局存量从「开局第 protectionMonths 个月月初」起算（绝对值，旧档不会因为迁移重新获得保护期）；
 * - 新交付住宅从交付时刻起算 `protectionMonths × 30` 游戏日。
 */
export function protectionDeadlineFor(
  deliveredAtMinute: number,
  fromGameStart: boolean,
): number {
  const months = REAL_ESTATE_RULES.protectionMonths;
  if (fromGameStart) return monthStartMinute(months, TIME.calendar);
  return deliveredAtMinute + months * CALENDAR.daysPerMonth * CALENDAR.minutesPerDay;
}

/* ------------------------------------------------------------ 估值口径 */

/** 住宅参考估值：单价 × 面积 × 地段系数 × 供需系数（有界）。 */
export function homeValuationCents(
  layoutId: string,
  areaSqm: number,
  districtFactor: number,
  marketFactor: number,
): number {
  const layout = homeLayoutOf(layoutId);
  const perSqm = layout?.pricePerSqmCents ?? HOME_LAYOUTS[0]!.pricePerSqmCents;
  const factor = clampFactor(districtFactor * marketFactor);
  return Math.max(1, Math.round(perSqm * areaSqm * factor));
}

function clampFactor(value: number): number {
  const { min, max } = REAL_ESTATE_RULES.homeValuationFactor;
  if (!Number.isFinite(value)) return 1;
  return Math.min(max, Math.max(min, value));
}

/** 土地参考估值：基准单价 × 面积 × 系数（地段/规划/GDP/周边建设，全部由应用层传入）。 */
export function landValuationCents(areaSqm: number, factor: number): number {
  const safe = Number.isFinite(factor) ? Math.min(1.6, Math.max(0.7, factor)) : 1;
  return Math.max(1, Math.round(REAL_ESTATE_RULES.landPricePerSqmCents * areaSqm * safe));
}

/** 挂牌价合法区间：不低于下限、不高于参考估值的上限倍数。 */
export function assertListingPrice(property: PropertyRecord, priceCents: number): void {
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) {
    throw new BusinessError('INVALID_PRICE', '挂牌价必须是正整数（分）');
  }
  if (priceCents < REAL_ESTATE_RULES.minListingPriceCents) {
    throw new BusinessError(
      'PRICE_TOO_LOW',
      `挂牌价不能低于 ${REAL_ESTATE_RULES.minListingPriceCents / 100} 元`,
    );
  }
  const ceiling = Math.round(property.valuationCents * REAL_ESTATE_RULES.maxListingMultiple);
  if (priceCents > ceiling) {
    throw new BusinessError('PRICE_TOO_HIGH', '挂牌价超过参考估值允许的上限，请重新定价');
  }
}

/* ------------------------------------------------------------ 状态构造 */

/** 把单元计划展开成「户型序列」，顺序稳定。 */
function expandPlan(plan: readonly { layoutId: HomeLayoutId; count: number }[]): HomeLayoutId[] {
  const rows: HomeLayoutId[] = [];
  for (const entry of plan) {
    for (let index = 0; index < entry.count; index += 1) rows.push(entry.layoutId);
  }
  return rows;
}

/**
 * 建立晴川公寓的 100 套存量：第 1 套为玩家永久居住权（非玩家产权），其余 99 套归晴川置业。
 *
 * 幂等：同一建筑已有住宅单元时直接返回（读档、迁移重复调用都不会重复发房）。
 * 只写本切片，不接触资金（资金由 app / 迁移显式处理）。
 */
export function seedBaseHousingStock(
  state: RealEstateState,
  nowMinute: number,
  baseValuationFactor: number,
): void {
  const exists = state.properties.some(
    (property) => property.kind === 'home' && property.buildingId === BASE_HOUSING_BUILDING_ID,
  );
  if (exists) return;
  const layouts = expandPlan(BASE_HOUSING_PLAN);
  const protectionUntil = protectionDeadlineFor(nowMinute, true);
  layouts.forEach((layoutId, index) => {
    const layout = homeLayoutOf(layoutId);
    if (!layout) throw new BusinessError('INVALID_LAYOUT', `未知户型：${layoutId}`);
    const isFree = index === 0;
    const valuation = homeValuationCents(layoutId, layout.areaSqm, baseValuationFactor, 1);
    state.properties.push({
      id: `home-${String(index + 1).padStart(3, '0')}`,
      kind: 'home',
      name: `${BASE_HOUSING_NAME} ${String(index + 1).padStart(3, '0')} 室`,
      districtId: 'district-base',
      buildingId: BASE_HOUSING_BUILDING_ID,
      parcelId: null,
      areaSqm: layout.areaSqm,
      layoutId,
      deliveredAtMinute: nowMinute,
      protectionUntilMinute: isFree ? null : protectionUntil,
      owner: isFree
        ? investorOwner(PROPERTY_OWNER_IDS.landReserve)
        : investorOwner(PROPERTY_OWNER_IDS.developer),
      occupancy: isFree ? 'free-residence' : 'vacant',
      freeResidenceFor: isFree ? 'player' : null,
      valuationCents: valuation,
      costBasisCents: 0,
      acquiredAtMinute: nowMinute,
      firstSoldAtMinute: isFree ? nowMinute : null,
      listing: null,
      listingVersion: 0,
      askPriceCents: null,
    });
  });
}

/** 建立 4 块城市储备土地（归城市土地储备中心，按估值 × 溢价出让给玩家）。 */
export function seedReserveLandStock(state: RealEstateState, nowMinute: number): void {
  for (const parcel of RESERVE_LAND_PARCELS) {
    if (state.properties.some((property) => property.id === parcel.id)) continue;
    const valuation = landValuationCents(parcel.areaSqm, 1);
    state.properties.push({
      id: parcel.id,
      kind: 'land',
      name: parcel.name,
      districtId: parcel.districtId,
      buildingId: null,
      parcelId: parcel.id,
      areaSqm: parcel.areaSqm,
      layoutId: null,
      deliveredAtMinute: nowMinute,
      protectionUntilMinute: null,
      owner: investorOwner(PROPERTY_OWNER_IDS.landReserve),
      occupancy: null,
      freeResidenceFor: null,
      valuationCents: valuation,
      costBasisCents: 0,
      acquiredAtMinute: nowMinute,
      firstSoldAtMinute: null,
      listing: null,
      listingVersion: 0,
      askPriceCents: Math.round(valuation * REAL_ESTATE_RULES.landAskPremium),
    });
  }
}

/**
 * 交付一片新住宅（城区建设完成后由 app 层调用一次）。
 *
 * 幂等：该建筑已有单元时跳过。保护期从交付时刻起算。
 * 返回实际新增的套数（0 表示已交付过）。
 */
export function deliverHousingUnits(
  state: RealEstateState,
  input: {
    districtId: string;
    buildingId: string;
    buildingName: string;
    buildingSuffix: string;
    deliveredAtMinute: number;
    districtFactor: number;
  },
): number {
  if (DISTRICT_HOUSING_EXCLUDED_SUFFIXES.includes(input.buildingSuffix)) return 0;
  const plan = DISTRICT_HOUSING_PLANS[input.buildingSuffix];
  if (!plan) return 0;
  const exists = state.properties.some(
    (property) => property.kind === 'home' && property.buildingId === input.buildingId,
  );
  if (exists) return 0;

  const layouts = expandPlan(plan);
  const protectionUntil = protectionDeadlineFor(input.deliveredAtMinute, false);
  let created = 0;
  layouts.forEach((layoutId, index) => {
    const layout = homeLayoutOf(layoutId);
    if (!layout) throw new BusinessError('INVALID_LAYOUT', `未知户型：${layoutId}`);
    const valuation = homeValuationCents(
      layoutId,
      layout.areaSqm,
      input.districtFactor,
      1,
    );
    state.properties.push({
      id: `${input.buildingId}-u${String(index + 1).padStart(2, '0')}`,
      kind: 'home',
      name: `${input.buildingName} ${String(index + 1).padStart(2, '0')} 室`,
      districtId: input.districtId,
      buildingId: input.buildingId,
      parcelId: null,
      areaSqm: layout.areaSqm,
      layoutId,
      deliveredAtMinute: input.deliveredAtMinute,
      protectionUntilMinute: protectionUntil,
      owner: investorOwner(PROPERTY_OWNER_IDS.developer),
      occupancy: 'vacant',
      freeResidenceFor: null,
      valuationCents: valuation,
      costBasisCents: 0,
      acquiredAtMinute: input.deliveredAtMinute,
      firstSoldAtMinute: null,
      listing: null,
      listingVersion: 0,
      askPriceCents: null,
    });
    created += 1;
  });
  return created;
}

/* ------------------------------------------------------------ 成交写入 */

export interface TransferInput {
  readonly propertyId: string;
  readonly buyer: PropertyOwner;
  readonly priceCents: number;
  readonly atMinute: number;
  readonly monthKey: string;
  readonly operationId: string;
  readonly channel: TradeChannel;
  /** 买下之后是否由买家自住（居民自住；玩家与 AI 持有为空置）。 */
  readonly occupy: boolean;
}

/**
 * 产权转移的唯一写入实现。
 *
 * 前置条件（由调用方在**同一份草稿**里再次校验）：资金已划转、挂牌与报价已处理。
 * 本函数只负责：写产权/入住/成本基础/首售时刻、关闭挂牌、追加成交记录、累计玩家已实现价差。
 * 不写流水、不改余额、不改居民群组（群组居住分配由 app 层按成交类型处理）。
 */
export function applyOwnershipTransfer(
  state: RealEstateState,
  input: TransferInput,
): PropertyTrade {
  const property = state.properties.find((item) => item.id === input.propertyId);
  if (!property) throw new BusinessError('NO_PROPERTY', '找不到该房产或土地');
  if (sameOwner(property.owner, input.buyer)) {
    throw new BusinessError('ALREADY_OWNED', '买方已经拥有该资产');
  }
  const seller = property.owner;
  const realized =
    seller.kind === 'player' ? input.priceCents - property.costBasisCents : null;

  property.owner = input.buyer;
  property.occupancy =
    property.kind === 'land'
      ? null
      : input.buyer.kind === 'household' && input.occupy
        ? 'owner-occupied'
        : 'vacant';
  property.costBasisCents = input.priceCents;
  property.acquiredAtMinute = input.atMinute;
  property.listing = null;
  // 出让价只属于城市土地储备中心的持有状态；产权转移后不再挂旧的出让价
  property.askPriceCents = null;
  if (property.firstSoldAtMinute === null) property.firstSoldAtMinute = input.atMinute;

  const trade: PropertyTrade = {
    id: `trade-${state.nextTradeSeq}`,
    propertyId: property.id,
    kind: property.kind,
    priceCents: input.priceCents,
    valuationCents: property.valuationCents,
    buyer: input.buyer,
    seller,
    atMinute: input.atMinute,
    monthKey: input.monthKey,
    operationId: input.operationId,
    realizedCents: realized,
    channel: input.channel,
  };
  state.nextTradeSeq += 1;
  state.trades.push(trade);
  if (state.trades.length > REAL_ESTATE_RULES.tradeHistoryLimit) {
    state.trades.splice(0, state.trades.length - REAL_ESTATE_RULES.tradeHistoryLimit);
  }
  if (realized !== null) {
    state.realizedCents += realized;
    state.realizedTrades += 1;
  }
  return trade;
}

/** 关闭/更新挂牌（版本号单调递增，避免界面用旧版本覆盖新价格）。 */
export function setListing(
  property: PropertyRecord,
  priceCents: number,
  atMinute: number,
): PropertyListing {
  assertListingPrice(property, priceCents);
  const version = property.listingVersion + 1;
  if (!Number.isSafeInteger(version)) throw new BusinessError('LISTING_VERSION_OVERFLOW', '挂牌版本已超出范围');
  property.listingVersion = version;
  property.listing = { priceCents, listedAtMinute: atMinute, version };
  return property.listing;
}

export function clearListing(property: PropertyRecord): void {
  property.listing = null;
}

/** 首次进入市场的新房按参考估值挂牌（卖方行为，不计入玩家已实现价差）。 */
export function ensureAskingListing(property: PropertyRecord, atMinute: number): void {
  if (property.kind !== 'home') return;
  if (property.occupancy === 'free-residence') return;
  if (property.owner.kind === 'player') return;
  if (property.listing !== null) return;
  if (property.owner.kind === 'household') return;
  setListing(property, initialAskingPriceCents(property.valuationCents), atMinute);
}

/* ------------------------------------------------------------ 报价辅助 */

export function activeOffersFor(
  state: RealEstateState | DeepReadonly<RealEstateState>,
  propertyId: string,
  nowMinute: number,
): (LandOffer | DeepReadonly<LandOffer>)[] {
  const source: readonly (LandOffer | DeepReadonly<LandOffer>)[] = state.offers;
  const rows: (LandOffer | DeepReadonly<LandOffer>)[] = [];
  for (const offer of source) {
    if (offer.propertyId === propertyId && offer.expiresAtMinute > nowMinute) rows.push(offer);
  }
  return rows;
}

export function offerById(
  state: RealEstateState | DeepReadonly<RealEstateState>,
  offerId: string,
): LandOffer | DeepReadonly<LandOffer> | null {
  const source: readonly (LandOffer | DeepReadonly<LandOffer>)[] = state.offers;
  for (const offer of source) {
    if (offer.id === offerId) return offer;
  }
  return null;
}
