/**
 * HUD —— 时间、资金摘要、生存状态、交互提示、保存入口与鼠标锁定遮罩。
 * 只渲染视图模型与场景给出的只读信息，所有写操作都通过回调转为命令。
 *
 * 暂停/速度/休息/睡觉已经迁到 TAB 标题栏的时间工具区（见 ui/panels.ts），
 * 这里不再持有任何时间控制，避免出现两套入口与两套状态。
 */

import type { GameDate } from '../core/calendar';
import { TIME } from '../content/config';
import type { GameViewModel } from '../app/view';
import type { SurvivalStatusView } from '../app/supplies-view';
import { icon } from './icons';

export interface HudHandlers {
  onOpenFinance(): void;
  onOpenPause(): void;
  onSave(): void;
  onRequestPointerLock(): void;
}

export class Hud {
  private readonly root: HTMLElement;
  private readonly dateEl: HTMLElement;
  private readonly clockEl: HTMLElement;
  private readonly chipEl: HTMLElement;
  private readonly fillEl: HTMLElement;
  private readonly cashEl: HTMLElement;
  private readonly savingsEl: HTMLElement;
  private readonly netEl: HTMLElement;
  private readonly debtEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly hintKeyEl: HTMLElement;
  private readonly hintTextEl: HTMLElement;
  private readonly hintSubEl: HTMLElement;
  private readonly saveStateEl: HTMLElement;
  private readonly moneyCardEl: HTMLElement;
  private readonly hungerTextEl: HTMLElement;
  private readonly hungerFillEl: HTMLElement;
  private readonly waterTextEl: HTMLElement;
  private readonly waterFillEl: HTMLElement;
  private readonly survivalEffectEl: HTMLElement;
  private readonly movementEl: HTMLElement;
  private readonly touchToggleEl: HTMLButtonElement;
  private readonly touchMenuEl: HTMLElement;
  private readonly lockOverlay: HTMLElement;
  private readonly lockTitle: HTMLElement;
  private hintId: string | null = null;
  private sprintingState: boolean | null = null;

  constructor(root: HTMLElement, handlers: HudHandlers) {
    this.root = root;
    root.innerHTML = `
      <div class="hud-time card">
        <div class="date-line" data-el="date"></div>
        <div class="clock-line">
          <span class="clock-main num" data-el="clock"></span>
          <span class="month-chip" data-el="chip"></span>
        </div>
        <div class="day-track"><div class="day-fill" data-el="fill"></div></div>
        <div class="movement-line">
          <span class="mode-chip" data-el="movement">行走</span>
          <span class="movement-hint">Shift 切换</span>
        </div>
      </div>

      <div class="hud-money card" data-el="money-card">
        <div class="money-cell">
          <div class="money-label">现金</div>
          <div class="money-value num" data-el="cash"></div>
        </div>
        <div class="money-cell">
          <div class="money-label">银行存款</div>
          <div class="money-value num" data-el="savings"></div>
        </div>
        <div class="money-cell">
          <div class="money-label">净资产</div>
          <div class="money-value num accent" data-el="net"></div>
        </div>
        <div class="money-cell">
          <div class="money-label">生活欠款</div>
          <div class="money-value num warn" data-el="debt"></div>
        </div>
      </div>

      <div class="hud-survival card" data-el="survival-card">
        <div class="survival-row">
          <span class="survival-label">饱食度</span>
          <span class="survival-value num" data-el="hunger-text"></span>
        </div>
        <div class="survival-bar"><i data-el="hunger-fill"></i></div>
        <div class="survival-row">
          <span class="survival-label">水分</span>
          <span class="survival-value num" data-el="water-text"></span>
        </div>
        <div class="survival-bar"><i data-el="water-fill"></i></div>
        <div class="survival-effect" data-el="survival-effect"></div>
      </div>

      <div class="hud-hint" data-el="hint" hidden>
        <span class="kbd" data-el="hint-key">F</span>
        <span data-el="hint-text"></span>
        <span class="hint-sub" data-el="hint-sub"></span>
      </div>

      <div class="hud-touch" data-el="touch">
        <button type="button" class="hud-touch-btn" data-el="touch-toggle" aria-expanded="false">
          ${icon('settings', { size: 16 })}界面
        </button>
        <div class="hud-touch-menu" data-el="touch-menu" hidden>
          <button type="button" class="btn" data-el="touch-personal">个人界面</button>
          <button type="button" class="btn" data-el="touch-pause">暂停菜单</button>
        </div>
      </div>

      <div class="hud-actions card">
        <span class="save-state" data-el="save-state"></span>
        <button type="button" class="btn btn-sm btn-ghost" data-el="save">${icon('save', { size: 14 })}保存</button>
      </div>

      <div class="hint-text">WASD 移动 · Shift 疾跑 · 鼠标转视角 · 滚轮缩放 · F 交互 · Tab 个人界面 · Esc 暂停</div>

      <div class="lock-overlay" data-el="lock" hidden>
        <div class="lock-card">
          <div class="lock-title" data-el="lock-title">点击继续游戏</div>
          <div class="lock-sub">鼠标将被锁定用于控制视角，按 Esc 可随时释放</div>
          <button type="button" class="btn btn-primary" data-el="lock-button">进入游戏</button>
        </div>
      </div>
    `;

    const pick = <T extends HTMLElement>(name: string): T => {
      const el = root.querySelector<T>(`[data-el="${name}"]`);
      if (!el) throw new Error(`HUD 元素缺失：${name}`);
      return el;
    };

    this.dateEl = pick('date');
    this.clockEl = pick('clock');
    this.chipEl = pick('chip');
    this.fillEl = pick('fill');
    this.cashEl = pick('cash');
    this.savingsEl = pick('savings');
    this.netEl = pick('net');
    this.debtEl = pick('debt');
    this.hintEl = pick('hint');
    this.hintKeyEl = pick('hint-key');
    this.hintTextEl = pick('hint-text');
    this.hintSubEl = pick('hint-sub');
    this.saveStateEl = pick('save-state');
    this.moneyCardEl = pick('money-card');
    this.hungerTextEl = pick('hunger-text');
    this.hungerFillEl = pick('hunger-fill');
    this.waterTextEl = pick('water-text');
    this.waterFillEl = pick('water-fill');
    this.survivalEffectEl = pick('survival-effect');
    this.movementEl = pick('movement');
    this.touchToggleEl = pick<HTMLButtonElement>('touch-toggle');
    this.touchMenuEl = pick('touch-menu');
    this.lockOverlay = pick('lock');
    this.lockTitle = pick('lock-title');

    const setTouchMenu = (open: boolean): void => {
      this.touchMenuEl.hidden = !open;
      this.touchToggleEl.setAttribute('aria-expanded', String(open));
    };

    this.touchToggleEl.addEventListener('click', () => {
      setTouchMenu(this.touchMenuEl.hidden);
    });
    pick<HTMLButtonElement>('touch-personal').addEventListener('click', () => {
      setTouchMenu(false);
      handlers.onOpenFinance();
    });
    pick<HTMLButtonElement>('touch-pause').addEventListener('click', () => {
      setTouchMenu(false);
      handlers.onOpenPause();
    });
    document.addEventListener('pointerdown', (event) => {
      if (this.touchMenuEl.hidden) return;
      const target = event.target as Node | null;
      if (target && this.touchToggleEl.parentElement?.contains(target)) return;
      setTouchMenu(false);
    });

    pick<HTMLButtonElement>('save').addEventListener('click', () => handlers.onSave());
    pick<HTMLButtonElement>('lock-button').addEventListener('click', () =>
      handlers.onRequestPointerLock(),
    );
    this.lockOverlay.addEventListener('click', () => handlers.onRequestPointerLock());
  }

  setTime(date: GameDate): void {
    this.dateEl.textContent = `${date.year}年${date.month}月${date.day}日`;
    this.clockEl.textContent = `${String(date.hour).padStart(2, '0')}:${String(date.minute).padStart(2, '0')}`;
    this.chipEl.textContent = `第 ${date.month} 月 · 第 ${date.day} 天`;
    const progress = Math.min(1, Math.max(0, (date.day - 1 + date.minuteOfDay / 1440) / TIME.calendar.daysPerMonth));
    this.fillEl.style.width = `${(progress * 100).toFixed(2)}%`;
  }

  setMoney(view: GameViewModel): void {
    this.cashEl.textContent = view.money.cashText;
    this.savingsEl.textContent = view.money.savingsText;
    this.netEl.textContent = view.money.netWorthText;
    this.debtEl.textContent = view.money.debtText;
    this.debtEl.style.opacity = view.money.debt > 0 ? '1' : '0.42';
    this.setSurvival(view.survival);
  }

  /**
   * 生存状态始终可见：它不随决策面板打开而隐藏（与财务卡片不同）。
   * 只更新文本、宽度和状态类，不重建 DOM。
   */
  setSurvival(survival: SurvivalStatusView): void {
    this.hungerTextEl.textContent = `${survival.hungerText} · ${survival.efficiencyText}`;
    this.waterTextEl.textContent = `${survival.waterText} · ${survival.moveText}`;
    this.hungerFillEl.style.width = `${survival.hungerPercent.toFixed(1)}%`;
    this.waterFillEl.style.width = `${survival.waterPercent.toFixed(1)}%`;
    this.hungerFillEl.classList.toggle('low', survival.lowHunger);
    this.hungerFillEl.classList.toggle('zero', survival.zeroHunger);
    this.waterFillEl.classList.toggle('low', survival.lowWater);
    this.waterFillEl.classList.toggle('zero', survival.zeroWater);
    this.survivalEffectEl.textContent = survival.effectText || '状态良好';
    this.survivalEffectEl.classList.toggle('warn', survival.zeroHunger || survival.zeroWater);
  }

  /**
   * 交互提示：只消费结构字段（id/name/subtitle），不依赖 world 或 content 的具体建筑类型，
   * 因此动态布局建筑与基础城区建筑走同一条渲染路径。
   */
  setHint(building: { readonly id: string; readonly name: string; readonly subtitle: string } | null): void {
    const nextId = building?.id ?? null;
    if (nextId === this.hintId) return;
    this.hintId = nextId;
    if (!building) {
      this.hintEl.hidden = true;
      return;
    }
    this.hintKeyEl.textContent = 'F';
    this.hintTextEl.textContent = `进入 ${building.name}`;
    this.hintSubEl.textContent = building.subtitle;
    this.hintEl.hidden = false;
  }

  setSaveState(text: string, kind: 'idle' | 'ok' | 'error'): void {
    this.saveStateEl.textContent = text;
    this.saveStateEl.className = `save-state${kind === 'idle' ? '' : ` ${kind}`}`;
  }

  /**
   * 面板打开时隐藏右上角财务卡片。
   * 只控制显隐，不改余额、不停止 setMoney 更新、不影响模拟暂停。
   */
  setPanelOpen(open: boolean): void {
    this.moneyCardEl.hidden = open;
    if (open) {
      this.touchMenuEl.hidden = true;
      this.touchToggleEl.setAttribute('aria-expanded', 'false');
    }
  }

  /**
   * ESC 菜单期间整体隐去 HUD：菜单是全屏表现，右侧要留给城市画面，
   * 不能让生存条、保存按钮和触屏入口压在菜单之上。
   */
  setMenuMode(active: boolean): void {
    this.root.classList.toggle('is-menu', active);
  }

  /** 移动模式文字（纯表现信息，不读写业务状态）。 */
  setMovementMode(sprinting: boolean): void {
    if (this.sprintingState === sprinting) return;
    this.sprintingState = sprinting;
    this.movementEl.textContent = sprinting ? '疾跑' : '行走';
    this.movementEl.classList.toggle('sprint', sprinting);
  }

  /** 鼠标未锁定时的「点击继续」遮罩。text 为 null 时隐藏。 */
  setLockOverlay(visible: boolean, title = '点击继续游戏'): void {
    this.lockOverlay.hidden = !visible;
    if (visible) this.lockTitle.textContent = title;
  }
}
