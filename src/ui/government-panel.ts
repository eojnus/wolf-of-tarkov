/**
 * 政府面板 —— 人口统计、政治人口、政府结构、选举与赞助、历史记录。
 *
 * 界面纪律：
 *  - 只消费 app/government-view 的只读视图，不直接读 features；
 *  - 草稿（赞助金额、当前栏目）只存在内存里，不写 GameState、不进存档；
 *  - 面板打开时模拟继续：刷新不重建输入框，结构不变时只更新数值节点；
 *  - 图表用原生 SVG 绘制（不引入图表库），并与文字人数、百分比同时出现。
 */

import { formatMoney } from '../core/money';
import { CANDIDATES, type CandidateId } from '../content/government';
import type { GovernmentPanelView } from '../app/government-view';
import type { CityEconomyPanelView } from '../app/city-view';
import { DonutPie, PIE_COLORS, type PieDatum } from './population-pie';

export type GovernmentTab =
  | 'population'
  | 'politics'
  | 'structure'
  | 'campaign'
  | 'economy'
  | 'development'
  | 'history';

export interface GovernmentUiHandlers {
  /** 提交一笔赞助：金额单位为分。返回命令结果供界面提示。 */
  onSponsor(candidateId: CandidateId, amountCents: number, requestId: string): {
    ok: boolean;
    message: string | null;
  };
}

const PIE_COLORS_TREND = [PIE_COLORS[1]!, PIE_COLORS[2]!, PIE_COLORS[0]!];

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 阶层占比趋势：最近 12 个月的堆叠柱。 */
function trendChart(
  points: Array<{ monthKey: string; low: number; mid: number; high: number }>,
): string {
  if (points.length === 0) return '';
  const width = 560;
  const height = 150;
  const padding = 8;
  const slot = (width - padding * 2) / points.length;
  const barWidth = Math.min(26, slot * 0.62);
  const bars = points
    .map((point, index) => {
      const x = padding + slot * index + (slot - barWidth) / 2;
      const low = Math.max(0, point.low);
      const mid = Math.max(0, point.mid);
      const high = Math.max(0, point.high);
      const yLow = height - padding - low * (height - padding * 2);
      const yMid = height - padding - (low + mid) * (height - padding * 2);
      const yHigh = height - padding - (low + mid + high) * (height - padding * 2);
      return `
        <rect x="${x.toFixed(1)}" y="${yHigh.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(0, high * (height - padding * 2)).toFixed(1)}" fill="${PIE_COLORS_TREND[2]}"></rect>
        <rect x="${x.toFixed(1)}" y="${yMid.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(0, mid * (height - padding * 2)).toFixed(1)}" fill="${PIE_COLORS_TREND[1]}"></rect>
        <rect x="${x.toFixed(1)}" y="${yLow.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(0, low * (height - padding * 2)).toFixed(1)}" fill="${PIE_COLORS_TREND[0]}"></rect>
        <text x="${(x + barWidth / 2).toFixed(1)}" y="${height - 1}" text-anchor="middle" font-size="9" fill="var(--text-faint)">${esc(point.monthKey.slice(2))}</text>`;
    })
    .join('');
  return `
    <svg class="gov-trend" viewBox="0 0 ${width} ${height}" role="img" aria-label="最近 12 个月阶层占比趋势">
      ${bars}
    </svg>
    <div class="gov-legend-row">
      <span><i class="dot" style="background:${PIE_COLORS_TREND[0]}"></i>低</span>
      <span><i class="dot" style="background:${PIE_COLORS_TREND[1]}"></i>中</span>
      <span><i class="dot" style="background:${PIE_COLORS_TREND[2]}"></i>高</span>
    </div>`;
}

function kv(label: string, value: string, live?: string): string {
  const liveAttr = live ? ` data-live="${live}"` : '';
  return `<div class="kv"><span class="k">${esc(label)}</span><span class="v num"${liveAttr}>${esc(value)}</span></div>`;
}

export class GovernmentPanel {
  private readonly populationPie = new DonutPie();
  private readonly politicsPie = new DonutPie();
  private readonly industryPie = new DonutPie();
  /** 赞助草稿：候选人 id → 输入文本（只存在内存）。 */
  private drafts: Record<string, string> = {};
  /** 待重试的赞助请求：同一笔重试复用同一个操作 id，不会重复扣款。 */
  private pending: { candidateId: CandidateId; amountCents: number; requestId: string } | null = null;

  constructor(
    private readonly view: () => GovernmentPanelView,
    private readonly handlers: GovernmentUiHandlers,
    private readonly cityView: () => CityEconomyPanelView,
  ) {}

  /** 新游戏 / 读档后清空草稿（不进存档）。 */
  resetSession(): void {
    this.drafts = {};
    this.pending = null;
  }

  /**
   * 渲染指定栏目。
   * 外部分类导航已经取代面板内部的 Tab 条，所以这里只返回栏目内容本体。
   */
  renderSection(tab: GovernmentTab): string {
    return `<div class="gov-body" data-gov-tab="${tab}">${this.renderTab(this.view(), tab)}</div>`;
  }

  /**
   * 内容重绘后重新挂载环形图：宿主换了才重建节点，数值变化只改弧长与文字，
   * 因此悬停中的扇区与提示不会被刷新打断。
   */
  paint(root: HTMLElement): void {
    const view = this.view();
    const city = this.cityView();

    const popHost = root.querySelector<HTMLElement>('[data-el="gov-pop-pie"]');
    if (popHost) {
      this.populationPie.mount(popHost);
      this.populationPie.update(populationPieData(view), {
        ariaLabel: '城市人口按经济阶层分布',
        unit: '人',
        center: {
          label: '总人口',
          value: view.population.totalText,
          sub: view.population.growthRateText,
        },
      });
    }

    const politicsHost = root.querySelector<HTMLElement>('[data-el="gov-politics-pie"]');
    if (politicsHost) {
      this.politicsPie.mount(politicsHost);
      this.politicsPie.update(politicsPieData(view), {
        ariaLabel: '城市人口按 12 个政治群体分布',
        unit: '',
        center: {
          label: '城市人口',
          value: view.population.totalText,
          sub: '12 个互斥群体',
        },
      });
    }

    const industryHost = root.querySelector<HTMLElement>('[data-el="gov-industry-pie"]');
    if (industryHost) {
      const industries = city.economy.industries;
      const data: PieDatum[] = industries.map((row, index) => ({
        id: `industry-${index}`,
        label: row.label,
        value: row.ratio,
        valueText: row.centsText,
        ratio: row.ratio,
      }));
      this.industryPie.mount(industryHost);
      this.industryPie.update(data, {
        ariaLabel: '本月已结算经营产出的产业分布',
        unit: '',
        center: {
          label: '本月产出',
          value: city.economy.monthOutputText,
          sub: industries.length ? '' : '尚无已结算经营产出',
        },
      });
    }
  }

  /**
   * 只更新数值/状态节点（面板打开且正在输入时不重建 DOM）。
   *
   * 输入期间除候选人资源与支持率外，阶段、倒计时、合格/参与人数、执政状态与
   * 「赞助按钮是否可用」也要实时反映；赞助记录表不含输入框，用内容指纹原地替换。
   */
  patchLive(root: HTMLElement): void {
    const view = this.view();
    const values = this.liveValues(view);
    for (const el of root.querySelectorAll<HTMLElement>('[data-live]')) {
      const key = el.dataset.live;
      if (!key) continue;
      const text = values[key];
      if (text === undefined) continue;
      if (el.textContent !== text) el.textContent = text;
    }
    for (const el of root.querySelectorAll<HTMLElement>('[data-live-disabled]')) {
      if (el.dataset.liveDisabled !== 'gov.sponsor') continue;
      const disabled = view.campaign.sponsorDisabled;
      if (el instanceof HTMLButtonElement && el.disabled !== disabled) el.disabled = disabled;
    }
    this.patchSponsorshipRecords(root, view);
    this.patchTrend(root, view);
    this.paint(root);
  }

  /** 阶层占比趋势是纯 SVG，没有交互状态，按内容指纹原地替换即可。 */
  private patchTrend(root: HTMLElement, view: GovernmentPanelView): void {
    const trendNode = root.querySelector<HTMLElement>('[data-el="gov-trend"]');
    if (!trendNode) return;
    const signature = view.population.trend
      .map((point) => `${point.monthKey}:${point.low}:${point.mid}:${point.high}`)
      .join('|');
    if (trendNode.dataset.signature === signature) return;
    trendNode.dataset.signature = signature;
    trendNode.innerHTML =
      trendChart(view.population.trend) || '<div class="empty">尚无趋势数据</div>';
  }

  /** 赞助记录表：结构固定、不含输入框，按内容指纹原地更新。 */
  private patchSponsorshipRecords(root: HTMLElement, view: GovernmentPanelView): void {
    const node = root.querySelector<HTMLElement>('[data-el="gov-sponsor-records"]');
    if (!node) return;
    const signature = view.campaign.records
      .map((row) => `${row.candidateName}|${row.amountText}|${row.atText}`)
      .join('~');
    if (node.dataset.signature === signature) return;
    node.dataset.signature = signature;
    node.innerHTML = this.renderSponsorshipRows(view);
  }

  private liveValues(view: GovernmentPanelView): Record<string, string> {
    const values: Record<string, string> = {
      'gov.countdown': view.campaign.countdownText,
      'gov.deadline': view.campaign.deadlineText,
      'gov.balance': view.campaign.availableBalanceText,
      'gov.participants': view.campaign.expectedParticipantsText,
      'gov.turnout': view.campaign.turnoutText,
      'gov.eligible': view.campaign.eligibleText,
      'gov.phase': view.campaign.phaseText,
      'gov.total': view.population.totalText,
      'gov.holder': view.structure.holderName,
      'gov.since': view.structure.holderSinceText,
      'gov.termLeft': view.structure.termLeftText,
      'gov.policy': view.structure.policyLabel,
    };
    for (const candidate of view.campaign.candidates) {
      const prefix = `gov.${candidate.id}`;
      values[`${prefix}.support`] = candidate.supportText;
      values[`${prefix}.expected`] = candidate.expectedVotesText;
      values[`${prefix}.advertising`] = candidate.advertisingText;
      values[`${prefix}.resources`] =
        `${candidate.baseText} / ${candidate.sponsoredText} / ${candidate.usedText} / ${candidate.remainingText}`;
      values[`${prefix}.ability`] = candidate.campaignAbilityText;
    }
    // 城市经济栏目同样在输入期间实时更新（只替换数值节点，不重建输入框）
    const city = this.cityView();
    values['city.gdp'] = city.economy.gdpText;
    values['city.settled'] = city.economy.settledOutputText;
    values['city.pending'] = city.economy.pendingOutputText;
    values['city.month'] = city.economy.monthOutputText;
    values['city.index'] = city.economy.indexText;
    values['city.adjust'] = city.economy.stockAdjustText;
    return values;
  }

  /** 处理面板内的点击。返回 true 表示已处理。 */
  handleAction(action: string, target: HTMLElement): boolean {
    if (action === 'gov-sponsor') {
      const candidateId = target.dataset.candidate as CandidateId | undefined;
      if (!candidateId) return false;
      this.submitSponsor(candidateId, target);
      return true;
    }
    return false;
  }

  /** 读取输入草稿。 */
  draftOf(candidateId: CandidateId): string {
    return this.drafts[candidateId] ?? '';
  }

  /**
   * 输入事件：实时把赞助金额存进内存草稿。
   *
   * 草稿只存在于这个组件实例里，不写 `GameState`、不进存档；
   * 切换栏目、关闭再打开都按会话规则保留，新游戏/读档由 `resetSession` 清空。
   */
  handleInput(target: HTMLInputElement): boolean {
    const name = target.getAttribute('data-el');
    if (!name || !name.startsWith('gov-amount-')) return false;
    const candidateId = name.slice('gov-amount-'.length);
    if (!CANDIDATES.some((candidate) => candidate.id === candidateId)) return false;
    this.drafts[candidateId] = target.value;
    return true;
  }

  private submitSponsor(candidateId: CandidateId, target: HTMLElement): void {
    const input = target.closest('.gov-sponsor-row')?.querySelector<HTMLInputElement>(
      `input[data-el="gov-amount-${candidateId}"]`,
    );
    const raw = (input?.value ?? this.drafts[candidateId] ?? '').trim();
    this.drafts[candidateId] = raw;
    const yuan = Number(raw);
    if (!raw || !Number.isFinite(yuan) || yuan <= 0) {
      this.handlers.onSponsor(candidateId, 0, this.requestIdFor(candidateId, 0));
      return;
    }
    const amountCents = Math.round(yuan * 100);
    const view = this.view();
    const confirmed = window.confirm(
      `确认赞助 ${view.campaign.candidates.find((row) => row.id === candidateId)?.name ?? '候选人'} ${formatMoney(amountCents)}？\n\n` +
        '· 资金仅来自你的个人存款（不动用现金、企业资金或贷款）\n' +
        '· **不可退款**，也不兑换现金\n' +
        `· ${view.campaign.countdownText}，届末未使用的竞选资源直接失效\n` +
        '· 赞助只提高宣传影响，不购买固定选票，也不保证当选\n\n' +
        '确认后立即从个人存款扣款。',
    );
    if (!confirmed) return;
    const outcome = this.handlers.onSponsor(candidateId, amountCents, this.requestIdFor(candidateId, amountCents));
    if (outcome.ok) {
      this.pending = null;
      this.drafts[candidateId] = '';
    }
  }

  /** 同一笔赞助的重试复用同一个操作 id，避免重复扣款。 */
  private requestIdFor(candidateId: CandidateId, amountCents: number): string {
    if (
      this.pending &&
      this.pending.candidateId === candidateId &&
      this.pending.amountCents === amountCents
    ) {
      return this.pending.requestId;
    }
    const random =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const requestId = `sponsor:${random}`;
    this.pending = { candidateId, amountCents, requestId };
    return requestId;
  }

  /* ------------------------------------------------------------ 栏目 */

  private renderTab(view: GovernmentPanelView, tab: GovernmentTab): string {
    switch (tab) {
      case 'population':
        return this.renderPopulation(view);
      case 'politics':
        return this.renderPolitics(view);
      case 'structure':
        return this.renderStructure(view);
      case 'campaign':
        return this.renderCampaign(view);
      case 'economy':
        return this.renderEconomy();
      case 'development':
        return this.renderDevelopment();
      case 'history':
        return this.renderHistory(view);
    }
  }

  private renderPopulation(view: GovernmentPanelView): string {
    const pop = view.population;
    const trendSignature = pop.trend
      .map((point) => `${point.monthKey}:${point.low}:${point.mid}:${point.high}`)
      .join('|');
    const classRows = pop.classes
      .map(
        (row) => `
        <tr>
          <td>${esc(row.name)}</td>
          <td class="num">${esc(row.peopleText)}</td>
          <td class="num">${esc(row.ratioText)}</td>
        </tr>`,
      )
      .join('');
    return `
      <div class="block">
        <div class="block-title">城市人口</div>
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-label">总人口</div>
            <div class="stat-value num" data-live="gov.total">${esc(pop.totalText)}</div>
            <div class="stat-note">${esc(pop.growthRateText)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">结算状态</div>
            <div class="stat-value">${esc(pop.settledMonthKey ?? '—')}</div>
            <div class="stat-note">${esc(pop.settledNote)}</div>
          </div>
        </div>
        <div data-el="gov-pop-pie" data-preserve="gov-pop-pie"></div>
        <div class="note">扇区与图例双向联动：悬停或键盘聚焦时扇区沿中线轻微外移并提亮，中心显示该阶层的摘要；表格保留同一份人数与占比，信息不只靠颜色表达。</div>
        <table class="gov-table">
          <thead><tr><th>经济阶层</th><th>人数</th><th>占比</th></tr></thead>
          <tbody>${classRows}</tbody>
        </table>
      </div>

      <div class="block">
        <div class="block-title">最近 12 个月阶层占比趋势</div>
        <div data-el="gov-trend" data-signature="${esc(trendSignature)}">${trendChart(pop.trend) || '<div class="empty">尚无趋势数据</div>'}</div>
        <div class="note">柱子自下而上为低、中、高三层占比；右侧文字为各月占比，与柱子面积同源。</div>
      </div>
    `;
  }

  private renderPolitics(view: GovernmentPanelView): string {
    const politics = view.politics;
    const rows = politics.groups
      .map(
        (row) => `
        <tr>
          <td>${esc(row.name)}</td>
          <td class="num">${esc(row.peopleText)}</td>
          <td class="num">${esc(row.ratioText)}</td>
          <td class="num">${esc(row.turnoutText)}</td>
          <td class="num">${esc(row.satisfactionText)}</td>
          <td class="num">${esc(row.support.map((item) => `${item.name} ${item.ratioText}`).join(' · '))}</td>
        </tr>`,
      )
      .join('');
    const marginRows = [...politics.incomeMargins, ...politics.interestMargins]
      .map(
        (row) => `
        <tr>
          <td>${esc(row.name)}</td>
          <td class="num">${esc(row.peopleText)}</td>
          <td class="num">${esc(row.ratioText)}</td>
          <td class="num">${esc(row.satisfactionText)}</td>
          <td class="num">${row.consecutiveMonths} / 3</td>
        </tr>`,
      )
      .join('');
    return `
      <div class="block">
        <div class="block-title">交叉政治群体（3 收入 × 4 利益 = 12 格）</div>
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-label">全市人口加权平均满意度</div>
            <div class="stat-value num">${esc(politics.averageSatisfactionText)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">提前选举监测</div>
            <div class="stat-value">${esc(politics.cityMonthsText)}</div>
            <div class="stat-note">${esc(politics.protectionText)}</div>
          </div>
        </div>
        <div data-el="gov-politics-pie" data-preserve="gov-politics-pie" class="pie-host-dense"></div>
        <div class="note">环形图只用这 12 个互斥群体：扇区面积来自同一份人数比例，合计等于城市人口。收入边际与利益边际是各自覆盖全人口的统计，不能与 12 群体相加。</div>
        <table class="gov-table">
          <thead>
            <tr><th>群体</th><th>人数</th><th>占比</th><th>参与倾向</th><th>满意度</th><th>群体内支持率</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="note">${esc(politics.note)}</div>
        <div class="note">全人口加权支持率（按群体比例，不含投票率）：${esc(politics.summaryText)}</div>
      </div>
      <div class="block">
        <div class="block-title">主要群体监测（3 收入边际 + 4 利益边际）</div>
        <table class="gov-table">
          <thead><tr><th>主要群体</th><th>人数</th><th>占人口</th><th>满意度</th><th>连续低满意度月</th></tr></thead>
          <tbody>${marginRows}</tbody>
        </table>
        <div class="note">${esc(politics.earlyElectionNote)}</div>
        <div class="note">提前选举不会因不同群体轮流不满而累计成同一个「三个月」：每个主要群体有独立计数器。</div>
      </div>
    `;
  }

  private renderStructure(view: GovernmentPanelView): string {
    const structure = view.structure;
    return `
      <div class="block">
        <div class="block-title">${esc(structure.institution)}</div>
        <div class="kv-list">
          ${kv('职位', structure.officeTitle)}
          ${kv('执政人', structure.holderName, 'gov.holder')}
          ${kv('上任时间', structure.holderSinceText, 'gov.since')}
          ${kv('任期', structure.termLeftText, 'gov.termLeft')}
          ${kv('任期标识', structure.termIdText)}
          ${kv('执政方向', structure.directionText)}
          ${kv('任期来源', structure.sourceText)}
          ${kv('当前政策', structure.policyLabel, 'gov.policy')}
        </div>
        ${
          structure.caretaker
            ? '<div class="note warn">当前为中性过渡负责人：不享有任何候选人的产业政策，也不获得现任竞选加分。</div>'
            : ''
        }
        <div class="note">${esc(structure.note)}</div>
      </div>
      <div class="block">
        <div class="block-title">政策效果</div>
        <div class="stat-grid">
          ${structure.policyEffects
            .map(
              (row) => `
            <div class="stat">
              <div class="stat-label">${esc(row.label)}</div>
              <div class="stat-value num">${esc(row.value)}</div>
            </div>`,
            )
            .join('')}
        </div>
        <div class="note">政策由选举结果产生，只对生效区间内新发生的经营事项生效；企业与 AI 适用同一套规则。</div>
      </div>
    `;
  }

  private renderSponsorshipRows(view: GovernmentPanelView): string {
    const records = view.campaign.records
      .map(
        (row) => `
        <tr>
          <td>${esc(row.candidateName)}</td>
          <td class="num">${esc(row.amountText)}</td>
          <td>${esc(row.atText)}</td>
        </tr>`,
      )
      .join('');
    return records || '<tr><td colspan="3">还没有赞助记录</td></tr>';
  }

  private renderCampaign(view: GovernmentPanelView): string {
    const campaign = view.campaign;
    const candidateRows = campaign.candidates
      .map((row) => {
        const prefix = `gov.${row.id}`;
        return `
        <div class="gov-candidate">
          <div class="gov-candidate-head">
            <span class="gov-candidate-name">${esc(row.name)}</span>
            <span class="badge">${esc(row.platform)}</span>
          </div>
          <div class="kv-list">
            ${kv('执政能力', row.policyLabel)}
            ${kv('候选能力', row.campaignAbilityText, `${prefix}.ability`)}
            ${kv('全人口加权支持率', row.supportText, `${prefix}.support`)}
            ${kv('预计有效票', row.expectedVotesText, `${prefix}.expected`)}
            ${kv('宣传影响', row.advertisingText, `${prefix}.advertising`)}
            ${kv('资源（基础/已赞助/已使用/剩余）', `${row.baseText} / ${row.sponsoredText} / ${row.usedText} / ${row.remainingText}`, `${prefix}.resources`)}
          </div>
          <div class="gov-sponsor-row">
            <input
              class="field"
              type="number"
              min="1"
              step="1"
              placeholder="赞助金额（元）"
              data-el="gov-amount-${row.id}"
              value="${esc(this.draftOf(row.id))}"
            />
            <button type="button" class="btn btn-sm btn-primary" data-action="gov-sponsor" data-candidate="${row.id}" data-live-disabled="gov.sponsor"${campaign.sponsorDisabled ? ' disabled' : ''}>赞助</button>
          </div>
        </div>`;
      })
      .join('');
    return `
      <div class="block">
        <div class="block-title">竞选状态</div>
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-label">阶段</div>
            <div class="stat-value" data-live="gov.phase">${esc(campaign.phaseText)}</div>
            <div class="stat-note" data-live="gov.deadline">投票时刻 ${esc(campaign.deadlineText)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">倒计时</div>
            <div class="stat-value num" data-live="gov.countdown">${esc(campaign.countdownText)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">合格人数</div>
            <div class="stat-value num" data-live="gov.eligible">${esc(campaign.eligibleText)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">预计参与</div>
            <div class="stat-value num" data-live="gov.participants">${esc(campaign.expectedParticipantsText)}</div>
            <div class="stat-note">预计投票率 <span data-live="gov.turnout">${esc(campaign.turnoutText)}</span></div>
          </div>
        </div>
        ${
          campaign.lowTurnout
            ? '<div class="note warn">预计投票率偏低：只要存在有效票，结果仍然有效，界面会保留提示。</div>'
            : ''
        }
      </div>

      <div class="block">
        <div class="block-title">候选人</div>
        ${candidateRows}
        <div class="note">${esc(campaign.sponsorNote)}</div>
        <div class="note">可用个人存款：<span class="num" data-live="gov.balance">${esc(campaign.availableBalanceText)}</span></div>
      </div>

      <div class="block">
        <div class="block-title">我的赞助记录</div>
        <table class="gov-table">
          <thead><tr><th>候选人</th><th>金额</th><th>时间</th></tr></thead>
          <tbody data-el="gov-sponsor-records" data-signature="${esc(
            campaign.records.map((row) => `${row.candidateName}|${row.amountText}|${row.atText}`).join('~'),
          )}">${this.renderSponsorshipRows(view)}</tbody>
        </table>
      </div>
    `;
  }

  private renderHistory(view: GovernmentPanelView): string {
    const history = view.history;
    const electionRows = history.elections
      .map(
        (row) => `
        <tr>
          <td>${esc(row.termText)}</td>
          <td>${esc(row.atText)}</td>
          <td class="num">${esc(row.populationText)}</td>
          <td class="num">${esc(row.eligibleText)}</td>
          <td class="num">${esc(row.participantsText)}</td>
          <td>${esc(row.votesText)}</td>
          <td>${esc(row.winnerText)}</td>
        </tr>`,
      )
      .join('');
    const termRows = history.terms
      .map(
        (row) => `
        <tr>
          <td>${esc(row.name)}</td>
          <td class="num">${esc(row.startText)}</td>
          <td class="num">${esc(row.endText)}</td>
          <td>${esc(row.directionText)}</td>
          <td>${esc(row.sourceText)}</td>
          <td>${esc(row.effectsText)}</td>
          <td>${esc(row.note)}</td>
        </tr>`,
      )
      .join('');
    return `
      <div class="block">
        <div class="block-title">历届选举</div>
        <table class="gov-table">
          <thead>
            <tr><th>届次</th><th>时间</th><th>投票时人口</th><th>合格人数</th><th>参与人数</th><th>票数</th><th>当选</th></tr>
          </thead>
          <tbody>${electionRows || `<tr><td colspan="7">${esc(history.emptyText)}</td></tr>`}</tbody>
        </table>
        ${
          history.elections.some((row) => row.tieNote)
            ? `<div class="note">平票处理：${esc(
                history.elections.find((row) => row.tieNote)?.tieNote ?? '',
              )}</div>`
            : ''
        }
      </div>
      <div class="block">
        <div class="block-title">任职与政策记录</div>
        <table class="gov-table">
          <thead>
            <tr><th>负责人</th><th>上任</th><th>离任</th><th>方向</th><th>来源</th><th>政策效果快照</th><th>说明</th></tr>
          </thead>
          <tbody>${termRows || '<tr><td colspan="7">暂无记录</td></tr>'}</tbody>
        </table>
      </div>
    `;
  }

  /**
   * 城市经济栏目：GDP 三部分、实时待结算、股市指数与调整值、月度趋势、
   * 产业经营产出占比、人口与政治概览。
   * 只消费 `CityEconomyPanelView`，不自己计算任何数值；
   * 企业样本统计与内部区域结构不在玩家界面展示。
   */
  private renderEconomy(): string {
    const city = this.cityView();
    const economy = city.economy;
    const trendRows = economy.trend
      .map(
        (row) => `
        <tr>
          <td>${esc(row.monthKey)}</td>
          <td class="num">${esc(row.gdpText)}</td>
          <td class="num">${esc(row.outputText)}</td>
          <td class="num">${esc(row.indexText)}</td>
        </tr>`,
      )
      .join('');
    return `
      <div class="block">
        <div class="block-title">实时游戏 GDP（发展指标，不是现金）</div>
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-label">实时游戏 GDP</div>
            <div class="stat-value num" data-live="city.gdp">${esc(economy.gdpText)}</div>
            <div class="stat-note">${esc(economy.compositionText)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">开局基础 GDP</div>
            <div class="stat-value num">${esc(economy.baseGdpText)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">累计经营产出</div>
            <div class="stat-value num">${esc(economy.cumulativeOutputText)}</div>
            <div class="stat-note">
              <span data-live="city.settled">${esc(economy.settledOutputText)}</span> ·
              <span data-live="city.pending">${esc(economy.pendingOutputText)}</span>
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">本月新增经营产出</div>
            <div class="stat-value num" data-live="city.month">${esc(economy.monthOutputText)}</div>
          </div>
        </div>
        <div class="kv-list">
          ${kv('全市场指数', economy.indexText, 'city.index')}
          ${kv('指数样本', economy.indexNote)}
          ${kv('股市权重口径', economy.stockWeightText)}
          ${kv('当前股市调整值', economy.stockAdjustText, 'city.adjust')}
        </div>
        <div class="note">${esc(economy.notes)}</div>
        ${!economy.indexValid ? '<div class="note warn">指数样本不足：保持上一观察值并如实标注，不会静默回到 100。</div>' : ''}
      </div>

      <div class="block">
        <div class="block-title">本月已结算经营产出的产业拆分</div>
        <div data-el="gov-industry-pie" data-preserve="gov-industry-pie"></div>
        <div class="note">${esc(economy.industryNote)}</div>
        <div class="note">产业占比只按「本月已结算产出」拆分（与下方月度快照同尺度）；累计产出与 GDP 在上一栏单独展示。</div>
      </div>

      <div class="block">
        <div class="block-title">最近月度产出与 GDP 快照</div>
        <table class="gov-table">
          <thead><tr><th>月份</th><th>GDP</th><th>本月经营产出</th><th>指数</th></tr></thead>
          <tbody>${trendRows || '<tr><td colspan="4">尚无完整月度快照（第一个月结后出现）</td></tr>'}</tbody>
        </table>
      </div>

      <div class="block">
        <div class="block-title">城市人口与收入阶层</div>
        <div class="kv-list">
          ${kv('城市人口', city.population.totalText, 'gov.total')}
          ${city.population.classes
            .map((row) => kv(row.name, `${row.peopleText} 人（${row.ratioText}）`))
            .join('')}
          ${kv('全市平均满意度', city.politics.averageSatisfactionText)}
        </div>
        <table class="gov-table">
          <thead><tr><th>利益边际群体</th><th>人数</th><th>占人口</th><th>满意度</th></tr></thead>
          <tbody>${city.population.interestMargins
            .map(
              (row) =>
                `<tr><td>${esc(row.name)}</td><td class="num">${esc(row.peopleText)}</td><td class="num">${esc(row.ratioText)}</td><td class="num">${esc(row.satisfactionText)}</td></tr>`,
            )
            .join('')}</tbody>
        </table>
        <div class="note">${esc(city.population.note)}</div>
      </div>

    `;
  }

  /**
   * 建设与城区栏目：门槛、项目与落成历史。
   * 只消费 `CityEconomyPanelView` 的 development 部分；
   * 逻辑地图的边界、地块与建筑 id 属于内部结构，不在玩家界面展示。
   */
  private renderDevelopment(): string {
    const city = this.cityView();
    const projectRows = city.development.projects
      .map(
        (row) => `
        <tr>
          <td>${esc(row.stageText)}</td>
          <td>${esc(row.directionText)}</td>
          <td>${esc(row.statusText)}</td>
          <td class="num">${esc(row.completeText)}</td>
          <td>${esc(row.note)}</td>
        </tr>`,
      )
      .join('');
    const completionRows = city.development.completions
      .map(
        (row) => `
        <tr>
          <td>${esc(row.districtText)}</td>
          <td>${esc(row.directionText)}</td>
          <td class="num">${esc(row.completedText)}</td>
        </tr>`,
      )
      .join('');
    return `
      <div class="block">
        <div class="block-title">建设阶段与扩张历史</div>
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-label">建设阶段</div>
            <div class="stat-value">${esc(city.development.stageText)}</div>
            <div class="stat-note">${esc(city.development.gapText)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">下一门槛</div>
            <div class="stat-value num">${esc(city.development.nextThresholdText)}</div>
          </div>
        </div>
        <div class="note">${esc(city.development.lastJudgementText)}</div>
        <table class="gov-table">
          <thead><tr><th>阶段</th><th>方向</th><th>状态</th><th>计划完成</th><th>说明</th></tr></thead>
          <tbody>${projectRows || '<tr><td colspan="5">尚无建设项目</td></tr>'}</tbody>
        </table>
        <table class="gov-table">
          <thead><tr><th>已落成城区</th><th>方向</th><th>完成时间</th></tr></thead>
          <tbody>${completionRows || '<tr><td colspan="3">尚无已完成城区</td></tr>'}</tbody>
        </table>
        <div class="note">${esc(city.development.note)}</div>
      </div>
    `;
  }
}

/** 人口分类 → 环形图数据。人数与占比都直接用视图给出的同一份数值。 */
function populationPieData(view: GovernmentPanelView): PieDatum[] {
  return view.population.classes.map((row) => ({
    id: row.name,
    label: row.name,
    value: row.people,
    valueText: row.peopleText,
    ratio: row.ratio,
  }));
}

/**
 * 12 个交叉政治群体 → 环形图数据。
 *
 * `value` 用视图给的 `ratio`（同一份人数比例，合计为 1），因此扇区面积与
 * 表格里的占比是同一个口径；不从已取整的显示文本反算，也不把收入/利益边际混进来。
 * 人数为 0 的群体得到零长度扇区，图例仍保留一行，便于说明「该群体当前为 0 人」。
 */
function politicsPieData(view: GovernmentPanelView): PieDatum[] {
  return view.politics.groups.map((row) => ({
    id: row.id,
    label: row.name,
    value: row.ratio,
    valueText: row.peopleText,
    ratio: row.ratio,
  }));
}

/** 供面板外部读取的候选人列表（避免重复引入 content 依赖）。 */
export const GOVERNMENT_CANDIDATE_IDS: readonly CandidateId[] = CANDIDATES.map(
  (candidate) => candidate.id,
);
