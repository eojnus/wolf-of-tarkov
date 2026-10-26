/**
 * 业务命令 —— 界面与场景唯一的写入口。
 *
 * 每个命令都在一次原子提交内完成；失败时状态不变，且只向界面返回一条提示。
 * 命令层不渲染 DOM、不操作 Three.js，只协调业务模块与统一时间推进。
 *
 * 时间推进只有一处：advanceGameTime。自然流逝、工作、休息、睡觉都走它，
 * 因此工资、利息、行情、月结、贷款到期的顺序在任何入口都一致。
 */

import { dateAtMinute, formatDuration, type GameDate } from '../core/calendar';
import { BusinessError, describeError } from '../core/errors';
import { GameStore } from '../core/store';
import { formatMoney, formatMoneyCompact } from '../core/money';
import { BRANDING, JOBS, TIME, findJob, type JobConfig } from '../content/config';
import { depositToSavings, withdrawToCash } from '../features/banking';
import { hire, planShift } from '../features/employment';
import { borrow, hasOpenLoan, repay, totalOwed } from '../features/loan';
import type { GameState } from './state';
import { executeTrade, nameOf, previewTrade } from './securities-settlement';
import { advanceGameTime, type AdvanceResult } from './timeAdvance';

export type NotifyKind = 'info' | 'success' | 'error';

export interface CommandHooks {
  notify(kind: NotifyKind, message: string): void;
  requestAutoSave(): void;
}

export interface CommandOutcome {
  readonly ok: boolean;
  readonly message: string | null;
}

function nextOperationId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}:${random}`;
}

/** 把一次时间推进的结果拼成一条可读提示，不逐条弹窗。 */
function summarize(result: AdvanceResult, main: string): string {
  const parts = [main];
  if (result.monthsSettled > 0) {
    parts.push(`完成 ${result.monthsSettled} 次月度结算`);
  }
  for (const event of result.loanDueEvents) {
    if (event.settled) {
      parts.push('贷款到期，已自动结清');
    } else if (event.overdue) {
      parts.push('贷款到期，存款不足，剩余转为逾期');
    } else {
      parts.push(
        `贷款到期，已自动偿还 ${formatMoneyCompact(event.paidInterest + event.paidPrincipal)}`,
      );
    }
  }
  if (result.researchCompletions.length > 0) {
    parts.push(`${result.researchCompletions.length} 个研发项目完成`);
  }
  if (result.stopReason) {
    parts.push(result.stopReason);
    if (result.remainingMinutes > 0) {
      parts.push(`剩余 ${formatDuration(result.remainingMinutes)} 未推进`);
    }
  }
  return parts.join('；');
}

const DEFAULT_JOB: JobConfig | null = JOBS[0] ?? null;

export class GameCommands {
  constructor(
    private readonly store: GameStore<GameState>,
    private readonly hooks: CommandHooks,
  ) {}

  private nowOf(state: GameState): GameDate {
    return dateAtMinute(state.clock.totalMinute, TIME.calendar);
  }

  /* ------------------------------------------------------------ 时间 */

  setSpeed(speed: number): CommandOutcome {
    if (!TIME.speedOptions.includes(speed)) {
      return { ok: false, message: '不支持的速度' };
    }
    return this.execute((draft) => {
      draft.clock.speed = speed;
      draft.settings.speed = speed;
      draft.clock.paused = false;
      return `速度调整为 ${speed}×`;
    });
  }

  setPaused(paused: boolean): void {
    this.store.run((draft) => {
      draft.clock.paused = paused;
    });
  }

  /** 暂停菜单用：进入暂停并标记，退出时恢复。 */
  togglePause(): CommandOutcome {
    return this.execute((draft) => {
      draft.clock.paused = !draft.clock.paused;
      return draft.clock.paused ? '已暂停' : '继续';
    });
  }

  /* ------------------------------------------------------------ 就业 */

  /**
   * 入职或切换岗位。`jobId` 缺省时沿用原行政岗位，保证旧入口与旧快捷键不变。
   * 切换岗位保留已赚工资与当日工时上限；不在这里复制任何工资算法。
   */
  hire(jobId?: string): CommandOutcome {
    return this.execute((draft) => {
      const job = jobId ? findJob(jobId) : DEFAULT_JOB;
      if (!job) throw new BusinessError('NO_JOB', jobId ? '没有该岗位' : '当前没有可应聘的岗位');
      const now = this.nowOf(draft);
      const previous = draft.employment.jobId;
      hire(draft.employment, job, {
        atMinute: draft.clock.totalMinute,
        monthKey: now.monthKey,
      });
      return previous
        ? `已从原岗位转入 ${job.employer} · ${job.title}（已赚工资与今日工时保留）`
        : `已入职 ${job.employer} · ${job.title}`;
    }, true);
  }

  /**
   * 开始一个班次。可传更短的分钟数（例如便利店 1 小时短班），
   * 但不能短于岗位最短班次、不能超过本次可工作分钟；每日上限仍按实际出勤执行。
   */
  workShift(minutes?: number): CommandOutcome {
    return this.execute((draft) => {
      const job = findJob(draft.employment.jobId);
      if (!job) throw new BusinessError(
        'NOT_EMPLOYED',
        `请先在${BRANDING.cityStem}实业大厦或便利店办理入职`,
      );
      const now = this.nowOf(draft);
      const plan = planShift(draft.employment, job, now);
      if (!plan.ok) throw new BusinessError('SHIFT_UNAVAILABLE', plan.reason ?? '当前无法上班');
      let shiftMinutes = plan.minutes;
      if (minutes !== undefined) {
        if (!Number.isSafeInteger(minutes) || minutes < job.minShiftMinutes) {
          throw new BusinessError('INVALID_SHIFT', `最短班次为 ${job.minShiftMinutes} 分钟`);
        }
        if (minutes > plan.minutes) {
          throw new BusinessError('INVALID_SHIFT', `本次最多可工作 ${plan.minutes} 分钟`);
        }
        shiftMinutes = minutes;
      }
      // 效率按班次开始时的生存状态确定；实际计薪由统一 wage 应计链路处理。
      // 展示用的平均效率必须来自本次推进的实际/有效分钟统计，不能再把起始值当整班值。
      const result = advanceGameTime(draft, shiftMinutes, { job });
      // 提前停止时只算已完成的工时，不记完整班次
      if (result.stopReason === null) {
        draft.employment.shiftsCompleted += 1;
      }

      const averageEfficiencyText =
        result.workedMinutes > 0
          ? `${((result.effectiveWorkMinutes / result.workedMinutes) * 100).toFixed(1)}%`
          : '无有效出勤统计';
      return summarize(
        result,
        `出勤 ${formatDuration(result.workedMinutes)}，折算计薪 ${result.effectiveWorkMinutes.toFixed(1)} 分钟，平均效率 ${averageEfficiencyText}，应计工资 ${formatMoney(result.wagesEarned)}`,
      );
    }, true);
  }

  /* ------------------------------------------------------------ 休息 */

  rest(minutes: number): CommandOutcome {
    if (!Number.isSafeInteger(minutes) || minutes <= 0) {
      return { ok: false, message: '休息时长无效' };
    }
    return this.execute((draft) => {
      const result = advanceGameTime(draft, minutes);
      // 提示实际推进的时间，不显示没走完的原计划
      return summarize(result, `休息 ${formatDuration(result.advancedMinutes)}`);
    }, true);
  }

  /** 睡到下一次 08:00。 */
  sleepUntilMorning(): CommandOutcome {
    return this.execute((draft) => {
      const now = this.nowOf(draft);
      const target = TIME.wakeMinuteOfDay;
      const minutes =
        now.minuteOfDay < target
          ? target - now.minuteOfDay
          : TIME.calendar.minutesPerDay - now.minuteOfDay + target;
      const result = advanceGameTime(draft, minutes);
      return summarize(
        result,
        `已推进 ${formatDuration(result.advancedMinutes)}（计划睡到 08:00）`,
      );
    }, true);
  }

  /* ------------------------------------------------------------ 银行 */

  deposit(cents: number): CommandOutcome {
    if (!Number.isSafeInteger(cents) || cents <= 0) {
      return { ok: false, message: '请输入有效的存款金额' };
    }
    return this.execute((draft) => {
      const now = this.nowOf(draft);
      depositToSavings(draft.finance, {
        amount: cents,
        operationId: nextOperationId('deposit'),
        atMinute: draft.clock.totalMinute,
        monthKey: now.monthKey,
      });
      return `已存入 ${formatMoney(cents)}，现金 ${formatMoney(draft.finance.accounts.cash)}`;
    }, true);
  }

  withdraw(cents: number): CommandOutcome {
    if (!Number.isSafeInteger(cents) || cents <= 0) {
      return { ok: false, message: '请输入有效的取款金额' };
    }
    return this.execute((draft) => {
      const now = this.nowOf(draft);
      withdrawToCash(draft.finance, {
        amount: cents,
        operationId: nextOperationId('withdraw'),
        atMinute: draft.clock.totalMinute,
        monthKey: now.monthKey,
      });
      return `已取现 ${formatMoney(cents)}，现金 ${formatMoney(draft.finance.accounts.cash)}`;
    }, true);
  }

  /* ------------------------------------------------------------ 贷款 */

  borrowLoan(cents: number): CommandOutcome {
    if (!Number.isSafeInteger(cents) || cents <= 0) {
      return { ok: false, message: '请输入有效的借款金额' };
    }
    return this.execute((draft) => {
      const now = this.nowOf(draft);
      const contract = borrow(draft.loan, draft.finance, cents, {
        operationId: nextOperationId('loan'),
        atMinute: draft.clock.totalMinute,
        monthKey: now.monthKey,
      });
      return `贷款 ${formatMoney(cents)} 已放款至银行存款，到期日 ${formatDueDate(contract.dueMinute)}`;
    }, true);
  }

  repayLoan(cents: number): CommandOutcome {
    if (!Number.isSafeInteger(cents) || cents <= 0) {
      return { ok: false, message: '请输入有效的还款金额' };
    }
    return this.execute((draft) => {
      const now = this.nowOf(draft);
      const result = repay(draft.loan, draft.finance, cents, {
        operationId: nextOperationId('repay'),
        atMinute: draft.clock.totalMinute,
        monthKey: now.monthKey,
      });
      const parts = [`已还款 ${formatMoney(result.interestPaid + result.principalPaid)}`];
      if (result.interestPaid > 0) parts.push(`其中利息 ${formatMoney(result.interestPaid)}`);
      if (result.settled) parts.push('贷款已结清');
      return parts.join('，');
    }, true);
  }

  repayLoanAll(): CommandOutcome {
    return this.execute((draft) => {
      const contract = draft.loan.contract;
      if (!contract || contract.status === 'settled') {
        throw new BusinessError('NO_LOAN', '当前没有未结清的贷款');
      }
      const now = this.nowOf(draft);
      const result = repay(draft.loan, draft.finance, totalOwed(contract), {
        operationId: nextOperationId('repay'),
        atMinute: draft.clock.totalMinute,
        monthKey: now.monthKey,
      });
      return `已结清贷款 ${formatMoney(result.interestPaid + result.principalPaid)}（利息 ${formatMoney(result.interestPaid)}）`;
    }, true);
  }

  hasOpenLoan(): boolean {
    return hasOpenLoan(this.store.state.loan);
  }

  /* ------------------------------------------------------------ 股票 */

  /**
   * 买入：数量与价格先由统一预览确定（含流动性、资金与冲击成本），
   * 超出可成交数量时明确拒绝，绝不悄悄改小数量。
   */
  buyStock(
    securityId: string,
    shares: number,
    expectedPriceCents: number | null = null,
  ): CommandOutcome {
    if (!Number.isSafeInteger(shares) || shares <= 0) {
      return { ok: false, message: '请输入有效的买入股数' };
    }
    return this.execute((draft) => {
      const preview = previewTrade(draft, securityId, 'buy', shares);
      if (preview.executableShares <= 0) {
        throw new BusinessError('NO_LIQUIDITY', preview.reason ?? '当前无法成交');
      }
      if (preview.executableShares < shares) {
        throw new BusinessError(
          'QUANTITY_LIMIT',
          `受流动性或资金限制，最多可成交 ${preview.executableShares} 股（约 ${formatMoney(
            preview.executableShares * preview.priceCents,
          )}）`,
        );
      }
      const result = executeTrade(draft, {
        securityId,
        side: 'buy',
        shares,
        atMinute: draft.clock.totalMinute,
        monthKey: this.nowOf(draft).monthKey,
        operationId: nextOperationId('buy'),
        // 玩家在预览里确认过的成交均价：变了就要求刷新，不按别的价格成交
        ...(expectedPriceCents !== null ? { expectedPriceCents } : {}),
      });
      return `买入「${nameOf(draft, securityId)}」${result.preview.executableShares} 股，成交均价 ${formatMoney(
        result.preview.priceCents,
      )}，支出 ${formatMoney(result.preview.amountCents)}`;
    }, true);
  }

  sellStock(
    securityId: string,
    shares: number,
    expectedPriceCents: number | null = null,
  ): CommandOutcome {
    if (!Number.isSafeInteger(shares) || shares <= 0) {
      return { ok: false, message: '请输入有效的卖出股数' };
    }
    return this.execute((draft) => {
      const preview = previewTrade(draft, securityId, 'sell', shares);
      if (preview.executableShares <= 0) {
        throw new BusinessError('NO_LIQUIDITY', preview.reason ?? '当前无法成交');
      }
      if (preview.executableShares < shares) {
        throw new BusinessError(
          'QUANTITY_LIMIT',
          `受持股或对手方资金限制，最多可成交 ${preview.executableShares} 股`,
        );
      }
      const result = executeTrade(draft, {
        securityId,
        side: 'sell',
        shares,
        atMinute: draft.clock.totalMinute,
        monthKey: this.nowOf(draft).monthKey,
        operationId: nextOperationId('sell'),
        ...(expectedPriceCents !== null ? { expectedPriceCents } : {}),
      });
      const pnl =
        result.realized >= 0
          ? `盈利 ${formatMoney(result.realized)}`
          : `亏损 ${formatMoney(-result.realized)}`;
      return `卖出「${nameOf(draft, securityId)}」${result.preview.executableShares} 股，成交均价 ${formatMoney(
        result.preview.priceCents,
      )}，本次${pnl}`;
    }, true);
  }

  /* ------------------------------------------------------------ 执行器 */

  private execute(mutate: (draft: GameState) => string, autoSave = false): CommandOutcome {
    try {
      const message = this.store.run(mutate);
      this.hooks.notify('success', message);
      if (autoSave) this.hooks.requestAutoSave();
      return { ok: true, message };
    } catch (error) {
      const message = describeError(error);
      this.hooks.notify('error', message);
      return { ok: false, message };
    }
  }
}

function formatDueDate(totalMinute: number): string {
  const date = dateAtMinute(totalMinute, TIME.calendar);
  return `${date.month}月${date.day}日`;
}
