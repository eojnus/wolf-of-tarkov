/**
 * 业务面板 —— 银行（含贷款）、公司、住宅、证券、个人财务、暂停菜单、未开放设施。
 *
 * 界面只渲染视图模型，所有写操作都以回调形式交给命令层；
 * 面板自身不持有任何经济状态。时间在业务面板打开期间照常流逝，
 * 因此刷新时不能打断正在输入的字段（有焦点时延迟到失焦再重绘）。
 */

import { formatMoneyCompact } from '../core/money';
import { BRANDING, CONVENIENCE_STORE_NAME, TIME } from '../content/config';
import type { FocusKey } from '../content/business';
import type { GameViewModel, PriceDirection } from '../app/view';
import { PersonalPanel } from './personal-panel';
import { GovernmentPanel, type GovernmentUiHandlers } from './government-panel';
import { ShopPanel, type ShopUiHandlers } from './shop-panel';
import type { GovernmentPanelView } from '../app/government-view';
import type { CityEconomyPanelView } from '../app/city-view';
import type { SuppliesView } from '../app/supplies-view';
import type { PersonalSection, PersonalUiQuery, PersonalView } from '../app/personal-view';
import type { CommandOutcome } from '../app/business';
import type {
  CompanyDetailView,
  SecuritiesOrderQuery,
  SecuritiesPanelView,
  TradePreviewView,
} from '../app/securities-view';

export type PanelId =
  | 'bank'
  | 'office'
  | 'home'
  | 'securities'
  | 'government'
  | 'shop'
  | 'personal'
  | 'pause';

export interface PanelHandlers {
  onClose(): void;
  onHire(jobId?: string): void;
  onWorkShift(minutes?: number): void;
  onRest(minutes: number): void;
  onSleep(): void;
  onDeposit(cents: number): void;
  onWithdraw(cents: number): void;
  onBuyStock(securityId: string, shares: number, expectedPriceCents: number | null): void;
  onSellStock(securityId: string, shares: number, expectedPriceCents: number | null): void;
  onBorrow(cents: number): void;
  onRepay(cents: number): void;
  onRepayAll(): void;
  onSave(): void;
  onLoad(): void;
  onExport(): void;
  onImportFile(file: File): void;
  onNewGame(): void;
  onResume(): void;
  onCreateCompany(name: string, capitalCents: number): CommandOutcome;
  onFundCompany(cents: number): CommandOutcome;
  onDividend(cents: number): CommandOutcome;
  onDividendAll(): CommandOutcome;
  onPauseCompany(): CommandOutcome;
  onResumeCompany(): CommandOutcome;
  onLiquidateCompany(): CommandOutcome;
  onAdvanceEvent(): CommandOutcome;
  onHireTalent(candidateId: string): CommandOutcome;
  onFireTalent(): CommandOutcome;
  onInvestTech(cents: number): CommandOutcome;
  onStartResearch(focus: FocusKey, days: number, budgetCents: number): CommandOutcome;
  onCancelResearch(): CommandOutcome;
  onReleaseProduct(
    productId: string,
    name: string,
    priceCents: number,
    marketingDailyCents: number,
  ): CommandOutcome;
  onSetPrice(productId: string, priceCents: number): CommandOutcome;
  onSetMarketing(productId: string, dailyCents: number): CommandOutcome;
  onStopProduct(productId: string): CommandOutcome;
  onRequestFinancing(cents: number): CommandOutcome;
  onAcceptQuote(quoteId: string): CommandOutcome;
  onRejectQuotes(): CommandOutcome;
  onListCompany(): CommandOutcome;
  onBuyback(companyId: string, shares: number, expectedPriceCents: number | null): CommandOutcome;
  onPromote(cents: number): CommandOutcome;
  onAppointCeo(companyId: string, holderId: string): CommandOutcome;
  onRemoveCeo(companyId: string, holderId: string): CommandOutcome;
  onVoteProposal(
    companyId: string,
    proposalId: string,
    choice: 'yes' | 'no' | 'abstain',
  ): CommandOutcome;
  /** 从背包使用一件消耗品；requestId 由界面复用，命令层保证不重复消耗。 */
  onUseItem(itemId: string, requestId: string): CommandOutcome;
}

const PANEL_HEADS: Record<PanelId, { kicker: string; title: string; sub: string }> = {
  bank: {
    kicker: '银行业务',
    title: `${BRANDING.cityStem}银行`,
    sub: '存取款与个人贷款。存取款只改变资金形态，不改变净资产。',
  },
  office: {
    kicker: '就业',
    title: `${BRANDING.cityStem}实业大厦`,
    sub: '入职后主动完成班次累计工资，当月工资在月度结算时发放到现金。',
  },
  home: {
    kicker: '住宅',
    title: '晴川公寓',
    sub: '休息会推进时间，时间照常跨过行情、计息与月结节点。',
  },
  securities: {
    kicker: '证券市场',
    title: `${BRANDING.cityStem}证券中心`,
    sub: '单只股票、即时成交。买卖用银行存款结算，只是资产形态转换。',
  },
  government: {
    kicker: '城市治理',
    title: `${BRANDING.cityStem}管理式民主政府`,
    sub: '人口统计、政治人口、政府结构、选举与竞选赞助。面板打开时模拟继续。',
  },
  shop: {
    kicker: '生活补给',
    title: CONVENIENCE_STORE_NAME,
    sub: '购买食品饮料、入职或切换便利店岗位、开始工作。面板打开时模拟继续。',
  },
  personal: {
    kicker: '人物',
    title: '人物管理',
    sub: '人物总览、个人财务、工作情况、股票投资与公司管理。',
  },
  pause: {
    kicker: '已暂停',
    title: '游戏暂停',
    sub: '模拟时间已停止。继续游戏会重新锁定鼠标。',
  },
};

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
  options?: {
    tone?: 'pos' | 'neg' | 'up' | 'down';
    note?: string;
    wide?: boolean;
    live?: string;
  },
): string {
  const tone = options?.tone ? ` ${options.tone}` : '';
  const wide = options?.wide ? ' wide' : '';
  const note = options?.note ? `<div class="stat-note">${esc(options.note)}</div>` : '';
  const live = options?.live ? ` data-live="${options.live}"` : '';
  return `<div class="stat${wide}">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value num${tone}"${live}>${esc(value)}</div>
    ${note}
  </div>`;
}

function kv(
  label: string,
  value: string,
  tone?: 'pos' | 'neg' | 'up' | 'down',
  live?: string,
): string {
  const cls = tone ? ` ${tone}` : '';
  const liveAttr = live ? ` data-live="${live}"` : '';
  return `<div class="kv"><span class="k">${esc(label)}</span><span class="v num${cls}"${liveAttr}>${esc(value)}</span></div>`;
}

function priceTone(direction: PriceDirection): 'up' | 'down' | undefined {
  if (direction === 'up') return 'up';
  if (direction === 'down') return 'down';
  return undefined;
}

type LiveTone = 'up' | 'down' | 'pos' | 'neg';

interface LiveSpec {
  readonly text: (view: GameViewModel, securities: SecuritiesPanelView | null) => string;
  readonly tone?: (view: GameViewModel, securities: SecuritiesPanelView | null) => LiveTone | null;
}

function maxBuyOf(view: SecuritiesPanelView | null): number {
  return view?.maxBuy ?? 0;
}

/**
 * 局部刷新的数值区。
 *
 * 时间在业务面板打开期间持续流逝，若此时整体重建 DOM，会打断输入或吞掉点击；
 * 但完全不刷新又会让玩家看着旧价格下单。所以把「纯数值/纯文本」的节点标上 data-live，
 * 有输入焦点或鼠标按下时只更新这些节点，DOM 结构和输入框保持不动。
 */
const LIVE: Record<string, LiveSpec> = {
  'stock.price': {
    text: (_view, securities) => securities?.selected?.priceText ?? '—',
    tone: (_view, securities) => priceTone(securities?.selected?.direction ?? 'flat') ?? null,
  },
  'stock.change': {
    text: (_view, securities) => {
      const selected = securities?.selected;
      return selected ? `${selected.changeText} · ${selected.changePctText}` : '—';
    },
    tone: (_view, securities) => priceTone(securities?.selected?.direction ?? 'flat') ?? null,
  },
  'stock.nextTick': { text: (_view, securities) => securities?.nextTickText ?? '—' },
  'stock.shares': { text: (_view, securities) => securities?.selected?.sharesText ?? '—' },
  'stock.avgCost': { text: (_view, securities) => securities?.selected?.avgCostText ?? '—' },
  'stock.marketValue': { text: (_view, securities) => securities?.selected?.valueText ?? '—' },
  'stock.unrealized': {
    text: (_view, securities) => securities?.selected?.pnlText ?? '—',
    tone: (_view, securities) =>
      (securities?.selected?.shares ?? 0) > 0
        ? securities?.selected?.pnlPositive
          ? 'up'
          : 'down'
        : null,
  },
  'stock.realized': {
    text: (_view, securities) => securities?.selected?.realizedText ?? '—',
    tone: (_view, securities) => (securities?.selected?.realizedPositive ? 'up' : 'down'),
  },
  'stock.trades': { text: (_view, securities) => securities?.selected?.tradesText ?? '—' },
  'stock.buyNote': {
    text: (_view, securities) => securities?.buyNote ?? '当前无法买入',
  },
  'stock.maxBuyLabel': { text: (_view, securities) => `最多 ${maxBuyOf(securities)} 股` },
  'trade.buyPreview': {
    text: (_view, securities) =>
      previewText(securities?.buyPreview ?? null, '输入买入股数后显示这一笔的均价、总额与价格影响'),
  },
  'trade.sellPreview': {
    text: (_view, securities) =>
      previewText(securities?.sellPreview ?? null, '输入卖出股数后显示这一笔的均价、总额与价格影响'),
  },
  'money.cash': { text: (view) => view.money.cashText },
  'money.savings': { text: (view) => view.money.savingsText },
  'money.available': { text: (view) => view.money.availableText },
  'money.unpaidWages': { text: (view) => view.money.unpaidWagesText },
  'money.debt': {
    text: (view) => view.money.debtText,
    tone: (view) => (view.money.debt > 0 ? 'neg' : null),
  },
  'money.loanLiability': {
    text: (view) => view.money.loanLiabilityText,
    tone: (view) => (view.money.loanLiability > 0 ? 'neg' : null),
  },
  'money.netWorth': {
    text: (view) => view.money.netWorthText,
    tone: (view) => (view.money.netWorth >= 0 ? 'pos' : 'neg'),
  },
  'loan.status': {
    text: (view) => view.loan.statusText,
    tone: (view) => (view.loan.overdue ? 'neg' : null),
  },
  'loan.outstanding': { text: (view) => view.loan.outstandingText },
  'loan.interest': { text: (view) => view.loan.accruedInterestText },
  'loan.totalOwed': {
    text: (view) => view.loan.totalOwedText,
    tone: (view) => (view.loan.overdue ? 'neg' : null),
  },
  'loan.remaining': {
    text: (view) => view.loan.remainingText,
    tone: (view) => (view.loan.overdue ? 'neg' : null),
  },
  'loan.paid': { text: (view) => view.loan.totalPaidText },
  'loan.repayable': { text: (view) => view.loan.maxRepayableText },
  'loan.repayAllLabel': { text: (view) => `全额结清 ${view.loan.totalOwedText}` },
};

/* ------------------------------------------------------------------ 银行 */

function renderBank(view: GameViewModel): string {
  const loan = view.loan;
  const loanBlock = loan.open
    ? `
    <div class="block">
      <div class="block-title">我的贷款</div>
      <div class="stat-grid">
        ${stat('贷款本金', loan.principalText, { note: `放款 ${esc(loan.startDateText)}` })}
        ${stat('未偿本金', loan.outstandingText, { live: 'loan.outstanding' })}
        ${stat('已计提利息', loan.accruedInterestText, { live: 'loan.interest', note: '按未偿本金单利累计' })}
        ${stat('待还总额', loan.totalOwedText, { live: 'loan.totalOwed', tone: loan.overdue ? 'neg' : undefined })}
        ${stat('到期日', loan.dueDateText, { note: `放款 ${esc(loan.startDateText)}` })}
        ${stat('剩余天数', loan.remainingText, { live: 'loan.remaining', tone: loan.overdue ? 'neg' : undefined })}
        ${stat('已支付合计', loan.totalPaidText, { wide: true, live: 'loan.paid' })}
      </div>
      <div class="actions">
        <span class="badge ${loan.overdue ? 'off' : 'live'}" data-live="loan.status">${esc(loan.statusText)}</span>
      </div>
      <div class="field-row" style="margin-top:10px">
        <input class="field" data-el="repay-input" inputmode="decimal" placeholder="还款金额（元）" />
        <button type="button" class="btn" data-action="repay">还款</button>
      </div>
      <div class="quick-row">
        <button type="button" class="btn btn-sm" data-action="repay-quick" data-amount="1000">¥1,000</button>
        <button type="button" class="btn btn-sm" data-action="repay-quick" data-amount="5000">¥5,000</button>
        <button type="button" class="btn btn-sm" data-action="repay-all">
          <span data-live="loan.repayAllLabel">全额结清 ${esc(loan.totalOwedText)}</span>
        </button>
      </div>
      <div class="note" style="margin-top:10px">
        还款先冲抵已计提利息、再冲抵本金；只能使用银行存款，不足时无法还款。
        到期时系统会尝试自动偿还，付不出的部分转为逾期并继续按同一规则计息，不加罚息。
      </div>
    </div>`
    : `
    <div class="block">
      <div class="block-title">个人贷款</div>
      <div class="stat-grid">
        ${stat('额度上限', loan.maxPrincipalText, { note: `单笔最低 ${loan.minPrincipalText}` })}
        ${stat('期限', loan.termText)}
        ${stat('利率', loan.interestRateText, { wide: true, note: '单利，按实际未偿本金计提' })}
      </div>
      <div class="field-row" style="margin-top:10px">
        <input class="field" data-el="borrow-input" inputmode="decimal" placeholder="借款金额（元）" />
        <button type="button" class="btn btn-primary" data-action="borrow">借款</button>
      </div>
      <div class="quick-row">
        <button type="button" class="btn btn-sm" data-action="borrow-quick" data-amount="1000">¥1,000</button>
        <button type="button" class="btn btn-sm" data-action="borrow-quick" data-amount="3000">¥3,000</button>
        <button type="button" class="btn btn-sm" data-action="borrow-quick" data-amount="10000">¥10,000</button>
      </div>
      <div class="note" style="margin-top:10px">
        借款全额进入银行存款，同时产生等额负债，<strong>不增加净资产</strong>。
        同时只能有一份未结清合同，结清后可再次申请。
      </div>
    </div>`;

  return `
    <div class="block">
      <div class="stat-grid">
        ${stat('现金', view.money.cashText, { note: '可直接用于支付', live: 'money.cash' })}
        ${stat('银行存款', view.money.savingsText, { note: '存取款、股票与贷款结算账户', live: 'money.savings' })}
        ${stat('可用资金', view.money.availableText, { wide: true, note: '现金 + 银行存款', live: 'money.available' })}
        ${stat('未发工资', view.money.unpaidWagesText, { wide: true, note: '未发放，不能直接用于支付', live: 'money.unpaidWages' })}
      </div>
    </div>

    <div class="block">
      <div class="block-title">存款 · 现金 → 银行存款</div>
      <div class="field-row">
        <input class="field" data-el="deposit-input" inputmode="decimal" placeholder="输入金额（元）" />
        <button type="button" class="btn btn-primary" data-action="deposit">存入</button>
      </div>
      <div class="quick-row">
        <button type="button" class="btn btn-sm" data-action="quick-deposit" data-amount="100">¥100</button>
        <button type="button" class="btn btn-sm" data-action="quick-deposit" data-amount="500">¥500</button>
        <button type="button" class="btn btn-sm" data-action="quick-deposit" data-amount="1000">¥1,000</button>
        <button type="button" class="btn btn-sm" data-action="quick-deposit" data-amount="all">全部现金</button>
      </div>
    </div>

    <div class="block">
      <div class="block-title">取款 · 银行存款 → 现金</div>
      <div class="field-row">
        <input class="field" data-el="withdraw-input" inputmode="decimal" placeholder="输入金额（元）" />
        <button type="button" class="btn" data-action="withdraw">取出</button>
      </div>
      <div class="quick-row">
        <button type="button" class="btn btn-sm" data-action="quick-withdraw" data-amount="100">¥100</button>
        <button type="button" class="btn btn-sm" data-action="quick-withdraw" data-amount="500">¥500</button>
        <button type="button" class="btn btn-sm" data-action="quick-withdraw" data-amount="1000">¥1,000</button>
        <button type="button" class="btn btn-sm" data-action="quick-withdraw" data-amount="all">全部取出</button>
      </div>
    </div>

    ${loanBlock}

    <div class="note">
      单笔存取款 ${esc(view.banking.minimumText)} 起，上限 ${esc(view.banking.maximumText)}。
      首版不计存款利息，不支持透支。
    </div>
  `;
}

/* ------------------------------------------------------------------ 证券 */

/** 预览里记录的成交均价，提交时用来判断价格是否已经变化。 */
function buyPreviewPriceAttr(preview: TradePreviewView | null): string {
  return preview && preview.executableShares > 0 ? ` data-price="${preview.priceCents}"` : '';
}

function previewText(preview: TradePreviewView | null, fallback: string): string {
  if (!preview) return fallback;
  if (preview.executableShares <= 0) return preview.note;
  const parts = [
    `${preview.executableShares} 股`,
    `均价 ${preview.priceText}`,
    `总额 ${preview.amountText}`,
    `价格影响 ${preview.impactText}`,
  ];
  if (preview.partial) parts.push('只能部分成交');
  return parts.join(' · ');
}

/** 股份供给饼图：只画一个环形（在售 / 未在售），不引入图表库。 */
/**
 * 公司详情区块的完整内容（含标题、饼图与图例）。
 *
 * 单独抽出来是为了让「输入期间」也能原地替换这一块：
 * 它里面没有任何交易输入框，替换 innerHTML 不会打断输入、焦点或滚动。
 */
function renderCompanyDetail(detail: CompanyDetailView): string {
  if (!detail.available) {
    return `<div class="block-title">公司详情 · 股份供给</div>
      <div class="empty">${esc(detail.note)}</div>`;
  }
  return `
    <div class="block-title">公司详情 · 股份供给</div>
    <div class="cd-head">
      <div class="cd-title">
        <div class="cd-name">${esc(detail.companyName)}</div>
        <div class="cd-sub">${esc(detail.listedText)} · ${esc(detail.statusText)} · 现价 <span class="num">${esc(
          detail.priceText,
        )}</span></div>
      </div>
      <div class="cd-total">
        <span>总发行股份</span>
        <b class="num">${esc(detail.totalSharesText)}</b>
      </div>
    </div>
    ${renderSharePie(detail)}
    <div class="kv-list">
      ${kv('在售股份（可买）', detail.forSaleText)}
      ${kv('未在售股份', detail.notForSaleText)}
      ${kv('其中库存股（不投票、不分红）', detail.treasuryText)}
      ${kv('做市库存', detail.deskInventoryText)}
      ${kv('当前愿售比例', detail.forSaleRatioText)}
      ${kv('你的持股', detail.playerSharesText)}
    </div>
    <div class="note" style="margin-top:10px">${esc(detail.note)}</div>`;
}

/** 公司详情的内容指纹：只在数字/状态真的变化时才替换 DOM。 */
function companyDetailSignature(detail: CompanyDetailView): string {
  return [
    detail.available ? '1' : '0',
    detail.companyName,
    detail.listedText,
    detail.statusText,
    detail.priceText,
    detail.totalShares,
    detail.forSaleShares,
    detail.notForSaleShares,
    detail.treasuryShares,
    detail.forSaleRatioText,
    detail.playerSharesText,
    detail.note,
  ].join('|');
}

function renderSharePie(detail: CompanyDetailView): string {
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  const ratio = Math.max(0, Math.min(100, detail.forSalePct)) / 100;
  const dash = circumference * ratio;
  const slice =
    dash > 0
      ? `<circle class="pie-slice" cx="60" cy="60" r="${radius}" stroke-dasharray="${dash.toFixed(
          2,
        )} ${(circumference - dash).toFixed(2)}" transform="rotate(-90 60 60)" />`
      : '';
  const centerText = detail.totalShares > 0 ? detail.forSalePctText : '—';
  return `
    <div class="pie-wrap">
      <svg class="pie-chart" viewBox="0 0 120 120" role="img" aria-label="在售与未在售股份比例">
        <circle class="pie-track" cx="60" cy="60" r="${radius}" />
        ${slice}
        <text class="pie-center-label" x="60" y="56">在售</text>
        <text class="pie-center-value" x="60" y="76">${esc(centerText)}</text>
      </svg>
      <ul class="pie-legend">
        <li><i class="dot dot-sale"></i><span>在售</span><b class="num">${esc(
          detail.forSaleText,
        )}</b><em class="num">${esc(detail.forSalePctText)}</em></li>
        <li><i class="dot dot-unsold"></i><span>未在售</span><b class="num">${esc(
          detail.notForSaleText,
        )}</b><em class="num">${esc(detail.notForSalePctText)}</em></li>
      </ul>
    </div>`;
}

function renderSecurities(view: SecuritiesPanelView): string {
  const selected = view.selected;
  const detail = view.companyDetail;
  const rows = view.rows
    .map(
      (row) => `<button type="button" class="btn btn-sm sec-tab${row.selected ? ' btn-primary' : ''}" data-action="select-security" data-security="${esc(row.id)}">
        ${esc(row.symbol)} · ${esc(row.priceText)} · ${esc(row.changePctText)}${row.holdingText !== '—' ? ` · ${esc(row.holdingText)}` : ''}
      </button>`,
    )
    .join('');
  if (!selected) {
    return `<div class="block"><div class="empty">暂无可用证券</div></div>`;
  }

  const tradeDisabled = detail.terminated;

  return `
    <div class="sec-layout">
      <div class="sec-main">
        <div class="block">
          <div class="block-title">证券标的</div>
          <div class="quick-row">${rows}</div>
          <div class="note" style="margin-top:10px">${esc(selected.name)} · ${esc(view.companyNote)}</div>
        </div>

        <div class="block">
          <div class="stock-head">
            <div>
              <div class="stock-symbol">${esc(selected.symbol)}</div>
              <div class="stock-name">${esc(selected.name)}</div>
              <div class="stock-status">${esc(selected.statusText)}</div>
            </div>
            <div class="stock-price-box">
              <div class="stock-price num ${priceTone(selected.direction) ?? ''}" data-live="stock.price">${esc(selected.priceText)}</div>
              <div class="stock-change num ${priceTone(selected.direction) ?? ''}" data-live="stock.change">
                ${esc(selected.changeText)} · ${esc(selected.changePctText)}
              </div>
            </div>
          </div>
          <canvas class="sparkline" data-el="sparkline" width="720" height="180"></canvas>
          <div class="sparkline-foot">
            <span>每 ${view.tickMinutes} 分钟更新一次 · ${esc(view.spanText)}</span>
            <span>下次更新 <span data-live="stock.nextTick">${esc(view.nextTickText)}</span></span>
          </div>
        </div>

        <div class="block">
          <div class="block-title">买入 · 银行存款结算</div>
          <div class="field-row">
            <input class="field" data-el="buy-input" inputmode="numeric" placeholder="买入股数" ${
              tradeDisabled ? 'disabled' : ''
            } />
            <button type="button" class="btn btn-primary" data-action="buy" ${
              view.maxBuy > 0 && !tradeDisabled ? '' : 'disabled'
            }>买入</button>
          </div>
          <div class="quick-row">
            <button type="button" class="btn btn-sm" data-action="buy-quick" data-shares="10" ${
              tradeDisabled ? 'disabled' : ''
            }>10 股</button>
            <button type="button" class="btn btn-sm" data-action="buy-quick" data-shares="50" ${
              tradeDisabled ? 'disabled' : ''
            }>50 股</button>
            <button type="button" class="btn btn-sm" data-action="buy-quick" data-shares="100" ${
              tradeDisabled ? 'disabled' : ''
            }>100 股</button>
            <button type="button" class="btn btn-sm" data-action="buy-quick" data-shares="max" ${
              tradeDisabled ? 'disabled' : ''
            }>
              <span data-live="stock.maxBuyLabel">最多 ${view.maxBuy} 股</span>
            </button>
          </div>
          <div class="note" style="margin-top:10px" data-live="stock.buyNote">${esc(view.buyNote)}</div>
          <div class="note preview-line" data-el="buy-preview"${buyPreviewPriceAttr(
            view.buyPreview,
          )} data-live="trade.buyPreview">${esc(
            previewText(view.buyPreview, '输入买入股数后显示这一笔的均价、总额与价格影响'),
          )}</div>
        </div>

        <div class="block">
          <div class="block-title">卖出 · 只卖出你输入的数量</div>
          <div class="field-row">
            <input class="field" data-el="sell-input" inputmode="numeric" placeholder="卖出股数" ${
              tradeDisabled ? 'disabled' : ''
            } />
            <button type="button" class="btn" data-action="sell" ${
              view.maxSell > 0 && !tradeDisabled ? '' : 'disabled'
            }>卖出</button>
          </div>
          <div class="quick-row">
            <button type="button" class="btn btn-sm" data-action="sell-quick" data-shares="10" ${
              tradeDisabled ? 'disabled' : ''
            }>10 股</button>
            <button type="button" class="btn btn-sm" data-action="sell-all" ${
              view.maxSell > 0 && !tradeDisabled ? '' : 'disabled'
            }>填入全部持仓</button>
          </div>
          <div class="note" style="margin-top:10px">${esc(view.sellNote)}</div>
          <div class="note preview-line" data-el="sell-preview"${buyPreviewPriceAttr(
            view.sellPreview,
          )} data-live="trade.sellPreview">${esc(
            previewText(view.sellPreview, '输入卖出股数后显示这一笔的均价、总额与价格影响'),
          )}</div>
          <div class="note" style="margin-top:8px">「填入全部持仓」只会把持仓数量填进输入框并刷新预览，仍需点「卖出」并在确认框里确认数量与金额；卖出不会自动变成清仓。</div>
        </div>
      </div>

      <div class="sec-side">
        <div class="block">
          <div class="block-title">你的持仓</div>
          <div class="stat-grid">
            ${stat('持股数量', selected.sharesText, {
              live: 'stock.shares',
              note: selected.shares > 0 ? 'T+0 即时可卖' : '空仓',
            })}
            ${stat('平均成本', selected.avgCostText, { live: 'stock.avgCost' })}
            ${stat('持仓市值', selected.valueText, { live: 'stock.marketValue' })}
            ${stat('浮动盈亏', selected.pnlText, {
              live: 'stock.unrealized',
              tone: selected.shares > 0 ? (selected.pnlPositive ? 'up' : 'down') : undefined,
            })}
            ${stat('已实现盈亏', selected.realizedText, {
              live: 'stock.realized',
              tone: selected.realizedPositive ? 'up' : 'down',
            })}
            ${stat('成交笔数', selected.tradesText, { live: 'stock.trades' })}
          </div>
        </div>

        <div class="block" data-el="company-detail" data-signature="${esc(
          companyDetailSignature(detail),
        )}">${renderCompanyDetail(detail)}</div>

        <div class="block">
          <div class="block-title">规则</div>
          <div class="note">公司证券价格按经营估值锚定并有界波动；独立证券保持零趋势随机。交易使用真实账户与真实股份库存，公司融资与回购也会进入同一价格历史。上市公司的销量表现会按最近三个完整游戏日的实际日销，对估值锚点给出有界修正。</div>
        </div>
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------------ 公司 */

function renderOffice(view: GameViewModel): string {
  const job = view.employment;
  if (!job.hired) {
    return `
      <div class="block">
        <div class="stat-grid">
          ${stat('岗位', job.jobTitle)}
          ${stat('雇主', job.employer)}
          ${stat('时薪', job.hourlyWageText)}
          ${stat('单次班次', `${job.shiftMinutes / 60} 小时`)}
          ${stat('每日工时上限', `${job.maxDaily / 60} 小时`, { wide: true })}
        </div>
      </div>
      <div class="block">
        <div class="note">${esc(job.description)}</div>
      </div>
      <div class="actions">
        <button type="button" class="btn btn-primary" data-action="hire">办理入职</button>
      </div>
    `;
  }

  const workedRatio = job.maxDaily > 0 ? Math.min(1, job.workedToday / job.maxDaily) : 0;
  const reason = job.shift.ok
    ? `本次可工作 ${job.shift.minutes} 分钟（${job.efficiencyText}），预计应计 ${job.estimatedEarnText}`
    : (job.shift.reason ?? '当前无法上班');

  return `
    <div class="block">
      <div class="stat-grid">
        ${stat('职位', job.jobTitle, { note: job.employer })}
        ${stat('时薪', job.hourlyWageText)}
        ${stat('当前效率', job.efficiencyText, { note: '受饱食度与水分影响' })}
        ${stat('本月应计工资', job.accruedThisMonthText, { note: '月结时发放' })}
        ${stat('未发工资合计', job.accruedTotalText)}
      </div>
    </div>

    <div class="block">
      <div class="block-title">今日工时</div>
      <div class="meter"><div class="meter-fill" style="width:${(workedRatio * 100).toFixed(1)}%"></div></div>
      <div class="kv">
        <span class="k">已工作 / 上限</span>
        <span class="v num">${job.workedToday} / ${job.maxDaily} 分钟</span>
      </div>
      ${kv('已完成班次', `${job.shiftsCompleted} 次`)}
    </div>

    <div class="block">
      <div class="actions">
        <button type="button" class="btn btn-primary" data-action="work" ${job.shift.ok ? '' : 'disabled'}>
          ${esc(job.shiftLabel)}
        </button>
        <button type="button" class="btn" data-action="work" data-minutes="60" ${job.shift.ok && job.shift.minutes >= 60 ? '' : 'disabled'}>
          工作 1 小时
        </button>
        <button type="button" class="btn" data-action="close">离开公司</button>
      </div>
      <div class="note${job.shift.ok ? '' : ' warn'}" style="margin-top:10px">${esc(reason)}</div>
    </div>

    <div class="note">
      工资按分钟精确应计，并按区间开始时的生存效率折算；跨月工作时按实际工作时间归属到对应月份。
      上班会同时推进时间，途中行情、贷款计息与月结都会按顺序发生。
    </div>
  `;
}

/* ------------------------------------------------------------------ 住宅 */

function renderHome(view: GameViewModel): string {
  const restButtons = TIME.restPresets
    .map(
      (preset) =>
        `<button type="button" class="btn" data-action="rest" data-minutes="${preset.minutes}">休息 ${preset.label}</button>`,
    )
    .join('');

  return `
    <div class="block">
      <div class="stat-grid">
        ${stat('每月房租', formatMoneyCompact(view.monthCharge.rent))}
        ${stat('每月生活费', formatMoneyCompact(view.monthCharge.living))}
        ${stat('每月应缴合计', view.monthChargeText, { wide: true })}
        ${stat('当前生活欠款', view.money.debtText, { tone: view.money.debt > 0 ? 'neg' : undefined })}
        ${stat('已结算月份', `${view.settledCount} 个`, { wide: true, note: view.lastSettledMonth ? `最近结算：${view.lastSettledMonth}` : '尚未结算过' })}
      </div>
    </div>

    <div class="block">
      <div class="block-title">休息 · 推进时间</div>
      <div class="actions">
        ${restButtons}
        <button type="button" class="btn btn-primary" data-action="sleep">睡到明早 08:00</button>
      </div>
      <div class="note" style="margin-top:10px">
        休息只推进时间、不产生工资。时间会照常跨过行情更新、贷款计息与月度结算节点。
      </div>
    </div>

    <div class="note">
      每月第 ${TIME.calendar.daysPerMonth} 天结束后自动月结：先结清并发放上月工资、偿还旧欠款，
      再扣本月房租与生活费，最后尝试贷款到期还款。
    </div>
    <div class="note warn" style="margin-top:8px">
      可用资金不足时，未付部分会转为生活欠款并计入负债。首版不做驱逐与游戏结束。
    </div>
  `;
}

/* -------------------------------------------------------------- 暂停菜单 */

function renderPause(view: GameViewModel): string {
  return `
    <div class="block">
      <div class="actions">
        <button type="button" class="btn btn-primary" data-action="resume">继续游戏</button>
      </div>
    </div>
    <div class="block">
      <div class="actions">
        <button type="button" class="btn" data-action="save">保存游戏</button>
        <button type="button" class="btn" data-action="load">读取存档</button>
      </div>
      <div class="actions">
        <button type="button" class="btn" data-action="export">导出 JSON</button>
        <label class="btn" style="display:inline-flex;align-items:center">
          导入 JSON
          <input type="file" accept="application/json,.json" hidden data-el="import-input" />
        </label>
      </div>
      <div class="actions">
        <button type="button" class="btn btn-ghost" data-action="new-game">重新开始</button>
      </div>
    </div>

    <div class="block">
      <div class="stat-grid">
        ${stat('当前时间', view.dateText, { wide: true })}
        ${stat('速度', `${view.speed}×`, { note: `1 天 = ${Math.round(TIME.calendar.minutesPerDay / (TIME.minutesPerRealSecond * 60))} 分钟现实时间` })}
      </div>
    </div>

    <div class="note">
      存档使用完整游戏快照，包含时间、账户与流水、任职与工资应计、股票持仓与行情、
      贷款合同、欠款、玩家位置与摄像机角度。
    </div>
    <div class="note warn" style="margin-top:8px">
      关闭页面或切到后台都不会补算离线时间、离线行情或离线收益。
    </div>
    <div style="margin-top:16px;font-size:14px;color:var(--text-faint)">
      ${BRANDING.gameTitle} · v0.3.3
    </div>
  `;
}

/* ------------------------------------------------------------------ 框架 */

function renderClosed(body: string): string {
  return `
    <div class="block">
      <div class="empty">${esc(body)}</div>
    </div>
    <div class="note">首版只保留入口与说明，不提供该系统的任何业务状态或操作。</div>
  `;
}

function renderBody(
  id: PanelId,
  view: GameViewModel,
  securities: SecuritiesPanelView,
): string {
  switch (id) {
    case 'bank':
      return renderBank(view);
    case 'office':
      return renderOffice(view);
    case 'home':
      return renderHome(view);
      case 'securities':
      return renderSecurities(securities);
    case 'personal':
      // 人物管理是独立组件（宽幅窗口），不通过字符串渲染
      return '';
    case 'pause':
      return renderPause(view);
    case 'government':
      // 政府面板是独立组件（由 PanelManager 渲染），这里只是兜底
      return renderClosed('政府面板正在加载。');
    case 'shop':
      // 便利店面板是独立组件（由 PanelManager 渲染），这里只是兜底
      return renderClosed('便利店面板正在加载。');
  }
}

/** 用近期价格画一条简单折线，涨红跌绿。 */
function drawSparkline(canvas: HTMLCanvasElement, prices: readonly number[], direction: PriceDirection): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  if (prices.length < 2) return;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const price of prices) {
    if (price < min) min = price;
    if (price > max) max = price;
  }
  const range = Math.max(1, max - min);
  const padY = 16;
  const usable = height - padY * 2;

  // 参考线
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i += 1) {
    const y = padY + (usable * i) / 4;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  const color = direction === 'up' ? '#e07070' : direction === 'down' ? '#5fbf8a' : '#8aa4b8';
  const stepX = width / (prices.length - 1);
  ctx.beginPath();
  prices.forEach((price, index) => {
    const x = index * stepX;
    const y = padY + usable - ((price - min) / range) * usable;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.4;
  ctx.lineJoin = 'round';
  ctx.stroke();

  const lastX = width;
  const lastY = padY + usable - ((prices[prices.length - 1]! - min) / range) * usable;
  ctx.beginPath();
  ctx.arc(lastX - 3, lastY, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

export class PanelManager {
  private current: PanelId | null = null;
  private lastView: GameViewModel | null = null;
  private deferredView: GameViewModel | null = null;
  private pointerActive = false;
  private readonly root: HTMLElement;

  private readonly personal: PersonalPanel;
  private readonly government: GovernmentPanel;
  private readonly shop: ShopPanel;
  private selectedSecurityId = 'YH-01';

  constructor(
    root: HTMLElement,
    private readonly handlers: PanelHandlers,
    personalView: (query: PersonalUiQuery) => PersonalView,
    private readonly securitiesView: (
      securityId: string | null,
      order?: SecuritiesOrderQuery,
    ) => SecuritiesPanelView,
    governmentView: () => GovernmentPanelView,
    governmentHandlers: GovernmentUiHandlers,
    cityEconomyView: () => CityEconomyPanelView,
    shopView: () => SuppliesView,
    shopHandlers: ShopUiHandlers,
  ) {
    this.root = root;
    this.personal = new PersonalPanel(personalView);
    this.government = new GovernmentPanel(governmentView, governmentHandlers, cityEconomyView);
    this.shop = new ShopPanel(shopView, shopHandlers);
    this.root.addEventListener('click', this.handleClick);
    this.root.addEventListener('change', this.handleChange);
    this.root.addEventListener('input', this.handleInput);
    this.root.addEventListener('focusout', this.handleFocusOut);
    this.root.addEventListener('pointerdown', this.handlePointerDown);
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('resize', this.handleResize);
  }

  private readonly handleResize = (): void => {
    this.personal.relayout();
  };

  /** 新游戏 / 读档后清空人物界面的会话状态（含股票浮窗）。 */
  resetPersonalSession(): void {
    this.personal.resetSession();
  }

  /** 新游戏 / 读档后清空政府界面的草稿（只在内存，不进存档）。 */
  resetGovernmentSession(): void {
    this.government.resetSession();
  }

  /** 新游戏 / 读档后清空便利店的购买草稿。 */
  resetShopSession(): void {
    this.shop.resetSession();
  }

  /** 打开人物界面的指定栏目（便利店「打开背包」快捷入口）。 */
  openPersonalSection(section: PersonalSection): void {
    if (this.current === 'personal') this.personal.openSection(section);
  }

  /** Esc：先关最上层股票浮窗；没有浮窗返回 false，交给上层关闭整个界面。 */
  handleEscape(): boolean {
    if (this.current !== 'personal') return false;
    return this.personal.handleEscape();
  }

  get isOpen(): boolean {
    return this.current !== null;
  }

  get activePanel(): PanelId | null {
    return this.current;
  }

  open(id: PanelId, view: GameViewModel): void {
    if (this.current === 'personal') this.personal.teardown();
    this.current = id;
    this.lastView = view;
    this.deferredView = null;

    if (id === 'personal') {
      this.root.innerHTML = '';
      this.personal.mount(this.root);
      const win = this.root.querySelector<HTMLElement>('.personal-window');
      const scrim = this.root.querySelector<HTMLElement>('.panel-scrim');
      requestAnimationFrame(() => {
        win?.classList.add('open');
        scrim?.classList.add('open');
        this.personal.relayout();
      });
      return;
    }

    const head = PANEL_HEADS[id];
    // 证券中心、政府与便利店面板用更宽的两栏窗口；其余建筑共用同一套居中窗口外观
    const sizeClass = id === 'securities' || id === 'government' || id === 'shop' ? ' panel-xl' : '';
    this.root.innerHTML = `
      <div class="panel-scrim" data-action="close"></div>
      <aside class="panel${sizeClass}">
        <div class="panel-head">
          <div>
            <div class="panel-kicker">${esc(head.kicker)}</div>
            <h2>${esc(head.title)}</h2>
            <p class="panel-sub">${esc(head.sub)}</p>
          </div>
          <button type="button" class="btn btn-sm btn-ghost panel-close" data-action="close">关闭</button>
        </div>
        <div class="panel-body">${this.bodyHtml(view)}</div>
      </aside>
    `;
    const panel = this.root.querySelector<HTMLElement>('.panel');
    const scrim = this.root.querySelector<HTMLElement>('.panel-scrim');
    requestAnimationFrame(() => {
      panel?.classList.add('open');
      scrim?.classList.add('open');
      this.paintCharts(view);
    });
  }

  close(): void {
    if (this.current === null) return;
    const wasPersonal = this.current === 'personal';
    this.current = null;
    this.deferredView = null;
    if (wasPersonal) {
      const win = this.root.querySelector<HTMLElement>('.personal-window');
      const scrim = this.root.querySelector<HTMLElement>('.panel-scrim');
      win?.classList.remove('open');
      scrim?.classList.remove('open');
      // 只销毁 DOM，浮窗的打开状态与位置留在内存里
      this.personal.teardown();
      window.setTimeout(() => {
        if (this.current === null) this.root.innerHTML = '';
      }, 220);
      return;
    }
    const panel = this.root.querySelector<HTMLElement>('.panel');
    const scrim = this.root.querySelector<HTMLElement>('.panel-scrim');
    panel?.classList.remove('open');
    scrim?.classList.remove('open');
    window.setTimeout(() => {
      if (this.current === null) this.root.innerHTML = '';
    }, 240);
  }

  /**
   * 状态变化后刷新当前面板。
   *
   * 输入框有焦点或鼠标正按在面板上时不能重建 DOM（会打断输入、吞掉点击），
   * 但也不能让价格/余额停在旧值——此时只更新标记了 data-live 的数值节点，
   * 结构与输入框保持不动。
   */
  refresh(view: GameViewModel): void {
    this.lastView = view;
    if (this.current === null) return;
    if (this.current === 'personal') {
      this.personal.update();
      return;
    }
    const active = document.activeElement;
    const typing = active instanceof HTMLInputElement && this.root.contains(active);
    if (typing || this.pointerActive) {
      this.deferredView = view;
      this.patchLive(view);
      return;
    }
    this.paintBody(view);
  }

  /** 只更新数值/文本节点，不触碰 DOM 结构。 */
  private patchLive(view: GameViewModel): void {
    const securities = this.current === 'securities'
      ? this.securitiesView(this.selectedSecurityId, this.currentOrder())
      : null;
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-live]')) {
      const key = el.dataset.live;
      if (!key) continue;
      const spec = LIVE[key];
      if (!spec) continue;
      const text = spec.text(view, securities);
      if (el.textContent !== text) el.textContent = text;
      if (spec.tone) {
        el.classList.remove('up', 'down', 'pos', 'neg');
        const tone = spec.tone(view, securities);
        if (tone) el.classList.add(tone);
      }
    }
    // 预览节点同时保存「确认过的成交均价」，提交时用它检测价格是否变化
    const previews: Array<[string, TradePreviewView | null]> = [
      ['buy-preview', securities?.buyPreview ?? null],
      ['sell-preview', securities?.sellPreview ?? null],
    ];
    for (const [name, preview] of previews) {
      const node = this.root.querySelector<HTMLElement>(`[data-el="${name}"]`);
      if (!node) continue;
      if (preview && preview.executableShares > 0) node.dataset.price = String(preview.priceCents);
      else delete node.dataset.price;
    }
    this.patchCompanyDetail(securities);
    if (this.current === 'government') this.government.patchLive(this.root);
    if (this.current === 'shop') this.shop.patchLive(this.root);
    this.paintCharts(view);
  }

  /**
   * 原地刷新「公司详情 · 股份供给」区块（含饼图）。
   *
   * - 数据来源就是本次 patchLive 里那一份只读视图：与交易预览同一时刻、同一证券；
   * - 只替换这一个 block 的 innerHTML：它不含任何交易输入框，
   *   因此不会打断输入、焦点、光标或滚动，也不需要重建整个 panel-body；
   * - 用内容指纹跳过没变化的刷新，避免每个 tick 都动 DOM。
   */
  private patchCompanyDetail(securities: SecuritiesPanelView | null): void {
    if (!securities) return;
    const node = this.root.querySelector<HTMLElement>('[data-el="company-detail"]');
    if (!node) return;
    const detail = securities.companyDetail;
    const signature = companyDetailSignature(detail);
    if (node.dataset.signature === signature) return;
    node.dataset.signature = signature;
    node.innerHTML = renderCompanyDetail(detail);
  }

  private paintBody(view: GameViewModel): void {
    const body = this.root.querySelector<HTMLElement>('.panel-body');
    if (!body || this.current === null) return;
    const active = document.activeElement;
    const activeName = active instanceof HTMLElement ? active.getAttribute('data-el') : null;
    const caret = active instanceof HTMLInputElement ? active.selectionStart : null;
    const values = new Map<string, string>();
    for (const input of this.root.querySelectorAll<HTMLInputElement>('input[data-el]')) {
      if (input.dataset.el) values.set(input.dataset.el, input.value);
    }

    body.innerHTML = this.bodyHtml(view);

    for (const [name, value] of values) {
      const next = body.querySelector<HTMLInputElement>(`[data-el="${name}"]`);
      if (next) next.value = value;
    }
    if (activeName) {
      const next = body.querySelector<HTMLInputElement>(`[data-el="${activeName}"]`);
      if (next) {
        next.focus();
        if (caret !== null) next.setSelectionRange(caret, caret);
      }
    }
    this.paintCharts(view);
  }

  /** 当前面板的主体 HTML：政府面板由独立组件渲染，其余走字符串渲染。 */
  private bodyHtml(view: GameViewModel): string {
    if (this.current === null) return '';
    if (this.current === 'government') return this.government.renderBody();
    if (this.current === 'shop') return this.shop.renderBody();
    return renderBody(
      this.current,
      view,
      this.securitiesView(this.selectedSecurityId, this.currentOrder()),
    );
  }

  private paintCharts(_view: GameViewModel): void {
    const canvas = this.root.querySelector<HTMLCanvasElement>('[data-el="sparkline"]');
    if (!canvas || this.current !== 'securities') return;
    const selected = this.securitiesView(this.selectedSecurityId, this.currentOrder()).selected;
    if (!selected) return;
    const prices = [...selected.candles.map((candle) => candle.close)];
    if (selected.current) prices.push(selected.current.close);
    drawSparkline(canvas, prices, selected.direction);
  }

  private handleFocusOut = (): void => {
    if (!this.deferredView) return;
    const view = this.deferredView;
    this.deferredView = null;
    window.setTimeout(() => {
      if (!this.current) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && this.root.contains(active)) return;
      this.paintBody(view);
    }, 0);
  };

  private handlePointerDown = (): void => {
    this.pointerActive = true;
  };

  private handlePointerUp = (): void => {
    if (!this.pointerActive) return;
    this.pointerActive = false;
    if (!this.deferredView) return;
    const view = this.deferredView;
    this.deferredView = null;
    // 放到下一轮循环，确保 click 事件先派发完再重建 DOM
    window.setTimeout(() => {
      if (!this.current) return;
      this.paintBody(view);
    }, 0);
  };

  private handleClick = (event: MouseEvent): void => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    // 人物界面自己的导航 / 浮窗动作先交给自己处理
    if (this.current === 'personal' && action) {
      if (action === 'close' || action === 'resume') {
        // 交给下面统一处理
      } else if (this.personal.handleAction(action, target)) {
        return;
      }
    }
    // 政府面板自己的栏目切换与赞助动作
    if (this.current === 'government' && action && action.startsWith('gov-')) {
      if (this.government.handleAction(action, target)) {
        if (this.lastView) this.paintBody(this.lastView);
        return;
      }
    }
    // 便利店面板的购买/岗位/背包快捷入口
    if (this.current === 'shop' && action && action.startsWith('shop-')) {
      if (this.shop.handleAction(action, target)) {
        // 「打开背包」会切换到人物界面：只有仍在便利店时才重绘
        if (this.current === 'shop' && this.lastView) this.paintBody(this.lastView);
        return;
      }
    }
    switch (action) {
      case 'close':
        this.handlers.onClose();
        break;
      case 'resume':
        this.handlers.onResume();
        break;
      case 'hire':
        this.handlers.onHire();
        break;
      case 'work':
        this.handlers.onWorkShift(target.dataset.minutes ? Number(target.dataset.minutes) : undefined);
        break;
      case 'rest':
        this.handlers.onRest(Number(target.dataset.minutes ?? TIME.restPresets[0]?.minutes ?? 60));
        break;
      case 'sleep':
        this.handlers.onSleep();
        break;
      case 'deposit':
        this.handlers.onDeposit(this.readMoney('deposit-input'));
        break;
      case 'withdraw':
        this.handlers.onWithdraw(this.readMoney('withdraw-input'));
        break;
      case 'borrow':
        this.handlers.onBorrow(this.readMoney('borrow-input'));
        break;
      case 'repay':
        this.handlers.onRepay(this.readMoney('repay-input'));
        break;
      case 'repay-all':
        this.handlers.onRepayAll();
        break;
      case 'select-security': {
        const id = target.dataset.security;
        if (id) {
          this.selectedSecurityId = id;
          if (this.lastView) this.paintBody(this.lastView);
        }
        break;
      }
      case 'buy':
        this.handlers.onBuyStock(
          this.selectedSecurityId,
          this.readShares('buy-input'),
          this.readPreviewPrice('buy-preview'),
        );
        break;
      case 'sell':
        this.handlers.onSellStock(
          this.selectedSecurityId,
          this.readShares('sell-input'),
          this.readPreviewPrice('sell-preview'),
        );
        break;
      case 'sell-all': {
        // 「填入全部持仓」只把数量填进输入框并刷新预览，不执行交易：
        // 卖出统一走「普通卖出 → 确认框 → 重新校验」，不存在一键清仓的旁路。
        const view = this.securitiesView(this.selectedSecurityId, this.currentOrder());
        const shares = view.selected?.shares ?? 0;
        if (shares <= 0) break;
        this.setInput('sell-input', String(shares));
        if (this.lastView) this.patchLive(this.lastView);
        break;
      }
      case 'quick-deposit':
        this.fillAmount('deposit-input', target.dataset.amount, 'cash');
        break;
      case 'quick-withdraw':
        this.fillAmount('withdraw-input', target.dataset.amount, 'savings');
        break;
      case 'borrow-quick':
        this.fillAmount('borrow-input', target.dataset.amount, 'none');
        break;
      case 'repay-quick':
        this.fillAmount('repay-input', target.dataset.amount, 'none');
        break;
      case 'buy-quick':
        this.fillShares('buy-input', target.dataset.shares);
        break;
      case 'sell-quick':
        this.fillShares('sell-input', target.dataset.shares);
        break;
      case 'save':
        this.handlers.onSave();
        break;
      case 'load':
        this.handlers.onLoad();
        break;
      case 'export':
        this.handlers.onExport();
        break;
      case 'new-game':
        this.handlers.onNewGame();
        break;
      case 'create-company':
        this.emit(action, target, this.handlers.onCreateCompany(
          this.readText('company-name'),
          this.readMoney('company-capital'),
        ));
        break;
      case 'fund-company':
        this.emit(action, target, this.handlers.onFundCompany(this.readMoney('fund-input')));
        break;
      case 'dividend':
        this.emit(action, target, this.handlers.onDividend(this.readMoney('dividend-input')));
        break;
      case 'dividend-all':
        this.emit(action, target, this.handlers.onDividendAll());
        break;
      case 'pause-company':
        this.emit(action, target, this.handlers.onPauseCompany());
        break;
      case 'resume-company':
        this.emit(action, target, this.handlers.onResumeCompany());
        break;
      case 'liquidate-company':
        this.emit(action, target, this.handlers.onLiquidateCompany());
        break;
      case 'advance-event':
        this.emit(action, target, this.handlers.onAdvanceEvent());
        break;
      case 'hire-talent':
        this.emit(action, target, this.handlers.onHireTalent(target.dataset.candidate ?? ''));
        break;
      case 'fire-talent':
        this.emit(action, target, this.handlers.onFireTalent());
        break;
      case 'invest-tech':
        this.emit(action, target, this.handlers.onInvestTech(this.readMoney('tech-input')));
        break;
      case 'start-research':
        this.emit(action, target, this.handlers.onStartResearch(
          this.readFocus('research-focus'),
          this.readInt('research-days'),
          this.readMoney('research-budget'),
        ));
        break;
      case 'cancel-research':
        this.emit(action, target, this.handlers.onCancelResearch());
        break;
      case 'release-product': {
        // 待发布产品的字段按产品 id 唯一，避免多款待发布产品互相串值
        const id = target.dataset.product ?? '';
        this.emit(action, target, this.handlers.onReleaseProduct(
          id,
          this.readText(`release-name-${id}`),
          this.readMoney(`release-price-${id}`),
          this.readMoney(`release-marketing-${id}`),
        ));
        break;
      }
      case 'save-price': {
        const id = target.dataset.product ?? '';
        this.emit(action, target, this.handlers.onSetPrice(id, this.readMoney(`price-${id}`)));
        break;
      }
      case 'save-marketing': {
        const id = target.dataset.product ?? '';
        this.emit(
          action,
          target,
          this.handlers.onSetMarketing(id, this.readMoney(`marketing-${id}`)),
        );
        break;
      }
      case 'stop-product':
        this.emit(action, target, this.handlers.onStopProduct(target.dataset.product ?? ''));
        break;
      case 'request-financing':
        this.emit(action, target, this.handlers.onRequestFinancing(this.readMoney('financing-input')));
        break;
      case 'accept-quote':
        this.emit(action, target, this.handlers.onAcceptQuote(target.dataset.quote ?? ''));
        break;
      case 'reject-quotes':
        this.emit(action, target, this.handlers.onRejectQuotes());
        break;
      case 'list-company':
        this.emit(action, target, this.handlers.onListCompany());
        break;
      case 'buyback':
        this.emit(
          action,
          target,
          this.handlers.onBuyback(
            target.dataset.company ?? '',
            this.readShares('buyback-input'),
            this.readPreviewPrice('buyback-preview'),
          ),
        );
        break;
      case 'promote':
        this.emit(action, target, this.handlers.onPromote(this.readMoney('promotion-input')));
        break;
      case 'appoint-ceo':
        this.emit(
          action,
          target,
          this.handlers.onAppointCeo(
            target.dataset.company ?? '',
            target.dataset.holder ?? '',
          ),
        );
        break;
      case 'remove-ceo':
        this.emit(
          action,
          target,
          this.handlers.onRemoveCeo(
            target.dataset.company ?? '',
            target.dataset.holder ?? '',
          ),
        );
        break;
      case 'vote-proposal': {
        const vote = target.dataset.vote;
        if (vote !== 'yes' && vote !== 'no' && vote !== 'abstain') break;
        this.emit(
          action,
          target,
          this.handlers.onVoteProposal(
            target.dataset.company ?? '',
            target.dataset.proposal ?? '',
            vote,
          ),
        );
        break;
      }
      case 'inv-use': {
        const itemId = target.dataset.item;
        if (!itemId) break;
        const requestId = this.personal.takeUseRequestId(itemId);
        this.emit(action, target, this.handlers.onUseItem(itemId, requestId));
        break;
      }
      default:
        break;
    }
  };

  /** 输入事件：交易预览立即刷新；政府/便利店数量实时写入内存草稿。 */
  private handleInput = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (this.current === 'government' && this.government.handleInput(target)) return;
    if (this.current === 'shop' && this.shop.handleInput(target)) return;
    const name = target.getAttribute('data-el');
    if (name !== 'buy-input' && name !== 'sell-input') return;
    if (this.current !== 'securities' || !this.lastView) return;
    this.patchLive(this.lastView);
  };

  private handleChange = (event: Event): void => {    const target = event.target;
    if (this.current === 'personal') {
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
        if (this.personal.handleChange(target)) return;
      }
    }
    if (!(target instanceof HTMLInputElement)) return;
    if (target.getAttribute('data-el') !== 'import-input') return;
    const file = target.files?.[0];
    if (file) this.handlers.onImportFile(file);
    target.value = '';
  };

  /**
   * 命令执行结果回传给人物界面：只有明确成功才清理对应草稿，
   * 界面不靠「状态好像变了」去猜提交是否成功。
   */
  private emit(action: string, el: HTMLElement, outcome: CommandOutcome): void {
    if (this.current === 'personal' && outcome.ok) this.personal.handleSubmitted(action, el);
  }

  private readMoney(name: string): number {
    const input = this.root.querySelector<HTMLInputElement>(`[data-el="${name}"]`);
    if (!input) return 0;
    const yuan = Number(input.value.replace(/,/g, '').trim());
    if (!Number.isFinite(yuan) || yuan <= 0) return 0;
    return Math.round(yuan * 100);
  }

  private readText(name: string): string {
    const input = this.root.querySelector<HTMLInputElement>(`[data-el="${name}"]`);
    return input ? input.value.trim() : '';
  }

  private readInt(name: string): number {
    const input = this.root.querySelector<HTMLInputElement>(`[data-el="${name}"]`);
    if (!input) return 0;
    const value = Number(input.value.trim());
    return Number.isFinite(value) ? Math.round(value) : 0;
  }

  private readFocus(name: string): FocusKey {
    const select = this.root.querySelector<HTMLSelectElement>(`[data-el="${name}"]`);
    const value = select?.value;
    if (value === 'reliability' || value === 'usability' || value === 'performance') return value;
    return 'performance';
  }

  private readShares(name: string): number {
    const input = this.root.querySelector<HTMLInputElement>(`[data-el="${name}"]`);
    if (!input) return 0;
    const shares = Number(input.value.trim());
    if (!Number.isSafeInteger(shares) || shares <= 0) return 0;
    return shares;
  }

  /** 当前输入框里的数量：交易预览与提交都用同一份数量。 */
  private currentOrder(): SecuritiesOrderQuery {
    return {
      buyShares: this.readShares('buy-input'),
      sellShares: this.readShares('sell-input'),
    };
  }

  /** 预览节点上记录的成交均价：提交时用它判断「玩家确认过的价格」是否已变化。 */
  private readPreviewPrice(name: string): number | null {
    const node = this.root.querySelector<HTMLElement>(`[data-el="${name}"]`);
    const raw = node?.dataset.price;
    if (!raw) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  private fillAmount(
    inputName: string,
    amount: string | undefined,
    source: 'cash' | 'savings' | 'none',
  ): void {
    if (!this.lastView) return;
    let cents: number;
    if (amount === 'all' && source === 'cash') {
      cents = this.lastView.money.cash;
    } else if (amount === 'all' && source === 'savings') {
      cents = this.lastView.money.savings;
    } else {
      cents = Math.round(Number(amount ?? '0') * 100);
    }
    if (!Number.isFinite(cents) || cents <= 0) return;
    this.setInput(inputName, String(cents / 100));
  }

  private fillShares(inputName: string, shares: string | undefined): void {
    if (!this.lastView) return;
    if (shares === 'max') {
      const count = this.securitiesView(this.selectedSecurityId, this.currentOrder()).maxBuy;
      if (count <= 0) return;
      this.setInput(inputName, String(count));
      return;
    }
    const value = Number(shares ?? '0');
    if (!Number.isSafeInteger(value) || value <= 0) return;
    this.setInput(inputName, String(value));
  }

  private setInput(name: string, value: string): void {
    const input = this.root.querySelector<HTMLInputElement>(`[data-el="${name}"]`);
    if (!input) return;
    input.value = value;
    input.focus();
  }
}
