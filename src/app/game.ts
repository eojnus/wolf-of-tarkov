/**
 * 游戏组装 —— 把核心、业务模块、场景与界面接在一起。
 *
 * 时间在这里连续流逝：与人物是否移动、是否打开业务面板无关。
 * 只有「暂停菜单 / 手动暂停 / 页面隐藏」会停止模拟。
 * 所有时间入口最终都走 app/timeAdvance 的 advanceGameTime。
 */

import { dateAtMinute } from '../core/calendar';
import { cloneForWrite } from '../core/readonly';
import { describeError } from '../core/errors';
import { formatMoney } from '../core/money';
import { GameStore } from '../core/store';
import { BRANDING, SAVE, TIME } from '../content/config';
import { panelIdForInteraction, type LayoutBuilding } from '../features/city-layout';
import {
  buildSnapshot,
  downloadSnapshot,
  parseSnapshot,
  readSnapshot,
  writeSnapshot,
  type LoadResult,
  type PersistedState,
  type SaveReason,
  type SaveSlot,
  type SaveSnapshot,
} from '../infrastructure/storage';
import { World } from '../world/world';
import { Hud } from '../ui/hud';
import { PanelManager, type PanelId } from '../ui/panels';
import { ToastHost } from '../ui/toast';
import { BusinessCommands, type CommandOutcome } from './business';
import { GovernmentCommands } from './government';
import { buildGovernmentView } from './government-view';
import { buildCityEconomyView } from './city-view';
import { CapitalCommands } from './capital';
import { GameCommands } from './commands';
import { SuppliesCommands } from './supplies';
import { buildSuppliesView } from './supplies-view';
import { moveMultiplierOf } from '../features/survival';
import { createInitialState, type GameState } from './state';
import { advanceGameTime, type AdvanceResult } from './timeAdvance';
import { buildPersonalView } from './personal-view';
import { buildCapitalView, buildSecuritiesPanel } from './securities-view';
import { buildViewModel } from './view';

export interface GameElements {
  readonly viewport: HTMLElement;
  readonly hudRoot: HTMLElement;
  readonly panelRoot: HTMLElement;
  readonly toastRoot: HTMLElement;
}

export class Game {
  readonly store: GameStore<GameState>;
  readonly commands: GameCommands;
  readonly business: BusinessCommands;
  readonly capital: CapitalCommands;
  readonly government: GovernmentCommands;
  readonly supplies: SuppliesCommands;
  private readonly world: World;
  private readonly hud: Hud;
  private readonly panels: PanelManager;
  private readonly toast: ToastHost;
  private readonly unsubscribe: () => void;

  private hiddenPaused = false;
  /** 模拟时间的余量（游戏分钟，小数部分）。不足一分钟不推进，余量保留。 */
  private simAccumulator = 0;
  private lastFrameMs = 0;
  private hudTimerMs = 0;
  private rafId = 0;
  private autosaveChain: Promise<void> = Promise.resolve();
  private started = false;
  private pauseOpenedAt = 0;
  /** 当前合法商店交互上下文：只在通过建筑交互打开便利店时存在；不持久化。 */
  private activeShopId: string | null = null;
  /** 清算确认中的重入保护：确认框本身是阻塞的，这里只挡住极端重复触发。 */
  private liquidatePending = false;

  private readonly keyHandler = (event: KeyboardEvent) => this.handleKey(event);
  private readonly visibilityHandler = () => this.handleVisibility();
  /** 已同步给世界的逻辑地图 revision：只有结构变化才触发增量同步。 */
  private syncedLayoutRevision = -1;
  /** 碰撞（含模型加载或明确回退）是否就绪：未就绪时锁移动与 F 交互。 */
  private collisionReady = false;

  constructor(elements: GameElements) {
    this.store = new GameStore<GameState>(createInitialState());
    this.toast = new ToastHost(elements.toastRoot);

    this.commands = new GameCommands(this.store, {
      notify: (kind, message) => this.toast.show(kind, message),
      requestAutoSave: () => this.enqueueAutoSave(),
    });

    this.business = new BusinessCommands(this.store, {
      notify: (kind, message) => this.toast.show(kind, message),
      requestAutoSave: () => this.enqueueAutoSave(),
    });

    this.capital = new CapitalCommands(this.store, {
      notify: (kind, message) => this.toast.show(kind, message),
      requestAutoSave: () => this.enqueueAutoSave(),
    });

    this.government = new GovernmentCommands(this.store, {
      notify: (kind, message) => this.toast.show(kind, message),
      requestAutoSave: () => this.enqueueAutoSave(),
    });

    this.supplies = new SuppliesCommands(this.store, {
      notify: (kind, message) => this.toast.show(kind, message),
      requestAutoSave: () => this.enqueueAutoSave(),
      // 购买上下文由世界交互提供：没站在便利店里就无法远程购物
      currentShopId: () => this.activeShopId,
    });

    this.world = new World(elements.viewport, {
      onPointerLockChange: (locked) => this.handlePointerLockChange(locked),
      // 碰撞就绪前锁移动与 F 交互（经济模拟不暂停）；就绪后刷新提示与遮罩
      onCollisionReadyChange: (ready) => this.handleCollisionReadyChange(ready),
    });
    this.syncWorldLayout();
    this.collisionReady = this.world.isCollisionReady();

    this.hud = new Hud(elements.hudRoot, {
      onSetSpeed: (speed) => {
        this.commands.setSpeed(speed);
        this.syncClockUi();
      },
      onTogglePause: () => {
        this.handleTogglePause();
      },
      onRest: (minutes) => {
        this.commands.rest(minutes);
        this.syncClockUi();
      },
      onSleep: () => {
        this.commands.sleepUntilMorning();
        this.syncClockUi();
      },
      onOpenFinance: () => this.togglePanel('personal'),
      onOpenPause: () => this.togglePanel('pause'),
      onSave: () => {
        void this.saveToSlot('manual');
      },
      onRequestPointerLock: () => this.requestPointerLock(),
    });

    this.panels = new PanelManager(elements.panelRoot, {
      onClose: () => this.closePanel(),
      onResume: () => this.resumeFromPause(),
      onHire: (jobId?: string) => {
        this.commands.hire(jobId);
        this.syncClockUi();
      },
      onWorkShift: (minutes?: number) => {
        this.commands.workShift(minutes);
        this.syncClockUi();
      },
      onRest: (minutes) => {
        this.commands.rest(minutes);
        this.syncClockUi();
      },
      onSleep: () => {
        this.commands.sleepUntilMorning();
        this.syncClockUi();
      },
      onDeposit: (cents) => {
        this.commands.deposit(cents);
      },
      onWithdraw: (cents) => {
        this.commands.withdraw(cents);
      },
      onBuyStock: (securityId, shares, expectedPriceCents) => {
        this.commands.buyStock(securityId, shares, expectedPriceCents);
      },
      onSellStock: (securityId, shares, expectedPriceCents) =>
        this.confirmSell(securityId, shares, expectedPriceCents),
      onBorrow: (cents) => {
        this.commands.borrowLoan(cents);
      },
      onRepay: (cents) => {
        this.commands.repayLoan(cents);
      },
      onRepayAll: () => {
        this.commands.repayLoanAll();
      },
      onSave: () => {
        void this.saveToSlot('manual');
      },
      onLoad: () => {
        void this.loadFromStorage(true);
      },
      onExport: () => this.exportSnapshot(),
      onImportFile: (file) => {
        void this.importFile(file);
      },
      onNewGame: () => this.startNewGame(),
      onCreateCompany: (name, capitalCents) =>
        this.business.createCompany(name, capitalCents),
      onFundCompany: (cents) => this.business.fundCompany(cents),
      onDividend: (cents) => this.capital.payDividend(cents),
      onDividendAll: () => {
        const amount = buildViewModel(this.store.state).business.distributable;
        if (amount <= 0) return { ok: false, message: null };
        return this.capital.payDividend(amount);
      },
      onPauseCompany: () => this.business.pauseCompany(),
      onResumeCompany: () => this.business.resumeCompany(),
      onLiquidateCompany: () => this.confirmLiquidate(),
      onAdvanceEvent: () => {
        const outcome = this.business.advanceToNextEvent();
        this.syncClockUi();
        return outcome;
      },
      onHireTalent: (candidateId) => this.business.hireTalent(candidateId),
      onFireTalent: () => this.business.fireTalent(),
      onInvestTech: (cents) => this.business.investTech(cents),
      onStartResearch: (focus, days, budgetCents) =>
        this.business.startResearch(focus, days, budgetCents),
      onCancelResearch: () => this.business.cancelResearch(),
      onReleaseProduct: (productId, name, priceCents, marketingDailyCents) =>
        this.business.releaseProduct(productId, name, priceCents, marketingDailyCents),
      onSetPrice: (productId, priceCents) => this.business.setPrice(productId, priceCents),
      onSetMarketing: (productId, dailyCents) =>
        this.business.setMarketing(productId, dailyCents),
      onStopProduct: (productId) => this.business.stopProduct(productId),
      onRequestFinancing: (cents) => this.capital.requestFinancing(cents),
      onAcceptQuote: (quoteId) => this.capital.acceptQuote(quoteId),
      onRejectQuotes: () => this.capital.rejectQuotes(),
      onListCompany: () => this.capital.listCompany(),
      onBuyback: (companyId, shares, expectedPriceCents) =>
        this.confirmBuyback(companyId, shares, expectedPriceCents),
      onPromote: (cents) => this.capital.promote(cents),
      onAppointCeo: (companyId, holderId) => this.capital.appointCeo(companyId, holderId),
      onRemoveCeo: (companyId, holderId) => this.capital.removeCeo(companyId, holderId),
      onVoteProposal: (companyId, proposalId, choice) =>
        this.capital.voteOnProposal(companyId, proposalId, choice),
      onUseItem: (itemId, requestId) => this.supplies.useItem(itemId, requestId),
    }, (query) => buildPersonalView(this.store.state, query),
    (securityId, order) => buildSecuritiesPanel(this.store.state, securityId, order),
    () => buildGovernmentView(this.store.state),
    {
      onSponsor: (candidateId, amountCents, requestId) =>
        this.government.sponsor(candidateId, amountCents, requestId),
    },
    () => buildCityEconomyView(this.store.state),
    () => buildSuppliesView(this.store.state, this.activeShopId),
    {
      onPurchase: (shopId, itemId, quantity, requestId) =>
        this.supplies.purchase(shopId, itemId, quantity, requestId),
      onHire: (jobId) => {
        const outcome = this.commands.hire(jobId);
        this.syncClockUi();
        return outcome;
      },
      onWorkShift: (minutes?: number) => {
        const outcome = this.commands.workShift(minutes);
        this.syncClockUi();
        return outcome;
      },
      onOpenInventory: () => {
        this.openPanel('personal');
        this.panels.openPersonalSection('inventory');
      },
    });

    this.unsubscribe = this.store.subscribe((state) => {
      const view = buildViewModel(state);
      this.hud.setMoney(view);
      // 城区扩张/招商只改变逻辑地图 revision：增量同步世界，不重建整个场景
      this.syncWorldLayout();
      if (this.panels.isOpen) this.panels.refresh(view);
    });

    window.addEventListener('keydown', this.keyHandler);
    document.addEventListener('visibilitychange', this.visibilityHandler);

    const initial = buildViewModel(this.store.state);
    this.hud.setMoney(initial);
    this.hud.setTime(initial.date);
    this.hud.setMovementMode(false);
    this.syncClockUi();
    this.syncPanelPresentation();
    this.hud.setSaveState('', 'idle');
  }

  /* ------------------------------------------------------------ 生命周期 */

  start(): void {
    if (this.started) return;
    this.started = true;
    this.lastFrameMs = 0;
    this.rafId = requestAnimationFrame(this.tick);
    this.updateLockOverlay();
    // 启动按钮本身是用户手势，可以直接尝试锁定鼠标
    this.world.requestPointerLock();
    this.toast.show(
      'info',
      `欢迎来到${BRANDING.cityName}。点击画面锁定鼠标，按 F 与建筑交互。`,
    );
  }

  stop(): void {
    this.started = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  dispose(): void {
    this.stop();
    this.unsubscribe();
    window.removeEventListener('keydown', this.keyHandler);
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.world.dispose();
  }

  /* ------------------------------------------------------------ 主循环 */

  private tick = (now: number): void => {
    const rawDelta = this.lastFrameMs === 0 ? 0 : now - this.lastFrameMs;
    this.lastFrameMs = now;

    const paused = this.isPaused();
    // 只有「未暂停 + 未开面板 + 鼠标已锁定 + 碰撞就绪」才允许移动，
    // 避免关闭面板后遮罩还挂着时 WASD 就让人物走起来，也避免模型加载期间走进错误碰撞体
    const canMove =
      !paused && !this.panels.isOpen && this.world.isPointerLocked() && this.collisionReady;

    // 位移与模拟时钟使用不同的单帧上限：位移限制只防穿墙，不拖慢时间
    const moveDeltaMs = Math.min(rawDelta, TIME.maxMoveDeltaMs);
    // 移动倍率由生存状态推导后显式传给世界；world 不读取任何业务状态
    this.world.update(
      moveDeltaMs / 1000,
      canMove,
      moveMultiplierOf(this.store.state.survival),
    );
    this.hud.setMovementMode(this.world.isSprinting());

    if (!paused) {
      this.accumulateSimulation(Math.min(rawDelta, TIME.maxSimDeltaMs));
    }

    this.world.render(Math.min(rawDelta, 200) / 1000);
    this.hud.setHint(
      paused || this.panels.isOpen || !this.collisionReady
        ? null
        : this.world.getNearbyBuilding(),
    );

    this.hudTimerMs += rawDelta;
    if (this.hudTimerMs >= 120) {
      this.hudTimerMs = 0;
      const date = dateAtMinute(this.store.state.clock.totalMinute, TIME.calendar);
      this.hud.setTime(date);
    }

    this.rafId = requestAnimationFrame(this.tick);
  };

  /** 连续流逝：只把整数分钟交给业务，余量保留，正常帧波动不会持续丢时间。 */
  private accumulateSimulation(deltaMs: number): void {
    if (deltaMs <= 0) return;
    const speed = this.store.state.clock.speed;
    this.simAccumulator += (deltaMs / 1000) * TIME.minutesPerRealSecond * speed;
    const wholeMinutes = Math.floor(this.simAccumulator);
    if (wholeMinutes < 1) return;
    this.simAccumulator -= wholeMinutes;

    try {
      // 自然流逝不因关键事件停止：帧内的余量不能被丢弃，事件仍会被完整处理
      const result = this.store.run((draft) =>
        advanceGameTime(draft, wholeMinutes, { honorKeyEvents: false }),
      );
      this.announceNaturalAdvance(result);
      // 自然流逝中发生的月结与贷款到期同样改变存档内容，必须落盘，
      // 否则最后一次自动保存可能停留在这些事件之前。
      if (
        result.monthsSettled > 0 ||
        result.loanDueEvents.length > 0 ||
        result.researchCompletions.length > 0 ||
        result.cityEvents.length > 0 ||
        result.businessEvents.some((event) => event.kind === 'crisis' || event.kind === 'liquidated')
      ) {
        this.enqueueAutoSave();
      }
    } catch (error) {
      this.toast.show('error', `时间推进失败：${describeError(error)}`);
    }
  }

  /** 自然流逝中发生的月结与贷款到期，单独提示。 */
  private announceNaturalAdvance(result: AdvanceResult): void {
    for (const report of result.reports) {
      this.toast.show(
        'info',
        `${report.monthKey} 月结：工资 ${(report.salary / 100).toFixed(0)} 元，` +
          `房租与生活费 ${((report.rent + report.living) / 100).toFixed(0)} 元` +
          (report.newDebt > 0 ? `，新增欠款 ${(report.newDebt / 100).toFixed(0)} 元` : ''),
      );
    }
    for (const event of result.businessEvents) {
      if (event.kind === 'crisis') {
        this.toast.show(
          'error',
          `${event.companyName} 进入资金危机：${event.detail}`,
        );
      } else if (event.kind === 'liquidated') {
        this.toast.show('info', `${event.companyName} 已清算：${event.detail}`);
      }
    }
    if (result.researchCompletions.length > 0) {
      const count = result.researchCompletions.length;
      this.toast.show('success', `有 ${count} 个研发项目完成，可到企业管理面板发布`);
    }
    for (const event of result.governmentEvents) {
      if (!event.message) continue;
      if (event.kind === 'appointment' || event.kind === 'early-election-started') {
        this.toast.show('success', event.message);
      } else {
        this.toast.show('info', event.message);
      }
    }
    for (const event of result.cityEvents) {
      this.toast.show(
        event.kind === 'district-completed' ? 'success' : 'info',
        event.message,
      );
    }
    for (const event of result.loanDueEvents) {
      if (event.settled) {
        this.toast.show('info', '贷款到期，已从银行存款自动结清');
      } else if (event.overdue) {
        this.toast.show('error', '贷款到期，银行存款不足，剩余部分已转为逾期');
      } else {
        this.toast.show(
          'info',
          `贷款到期，已自动偿还 ${((event.paidInterest + event.paidPrincipal) / 100).toFixed(0)} 元`,
        );
      }
    }
  }

  private isPaused(): boolean {
    if (this.hiddenPaused) return true;
    if (this.store.state.clock.paused) return true;
    return this.panels.activePanel === 'pause';
  }

  private syncClockUi(): void {
    const clock = this.store.state.clock;
    this.hud.syncSpeed(this.isPaused(), clock.speed);
  }

  private handleVisibility(): void {
    this.hiddenPaused = document.hidden;
    if (document.hidden) {
      this.world.clearInput();
      // 回来时不补算后台时间：余量与帧基准都重置
      this.simAccumulator = 0;
      this.lastFrameMs = 0;
    }
    this.syncClockUi();
  }

  /** 把当前逻辑地图同步给场景：只在 revision 变化时做增量同步。 */
  private syncWorldLayout(): void {
    const revision = this.store.state.cityLayout.revision;
    if (revision === this.syncedLayoutRevision) return;
    this.syncedLayoutRevision = revision;
    this.world.syncLayout(this.store.state.cityLayout);
  }

  /** 碰撞就绪状态变化：刷新遮罩与交互提示（不暂停经济模拟）。 */
  private handleCollisionReadyChange(ready: boolean): void {
    this.collisionReady = ready;
    this.syncPanelPresentation();
  }

  /* ---------------------------------------------------------- 鼠标锁定 */

  private requestPointerLock(): void {
    if (this.panels.isOpen) return;
    this.world.requestPointerLock();
  }

  private handlePointerLockChange(locked: boolean): void {
    if (locked) {
      this.hud.setLockOverlay(false);
      return;
    }
    // 解锁可能是「打开面板」造成的，此时不弹暂停菜单
    if (this.panels.isOpen) return;
    if (!this.started) return;
    this.openPanel('pause');
  }

  private updateLockOverlay(): void {
    const shouldShow = this.started && !this.panels.isOpen && !this.world.isPointerLocked();
    this.hud.setLockOverlay(shouldShow);
  }

  /* ------------------------------------------------------------ 交互 */

  private isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  private handleKey(event: KeyboardEvent): void {
    if (this.isTypingTarget(event.target)) return;

    if (event.code === 'Tab') {
      event.preventDefault();
      this.togglePanel('personal');
      return;
    }

    if (event.code === 'KeyF') {
      event.preventDefault();
      if (this.panels.isOpen) {
        this.closePanel();
        return;
      }
      // 碰撞/模型加载期间锁 F 交互：不能对着占位碰撞体开面板
      if (!this.collisionReady) {
        this.toast.show('info', '场景仍在加载，请稍候');
        return;
      }
      const building = this.world.getNearbyBuilding();
      if (!building) {
        this.toast.show('info', '附近没有可以交互的设施');
        return;
      }
      const panelId = this.panelIdFor(building);
      if (panelId) {
        // 只有真实站在便利店里才建立商店上下文；离开面板即失效
        this.activeShopId = panelId === 'shop' ? (building.shopId ?? null) : null;
        this.openPanel(panelId);
      }
      return;
    }

    if (event.code === 'Escape') {
      if (this.panels.isOpen) {
        // 刚由解锁事件自动打开的暂停菜单，忽略这次 Esc，避免开了又关
        if (performance.now() - this.pauseOpenedAt < 350) return;
        // 先关最上层股票浮窗；没有浮窗时再关整个界面，一次按键只做一件事
        if (this.panels.handleEscape()) return;
        this.closePanel();
        return;
      }
      if (!this.world.isPointerLocked()) {
        this.openPanel('pause');
      }
      return;
    }

    if (event.code === 'Space') {
      event.preventDefault();
      this.handleTogglePause();
    }
  }

  /** 手动暂停/继续。切换后清理移动与疾跑输入，避免恢复时残留。 */
  private handleTogglePause(): void {
    this.commands.togglePause();
    this.world.clearInput();
    this.syncClockUi();
  }

  /**
   * 建筑 → 面板 id：统一从**当前逻辑布局**的交互标识查询，
   * 不再只查静态 CITY.buildings，因此新区建筑同样可交互。
   */
  private panelIdFor(building: LayoutBuilding): PanelId | null {
    return panelIdForInteraction(building.interactionId) as PanelId | null;
  }

  private togglePanel(id: PanelId): void {
    if (this.panels.isOpen && this.panels.activePanel === id) {
      this.closePanel();
      return;
    }
    this.openPanel(id);
  }

  private openPanel(id: PanelId): void {
    // 商店购买上下文只属于便利店面板；打开其它面板即失效
    if (id !== 'shop') this.activeShopId = null;
    // 从暂停菜单切换到其他面板时，必须先解除暂停，否则会出现「面板可点但模拟停着」
    if (this.panels.activePanel === 'pause' && id !== 'pause') {
      this.commands.setPaused(false);
    }
    this.world.clearInput();
    this.world.exitPointerLock();
    this.panels.open(id, buildViewModel(this.store.state));
    if (id === 'pause') {
      this.commands.setPaused(true);
      this.pauseOpenedAt = performance.now();
    }
    this.syncClockUi();
    this.syncPanelPresentation();
  }

  private closePanel(): void {
    const wasPause = this.panels.activePanel === 'pause';
    // 关闭任何面板都结束商店购买上下文
    this.activeShopId = null;
    // 先清空移动与疾跑输入：遮罩还在时按过的键不能残留到恢复之后
    this.world.clearInput();
    this.panels.close();
    if (wasPause) {
      this.commands.setPaused(false);
    }
    this.syncClockUi();
    this.syncPanelPresentation();
  }

  private resumeFromPause(): void {
    this.world.clearInput();
    this.panels.close();
    this.commands.setPaused(false);
    this.syncClockUi();
    this.world.requestPointerLock();
    this.syncPanelPresentation();
  }

  /**
   * 面板相关显示状态的唯一同步点：财务卡片、时间控件锁定、交互提示、鼠标遮罩。
   * 唯一依据是 panels.isOpen，不额外维护「面板是否打开」的布尔字段，避免状态漂移。
   */
  private syncPanelPresentation(): void {
    const open = this.panels.isOpen;
    this.hud.setPanelOpen(open);
    this.hud.setControlsLocked(open);
    this.hud.setHint(
      open || !this.collisionReady ? null : this.world.getNearbyBuilding(),
    );
    this.updateLockOverlay();
  }

  /* ------------------------------------------------------------ 清算确认 */

  /**
   * 清算需要一次明确确认：列出后果，用户确认后才提交一次业务命令。
   *
   * 确认框里的公司名只用于说明；业务层仍会重新校验公司状态，
   * 不依赖打开确认时的快照。`liquidatePending` 只用于挡住确认过程中的重复触发。
   */
  private confirmLiquidate(): CommandOutcome {
    if (this.liquidatePending) return { ok: false, message: null };
    const view = buildViewModel(this.store.state).business;
    if (!view.hasCompany || view.isClosed) return { ok: false, message: null };

    const confirmed = window.confirm(
      `确定要清算「${view.name}」吗？\n\n` +
        '· 进行中的研发会立即终止，已投入的研发费不退\n' +
        '· 全部产品立即停止销售\n' +
        '· 先按规则偿还企业应付费用\n' +
        '· 剩余现金返还到你的银行存款\n' +
        '· 公司关闭，历史报表与记录保留\n\n' +
        '清算后无法撤销。',
    );
    if (!confirmed) return { ok: false, message: null };

    this.liquidatePending = true;
    try {
      return this.business.liquidateCompany();
    } finally {
      this.liquidatePending = false;
    }
  }

  /* ------------------------------------------------------------ 卖出确认 */

  /**
   * 卖出确认：先把「玩家眼下看到的这一笔」固定下来，再提交一次命令。
   *
   * 顺序固定：读一次只读视图 → 显示证券名称、股数、均价、金额、预计剩余
   * → 玩家确认 → 命令内部重新预览（数量或价格变化即拒绝，不缩量、不换价）。
   * 确认框是阻塞的，期间不会重算并替换玩家已经看到的数字。
   */
  private confirmSell(
    securityId: string,
    shares: number,
    expectedPriceCents: number | null,
  ): CommandOutcome {
    if (!securityId) return { ok: false, message: null };
    if (!Number.isSafeInteger(shares) || shares <= 0) {
      this.toast.show('error', '请先输入要卖出的股数（不会自动按全部持仓卖出）');
      return { ok: false, message: null };
    }

    const view = buildSecuritiesPanel(this.store.state, securityId, { sellShares: shares });
    const card = view.selected;
    const preview = view.sellPreview;
    if (!card || card.id !== securityId || !preview || preview.executableShares <= 0) {
      this.toast.show('error', preview?.note ?? '当前无法卖出');
      return { ok: false, message: null };
    }
    if (preview.executableShares !== shares) {
      this.toast.show('error', `本次最多可卖 ${preview.executableShares} 股：${preview.note}`);
      return { ok: false, message: null };
    }
    // 行情在每个节点都会变：界面上的旧报价只作为提示，确认框里的数字才是玩家这次确认的对象
    const priceMoved =
      expectedPriceCents !== null && expectedPriceCents !== preview.priceCents;

    const remaining = card.shares - preview.executableShares;
    const lines = [
      `确认卖出「${card.name}」（${card.symbol}）${shares} 股？`,
      '',
      ...(priceMoved
        ? [`· 行情已更新：界面上原显示 ${formatMoney(expectedPriceCents ?? 0)}，以下为最新成交价`, '']
        : []),
      `· 成交均价：${preview.priceText}`,
      `· 成交金额：${preview.amountText}`,
      `· 价格影响：${preview.impactText}`,
      `· 卖出后剩余：${remaining} 股${remaining === 0 ? '（将清空该持仓）' : ''}`,
      '',
      '确认后按当前行情重新校验：数量或价格变化会要求你重新确认，不会静默改变成交结果。',
    ];
    if (!window.confirm(lines.join('\n'))) return { ok: false, message: null };
    return this.commands.sellStock(securityId, shares, preview.priceCents);
  }

  /* ------------------------------------------------------------ 回购确认 */

  /**
   * 回购需要玩家对**这一次**的数量与价格做明确确认。
   *
   * 预览文案来自只读视图（与界面显示同一份数字），确认后才提交一次命令；
   * 业务层仍会重新校验权限、现金、库存与价格，确认框里的数字不替代执行时的校验。
   */
  private confirmBuyback(
    companyId: string,
    shares: number,
    expectedPriceCents: number | null,
  ): CommandOutcome {
    if (!companyId) return { ok: false, message: null };
    if (!Number.isSafeInteger(shares) || shares <= 0) {
      this.toast.show('error', '请先输入本次要回购的股数');
      return { ok: false, message: null };
    }
    const view = buildCapitalView(this.store.state, companyId, shares);
    if (view.companyId !== companyId) {
      this.toast.show('error', '公司状态已变化（可能已清算或没有股权簿），请刷新后再确认');
      return { ok: false, message: null };
    }
    if (view.buybackPreviewExecutable !== shares || view.buybackPreviewPrice <= 0) {
      this.toast.show('error', view.buybackPreviewNote);
      return { ok: false, message: null };
    }
    if (expectedPriceCents !== null && expectedPriceCents !== view.buybackPreviewPrice) {
      this.toast.show('error', '预览已变化，请重新确认本次回购的数量与价格');
      return { ok: false, message: null };
    }

    const confirmed = window.confirm(
      `确认回购 ${view.companyName} 的 ${shares.toLocaleString('en-US')} 股？\n\n` +
        `· 含冲击成交均价：${view.buybackPreviewPriceText}\n` +
        `· 支付总额：${view.buybackPreviewAmountText}\n` +
        `· 价格影响：${view.buybackPreviewImpactText}\n` +
        `· 股份转入库存股，总发行股数不变；库存股不投票、不分红\n\n` +
        '回购后无法撤销。',
    );
    if (!confirmed) return { ok: false, message: null };
    return this.capital.buyback(companyId, shares, view.buybackPreviewPrice);
  }

  /* ------------------------------------------------------------ 存档 */

  private buildCurrentSnapshot(reason: SaveReason): SaveSnapshot {
    // 存档是我们自己拥有的深克隆副本：允许写入（去掉暂停标记），不影响正式状态
    const state = cloneForWrite<GameState>(this.store.state);
    // 存档代表「可继续的游戏状态」：不把暂停菜单/手动暂停带进去，避免读档后时间不走
    state.clock.paused = false;
    const persisted: PersistedState = {
      ...state,
      world: this.world.getSaveData(),
    };
    return buildSnapshot(persisted, reason);
  }

  private enqueueAutoSave(): void {
    this.autosaveChain = this.autosaveChain
      .then(() => this.performSave('auto', true))
      .catch(() => {
        /* 失败已在 performSave 内提示 */
      });
  }

  private async saveToSlot(slot: SaveSlot): Promise<void> {
    await this.autosaveChain;
    await this.performSave(slot, false);
  }

  private async performSave(slot: SaveSlot, silent: boolean): Promise<void> {
    const snapshot = this.buildCurrentSnapshot(slot === 'manual' ? 'manual' : 'auto');
    if (!silent) this.hud.setSaveState('保存中…', 'idle');
    try {
      await writeSnapshot(slot, snapshot);
      const label = formatSaveTime(this.store.state.clock.totalMinute);
      this.hud.setSaveState(`${slot === 'manual' ? '已保存' : '已自动保存'} ${label}`, 'ok');
      if (!silent) this.toast.show('success', `游戏已保存（${label}）`);
    } catch (error) {
      this.hud.setSaveState('保存失败', 'error');
      this.toast.show('error', `保存失败：${describeError(error)}`);
    }
  }

  async loadFromStorage(confirmFirst: boolean): Promise<void> {
    if (confirmFirst && !window.confirm('读取存档会替换当前进度，确定继续吗？')) return;
    let result: LoadResult = await this.readPreferred('manual');
    if (!result.ok) {
      const fallback = await this.readPreferred('auto');
      if (fallback.ok) result = fallback;
    }
    if (!result.ok) {
      this.toast.show('error', `读取失败：${result.reason}`);
      return;
    }
    this.applySnapshot(result.snapshot);
    if (result.usedBackup) {
      this.toast.show('info', result.warning ?? '已回退到上一份有效快照');
    } else if (result.snapshot.migratedFrom) {
      this.toast.show(
        'success',
        `已读取旧版存档（v${result.snapshot.migratedFrom}）并迁移到 v${SAVE.formatVersion}`,
      );
    } else {
      this.toast.show('success', `已读取存档（${result.snapshot.savedAt.slice(0, 19).replace('T', ' ')}）`);
    }
    this.hud.setSaveState('已读取存档', 'ok');
  }

  private async readPreferred(slot: SaveSlot): Promise<LoadResult> {
    try {
      return await readSnapshot(slot);
    } catch (error) {
      return { ok: false, reason: describeError(error) };
    }
  }

  private applySnapshot(snapshot: SaveSnapshot): void {
    const { world: worldData, ...gameState } = snapshot.state;
    this.store.replace(gameState as GameState);
    this.activeShopId = null;
    this.panels.resetPersonalSession();
    this.panels.resetGovernmentSession();
    this.panels.resetShopSession();
    // 读档顺序固定：先恢复逻辑地图并同步该地图的建筑实例，再恢复原始存档 pose；
    // 世界内部等到最终碰撞就绪后才会「仅在原位置非法时」做一次最小推出。
    this.syncedLayoutRevision = -1;
    this.syncWorldLayout();
    this.world.restore(worldData);
    this.collisionReady = this.world.isCollisionReady();
    this.simAccumulator = 0;
    this.lastFrameMs = 0;
    if (this.panels.isOpen) this.panels.refresh(buildViewModel(this.store.state));
    this.hud.setTime(dateAtMinute(this.store.state.clock.totalMinute, TIME.calendar));
    this.syncClockUi();
    this.syncPanelPresentation();
  }

  exportSnapshot(): void {
    try {
      downloadSnapshot(this.buildCurrentSnapshot('manual'));
      this.toast.show('success', '已导出当前进度的 JSON 快照');
    } catch (error) {
      this.toast.show('error', `导出失败：${describeError(error)}`);
    }
  }

  async importFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const parsed = parseSnapshot(JSON.parse(text) as unknown);
      if (!window.confirm('导入会替换当前进度，确定继续吗？')) return;
      this.applySnapshot(parsed);
      this.closePanel();
      this.toast.show(
        'success',
        parsed.migratedFrom ? `存档已导入（已从 v${parsed.migratedFrom} 迁移）` : '存档导入成功',
      );
      this.hud.setSaveState('已导入存档', 'ok');
    } catch (error) {
      this.toast.show('error', `导入失败：${describeError(error)}`);
    }
  }

  startNewGame(): void {
    if (!window.confirm('重新开始会清空当前进度（本地存档仍保留），确定吗？')) return;
    this.store.replace(createInitialState());
    this.activeShopId = null;
    this.panels.resetPersonalSession();
    this.panels.resetGovernmentSession();
    this.panels.resetShopSession();
    this.syncedLayoutRevision = -1;
    this.syncWorldLayout();
    this.world.resetToSpawn();
    this.collisionReady = this.world.isCollisionReady();
    this.simAccumulator = 0;
    this.lastFrameMs = 0;
    this.panels.close();
    this.hud.setTime(dateAtMinute(this.store.state.clock.totalMinute, TIME.calendar));
    this.hud.setSaveState('', 'idle');
    this.syncClockUi();
    this.syncPanelPresentation();
    this.toast.show('info', '已开始新的游戏进度');
  }

  /** 启动页使用：是否已有可读存档。 */
  async hasAnySave(): Promise<boolean> {
    const manual = await this.readPreferred('manual');
    if (manual.ok) return true;
    const auto = await this.readPreferred('auto');
    return auto.ok;
  }
}

function formatSaveTime(totalMinute: number): string {
  const date = dateAtMinute(totalMinute, TIME.calendar);
  return `${date.month}月${date.day}日 ${String(date.hour).padStart(2, '0')}:${String(date.minute).padStart(2, '0')}`;
}
