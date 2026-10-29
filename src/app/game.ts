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
import { EstateCommands } from './real-estate-commands';
import { pushEnvironment } from './environment';
import { entryAllows, entryDeniedMessage, type EntryCapability } from './entry-policy';
import { buildEstateView } from './real-estate-view';
import { FURNITURE_DEFINITION_BY_ID, INTERIOR } from '../content/interior';
import { freeResidenceOf } from '../features/real-estate';
import { buildSuppliesView } from './supplies-view';
import { moveMultiplierOf } from '../features/survival';
import { createInitialState, type GameState } from './state';
import { advanceGameTime, type AdvanceResult } from './timeAdvance';
import { buildPersonalView } from './personal-view';
import { buildCapitalView, buildSecuritiesPanel } from './securities-view';
import { buildViewModel } from './view';
import { FurnitureCommands } from './furniture';
import { FurniturePanel } from '../ui/furniture-panel';
import type { FurnitureEditCommit } from '../world/interiors/furniture-editor';

export interface GameElements {
  readonly viewport: HTMLElement;
  readonly hudRoot: HTMLElement;
  readonly panelRoot: HTMLElement;
  readonly furnitureRoot: HTMLElement;
  readonly toastRoot: HTMLElement;
}

export class Game {
  readonly store: GameStore<GameState>;
  readonly commands: GameCommands;
  readonly business: BusinessCommands;
  readonly capital: CapitalCommands;
  readonly government: GovernmentCommands;
  readonly supplies: SuppliesCommands;
  readonly estate: EstateCommands;
  readonly furniture: FurnitureCommands;
  private readonly world: World;
  private readonly hud: Hud;
  private readonly panels: PanelManager;
  private readonly furniturePanel: FurniturePanel;
  private readonly toast: ToastHost;
  private readonly unsubscribe: () => void;
  /** 家具编辑会话代次；旧拖动/旧命令回调不得提交到新会话。 */
  private furnitureSession = 0;

  private hiddenPaused = false;
  /** 触屏/粗指针：没有鼠标锁定语义，锁定遮罩与指针锁请求都不参与表现。 */
  private readonly coarsePointer =
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
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
  /** 室内加载中：锁移动与重复进入；不暂停经济模拟。 */
  private interiorLoading = false;
  /**
   * 住宅进入请求代次。读档、新游戏、dispose 会递增它；await 返回后只有仍是
   * 当前请求才允许通知、同步界面与请求鼠标锁定，避免过期请求改到新会话。
   */
  private residenceRequest = 0;

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

    this.estate = new EstateCommands(this.store, {
      notify: (kind, message) => this.toast.show(kind, message),
      requestAutoSave: () => this.enqueueAutoSave(),
    });

    this.furniture = new FurnitureCommands(this.store, {
      canEdit: () => this.world.isFurnitureEditing(),
      session: () => this.furnitureSession,
      requestAutoSave: () => this.enqueueAutoSave(),
    });

    this.world = new World(elements.viewport, {
      onPointerLockChange: (locked) => this.handlePointerLockChange(locked),
      // 碰撞就绪前锁移动与 F 交互（经济模拟不暂停）；就绪后刷新提示与遮罩
      onCollisionReadyChange: (ready) => this.handleCollisionReadyChange(ready),
      onPhysicsError: (message) => {
        this.toast.show('error', `${message}；人物移动已锁定，请刷新页面重试`);
      },
    });
    this.syncWorldLayout();
    this.collisionReady = this.world.isCollisionReady();

    this.hud = new Hud(elements.hudRoot, {
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
      onTogglePause: () => this.handleTogglePause(),
      onSetSpeed: (speed) => {
        this.commands.setSpeed(speed);
        this.syncClockUi();
      },
      onHire: (jobId?: string) => {
        if (!this.guardEntry('employment')) return;
        this.commands.hire(jobId);
        this.syncClockUi();
      },
      onWorkShift: (minutes?: number) => {
        if (!this.guardEntry('employment')) return;
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
        if (!this.guardEntry('banking')) return;
        this.commands.deposit(cents);
      },
      onWithdraw: (cents) => {
        if (!this.guardEntry('banking')) return;
        this.commands.withdraw(cents);
      },
      onBuyStock: (securityId, shares, expectedPriceCents) => {
        if (!this.guardEntry('trading')) return;
        this.commands.buyStock(securityId, shares, expectedPriceCents);
      },
      onSellStock: (securityId, shares, expectedPriceCents) =>
        this.confirmSell(securityId, shares, expectedPriceCents),
      onBorrow: (cents) => {
        if (!this.guardEntry('banking')) return;
        this.commands.borrowLoan(cents);
      },
      onRepay: (cents) => {
        if (!this.guardEntry('banking')) return;
        this.commands.repayLoan(cents);
      },
      onRepayAll: () => {
        if (!this.guardEntry('banking')) return;
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
      onRequestFinancing: (cents) =>
        this.withEntry('capital', () => this.capital.requestFinancing(cents)),
      onAcceptQuote: (quoteId) =>
        this.withEntry('capital', () => this.capital.acceptQuote(quoteId)),
      onRejectQuotes: () => this.withEntry('capital', () => this.capital.rejectQuotes()),
      onListCompany: () => this.withEntry('capital', () => this.capital.listCompany()),
      onBuyback: (companyId, shares, expectedPriceCents) =>
        this.confirmBuyback(companyId, shares, expectedPriceCents),
      onPromote: (cents) => this.withEntry('capital', () => this.capital.promote(cents)),
      onAppointCeo: (companyId, holderId) =>
        this.withGovernance(companyId, () => this.capital.appointCeo(companyId, holderId)),
      onRemoveCeo: (companyId, holderId) =>
        this.withGovernance(companyId, () => this.capital.removeCeo(companyId, holderId)),
      onVoteProposal: (companyId, proposalId, choice) =>
        this.withGovernance(companyId, () =>
          this.capital.voteOnProposal(companyId, proposalId, choice),
        ),
      onUseItem: (itemId, requestId) => this.supplies.useItem(itemId, requestId),
      onBuyHome: (propertyId, priceCents, listingVersion) =>
        this.confirmBuyHome(propertyId, priceCents, listingVersion),
      onBuyLand: (propertyId, priceCents) => this.confirmBuyLand(propertyId, priceCents),
      onListHome: (propertyId, priceCents, expectedVersion) =>
        this.withEntry('estate', () =>
          this.estate.listHome(propertyId, priceCents, expectedVersion),
        ),
      onCancelListing: (propertyId, expectedVersion) =>
        this.withEntry('estate', () => this.estate.cancelListing(propertyId, expectedVersion)),
      onAcceptOffer: (offerId, priceCents) => this.confirmAcceptOffer(offerId, priceCents),
      onRejectOffer: (offerId) => this.withEntry('estate', () => this.estate.rejectOffer(offerId)),
      onEnterHome: () => {
        void this.enterResidence();
      },
    }, (query) => buildPersonalView(this.store.state, query),
    (securityId, order) => buildSecuritiesPanel(this.store.state, securityId, order),
    () => buildGovernmentView(this.store.state),
    {
      onSponsor: (candidateId, amountCents, requestId) =>
        this.guardEntry('sponsorship')
          ? this.government.sponsor(candidateId, amountCents, requestId)
          : { ok: false, message: null },
    },
    () => buildCityEconomyView(this.store.state),
    () => buildSuppliesView(this.store.state, this.activeShopId),
    {
      onPurchase: (shopId, itemId, quantity, requestId) =>
        this.supplies.purchase(shopId, itemId, quantity, requestId),
      onHire: (jobId) => {
        if (!this.guardEntry('employment')) return { ok: false, message: null };
        const outcome = this.commands.hire(jobId);
        this.syncClockUi();
        return outcome;
      },
      onWorkShift: (minutes?: number) => {
        if (!this.guardEntry('employment')) return { ok: false, message: null };
        const outcome = this.commands.workShift(minutes);
        this.syncClockUi();
        return outcome;
      },
      onOpenInventory: () => {
        this.openPanel('personal');
        this.panels.openPersonalSection('inventory');
      },
    },
    (onsite) => buildEstateView(this.store.state, onsite),
    );

    this.furniturePanel = new FurniturePanel(elements.furnitureRoot, {
      onExit: () => {
        this.exitFurnitureEdit();
      },
      onWarehouseDragStart: (id, pointerId, clientX, clientY) => {
        this.world.startWarehouseDrag?.(id, pointerId, clientX, clientY);
      },
      onWarehouseDragMove: (pointerId, clientX, clientY) => {
        this.world.updateWarehouseDrag?.(pointerId, clientX, clientY);
      },
      onWarehouseDragEnd: (pointerId, clientX, clientY) => {
        this.world.endWarehouseDrag?.(pointerId, clientX, clientY);
      },
      onWarehouseDragCancel: () => this.world.cancelFurnitureDrag(),
      onCandidateSelect: (id) => this.world.selectFurniture(id),
      onResize: () => this.syncFurniturePanelRect(),
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
    this.requestPointerLock();
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
    this.invalidateResidenceRequest();
    this.cancelFurnitureUi();
    this.stop();
    this.unsubscribe();
    window.removeEventListener('keydown', this.keyHandler);
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.furniturePanel.dispose();
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
      !paused &&
      !this.panels.isOpen &&
      !this.world.isFurnitureEditing() &&
      this.world.isPointerLocked() &&
      this.collisionReady &&
      !this.interiorLoading;

    // 位移与模拟时钟使用不同的单帧上限：位移限制只防穿墙，不拖慢时间
    const moveDeltaMs = Math.min(rawDelta, TIME.maxMoveDeltaMs);
    // 移动倍率由生存状态推导后显式传给世界；world 不读取任何业务状态
    this.world.update(
      moveDeltaMs / 1000,
      canMove,
      moveMultiplierOf(this.store.state.survival),
      paused || this.world.isFurnitureEditing(),
    );
    this.hud.setMovementMode(this.world.isSprinting());
    this.world.updateFurnitureEdit(moveDeltaMs / 1000, paused);

    if (!paused) {
      this.accumulateSimulation(Math.min(rawDelta, TIME.maxSimDeltaMs));
    }

    // 环境：太阳、天空、雾跟随游戏时间；暂停时 dt 传 0，雨滴冻结而状态不变。
    const renderDeltaSeconds = Math.min(rawDelta, 200) / 1000;
    pushEnvironment(
      this.world,
      this.store.state,
      this.simAccumulator,
      paused ? 0 : renderDeltaSeconds,
    );

    this.world.render(renderDeltaSeconds);
    this.hud.setHint(
      paused || this.panels.isOpen || !this.collisionReady ? null : this.currentHint(),
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
      this.toast.show('success', `有 ${count} 个研发项目完成，可到「我的公司 › 产品与研发」发布`);
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
    // 时间工具区在 TAB 标题栏；未打开 TAB 时由 PanelManager 内部安全短路
    this.panels.syncTimeTools(clock.paused, clock.speed);
  }

  private handleVisibility(): void {
    this.hiddenPaused = document.hidden;
    if (document.hidden) {
      this.world.clearInput();
      this.world.cancelFurnitureDrag();
      this.furniturePanel.cancelDrag();
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
    if (this.coarsePointer || this.panels.isOpen || document.hidden) return;
    if (this.world.isFurnitureEditing()) return;
    this.world.requestPointerLock();
  }

  private handlePointerLockChange(locked: boolean): void {
    if (locked) {
      this.hud.setLockOverlay(false);
      return;
    }
    // 家具编辑主动释放鼠标：不是暂停，也不显示遮罩。
    if (this.world.isFurnitureEditing()) return;
    // 解锁可能是「打开面板」造成的，此时不弹暂停菜单
    if (this.panels.isOpen) return;
    if (!this.started) return;
    this.openPanel('pause');
  }

  private updateLockOverlay(): void {
    // 触屏/粗指针没有鼠标锁定语义：遮罩只会在全屏挡住「界面」入口
    const shouldShow =
      this.started &&
      !this.coarsePointer &&
      !this.panels.isOpen &&
      !this.world.isFurnitureEditing() &&
      !this.world.isPointerLocked();
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

    if (event.code === 'KeyE') {
      if (event.repeat) return;
      event.preventDefault();
      if (this.world.isFurnitureEditing()) {
        this.exitFurnitureEdit();
      } else if (!this.panels.isOpen) {
        this.enterFurnitureEdit();
      }
      return;
    }

    if (event.code === 'Tab') {
      event.preventDefault();
      if (this.world.isFurnitureEditing() && !this.exitFurnitureEdit(false)) return;
      this.togglePanel('personal');
      return;
    }

    if (event.code === 'KeyF') {
      event.preventDefault();
      if (this.world.isFurnitureEditing() && !this.exitFurnitureEdit()) return;
      if (this.panels.isOpen) {
        this.closePanel();
        return;
      }
      if (this.world.isIndoor()) {
        this.leaveResidence();
        return;
      }
      if (this.world.isInteriorTransitioning() || this.interiorLoading) {
        this.toast.show('info', '住宅正在加载，请稍候');
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
      if (this.world.isFurnitureEditing()) {
        this.exitFurnitureEdit();
        return;
      }
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

    // 空格跳跃由 World 的输入处理消费；这里不再绑定暂停。
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
    if (this.world.isFurnitureEditing() && !this.exitFurnitureEdit(false)) return;
    // 商店购买上下文只属于便利店面板；打开其它面板即失效
    if (id !== 'shop') this.activeShopId = null;
    // 菜单暂停只由「当前面板是 pause」表达，不再改写 clock.paused。
    // 先挂面板再释放鼠标：解锁回调看到面板已打开，不会二次打开菜单。
    this.world.clearInput();
    this.panels.open(id, buildViewModel(this.store.state));
    this.world.exitPointerLock();
    if (id === 'pause') {
      this.pauseOpenedAt = performance.now();
      this.resetFrameBaseline();
    }
    this.syncClockUi();
    this.syncPanelPresentation();
  }

  private closePanel(): void {
    // 关闭任何面板都结束商店购买上下文
    this.activeShopId = null;
    // 先清空移动与疾跑输入：遮罩还在时按过的键不能残留到恢复之后
    this.world.clearInput();
    this.panels.close();
    // 离开菜单后从当前帧重新计时：暂停期间的停留时间不补算
    this.resetFrameBaseline();
    this.syncClockUi();
    this.syncPanelPresentation();
  }

  private resumeFromPause(): void {
    this.world.clearInput();
    this.panels.close();
    this.resetFrameBaseline();
    this.syncClockUi();
    this.syncPanelPresentation();
    this.requestPointerLock();
  }

  /**
   * 重置帧基准。只影响「下一帧的 rawDelta」，不改时钟、不结算、不清余量，
   * 因此暂停停留多久都不会在恢复时被补算进模拟时间。
   */
  private resetFrameBaseline(): void {
    this.lastFrameMs = 0;
  }

  /**
   * 面板相关显示状态的唯一同步点：财务卡片、时间控件锁定、交互提示、鼠标遮罩。
   * 唯一依据是 panels.isOpen，不额外维护「面板是否打开」的布尔字段，避免状态漂移。
   */
  private syncPanelPresentation(): void {
    const open = this.panels.isOpen;
    const editing = this.world.isFurnitureEditing();
    this.hud.setPanelOpen(open || editing);
    // ESC 菜单是全屏表现：HUD 整体让位，右侧只留城市画面
    this.hud.setMenuMode(this.panels.activePanel === 'pause');
    this.hud.setHint(
      open || editing || !this.collisionReady ? null : this.currentHint(),
    );
    this.updateLockOverlay();
  }

  /* ------------------------------------------------------------ 室内入口 */

  /** 当前应显示的 F 提示：室内只在门口提示离开，室外沿用建筑缓存。 */
  private currentHint():
    | { readonly id: string; readonly name: string; readonly subtitle: string; readonly verb?: string }
    | null {
    if (this.world.isFurnitureEditing()) return null;
    if (this.world.isIndoor()) {
      if (!this.world.canExitInterior()) return null;
      return { id: 'interior-exit', name: '住宅', verb: '离开', subtitle: '回到晴川公寓楼外' };
    }
    return this.world.getNearbyBuilding();
  }

  /**
   * 让所有在途的住宅进入请求失效。读档、新游戏与 dispose 在替换 store / 释放世界
   * 之前调用；迟到的 `enterInterior` 结果据此跳过通知、界面同步与鼠标锁定。
   * 这里不碰 World 的会话代次，取消室内场景仍由 `world.cancelInterior()` 负责。
   */
  private invalidateResidenceRequest(): void {
    this.residenceRequest += 1;
    this.interiorLoading = false;
  }

  /**
   * 从晴川公寓现场进入个人住宅。
   *
   * 界面按钮只是入口；这里重新核对「当前现场 + 附近建筑 id + 永久居住权」，不以产权、
   * 净资产或房价替代。加载期间锁人物移动但不暂停经济，失败保持室外可重试。
   */
  private async enterResidence(): Promise<void> {
    if (this.panels.activePanel !== 'home') return;
    if (this.world.isIndoor() || this.world.isInteriorTransitioning() || this.interiorLoading) return;

    const nearby = this.world.getNearbyBuilding();
    const residence = freeResidenceOf(this.store.state.realEstate);
    if (
      !nearby ||
      nearby.interactionId !== 'home' ||
      nearby.id !== INTERIOR.buildingId ||
      !residence ||
      residence.kind !== 'home' ||
      residence.id !== INTERIOR.residenceId ||
      residence.buildingId !== nearby.id
    ) {
      this.toast.show('error', '只能从晴川公寓现场进入自己的永久住所');
      return;
    }
    if (!this.collisionReady) {
      this.toast.show('info', '城市仍在加载，请稍候');
      return;
    }

    const request = this.residenceRequest + 1;
    this.residenceRequest = request;
    this.interiorLoading = true;
    this.world.clearInput();
    this.closePanel();
    try {
      const result = await this.world.enterInterior(
        () => {
          const still = freeResidenceOf(this.store.state.realEstate);
          return (
            still !== null &&
            still.kind === 'home' &&
            still.id === INTERIOR.residenceId &&
            still.buildingId === INTERIOR.buildingId
          );
        },
        this.store.state.furniture,
      );
      // 读档/新游戏/dispose 已让本次请求过期：不弹提示、不同步、不抢鼠标。
      if (request !== this.residenceRequest) return;
      if (!result.ok) {
        this.toast.show('error', `进入住宅失败：${result.message ?? '未知原因'}`);
        return;
      }
      this.collisionReady = this.world.isCollisionReady();
      this.toast.show('success', '已进入个人住宅。走到门口按 F 离开。');
      this.syncPanelPresentation();
      this.requestPointerLock();
    } finally {
      // 过期请求不得清掉新请求的加载锁。
      if (request === this.residenceRequest) this.interiorLoading = false;
    }
  }

  private leaveResidence(): void {
    if (!this.world.isIndoor()) return;
    if (!this.world.canExitInterior()) {
      this.toast.show('info', '走到门口再按 F 离开住宅');
      return;
    }
    this.world.exitInterior();
    this.collisionReady = this.world.isCollisionReady();
    this.syncPanelPresentation();
    this.toast.show('info', '已回到晴川公寓楼外');
    this.requestPointerLock();
  }

  /* ------------------------------------------------------------ 家具编辑 */

  private enterFurnitureEdit(): void {
    if (this.world.isFurnitureEditing()) return;
    if (!this.world.isIndoor()) {
      this.toast.show('info', '只能在个人住宅内编辑家具');
      return;
    }
    if (
      this.panels.isOpen ||
      this.interiorLoading ||
      this.world.isInteriorTransitioning() ||
      !this.collisionReady
    ) {
      this.toast.show('info', '住宅尚未准备好，请稍候');
      return;
    }
    if (!this.world.isPlayerGrounded()) {
      this.toast.show('info', '落地后再整理家具');
      return;
    }
    const session = this.furnitureSession + 1;
    this.furnitureSession = session;
    const handlers: FurnitureEditCommit = {
      move: (id, cellX, cellZ) => this.furniture.move(session, id, cellX, cellZ),
      rotate: (id, direction) => this.furniture.rotate(session, id, direction),
      store: (id) => this.furniture.store(session, id),
      place: (id, cellX, cellZ) => this.furniture.place(session, id, cellX, cellZ),
    };
    const result = this.world.enterFurnitureEdit(handlers, {
      onSelectionChange: (id) => {
        const layout = this.world.getFurnitureLayout();
        const item = id && layout ? layout.items[id] : undefined;
        const definition = item
          ? FURNITURE_DEFINITION_BY_ID[item.definitionId]
          : undefined;
        this.furniturePanel.setSelection(definition?.name ?? null);
      },
      onCandidatesChange: (candidates) => this.furniturePanel.setCandidates(candidates),
      onLayoutChange: (layout) => this.furniturePanel.update(layout),
      notify: (message) => this.toast.show('error', message),
    });
    if (!result.ok) {
      this.toast.show('info', result.message ?? '无法进入家具编辑');
      return;
    }
    const layout = this.world.getFurnitureLayout();
    if (layout) this.furniturePanel.show(layout);
    this.syncFurniturePanelRect();
    this.syncPanelPresentation();
  }

  private exitFurnitureEdit(relock = true): boolean {
    if (!this.world.isFurnitureEditing()) {
      this.furniturePanel.hide();
      return true;
    }
    const result = this.world.exitFurnitureEdit();
    if (!result.ok) {
      if (result.message) this.toast.show('info', result.message);
      return false;
    }
    this.furnitureSession += 1;
    this.furniturePanel.hide();
    this.world.setFurniturePanelRect(null);
    this.syncPanelPresentation();
    if (relock) this.requestPointerLock();
    return true;
  }

  private cancelFurnitureUi(): void {
    this.furnitureSession += 1;
    this.world.cancelFurnitureEdit();
    this.furniturePanel.hide();
    this.world.setFurniturePanelRect(null);
  }

  private syncFurniturePanelRect(): void {
    if (!this.world.isFurnitureEditing()) return;
    const rect = this.furniturePanel.getRect();
    this.world.setFurniturePanelRect({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }

  /* -------------------------------------------------------- 入口能力检查 */

  /**
   * 玩家界面入口的现场检查。
   *
   * 只拦「玩家从界面提交」这一层：底层命令、AI 决策、定时模拟与月结都不经过这里，
   * 金额/股数/价格/权限等业务校验仍由原命令执行。判定表在 entry-policy，
   * 权限只存在内存，不写 `GameState`、不进存档。
   */
  private guardEntry(capability: EntryCapability): boolean {
    if (entryAllows(this.panels.activePanel, capability)) return true;
    this.toast.show('error', entryDeniedMessage(capability));
    return false;
  }

  /** 需要原样返回命令结果的操作用这个包装：入口不符时给出统一的失败结果。 */
  private withEntry(capability: EntryCapability, run: () => CommandOutcome): CommandOutcome {
    if (!this.guardEntry(capability)) return { ok: false, message: null };
    return run();
  }

  /**
   * 治理类操作的入口检查：除入口本身，还要核对**目标公司**。
   *
   * 人物界面只能办理当前管理公司（`managedCompany`，即 CEO 身份）的治理；
   * 其它持股公司的股东权利留在证券中心，按其原有业务权限校验。
   * 这里只决定「这次界面调用能不能到达命令」，不改变 `capital.ts` 内部的提案/任免判断。
   */
  private guardGovernance(companyId: string): boolean {
    if (!this.guardEntry('governance')) return false;
    if (this.panels.activePanel !== 'personal') return true;
    const business = buildViewModel(this.store.state).business;
    if (business.canManage && business.id === companyId) return true;
    this.toast.show(
      'error',
      '人物界面只能办理当前管理公司的治理事项：其它持股公司的股东权利请到证券中心处理。',
    );
    return false;
  }

  private withGovernance(companyId: string, run: () => CommandOutcome): CommandOutcome {
    if (!this.guardGovernance(companyId)) return { ok: false, message: null };
    return run();
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
    if (!this.guardEntry('trading')) return { ok: false, message: null };
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
    // 确认框是阻塞的，期间可能已经关闭/切换窗口：提交前再检查一次现场
    if (!this.guardEntry('trading')) return { ok: false, message: null };
    return this.commands.sellStock(securityId, shares, preview.priceCents);
  }

  /* ------------------------------------------------------------ 回购确认 */

  /**
   * 回购需要玩家对**这一次**的数量与价格做明确确认。
   *
   * 预览文案来自只读视图（与界面显示同一份数字），确认后才提交一次命令；
   * 业务层仍会重新校验权限、现金、库存与价格，确认框里的数字不替代执行时的校验。
   */
  /* ------------------------------------------------------ 房地产确认 */

  /**
   * 买入住宅的确认：固定「玩家眼下确认的这一笔」（资产、价格、付款账户、结果），
   * 命令执行时重新校验挂牌价与版本；变化即拒绝，不静默换价或换资产。
   */
  private confirmBuyHome(
    propertyId: string,
    priceCents: number,
    listingVersion: number,
  ): CommandOutcome {
    if (!this.guardEntry('estate')) return { ok: false, message: null };
    if (!propertyId) return { ok: false, message: null };
    const view = buildEstateView(this.store.state, true);
    const card = view.marketHomes.find((item) => item.id === propertyId);
    if (!card) {
      this.toast.show('error', '该房源已不在售，请刷新列表');
      return { ok: false, message: null };
    }
    if (card.priceCents !== priceCents || card.listingVersion !== listingVersion) {
      this.toast.show('error', '挂牌信息已更新，请按最新价格重新确认');
      return { ok: false, message: null };
    }
    if (!card.canBuy) {
      this.toast.show('error', card.buyNote || '当前无法购买该房源');
      return { ok: false, message: null };
    }
    const savings = this.store.state.finance.accounts.savings;
    const remainder = savings - priceCents;
    const lines = [
      `确认购买「${card.name}」？`,
      '',
      `· 户型与地段：${card.layoutText} · ${card.districtText}`,
      `· 挂牌价：${card.priceText}（参考估值 ${card.valuationText}）`,
      `· 付款账户：个人银行存款（当前 ${formatMoney(savings)}）`,
      `· 付款后余额：${formatMoney(remainder)}`,
      `· 结果：住宅产权转到你名下，成为持有资产；本次不产生按揭、不自动搬家`,
      '',
      '两件事需要你确认：一是成交后房价与挂牌可能变化，提交时价格或版本不一致会直接拒绝；',
      '二是持有期间没有租金收入，卖出需要重新挂牌并由市场成交。',
    ];
    if (!window.confirm(lines.join('\n'))) return { ok: false, message: null };
    if (!this.guardEntry('estate')) return { ok: false, message: null };
    return this.estate.buyHome(propertyId, priceCents, listingVersion);
  }

  /** 受让储备土地的确认：出让价、付款账户与结果。 */
  private confirmBuyLand(propertyId: string, priceCents: number): CommandOutcome {
    if (!this.guardEntry('estate')) return { ok: false, message: null };
    if (!propertyId) return { ok: false, message: null };
    const view = buildEstateView(this.store.state, true);
    const card = view.reserveLand.find((item) => item.id === propertyId);
    if (!card) {
      this.toast.show('error', '该地块已不可受让，请刷新列表');
      return { ok: false, message: null };
    }
    if (card.priceCents !== priceCents) {
      this.toast.show('error', '出让价已更新，请按最新价格重新确认');
      return { ok: false, message: null };
    }
    if (!card.canBuyLand) {
      this.toast.show('error', card.buyNote || '当前无法受让该地块');
      return { ok: false, message: null };
    }
    const savings = this.store.state.finance.accounts.savings;
    const lines = [
      `确认受让「${card.name}」？`,
      '',
      `· 面积与用途：${card.layoutText}`,
      `· 出让价：${card.priceText}（参考估值 ${card.valuationText}）`,
      `· 付款账户：个人银行存款（当前 ${formatMoney(savings)}）`,
      `· 结果：土地产权转到你名下；首版不能在这块地上建房，也不会自动产生收益`,
      '',
      '机构可能随后对你的地块提出限时收购报价，是否接受由你决定。',
    ];
    if (!window.confirm(lines.join('\n'))) return { ok: false, message: null };
    if (!this.guardEntry('estate')) return { ok: false, message: null };
    return this.estate.buyLand(propertyId, priceCents);
  }

  /** 接受土地收购报价的确认：报价金额与到账结果。 */
  private confirmAcceptOffer(offerId: string, priceCents: number): CommandOutcome {
    if (!this.guardEntry('estate')) return { ok: false, message: null };
    if (!offerId) return { ok: false, message: null };
    const view = buildEstateView(this.store.state, true);
    let matched: { name: string; buyer: string; price: number; expires: string } | null = null;
    for (const card of view.playerLand) {
      const offer = card.offers.find((item) => item.id === offerId);
      if (offer) {
        matched = {
          name: card.name,
          buyer: offer.buyerText,
          price: offer.priceCents,
          expires: offer.expiresText,
        };
        break;
      }
    }
    if (!matched) {
      this.toast.show('error', '该报价已失效，请刷新');
      return { ok: false, message: null };
    }
    if (matched.price !== priceCents) {
      this.toast.show('error', '报价金额已变化，请重新确认');
      return { ok: false, message: null };
    }
    const lines = [
      `确认接受「${matched.buyer}」对「${matched.name}」的收购报价？`,
      '',
      `· 报价：${formatMoney(priceCents)}（${matched.expires}）`,
      `· 收款账户：个人银行存款`,
      `· 结果：土地产权转给该机构，报价资金来自对方已预留的真实资金`,
      '',
      '接受后无法撤销；其他报价会同时失效并释放对方的预留资金。',
    ];
    if (!window.confirm(lines.join('\n'))) return { ok: false, message: null };
    if (!this.guardEntry('estate')) return { ok: false, message: null };
    return this.estate.acceptOffer(offerId, priceCents);
  }

  private confirmBuyback(
    companyId: string,
    shares: number,
    expectedPriceCents: number | null,
  ): CommandOutcome {
    if (!this.guardEntry('capital')) return { ok: false, message: null };
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
    if (!this.guardEntry('capital')) return { ok: false, message: null };
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
    try {
      const snapshot = this.buildCurrentSnapshot(slot === 'manual' ? 'manual' : 'auto');
      if (!silent) this.hud.setSaveState('保存中…', 'idle');
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
    // 替换 store 前失效并清理旧室内会话；迟到加载结果不得把新存档拉回房间。
    this.cancelFurnitureUi();
    this.invalidateResidenceRequest();
    this.world.cancelInterior();
    this.store.replace(gameState as GameState);
    this.activeShopId = null;
    this.panels.resetPersonalSession();
    this.panels.resetGovernmentSession();
    this.panels.resetShopSession();
    // 读档不继承旧现场：关闭管理窗口（含其入口上下文），由玩家重新走到设施前打开
    this.panels.close();
    // 读档顺序固定：先恢复逻辑地图并同步该地图的建筑实例，再恢复原始存档 pose；
    // 世界内部等到最终碰撞就绪后才会「仅在原位置非法时」做一次最小推出。
    this.syncedLayoutRevision = -1;
    // 换了一份进度：先开新的显示会话（清掉上一份的装饰抑制），再同步布局与恢复位置
    this.world.beginDisplaySession();
    this.syncWorldLayout();
    this.world.restore(worldData);
    this.collisionReady = this.world.isCollisionReady();
    this.simAccumulator = 0;
    this.lastFrameMs = 0;
    this.hud.setTime(dateAtMinute(this.store.state.clock.totalMinute, TIME.calendar));
    // 读档后第一帧之前就把环境对齐到存档时间与天气，避免出现旧天气的一帧
    pushEnvironment(this.world, this.store.state, 0, 0);
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
    this.cancelFurnitureUi();
    this.invalidateResidenceRequest();
    this.world.cancelInterior();
    this.store.replace(createInitialState());
    this.activeShopId = null;
    this.panels.resetPersonalSession();
    this.panels.resetGovernmentSession();
    this.panels.resetShopSession();
    this.syncedLayoutRevision = -1;
    // 新游戏同样是一次新的显示会话
    this.world.beginDisplaySession();
    this.syncWorldLayout();
    this.world.resetToSpawn();
    this.collisionReady = this.world.isCollisionReady();
    this.simAccumulator = 0;
    this.lastFrameMs = 0;
    this.panels.close();
    this.hud.setTime(dateAtMinute(this.store.state.clock.totalMinute, TIME.calendar));
    pushEnvironment(this.world, this.store.state, 0, 0);
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
