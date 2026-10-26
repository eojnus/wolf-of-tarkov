/**
 * 企业管理面板 —— 只负责把只读视图渲染成 HTML，并把点击翻译成 data-action。
 *
 * 不导入任何业务模块、不修改状态：所有写操作都由 PanelManager 转交给 app 层的命令。
 */

import type { BusinessView, ProductView } from '../app/business-view';

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
  options?: { tone?: 'pos' | 'neg'; note?: string; wide?: boolean },
): string {
  const tone = options?.tone ? ` ${options.tone}` : '';
  const wide = options?.wide ? ' wide' : '';
  const note = options?.note ? `<div class="stat-note">${esc(options.note)}</div>` : '';
  return `<div class="stat${wide}">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value num${tone}">${esc(value)}</div>
    ${note}
  </div>`;
}

function kv(label: string, value: string, tone?: 'pos' | 'neg'): string {
  const cls = tone ? ` ${tone}` : '';
  return `<div class="kv"><span class="k">${esc(label)}</span><span class="v num${cls}">${esc(value)}</span></div>`;
}

export function renderBusinessCreate(view: BusinessView): string {
  return `
    <div class="block">
      <div class="block-title">创建科技公司</div>
      <div class="field-row">
        <input class="field" data-el="company-name" maxlength="12" placeholder="公司名称（2–12 字）" />
        <input class="field" data-el="company-capital" inputmode="decimal" placeholder="初始出资（元，最低 ${esc(
          view.createMinCapitalText,
        )}）" />
      </div>
      <div class="actions" style="margin-top:10px">
        <button type="button" class="btn btn-primary" data-action="create-company" ${
          view.canCreate ? '' : 'disabled'
        }>出资并成立公司</button>
      </div>
      <div class="note" style="margin-top:10px">
        ${esc(view.createHint)}。这笔钱是从个人银行存款转入企业账户的<strong>创始资本</strong>，
        不是手续费，也不减少净资产；公司现金与个人资金完全独立，
        公司欠款不会变成你的个人债务，已成立的旧公司不会追溯要求补足。
      </div>
    </div>
  `;
}

export function renderBusinessOverview(view: BusinessView): string {
  const profitTone = view.monthProfitPositive ? 'pos' : 'neg';
  return `
    <div class="block">
      <div class="stat-grid">
        ${stat('企业现金', view.cashText, { note: '独立账户，不直接计入个人现金' })}
        ${stat('应付费用', view.payablesText, {
          tone: view.payables > 0 ? 'neg' : undefined,
          note: '未付工资与经营费用',
        })}
        ${stat('账面权益', view.equityText, { note: '现金 − 应付' })}
        ${stat('可分配现金', view.distributableText, { note: '分红只能取这部分' })}
        ${stat('有效科技', String(view.techLevel), { note: '永久积累 + 高管能力' })}
        ${stat('永久积累', String(view.permanentTech))}
        ${stat('高管能力', String(view.talentAbility), { note: view.talentName })}
        ${stat('本月利润', view.monthProfitText, { tone: profitTone, note: '应计口径，未付费用也计入' })}
      </div>
      <div class="actions" style="margin-top:10px">
        <span class="badge ${view.status === 'active' ? 'live' : 'off'}">${esc(view.statusText)}</span>
        ${view.liquidationNote ? `<span class="note" style="margin:0">${esc(view.liquidationNote)}</span>` : ''}
      </div>
    </div>
  `;
}

export function renderBusinessActions(view: BusinessView): string {
  const canResume = view.payables === 0 && view.status !== 'closed';
  const perm = view.canManage ? '' : 'disabled';
  return `
    <div class="block">
      <div class="block-title">资金与经营</div>
      <div class="field-row">
        <input class="field" data-el="fund-input" inputmode="decimal" placeholder="追加出资（元）" ${perm} />
        <button type="button" class="btn" data-action="fund-company" ${perm}>追加出资</button>
      </div>
      <div class="field-row" style="margin-top:8px">
        <input class="field" data-el="dividend-input" inputmode="decimal" placeholder="分红金额（元）" ${perm} />
        <button type="button" class="btn" data-action="dividend" ${perm}>分红</button>
        <button type="button" class="btn btn-sm" data-action="dividend-all" ${perm}>全部分配</button>
      </div>
      <div class="quick-row">
        <button type="button" class="btn btn-sm" data-action="pause-company" ${perm}>暂停经营</button>
        <button type="button" class="btn btn-sm" data-action="resume-company" ${
          canResume && view.canManage ? '' : 'disabled'
        }>恢复经营</button>
        <button type="button" class="btn btn-sm btn-ghost" data-action="liquidate-company" ${perm}>清算公司</button>
        <button type="button" class="btn btn-sm" data-action="advance-event" ${perm}>推进到下一事件</button>
      </div>
      <div class="note" style="margin-top:8px">
        ${view.canManage ? '' : '你不是现任 CEO，只能查看，不能提交经营与资本操作。<br />'}
        暂停后不再销售、也不计营销与运营费。恢复经营须先付清全部应付；
        清算会先偿还企业欠款，剩余现金按有效持股分配给股东，未清偿部分不追索个人资金。
      </div>
    </div>
  `;
}

export function renderBusinessTalent(view: BusinessView): string {
  const perm = view.canManage ? '' : 'disabled';
  const rows = view.candidates
    .map(
      (candidate) => `
      <div class="candidate-row">
        <div>
          <div class="candidate-name">${esc(candidate.name)} <span class="candidate-ability">能力 ${candidate.ability}</span></div>
          <div class="candidate-meta">月薪 ${esc(candidate.salaryText)} · ${esc(candidate.note)}</div>
        </div>
        <div class="candidate-side">
          ${
            candidate.available
              ? `<button type="button" class="btn btn-sm" data-action="hire-talent" data-candidate="${esc(candidate.id)}" ${perm}>聘用</button>`
              : `<span class="candidate-taken">${esc(candidate.employedByText)}</span>`
          }
        </div>
      </div>`,
    )
    .join('');
  return `
    <div class="block">
      <div class="block-title">科研高管</div>
      <div class="stat-grid">
        ${stat('当前高管', view.talentName, { note: view.talentSalaryText })}
        ${stat('待发工资', view.talentAccruedText, { note: '按实际任职分钟计提，月末支付' })}
      </div>
      <div class="actions" style="margin-top:8px">
        <button type="button" class="btn btn-sm btn-ghost" data-action="fire-talent" ${
          view.talentAbility > 0 && view.canManage ? '' : 'disabled'
        }>解雇</button>
      </div>
      <div class="candidate-list">${rows}</div>
      <div class="note" style="margin-top:8px">
        每位候选人只能被一家公司聘用；工资按月薪 × 实际任职分钟计提，月中解雇不免除已产生的薪酬。
        没有高管时仍可用永久科技积累研发。
      </div>
    </div>
  `;
}

function renderTechInvest(view: BusinessView): string {
  const perm = view.canManage ? '' : 'disabled';
  return `
    <div class="block">
      <div class="block-title">技术积累投入</div>
      <div class="field-row">
        <input class="field" data-el="tech-input" inputmode="decimal" placeholder="投入金额（元）" ${perm} />
        <button type="button" class="btn" data-action="invest-tech" ${perm}>投入</button>
      </div>
      <div class="note" style="margin-top:8px">
        提高永久科技积累，边际收益递减，与单款产品的研发预算互不重复计算。
        当前永久积累 ${view.permanentTech}。
      </div>
    </div>
  `;
}

function renderResearch(view: BusinessView): string {
  const perm = view.canManage ? '' : 'disabled';
  const options = view.focusOptions
    .map((option) => `<option value="${esc(option.id)}">${esc(option.name)}</option>`)
    .join('');

  if (view.hasProject) {
    const projected = view.projectProjected
      .map((line) => kv(line.label, line.value))
      .join('');
    return `
      <div class="block">
        <div class="block-title">研发进行中</div>
        <div class="progress"><div class="progress-fill" style="width:${view.projectProgressPct}%"></div></div>
        <div class="stat-grid" style="margin-top:10px">
          ${stat('研发重点', view.projectFocusText)}
          ${stat('计划时长', `${view.projectDays} 天`)}
          ${stat('已进行', `${view.projectElapsedDays} 天`)}
          ${stat('剩余', view.projectRemainingText)}
          ${stat('预算', view.projectBudgetText, { note: '立项时已一次付清' })}
          ${stat('立项科技', String(view.projectBaseTech))}
        </div>
        <div class="kv-list">${projected}</div>
        <div class="actions" style="margin-top:8px">
          <button type="button" class="btn btn-sm btn-ghost" data-action="cancel-research" ${perm}>取消项目（不退费用）</button>
        </div>
        <div class="note" style="margin-top:8px">
          预计完成：${esc(view.projectEndText)}。立项科技已锁定，后续更换高管不追溯改变本品的基础。
        </div>
      </div>
    `;
  }

  return `
    <div class="block">
      <div class="block-title">新产品立项</div>
      <div class="field-row">
        <select class="field" data-el="research-focus" ${perm}>${options}</select>
        <input class="field" data-el="research-days" inputmode="numeric" placeholder="研发天数（建议 90）" ${perm} />
        <input class="field" data-el="research-budget" inputmode="decimal" placeholder="研发预算（元）" ${perm} />
        <button type="button" class="btn btn-primary" data-action="start-research" ${perm}>立项</button>
      </div>
      <div class="note" style="margin-top:8px">
        第 1–${view.limits.capDays} 天收益递增，超过 ${view.limits.capDays} 天不再增加属性（最长可填 ${view.limits.maxPlannedDays} 天）。
        参考预算 ${esc(view.limits.referenceBudgetText)}；最低 ${esc(view.limits.minResearchBudgetText)}。
        立项即支付全部预算，取消不退。每个游戏年最多发布一款产品。
        ${view.publishBlocked ? `<br />${esc(view.publishBlockedText)}` : ''}
      </div>
    </div>
  `;
}

function renderPending(view: BusinessView): string {
  const perm = view.canManage ? '' : 'disabled';
  if (view.pending.length === 0) return '';
  return view.pending
    .map((product) => {
      const attrs = product.attributes
        .map((line) => kv(line.label, line.value))
        .join('');
      return `
      <div class="block">
        <div class="block-title">待上市产品</div>
        <div class="stat-grid">
          ${stat('品质分数 Q', product.qualityText, { note: '按人口偏好加权' })}
          ${stat('单位成本', product.unitCostText, { note: '研发完成时锁定' })}
          ${stat('建议售价', product.suggestedPriceText, { note: '仅作参考，可自由定价' })}
        </div>
        <div class="kv-list">${attrs}</div>
        <div class="field-row" style="margin-top:10px">
          <input class="field" data-el="release-name-${esc(product.id)}" maxlength="16" placeholder="产品名称" ${perm} />
          <input class="field" data-el="release-price-${esc(product.id)}" inputmode="decimal" placeholder="售价（元）" ${perm} />
          <input class="field" data-el="release-marketing-${esc(product.id)}" inputmode="decimal" placeholder="每日营销（元）" ${perm} />
          <button type="button" class="btn btn-primary" data-action="release-product" data-product="${esc(
            product.id,
          )}" ${perm}>发布上市</button>
        </div>
        <div class="note" style="margin-top:8px">
          售价只影响收入，不影响本轮销量；发布后会占用本年度发布名额。
        </div>
      </div>`;
    })
    .join('');
}

function renderProduct(product: ProductView, canManage: boolean): string {
  const perm = canManage ? '' : 'disabled';
  return `
    <div class="product-card">
      <div class="product-head">
        <div>
          <div class="product-name">${esc(product.name)}
            <span class="badge ${product.onSale ? 'live' : 'off'}">${esc(product.onSaleText)}</span>
          </div>
          <div class="product-meta">
            ${esc(product.generationText)} · 代际系数 ${esc(product.generationFactorText)} ·
            Q ${esc(product.qualityText)} · 预计日销 ${esc(product.dailyUnitsText)} 件
          </div>
        </div>
        <div class="product-price num">${esc(product.priceText)}</div>
      </div>
      <div class="stat-grid">
        ${stat('单位成本', product.unitCostText)}
        ${stat('单件毛利', product.marginText)}
        ${stat('累计销量', `${product.totalUnits} 件`)}
        ${stat('累计收入', product.revenueText)}
        ${stat('累计成本', product.costText)}
        ${stat('销售毛利', product.grossText, {
          tone: product.grossPositive ? 'pos' : 'neg',
          note: '未扣营销与运营费',
        })}
      </div>
      ${
        product.onSale
          ? `<div class="field-row" style="margin-top:10px">
        <input class="field" data-el="price-${esc(product.id)}" inputmode="decimal" placeholder="新售价（元）" ${perm} />
        <button type="button" class="btn btn-sm" data-action="save-price" data-product="${esc(product.id)}" ${perm}>改价</button>
        <input class="field" data-el="marketing-${esc(product.id)}" inputmode="decimal" placeholder="每日营销（元）" ${perm} />
        <button type="button" class="btn btn-sm" data-action="save-marketing" data-product="${esc(
          product.id,
        )}" ${perm}>改营销</button>
        <button type="button" class="btn btn-sm btn-ghost" data-action="stop-product" data-product="${esc(
          product.id,
        )}" ${perm}>停售</button>
      </div>`
          : `<div class="note" style="margin-top:8px">已停售，不会自动恢复上架。</div>`
      }
    </div>
  `;
}

function renderProducts(view: BusinessView): string {
  const body = view.products.length
    ? view.products.map((product) => renderProduct(product, view.canManage)).join('')
    : '<div class="empty">还没有在售产品，先完成一次研发并发布</div>';
  return `
    <div class="block">
      <div class="block-title">产品线</div>
      ${body}
      <div class="note" style="margin-top:8px">
        每落后一代销量系数乘 0.5；代次在发布时确定，不会随时间重复累计。
      </div>
    </div>
  `;
}

export function renderBusinessFinance(view: BusinessView): string {
  const reports = view.reports.length
    ? view.reports
        .map(
          (report) => `
      <div class="report-card">
        <div class="report-head">
          <span class="report-month">${esc(report.monthKey)}</span>
          <span class="num" style="color:${report.profitPositive ? 'var(--success)' : 'var(--danger)'}">
            ${report.profitPositive ? '+' : ''}${esc(report.profitText)}
          </span>
        </div>
        ${kv('销售收入', report.revenueText, 'pos')}
        ${kv('经营费用', report.expenseText, 'neg')}
        ${kv('销量', `${report.units} 件`)}
        ${kv('期末现金', report.cashText)}
        ${kv('期末应付', report.payablesText)}
      </div>`,
        )
        .join('')
    : '<div class="empty">还没有企业月报，跨月后生成</div>';

  return `
    <div class="block">
      <div class="block-title">本月经营（应计）</div>
      <div class="stat-grid">
        ${stat('销售收入', view.monthRevenueText)}
        ${stat('应计费用', view.monthExpenseText, { note: '成本 + 工资 + 研发 + 营销 + 运营' })}
        ${stat('利润', view.monthProfitText, { tone: view.monthProfitPositive ? 'pos' : 'neg' })}
        ${stat('销量', `${view.monthUnits} 件`)}
      </div>
      <div class="note" style="margin-top:8px">
        利润按应计口径计算：未付的成本与工资同样计入费用；
        现金变化与利润分开显示，不能把欠着没付的费用当成利润。
      </div>
    </div>
    <div class="block">
      <div class="block-title">企业月报</div>
      ${reports}
    </div>
  `;
}

export function renderBusinessMarket(view: BusinessView): string {
  const rows = view.competitors
    .map(
      (company) => `
      <div class="candidate-row">
        <div>
          <div class="candidate-name">${esc(company.name)}
            <span class="badge ${company.statusText === '正常经营' ? 'live' : 'off'}">${esc(company.statusText)}</span>
          </div>
          <div class="candidate-meta">
            科技 ${company.techLevel} · 现金 ${esc(company.cashText)} ·
            在售 ${company.onSaleCount}/${company.productCount} 款 · 累计销量 ${company.totalUnits} 件
          </div>
          <div class="candidate-meta">最新产品：${esc(company.latestProductName)} ${esc(company.latestPriceText)}</div>
        </div>
      </div>`,
    )
    .join('');
  return `
    <div class="block">
      <div class="block-title">市场总览</div>
      ${rows}
      <div class="note" style="margin-top:8px">${esc(view.marketNote)}</div>
    </div>
  `;
}

/** 研发与产品子页：技术积累 + 立项/进度 + 待发布 + 产品线。 */
export function renderBusinessResearchSection(view: BusinessView): string {
  return [
    renderTechInvest(view),
    renderResearch(view),
    renderPending(view),
    renderProducts(view),
  ].join('');
}

/** 兼容入口：整页顺序拼接（旧面板与需要单页显示时使用）。 */
export function renderBusinessPanel(view: BusinessView): string {
  if (!view.hasCompany) {
    return renderBusinessCreate(view) + renderBusinessMarket(view);
  }
  return [
    renderBusinessOverview(view),
    renderBusinessActions(view),
    renderBusinessTalent(view),
    renderBusinessResearchSection(view),
    renderBusinessFinance(view),
    renderBusinessMarket(view),
  ].join('');
}
