/**
 * AI 决策模块 —— 只根据「当前可见的经营快照」产出明确的行动建议。
 *
 * 不修改任何状态、不调用财务接口、不预测未来结果；同一快照必然得到同一组建议。
 * 应用层负责把这些建议翻译成真正的经营命令。
 */

import type { EnterpriseStatus } from '../enterprise';

export interface AiProductSnapshot {
  readonly id: string;
  readonly onSale: boolean;
  /** 当前售价下的日毛利估算（分/日），为负数说明在亏损销售。 */
  readonly dailyProfitCents: number;
  readonly generation: number;
}

export interface AiSnapshot {
  readonly cash: number;
  readonly payables: number;
  readonly techLevel: number;
  readonly hasProject: boolean;
  readonly pendingProductCount: number;
  readonly products: readonly AiProductSnapshot[];
  readonly status: EnterpriseStatus;
  /** 已处于资金危机的游戏日数；不在危机中为 0。 */
  readonly crisisDays: number;
  /** 本年度是否已经发布过产品。 */
  readonly publishBlocked: boolean;
}

export type AiAction =
  | { readonly kind: 'start-research'; readonly days: number; readonly budgetCents: number }
  | { readonly kind: 'release-product' }
  | { readonly kind: 'stop-selling'; readonly productId: string }
  | { readonly kind: 'set-marketing'; readonly productId: string; readonly dailyCents: number }
  | { readonly kind: 'liquidate'; readonly reason: string };

export interface AiPolicyConfig {
  readonly researchDayOptions: readonly number[];
  readonly researchBudgetCents: number;
  readonly marketingDailyCents: number;
  readonly strategy: 'aggressive' | 'steady' | 'frugal';
  /** 危机容忍天数，超过则清算。 */
  readonly crisisGraceDays: number;
}

/** 研发预算占现金的比例上限，避免 AI 一次把现金花光。 */
const BUDGET_SHARE: Record<AiPolicyConfig['strategy'], number> = {
  aggressive: 0.35,
  steady: 0.25,
  frugal: 0.15,
};

/** 启动研发前必须保留的现金（覆盖约两个月应付与运营）。 */
function reserveOf(config: AiPolicyConfig): number {
  return config.strategy === 'aggressive' ? 600_000 : config.strategy === 'steady' ? 800_000 : 400_000;
}

export function decide(snapshot: AiSnapshot, config: AiPolicyConfig): AiAction[] {
  const actions: AiAction[] = [];

  // 1. 危机：先止血，忍无可忍再清算
  if (snapshot.status === 'crisis') {
    if (snapshot.crisisDays >= config.crisisGraceDays) {
      actions.push({ kind: 'liquidate', reason: '长期资金危机，无力清偿' });
      return actions;
    }
    for (const product of snapshot.products) {
      if (product.onSale && product.dailyProfitCents < 0) {
        actions.push({ kind: 'stop-selling', productId: product.id });
      }
    }
    return actions;
  }

  if (snapshot.status === 'closed') return actions;

  // 2. 现金紧张：停售亏损产品、压低营销
  const tight = snapshot.cash < snapshot.payables * 2 + reserveOf(config);
  if (tight) {
    for (const product of snapshot.products) {
      if (!product.onSale) continue;
      if (product.dailyProfitCents < 0) {
        actions.push({ kind: 'stop-selling', productId: product.id });
      } else {
        actions.push({
          kind: 'set-marketing',
          productId: product.id,
          dailyCents: Math.floor(config.marketingDailyCents / 2),
        });
      }
    }
  }

  // 3. 有完成品就上市（每年一款的限制由应用层校验）
  if (snapshot.pendingProductCount > 0 && !snapshot.publishBlocked) {
    actions.push({ kind: 'release-product' });
  }

  // 4. 有余力就研发，研发时长从配置候选中取第一个买得起的
  if (!snapshot.hasProject && snapshot.pendingProductCount === 0 && !tight) {
    const cap = Math.max(0, Math.floor(snapshot.cash * BUDGET_SHARE[config.strategy]));
    for (const days of config.researchDayOptions) {
      const budget = Math.min(config.researchBudgetCents, cap);
      if (budget >= 50_000) {
        actions.push({ kind: 'start-research', days, budgetCents: budget });
        break;
      }
    }
  }

  return actions;
}
