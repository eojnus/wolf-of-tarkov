/**
 * 股票详情浮动窗管理 —— 打开、关闭、置顶、拖动与显隐。
 *
 * 只处理「窗口」这件事：位置、层级、显隐都留在内存里，不写进 GameState、不进存档。
 * 关闭整个管理界面时窗口被销毁，但打开状态与位置会保留，
 * 同一会话里再次打开时恢复；新游戏或读档则整体重置。
 */

/** 同时打开的辅助窗上限：超出时关闭最早打开的一个。 */
const MAX_WINDOWS = 2;

export interface StockWindowContent {
  readonly title: string;
  readonly subtitle: string;
  readonly body: string;
}

interface WindowEntry {
  readonly id: string;
  el: HTMLElement;
  x: number;
  y: number;
  z: number;
  visible: boolean;
}


export class StockWindowManager {
  private layer: HTMLElement | null = null;
  private readonly windows = new Map<string, WindowEntry>();
  private readonly positions = new Map<string, { x: number; y: number }>();
  private readonly openOrder: string[] = [];
  private zTop = 30;
  private drag: {
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null = null;

  attach(layer: HTMLElement): void {
    this.layer = layer;
    layer.innerHTML = '';
    this.windows.clear();
    // 恢复本会话内的打开顺序
    for (const id of this.openOrder) {
      const pos = this.positions.get(id) ?? { x: 24, y: 24 };
      this.createShell(id, pos.x, pos.y);
    }
    this.layout();
  }

  detach(): void {
    this.endDrag();
    if (this.layer) this.layer.innerHTML = '';
    this.layer = null;
    this.windows.clear();
  }

  /** 当前打开的股票 id（按打开顺序）。 */
  openIds(): string[] {
    return [...this.openOrder];
  }

  has(id: string): boolean {
    return this.openOrder.includes(id);
  }

  /** 打开或唤起某只股票的窗口。重复调用只置顶，不新建。 */
  open(id: string, content: StockWindowContent): void {
    const existing = this.windows.get(id);
    if (existing) {
      this.fill(existing, content);
      this.focus(id);
      return;
    }
    if (!this.layer) return;
    // 辅助窗最多两个：再多就关掉最早打开的那个，避免层层叠加遮住主窗口
    while (this.openOrder.length >= MAX_WINDOWS) {
      const oldest = this.openOrder[0];
      if (oldest === undefined) break;
      this.close(oldest);
    }
    if (!this.positions.has(id)) {
      const offset = this.openOrder.length * 24;
      this.positions.set(id, { x: 28 + offset, y: 20 + offset });
    }
    const pos = this.positions.get(id)!;
    const entry = this.createShell(id, pos.x, pos.y);
    if (!entry) return;
    this.fill(entry, content);
    this.openOrder.push(id);
    this.focus(id);
    this.layout();
  }

  /** 内容更新：只换正文，不动位置、不抢焦点。 */
  syncContent(id: string, content: StockWindowContent): void {
    const entry = this.windows.get(id);
    if (!entry) return;
    this.fill(entry, content);
  }

  focus(id: string): void {
    const entry = this.windows.get(id);
    if (!entry) return;
    entry.visible = true;
    entry.el.hidden = false;
    this.zTop += 1;
    entry.z = this.zTop;
    entry.el.style.zIndex = String(entry.z);
  }

  close(id: string): void {
    const entry = this.windows.get(id);
    if (!entry) {
      const index = this.openOrder.indexOf(id);
      if (index >= 0) this.openOrder.splice(index, 1);
      return;
    }
    entry.el.remove();
    this.windows.delete(id);
    const index = this.openOrder.indexOf(id);
    if (index >= 0) this.openOrder.splice(index, 1);
    if (this.drag?.id === id) this.endDrag();
  }

  /** 关闭最上层窗口；没有窗口时返回 false（交给上层关闭整个界面）。 */
  closeTop(): boolean {
    let top: WindowEntry | null = null;
    for (const entry of this.windows.values()) {
      if (!entry.visible) continue;
      if (!top || entry.z > top.z) top = entry;
    }
    if (!top) return false;
    this.close(top.id);
    return true;
  }

  hideAll(): void {
    for (const entry of this.windows.values()) {
      entry.visible = false;
      entry.el.hidden = true;
    }
  }

  showAll(): void {
    for (const entry of this.windows.values()) {
      entry.visible = true;
      entry.el.hidden = false;
    }
  }

  /** 浏览器尺寸变化后重新限制位置，保证标题栏与关闭按钮都在可视范围内。 */
  layout(): void {
    const layer = this.layer;
    if (!layer) return;
    const bounds = layer.getBoundingClientRect();
    for (const entry of this.windows.values()) {
      const width = entry.el.offsetWidth || 320;
      const height = entry.el.offsetHeight || 260;
      // 整窗留在窗口范围内：标题栏与右上角关闭按钮都不会被裁掉
      const maxX = Math.max(0, bounds.width - width);
      const maxY = Math.max(0, bounds.height - height);
      entry.x = Math.min(Math.max(entry.x, 0), maxX);
      entry.y = Math.min(Math.max(entry.y, 0), maxY);
      entry.el.style.left = `${Math.round(entry.x)}px`;
      entry.el.style.top = `${Math.round(entry.y)}px`;
      this.positions.set(entry.id, { x: entry.x, y: entry.y });
    }
  }

  /** 新游戏 / 读档后清空窗口状态。 */
  resetSession(): void {
    this.detach();
    this.positions.clear();
    this.openOrder.length = 0;
  }

  private createShell(id: string, x: number, y: number): WindowEntry | null {
    const layer = this.layer;
    if (!layer) return null;
    const el = document.createElement('div');
    el.className = 'stock-window';
    el.dataset.stockWindow = id;
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    el.innerHTML = `
      <header class="stock-window-head" data-window-head>
        <div class="stock-window-title">
          <b></b>
          <span></span>
        </div>
        <button type="button" class="stock-window-close" data-action="close-stock" data-stock="${id}" aria-label="关闭该股票窗口">×</button>
      </header>
      <div class="stock-window-body"></div>
    `;
    layer.appendChild(el);

    el.addEventListener('pointerdown', () => this.focus(id));
    const head = el.querySelector<HTMLElement>('[data-window-head]');
    head?.addEventListener('pointerdown', (event) => this.beginDrag(event, id));

    const entry: WindowEntry = { id, el, x, y, z: this.zTop, visible: true };
    el.style.zIndex = String(entry.z);
    this.windows.set(id, entry);
    return entry;
  }

  private fill(entry: WindowEntry, content: StockWindowContent): void {
    const title = entry.el.querySelector('.stock-window-title b');
    const subtitle = entry.el.querySelector('.stock-window-title span');
    const body = entry.el.querySelector<HTMLElement>('.stock-window-body');
    if (title && title.textContent !== content.title) title.textContent = content.title;
    if (subtitle && subtitle.textContent !== content.subtitle) {
      subtitle.textContent = content.subtitle;
    }
    if (body && body.dataset.signature !== content.body) {
      body.dataset.signature = content.body;
      body.innerHTML = content.body;
    }
  }

  private beginDrag(event: PointerEvent, id: string): void {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    // 关闭按钮不参与拖动
    if (target?.closest('[data-action="close-stock"]')) return;
    const entry = this.windows.get(id);
    if (!entry) return;
    event.preventDefault();
    this.drag = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: entry.x,
      originY: entry.y,
    };
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('pointercancel', this.handlePointerUp);
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    const layer = this.layer;
    if (!drag || !layer) return;
    if (drag.pointerId !== event.pointerId) return;
    const entry = this.windows.get(drag.id);
    if (!entry) return;
    const bounds = layer.getBoundingClientRect();
    const width = entry.el.offsetWidth || 320;
    const height = entry.el.offsetHeight || 260;
    const nextX = drag.originX + (event.clientX - drag.startX);
    const nextY = drag.originY + (event.clientY - drag.startY);
    // 整窗留在可视范围内，保证标题栏与关闭按钮始终可点
    const minX = 0;
    const maxX = Math.max(0, bounds.width - width);
    const minY = 0;
    const maxY = Math.max(0, bounds.height - height);
    entry.x = Math.min(Math.max(nextX, minX), maxX);
    entry.y = Math.min(Math.max(nextY, minY), maxY);
    entry.el.style.left = `${Math.round(entry.x)}px`;
    entry.el.style.top = `${Math.round(entry.y)}px`;
    this.positions.set(entry.id, { x: entry.x, y: entry.y });
  };

  private readonly handlePointerUp = (): void => {
    this.endDrag();
  };

  private endDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('pointercancel', this.handlePointerUp);
  }
}
