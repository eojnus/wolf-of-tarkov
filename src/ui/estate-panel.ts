/**
 * 住房与土地面板 —— 只渲染只读视图，并把点击翻译成 data-action。
 *
 * 位置规则：远程只能查看（我的住所、持有物业、在售房源、土地与报价、成交记录）；
 * 购买、挂牌、改价、撤销与接受/拒绝报价都在晴川公寓现场办理，按钮在远程时禁用并说明原因。
 */

import { formatMoneyCompact } from '../core/money';
import { PROTECTION_NOTE, type EstateCardView, type EstateSectionView } from '../app/real-estate-view';
import { icon } from './icons';

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stat(
  label: string,
  value: string,
  options?: { tone?: 'pos' | 'neg'; note?: string; live?: string },
): string {
  const tone = options?.tone ? ` ${options.tone}` : '';
  const note = options?.note ? `<div class="stat-note">${esc(options.note)}</div>` : '';
  const live = options?.live ? ` data-live="${options.live}"` : '';
  return `<div class="stat">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value num${tone}"${live}>${esc(value)}</div>
    ${note}
  </div>`;
}

function title(text: string): string {
  return `<div class="block-title">${esc(text)}</div>`;
}

function table(headers: readonly string[], rows: readonly string[], emptyText: string): string {
  if (rows.length === 0) return `<div class="pp-empty">${esc(emptyText)}</div>`;
  const head = headers.map((text) => `<th>${esc(text)}</th>`).join('');
  return `<table class="pp-table"><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function cell(text: string, numeric = false): string {
  return `<td${numeric ? ' class="num"' : ''}>${esc(text)}</td>`;
}

/** 我的住所：永久居住权，不是可售资产。 */
function residenceBlock(view: EstateSectionView): string {
  return `
    <div class="block">
      ${title('我的住所')}
      <div class="stat-grid">
        ${stat('住所', view.residenceName, { note: view.residenceLayoutText })}
        ${stat('每月房租', view.monthRentText, { note: '永久居住权：免租，且不产生未来房租' })}
        ${stat('每月生活费', view.livingCostText, { note: '房租之外的基本生活开支' })}
        ${stat('每月应缴合计', view.monthChargeText, { note: '仅基本生活费' })}
        ${stat('当前生活欠款', view.debtText)}
        ${stat('已结算月份', `${view.settledCount} 个`, {
          note: view.lastSettledMonth ? `最近结算：${view.lastSettledMonth}` : '尚未结算过',
        })}
      </div>
      <div class="note" style="margin-top:8px">${esc(view.residenceNote)}</div>
    </div>`;
}

function holdingRow(card: EstateCardView, onsite: boolean): string {
  const canTrade = onsite;
  const priceValue = card.priceCents > 0 ? (card.priceCents / 100).toFixed(0) : '';
  const listControls = card.canList
    ? `<div class="field-row" style="margin-top:6px">
         <input class="field field-sm" data-el="re-price-${esc(card.id)}" inputmode="decimal"
           placeholder="挂牌价（元）" value="${priceValue}" />
         <button type="button" class="btn btn-sm" data-action="re-list-home"
           data-property="${esc(card.id)}" data-version="${card.listingVersion}"
           ${canTrade ? '' : 'disabled'}>${card.listingVersion > 0 ? '修改挂牌价' : '挂牌出售'}</button>
         ${
           card.canCancelListing
             ? `<button type="button" class="btn btn-sm btn-ghost" data-action="re-cancel-listing"
                  data-property="${esc(card.id)}" data-version="${card.listingVersion}"
                  ${canTrade ? '' : 'disabled'}>撤销挂牌</button>`
             : ''
         }
       </div>`
    : '';
  const offerRows = card.offers
    .map(
      (offer) =>
        `<div class="field-row" style="margin-top:6px">
           <span class="badge live">${esc(offer.buyerText)} 出价 ${esc(offer.priceText)} · ${esc(offer.expiresText)}</span>
           <button type="button" class="btn btn-sm btn-primary" data-action="re-accept-offer"
             data-offer="${esc(offer.id)}" data-price="${offer.priceCents}" ${canTrade ? '' : 'disabled'}>接受报价</button>
           <button type="button" class="btn btn-sm btn-ghost" data-action="re-reject-offer"
             data-offer="${esc(offer.id)}" ${canTrade ? '' : 'disabled'}>拒绝</button>
         </div>`,
    )
    .join('');
  return `
    <div class="block">
      <div class="block-title">${esc(card.name)}</div>
      <div class="kv-list">
        <div class="kv"><span class="k">地段</span><span class="v">${esc(card.districtText)}</span></div>
        <div class="kv"><span class="k">户型</span><span class="v">${esc(card.layoutText)}</span></div>
        <div class="kv"><span class="k">状态</span><span class="v">${esc(card.statusText)}</span></div>
        <div class="kv"><span class="k">参考估值</span><span class="v num">${esc(card.valuationText)}</span></div>
        <div class="kv"><span class="k">取得成本</span><span class="v num">${esc(card.costBasisText)}</span></div>
        <div class="kv"><span class="k">未实现估值差</span><span class="v num ${card.unrealizedPositive ? 'pos' : 'neg'}">${esc(card.unrealizedText)}</span></div>
        <div class="kv"><span class="k">${card.kind === 'land' ? '出让价' : '挂牌价'}</span><span class="v num">${esc(card.priceText)}</span></div>
      </div>
      ${listControls}
      ${offerRows}
    </div>`;
}

function marketRows(cards: readonly EstateCardView[], onsite: boolean): string[] {
  return cards.map((card) => {
    const action = `<button type="button" class="btn btn-sm btn-primary" data-action="re-buy-home"
        data-property="${esc(card.id)}" data-price="${card.priceCents}" data-version="${card.listingVersion}"
        ${card.canBuy && onsite ? '' : 'disabled'}>购买</button>`;
    return `<tr>
      ${cell(card.name)}
      ${cell(card.layoutText)}
      ${cell(card.districtText)}
      ${cell(card.valuationText, true)}
      ${cell(card.priceText, true)}
      ${cell(card.protectionText)}
      <td>${action}</td>
    </tr>`;
  });
}

function landRows(cards: readonly EstateCardView[], onsite: boolean): string[] {
  return cards.map((card) => {
    const action = `<button type="button" class="btn btn-sm btn-primary" data-action="re-buy-land"
        data-property="${esc(card.id)}" data-price="${card.priceCents}"
        ${card.canBuyLand && onsite ? '' : 'disabled'}>受让</button>`;
    return `<tr>
      ${cell(card.name)}
      ${cell(card.layoutText)}
      ${cell(card.ownerText)}
      ${cell(card.valuationText, true)}
      ${cell(card.priceText, true)}
      <td>${action}</td>
    </tr>`;
  });
}

function tradeRows(view: EstateSectionView): string[] {
  return view.trades.map((trade) =>
    `<tr>
      ${cell(trade.dateText)}
      ${cell(trade.nameText)}
      ${cell(trade.actionText)}
      ${cell(trade.priceText, true)}
      ${cell(trade.counterPartyText)}
      <td class="num ${trade.realizedPositive ? 'pos' : 'neg'}">${esc(trade.realizedText)}</td>
    </tr>`,
  );
}

/** 住房与土地整页。 */
export function renderEstate(view: EstateSectionView): string {
  const holdingsBlock = view.emptyHoldings
    ? `<div class="pp-empty">还没有持有物业。购买住宅或受让储备土地后会出现在这里。</div>`
    : view.holdings.map((card) => holdingRow(card, view.onsite)).join('');

  return `
    ${residenceBlock(view)}

    <div class="block">
      ${title('我的物业')}
      <div class="stat-grid">
        ${stat('持有物业估值', view.propertyValueText, { note: '按参考估值计入净资产（永久居住权不计）' })}
        ${stat('已实现价差', view.realizedText, {
          tone: view.realizedPositive ? 'pos' : 'neg',
          note: `累计 ${view.realizedTrades} 笔卖出`,
        })}
        ${stat('银行存款', view.savingsText, { note: '买卖使用银行存款结算' })}
      </div>
      <div style="margin-top:10px">${holdingsBlock}</div>
      <div class="note" style="margin-top:8px">${esc(view.listingHint)}</div>
    </div>

    <div class="block">
      ${title('在售住宅')}
      ${table(
        ['房源', '户型', '地段', '参考估值', '挂牌价', '保护期', '操作'],
        marketRows(view.marketHomes, view.onsite),
        '当前没有在售住宅。',
      )}
      <div class="note" style="margin-top:8px">${esc(PROTECTION_NOTE)}</div>
    </div>

    <div class="block">
      ${title('城市储备土地')}
      ${table(
        ['地块', '面积与用途', '产权主体', '参考估值', '出让价', '操作'],
        landRows(view.reserveLand, view.onsite),
        '当前没有可受让的储备土地。',
      )}
      <div class="note" style="margin-top:8px">${esc(view.landHint)}</div>
    </div>

    <div class="block">
      ${title('成交记录')}
      ${table(
        ['时间', '资产', '方向', '成交价', '对手方', '已实现价差'],
        tradeRows(view),
        '还没有你的房地产成交记录。',
      )}
    </div>

    <div class="note${view.onsite ? '' : ' warn'}">
      ${esc(view.onsiteHint)}
    </div>
  `;
}

/** 远程只读摘要（用于个人生活其它入口的提示，不提供交易按钮）。 */
export function renderEstateBrief(view: EstateSectionView): string {
  return `
    <div class="block">
      <div class="stat-grid">
        ${stat('持有物业估值', view.propertyValueText)}
        ${stat('已实现价差', view.realizedText, { tone: view.realizedPositive ? 'pos' : 'neg' })}
        ${stat('在售住宅', `${view.marketHomes.length} 套`, { note: '含玩家优先保护期内的新房' })}
        ${stat('储备土地', `${view.reserveLand.length} 块`)}
      </div>
      <div class="note" style="margin-top:8px">${esc(view.onsiteHint)}</div>
    </div>
  `;
}

/**
 * 个人资产里的房地产持有明细：只读表格，与住房页共用同一份 `EstateSectionView` 与行渲染。
 *
 * 这里刻意不含挂牌输入、买入/受让按钮与报价处理：
 * 人物界面只查看持有情况与「有没有机构在看」，交易仍在晴川公寓现场办理。
 */
export function renderEstateHoldingsTable(view: EstateSectionView): string {
  if (view.holdings.length === 0) {
    return `<div class="pp-empty">还没有持有物业。住宅与土地需要在晴川公寓现场购买或受让。</div>`;
  }
  const offerText = (card: EstateCardView): string => {
    if (card.offers.length === 0) return '—';
    const best = card.offers.reduce((max, offer) =>
      offer.priceCents > max.priceCents ? offer : max,
    );
    return `${card.offers.length} 份 · 最高 ${best.priceText}`;
  };
  const rows = view.holdings.map(
    (card) => `<tr>
      ${cell(card.name)}
      ${cell(card.kind === 'land' ? '储备土地' : '住宅')}
      ${cell(card.layoutText)}
      ${cell(card.statusText)}
      ${cell(card.costBasisText, true)}
      ${cell(card.valuationText, true)}
      <td class="num ${card.unrealizedPositive ? 'pos' : 'neg'}">${esc(card.unrealizedText)}</td>
      ${cell(offerText(card), true)}
    </tr>`,
  );
  return table(
    ['物业', '类别', '户型/面积', '状态', '取得成本', '参考估值', '未实现价差', '机构报价'],
    rows,
    '还没有持有物业',
  );
}

/** 休息/睡觉入口（只在住宅现场出现），与住房交易同页但互不影响。 */
export function renderRestBlock(presets: readonly { minutes: number; label: string }[]): string {
  const buttons = presets
    .map(
      (preset) =>
        `<button type="button" class="btn" data-action="rest" data-minutes="${preset.minutes}">休息 ${esc(preset.label)}</button>`,
    )
    .join('');
  return `
    <div class="block">
      ${title('休息 · 推进时间')}
      <div class="actions">
        ${buttons}
        <button type="button" class="btn btn-primary" data-action="sleep">${icon('clock', { size: 15 })}睡到明早 08:00</button>
      </div>
      <div class="note" style="margin-top:8px">
        休息只推进时间、不产生工资。时间会照常跨过行情更新、贷款计息、住房月度市场与月度结算节点。
      </div>
    </div>
  `;
}

/** 头部一句提示：位置与免租状态。 */
export function estateHeadline(view: EstateSectionView): string {
  return `${view.residenceName} · ${view.residenceLayoutText} · 每月应缴 ${view.monthChargeText}（房租 ${view.monthRentText}） · 银行存款 ${view.savingsText}`;
}

/** 供外部（测试/说明）复用的金额格式化。 */
export const estateMoney = formatMoneyCompact;
