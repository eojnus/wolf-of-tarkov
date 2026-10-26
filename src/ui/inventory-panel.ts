/**
 * 背包栏目渲染 —— 接入现有人物管理界面的「背包」页。
 *
 * 只渲染 app/supplies-view 已经算好的行（数量、效果、实际恢复预览），
 * 不在这里重新计算恢复量，也不修改任何业务状态。
 * 使用按钮交由命令层（app/supplies.useItem）执行，界面仍会在提交时重新校验。
 */

import type { InventoryItemView, SurvivalStatusView } from '../app/supplies-view';
import { SURVIVAL } from '../content/survival';

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function survivalBar(label: string, valueText: string, percent: number, low: boolean, zero: boolean): string {
  const cls = zero ? ' zero' : low ? ' low' : '';
  return `
    <div class="survival-row">
      <span class="survival-label">${esc(label)}</span>
      <span class="survival-value num">${esc(valueText)}</span>
    </div>
    <div class="survival-bar"><i class="${cls.trim()}" style="width:${Math.max(0, Math.min(100, percent)).toFixed(1)}%"></i></div>`;
}

export function renderInventorySection(
  items: readonly InventoryItemView[],
  empty: boolean,
  survival: SurvivalStatusView,
): string {
  const rows = items
    .map(
      (item) => `
      <div class="pp-card inv-item">
        <div class="inv-item-head">
          <div>
            <div class="pp-card-title">${esc(item.name)}<span class="badge">${esc(item.categoryText)}</span></div>
            <div class="pp-hint">${esc(item.description)}</div>
          </div>
          <div class="inv-item-count num">× ${item.count}</div>
        </div>
        <div class="pp-rows">
          <div class="pp-row"><span>效果</span><span class="num">${esc(item.effectText)}</span></div>
          <div class="pp-row"><span>本次实际恢复</span><span class="num">${esc(item.restoreText)}</span></div>
        </div>
        <div class="actions">
          <button type="button" class="btn btn-sm btn-primary" data-action="inv-use" data-item="${esc(item.itemId)}"${item.canUse ? '' : ' disabled'}>使用 1 件</button>
          ${item.canUse ? '' : `<span class="pp-hint">${esc(item.disabledReason)}</span>`}
        </div>
      </div>`,
    )
    .join('');

  {
    return `<div class="pp-scroll">
      <div class="pp-card">
        <div class="pp-card-title">生存状态</div>
        <div class="pp-kpi-row">
          <div class="inv-kpi">
            ${survivalBar('饱食度', survival.hungerText, survival.hungerPercent, survival.lowHunger, survival.zeroHunger)}
          </div>
          <div class="inv-kpi">
            ${survivalBar('水分', survival.waterText, survival.waterPercent, survival.lowWater, survival.zeroWater)}
          </div>
          <div class="inv-kpi">
            <div class="pp-kpi-label">当前效果</div>
            <div class="pp-kpi-value">${esc(survival.efficiencyText)} · ${esc(survival.moveText)}</div>
            <div class="pp-kpi-note">${esc(survival.note)}</div>
          </div>
        </div>
        <div class="pp-hint">满值 ${SURVIVAL.maxPoints}；从满值降到 0 需 ${SURVIVAL.depletionMinutes / 60} 游戏小时。暂停或关闭游戏不会继续消耗，也不会离线恢复。</div>
      </div>
      <div class="pp-card">
        <div class="pp-card-title">背包</div>
        ${
          empty
            ? '<div class="pp-empty">背包是空的。到便利店购买面包、便当、矿泉水或运动饮料。</div>'
            : rows
        }
        <div class="pp-hint">不自动进食、不自动消耗；使用立即生效，不推进游戏时间，也不再次扣钱。同类物品堆叠，不限制格数。</div>
      </div>
    </div>`;
  }
}
