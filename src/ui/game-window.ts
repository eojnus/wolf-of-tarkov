/**
 * 统一主窗口 —— 所有管理界面共用的浮动窗口外壳。
 *
 * 只负责「窗口」这件事：位置、尺寸、层级、标题栏拖动、放大/恢复与左侧分类导航。
 * 内容由调用方（PanelManager）放进 `content`；这里不读任何业务视图，也不提交命令。
 *
 * 位置、放大状态与滚动位置都只存在内存里：不进 GameState、不进存档，
 * 新游戏与读档时由调用方 `unmount()` 整体丢弃。
 */

import { icon, type IconName } from './icons';

export interface NavItem {
  readonly key: string;
  readonly label: string;
  readonly icon: IconName;
  /** 需要到特定地点才能使用时的说明（例如「需到银行办理」）。 */
  readonly lockedNote?: string;
}

export interface NavGroup {
  readonly key: string;
  readonly label: string;
  readonly icon: IconName;
  readonly items: readonly NavItem[];
}

export interface WindowChrome {
  readonly kicker: string;
  readonly title: string;
  readonly subtitle: string;
  /** 当前所在地点；纯展示，用来说明「为什么这个入口在这里」。 */
  readonly place: string | null;
}

export interface GameWindowHandlers {
  onClose(): void;
  onSelectSection(key: string): void;
}

interface Point {
  x: number;
  y: number;
}

export class GameWindow {
  private scrim: HTMLElement | null = null;
  private win: HTMLElement | null = null;
  private railEl: HTMLElement | null = null;
  private contentEl: HTMLElement | null = null;
  private floatEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private kickerEl: HTMLElement | null = null;
  private subEl: HTMLElement | null = null;
  private placeEl: HTMLElement | null = null;
  private maxBtn: HTMLButtonElement | null = null;

  private pos: Point = { x: 0, y: 0 };
  private restored: Point | null = null;
  private maximized = false;
  private drag: {
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null = null;

  constructor(
    private readonly layer: HTMLElement,
    private readonly handlers: GameWindowHandlers,
  ) {}

  get isMounted(): boolean {
    return this.win !== null;
  }

  get content(): HTMLElement | null {
    return this.contentEl;
  }

  /** 股票详情等辅助浮窗的宿主：覆盖在内容之上，不随内容滚动。 */
  get floatLayer(): HTMLElement | null {
    return this.floatEl;
  }

  get root(): HTMLElement | null {
    return this.win;
  }

  get isMaximized(): boolean {
    return this.maximized;
  }

  mount(chrome: WindowChrome): void {
    if (this.win) return;
    const scrim = document.createElement('div');
    scrim.className = 'gw-scrim';
    scrim.dataset.action = 'close';

    const win = document.createElement('section');
    win.className = 'gw';
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-modal', 'true');
    win.innerHTML = `
      <header class="gw-bar" data-gw-bar>
        <div class="gw-ident">
          <div class="gw-kicker" data-gw-kicker></div>
          <h2 class="gw-title" data-gw-title></h2>
          <p class="gw-sub" data-gw-sub></p>
        </div>
        <div class="gw-tools">
          <span class="gw-place" data-gw-place hidden></span>
          <button type="button" class="gw-btn" data-gw-max aria-label="放大窗口">${icon('maximize-2', { size: 16 })}</button>
          <button type="button" class="gw-btn gw-btn-close" data-gw-close aria-label="关闭窗口">${icon('x', { size: 16 })}</button>
        </div>
      </header>
      <div class="gw-main">
        <nav class="gw-rail" data-gw-rail aria-label="功能分类"></nav>
        <div class="gw-work">
          <div class="gw-scroll" data-gw-content></div>
          <div class="gw-float" data-gw-float></div>
        </div>
      </div>
    `;
    this.layer.appendChild(scrim);
    this.layer.appendChild(win);

    this.scrim = scrim;
    this.win = win;
    this.railEl = win.querySelector<HTMLElement>('[data-gw-rail]');
    this.contentEl = win.querySelector<HTMLElement>('[data-gw-content]');
    this.floatEl = win.querySelector<HTMLElement>('[data-gw-float]');
    this.titleEl = win.querySelector<HTMLElement>('[data-gw-title]');
    this.kickerEl = win.querySelector<HTMLElement>('[data-gw-kicker]');
    this.subEl = win.querySelector<HTMLElement>('[data-gw-sub]');
    this.placeEl = win.querySelector<HTMLElement>('[data-gw-place]');
    this.maxBtn = win.querySelector<HTMLButtonElement>('[data-gw-max]');

    this.setChrome(chrome);
    this.attachNav();

    win.querySelector<HTMLElement>('[data-gw-close]')?.addEventListener('click', () =>
      this.handlers.onClose(),
    );
    this.maxBtn?.addEventListener('click', () => this.toggleMaximize());
    const bar = win.querySelector<HTMLElement>('[data-gw-bar]');
    bar?.addEventListener('pointerdown', this.beginDrag);
    bar?.addEventListener('dblclick', (event) => {
      if ((event.target as HTMLElement | null)?.closest('button')) return;
      this.toggleMaximize();
    });

    window.addEventListener('resize', this.handleResize);

    // 首帧量出真实尺寸后再定位与入场，避免先闪一下左上角
    requestAnimationFrame(() => {
      if (!this.win) return;
      this.center();
      this.win.classList.add('is-open');
      this.scrim?.classList.add('is-open');
    });
  }

  unmount(): void {
    this.endDrag();
    window.removeEventListener('resize', this.handleResize);
    this.railEl?.removeEventListener('click', this.handleNavClick);
    this.scrim?.remove();
    this.win?.remove();
    this.scrim = null;
    this.win = null;
    this.railEl = null;
    this.contentEl = null;
    this.floatEl = null;
    this.restored = null;
    this.maximized = false;
  }

  setChrome(chrome: WindowChrome): void {
    if (this.kickerEl && this.kickerEl.textContent !== chrome.kicker) {
      this.kickerEl.textContent = chrome.kicker;
    }
    if (this.titleEl && this.titleEl.textContent !== chrome.title) {
      this.titleEl.textContent = chrome.title;
    }
    if (this.subEl && this.subEl.textContent !== chrome.subtitle) {
      this.subEl.textContent = chrome.subtitle;
    }
    if (this.placeEl) {
      this.placeEl.hidden = chrome.place === null;
      const text = chrome.place ?? '';
      if (this.placeEl.textContent !== text) this.placeEl.textContent = text;
    }
    this.win?.setAttribute('aria-label', `${chrome.kicker} · ${chrome.title}`);
  }

  /** 重建左侧分类导航。`locked` 里的栏目仍然可见但不可进入，并说明所需地点。 */
  setNav(
    groups: readonly NavGroup[],
    activeKey: string,
    locked: ReadonlySet<string> = new Set(),
  ): void {
    const rail = this.railEl;
    if (!rail) return;
    const html = groups
      .map((group) => {
        const items = group.items
          .map((item) => {
            const isActive = item.key === activeKey;
            const isLocked = locked.has(item.key);
            const cls = ['gw-nav-item', isActive ? 'is-active' : '', isLocked ? 'is-locked' : '']
              .filter(Boolean)
              .join(' ');
            // 锁定栏目只留一个锁形提示：地点写在提示与标题栏里，避免挤占分类文字
            const note = isLocked ? `<span class="gw-nav-lock">${icon('lock', { size: 12 })}</span>` : '';
            const title =
              isLocked && item.lockedNote
                ? item.lockedNote === 'Esc'
                  ? '按 Esc 打开系统菜单'
                  : `需到${item.lockedNote}现场办理`
                : '';
            return `<button type="button" class="${cls}" data-gw-nav="${item.key}"${
              isActive ? ' aria-current="page"' : ''
            }${isLocked ? ' disabled aria-disabled="true"' : ''}${
              title ? ` title="${title}"` : ''
            }>
              ${icon(item.icon, { size: 16 })}
              <span class="gw-nav-label">${item.label}</span>
              ${note}
            </button>`;
          })
          .join('');
        return `<div class="gw-nav-group">
          <div class="gw-nav-head">${icon(group.icon, { size: 14 })}<span>${group.label}</span></div>
          ${items}
        </div>`;
      })
      .join('');
    if (rail.dataset.signature === html) return;
    rail.dataset.signature = html;
    rail.innerHTML = html;
    // 分类导航比窗口高时，把当前分类滚进可见范围，避免用户找不到自己在哪
    const active = rail.querySelector<HTMLElement>('.gw-nav-item.is-active');
    if (!active) return;
    const top = active.offsetTop;
    const bottom = top + active.offsetHeight;
    if (top < rail.scrollTop || bottom > rail.scrollTop + rail.clientHeight) {
      rail.scrollTop = Math.max(0, top - 72);
    }
  }

  scrollContentTo(top: number): void {
    const el = this.scroller;
    if (el) el.scrollTop = top;
  }

  get contentScrollTop(): number {
    return this.scroller?.scrollTop ?? 0;
  }

  toggleMaximize(): void {
    const win = this.win;
    if (!win) return;
    if (this.maximized) {
      this.maximized = false;
      win.classList.remove('is-max');
      if (this.restored) {
        this.pos = { ...this.restored };
        this.applyPosition();
      }
      this.setMaxIcon(false);
      return;
    }
    this.restored = { ...this.pos };
    this.maximized = true;
    win.classList.add('is-max');
    this.setMaxIcon(true);
  }

  /** 浏览器尺寸变化：重新约束位置，保证标题栏与关闭按钮始终可点。 */
  layout(): void {
    const win = this.win;
    if (!win) return;
    if (this.maximized) return;
    const bounds = this.layer.getBoundingClientRect();
    const maxX = Math.max(0, bounds.width - win.offsetWidth);
    const maxY = Math.max(0, bounds.height - win.offsetHeight);
    this.pos.x = Math.min(Math.max(this.pos.x, 0), maxX);
    this.pos.y = Math.min(Math.max(this.pos.y, 0), maxY);
    this.applyPosition();
  }

  private get scroller(): HTMLElement | null {
    return this.win?.querySelector<HTMLElement>('.gw-scroll') ?? null;
  }

  private readonly handleNavClick = (event: Event): void => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-gw-nav]');
    const key = target?.dataset.gwNav;
    if (!key || target?.hasAttribute('disabled')) return;
    this.handlers.onSelectSection(key);
  };

  private attachNav(): void {
    this.railEl?.addEventListener('click', this.handleNavClick);
  }

  private setMaxIcon(maximized: boolean): void {
    if (!this.maxBtn) return;
    this.maxBtn.innerHTML = icon(maximized ? 'minimize-2' : 'maximize-2', { size: 16 });
    this.maxBtn.setAttribute('aria-label', maximized ? '恢复窗口大小' : '放大窗口');
  }

  private center(): void {
    const win = this.win;
    if (!win) return;
    const bounds = this.layer.getBoundingClientRect();
    this.pos.x = Math.max(0, Math.round((bounds.width - win.offsetWidth) / 2));
    this.pos.y = Math.max(0, Math.round((bounds.height - win.offsetHeight) / 2) - 8);
    this.applyPosition();
  }

  private applyPosition(): void {
    const win = this.win;
    if (!win) return;
    win.style.left = `${Math.round(this.pos.x)}px`;
    win.style.top = `${Math.round(this.pos.y)}px`;
  }

  private readonly handleResize = (): void => {
    this.layout();
  };

  private readonly beginDrag = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button')) return;
    const win = this.win;
    if (!win || this.maximized) return;
    event.preventDefault();
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: this.pos.x,
      originY: this.pos.y,
    };
    win.classList.add('is-dragging');
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.endDrag);
    window.addEventListener('pointercancel', this.endDrag);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    const win = this.win;
    if (!drag || !win || drag.pointerId !== event.pointerId) return;
    const bounds = this.layer.getBoundingClientRect();
    const nextX = drag.originX + (event.clientX - drag.startX);
    const nextY = drag.originY + (event.clientY - drag.startY);
    // 整窗留在可视区域内：标题栏与右上角按钮不会被裁到屏幕外
    const maxX = Math.max(0, bounds.width - win.offsetWidth);
    const maxY = Math.max(0, bounds.height - win.offsetHeight);
    this.pos.x = Math.min(Math.max(nextX, 0), maxX);
    this.pos.y = Math.min(Math.max(nextY, 0), maxY);
    this.applyPosition();
  };

  private readonly endDrag = (): void => {
    this.drag = null;
    this.win?.classList.remove('is-dragging');
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.endDrag);
    window.removeEventListener('pointercancel', this.endDrag);
  };
}
