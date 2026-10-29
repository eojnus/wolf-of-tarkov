/**
 * 业务面板路由 —— 统一窗口 + 五大功能分类。
 *
 * 界面纪律不变：
 *  - 只渲染只读视图，所有写操作都以回调交给 app 层的命令；
 *  - 面板自身不持有任何经济状态，时间在窗口打开期间照常流逝；
 *  - 输入有焦点或正按住鼠标时不重建 DOM，只更新标记了 data-live 的数值节点。
 *
 * 本轮新增的只有「怎么组织」：一个窗口、一个左侧分类导航。
 * 现场的入口（银行、公司、住宅、证券中心、政府、便利店）仍然只在对应建筑里出现，
 * 不会因为分类重排把现场办理的操作变成远程操作。
 */

import { formatMoneyCompact } from '../core/money';
import { BRANDING, CONVENIENCE_STORE_NAME, TIME } from '../content/config';
import type { FocusKey } from '../content/business';
import type { GameViewModel, PriceDirection } from '../app/view';
import { PersonalPanel, type CapitalMode } from './personal-panel';
import { GovernmentPanel, type GovernmentTab, type GovernmentUiHandlers } from './government-panel';
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
import { GameWindow, type NavGroup, type WindowChrome } from './game-window';
import type { IconName } from './icons';
import { renderBank, renderPause } from './life-panels';
import {
  estateHeadline,
  renderEstate,
  renderEstateBrief,
  renderRestBlock,
} from './estate-panel';
import type { EstateSectionView } from '../app/real-estate-view';
import { destroyStockCharts, paintStockCharts, type ChartInput } from './stock-chart';

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
  /** TAB 时间工具区：暂停/继续手动暂停，只走既有命令。 */
  onTogglePause(): void;
  /** TAB 时间工具区：速度档位，沿用 TIME.speedOptions 与既有命令语义。 */
  onSetSpeed(speed: number): void;
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
  /** 房地产：现场买入住宅（价格与挂牌版本在提交时重新校验）。 */
  onBuyHome(propertyId: string, priceCents: number, listingVersion: number): CommandOutcome;
  /** 房地产：受让城市储备土地。 */
  onBuyLand(propertyId: string, priceCents: number): CommandOutcome;
  /** 房地产：挂牌或改价（带期望版本）。 */
  onListHome(propertyId: string, priceCents: number, expectedVersion: number): CommandOutcome;
  /** 房地产：撤销挂牌（带期望版本）。 */
  onCancelListing(propertyId: string, expectedVersion: number): CommandOutcome;
  /** 房地产：接受 AI 土地收购报价。 */
  onAcceptOffer(offerId: string, priceCents: number): CommandOutcome;
  /** 房地产：拒绝 AI 土地收购报价。 */
  onRejectOffer(offerId: string): CommandOutcome;
  /** 从晴川公寓现场进入个人住宅（权限由 app 层按现场与永久居住权重新校验）。 */
  onEnterHome(): void;
}

/** 建筑入口在地点上的含义：用于标题栏的地点说明，不参与任何业务判断。 */
const ENTRY_META: Record<
  PanelId,
  { place: string | null; short: string | null; kicker: string; title: string; sub: string }
> = {
  bank: {
    place: `${BRANDING.cityStem}银行`,
    short: '银行',
    kicker: '个人生活',
    title: '银行业务',
    sub: '存取款与个人贷款只改变资金形态与负债，不改变净资产口径。',
  },
  office: {
    place: `${BRANDING.cityStem}实业大厦`,
    short: '实业大厦',
    kicker: '个人生活',
    title: '工作',
    sub: '入职与上班需要在本公司现场完成；上班会同时推进时间。',
  },
  home: {
    place: '晴川公寓',
    short: '晴川公寓',
    kicker: '个人生活',
    title: '住房与土地',
    sub: '现场可买卖住宅与储备土地；休息会推进时间，时间照常跨过行情、计息与月结节点。',
  },
  securities: {
    place: `${BRANDING.cityStem}证券中心`,
    short: '证券中心',
    kicker: '投资市场',
    title: '行情与交易',
    sub: '买卖按即时价格成交，用银行存款结算，只是资产形态转换。',
  },
  government: {
    place: `${BRANDING.cityStem}管理式民主政府`,
    short: '市政府',
    kicker: '城市事务',
    title: '人口与民意',
    sub: '人口统计、政治群体、政府结构、选举与建设。窗口打开时模拟继续。',
  },
  shop: {
    place: CONVENIENCE_STORE_NAME,
    short: '便利店',
    kicker: '个人生活',
    title: '便利店补给',
    sub: '购买食品饮料、入职或切换便利店岗位。只有站在店里才能购买。',
  },
  personal: {
    place: null,
    short: null,
    kicker: '个人生活',
    title: '人物总览',
    sub: '人物状态、背包、工作、个人财务与住房。',
  },
  pause: {
    place: null,
    short: null,
    kicker: '系统菜单',
    title: '游戏菜单',
    sub: '模拟时间已停止。继续游戏会重新锁定鼠标。',
  },
};

type GroupKey = 'life' | 'business' | 'market' | 'city' | 'system';
type Owner = 'personal' | 'government' | 'shop' | 'router';

interface SectionSpec {
  readonly key: string;
  readonly group: GroupKey;
  readonly label: string;
  readonly icon: IconName;
  /** 需要站在该地点才能进入的分类 */
  readonly requires?: PanelId;
  /** 站在该地点时追加现场办理内容 */
  readonly onsite?: PanelId;
  readonly owner: Owner;
  /** 交给 PersonalPanel 渲染时对应的栏目 */
  readonly personal?: PersonalSection;
}

const SECTIONS: readonly SectionSpec[] = [
  // 个人（Tab 人物管理）
  { key: 'life.overview', group: 'life', label: '人物总览', icon: 'user', owner: 'personal', personal: 'overview' },
  { key: 'life.inventory', group: 'life', label: '背包', icon: 'backpack', owner: 'personal', personal: 'inventory' },
  { key: 'life.work', group: 'life', label: '工作', icon: 'briefcase', owner: 'personal', personal: 'work', onsite: 'office' },
  { key: 'life.finance', group: 'life', label: '个人财务', icon: 'wallet', owner: 'personal', personal: 'finance' },
  { key: 'life.stocks', group: 'life', label: '股票持仓', icon: 'chart-pie', owner: 'personal', personal: 'stocks' },
  // 现场办理页：只有站在对应设施前才出现在导航里
  { key: 'life.bank', group: 'life', label: '银行业务', icon: 'banknote', owner: 'router', requires: 'bank' },
  { key: 'life.housing', group: 'life', label: '住房与土地', icon: 'house', owner: 'router', onsite: 'home', requires: 'home' },
  { key: 'life.shop', group: 'life', label: '便利店补给', icon: 'store', owner: 'shop', requires: 'shop' },

  // 我的公司
  { key: 'biz.overview', group: 'business', label: '公司概览', icon: 'building-2', owner: 'personal', personal: 'company' },
  { key: 'biz.research', group: 'business', label: '产品与研发', icon: 'factory', owner: 'personal', personal: 'company' },
  { key: 'biz.talent', group: 'business', label: '人才', icon: 'users', owner: 'personal', personal: 'company' },
  { key: 'biz.market', group: 'business', label: '市场与竞品', icon: 'chart-line', owner: 'personal', personal: 'company' },
  { key: 'biz.finance', group: 'business', label: '企业财务', icon: 'banknote', owner: 'personal', personal: 'company' },
  { key: 'biz.ops', group: 'business', label: '日常经营', icon: 'megaphone', owner: 'personal', personal: 'company' },
  { key: 'biz.governance', group: 'business', label: '公司治理', icon: 'handshake', owner: 'personal', personal: 'company' },

  // 投资市场（证券中心现场）
  { key: 'market.quotes', group: 'market', label: '行情与交易', icon: 'chart-line', owner: 'router', requires: 'securities' },
  { key: 'market.company', group: 'market', label: '公司详情', icon: 'file-text', owner: 'router', requires: 'securities' },
  { key: 'market.capital', group: 'market', label: '公司与资本', icon: 'handshake', owner: 'personal', personal: 'company', requires: 'securities' },

  // 城市事务
  { key: 'city.economy', group: 'city', label: '城市经济', icon: 'chart-line', owner: 'government', requires: 'government' },
  { key: 'city.population', group: 'city', label: '人口与民意', icon: 'users', owner: 'government', requires: 'government' },
  { key: 'city.government', group: 'city', label: '政府', icon: 'landmark', owner: 'government', requires: 'government' },
  { key: 'city.election', group: 'city', label: '选举与赞助', icon: 'vote', owner: 'government', requires: 'government' },
  { key: 'city.build', group: 'city', label: '建设与城区', icon: 'hammer', owner: 'government', requires: 'government' },
  { key: 'city.history', group: 'city', label: '历史记录', icon: 'clipboard-list', owner: 'government', requires: 'government' },

  // 系统菜单（Esc / HUD）
  { key: 'sys.menu', group: 'system', label: '保存与菜单', icon: 'save', owner: 'router', requires: 'pause' },
  { key: 'sys.about', group: 'system', label: '游戏信息', icon: 'circle-help', owner: 'router' },
];

const GROUPS: ReadonlyArray<{ key: GroupKey; label: string; icon: IconName }> = [
  { key: 'life', label: '个人', icon: 'user' },
  { key: 'business', label: '我的公司', icon: 'briefcase-business' },
  { key: 'market', label: '投资市场', icon: 'chart-candlestick' },
  { key: 'city', label: '城市事务', icon: 'landmark' },
  { key: 'system', label: '系统菜单', icon: 'settings' },
];

/**
 * 每个打开入口能看到哪些栏目 —— 不在表里的栏目既不显示也不可切换，
 * 因此不存在「顶层按钮藏起来、子页还能点进去」的中间状态。
 */
const ENTRY_SECTIONS: Record<PanelId, readonly string[]> = {
  personal: [
    'life.overview',
    'life.inventory',
    'life.work',
    'life.finance',
    'life.stocks',
    'biz.overview',
    'biz.research',
    'biz.talent',
    'biz.market',
    'biz.finance',
    'biz.ops',
    'biz.governance',
  ],
  bank: ['life.bank'],
  office: ['life.work'],
  home: ['life.housing'],
  shop: ['life.shop'],
  securities: ['market.quotes', 'market.company', 'market.capital'],
  government: ['city.economy', 'city.population', 'city.government', 'city.election', 'city.build', 'city.history'],
  pause: ['sys.menu', 'sys.about'],
};

/** 建筑入口默认落在哪个栏目上（必须在 ENTRY_SECTIONS 里）。 */
const ENTRY_SECTION: Record<PanelId, string> = {
  bank: 'life.bank',
  office: 'life.work',
  home: 'life.housing',
  securities: 'market.quotes',
  government: 'city.population',
  shop: 'life.shop',
  personal: 'life.overview',
  pause: 'sys.menu',
};

/** 城市事务分类 → 政府面板栏目。人口与民意在同一页里合并且不重复取数。 */
const CITY_TABS: Record<string, readonly GovernmentTab[]> = {
  'city.economy': ['economy'],
  'city.population': ['population', 'politics'],
  'city.government': ['structure'],
  'city.election': ['campaign'],
  'city.build': ['development'],
  'city.history': ['history'],
};

/** 公司栏目对应的公司子页。 */
const BIZ_SUB: Record<
  string,
  'overview' | 'research' | 'talent' | 'market' | 'finance' | 'capital' | 'actions'
> = {
  'biz.overview': 'overview',
  'biz.research': 'research',
  'biz.talent': 'talent',
  'biz.market': 'market',
  'biz.finance': 'finance',
  'biz.ops': 'actions',
  'biz.governance': 'capital',
  'market.capital': 'capital',
};

/**
 * 资本子页的两种形态（类型定义在 personal-panel）：
 *  - `full`：证券中心的「公司与资本」，含上市/融资/报价/回购/宣传与治理；
 *  - `governance`：人物界面「我的公司 › 公司治理」，只保留自有公司的股权、表决与任免。
 */
const CAPITAL_MODE: Record<string, CapitalMode> = {
  'biz.governance': 'governance',
  'market.capital': 'full',
};

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function priceTone(direction: PriceDirection): 'up' | 'down' | undefined {
  if (direction === 'up') return 'up';
  if (direction === 'down') return 'down';
  return undefined;
}

function stat(
  label: string,
  value: string,
  options?: { tone?: 'pos' | 'neg' | 'up' | 'down'; note?: string; live?: string },
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

function kv(label: string, value: string, tone?: 'pos' | 'neg'): string {
  const cls = tone ? ` ${tone}` : '';
  return `<div class="kv"><span class="k">${esc(label)}</span><span class="v num${cls}">${esc(value)}</span></div>`;
}

/* --------------------------------------------------- 局部刷新（data-live） */

type LiveTone = 'up' | 'down' | 'pos' | 'neg';

interface LiveSpec {
  readonly text: (view: GameViewModel, securities: SecuritiesPanelView | null) => string;
  readonly tone?: (view: GameViewModel, securities: SecuritiesPanelView | null) => LiveTone | null;
}

function maxBuyOf(view: SecuritiesPanelView | null): number {
  return view?.maxBuy ?? 0;
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

/**
 * 时间在窗口打开期间持续流逝：整体重建会打断输入或吞掉点击，
 * 所以纯数值节点标记 data-live，只在输入/按住鼠标时就地更新。
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
  'stock.buyNote': { text: (_view, securities) => securities?.buyNote ?? '当前无法买入' },
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

/* ------------------------------------------------------------ 行情绘制 */

/** 公司股份供给环形图：只画一个环（在售 / 未在售），不引入图表库。 */
function renderSharePie(detail: CompanyDetailView): string {
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  const ratio = Math.max(0, Math.min(100, detail.forSalePct)) / 100;
  const dash = circumference * ratio;
  const slice =
    dash > 0
      ? `<circle class="pie-slice" cx="60" cy="60" r="${radius}" stroke-dasharray="${dash.toFixed(
          2,
        )} ${(circumference - dash).toFixed(2)}" transform="rotate(-90 60 60)" stroke="#2b7c8f"></circle>`
      : '';
  const centerText = detail.totalShares > 0 ? detail.forSalePctText : '—';
  return `
    <div class="pie-wrap">
      <svg class="pie-chart" viewBox="0 0 120 120" role="img" aria-label="在售与未在售股份比例">
        <circle class="pie-track" cx="60" cy="60" r="${radius}"></circle>
        ${slice}
        <text class="pie-center-label" x="60" y="52">在售</text>
        <text class="pie-center-value" x="60" y="72">${esc(centerText)}</text>
        <text class="pie-center-sub" x="60" y="87">总股本 ${esc(detail.totalSharesText)}</text>
      </svg>
      <ul class="pie-legend">
        <li><i class="dot dot-sale"></i><span>在售</span><b>${esc(detail.forSaleText)}</b><em>${esc(
          detail.forSalePctText,
        )}</em></li>
        <li><i class="dot dot-unsold"></i><span>未在售</span><b>${esc(
          detail.notForSaleText,
        )}</b><em>${esc(detail.notForSalePctText)}</em></li>
      </ul>
    </div>`;
}

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
    <div class="note" style="margin-top:8px">${esc(detail.note)}</div>`;
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

/* ------------------------------------------------------------ 面板路由 */

export class PanelManager {
  private active: string | null = null;
  private entry: PanelId | null = null;
  private lastView: GameViewModel | null = null;
  private deferredView: GameViewModel | null = null;
  private pointerActive = false;
  private paintedScroll = 0;
  private readonly root: HTMLElement;
  private readonly win: GameWindow;
  /** TAB 标题栏的时间工具区：与窗口内容分离，不随栏目刷新重建。 */
  private timeToolsEl: HTMLElement | null = null;

  private readonly personal: PersonalPanel;
  private readonly government: GovernmentPanel;
  private readonly shop: ShopPanel;
  private selectedSecurityId = 'YH-01';
  /** 交易区的买卖模式：只存在内存，不进 GameState、不进存档。 */
  private tradeSide: 'buy' | 'sell' = 'buy';

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
    private readonly estateView: (onsite: boolean) => EstateSectionView,
  ) {
    this.root = root;
    this.win = new GameWindow(root, {
      onClose: () => this.handlers.onClose(),
      onSelectSection: (key) => this.selectSection(key),
    });
    this.personal = new PersonalPanel(personalView, {
      onsite: () => this.entry,
      view: () => this.lastView,
      estate: () => this.estateView(false),
      // 待办与持仓卡片同样受入口限制：切不到当前入口没有的栏目
      canOpen: (section) => this.allowedKeys().has(this.keyForSection(section)),
      navigate: (section) => {
        const key = this.keyForSection(section);
        // 只同步分类高亮与标题；栏目本身已经在 personal 内部切换完成
        if (key !== this.active && this.allowedKeys().has(key)) {
          this.active = key;
          this.applySection(true);
        }
      },
    });
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
    this.win.layout();
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

  /** 打开人物界面的指定分类（便利店「打开背包」快捷入口），同样受入口限制。 */
  openPersonalSection(section: PersonalSection): void {
    if (!this.win.isMounted) return;
    this.selectSection(this.keyForSection(section));
  }

  /** Esc：先关最上层股票浮窗；没有浮窗返回 false，交给上层关闭整个界面。 */
  handleEscape(): boolean {
    if (!this.personal.isMounted) return false;
    return this.personal.handleEscape();
  }

  get isOpen(): boolean {
    return this.active !== null;
  }

  get activePanel(): PanelId | null {
    return this.entry;
  }

  open(id: PanelId, view: GameViewModel): void {
    this.entry = id;
    this.lastView = view;
    this.deferredView = null;
    this.paintedScroll = 0;
    this.timeToolsEl = null;
    const allowed = this.allowedKeys();
    const landing = ENTRY_SECTION[id];
    this.active = allowed.has(landing) ? landing : (allowed.values().next().value ?? null);

    if (this.personal.isMounted) this.personal.teardown();
    destroyStockCharts(this.win.content);
    if (this.win.isMounted) this.win.unmount();
    this.root.innerHTML = '';

    const meta = ENTRY_META[id];
    this.win.mount({
      kicker: meta.kicker,
      title: meta.title,
      subtitle: meta.sub,
      place: meta.place,
    });
    // ESC 菜单走独立的全屏表现模式；其他入口保持普通浮动窗口
    this.win.setPresentation(id === 'pause' ? 'pause' : 'window');
    this.applySection(true);
    this.syncTimeTools(view.paused, view.speed);
  }

  close(): void {
    if (!this.win.isMounted) {
      this.active = null;
      this.entry = null;
      this.timeToolsEl = null;
      return;
    }
    this.active = null;
    this.deferredView = null;
    this.timeToolsEl = null;
    this.personal.teardown();
    destroyStockCharts(this.win.content);
    this.win.unmount();
    this.root.innerHTML = '';
    // 关闭即失去现场上下文：不留任何可被旧事件复用的入口权限
    this.entry = null;
  }

  /**
   * 状态变化后刷新当前分类。
   * 输入框有焦点或鼠标正按在窗口上时不重建 DOM，只更新 data-live 数值节点。
   */
  refresh(view: GameViewModel): void {
    this.lastView = view;
    if (!this.win.isMounted || !this.active) return;
    const spec = this.specOf(this.active);
    if (!spec) return;
    if (spec.owner === 'personal') {
      // 时间工具区不参与内容重建，但必须跟随暂停/速度变化（personal 分支会提前返回）
      this.syncTimeTools(view.paused, view.speed);
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

  /* ---------------------------------------------------------- 时间工具区 */

  /**
   * 构建 TAB 标题栏的时间工具组。
   * 暂停/继续与速度档位复用既有命令；休息/睡觉复用 TIME 配置与既有业务语义。
   */
  private ensureTimeTools(): HTMLElement {
    if (this.timeToolsEl) return this.timeToolsEl;
    const el = document.createElement('div');
    el.className = 'gw-time-tools';
    el.innerHTML = `
      <button type="button" class="gw-tool" data-time-action="toggle">暂停</button>
      <span class="gw-tool-divider"></span>
      ${TIME.speedOptions
        .map(
          (speed) =>
            `<button type="button" class="gw-tool" data-time-action="speed" data-speed="${speed}">${speed}×</button>`,
        )
        .join('')}
      <span class="gw-tool-divider"></span>
      <button type="button" class="gw-tool" data-time-action="rest">休息 1 小时</button>
      <button type="button" class="gw-tool" data-time-action="sleep">睡到早上</button>
    `;
    this.timeToolsEl = el;
    return el;
  }

  /** 只同步按钮文本与高亮，不重建节点、不影响输入焦点与滚动。 */
  syncTimeTools(paused: boolean, speed: number): void {
    const el = this.timeToolsEl;
    if (!el) return;
    const toggle = el.querySelector<HTMLElement>('[data-time-action="toggle"]');
    if (toggle) {
      const text = paused ? '继续' : '暂停';
      if (toggle.textContent !== text) toggle.textContent = text;
      toggle.classList.toggle('is-active', paused);
    }
    for (const button of el.querySelectorAll<HTMLElement>('[data-time-action="speed"]')) {
      const value = Number(button.dataset.speed);
      button.classList.toggle('is-active', !paused && value === speed);
    }
  }

  private dispatchTimeAction(target: HTMLElement): void {
    const action = target.dataset.timeAction;
    if (action === 'toggle') {
      this.handlers.onTogglePause();
      return;
    }
    if (action === 'speed') {
      const speed = Number(target.dataset.speed);
      if (TIME.speedOptions.includes(speed)) this.handlers.onSetSpeed(speed);
      return;
    }
    if (action === 'rest') {
      this.handlers.onRest(TIME.restPresets[0]?.minutes ?? 60);
      return;
    }
    if (action === 'sleep') this.handlers.onSleep();
  }

  /* ---------------------------------------------------------- 分类切换 */

  private selectSection(key: string): void {
    if (key === this.active) return;
    if (!this.allowedKeys().has(key)) return;
    this.active = key;
    this.paintedScroll = 0;
    this.applySection(true);
  }

  private specOf(key: string): SectionSpec | null {
    return SECTIONS.find((item) => item.key === key) ?? null;
  }

  /** 人物界面内部栏目 → 栏目 key（待办、持仓卡片与快捷入口共用同一份映射）。 */
  private keyForSection(section: PersonalSection): string {
    if (section === 'stocks') return 'life.stocks';
    if (section === 'company') return 'biz.overview';
    return `life.${section}`;
  }

  /**
   * 当前入口可访问的栏目集合：
   * 既要在 ENTRY_SECTIONS 里，也要满足 `requires` 的现场条件（双重检查）。
   */
  private allowedKeys(): ReadonlySet<string> {
    const entry = this.entry;
    const allowed = new Set<string>();
    if (!entry) return allowed;
    for (const key of ENTRY_SECTIONS[entry]) {
      const spec = this.specOf(key);
      if (!spec) continue;
      if (spec.requires !== undefined && spec.requires !== entry) continue;
      allowed.add(key);
    }
    return allowed;
  }

  private navGroups(allowed: ReadonlySet<string>): NavGroup[] {
    return GROUPS.map((group) => ({
      key: group.key,
      label: group.label,
      icon: group.icon,
      items: SECTIONS.filter((item) => item.group === group.key && allowed.has(item.key)).map(
        (item) => ({ key: item.key, label: item.label, icon: item.icon }),
      ),
    })).filter((group) => group.items.length > 0);
  }

  /** 分类切换的唯一入口：同步导航、标题、内容归属与滚动位置。 */
  private applySection(resetScroll: boolean): void {
    const spec = this.active ? this.specOf(this.active) : null;
    if (!spec || !this.lastView) return;

    // 导航只列出当前入口真正能进的栏目，不再出现「看得见、点不进」的锁定项
    this.win.setNav(this.navGroups(this.allowedKeys()), spec.key);

    const meta = ENTRY_META[this.entry ?? 'personal'];
    const chrome = this.chromeFor(spec, meta);
    this.win.setChrome(chrome);

    // 时间工具只属于 TAB 标题栏；其他入口（含 ESC）不出现第二套时间控制
    if (this.entry === 'personal') this.win.setTools(this.ensureTimeTools());
    else this.win.setTools(null);

    this.mountContent(spec, this.lastView);
    if (resetScroll) this.win.scrollContentTo(0);
    else this.win.scrollContentTo(this.paintedScroll);
  }

  private chromeFor(spec: SectionSpec, meta: (typeof ENTRY_META)[PanelId]): WindowChrome {
    const sub =
      spec.onsite !== undefined && this.entry === spec.onsite
        ? `${groupLabel(spec.group)} · 现场办理`
        : `${groupLabel(spec.group)} · ${meta.place ?? '随身界面'}`;
    return {
      kicker: groupLabel(spec.group),
      title: spec.label,
      subtitle: sub,
      place: meta.place,
    };
  }

  private mountContent(spec: SectionSpec, view: GameViewModel): void {
    const content = this.win.content;
    if (!content) return;
    if (spec.owner === 'personal') {
      const section = spec.personal ?? 'overview';
      if (!this.personal.isMounted) {
        destroyStockCharts(content);
        this.personal.mount(content, this.win.floatLayer);
      }
      this.personal.setScope(
        section,
        BIZ_SUB[spec.key],
        CAPITAL_MODE[spec.key] ?? 'full',
      );
      return;
    }
    if (this.personal.isMounted) this.personal.teardown();
    destroyStockCharts(content);
    content.innerHTML = this.bodyHtml(spec, view);
    this.paintCharts(view);
  }

  private bodyHtml(spec: SectionSpec, view: GameViewModel): string {
    if (spec.owner === 'shop') return this.shop.renderBody();
    if (spec.owner === 'government') {
      const tabs = CITY_TABS[spec.key] ?? [];
      return `<div class="gw-section">${tabs
        .map((tab) => this.government.renderSection(tab))
        .join('')}</div>`;
    }
    switch (spec.key) {
      case 'life.bank':
        // 银行入口只提供银行业务本体：存取款与既有贷款，不再顺带展示整页个人财务
        return `<div class="gw-section">${renderBank(view)}</div>`;
      case 'life.housing': {
        // 住房与土地：晴川公寓现场办理交易与休息；其它上下文只给只读摘要（正常不可达）
        const onsite = this.entry === 'home';
        const estate = this.estateView(onsite);
        const head = `<div class="note">${esc(estateHeadline(estate))}</div>`;
        return `<div class="gw-section">${head}${
          onsite ? `${renderRestBlock(TIME.restPresets)}${renderEstate(estate)}` : renderEstateBrief(estate)
        }</div>`;
      }
      case 'market.quotes':
        return this.renderQuotes(view);
      case 'market.company':
        return this.renderCompany(view);
      case 'sys.menu':
        return `<div class="gw-section">${renderPause(view)}</div>`;
      case 'sys.about':
        return this.renderAbout(view);
      default:
        return '';
    }
  }

  /**
   * 重绘当前分类。
   *
   * 三件事必须在重绘后恢复：滚动位置、输入值、以及带有内部状态的图形节点。
   * 图形节点（K 线画布、人口环形图）用 `data-preserve` 标记后整体搬到新位置，
   * 这样数据刷新不会打断悬停、缩放与平移，提示框也不会反复闪烁。
   */
  private paintBody(view: GameViewModel): void {
    const content = this.win.content;
    const spec = this.active ? this.specOf(this.active) : null;
    if (!content || !spec) return;

    const scrollTop = this.win.contentScrollTop;
    this.paintedScroll = scrollTop;

    const values = new Map<string, string>();
    for (const input of content.querySelectorAll<HTMLInputElement>('input[data-el]')) {
      if (input.dataset.el) values.set(input.dataset.el, input.value);
    }
    const active = document.activeElement;
    const activeName = active instanceof HTMLElement ? active.getAttribute('data-el') : null;
    const caret = active instanceof HTMLInputElement ? active.selectionStart : null;

    const preserved = new Map<string, HTMLElement>();
    for (const node of content.querySelectorAll<HTMLElement>('[data-preserve]')) {
      const key = node.dataset.preserve;
      if (key && node.childElementCount > 0) preserved.set(key, node);
    }

    // Keep reusable charts alive; dispose only nodes that are actually removed.
    for (const node of preserved.values()) node.remove();
    destroyStockCharts(content);
    content.innerHTML = this.bodyHtml(spec, view);

    for (const slot of content.querySelectorAll<HTMLElement>('[data-preserve]')) {
      const key = slot.dataset.preserve;
      const node = key ? preserved.get(key) : undefined;
      if (node && node !== slot) slot.replaceWith(node);
    }

    for (const [name, value] of values) {
      const input = content.querySelector<HTMLInputElement>(`[data-el="${name}"]`);
      if (input) input.value = value;
    }
    if (activeName) {
      const next = content.querySelector<HTMLInputElement>(`[data-el="${activeName}"]`);
      if (next) {
        next.focus();
        if (caret !== null) next.setSelectionRange(caret, caret);
      }
    }

    this.win.scrollContentTo(scrollTop);
    this.paintCharts(view);
  }

  /** 只更新数值/文本节点，不触碰 DOM 结构。 */
  private patchLive(view: GameViewModel): void {
    const securities = this.securitiesOf();
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
    if (this.active?.startsWith('city.')) this.government.patchLive(this.root);
    if (this.active === 'life.shop') this.shop.patchLive(this.root);
    this.paintCharts(view);
  }

  /**
   * 原地刷新「公司详情 · 股份供给」区块（含环形图）。
   * 该区块不含交易输入框，替换 innerHTML 不会打断输入、焦点或滚动。
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

  private handleFocusOut = (): void => {
    if (!this.deferredView) return;
    const view = this.deferredView;
    this.deferredView = null;
    window.setTimeout(() => {
      if (!this.active) return;
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
      if (!this.active) return;
      this.paintBody(view);
    }, 0);
  };

  /* ------------------------------------------------------------ 动作派发 */

  private handleClick = (event: MouseEvent): void => {
    const timeTarget = (event.target as HTMLElement).closest<HTMLElement>('[data-time-action]');
    if (timeTarget) {
      this.dispatchTimeAction(timeTarget);
      return;
    }
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    if (!action) return;

    // 各内容组件先处理自己的动作
    if (this.personal.isMounted && !action.startsWith('gov-') && !action.startsWith('shop-')) {
      if (action !== 'close' && action !== 'resume' && this.personal.handleAction(action, target)) {
        return;
      }
    }
    if (action.startsWith('gov-')) {
      if (this.government.handleAction(action, target)) {
        if (this.lastView) this.paintBody(this.lastView);
        return;
      }
    }
    if (action.startsWith('shop-')) {
      if (this.shop.handleAction(action, target)) {
        if (this.active === 'life.shop' && this.lastView) this.paintBody(this.lastView);
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
        if (id && id !== this.selectedSecurityId) {
          this.selectedSecurityId = id;
          // 换标的必须丢掉旧标的的数量草稿与预览：不能把上一只股票的数量当作这一只的输入
          this.clearTradeDrafts();
          if (this.lastView) this.paintBody(this.lastView);
        }
        break;
      }
      case 'trade-side': {
        const side = target.dataset.side;
        if ((side === 'buy' || side === 'sell') && side !== this.tradeSide) {
          this.tradeSide = side;
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
        // 「填入全部持仓」只把数量填进输入框并刷新预览，不执行交易
        const view = this.securitiesOf();
        const shares = view?.selected?.shares ?? 0;
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
      case 're-buy-home': {
        const propertyId = target.dataset.property ?? '';
        const priceCents = Number(target.dataset.price ?? '0');
        const version = Number(target.dataset.version ?? '0');
        this.handlers.onBuyHome(propertyId, priceCents, version);
        break;
      }
      case 'enter-home':
        this.handlers.onEnterHome();
        break;
      case 're-buy-land': {
        const propertyId = target.dataset.property ?? '';
        const priceCents = Number(target.dataset.price ?? '0');
        this.handlers.onBuyLand(propertyId, priceCents);
        break;
      }
      case 're-list-home': {
        const propertyId = target.dataset.property ?? '';
        const version = Number(target.dataset.version ?? '0');
        this.handlers.onListHome(
          propertyId,
          this.readMoney(`re-price-${propertyId}`),
          version,
        );
        break;
      }
      case 're-cancel-listing': {
        const propertyId = target.dataset.property ?? '';
        const version = Number(target.dataset.version ?? '0');
        this.handlers.onCancelListing(propertyId, version);
        break;
      }
      case 're-accept-offer': {
        this.handlers.onAcceptOffer(
          target.dataset.offer ?? '',
          Number(target.dataset.price ?? '0'),
        );
        break;
      }
      case 're-reject-offer':
        this.handlers.onRejectOffer(target.dataset.offer ?? '');
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
        this.emit(
          action,
          target,
          this.handlers.onCreateCompany(this.readText('company-name'), this.readMoney('company-capital')),
        );
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
        this.emit(
          action,
          target,
          this.handlers.onStartResearch(
            this.readFocus('research-focus'),
            this.readInt('research-days'),
            this.readMoney('research-budget'),
          ),
        );
        break;
      case 'cancel-research':
        this.emit(action, target, this.handlers.onCancelResearch());
        break;
      case 'release-product': {
        // 待发布产品的字段按产品 id 唯一，避免多款待发布产品互相串值
        const id = target.dataset.product ?? '';
        this.emit(
          action,
          target,
          this.handlers.onReleaseProduct(
            id,
            this.readText(`release-name-${id}`),
            this.readMoney(`release-price-${id}`),
            this.readMoney(`release-marketing-${id}`),
          ),
        );
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
          this.handlers.onAppointCeo(target.dataset.company ?? '', target.dataset.holder ?? ''),
        );
        break;
      case 'remove-ceo':
        this.emit(
          action,
          target,
          this.handlers.onRemoveCeo(target.dataset.company ?? '', target.dataset.holder ?? ''),
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

  /** 输入事件：交易预览立即刷新；政府/便利店的数量实时写入内存草稿。 */
  private handleInput = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (this.active?.startsWith('city.') && this.government.handleInput(target)) return;
    if (this.active === 'life.shop' && this.shop.handleInput(target)) return;
    const name = target.getAttribute('data-el');
    if (name !== 'buy-input' && name !== 'sell-input') return;
    if (!this.lastView) return;
    if (this.active !== 'market.quotes') return;
    this.patchLive(this.lastView);
  };

  private handleChange = (event: Event): void => {
    const target = event.target;
    if (this.personal.isMounted) {
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
    if (this.personal.isMounted && outcome.ok) this.personal.handleSubmitted(action, el);
  }

  /* --------------------------------------------------------------- 取值 */

  private securitiesOf(): SecuritiesPanelView | null {
    if (!this.active) return null;
    if (this.active !== 'market.quotes' && this.active !== 'market.company') {
      return null;
    }
    return this.securitiesView(this.selectedSecurityId, this.currentOrder());
  }

  /** 清空交易输入与预览价格：切换标的后不复用旧的数量与成交价。 */
  private clearTradeDrafts(): void {
    for (const name of ['buy-input', 'sell-input']) {
      const input = this.root.querySelector<HTMLInputElement>(`[data-el="${name}"]`);
      if (input) input.value = '';
    }
    for (const name of ['buy-preview', 'sell-preview']) {
      const node = this.root.querySelector<HTMLElement>(`[data-el="${name}"]`);
      if (node) delete node.dataset.price;
    }
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
      const count = this.securitiesOf()?.maxBuy ?? 0;
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

  /* --------------------------------------------------------- 行情与交易 */

  private renderSecurityTabs(view: SecuritiesPanelView): string {
    if (view.rows.length === 0) return '';
    return `<div class="sec-tabs">${view.rows
      .map(
        (row) =>
          `<button type="button" class="btn btn-sm sec-tab${row.selected ? ' is-active' : ''}" data-action="select-security" data-security="${esc(
            row.id,
          )}">${esc(row.symbol)} · ${esc(row.priceText)} · ${esc(row.changePctText)}${
            row.holdingText !== '—' ? ` · ${esc(row.holdingText)}` : ''
          }</button>`,
      )
      .join('')}</div>`;
  }

  private renderQuoteHead(view: SecuritiesPanelView): string {
    const selected = view.selected;
    if (!selected) return '';
    const tone = priceTone(selected.direction) ?? '';
    return `
      <div class="quote-head">
        <div>
          <div class="quote-name">${esc(selected.name)}</div>
          <div class="quote-meta">
            <span class="quote-code">${esc(selected.symbol)}</span>
            <span>${esc(selected.statusText)}</span>
            <span>下次行情 <span data-live="stock.nextTick">${esc(view.nextTickText)}</span></span>
          </div>
        </div>
        <div class="quote-price">
          <div class="quote-last num ${tone}" data-live="stock.price">${esc(selected.priceText)}</div>
          <div class="quote-delta num ${tone}" data-live="stock.change">${esc(selected.changeText)} · ${esc(
            selected.changePctText,
          )}</div>
          <div class="quote-extra">每 ${view.tickMinutes} 游戏分钟一根 K 线</div>
        </div>
      </div>`;
  }

  /**
   * 行情与交易合成一页：选股与行情摘要 → K 线 → 同一标的的交易区 → 必要持仓资料。
   * 交易片段只渲染一次，不再嵌入完整交易页，因此没有重复的标题、选择器与事件监听。
   */
  private renderQuotes(view: GameViewModel): string {
    const securities = this.securitiesView(this.selectedSecurityId, this.currentOrder());
    const selected = securities.selected;
    if (!selected) {
      return `<div class="gw-section"><div class="empty">暂无可用证券</div></div>`;
    }
    const emptyText = securities.companyDetail.terminated
      ? '该证券已终止，不再生成行情'
      : '正在积累行情，第一根 K 线形成后才能绘图';
    return `<div class="gw-section">
      ${this.renderSecurityTabs(securities)}
      ${this.renderQuoteHead(securities)}
      <div class="block">
        <div class="chart-block" data-preserve="quote-chart">
          <div class="chart-frame" style="height:340px">
            <canvas data-chart="quote" data-stock="${esc(this.selectedSecurityId)}"></canvas>
            <div class="chart-tip" data-chart-tip hidden></div>
            <div class="chart-empty" data-chart-empty>${esc(emptyText)}</div>
          </div>
          <div class="chart-toolbar">
            <div class="chart-legend" data-chart-legend></div>
            <div class="actions">
              <span>滚轮缩放 · 拖动平移</span>
              <button type="button" class="btn btn-sm btn-ghost" data-chart-reset>返回最新</button>
            </div>
          </div>
        </div>
        <div class="note" style="margin-top:6px">${esc(securities.spanText)} · 每 ${securities.tickMinutes} 分钟一根 K 线 · ${esc(securities.companyNote)}</div>
      </div>
      <div class="sec-layout">
        <div class="sec-main">${this.renderTradeArea(securities)}</div>
        <div class="sec-side">${this.renderHoldingSide(selected, view)}</div>
      </div>
      <div class="block">
        <div class="block-title">全部标的</div>
        ${this.renderHoldingsTable(securities)}
      </div>
      <div class="note">公司证券价格按经营估值锚定并有界波动；独立证券保持零趋势随机。交易使用真实账户与真实股份库存，公司融资与回购也会进入同一价格历史。成交量与历史分钟数据当前没有实现，界面不显示也不推算这些字段。</div>
    </div>`;
  }

  /** 交易区：买入/卖出只是同一块表单的两种模式，提交仍各走原命令一次。 */
  private renderTradeArea(securities: SecuritiesPanelView): string {
    const tradeDisabled = securities.companyDetail.terminated;
    const buy = this.tradeSide === 'buy';
    return `<div class="block">
      <div class="block-title">交易 · 银行存款结算</div>
      <div class="sec-switch" role="group" aria-label="选择买入或卖出">
        <button type="button" class="sec-switch-item${buy ? ' is-active' : ''}" data-action="trade-side" data-side="buy" aria-pressed="${buy}">买入</button>
        <button type="button" class="sec-switch-item${buy ? '' : ' is-active'}" data-action="trade-side" data-side="sell" aria-pressed="${!buy}">卖出</button>
      </div>
      ${buy ? this.renderBuyForm(securities, tradeDisabled) : this.renderSellForm(securities, tradeDisabled)}
    </div>`;
  }

  private renderBuyForm(securities: SecuritiesPanelView, tradeDisabled: boolean): string {
    return `
      <div class="field-row">
        <input class="field" data-el="buy-input" inputmode="numeric" placeholder="买入股数" ${
          tradeDisabled ? 'disabled' : ''
        } />
        <button type="button" class="btn btn-primary" data-action="buy" ${
          securities.maxBuy > 0 && !tradeDisabled ? '' : 'disabled'
        }>买入</button>
      </div>
      <div class="quick-row">
        ${[10, 50, 100]
          .map(
            (count) =>
              `<button type="button" class="btn btn-sm" data-action="buy-quick" data-shares="${count}" ${
                tradeDisabled ? 'disabled' : ''
              }>${count} 股</button>`,
          )
          .join('')}
        <button type="button" class="btn btn-sm" data-action="buy-quick" data-shares="max" ${
          tradeDisabled ? 'disabled' : ''
        }><span data-live="stock.maxBuyLabel">最多 ${securities.maxBuy} 股</span></button>
      </div>
      <div class="note" style="margin-top:8px" data-live="stock.buyNote">${esc(securities.buyNote)}</div>
      <div class="note preview-line" data-el="buy-preview"${
        securities.buyPreview && securities.buyPreview.executableShares > 0
          ? ` data-price="${securities.buyPreview.priceCents}"`
          : ''
      } data-live="trade.buyPreview">${esc(
        previewText(securities.buyPreview, '输入买入股数后显示这一笔的均价、总额与价格影响'),
      )}</div>
      <div class="note" style="margin-top:6px">成交价由业务预览决定：确认后价格或数量变化会要求重新确认，不静默换价、不缩量。</div>`;
  }

  private renderSellForm(securities: SecuritiesPanelView, tradeDisabled: boolean): string {
    return `
      <div class="field-row">
        <input class="field" data-el="sell-input" inputmode="numeric" placeholder="卖出股数" ${
          tradeDisabled ? 'disabled' : ''
        } />
        <button type="button" class="btn" data-action="sell" ${
          securities.maxSell > 0 && !tradeDisabled ? '' : 'disabled'
        }>卖出</button>
      </div>
      <div class="quick-row">
        <button type="button" class="btn btn-sm" data-action="sell-quick" data-shares="10" ${
          tradeDisabled ? 'disabled' : ''
        }>10 股</button>
        <button type="button" class="btn btn-sm" data-action="sell-all" ${
          securities.maxSell > 0 && !tradeDisabled ? '' : 'disabled'
        }>填入全部持仓</button>
      </div>
      <div class="note" style="margin-top:8px">${esc(securities.sellNote)}</div>
      <div class="note preview-line" data-el="sell-preview"${
        securities.sellPreview && securities.sellPreview.executableShares > 0
          ? ` data-price="${securities.sellPreview.priceCents}"`
          : ''
      } data-live="trade.sellPreview">${esc(
        previewText(securities.sellPreview, '输入卖出股数后显示这一笔的均价、总额与价格影响'),
      )}</div>
      <div class="note" style="margin-top:6px">「填入全部持仓」只会把持仓数量填进输入框并刷新预览，仍需点「卖出」并在确认框里确认数量与金额；卖出不会自动变成清仓。</div>`;
  }

  private renderHoldingSide(
    selected: SecuritiesPanelView['selected'],
    view: GameViewModel,
  ): string {
    if (!selected) return '';
    return `
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
          ${stat('可用于买入', view.money.savingsText, {
            live: 'money.savings',
            note: '买入只从银行存款扣款，现金不计入',
          })}
        </div>
      </div>
      <div class="block">
        <div class="block-title">买卖口径</div>
        <div class="note">成交价与预览价不一致时会明确拒绝，不会静默换价或缩量成交。买入受在售股份与银行存款限制，卖出只卖出你输入的数量；成交价由业务预览决定，不能手动填写。</div>
      </div>`;
  }

  private renderHoldingsTable(view: SecuritiesPanelView): string {
    if (view.rows.length === 0) return '<div class="empty">暂无可用证券</div>';
    const rows = view.rows
      .map(
        (row) => `<tr>
          <td>${esc(row.symbol)}</td>
          <td>${esc(row.priceText)}</td>
          <td class="num">${esc(row.changePctText)}</td>
          <td class="num">${esc(row.holdingText)}</td>
          <td><button type="button" class="btn btn-sm btn-ghost" data-action="select-security" data-security="${esc(
            row.id,
          )}">${row.selected ? '当前' : '查看'}</button></td>
        </tr>`,
      )
      .join('');
    return `<div class="table-wrap"><table class="pp-table">
      <thead><tr><th>代码</th><th>现价</th><th>涨跌幅</th><th>持仓</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  private renderCompany(_view: GameViewModel): string {
    const securities = this.securitiesView(this.selectedSecurityId, this.currentOrder());
    const detail = securities.companyDetail;
    return `<div class="gw-section">
      ${this.renderSecurityTabs(securities)}
      <div class="block" data-el="company-detail" data-signature="${esc(
        companyDetailSignature(detail),
      )}">${renderCompanyDetail(detail)}</div>
      <div class="block">
        <div class="block-title">全部标的</div>
        ${this.renderHoldingsTable(securities)}
      </div>
    </div>`;
  }

  private renderAbout(view: GameViewModel): string {
    return `<div class="gw-section">
      <div class="block">
        <div class="stat-grid">
          ${stat('游戏时间', view.dateText)}
          ${stat('速度', `${view.speed}×`)}
          ${stat('净资产', view.money.netWorthText, { live: 'money.netWorth' })}
          ${stat('可用资金', view.money.availableText, { live: 'money.available' })}
        </div>
      </div>
      <div class="block">
        <div class="block-title">界面说明</div>
        <div class="note">管理窗口以浮动面板覆盖在城市场景之上，一次只打开一个；股票详情是辅助浮窗，最多同时打开两个。</div>
        <div class="note">拖动标题栏可移动窗口，双击标题栏或右上角按钮可放大与恢复；位置与放大状态只在内存中，不写入存档。</div>
        <div class="note">打开管理窗口时模拟继续；只有 Esc 菜单（或触屏「界面」里的暂停菜单）会暂停时间。暂停/继续与速度档位在 Tab 窗口标题栏。</div>
        <div class="note">图标来自 Lucide（ISC 许可证），中文字体使用系统字体栈，资源来源见 public/assets/SOURCES.md。</div>
      </div>
      <div class="block">
        <div class="block-title">快捷键</div>
        <div class="kv-list">
          ${kv('人物界面', 'Tab')}
          ${kv('交互 / 关闭窗口', 'F')}
          ${kv('跳跃', 'Space')}
          ${kv('暂停与返回', 'Esc')}
        </div>
      </div>
      <div class="note" style="margin-top:8px">${esc(BRANDING.gameTitle)} · ${formatMoneyCompact(
        view.money.netWorth,
      )} 净资产</div>
    </div>`;
  }

  /** 只重绘当前分类的图形：K 线画布与城市人口/产业环形图。 */
  private paintCharts(view: GameViewModel): void {
    const content = this.win.content;
    if (!content) return;
    if (this.active?.startsWith('city.')) {
      this.government.paint(content);
      return;
    }
    const securities = this.securitiesOf();
    const selected = securities?.selected ?? null;
    if (!selected) return;
    // 画布在重绘时被整体保留，切换标的时要把数据来源同步成当前证券
    const quoteCanvas = content.querySelector<HTMLCanvasElement>('canvas[data-chart="quote"]');
    if (quoteCanvas) quoteCanvas.dataset.stock = this.selectedSecurityId;
    const lookup = (id: string): ChartInput | null => {
      if (id !== this.selectedSecurityId) return null;
      return { closed: selected.candles, current: selected.current };
    };
    paintStockCharts(content, lookup);
    void view;
  }
}

function groupLabel(group: GroupKey): string {
  return GROUPS.find((item) => item.key === group)?.label ?? '';
}
