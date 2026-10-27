/**
 * 人物管理界面 —— Tab 打开的宽幅管理窗口。
 *
 * 结构：顶部身份栏 + 左侧固定导航 + 右侧可滚动内容 + 股票浮窗层。
 *
 * 刷新策略（本轮重点）：
 *  - 每个栏目有一个「结构指纹」，只包含会改变 DOM 结构的信息（有哪些区块、产品、报表行…），
 *    不包含金额与价格；
 *  - 指纹不变 → 原地比对更新文本与属性，输入框、滚动位置、展开说明、按钮全部不动；
 *  - 指纹变化 → 只重建该栏目，并恢复草稿与滚动位置；
 *  - 正在输入时若结构变化，先保留原表单并显示提示，等焦点离开再重建。
 *
 * 草稿只存在内存里（不进 GameState、不进存档），按「栏目 + 公司子页 + 公司 id + 字段」分区，
 * 产品相关字段自带产品 id，因此不会串到另一款产品。
 */

import type {
  PersonalSection,
  PersonalUiQuery,
  PersonalView,
  ReportView,
  SummaryItem,
} from '../app/personal-view';
import type { CapitalView } from '../app/securities-view';
import type { GameViewModel } from '../app/view';
import { DEFAULT_PERSONAL_QUERY } from '../app/personal-view';
import { BRANDING } from '../content/config';
import {
  renderBusinessActions,
  renderBusinessCreate,
  renderBusinessFinance,
  renderBusinessMarket,
  renderBusinessOverview,
  renderBusinessResearchSection,
  renderBusinessTalent,
} from './business-panel';
import { icon } from './icons';
import { renderOffice } from './life-panels';
import { renderEstateHoldingsTable } from './estate-panel';
import type { EstateSectionView } from '../app/real-estate-view';
import { renderInventorySection } from './inventory-panel';
import {
  patchStockWindowNumbers,
  renderStockCard,
  renderStockSummary,
  renderStockWindowBody,
} from './stock-portfolio';
import { StockWindowManager } from './stock-window-manager';

type CompanySub = 'overview' | 'research' | 'talent' | 'finance' | 'actions' | 'market' | 'capital';

/** 资本子页的两种形态：证券中心的完整资本业务，或人物界面的自有公司治理。 */
export type CapitalMode = 'full' | 'governance';

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const SECTIONS: ReadonlyArray<{ id: PersonalSection; name: string }> = [
  { id: 'overview', name: '人物总览' },
  { id: 'finance', name: '个人财务' },
  { id: 'work', name: '工作情况' },
  { id: 'inventory', name: '背包' },
  { id: 'stocks', name: '股票持仓' },
  { id: 'company', name: '我的公司' },
];

/** 内容归属者提供的外部依赖：现场办理的上下文、当前游戏视图与分类跳转。 */
export interface PersonalPanelHost {
  /** 当前窗口是从哪个建筑入口打开的（决定现场办理内容）。 */
  onsite(): string | null;
  view(): GameViewModel | null;
  /** 远程只读的房地产视图：个人资产里的持有明细从这里取。 */
  estate(): EstateSectionView;
  /** 当前入口是否允许进入该栏目（待办与快捷入口同样受此限制）。 */
  canOpen?(section: PersonalSection): boolean;
  navigate?(section: PersonalSection): void;
}

/** 数值原地更新的最小间隔：时间连续流逝时不必每帧重排。 */
const PATCH_INTERVAL_MS = 180;

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function kpi(item: SummaryItem): string {
  const tone = item.tone ? ` ${item.tone}` : '';
  const note = item.note ? `<div class="pp-kpi-note">${esc(item.note)}</div>` : '';
  return `<div class="pp-kpi">
    <div class="pp-kpi-label">${esc(item.label)}</div>
    <div class="pp-kpi-value num${tone}">${esc(item.valueText)}</div>
    ${note}
  </div>`;
}

function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  emptyText: string,
): string {
  if (rows.length === 0) return `<div class="pp-empty">${esc(emptyText)}</div>`;
  const head = headers.map((text) => `<th>${esc(text)}</th>`).join('');
  const body = rows
    .map(
      (cells) =>
        `<tr>${cells
          .map((cell, index) => `<td class="${index >= 2 ? 'num' : ''}">${cell}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  return `<table class="pp-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function reportBlock(report: ReportView | null, months: string[], current: string | null): string {
  const options = months.length
    ? months
        .map(
          (month) =>
            `<option value="${esc(month)}"${month === current ? ' selected' : ''}>${esc(month)}</option>`,
        )
        .join('')
    : '<option value="">暂无月报</option>';
  const body = report
    ? `<div class="pp-kpi-row">
        ${kpi({ label: '收入', valueText: report.incomeText, tone: 'pos' })}
        ${kpi({ label: '支出', valueText: report.expenseText, tone: 'neg' })}
        ${kpi({ label: '净额', valueText: report.netText, tone: report.netPositive ? 'pos' : 'neg' })}
      </div>
      <div class="pp-rows">
        ${report.lines
          .map(
            (line) =>
              `<div class="pp-row"><span class="pp-row-label">${esc(line.label)}</span><span class="pp-row-amount num ${line.tone ?? ''}">${esc(line.valueText)}</span></div>`,
          )
          .join('')}
      </div>
      <div class="pp-hint">${esc(report.footer)}</div>`
    : '<div class="pp-empty">还没有月度报告，完成第一个月后会生成</div>';
  return `<div class="field-row">
      <select class="field" data-el="pp-report-month">${options}</select>
    </div>
    ${body}`;
}

/* ------------------------------------------------------ DOM 原地比对 */

function isFormControl(node: Element): boolean {
  return (
    node.tagName === 'INPUT' || node.tagName === 'SELECT' || node.tagName === 'TEXTAREA'
  );
}

/**
 * 同步属性。`value` 一律不动（输入值属于用户，不属于渲染结果），
 * canvas 的宽高也不动（那是绘制时按像素比设的）。
 */
function syncAttributes(current: Element, next: Element): void {
  const skipSelfSize = current.tagName === 'CANVAS';
  for (const attr of Array.from(next.attributes)) {
    if (attr.name === 'value') continue;
    if (skipSelfSize && (attr.name === 'width' || attr.name === 'height')) continue;
    if (current.getAttribute(attr.name) !== attr.value) {
      current.setAttribute(attr.name, attr.value);
    }
  }
  for (const attr of Array.from(current.attributes)) {
    if (attr.name === 'value') continue;
    if (skipSelfSize && (attr.name === 'width' || attr.name === 'height')) continue;
    if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
  }
}

/**
 * 把 `next` 的内容合并进 `current`，只更新变化的文本与属性。
 * 结构一致时完全不动节点身份，因此输入焦点、滚动位置、展开状态都保留。
 */
function reconcile(current: Element, next: Element): void {
  if (current.tagName !== next.tagName) {
    current.replaceWith(next.cloneNode(true));
    return;
  }
  syncAttributes(current, next);
  if (isFormControl(current)) return;
  reconcileChildren(current, next);
}

function reconcileChildren(current: Element, next: Element): void {
  const currentNodes = Array.from(current.childNodes);
  const nextNodes = Array.from(next.childNodes);
  for (let i = 0; i < nextNodes.length; i += 1) {
    const incoming = nextNodes[i]!;
    const existing = currentNodes[i];
    if (!existing) {
      current.appendChild(incoming.cloneNode(true));
      continue;
    }
    if (existing.nodeType !== incoming.nodeType) {
      current.replaceChild(incoming.cloneNode(true), existing);
      continue;
    }
    if (existing.nodeType === Node.TEXT_NODE) {
      if (existing.nodeValue !== incoming.nodeValue) existing.nodeValue = incoming.nodeValue;
      continue;
    }
    if (existing.nodeType !== Node.ELEMENT_NODE) continue;
    reconcile(existing as Element, incoming as Element);
  }
  for (let i = nextNodes.length; i < currentNodes.length; i += 1) {
    currentNodes[i]!.parentNode?.removeChild(currentNodes[i]!);
  }
}

/** 某个动作成功后应当清理的字段名（产品相关字段自带产品 id）。 */
function submittedFields(action: string, el: HTMLElement): string[] {
  switch (action) {
    case 'create-company':
      return ['company-name', 'company-capital'];
    case 'fund-company':
      return ['fund-input'];
    case 'dividend':
      return ['dividend-input'];
    case 'invest-tech':
      return ['tech-input'];
    case 'start-research':
      return ['research-focus', 'research-days', 'research-budget'];
    case 'release-product': {
      const id = el.dataset.product ?? '';
      return [`release-name-${id}`, `release-price-${id}`, `release-marketing-${id}`];
    }
    case 'save-price':
      return [`price-${el.dataset.product ?? ''}`];
    case 'save-marketing':
      return [`marketing-${el.dataset.product ?? ''}`];
    case 'request-financing':
      return ['financing-input'];
    case 'buyback':
      return ['buyback-input'];
    case 'promote':
      return ['promotion-input'];
    default:
      return [];
  }
}

export class PersonalPanel {
  private root: HTMLElement | null = null;
  /** 股票详情浮窗的宿主（统一窗口的浮层，不随内容滚动）。 */
  private floatEl: HTMLElement | null = null;
  private section: PersonalSection = 'overview';
  private companySub: CompanySub = 'overview';
  /** 资本子页形态：只有证券中心显示完整资本业务，人物界面只显示治理。 */
  private capitalMode: CapitalMode = 'full';
  private query: PersonalUiQuery = { ...DEFAULT_PERSONAL_QUERY };
  private readonly windows = new StockWindowManager();
  private lastView: PersonalView | null = null;
  /** 本次刷新用的房地产只读视图：个人财务的持有明细从这里取，避免同一次绘制重复构建。 */
  private lastEstate: EstateSectionView | null = null;
  private lastPatch = 0;
  /** 当前栏目的结构指纹；只在真正重建后更新。 */
  private lastSignature = '';
  /** 结构变了但正在输入，等安全时机再重建。 */
  private pendingRebuild = false;
  private pointerActive = false;
  private listening = false;
  /** 未提交的输入草稿：`栏目|公司子页|公司id::字段` → 值。 */
  private readonly drafts = new Map<string, string>();
  /** 浮窗正文的结构指纹：只有持仓或成交笔数变化时才重建正文。 */
  private readonly windowShape = new Map<string, string>();
  /** 背包使用请求的 requestId：同一物品只在 cursor 未变时复用，成功（含重放）后清理。 */
  private readonly pendingUseRequests = new Map<string, string>();

  constructor(
    private readonly getView: (query: PersonalUiQuery) => PersonalView,
    private readonly host: PersonalPanelHost,
  ) {}

  get isMounted(): boolean {
    return this.root !== null;
  }

  /** 挂到统一窗口的内容区：只渲染栏目容器，窗口外壳与分类导航由外层负责。 */
  mount(container: HTMLElement, floatLayer: HTMLElement | null): void {
    this.root = container;
    this.floatEl = floatLayer;
    this.lastPatch = 0;
    this.lastSignature = '';
    this.pendingRebuild = false;
    this.attachListeners(container);
    container.innerHTML = this.sectionsHtml();
    if (floatLayer) this.windows.attach(floatLayer);
    this.paint(true);
  }

  /** 关闭整个界面：销毁 DOM，但保留浮窗的打开状态与位置。 */
  teardown(): void {
    this.windows.detach();
    if (this.root) this.root.innerHTML = '';
    this.root = null;
    this.floatEl = null;
  }

  /**
   * 由外层分类导航调用：设置当前栏目、公司子页与资本子页形态。
   * 这里只切换显示的栏目，不重建导航本身。
   */
  setScope(section: PersonalSection, sub?: CompanySub, capitalMode: CapitalMode = 'full'): void {
    if (!this.root) return;
    const nextSub = sub ?? 'overview';
    if (
      section === this.section &&
      nextSub === this.companySub &&
      capitalMode === this.capitalMode
    ) {
      this.patchNav();
      return;
    }
    this.section = section;
    this.companySub = nextSub;
    this.capitalMode = capitalMode;
    this.lastSignature = '';
    this.patchNav();
    this.paint(true);
  }

  resetSession(): void {
    this.windows.resetSession();
    this.windowShape.clear();
    this.drafts.clear();
    this.query = { ...DEFAULT_PERSONAL_QUERY };
    this.section = 'overview';
    this.companySub = 'overview';
    this.lastSignature = '';
    this.pendingRebuild = false;
    this.pendingUseRequests.clear();
  }

  /** 状态变化后刷新。 */
  update(): void {
    if (!this.root) return;
    if (this.pendingRebuild && !this.pointerActive && !this.hasFormFocus()) {
      // 输入已经结束：补做被推迟的结构更新
      this.paint(true);
      return;
    }
    this.paint(false);
  }

  /** 关闭最上层的股票浮窗；没有浮窗时返回 false。 */
  handleEscape(): boolean {
    return this.windows.closeTop();
  }

  /**
   * 背包使用请求的 requestId：只从当前 cursor 读取（读取不消耗序号）。
   *
   * 同一物品的 pending 只在 requestId 与当前 cursor 一致时复用；
   * cursor 已前进（其它操作已消耗序号）时替换为新 cursor，不自行猜序号。
   * lastView 缺失时返回空串，由命令层按 INVALID_REQUEST 拒绝。
   */
  takeUseRequestId(itemId: string): string {
    const requestId = this.lastView?.inventoryCursor.requestId ?? '';
    if (!requestId) return '';
    if (this.pendingUseRequests.get(itemId) !== requestId) {
      this.pendingUseRequests.set(itemId, requestId);
    }
    return requestId;
  }

  /** 命令成功后的明确回调：只清理该操作涉及的字段。 */
  handleSubmitted(action: string, el: HTMLElement): void {
    if (action === 'inv-use') {
      // 成功与重放都算处理完成：清掉该物品的 pending，下一次点击取新 cursor
      const itemId = el.dataset.item;
      if (itemId) this.pendingUseRequests.delete(itemId);
    }
    if (action === 'buyback') {
      // 回购已成交：清掉预览数量，避免下一次看别的数量时还显示旧结果
      this.query = { ...this.query, capitalBuybackShares: 0 };
    }
    const fields = submittedFields(action, el);
    if (fields.length === 0 || !this.root) return;
    const prefix = `${this.section}|${this.companySub}|`;
    for (const field of fields) {
      // 创建公司会让公司 id 变化，因此按前缀清理，避免旧草稿留到下一家公司
      for (const key of Array.from(this.drafts.keys())) {
        if (key.startsWith(prefix) && key.endsWith(`::${field}`)) this.drafts.delete(key);
      }
      const control = this.findControl(field);
      if (!control) continue;
      if (control instanceof HTMLInputElement && control.type === 'checkbox') {
        control.checked = false;
      } else {
        control.value = '';
      }
    }
  }

  /** 新动作。返回 true 表示已处理。 */
  handleAction(action: string, el: HTMLElement): boolean {
    switch (action) {
      case 'pp-section': {
        const next = el.dataset.section as PersonalSection | undefined;
        if (next) this.switchSection(next);
        return true;
      }
      case 'pp-company-sub': {
        const next = el.dataset.sub as CompanySub | undefined;
        if (next && next !== this.companySub) {
          this.companySub = next;
          this.paint(true);
        }
        return true;
      }
      case 'pp-capital-company': {
        // 界面当前选择只存在内存里：不进 GameState、不进存档
        const id = el.dataset.company ?? null;
        if (id !== this.query.capitalCompanyId) {
          this.query = { ...this.query, capitalCompanyId: id, capitalBuybackShares: 0 };
          this.paint(true);
        }
        return true;
      }
      case 'pp-ledger-page': {
        const delta = Number(el.dataset.page ?? '0');
        this.query = {
          ...this.query,
          ledgerPage: Math.max(0, this.query.ledgerPage + delta),
        };
        this.paint(true);
        return true;
      }
      case 'open-stock': {
        const id = el.dataset.stock;
        if (!id || !this.lastView) return true;
        const card = this.lastView.stocks.cards.find((item) => item.id === id);
        if (!card) return true;
        this.windows.open(id, {
          title: card.name,
          subtitle: card.symbol,
          body: renderStockWindowBody(card),
        });
        this.paintWindows(true);
        return true;
      }
      case 'close-stock': {
        const id = el.dataset.stock;
        if (id) {
          this.windows.close(id);
          this.syncWindowVisibility();
        }
        return true;
      }
      case 'pp-nav-event': {
        const target = el.dataset.target as PersonalSection | undefined;
        if (target) this.switchSection(target);
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * 下拉筛选（change 事件）。
   * 查询状态由 PersonalUiQuery 管理，不写入草稿；改动必须立即反映到表格与页码。
   */
  handleChange(el: HTMLInputElement | HTMLSelectElement): boolean {
    const field = el.dataset.el;
    if (!field) return false;
    if (field === 'pp-ledger-month') {
      this.query = { ...this.query, ledgerMonth: el.value || null, ledgerPage: 0 };
      this.paint(true);
      return true;
    }
    if (field === 'pp-ledger-category') {
      this.query = { ...this.query, ledgerCategory: el.value || null, ledgerPage: 0 };
      this.paint(true);
      return true;
    }
    if (field === 'pp-report-month') {
      this.query = { ...this.query, reportMonth: el.value || null };
      this.paint(true);
      return true;
    }
    return false;
  }

  /** 浏览器尺寸变化后重新约束浮窗位置。 */
  relayout(): void {
    this.windows.layout();
  }

  /* ------------------------------------------------------------------ */

  private attachListeners(host: HTMLElement): void {
    if (this.listening) return;
    this.listening = true;
    // 捕获阶段监听：无论字段由谁渲染，输入即写入草稿，不依赖重建前临时抓取
    host.addEventListener('input', this.captureDraft, true);
    host.addEventListener('input', this.handleCapitalInput, true);
    host.addEventListener('change', this.captureDraft, true);
    host.addEventListener('pointerdown', this.handlePointerDown, true);
    window.addEventListener('pointerup', this.handlePointerUp);
  }

  private readonly captureDraft = (event: Event): void => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) {
      return;
    }
    const field = el.dataset.el;
    // 查询筛选属于查询状态，不能当成草稿被回填，否则旧选择会覆盖新选择
    if (!field || field.startsWith('pp-')) return;
    const value =
      el instanceof HTMLInputElement && el.type === 'checkbox'
        ? el.checked
          ? '1'
          : '0'
        : el.value;
    this.drafts.set(`${this.scope()}::${field}`, value);
  };

  /** 回购股数输入：更新「本次预览」的数值，但不重建栏目（不打断输入）。 */
  private readonly handleCapitalInput = (event: Event): void => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement)) return;
    if (el.dataset.el !== 'buyback-input') return;
    if (this.section !== 'company' || this.companySub !== 'capital') return;
    const shares = Number(el.value.trim());
    const next = Number.isSafeInteger(shares) && shares > 0 ? shares : 0;
    if (next === this.query.capitalBuybackShares) return;
    this.query = { ...this.query, capitalBuybackShares: next };
    this.patchBuybackPreview();
  };

  /** 只替换回购预览相关的节点，DOM 结构保持不动。 */
  private patchBuybackPreview(): void {
    if (!this.root) return;
    const view = this.buildView();
    this.lastView = view;
    const cap = view.capital;
    const setText = (name: string, text: string): void => {
      const node = this.root?.querySelector<HTMLElement>(`[data-el="${name}"]`);
      if (node && node.textContent !== text) node.textContent = text;
    };
    setText('buyback-request', cap.buybackRequestShares > 0 ? String(cap.buybackRequestShares) : '—');
    setText(
      'buyback-executable',
      cap.buybackPreviewExecutable > 0 ? String(cap.buybackPreviewExecutable) : '—',
    );
    setText('buyback-price', cap.buybackPreviewPriceText);
    setText('buyback-amount', cap.buybackPreviewAmountText);
    setText('buyback-impact', cap.buybackPreviewImpactText);
    const node = this.root.querySelector<HTMLElement>('[data-el="buyback-preview"]');
    if (!node) return;
    if (cap.buybackPreviewPrice > 0) node.dataset.price = String(cap.buybackPreviewPrice);
    else delete node.dataset.price;
    if (node.textContent !== cap.buybackPreviewNote) node.textContent = cap.buybackPreviewNote;
  }

  private readonly handlePointerDown = (): void => {
    this.pointerActive = true;
  };

  private readonly handlePointerUp = (): void => {
    this.pointerActive = false;
  };

  /** 草稿分区：栏目 + 公司子页 + 公司 id（产品 id 由字段名自带）。 */
  private scope(): string {
    return `${this.section}|${this.companySub}|${this.lastView?.company.id ?? ''}`;
  }

  private findControl(field: string): FormControl | null {
    if (!this.root) return null;
    for (const el of this.root.querySelectorAll<FormControl>('input, select, textarea')) {
      if (el.dataset.el === field) return el;
    }
    return null;
  }

  private activeContainer(): HTMLElement | null {
    return (
      this.root?.querySelector<HTMLElement>(`.pp-section[data-section="${this.section}"]`) ?? null
    );
  }

  private hasFormFocus(): boolean {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    if (!active.matches('input, select, textarea')) return false;
    const container = this.activeContainer();
    return container ? container.contains(active) : false;
  }

  /**
   * 栏目跳转统一交给外层：外层的分类导航决定高亮与标题，
   * 这里只负责在自己的栏目容器之间切换。当前入口没有的栏目直接忽略，
   * 待办按钮与持仓快捷入口因此不能绕开入口限制。
   */
  private switchSection(next: PersonalSection): void {
    if (next !== this.section) {
      if (this.host.canOpen && !this.host.canOpen(next)) return;
      this.section = next;
      this.lastSignature = '';
      this.patchNav();
      this.paint(true);
    }
    this.host.navigate?.(next);
  }

  /** 只创建栏目容器：每个栏目各自保存滚动位置、输入与展开状态。 */
  private sectionsHtml(): string {
    return SECTIONS.map(
      (item) =>
        `<section class="pp-section" data-section="${item.id}"${item.id === this.section ? '' : ' hidden'}></section>`,
    ).join('');
  }

  private paint(force: boolean): void {
    if (!this.root) return;
    const view = this.buildView();
    this.lastView = view;

    this.patchNav();

    const now = performance.now();
    if (!force && now - this.lastPatch < PATCH_INTERVAL_MS) {
      this.syncWindowVisibility();
      return;
    }
    this.lastPatch = now;

    // 个人财务里要列房地产持有明细：只在需要时构建一次，供指纹与渲染共用
    this.lastEstate = this.section === 'finance' ? this.host.estate() : null;
    const container = this.activeContainer();
    if (container) this.paintSection(container, view, force);

    this.syncWindowVisibility();
    if (this.section === 'stocks') this.paintWindows(force);
  }

  /**
   * 取视图的唯一入口。
   *
   * 治理子页必须绑定**当前管理公司**（CEO 身份，由 `buildBusinessView` 的 `canManage` 表达），
   * 不能沿用证券中心浏览时写进 `query.capitalCompanyId` 的其它持股公司；
   * 同时也不能只把查询置空——`buildCapitalView` 在没有管理公司时会回退到「玩家持股的第一家」，
   * 那同样会把别的公司带进人物界面，所以这里以实际管理公司为准做一次核对。
   */
  private buildView(): PersonalView {
    if (this.capitalMode !== 'governance') return this.getView(this.query);
    const bound = this.managedCompanyId();
    const view = this.getView({ ...this.query, capitalCompanyId: bound });
    const target = view.company.canManage ? view.company.id : null;
    // 没有管理公司时不在人物界面渲染治理内容（由 renderCompany 给指引），因此无需再取一次
    if (target === null || view.capital.companyId === target) return view;
    return this.getView({ ...this.query, capitalCompanyId: target });
  }

  /** 当前管理公司 id：只有 CEO 身份才算，卖光股份不撤职（由视图的 canManage 表达）。 */
  private managedCompanyId(): string | null {
    const company = this.lastView?.company;
    return company && company.canManage ? company.id : null;
  }

  private patchNav(): void {
    if (!this.root) return;
    // 只显示当前栏目；其他栏目的 DOM 保留，切换回来时滚动位置与输入都还在
    for (const el of this.root.querySelectorAll<HTMLElement>('.pp-section[data-section]')) {
      el.hidden = el.dataset.section !== this.section;
    }
  }

  /* --------------------------------------------------------- 栏目刷新 */

  private paintSection(container: HTMLElement, view: PersonalView, force: boolean): void {
    const signature = this.signature(view);
    const html = this.renderSection(view);

    if (container.childElementCount === 0) {
      this.rebuild(container, html);
      this.lastSignature = signature;
      return;
    }

    // 已经推迟过一次重建：栏目里多了提示节点，按索引比对会错位，只能等重建
    if (this.pendingRebuild && !force) {
      this.showStaleHint(container);
      return;
    }

    if (signature === this.lastSignature) {
      this.patchSection(container, html);
      return;
    }

    // 结构变了：优先立即重建；正在输入或正按着鼠标时推迟，避免丢失输入或吞掉点击
    if (!force && (this.pointerActive || this.hasFormFocus())) {
      this.pendingRebuild = true;
      this.showStaleHint(container);
      return;
    }
    this.rebuild(container, html);
    this.lastSignature = signature;
  }

  /** 结构一致：只更新文本与属性，不动节点身份。 */
  private patchSection(container: HTMLElement, html: string): void {
    const template = document.createElement('template');
    template.innerHTML = html;
    const next = template.content.firstElementChild;
    const current = container.firstElementChild;
    if (!next || !current) {
      container.innerHTML = html;
      return;
    }
    reconcile(current, next);
  }

  private rebuild(container: HTMLElement, html: string): void {
    const scroller = container.querySelector<HTMLElement>('.pp-scroll');
    const scrollTop = scroller?.scrollTop ?? 0;
    const openDetails = new Set<number>();
    container.querySelectorAll('details').forEach((item, index) => {
      if (item.open) openDetails.add(index);
    });

    container.innerHTML = html;

    const nextScroller = container.querySelector<HTMLElement>('.pp-scroll');
    if (nextScroller) nextScroller.scrollTop = scrollTop;
    container.querySelectorAll('details').forEach((item, index) => {
      if (openDetails.has(index)) item.open = true;
    });
    this.restoreDrafts(container);
    this.pendingRebuild = false;
  }

  private restoreDrafts(container: HTMLElement): void {
    const scope = this.scope();
    for (const el of container.querySelectorAll<FormControl>('input[data-el], select[data-el], textarea[data-el]')) {
      const field = el.dataset.el;
      if (!field || field.startsWith('pp-')) continue;
      const value = this.drafts.get(`${scope}::${field}`);
      if (value === undefined) continue;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = value === '1';
      else el.value = value;
    }
  }

  private showStaleHint(container: HTMLElement): void {
    const scroller = container.querySelector<HTMLElement>('.pp-scroll');
    if (!scroller || scroller.querySelector('.pp-stale')) return;
    const hint = document.createElement('div');
    hint.className = 'pp-stale';
    hint.textContent = '数据已更新，完成当前输入后自动同步显示';
    scroller.prepend(hint);
  }

  /**
   * 结构指纹：只包含会改变 DOM 结构的信息。
   * 金额、价格、进度百分比都不在内——它们走原地更新，不会触发重建。
   */
  private signature(view: PersonalView): string {
    switch (this.section) {
      case 'overview':
        return `o|${view.overview.todos.length}|${view.overview.todos
          .map((todo) => `${todo.tone}${todo.section}`)
          .join(',')}`;
      case 'finance': {
        const f = view.finance;
        const game = this.host.view();
        const held = this.lastEstate
          ? this.lastEstate.holdings.map((item) => `${item.id}:${item.status}`).join(',')
          : '';
        return [
          'f',
          this.host.onsite() === 'bank' ? 'bank' : '',
          game?.loan.open ? '1' : '0',
          f.ledger.months.join(','),
          f.ledger.categories.map((item) => item.id).join(','),
          f.ledger.month ?? '',
          f.ledger.category ?? '',
          String(f.ledger.total),
          String(f.ledger.page),
          String(f.ledger.pageCount),
          f.ledger.rows.map((row) => row.id).join(','),
          f.report?.monthKey ?? '',
          f.reportMonths.join(','),
          String(f.report?.lines.length ?? 0),
          String(f.incomeLines.length),
          String(f.expenseLines.length),
          held,
        ].join('|');
      }
      case 'work':
        return `w|${view.work.hired ? '1' : '0'}|${this.host.onsite() === 'office' ? 'office' : ''}`;
      case 'inventory':
        return `i|${view.inventory.map((item) => `${item.itemId}:${item.count}`).join(',')}|${view.survival.zeroHunger ? '1' : '0'}${view.survival.zeroWater ? '1' : '0'}`;
      case 'stocks': {
        const s = view.stocks;
        return [
          's',
          s.empty ? '1' : '0',
          s.cards.map((card) => `${card.id}:${card.trades.length}`).join(','),
        ].join('|');
      }
      case 'company':
      default: {
        const b = view.company;
        const k = view.capital;
        return [
          'c',
          b.hasCompany ? '1' : '0',
          this.companySub,
          this.capitalMode,
          b.id,
          b.isClosed ? '1' : '0',
          b.hasProject ? '1' : '0',
          b.pending.map((item) => item.id).join(','),
          b.products.map((item) => `${item.id}${item.onSale ? '1' : '0'}`).join(','),
          b.candidates.map((item) => `${item.id}${item.available ? '1' : '0'}`).join(','),
          String(b.reports.length),
          b.dueItems.map((item) => item.label).join(','),
          b.ledgerRows.map((row) => row.id).join(','),
          k.hasCompany ? '1' : '0',
          k.listed ? '1' : '0',
          k.canList ? '1' : '0',
          k.canManage ? '1' : '0',
          k.canPropose ? '1' : '0',
          this.query.capitalCompanyId ?? '',
          k.companyId,
          k.companies.map((item) => `${item.id}${item.selected ? '1' : '0'}`).join(','),
          k.capTable.map((row) => `${row.holderId}:${row.sharesText}`).join(','),
          k.quotes.map((row) => row.quoteId).join(','),
          k.proposals.map((row) => `${row.id}${row.resultText}${row.canVote ? '1' : '0'}`).join(','),
        ].join('|');
      }
    }
  }

  private renderSection(view: PersonalView): string {
    switch (this.section) {
      case 'overview':
        return this.renderOverview(view);
      case 'finance':
        return this.renderFinance(view);
      case 'work':
        return this.renderWork(view);
      case 'inventory':
        return renderInventorySection(view.inventory, view.inventoryEmpty, view.survival);
      case 'stocks':
        return this.renderStocks(view);
      case 'company':
        return this.renderCompany(view);
      default:
        return '';
    }
  }

  /**
   * 现场办理区块：只有从对应建筑入口打开时才追加。
   * 银行入口现在有独立页面（存取款与贷款），因此这里只剩办公楼现场。
   */
  private onsiteExtra(): string {
    const game = this.host.view();
    if (!game) return '';
    const onsite = this.host.onsite();
    if (this.section === 'work' && onsite === 'office') {
      return `<div class="pp-card"><div class="pp-card-title">${icon('briefcase', { size: 14 })} 现场办理 · 入职与上班</div>${renderOffice(game)}</div>`;
    }
    return '';
  }

  private renderOverview(view: PersonalView): string {
    const o = view.overview;
    const todos = o.todos.length
      ? `<div class="pp-todos">${o.todos
          .map(
            (todo) => `<button type="button" class="pp-todo ${todo.tone}" data-action="pp-nav-event" data-target="${todo.section}">
              <span class="pp-todo-text">${esc(todo.text)}</span>
              <span class="pp-todo-detail">${esc(todo.detail)}</span>
            </button>`,
          )
          .join('')}</div>`
      : '<div class="pp-empty">目前没有待处理事项</div>';

    return `<div class="pp-scroll">
      <div class="pp-ident">
        <div class="pp-avatar" aria-hidden="true">市</div>
        <div class="pp-identity">
          <h2>${esc(o.name)}</h2>
          <p class="pp-meta">${esc(view.dateText)} ${esc(view.clockText)} · ${esc(o.jobText)}</p>
          <p class="pp-meta sub">${esc(o.companyText)} · ${esc(o.companyStatusText)}</p>
        </div>
      </div>
      <div class="pp-card">
        <div class="pp-card-title">当前状态</div>
        <div class="pp-kpi-row">${o.summary.map(kpi).join('')}</div>
        <div class="pp-hint">${esc(o.researchText)}</div>
      </div>
      <div class="pp-card">
        <div class="pp-card-title">待处理事项</div>
        ${todos}
      </div>
      <div class="pp-hint">按 Tab 关闭窗口；按 Esc 先关股票详情窗，再关整个窗口。</div>
    </div>`;
  }

  private renderFinance(view: PersonalView): string {
    const f = view.finance;
    const monthOptions = [
      `<option value=""${f.ledger.month === null ? ' selected' : ''}>全部月份</option>`,
      ...f.ledger.months.map(
        (month) =>
          `<option value="${esc(month)}"${month === f.ledger.month ? ' selected' : ''}>${esc(month)}</option>`,
      ),
    ].join('');
    const categoryOptions = [
      `<option value=""${f.ledger.category === null ? ' selected' : ''}>全部类别</option>`,
      ...f.ledger.categories.map(
        (item) =>
          `<option value="${esc(item.id)}"${item.id === f.ledger.category ? ' selected' : ''}>${esc(item.name)}</option>`,
      ),
    ].join('');

    const rows = f.ledger.rows.map((row) => [
      esc(row.timeText),
      `${esc(row.labelText)}<span class="pp-tag ${row.kind}">${esc(row.categoryText)}</span>`,
      esc(row.inText),
      esc(row.outText),
      esc(row.accountText),
      esc(row.categoryText),
    ]);

    return `<div class="pp-scroll">
      <div class="pp-grid-2">
        <div class="pp-card">
          <div class="pp-card-title">资产</div>
          <div class="pp-kpi-row">${f.assets.map(kpi).join('')}</div>
        </div>
        <div class="pp-card">
          <div class="pp-card-title">负债</div>
          <div class="pp-kpi-row">${f.liabilities.map(kpi).join('')}</div>
        </div>
      </div>
      <div class="pp-card">
        <div class="pp-card-title">净资产</div>
        <div class="pp-kpi-row">
          ${kpi({ label: `净资产（${f.currentMonth}）`, valueText: f.netWorthText })}
          ${kpi({ label: '本月收入', valueText: f.monthIncomeText, tone: 'pos' })}
          ${kpi({ label: '本月支出', valueText: f.monthExpenseText, tone: 'neg' })}
          ${kpi({ label: '本月净额', valueText: f.monthNetText, tone: f.monthNetPositive ? 'pos' : 'neg' })}
        </div>
        <details class="pp-details"><summary>计算说明</summary><p>${esc(f.formulaText)}</p></details>
      </div>
      <div class="pp-card">
        <div class="pp-card-title">房地产持有明细</div>
        ${renderEstateHoldingsTable(this.lastEstate ?? this.host.estate())}
        <div class="pp-hint">持有物业按参考估值计入净资产，永久居住权不计入。买入、挂牌、改价、撤销与机构报价的接受/拒绝都需要在晴川公寓现场办理。</div>
      </div>
      <div class="pp-grid-2">
        <div class="pp-card">
          <div class="pp-card-title">本月收入明细</div>
          <div class="pp-rows">
            ${
              f.incomeLines.length
                ? f.incomeLines
                    .map(
                      (line) =>
                        `<div class="pp-row"><span>${esc(line.label)}</span><span class="num pos">${esc(line.valueText)}</span></div>`,
                    )
                    .join('')
                : '<div class="pp-empty">本月还没有个人收入</div>'
            }
          </div>
        </div>
        <div class="pp-card">
          <div class="pp-card-title">本月支出明细</div>
          <div class="pp-rows">
            ${
              f.expenseLines.length
                ? f.expenseLines
                    .map(
                      (line) =>
                        `<div class="pp-row"><span>${esc(line.label)}</span><span class="num neg">${esc(line.valueText)}</span></div>`,
                    )
                    .join('')
                : '<div class="pp-empty">本月还没有个人支出</div>'
            }
          </div>
        </div>
      </div>
      <div class="pp-card">
        <div class="pp-card-title">资金往来</div>
        <div class="field-row">
          <select class="field" data-el="pp-ledger-month">${monthOptions}</select>
          <select class="field" data-el="pp-ledger-category">${categoryOptions}</select>
        </div>
        ${table(['时间', '事项', '流入', '流出', '账户', '分类'], rows, '没有符合条件的个人流水')}
        <div class="pp-pager">
          <button type="button" class="btn btn-sm" data-action="pp-ledger-page" data-page="-1" ${f.ledger.page <= 0 ? 'disabled' : ''}>上一页</button>
          <span class="pp-pager-info num">第 ${f.ledger.page + 1} / ${f.ledger.pageCount} 页 · 共 ${f.ledger.total} 条</span>
          <button type="button" class="btn btn-sm" data-action="pp-ledger-page" data-page="1" ${f.ledger.page >= f.ledger.pageCount - 1 ? 'disabled' : ''}>下一页</button>
        </div>
        <div class="pp-hint">${esc(f.flowNote)}</div>
      </div>
      <div class="pp-card">
        <div class="pp-card-title">历史个人月报</div>
        ${reportBlock(f.report, f.reportMonths, f.report ? f.report.monthKey : null)}
      </div>
      ${this.onsiteExtra()}
    </div>`;
  }

  private renderWork(view: PersonalView): string {
    const w = view.work;
    return `<div class="pp-scroll">
      <div class="pp-card">
        <div class="pp-card-title">当前工作</div>
        <div class="pp-kpi-row">
          ${kpi({ label: '单位', valueText: w.employer })}
          ${kpi({ label: '岗位', valueText: w.title })}
          ${kpi({ label: '时薪', valueText: w.wageText })}
          ${kpi({ label: '工作效率', valueText: w.efficiencyText })}
          ${kpi({ label: '本次预计收入', valueText: w.estimatedEarnText })}
        </div>
        <div class="pp-hint">${esc(w.description)}</div>
      </div>
      <div class="pp-card">
        <div class="pp-card-title">工时与工资</div>
        <div class="pp-kpi-row">
          ${kpi({ label: '今日已工作', valueText: w.workedText })}
          ${kpi({ label: '今日剩余可工作', valueText: w.remainingText })}
          ${kpi({ label: '本月未发工资', valueText: w.monthAccruedText })}
          ${kpi({ label: '累计未发工资', valueText: w.totalAccruedText })}
        </div>
        <div class="pp-hint">当前状态：${esc(w.reasonText)}</div>
        <div class="pp-hint">${esc(w.note)}</div>
      </div>
      ${this.onsiteExtra()}
    </div>`;
  }

  private renderStocks(view: PersonalView): string {
    const s = view.stocks;
    const cards = s.cards.length
      ? `<div class="stock-grid">${s.cards.map(renderStockCard).join('')}</div>`
      : `<div class="pp-empty">当前没有持仓。到城市里的「${esc(BRANDING.cityStem)}证券中心」可以买入。</div>`;
    return `<div class="pp-scroll">
      ${renderStockSummary(s)}
      <div class="pp-card">
        <div class="pp-card-title">我的持仓</div>
        ${cards}
        <div class="pp-hint">本页只做查看：持股、成本、市值与盈亏。K 线与买卖都在「${esc(BRANDING.cityStem)}证券中心」；点击卡片打开只读持仓详情窗。</div>
        <div class="pp-hint">对其他持股公司的股东权利（表决、任免、资本业务）在证券中心「公司与资本」里按公司办理。</div>
      </div>
    </div>`;
  }

  private renderCompany(view: PersonalView): string {
    const b = view.company;
    // 人物界面的治理子页只服务「当前管理公司」，与证券中心浏览过的主体互不影响
    const governanceOnly = this.companySub === 'capital' && this.capitalMode === 'governance';

    let content = '';
    if (governanceOnly) {
      content = b.canManage
        ? this.renderCapital(view.capital, 'governance')
        : `<div class="block">
            <div class="block-title">公司治理</div>
            <div class="note">${
              b.hasCompany
                ? `你持有「${esc(b.name)}」的股份，但当前不是它的 CEO；这里只显示你管理中的公司。`
                : '你当前没有管理中的公司（CEO 身份）。'
            }</div>
            <div class="note">股东表决、任免与资本业务在「${esc(BRANDING.cityStem)}证券中心 › 公司与资本」里按公司办理；创建公司请到「公司概览」。</div>
          </div>`;
    } else if (!b.hasCompany) {
      // 没有公司时只保留基线已有的创建入口：不把外部融资、上市与回购面板带回这里
      content =
        this.host.onsite() === 'securities'
          ? `<div class="block">
              <div class="block-title">公司</div>
              <div class="note">你还没有公司。创建公司与日常经营在人物界面（Tab）的「我的公司」里办理；这里只处理已成立公司的资本业务。</div>
            </div>`
          : renderBusinessCreate(b);
    } else {
      switch (this.companySub) {
        case 'overview':
          content = renderBusinessOverview(b);
          break;
        case 'research':
          content = renderBusinessResearchSection(b);
          break;
        case 'talent':
          content = renderBusinessTalent(b);
          break;
        case 'finance':
          content = `${renderBusinessFinance(b)}
            <div class="block">
              <div class="block-title">应付款项</div>
              <div class="pp-rows">
                ${b.dueItems
                  .map(
                    (item) =>
                      `<div class="pp-row"><span>${esc(item.label)}</span><span class="num">${esc(item.valueText)}</span></div>`,
                  )
                  .join('')}
              </div>
              <div class="note">费用在发生时计入当月费用；补付应付只减少现金与负债，不会再次计入费用。</div>
            </div>
            <div class="block">
              <div class="block-title">企业流水 · 最近 ${b.ledgerRows.length} 条</div>
              ${table(
                ['时间', '事项', '流入', '流出', '分类'],
                b.ledgerRows.map((row) => [
                  esc(row.timeText),
                  esc(row.labelText),
                  esc(row.inText),
                  esc(row.outText),
                  esc(row.categoryText),
                ]),
                '还没有企业资金流水',
              )}
            </div>
            <div class="block">
              <div class="note">出资、分红、暂停/恢复经营、清算与「推进到下一事件」在「日常经营」里办理；上市、融资、回购与资本宣传在证券中心办理。</div>
            </div>`;
          break;
        case 'actions':
          content = renderBusinessActions(b);
          break;
        case 'market':
          content = renderBusinessMarket(b);
          break;
        case 'capital':
          content = this.renderCapital(view.capital, this.capitalMode);
          break;
        default:
          content = '';
      }
    }

    return `<div class="pp-scroll">${content}</div>`;
  }

  /**
   * 资本子页。
   *
   * `full`：证券中心「公司与资本」——公司选择、上市、外部融资、报价、回购与资本宣传，外加治理；
   * `governance`：人物界面「我的公司 › 公司治理」——只保留自有公司的股权、表决与任免，
   * 资本业务只留一行指引，不在这里保留半套入口。
   */
  private renderCapital(view: CapitalView, mode: CapitalMode): string {
    const cap = view;
    const perm = cap.canManage ? '' : 'disabled';
    const propose = cap.canPropose ? '' : 'disabled';
    // 公司选择只在证券中心出现：那里才同时覆盖自有公司与其它持股公司
    const selector =
      mode === 'full' && cap.companies.length
        ? `<div class="pp-subnav">${cap.companies
            .map(
              (item) =>
                `<button type="button" class="pp-subnav-item${item.selected ? ' active' : ''}" data-action="pp-capital-company" data-company="${esc(item.id)}">${esc(item.name)} · ${esc(item.label)}</button>`,
            )
            .join('')}</div>`
        : '';

    const capRows = cap.capTable
      .map((row) => {
        const canAppoint =
          cap.canPropose && row.holderId !== 'treasury' && row.holderId !== cap.ceoHolderId;
        const appointLabel = row.roleText === 'CEO' ? '现任' : '任命为 CEO';
        return `
        <div class="pp-row${row.isPlayer ? ' pp-row-player' : ''}">
          <span>${esc(row.label)}${row.roleText ? ` <span class="pp-tag">${esc(row.roleText)}</span>` : ''}</span>
          <span class="num">${esc(row.sharesText)}</span>
          <span class="num">${esc(row.ratioText)}</span>
          <span class="num">${esc(row.votingText)}</span>
          <span class="pp-row-side">
            ${
              row.holderId === 'treasury'
                ? ''
                : `<button type="button" class="btn btn-sm btn-ghost" data-action="appoint-ceo" data-company="${esc(cap.companyId)}" data-holder="${esc(row.holderId)}" ${canAppoint ? '' : 'disabled'}>${appointLabel}</button>`
            }
          </span>
        </div>`;
      })
      .join('');

    const quoteRows = cap.quotes
      .map(
        (quote) => `
        <div class="pp-card">
          <div class="pp-row">
            <span><strong>${esc(quote.investorName)}</strong></span>
            <span class="num">${esc(quote.amountText)} 到账</span>
            <span class="pp-row-side">
              <button type="button" class="btn btn-sm" data-action="accept-quote" data-quote="${esc(quote.quoteId)}" ${perm}>接受这份报价</button>
            </span>
          </div>
          <div class="pp-rows">
            <div class="pp-row"><span>新发股数 / 每股发行价</span><span class="num">${esc(quote.sharesText)} 股 · ${esc(quote.priceText)}</span></div>
            <div class="pp-row"><span>隐含投前 / 投后估值</span><span class="num">${esc(quote.preMoneyText)} → ${esc(quote.postMoneyText)}</span></div>
            <div class="pp-row"><span>投资者融资后持股</span><span class="num">${esc(quote.investorRatioText)}</span></div>
            <div class="pp-row"><span>你的持股 / 表决权</span><span class="num">${esc(quote.playerRatioText)} · ${esc(quote.votingText)}</span></div>
            <div class="pp-row"><span>有效期至</span><span class="num">${esc(quote.expiresText)}</span></div>
          </div>
          <div class="pp-hint${quote.losesControl ? ' warn' : ''}">${
            quote.losesControl
              ? '接受后你的表决权不超过 50%：控制权需要靠治理而不是持股自动维持。'
              : '接受后你仍保有超过 50% 的表决权。'
          } 发行价只决定本轮金额与新增股数，不直接改写公开市场价。</div>
        </div>`,
      )
      .join('');

    const proposals = cap.proposals.length
      ? cap.proposals
          .map(
            (proposal) => `
        <div class="pp-row">
          <span>${esc(proposal.title)} <span class="pp-tag">${esc(proposal.originText)}</span></span>
          <span class="pp-tag ${proposal.resultText === '通过' ? 'pos' : proposal.resultText === '未通过' ? 'neg' : ''}">${esc(proposal.resultText)}</span>
          <span class="pp-hint">${esc(proposal.deadlineText)} · ${esc(proposal.playerVoteText)}</span>
          <span class="pp-hint">${esc(proposal.note)}</span>
          ${
            proposal.canVote
              ? `<span class="pp-row-side">
                  <button type="button" class="btn btn-sm" data-action="vote-proposal" data-company="${esc(cap.companyId)}" data-proposal="${esc(proposal.id)}" data-vote="yes" ${propose}>赞成</button>
                  <button type="button" class="btn btn-sm btn-ghost" data-action="vote-proposal" data-company="${esc(cap.companyId)}" data-proposal="${esc(proposal.id)}" data-vote="no" ${propose}>反对</button>
                  <button type="button" class="btn btn-sm btn-ghost" data-action="vote-proposal" data-company="${esc(cap.companyId)}" data-proposal="${esc(proposal.id)}" data-vote="abstain" ${propose}>弃权</button>
                </span>`
              : ''
          }
        </div>`,
          )
          .join('')
      : '<div class="pp-empty">还没有董事会提案</div>';

    const passive = cap.passiveHoldings.length
      ? cap.passiveHoldings
          .map(
            (item) => `
        <div class="pp-row">
          <span>${esc(item.companyName)}</span>
          <span class="num">${esc(item.ratioText)}</span>
          <span class="num">${esc(item.valueText)}</span>
          <span class="pp-hint">${esc(item.note)}</span>
        </div>`,
          )
          .join('')
      : '';

    const governance = `
      <div class="pp-card">
        <div class="pp-card-title">股权与治理 · ${esc(cap.companyName || '未选择公司')}</div>
        <div class="pp-hint">${esc(cap.permissionText)}</div>
        <div class="pp-kpi-row">
          ${kpi({ label: '总股本', valueText: cap.totalSharesText })}
          ${kpi({ label: '库存股', valueText: cap.treasuryText })}
          ${kpi({ label: 'CEO', valueText: cap.ceoText })}
          ${kpi({ label: '你的持股', valueText: cap.playerRatioText })}
          ${kpi({ label: '你的表决权', valueText: cap.playerVotingText })}
        </div>
        <div class="pp-rows">${capRows}</div>
        <div class="actions" style="margin-top:8px">
          <button type="button" class="btn btn-sm btn-ghost" data-action="remove-ceo" data-company="${esc(cap.companyId)}" data-holder="${esc(cap.ceoHolderId)}" ${propose && cap.ceoHolderId ? '' : 'disabled'}>罢免现任 CEO</button>
        </div>
        <div class="pp-hint">任免通过表决生效：赞成必须严格超过有效股份的 50%，库存股不投票。首轮最多同时管理一家公司。</div>
      </div>`;

    const listing = `
      <div class="pp-card">
        <div class="pp-card-title">上市与估值</div>
        <div class="pp-kpi-row">
          ${kpi({ label: '上市状态', valueText: cap.listed ? '已上市' : '未上市' })}
          ${kpi({ label: '现价', valueText: cap.priceText })}
          ${kpi({ label: '每股合理价值', valueText: cap.perShareValueText })}
          ${kpi({ label: '公司合理价值', valueText: cap.fairValueText })}
        </div>
        <div class="pp-hint">${esc(cap.listingText)}</div>
        <div class="actions" style="margin-top:8px">
          <button type="button" class="btn btn-primary" data-action="list-company" ${cap.canList ? '' : 'disabled'}>申请上市</button>
        </div>
      </div>`;

    const financing = `
      <div class="pp-card">
        <div class="pp-card-title">外部股权融资</div>
        <div class="pp-hint">${esc(cap.financingStatusText)}${cap.cooldownText ? ` · ${esc(cap.cooldownText)}` : ''}</div>
        <div class="field-row">
          <input class="field" data-el="financing-input" inputmode="decimal" placeholder="拟融资金额（元，${esc(cap.limits.minRequestText)}–${esc(cap.limits.maxRequestText)}）" ${perm} />
          <button type="button" class="btn" data-action="request-financing" ${perm}>发起融资</button>
        </div>
        ${cap.quotes.length ? `${quoteRows}<div class="actions" style="margin-top:8px"><button type="button" class="btn btn-sm btn-ghost" data-action="reject-quotes" ${perm}>拒绝全部报价</button></div>` : '<div class="pp-empty">当前没有待接受的报价</div>'}
      </div>`;

    const buyback = `
      <div class="pp-card">
        <div class="pp-card-title">回购与宣传</div>
        <div class="pp-hint">参考上限（不是本次数量）：${esc(cap.buybackMaxText)}。${esc(cap.buybackNote)}</div>
        <div class="field-row">
          <input class="field" data-el="buyback-input" inputmode="numeric" placeholder="本次回购股数" ${perm} />
          <button type="button" class="btn btn-sm" data-action="buyback" ${perm}>确认回购</button>
        </div>
        <div class="pp-rows">
          <div class="pp-row"><span>请求股数</span><span class="num" data-el="buyback-request">${cap.buybackRequestShares > 0 ? cap.buybackRequestShares : '—'}</span></div>
          <div class="pp-row"><span>实际可成交</span><span class="num" data-el="buyback-executable">${cap.buybackPreviewExecutable > 0 ? cap.buybackPreviewExecutable : '—'}</span></div>
          <div class="pp-row"><span>含冲击均价</span><span class="num" data-el="buyback-price">${esc(cap.buybackPreviewPriceText)}</span></div>
          <div class="pp-row"><span>总金额</span><span class="num" data-el="buyback-amount">${esc(cap.buybackPreviewAmountText)}</span></div>
          <div class="pp-row"><span>价格影响</span><span class="num" data-el="buyback-impact">${esc(cap.buybackPreviewImpactText)}</span></div>
        </div>
        <div class="pp-hint" data-el="buyback-preview"${cap.buybackPreviewPrice > 0 ? ` data-price="${cap.buybackPreviewPrice}"` : ''}>${esc(cap.buybackPreviewNote)}</div>
        <div class="field-row" style="margin-top:8px">
          <input class="field" data-el="promotion-input" inputmode="decimal" placeholder="宣传预算（元，${esc(cap.limits.minPromotionText)}–${esc(cap.limits.maxPromotionText)}）" ${perm} />
          <button type="button" class="btn btn-sm" data-action="promote" ${perm}>宣传</button>
        </div>
        <div class="pp-hint">${esc(cap.promotionText)} · 固定失败率 ${esc(cap.limits.failRateText)}，失败也支付费用</div>
      </div>`;

    const proposalsBlock = `
      <div class="pp-card">
        <div class="pp-card-title">董事会提案</div>
        ${cap.openProposalText ? `<div class="pp-hint warn">${esc(cap.openProposalText)}</div>` : ''}
        ${proposals}
        <div class="pp-hint">外部股东提案有 ${cap.limits.voteWindowDays} 个游戏日的表决窗口；你不投票按弃权处理，系统不会把你的股份自动算成赞成。</div>
      </div>`;

    const passiveBlock = passive
      ? `<div class="pp-card"><div class="pp-card-title">其他持股</div><div class="pp-rows">${passive}</div></div>`
      : '';

    if (mode === 'governance') {
      return `
        <div class="pp-card">
          <div class="pp-card-title">资本业务入口</div>
          <div class="pp-hint">上市、外部融资、接受投资报价、股份回购与公司资本宣传在「${esc(BRANDING.cityStem)}证券中心 › 公司与资本」办理；产品营销预算仍在「产品与研发」里。</div>
        </div>
        ${governance}
        ${proposalsBlock}
        ${passiveBlock}
      `;
    }

    return `${selector}${governance}${listing}${financing}${buyback}${proposalsBlock}${passiveBlock}`;
  }

  private syncWindowVisibility(): void {
    if (this.section === 'stocks') this.windows.showAll();
    else this.windows.hideAll();
  }

  /** 浮窗正文与卡片读同一份视图；位置与层级不动。 */
  private paintWindows(force: boolean): void {
    const view = this.lastView;
    if (!view || this.section !== 'stocks') return;
    // 浮窗在独立的浮层里，不在正文容器内：必须从浮层查节点，
    // 否则每次刷新都判定为「没有正文」而整块重建，图表缩放与内部滚动都会被重置。
    const layer = this.floatEl;
    if (!layer) return;
    for (const id of this.windows.openIds()) {
      const card = view.stocks.cards.find((item) => item.id === id);
      if (!card) {
        this.windows.close(id);
        this.windowShape.delete(id);
        continue;
      }
      const shape = `${card.shares}|${card.trades.length}`;
      const scope = layer.querySelector<HTMLElement>(`[data-stock-window="${id}"]`);
      const hasBody = (scope?.querySelector('.stock-window-body')?.childElementCount ?? 0) > 0;
      if (scope && hasBody && this.windowShape.get(id) === shape) {
        // 结构没变：只更新数字，不重建正文、不动位置
        patchStockWindowNumbers(scope, card);
        continue;
      }
      this.windowShape.set(id, shape);
      this.windows.syncContent(id, {
        title: card.name,
        subtitle: card.symbol,
        body: renderStockWindowBody(card),
      });
    }
    if (force) this.windows.layout();
  }
}
