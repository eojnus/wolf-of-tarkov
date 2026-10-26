/**
 * 便利店面板 —— 生存状态、商品购买、岗位入职/切换与开始工作、背包快捷入口。
 *
 * 界面纪律：
 *  - 只消费 app/supplies-view 的只读视图，不直接读 features，也不修改经济状态；
 *  - 购买数量草稿只存在内存（不进 GameState、不进存档），新游戏/读档清空；
 *  - 面板打开时时间继续流逝：输入期间只原地更新数值与按钮状态，不重建输入框；
 *  - 购买请求的 requestId 只来自视图里的补给 cursor（读取不消耗序号）：
 *    同一笔重试复用冻结的请求；商品或数量变化即新操作，重新确认后再提交；
 *  - 赞助式确认：确认框里的商品、数量、金额固定在这一刻，提交后命令层重新校验。
 */

import { formatMoney } from '../core/money';
import type { ShopOfferView, SuppliesView } from '../app/supplies-view';

export interface ShopUiHandlers {
  /** `code` 用于区分「已应用 / 重放 / 协议拒绝」，界面据此决定是否清理 pending。 */
  onPurchase(
    shopId: string,
    itemId: string,
    quantity: number,
    requestId: string,
  ): { ok: boolean; code: string; message: string | null };
  onHire(jobId: string): { ok: boolean; message: string | null };
  onWorkShift(minutes?: number): { ok: boolean; message: string | null };
  onOpenInventory(): void;
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bar(
  label: string,
  text: string,
  percent: number,
  liveKey: string,
  extraClass: string,
  barKey: string,
): string {
  return `
    <div class="survival-row">
      <span class="survival-label">${esc(label)}</span>
      <span class="survival-value num" data-live="${esc(liveKey)}">${esc(text)}</span>
    </div>
    <div class="survival-bar"><i class="${extraClass}" data-el="${esc(barKey)}" style="width:${Math.max(0, Math.min(100, percent)).toFixed(1)}%"></i></div>`;
}

export class ShopPanel {
  private drafts: Record<string, string> = {};
  private pending: { itemId: string; quantity: number; requestId: string } | null = null;

  constructor(
    private readonly view: () => SuppliesView,
    private readonly handlers: ShopUiHandlers,
  ) {}

  /** 新游戏 / 读档后清空未提交的购买草稿。 */
  resetSession(): void {
    this.drafts = {};
    this.pending = null;
  }

  /** 输入事件：实时保存每个商品的购买数量草稿（只在内存）。 */
  handleInput(target: HTMLInputElement): boolean {
    const name = target.getAttribute('data-el');
    if (!name || !name.startsWith('shop-qty-')) return false;
    const itemId = name.slice('shop-qty-'.length);
    this.drafts[itemId] = target.value;
    return true;
  }

  handleAction(action: string, target: HTMLElement): boolean {
    switch (action) {
      case 'shop-buy': {
        const itemId = target.dataset.item;
        if (!itemId) return false;
        this.submitPurchase(itemId, target);
        return true;
      }
      case 'shop-hire': {
        const jobId = target.dataset.job;
        if (!jobId) return false;
        const outcome = this.handlers.onHire(jobId);
        if (outcome.ok) this.pending = null;
        return true;
      }
      case 'shop-work':
        this.handlers.onWorkShift(
          target.dataset.minutes ? Number(target.dataset.minutes) : undefined,
        );
        return true;
      case 'shop-open-inventory':
        this.handlers.onOpenInventory();
        return true;
      default:
        return false;
    }
  }

  /** 只更新数值与按钮可用状态，不触碰输入框、焦点与滚动。 */
  patchLive(root: HTMLElement): void {
    const view = this.view();
    const values: Record<string, string> = {
      'shop.cash': view.cashText,
      // 顶部「效率 / 移动」与下方两条生存进度用同一份视图、同一时刻的数据
      'shop.efficiency': `${view.survival.efficiencyText} · ${view.survival.moveText}`,
      'shop.hunger': `${view.survival.hungerText} · ${view.survival.efficiencyText}`,
      'shop.water': `${view.survival.waterText} · ${view.survival.moveText}`,
      'shop.effect': view.survival.effectText || '状态良好',
      'shop.job-status': view.job.workReason,
      'shop.job-title': view.job.title,
    };
    for (const el of root.querySelectorAll<HTMLElement>('[data-live]')) {
      const key = el.dataset.live;
      if (!key) continue;
      const text = values[key];
      if (text === undefined) continue;
      if (el.textContent !== text) el.textContent = text;
    }
    for (const el of root.querySelectorAll<HTMLButtonElement>('[data-live-disabled]')) {
      const key = el.dataset.liveDisabled;
      if (!key) continue;
      if (key === 'shop.work') {
        el.disabled = !view.job.workAvailable;
      } else if (key === 'shop.hire') {
        el.disabled = view.job.hiredHere;
      } else if (key.startsWith('shop.buy:')) {
        const itemId = key.slice('shop.buy:'.length);
        const offer = view.shop.offers.find((row) => row.itemId === itemId);
        el.disabled = !offer?.canAfford;
      }
    }
    const effect = root.querySelector<HTMLElement>('[data-live="shop.effect"]');
    if (effect) {
      effect.classList.toggle('warn', view.survival.zeroHunger || view.survival.zeroWater);
    }
    const bars: Array<[string, number, boolean, boolean]> = [
      ['shop-hunger-fill', view.survival.hungerPercent, view.survival.lowHunger, view.survival.zeroHunger],
      ['shop-water-fill', view.survival.waterPercent, view.survival.lowWater, view.survival.zeroWater],
    ];
    for (const [name, percent, low, zero] of bars) {
      const node = root.querySelector<HTMLElement>(`[data-el="${name}"]`);
      if (!node) continue;
      node.style.width = `${Math.max(0, Math.min(100, percent)).toFixed(1)}%`;
      node.classList.toggle('low', low);
      node.classList.toggle('zero', zero);
    }
  }

  renderBody(): string {
    const view = this.view();
    const s = view.survival;
    return `
      <div class="block">
        <div class="block-title">你的状态</div>
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-label">现金</div>
            <div class="stat-value num" data-live="shop.cash">${esc(view.cashText)}</div>
            <div class="stat-note">购买只使用现金；存款需先到银行取现</div>
          </div>
          <div class="stat">
            <div class="stat-label">效率 / 移动</div>
            <div class="stat-value num" data-live="shop.efficiency">${esc(s.efficiencyText)} · ${esc(s.moveText)}</div>
            <div class="stat-note">两项惩罚按加法叠加，不会死亡</div>
          </div>
        </div>
        <div class="survival-block">
          ${bar('饱食度', `${s.hungerText} · ${s.efficiencyText}`, s.hungerPercent, 'shop.hunger', s.zeroHunger ? 'zero' : s.lowHunger ? 'low' : '', 'shop-hunger-fill')}
          ${bar('水分', `${s.waterText} · ${s.moveText}`, s.waterPercent, 'shop.water', s.zeroWater ? 'zero' : s.lowWater ? 'low' : '', 'shop-water-fill')}
          <div class="survival-effect${s.effectText ? ' warn' : ''}" data-live="shop.effect">${esc(s.effectText || '状态良好')}</div>
        </div>
      </div>

      <div class="block">
        <div class="block-title">便利店岗位</div>
        <div class="kv-list">
          <div class="kv"><span class="k">岗位</span><span class="v" data-live="shop.job-title">${esc(view.job.title)}</span></div>
          <div class="kv"><span class="k">时薪</span><span class="v num">${esc(view.job.wageText)}</span></div>
        </div>
        <div class="note" data-live="shop.job-status">${esc(view.job.workReason)}</div>
        <div class="actions">
          <button type="button" class="btn" data-action="shop-hire" data-job="${esc(view.job.jobId)}" data-live-disabled="shop.hire"${view.job.hiredHere ? ' disabled' : ''}>${view.job.hiredHere ? '已在本店任职' : view.job.hiredElsewhere ? '切换到此岗位' : '入职便利店'}</button>
          <button type="button" class="btn btn-primary" data-action="shop-work" data-live-disabled="shop.work"${view.job.workAvailable ? '' : ' disabled'}>开始工作</button>
          <button type="button" class="btn" data-action="shop-work" data-minutes="60" data-live-disabled="shop.work"${view.job.workAvailable ? '' : ' disabled'}>工作 1 小时</button>
        </div>
        <div class="note">一次只能在一个岗位在职；切换岗位保留已赚工资与今日工时上限。工资在月末结算发放。</div>
      </div>

      <div class="block">
        <div class="block-title">${esc(view.shop.name)}</div>
        <div class="note">${esc(view.shop.description)}</div>
        <div class="shop-items">${view.shop.offers.map((offer) => this.renderItem(view, offer)).join('')}</div>
        <div class="note">${esc(view.shop.note)}</div>
        <div class="actions">
          <button type="button" class="btn btn-ghost" data-action="shop-open-inventory">打开背包</button>
        </div>
      </div>
    `;
  }

  private renderItem(view: SuppliesView, offer: ShopOfferView): string {
    const draft = this.drafts[offer.itemId] ?? '1';
    return `
      <div class="shop-item">
        <div class="shop-item-main">
          <div class="shop-item-name">${esc(offer.name)} <span class="badge">${esc(offer.effectText)}</span></div>
          <div class="shop-item-desc">${esc(offer.description)}</div>
        </div>
        <div class="shop-item-price num">${esc(offer.priceText)}</div>
        <div class="shop-item-buy">
          <input class="field field-sm" type="number" min="1" step="1" inputmode="numeric" data-el="shop-qty-${esc(offer.itemId)}" value="${esc(draft)}" aria-label="${esc(offer.name)}购买数量" />
          <button type="button" class="btn btn-sm btn-primary" data-action="shop-buy" data-item="${esc(offer.itemId)}" data-live-disabled="shop.buy:${esc(offer.itemId)}"${view.cash >= offer.priceCents ? '' : ' disabled'}>购买</button>
        </div>
      </div>`;
  }

  private submitPurchase(itemId: string, target: HTMLElement): void {
    const view = this.view();
    const offer = view.shop.offers.find((row) => row.itemId === itemId);
    if (!offer) return;
    const input = target.closest('.shop-item')?.querySelector<HTMLInputElement>(
      `input[data-el="shop-qty-${itemId}"]`,
    );
    const raw = (input?.value ?? this.drafts[itemId] ?? '').trim();
    this.drafts[itemId] = raw;
    const quantity = Number(raw);
    const valid = Number.isSafeInteger(quantity) && quantity > 0;
    // 非正整数同样固定成一次请求（数量 0），交命令层给出统一错误提示
    const effectiveQuantity = valid ? quantity : 0;

    // 规范 requestId 只来自当前 cursor；读取不消耗序号。
    // pending 只在「商品 + 数量 + requestId」完全相同时才算同一次重试，
    // 购买内容变化即视为新操作：必须重新确认，不能静默沿用旧请求。
    const requestId = view.requestCursor.requestId;
    const retry =
      this.pending !== null &&
      this.pending.itemId === itemId &&
      this.pending.quantity === effectiveQuantity &&
      this.pending.requestId === requestId;

    // 新操作先确认这一刻的商品、数量与金额；重试沿用已确认过的那一笔
    if (valid && !retry) {
      const total = offer.priceCents * quantity;
      const confirmed = window.confirm(
        `确认购买 ${offer.name} × ${quantity}？\n\n` +
          `· 单价：${formatMoney(offer.priceCents)}\n` +
          `· 合计：${formatMoney(total)}\n` +
          `· 从个人现金扣款（当前 ${view.cashText}）；现金不足会整体拒绝\n` +
          `· 购买后可从背包使用，不自动进食`,
      );
      if (!confirmed) return;
    }

    // 冻结本次 itemId / quantity / requestId，重试期间不再改变
    this.pending = { itemId, quantity: effectiveQuantity, requestId };
    const outcome = this.handlers.onPurchase(
      view.shop.id,
      itemId,
      effectiveQuantity,
      requestId,
    );
    if (outcome.ok) {
      // 成功（含重放）：清理 pending 与数量草稿
      this.pending = null;
      this.drafts[itemId] = '';
      if (input) input.value = '';
      return;
    }
    // 协议层已拒绝并提示：pending 立即失效，等 PanelManager 重绘带来新 cursor
    if (
      outcome.code === 'REQUEST_EXPIRED' ||
      outcome.code === 'REQUEST_OUT_OF_ORDER' ||
      outcome.code === 'INVALID_REQUEST' ||
      outcome.code === 'REQUEST_MISMATCH'
    ) {
      this.pending = null;
    }
  }
}
