/**
 * 房地产编排 —— 播种、付款与产权转移的唯一入口。
 *
 * 所有写操作都必须在同一次 `store.run` 草稿里完成：
 *   资金划转（finance）→ 产权/入住/挂牌/成交记录（realEstate）→ 居民群组统计（housing）。
 * 任一步抛错都整份回滚，不会留下「扣了钱没过户」或「过户两次」的中间状态。
 *
 * 本文件不碰 DOM、不做月度需求计算（那是 app/housing-simulation），也不创建 Three.js 对象。
 */

import { dateAtMinute } from '../core/calendar';
import { BusinessError } from '../core/errors';
import { CALENDAR, TIME } from '../content/config';
import {
  HOUSING_GROUPS,
  HOME_LAYOUTS,
  PROPERTY_ENTITIES,
  PROPERTY_OWNER_IDS,
  REAL_ESTATE_RULES,
  homeLayoutOf,
  propertyEntityOf,
} from '../content/real-estate';
import {
  PERSONAL_SAVINGS,
  openSubjectAccount,
  releaseFunds,
  reserveFunds,
  subjectBalance,
  subjectRef,
  transferFunds,
  transferReservedFunds,
  type AccountRef,
  type TransactionCategory,
} from '../features/finance';
import { householdsOf } from '../features/housing';
import {
  PLAYER_OWNER,
  activeOffersFor,
  applyOwnershipTransfer,
  ensureAskingListing,
  freeResidenceOf,
  investorOwner,
  landValuationCents,
  mutablePropertyById,
  playerPropertiesOf,
  propertyById,
  protectionActive,
  sameOwner,
  seedBaseHousingStock,
  seedReserveLandStock,
  setListing,
  type LandOffer,
  type PropertyOwner,
  type PropertyRecord,
  type PropertyTrade,
  type TradeChannel,
} from '../features/real-estate';
import type { GameState } from './state';

/** 基础城区的地段系数（扩张城区按模板给同一基数，避免无依据的差异）。 */
const BASE_DISTRICT_FACTOR = 1;

/* ------------------------------------------------------------ 账户与标签 */

/** 产权主体 → 真实资金账户。玩家用银行存款，居民用群组主体账户，机构用 investor 账户。 */
export function ownerAccountRef(owner: PropertyOwner): AccountRef {
  if (owner.kind === 'player') return PERSONAL_SAVINGS;
  if (owner.kind === 'household') return subjectRef('household', owner.id);
  return subjectRef('investor', owner.id);
}

export function ownerLabel(owner: PropertyOwner): string {
  if (owner.kind === 'player') return '你';
  if (owner.kind === 'household') {
    return HOUSING_GROUPS.find((group) => group.id === owner.id)?.name ?? owner.id;
  }
  return propertyEntityOf(owner.id)?.name ?? owner.id;
}

function tradeCategory(kind: 'home' | 'land', sellerIsPlayer: boolean): TransactionCategory {
  if (kind === 'home') return sellerIsPlayer ? 'home-sale' : 'home-purchase';
  return sellerIsPlayer ? 'land-sale' : 'land-purchase';
}

/* -------------------------------------------------------------- 世界播种 */

/**
 * 一次性建立房地产世界：产权主体账户、晴川公寓存量、储备土地与卖方挂牌。
 *
 * 幂等：账户存在则跳过开户，存量按建筑/地块 id 判重；读档、迁移重复调用都不会重复注资或发房。
 * 初始资金只分配给真实出售方与 AI（`PROPERTY_ENTITIES`），不使用无余额的 external。
 */
export function seedRealEstateWorld(state: GameState, nowMinute: number): void {
  const now = dateAtMinute(nowMinute, TIME.calendar);
  const ctx = { atMinute: nowMinute, monthKey: now.monthKey };

  for (const entity of PROPERTY_ENTITIES) {
    if (state.finance.subjectAccounts[`investor:${entity.id}`] !== undefined) continue;
    openSubjectAccount(
      state.finance,
      'investor',
      entity.id,
      entity.initialCashCents,
      ctx,
      `${entity.name}初始资金`,
    );
  }

  for (const config of HOUSING_GROUPS) {
    if (state.finance.subjectAccounts[`household:${config.id}`] !== undefined) continue;
    const households = householdsOf(state.population.classes[config.income], config.householdSize);
    const opening = households * config.initialSavingsPerHouseholdCents;
    openSubjectAccount(
      state.finance,
      'household',
      config.id,
      opening,
      ctx,
      `${config.name}初始储蓄（按迁移/开局家庭数 × 每户储蓄）`,
    );
  }

  seedBaseHousingStock(state.realEstate, nowMinute, BASE_DISTRICT_FACTOR);
  seedReserveLandStock(state.realEstate, nowMinute);
  refreshSellerListings(state, nowMinute);
}

/**
 * 卖方挂牌刷新：未售新房的挂牌价跟随参考估值。
 *
 * 只改卖方（非玩家、非居民）的挂牌，不改玩家定价；版本号继续单调递增，
 * 因此界面确认过的旧价格会因版本不一致被明确拒绝，而不是静默换价。
 */
export function refreshSellerListings(state: GameState, atMinute: number): void {
  for (const property of state.realEstate.properties) {
    if (property.owner.kind !== 'investor') continue;
    if (property.kind === 'land') continue;
    ensureAskingListing(property, atMinute);
    const listing = property.listing;
    if (!listing) continue;
    const target = Math.max(
      REAL_ESTATE_RULES.minListingPriceCents,
      Math.round(property.valuationCents * 1.02),
    );
    if (Math.abs(target - listing.priceCents) < Math.max(100, listing.priceCents * 0.01)) continue;
    property.listing = {
      priceCents: target,
      listedAtMinute: atMinute,
      version: listing.version + 1,
    };
  }
}

/**
 * 土地估值与出让价刷新。
 *
 * 估值对所有地块生效（玩家持有的地块也要有参考估值，AI 才可能报价）；
 * 出让价只属于城市土地储备中心持有的地块，玩家持有的地块没有「出让价」。
 */
export function refreshLandAskPrices(state: GameState, factor = 1): void {
  for (const property of state.realEstate.properties) {
    if (property.kind !== 'land') continue;
    const valuation = landValuationCents(property.areaSqm, factor);
    property.valuationCents = valuation;
    // 只有「城市土地储备中心」持有且正在出让的地块才有出让价；
    // 玩家持有、或已被机构收购的地块都不挂出让价（机构不通过这个口子回售）。
    const isCityReserve =
      property.owner.kind === 'investor' && property.owner.id === PROPERTY_OWNER_IDS.landReserve;
    property.askPriceCents = isCityReserve
      ? Math.round(valuation * REAL_ESTATE_RULES.landAskPremium)
      : null;
  }
}

/* ------------------------------------------------------------ 成交核心 */

export interface PurchaseInput {
  readonly propertyId: string;
  readonly buyer: PropertyOwner;
  readonly priceCents: number;
  readonly atMinute: number;
  readonly monthKey: string;
  readonly operationId: string;
  readonly channel: TradeChannel;
  /** 通过 AI 报价成交时传入：只消费该单据的预留。 */
  readonly offerId?: string | null;
  /** 玩家现场购买时传确认过的挂牌版本；不一致明确拒绝。 */
  readonly expectedListingVersion?: number | null;
}

/**
 * 成交的唯一写入实现（付款 + 产权 + 挂牌 + 记录）。
 *
 * 订单级校验全部在这里重做一次：资产存在、买卖双方不同、保护期、价格与版本、
 * 买方资金真实可用。调用方不得跳过这里直接改产权。
 */
export function executePurchase(draft: GameState, input: PurchaseInput): PropertyTrade {
  const property = propertyById(draft.realEstate, input.propertyId);
  if (!property) throw new BusinessError('NO_PROPERTY', '找不到该房产或土地');
  const seller = property.owner;
  if (sameOwner(seller, input.buyer)) {
    throw new BusinessError('ALREADY_OWNED', '你已经是该资产的产权人');
  }
  if (!Number.isSafeInteger(input.priceCents) || input.priceCents <= 0) {
    throw new BusinessError('INVALID_PRICE', '成交价必须是正整数（分）');
  }

  const offerId = input.offerId ?? null;
  if (offerId === null) {
    // 现场/市场成交必须以当前挂牌价成交，不允许静默换价
    if (property.kind === 'home') {
      const listing = property.listing;
      if (!listing) throw new BusinessError('NOT_LISTED', '该房源当前没有挂牌');
      if (listing.priceCents !== input.priceCents) {
        throw new BusinessError('PRICE_CHANGED', '挂牌价已经变化，请刷新后重新确认');
      }
      if (
        input.expectedListingVersion !== undefined &&
        input.expectedListingVersion !== null &&
        listing.version !== input.expectedListingVersion
      ) {
        throw new BusinessError('LISTING_CHANGED', '挂牌信息已被修改，请刷新后重新确认');
      }
    } else {
      if (property.owner.kind === 'player') {
        throw new BusinessError('NOT_LISTED', '该地块没有可成交的报价');
      }
      if (property.askPriceCents !== input.priceCents) {
        throw new BusinessError('PRICE_CHANGED', '土地出让价已经变化，请刷新后重新确认');
      }
    }
  }

  if (input.buyer.kind !== 'player' && protectionActive(property, input.atMinute)) {
    throw new BusinessError('PROTECTED', '该住宅仍在玩家优先保护期内，居民与机构暂不能购买');
  }

  const from = ownerAccountRef(input.buyer);
  const to = ownerAccountRef(seller);
  const category = tradeCategory(property.kind, seller.kind === 'player');
  const ctx = {
    atMinute: input.atMinute,
    monthKey: input.monthKey,
    operationId: input.operationId,
    category,
    memo: `${property.name} · ${ownerLabel(input.buyer)} ← ${ownerLabel(seller)}`,
  };
  if (offerId === null) {
    transferFunds(draft.finance, { ...ctx, from, to, amount: input.priceCents });
  } else {
    transferReservedFunds(draft.finance, {
      ...ctx,
      from,
      to,
      amount: input.priceCents,
      reservationRef: offerId,
    });
  }

  // 该资产的全部有效报价（含本次成交的那份）在这里结束：已消费的预留是空操作，
  // 其余报价各自释放自己的预留，避免同一块地被承诺两次、也避免留下失效报价。
  releaseOffersFor(draft, property.id, null);

  return applyOwnershipTransfer(draft.realEstate, {
    propertyId: property.id,
    buyer: input.buyer,
    priceCents: input.priceCents,
    atMinute: input.atMinute,
    monthKey: input.monthKey,
    operationId: input.operationId,
    channel: input.channel,
    occupy: input.buyer.kind === 'household',
  });
}

/** 释放某房产上除 `keepOfferId` 之外的全部报价（含预留）。 */
export function releaseOffersFor(draft: GameState, propertyId: string, keepOfferId: string | null): void {
  const keep = keepOfferId;
  const remaining: LandOffer[] = [];
  for (const offer of draft.realEstate.offers) {
    if (offer.propertyId !== propertyId) {
      remaining.push(offer);
      continue;
    }
    if (keep !== null && offer.id === keep) {
      remaining.push(offer);
      continue;
    }
    releaseFunds(draft.finance, 'investor', offer.investorId, offer.priceCents, offer.id);
  }
  draft.realEstate.offers = remaining;
}

/* ------------------------------------------------------------ 玩家命令 */

export interface PlayerBuyInput {
  readonly propertyId: string;
  readonly expectedPriceCents: number;
  readonly expectedListingVersion: number | null;
  readonly atMinute: number;
  readonly monthKey: string;
  readonly operationId: string;
}

/** 玩家现场买入住宅：用个人银行存款，一次性付清，不产生按揭。 */
export function buyHomeByPlayer(draft: GameState, input: PlayerBuyInput): PropertyTrade {
  const property = propertyById(draft.realEstate, input.propertyId);
  if (!property) throw new BusinessError('NO_PROPERTY', '找不到该房源');
  if (property.kind !== 'home') throw new BusinessError('NOT_A_HOME', '该资产不是住宅');
  if (property.owner.kind === 'player') throw new BusinessError('ALREADY_OWNED', '你已经是该房源的产权人');
  if (property.occupancy === 'free-residence') {
    throw new BusinessError('NOT_TRADEABLE', '永久居住权住宅不是可售资产');
  }
  if (draft.finance.accounts.savings < input.expectedPriceCents) {
    throw new BusinessError('INSUFFICIENT_SAVINGS', '银行存款不足以支付全款（首版不支持按揭）');
  }
  return executePurchase(draft, {
    propertyId: input.propertyId,
    buyer: PLAYER_OWNER,
    priceCents: input.expectedPriceCents,
    atMinute: input.atMinute,
    monthKey: input.monthKey,
    operationId: input.operationId,
    channel: 'player',
    expectedListingVersion: input.expectedListingVersion,
  });
}

/** 玩家买入城市储备土地（出让方为土地储备中心，可拒绝成交）。 */
export function buyLandByPlayer(draft: GameState, input: PlayerBuyInput): PropertyTrade {
  const property = propertyById(draft.realEstate, input.propertyId);
  if (!property) throw new BusinessError('NO_PROPERTY', '找不到该地块');
  if (property.kind !== 'land') throw new BusinessError('NOT_A_LAND', '该资产不是土地');
  if (property.owner.kind === 'player') throw new BusinessError('ALREADY_OWNED', '你已经是该地块的产权人');
  if (draft.finance.accounts.savings < input.expectedPriceCents) {
    throw new BusinessError('INSUFFICIENT_SAVINGS', '银行存款不足以支付土地出让价');
  }
  return executePurchase(draft, {
    propertyId: input.propertyId,
    buyer: PLAYER_OWNER,
    priceCents: input.expectedPriceCents,
    atMinute: input.atMinute,
    monthKey: input.monthKey,
    operationId: input.operationId,
    channel: 'player',
    expectedListingVersion: null,
  });
}

/** 玩家挂牌/改价：版本号不一致即拒绝，不静默覆盖新价格。 */
export function listHomeByPlayer(
  draft: GameState,
  input: {
    readonly propertyId: string;
    readonly priceCents: number;
    readonly expectedVersion: number;
    readonly atMinute: number;
  },
): { version: number } {
  const property = mutablePropertyById(draft.realEstate, input.propertyId);
  if (!property) throw new BusinessError('NO_PROPERTY', '找不到该房源');
  if (!sameOwner(property.owner, PLAYER_OWNER)) {
    throw new BusinessError('NOT_OWNER', '只能挂牌自己持有的住宅');
  }
  if (property.kind !== 'home') throw new BusinessError('NOT_A_HOME', '土地不能挂牌，只能接受或拒绝收购报价');
  const currentVersion = property.listing?.version ?? 0;
  if (currentVersion !== input.expectedVersion) {
    throw new BusinessError('LISTING_CHANGED', '挂牌信息已经变化，请刷新后重新提交');
  }
  const listing = setListing(property, input.priceCents, input.atMinute);
  return { version: listing.version };
}

/** 撤销挂牌。 */
export function cancelListingByPlayer(
  draft: GameState,
  input: { readonly propertyId: string; readonly expectedVersion: number },
): void {
  const property = mutablePropertyById(draft.realEstate, input.propertyId);
  if (!property) throw new BusinessError('NO_PROPERTY', '找不到该房源');
  if (!sameOwner(property.owner, PLAYER_OWNER)) {
    throw new BusinessError('NOT_OWNER', '只能撤销自己的挂牌');
  }
  if (!property.listing) throw new BusinessError('NOT_LISTED', '该房源没有挂牌');
  if (property.listing.version !== input.expectedVersion) {
    throw new BusinessError('LISTING_CHANGED', '挂牌信息已经变化，请刷新后重新提交');
  }
  property.listing = null;
}

/** 接受 AI 土地收购报价：只消费该报价自己的预留。 */
export function acceptLandOffer(
  draft: GameState,
  input: {
    readonly offerId: string;
    readonly expectedPriceCents: number;
    readonly atMinute: number;
    readonly monthKey: string;
    readonly operationId: string;
  },
): PropertyTrade {
  const offer = draft.realEstate.offers.find((item) => item.id === input.offerId);
  if (!offer) throw new BusinessError('NO_OFFER', '该报价已不存在');
  if (offer.expiresAtMinute <= input.atMinute) {
    throw new BusinessError('OFFER_EXPIRED', '该报价已过期');
  }
  if (offer.priceCents !== input.expectedPriceCents) {
    throw new BusinessError('PRICE_CHANGED', '报价金额已经变化，请刷新后重新确认');
  }
  const property = propertyById(draft.realEstate, offer.propertyId);
  if (!property) throw new BusinessError('NO_PROPERTY', '找不到该地块');
  if (!sameOwner(property.owner, PLAYER_OWNER)) {
    throw new BusinessError('NOT_OWNER', '你已不是该地块的产权人');
  }
  return executePurchase(draft, {
    propertyId: property.id,
    buyer: investorOwner(offer.investorId),
    priceCents: offer.priceCents,
    atMinute: input.atMinute,
    monthKey: input.monthKey,
    operationId: input.operationId,
    channel: 'offer',
    offerId: offer.id,
  });
}

/** 拒绝报价：释放该单据的预留，报价从列表移除。 */
export function rejectLandOffer(draft: GameState, offerId: string): void {
  const offer = draft.realEstate.offers.find((item) => item.id === offerId);
  if (!offer) throw new BusinessError('NO_OFFER', '该报价已不存在');
  releaseFunds(draft.finance, 'investor', offer.investorId, offer.priceCents, offer.id);
  draft.realEstate.offers = draft.realEstate.offers.filter((item) => item.id !== offerId);
}

/* -------------------------------------------------------- 居民 / AI 成交 */

/** 居民家庭买入（由月度匹配调用）：只允许买挂牌住宅，钱从群组账户真实扣。 */
export function purchaseHomeByHousehold(
  draft: GameState,
  input: {
    readonly groupId: string;
    readonly propertyId: string;
    readonly atMinute: number;
    readonly monthKey: string;
    readonly operationId: string;
  },
): PropertyTrade {
  const property = propertyById(draft.realEstate, input.propertyId);
  if (!property) throw new BusinessError('NO_PROPERTY', '找不到该房源');
  const priceCents = property.listing?.priceCents ?? 0;
  if (priceCents <= 0) throw new BusinessError('NOT_LISTED', '该房源当前没有挂牌');
  return executePurchase(draft, {
    propertyId: property.id,
    buyer: { kind: 'household', id: input.groupId },
    priceCents,
    atMinute: input.atMinute,
    monthKey: input.monthKey,
    operationId: input.operationId,
    channel: 'market',
  });
}

/** 机构投资者买入（持有型 AI）：按挂牌价成交，资金来自其真实账户。 */
export function purchaseHomeByInvestor(
  draft: GameState,
  input: {
    readonly investorId: string;
    readonly propertyId: string;
    readonly atMinute: number;
    readonly monthKey: string;
    readonly operationId: string;
  },
): PropertyTrade {
  const property = propertyById(draft.realEstate, input.propertyId);
  if (!property) throw new BusinessError('NO_PROPERTY', '找不到该房源');
  const priceCents = property.listing?.priceCents ?? 0;
  if (priceCents <= 0) throw new BusinessError('NOT_LISTED', '该房源当前没有挂牌');
  if (subjectBalance(draft.finance, 'investor', input.investorId) < priceCents) {
    throw new BusinessError('INSUFFICIENT_SUBJECT_FUNDS', '该机构可动用资金不足');
  }
  return executePurchase(draft, {
    propertyId: property.id,
    buyer: investorOwner(input.investorId),
    priceCents,
    atMinute: input.atMinute,
    monthKey: input.monthKey,
    operationId: input.operationId,
    channel: 'market',
  });
}

/* ------------------------------------------------------------ 土地报价 */

/**
 * 月度土地报价：土地收购型 AI 对玩家持有的储备土地报价。
 *
 * - 报价来自真实资金，按「主体 + 报价 id」预留，不与融资报价混用；
 * - 有效期固定 `landOfferValidDays` 个游戏日，过期由日界释放；
 * - 同一地块同时只有一份有效报价（避免同一笔资金重复承诺）。
 */
export function createLandOffers(draft: GameState, atMinute: number, monthIndex: number): number {
  let created = 0;
  for (const entity of PROPERTY_ENTITIES) {
    if (!entity.bidsLand) continue;
    for (const property of playerPropertiesOf(draft.realEstate)) {
      if (property.kind !== 'land') continue;
      if (activeOffersFor(draft.realEstate, property.id, atMinute).length > 0) continue;
      const premium = Math.min(
        REAL_ESTATE_RULES.landOfferPremium.max,
        Math.max(
          REAL_ESTATE_RULES.landOfferPremium.min,
          entity.bidPremium + 0.02 * ((monthIndex % 3) - 1),
        ),
      );
      const priceCents = Math.max(1, Math.round(property.valuationCents * premium));
      if (priceCents > entity.maxTicketCents) continue;
      const available = subjectBalance(draft.finance, 'investor', entity.id);
      if (available < priceCents) continue;
      const offer: LandOffer = {
        id: `land-offer-${draft.realEstate.nextOfferSeq}`,
        propertyId: property.id,
        investorId: entity.id,
        priceCents,
        createdAtMinute: atMinute,
        expiresAtMinute:
          atMinute + REAL_ESTATE_RULES.landOfferValidDays * CALENDAR.minutesPerDay,
      };
      draft.realEstate.nextOfferSeq += 1;
      try {
        reserveFunds(draft.finance, 'investor', entity.id, priceCents, offer.id);
      } catch {
        // 可用资金不足（含已被融资报价预留）：本月不报价，属于正常状态
        continue;
      }
      draft.realEstate.offers.push(offer);
      created += 1;
    }
  }
  return created;
}

/** 日界：释放过期报价的预留并移除报价。 */
export function expireLandOffers(draft: GameState, nowMinute: number): number {
  let expired = 0;
  const remaining: LandOffer[] = [];
  for (const offer of draft.realEstate.offers) {
    if (offer.expiresAtMinute > nowMinute) {
      remaining.push(offer);
      continue;
    }
    releaseFunds(draft.finance, 'investor', offer.investorId, offer.priceCents, offer.id);
    expired += 1;
  }
  if (expired > 0) draft.realEstate.offers = remaining;
  return expired;
}

/* ------------------------------------------------------------ 只读辅助 */

/** 玩家永久居住权是否存在（免租的唯一依据）。 */
export function playerHasFreeResidence(state: GameState): boolean {
  return freeResidenceOf(state.realEstate) !== null;
}

/** 基础城区与扩张城区的参考地段系数：同一模板同一系数，避免无依据差异。 */
export function districtFactorOf(districtId: string): number {
  if (districtId === 'district-base') return BASE_DISTRICT_FACTOR;
  return 1.02;
}

/** 户型名与面积文案在视图层复用。 */
export function layoutLabelOf(layoutId: string | null, areaSqm: number): string {
  const layout = layoutId ? homeLayoutOf(layoutId) : null;
  const name = layout?.name ?? HOME_LAYOUTS[0]!.name;
  return `${name} · ${areaSqm}㎡`;
}

/** 已售出的住宅数量（含玩家与居民、机构），用于界面与校验。 */
export function soldHomeCount(properties: readonly (PropertyRecord | Readonly<PropertyRecord>)[]): number {
  let count = 0;
  for (const property of properties) {
    if (property.kind !== 'home') continue;
    if (property.firstSoldAtMinute !== null) count += 1;
  }
  return count;
}
