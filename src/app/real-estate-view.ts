/**
 * 房地产只读视图 —— 界面只消费这里的格式化结果，不读业务内部状态。
 *
 * 不向玩家展示：全市家庭数、居民储蓄池、购买力档位、匹配算法、内部区域参数。
 * 只展示资产本身：地段、估值、挂牌价、状态、可买条件、保护期、个人持有、报价与成交结果。
 */

import { dateAtMinute } from '../core/calendar';
import { formatMoney, formatMoneyCompact } from '../core/money';
import { HOME_LAYOUTS, PROPERTY_ENTITIES, REAL_ESTATE_RULES, homeLayoutOf } from '../content/real-estate';
import { TIME } from '../content/config';
import { activeOffersFor, playerPropertiesOf, protectionDaysLeft, protectionActive } from '../features/real-estate';
import type { PropertyRecord, PropertyTrade } from '../features/real-estate';
import type { DeepReadonly } from '../core/readonly';
import type { ReadonlyGameState } from './state';
import { propertyValueOf } from './state';
import { monthChargeOf } from './residence';
import { ownerLabel } from './real-estate';

export type EstateStatus = 'free-residence' | 'owned' | 'listed' | 'for-sale' | 'protected' | 'land';

export interface EstateCardView {
  readonly id: string;
  readonly name: string;
  readonly kind: 'home' | 'land';
  readonly layoutText: string;
  readonly districtText: string;
  readonly ownerText: string;
  readonly statusText: string;
  readonly status: EstateStatus;
  readonly valuationText: string;
  readonly priceText: string;
  readonly priceCents: number;
  readonly listingVersion: number;
  readonly protectionText: string;
  readonly canBuy: boolean;
  readonly buyNote: string;
  readonly canList: boolean;
  readonly canCancelListing: boolean;
  readonly canBuyLand: boolean;
  readonly offers: EstateOfferView[];
  readonly costBasisText: string;
  readonly unrealizedText: string;
  readonly unrealizedPositive: boolean;
}

export interface EstateOfferView {
  readonly id: string;
  readonly buyerText: string;
  readonly priceText: string;
  readonly priceCents: number;
  readonly expiresText: string;
}

export interface EstateTradeView {
  readonly id: string;
  readonly dateText: string;
  readonly nameText: string;
  readonly actionText: string;
  readonly priceText: string;
  readonly counterPartyText: string;
  readonly realizedText: string;
  readonly realizedPositive: boolean;
}

export interface EstateSectionView {
  readonly residenceName: string;
  readonly residenceLayoutText: string;
  readonly residenceNote: string;
  readonly holdings: EstateCardView[];
  readonly marketHomes: EstateCardView[];
  readonly reserveLand: EstateCardView[];
  readonly playerLand: EstateCardView[];
  readonly trades: EstateTradeView[];
  readonly emptyHoldings: boolean;
  readonly emptyMarket: boolean;
  readonly propertyValueText: string;
  readonly realizedText: string;
  readonly realizedPositive: boolean;
  readonly realizedTrades: number;
  readonly savingsText: string;
  readonly monthChargeText: string;
  readonly monthRentText: string;
  readonly livingCostText: string;
  readonly debtText: string;
  readonly settledCount: number;
  readonly lastSettledMonth: string | null;
  readonly listingHint: string;
  readonly landHint: string;
  readonly onsiteHint: string;
  /** 现场办理：只有站在晴川公寓时才允许成交、挂牌、接受报价。 */
  readonly onsite: boolean;
  /** 现场进入个人住宅：只表示界面可用，点击时 app 会重新校验现场与永久居住权。 */
  readonly canEnterResidence: boolean;
  readonly residenceEntryNote: string;
}

function districtTextOf(districtId: string): string {
  if (districtId === 'district-base') return '晴川公寓 · 基础城区';
  const matched = /^district-stage-(\d+)$/.exec(districtId);
  if (matched) return `第 ${Number(matched[1])} 阶段新区`;
  return districtId;
}

function layoutTextOf(property: PropertyRecord | DeepReadonly<PropertyRecord>): string {
  if (property.kind === 'land') return `储备土地 · ${property.areaSqm}㎡`;
  const layout = property.layoutId ? homeLayoutOf(property.layoutId) : null;
  return `${layout?.name ?? HOME_LAYOUTS[0]!.name} · ${property.areaSqm}㎡`;
}

function protectionTextOf(
  property: PropertyRecord | DeepReadonly<PropertyRecord>,
  nowMinute: number,
): string {
  if (property.kind === 'land') return '—';
  if (!protectionActive(property, nowMinute)) {
    return property.firstSoldAtMinute === null ? '无保护期限制' : '—';
  }
  return `玩家优先 ${protectionDaysLeft(property, nowMinute)} 天`;
}

function expiresTextOf(expiresAtMinute: number): string {
  const date = dateAtMinute(expiresAtMinute, TIME.calendar);
  return `${date.month}月${date.day}日到期`;
}

function buildOffers(
  state: ReadonlyGameState,
  propertyId: string,
): EstateOfferView[] {
  const now = state.clock.totalMinute;
  return activeOffersFor(state.realEstate, propertyId, now).map((offer) => ({
    id: offer.id,
    buyerText: ownerLabel({ kind: 'investor', id: offer.investorId }),
    priceText: formatMoneyCompact(offer.priceCents),
    priceCents: offer.priceCents,
    expiresText: expiresTextOf(offer.expiresAtMinute),
  }));
}

function buildCard(
  state: ReadonlyGameState,
  property: PropertyRecord | DeepReadonly<PropertyRecord>,
): EstateCardView {
  const now = state.clock.totalMinute;
  const isPlayer = property.owner.kind === 'player';
  const isFree = property.freeResidenceFor === 'player';
  const listing = property.listing;
  const priceCents = listing?.priceCents ?? property.askPriceCents ?? 0;
  const savings = state.finance.accounts.savings;

  let status: EstateStatus;
  let statusText: string;
  if (isFree) {
    status = 'free-residence';
    statusText = '永久居住权 · 不可出售';
  } else if (isPlayer && listing) {
    status = 'listed';
    statusText = '已挂牌出售';
  } else if (isPlayer) {
    status = 'owned';
    statusText = '持有中';
  } else if (property.kind === 'land') {
    status = 'land';
    statusText = '城市储备土地';
  } else if (protectionActive(property, now)) {
    status = 'protected';
    statusText = '保护期内仅玩家可购买';
  } else {
    status = 'for-sale';
    statusText = listing ? '在售' : '未挂牌';
  }

  const canBuyHome =
    !isPlayer &&
    property.kind === 'home' &&
    !isFree &&
    listing !== null &&
    savings >= priceCents;
  const canBuyLand = !isPlayer && property.kind === 'land' && priceCents > 0 && savings >= priceCents;
  const canBuy = canBuyHome || canBuyLand;
  const buyNote = canBuy
    ? ''
    : property.kind === 'home'
      ? listing === null
        ? '当前没有挂牌'
        : savings < priceCents
          ? `银行存款不足（需 ${formatMoneyCompact(priceCents)}）`
          : '不可购买'
      : priceCents <= 0
        ? '暂不出让'
        : `银行存款不足（需 ${formatMoneyCompact(priceCents)}）`;

  const costBasis = property.costBasisCents;
  const unrealized = isPlayer ? property.valuationCents - costBasis : 0;

  return {
    id: property.id,
    name: property.name,
    kind: property.kind,
    layoutText: layoutTextOf(property),
    districtText: districtTextOf(property.districtId),
    ownerText: ownerLabel(property.owner),
    statusText,
    status,
    valuationText: formatMoneyCompact(property.valuationCents),
    priceText: priceCents > 0 ? formatMoneyCompact(priceCents) : '—',
    priceCents,
    listingVersion: listing?.version ?? 0,
    protectionText: protectionTextOf(property, now),
    canBuy,
    buyNote,
    canList: isPlayer && property.kind === 'home' && !isFree,
    canCancelListing: isPlayer && listing !== null,
    canBuyLand,
    offers: buildOffers(state, property.id),
    costBasisText: isPlayer && costBasis > 0 ? formatMoneyCompact(costBasis) : '—',
    unrealizedText: isPlayer && costBasis > 0 ? `${unrealized >= 0 ? '+' : '−'}${formatMoneyCompact(Math.abs(unrealized))}` : '—',
    unrealizedPositive: unrealized >= 0,
  };
}

function tradeViewsOf(state: ReadonlyGameState): EstateTradeView[] {
  const rows: EstateTradeView[] = [];
  const trades = state.realEstate.trades;
  for (let index = trades.length - 1; index >= 0 && rows.length < 8; index -= 1) {
    const trade = trades[index];
    if (!trade) continue;
    const isBuyer = trade.buyer.kind === 'player';
    const isSeller = trade.seller.kind === 'player';
    if (!isBuyer && !isSeller) continue;
    const property = state.realEstate.properties.find((item) => item.id === trade.propertyId);
    rows.push({
      id: trade.id,
      dateText: `${dateAtMinute(trade.atMinute, TIME.calendar).month}月${dateAtMinute(trade.atMinute, TIME.calendar).day}日`,
      nameText: property?.name ?? trade.propertyId,
      actionText: isBuyer ? '买入' : '卖出',
      priceText: formatMoneyCompact(trade.priceCents),
      counterPartyText: ownerLabel(isBuyer ? trade.seller : trade.buyer),
      realizedText: realizedTextOf(trade),
      realizedPositive: (trade.realizedCents ?? 0) >= 0,
    });
  }
  return rows;
}

function realizedTextOf(trade: PropertyTrade | DeepReadonly<PropertyTrade>): string {
  if (trade.realizedCents === null) return '—';
  const value = trade.realizedCents;
  return `${value >= 0 ? '+' : '−'}${formatMoneyCompact(Math.abs(value))}`;
}

/** 房地产区块视图（住房页与个人财务摘要共用）。 */
export function buildEstateView(state: ReadonlyGameState, onsite: boolean): EstateSectionView {
  const properties = state.realEstate.properties;
  const residence = properties.find((property) => property.freeResidenceFor === 'player') ?? null;
  const holdings: EstateCardView[] = [];
  const marketHomes: EstateCardView[] = [];
  const reserveLand: EstateCardView[] = [];
  const playerLand: EstateCardView[] = [];

  for (const property of properties) {
    // 永久居住权不属于可交易资产，也不计入持有列表
    if (property.freeResidenceFor === 'player') continue;
    const isPlayer = property.owner.kind === 'player';
    if (isPlayer) {
      holdings.push(buildCard(state, property));
      if (property.kind === 'land') playerLand.push(buildCard(state, property));
      continue;
    }
    if (property.kind === 'home' && property.listing) {
      marketHomes.push(buildCard(state, property));
    } else if (property.kind === 'land' && property.askPriceCents !== null) {
      reserveLand.push(buildCard(state, property));
    }
  }

  // 在售房源按单价从低到高展示；保护期内的排在后面
  const order = (card: EstateCardView): number =>
    (card.status === 'protected' ? 1_000_000_000 : 0) + card.priceCents;
  marketHomes.sort((left, right) => order(left) - order(right) || (left.id < right.id ? -1 : 1));

  const tradeViews = tradeViewsOf(state);
  const charge = monthChargeOf(state);

  return {
    residenceName: residence?.name ?? '晴川公寓 · 永久居住权',
    residenceLayoutText: residence ? layoutTextOf(residence) : '—',
    residenceNote:
      '这是永久免费居住权：不产生房租、不能出售、不能出租，也不计入个人房地产净资产；' +
      '它实际占用一套住宅，但你并不拥有它的产权。',
    holdings,
    marketHomes,
    reserveLand,
    playerLand,
    trades: tradeViews,
    emptyHoldings: holdings.length === 0,
    emptyMarket: marketHomes.length === 0,
    propertyValueText: formatMoney(propertyValueOf(state)),
    realizedText: `${state.realEstate.realizedCents >= 0 ? '+' : '−'}${formatMoneyMathAbs(state.realEstate.realizedCents)}`,
    realizedPositive: state.realEstate.realizedCents >= 0,
    realizedTrades: state.realEstate.realizedTrades,
    savingsText: formatMoney(state.finance.accounts.savings),
    monthChargeText: formatMoneyCompact(charge.total),
    monthRentText: charge.rent === 0 ? '免租' : formatMoneyCompact(charge.rent),
    livingCostText: formatMoneyCompact(charge.living),
    debtText: formatMoney(state.living.debt),
    settledCount: state.settlement.settledMonths.length,
    lastSettledMonth: state.settlement.lastSettledMonth,
    listingHint:
      '挂牌后由居民与机构在月度市场中按真实需求与资金购买，没有保底回收、没有即时卖出。' +
      '价格过高会长期无人问津，价格过低会被更快买走。',
    landHint:
      '土地只能接受或拒绝机构的限时收购报价；首版不做私人建房，购买土地只是持有资产。' +
      '公共新区的建设用地不进入交易，因此拒售不会阻塞城市扩张。',
    onsiteHint: onsite
      ? '你在晴川公寓现场：可以购买、挂牌、改价、撤销与接受土地报价。'
      : '当前只能远程查看；购买、挂牌与报价处理需要在晴川公寓现场办理。',
    onsite,
    canEnterResidence: onsite && residence !== null,
    residenceEntryNote:
      '首轮只开放这一套永久居住权住宅的固定室内：进门后可查看玄关、厨房、卫浴与卧室起居区，' +
      '走到门口按 F 离开。室内不提供家具编辑、交易或新的生活玩法。',
  };
}

function formatMoneyMathAbs(cents: number): string {
  return formatMoney(Math.abs(cents));
}

/** 供个人财务摘要使用：物业估值与已实现价差的一句话说明。 */
export function estateSummaryText(state: ReadonlyGameState): string {
  const count = playerPropertiesOf(state.realEstate).length;
  if (count === 0) return '尚未持有可交易物业（永久居住权不计入）';
  return `持有 ${count} 处物业 · 参考估值 ${formatMoney(propertyValueOf(state))}`;
}

/** 卖方主体名称（视图内部使用，避免界面重复实现）。 */
export function entityNameOf(id: string): string {
  return PROPERTY_ENTITIES.find((entity) => entity.id === id)?.name ?? id;
}

/** 保护期规则文案（界面说明用）。 */
export const PROTECTION_NOTE = `新住宅交付后有 ${REAL_ESTATE_RULES.protectionMonths} 个游戏月的玩家优先窗口；土地不适用保护期。`;
