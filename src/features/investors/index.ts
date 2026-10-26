/**
 * 机构投资者 —— 有真实资金、有偏好、有单笔上限的有限投资者。
 *
 * 这里只做「谁愿意投多少、按什么估值投」的判断；
 * 资金在 finance 的投资者账户里，持股在 equity 的股权簿里，
 * 本模块不持有余额、不写流水、不发股份。
 */

import { FINANCING_RULES, INVESTORS, findInvestor, type InvestorConfig } from '../../content/capital';

export type { InvestorConfig };

export function investorProfiles(): readonly InvestorConfig[] {
  return INVESTORS;
}

export function investorName(id: string): string {
  return findInvestor(id)?.name ?? id;
}

/** 投资者资金账户在 finance 中的 id。 */
export function investorAccountId(investorId: string): string {
  return investorId;
}

/** 股权簿里属于投资者的 holderId。 */
export function investorHolderId(investorId: string): string {
  return `inv:${investorId}`;
}

export function isInvestorHolder(holderId: string): boolean {
  return holderId.startsWith('inv:');
}

export function investorIdOfHolder(holderId: string): string | null {
  return isInvestorHolder(holderId) ? holderId.slice(4) : null;
}

export interface WillingnessInput {
  /** 融资前估值（分），由 app 层用统一的估值口径算好传入。 */
  readonly preMoneyCents: number;
  readonly requestedCents: number;
  /** 该投资者当前可用资金（已扣除预留）。 */
  readonly availableCents: number;
  /** 公司是否已经有在售产品（保守型机构不投纯概念阶段）。 */
  readonly hasRevenueProduct: boolean;
}

export interface Willingness {
  readonly amountCents: number;
  readonly valuationPremium: number;
}

/**
 * 单个投资者的出价意愿。确定性计算：同一份状态永远得到同一组报价，
 * 不做随机重抽，因此打开界面 / 读档 / 反复点击都不会改变条件。
 */
export function willingnessOf(
  investor: InvestorConfig,
  input: WillingnessInput,
): Willingness | null {
  if (input.preMoneyCents <= 0) return null;
  // 保守型机构不投还没有产品收入的公司
  if (!input.hasRevenueProduct && investor.risk < 0.35) return null;

  const capacity = Math.min(investor.maxTicketCents, input.availableCents);
  if (capacity < FINANCING_RULES.minQuoteCents) return null;

  const target = Math.round(input.requestedCents * investor.appetite);
  const amount = Math.min(capacity, Math.max(FINANCING_RULES.minQuoteCents, target));
  if (amount <= 0) return null;

  return { amountCents: amount, valuationPremium: investor.valuationPremium };
}
