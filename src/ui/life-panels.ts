/**
 * 个人生活类面板：银行（存取款与贷款）、就业、系统菜单。
 *
 * 住房与土地在 `ui/estate-panel.ts`（含交易、报价与休息入口）。
 *
 * 只把只读视图渲染成 HTML，并把点击翻译成 data-action；
 * 所有写操作都由 PanelManager 转交给 app 层的命令，这里不碰状态。
 *
 * 这些区块现在被组织进统一窗口的「个人生活／系统菜单」分类，
 * 但现场办理的含义不变：存取款、入职上班、休息睡觉仍然只在对应建筑里出现。
 */

import { formatMoney } from '../core/money';
import { BRANDING, TIME } from '../content/config';
import type { GameViewModel } from '../app/view';
import { icon } from './icons';

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

function title(text: string): string {
  return `<div class="block-title">${esc(text)}</div>`;
}

/* ------------------------------------------------------------------ 银行 */

export function renderBank(view: GameViewModel): string {
  const loan = view.loan;
  const loanBlock = loan.open
    ? `
    <div class="block">
      ${title('我的贷款')}
      <div class="stat-grid">
        ${stat('贷款本金', loan.principalText, { note: `放款 ${loan.startDateText}` })}
        ${stat('未偿本金', loan.outstandingText, { live: 'loan.outstanding' })}
        ${stat('已计提利息', loan.accruedInterestText, { live: 'loan.interest', note: '按未偿本金单利累计' })}
        ${stat('待还总额', loan.totalOwedText, { live: 'loan.totalOwed', tone: loan.overdue ? 'neg' : undefined })}
        ${stat('到期日', loan.dueDateText, { note: `放款 ${loan.startDateText}` })}
        ${stat('剩余天数', loan.remainingText, { live: 'loan.remaining', tone: loan.overdue ? 'neg' : undefined })}
        ${stat('已支付合计', loan.totalPaidText, { wide: true, live: 'loan.paid' })}
      </div>
      <div class="actions" style="margin-top:10px">
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
      <div class="note" style="margin-top:8px">
        还款先冲抵已计提利息、再冲抵本金；只能使用银行存款，不足时无法还款。
        到期时系统会尝试自动偿还，付不出的部分转为逾期并继续按同一规则计息，不加罚息。
      </div>
    </div>`
    : `
    <div class="block">
      ${title('个人贷款')}
      <div class="stat-grid">
        ${stat('额度上限', loan.maxPrincipalText, { note: `单笔最低 ${loan.minPrincipalText}` })}
        ${stat('期限', loan.termText)}
        ${stat('利率', loan.interestRateText, { note: '单利，按实际未偿本金计提' })}
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
      <div class="note" style="margin-top:8px">
        借款全额进入银行存款，同时产生等额负债，<strong>不增加净资产</strong>。
        同时只能有一份未结清合同，结清后可再次申请。
      </div>
    </div>`;

  return `
    <div class="block">
      <div class="stat-grid">
        ${stat('现金', view.money.cashText, { note: '可直接用于支付', live: 'money.cash' })}
        ${stat('银行存款', view.money.savingsText, { note: '存取款、股票与贷款结算账户', live: 'money.savings' })}
        ${stat('可用资金', view.money.availableText, { note: '现金 + 银行存款', live: 'money.available' })}
        ${stat('未发工资', view.money.unpaidWagesText, { note: '未发放，不能直接用于支付', live: 'money.unpaidWages' })}
      </div>
    </div>

    <div class="block">
      ${title('存款 · 现金 → 银行存款')}
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
      ${title('取款 · 银行存款 → 现金')}
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

/* ------------------------------------------------------------------ 就业 */

export function renderOffice(view: GameViewModel): string {
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
      <div class="block"><div class="note">${esc(job.description)}</div></div>
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
      ${title('今日工时')}
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
      </div>
      <div class="note${job.shift.ok ? '' : ' warn'}" style="margin-top:8px">${esc(reason)}</div>
    </div>

    <div class="note">
      工资按分钟精确应计，并按区间开始时的生存效率折算；跨月工作时按实际工作时间归属到对应月份。
      上班会同时推进时间，途中行情、贷款计息与月结都会按顺序发生。
    </div>
  `;
}

/* -------------------------------------------------------------- 系统菜单 */

export function renderPause(view: GameViewModel): string {
  return `
    <div class="block">
      <div class="actions">
        <button type="button" class="btn btn-primary" data-action="resume">继续游戏</button>
      </div>
    </div>

    <div class="block">
      ${title('存档')}
      <div class="actions">
        <button type="button" class="btn" data-action="save">${icon('save', { size: 15 })}保存游戏</button>
        <button type="button" class="btn" data-action="load">读取存档</button>
        <button type="button" class="btn" data-action="export">导出 JSON</button>
        <label class="btn">
          导入 JSON
          <input type="file" accept="application/json,.json" hidden data-el="import-input" />
        </label>
      </div>
      <div class="actions" style="margin-top:8px">
        <button type="button" class="btn btn-danger" data-action="new-game">重新开始</button>
      </div>
    </div>

    <div class="block">
      ${title('当前进度')}
      <div class="stat-grid">
        ${stat('当前时间', view.dateText, { wide: true })}
        ${stat('速度', `${view.speed}×`, {
          note: `1 天 = ${Math.round(TIME.calendar.minutesPerDay / (TIME.minutesPerRealSecond * 60))} 分钟现实时间`,
        })}
      </div>
    </div>

    <div class="note">
      存档使用完整游戏快照，包含时间、账户与流水、任职与工资应计、股票持仓与行情、
      贷款合同、欠款、玩家位置与摄像机角度。
    </div>
    <div class="note warn" style="margin-top:6px">
      关闭页面或切到后台都不会补算离线时间、离线行情或离线收益。
    </div>
    <div class="note" style="margin-top:6px">
      ${esc(BRANDING.gameTitle)} · 当前净资产 ${formatMoney(view.money.netWorth)}
    </div>
  `;
}
