/**
 * 股票投资栏的内容：账户摘要 + 持仓卡片 + 详情窗正文。
 *
 * 只渲染 app/personal-view 给出的只读数据；卡片与详情窗读的是同一个 StockCardView，
 * 因此不存在「卡片便宜、窗口贵」这种两套数字。
 */

import type { StockCardView, StocksSectionView } from '../app/personal-view';
import { BRANDING } from '../content/config';

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toneClass(up: boolean): string {
  return up ? 'up' : 'down';
}

function kpi(label: string, value: string, cls = ''): string {
  return `<div class="pp-kpi">
    <div class="pp-kpi-label">${esc(label)}</div>
    <div class="pp-kpi-value num ${cls}">${esc(value)}</div>
  </div>`;
}

export function renderStockSummary(view: StocksSectionView): string {
  if (view.empty) {
    return `<div class="pp-card">
      <div class="pp-card-title">股票账户</div>
      <div class="pp-empty">
        当前没有持仓。交易请到城市里的「${BRANDING.cityStem}证券中心」，本页只做查看。
      </div>
      <div class="pp-kpi-row">
        ${kpi('累计已实现盈亏', view.realizedText, toneClass(view.realizedPositive))}
      </div>
    </div>`;
  }
  return `<div class="pp-card">
    <div class="pp-card-title">股票账户</div>
    <div class="pp-kpi-row">
      ${kpi('总持仓市值', view.totalValueText)}
      ${kpi('总持仓成本', view.totalCostText)}
      ${kpi('总浮动盈亏', `${view.totalPnlText}（${view.totalPnlPctText}）`, toneClass(view.totalPnlPositive))}
      ${kpi('累计已实现盈亏', view.realizedText, toneClass(view.realizedPositive))}
    </div>
    <div class="pp-hint">${esc(view.spanText)}；K 线按每 120 游戏分钟一根聚合。</div>
  </div>`;
}

export function renderStockCard(card: StockCardView): string {
  return `<article class="pp-card stock-card" data-action="open-stock" data-stock="${esc(card.id)}" tabindex="0" role="button">
    <header class="stock-card-head">
      <div>
        <div class="stock-card-symbol">${esc(card.symbol)}</div>
        <div class="stock-card-name">${esc(card.name)}</div>
      </div>
      <div class="stock-card-price">
        <div class="num ${card.direction === 'up' ? 'up' : card.direction === 'down' ? 'down' : ''}">${esc(card.priceText)}</div>
        <div class="stock-card-change num ${card.direction === 'up' ? 'up' : card.direction === 'down' ? 'down' : ''}">${esc(card.changeText)} · ${esc(card.changePctText)}</div>
        <div class="stock-card-change">${esc(card.statusText)}</div>
      </div>
    </header>
    <div class="stock-card-chart">
      <canvas class="candle-canvas" data-chart="card" data-stock="${esc(card.id)}"></canvas>
      <span class="chart-empty" data-chart-empty="${esc(card.id)}">正在积累行情</span>
    </div>
    <div class="stock-card-grid">
      <div><span>持股</span><b class="num">${esc(card.sharesText)}</b></div>
      <div><span>平均成本</span><b class="num">${esc(card.avgCostText)}</b></div>
      <div><span>持仓市值</span><b class="num">${esc(card.valueText)}</b></div>
      <div><span>浮动盈亏</span><b class="num ${toneClass(card.pnlPositive)}">${esc(card.pnlText)}（${esc(card.pnlPctText)}）</b></div>
    </div>
    <div class="stock-card-foot">${esc(card.statusText)} · 点击查看详情</div>
  </article>`;
}

export function renderStockCards(view: StocksSectionView): string {
  return `<div class="stock-grid">${view.cards.map(renderStockCard).join('')}</div>`;
}

export function renderStockTradeRows(card: StockCardView): string {
  if (card.trades.length === 0) {
    return '<div class="pp-empty">还没有该股票的成交记录</div>';
  }
  const rows = card.trades
    .map(
      (row) => `<div class="pp-row">
        <span class="pp-row-time">${esc(row.dateText)}</span>
        <span class="pp-row-label">${esc(row.label)}</span>
        <span class="pp-row-amount num ${row.kind === 'sell' ? 'up' : 'down'}">
          ${row.kind === 'sell' ? '+' : '−'}${esc(row.amountText)}
        </span>
      </div>`,
    )
    .join('');
  return `<div class="pp-rows">${rows}</div>`;
}

/**
 * 只更新浮窗里的数字节点，不重建正文。
 * 拖动或时间流逝时窗口位置、文字选择都不受影响。
 */
export function patchStockWindowNumbers(scope: ParentNode, card: StockCardView): void {
  const text: Record<string, string> = {
    price: card.priceText,
    change: `${card.changeText} · ${card.changePctText}`,
    shares: card.sharesText,
    avgCost: card.avgCostText,
    totalCost: card.totalCostText,
    value: card.valueText,
    pnl: `${card.pnlText}（${card.pnlPctText}）`,
    realized: card.realizedText,
  };
  const direction = card.direction === 'up' ? 'up' : card.direction === 'down' ? 'down' : '';
  for (const el of scope.querySelectorAll<HTMLElement>('[data-wf]')) {
    const key = el.dataset.wf;
    if (!key) continue;
    const next = text[key];
    if (next !== undefined && el.textContent !== next) el.textContent = next;
    if (key === 'price' || key === 'change') {
      el.classList.remove('up', 'down');
      if (direction) el.classList.add(direction);
    }
    if (key === 'pnl' || key === 'realized') {
      const positive = key === 'pnl' ? card.pnlPositive : card.realizedPositive;
      el.classList.toggle('up', positive);
      el.classList.toggle('down', !positive);
    }
  }
}

/** 浮动详情窗正文。窗口外壳由 stock-window-manager 负责。 */
export function renderStockWindowBody(card: StockCardView): string {
  return `
    <div class="stock-window-chart">
      <canvas class="candle-canvas" data-chart="window" data-stock="${esc(card.id)}"></canvas>
      <span class="chart-empty" data-chart-empty="${esc(card.id)}">正在积累行情</span>
    </div>
    <div class="stock-window-price">
      <span class="num ${card.direction === 'up' ? 'up' : card.direction === 'down' ? 'down' : ''}" data-wf="price">${esc(card.priceText)}</span>
      <span class="num ${card.direction === 'up' ? 'up' : card.direction === 'down' ? 'down' : ''}" data-wf="change">${esc(card.changeText)} · ${esc(card.changePctText)}</span>
    </div>
    <div class="pp-kv-grid">
      <div><span>持股</span><b class="num" data-wf="shares">${esc(card.sharesText)}</b></div>
      <div><span>平均成本</span><b class="num" data-wf="avgCost">${esc(card.avgCostText)}</b></div>
      <div><span>总成本</span><b class="num" data-wf="totalCost">${esc(card.totalCostText)}</b></div>
      <div><span>市值</span><b class="num" data-wf="value">${esc(card.valueText)}</b></div>
      <div><span>浮动盈亏</span><b class="num ${toneClass(card.pnlPositive)}" data-wf="pnl">${esc(card.pnlText)}（${esc(card.pnlPctText)}）</b></div>
      <div><span>已实现盈亏</span><b class="num ${toneClass(card.realizedPositive)}" data-wf="realized">${esc(card.realizedText)}</b></div>
    </div>
    <div class="pp-card-title sm">近期成交</div>
    ${renderStockTradeRows(card)}
  `;
}
