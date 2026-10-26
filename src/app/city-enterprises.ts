/**
 * 城市新区招商 —— 运行时创建**真实**的科技 AI 企业。
 *
 * 严格边界：
 *  - 只走正常业务路径：真实出资划转、真实股权簿、真实科技状态与 AI 记忆；
 *  - **禁止**调用 `seedBusinessWorld` / `seedListedCompanyCapital`（那是开局历史初始化路径，
 *    会带入赠予资金、种子产品或历史上市状态）；
 *  - 不赠送已上市产品、不创建证券、不凭空发钱；
 *  - 资金不足时保留「待招商」，只在既有游戏日节点重试；
 *  - 招商成功后永久标记，读档不会重复创建；
 *  - 全部写入在同一次 `GameStore` 草稿提交内完成，失败不得留半家公司。
 */

import { dateAtMinute } from '../core/calendar';
import { INVESTORS } from '../content/capital';
import { CITY_DEVELOPMENT_RULES } from '../content/city-economy';
import { TIME } from '../content/config';
import { createEnterprise } from '../features/enterprise';
import { bookOfCompany, createCompanyBook } from '../features/equity';
import {
  availableSubjectBalance,
  businessAccountRef,
  openBusinessAccount,
  subjectRef,
  transferFunds,
} from '../features/finance';
import { investorAccountId } from '../features/investors';
import { bindBuildingCompany } from '../features/city-layout';
import { markEnterpriseCreated, noteEnterpriseAttempt } from '../features/city-development';
import { ensureTechCompany } from '../features/technology';
import { operationId } from './capital-operations';
import { nextPendingEnterpriseSlot } from './city-development';
import type { GameState } from './state';

/** 新区公司 id 前缀：与玩家公司 `player-*`、开局 AI 公司 id 分开，便于溯源。 */
export const CITY_ENTERPRISE_ID_PREFIX = 'city-';

/** 新区公司显示名：不含城市专有名词字面量，避免与 BRANDING 单一来源冲突。 */
function enterpriseNameOf(seq: number): string {
  return `新区科技 ${String(seq).padStart(2, '0')}`;
}

/**
 * 尝试为一个待招商槽位创建真实 AI 企业。
 *
 * 返回是否真的创建成功。资金不足时保留 pending 并记录本次尝试时刻，
 * 由 `nextPendingEnterpriseSlot` 按配置的游戏日间隔节流重试。
 */
export function tryCreateCityEnterprise(draft: GameState, nowMinute: number): boolean {
  const slot = nextPendingEnterpriseSlot(draft, nowMinute);
  if (!slot) return false;

  const companyId = `${CITY_ENTERPRISE_ID_PREFIX}${slot.districtId}`;
  // 幂等兜底：公司已经存在（例如读档前已创建）时只补标记，绝不重复创建或重复出资
  if (draft.enterprises.companies[companyId]) {
    markEnterpriseCreated(draft.cityDevelopment, slot.id, companyId, nowMinute);
    bindBuildingCompany(draft.cityLayout, slot.buildingId, companyId);
    return false;
  }

  const { targetFundingCents, initialTechLevel } = CITY_DEVELOPMENT_RULES.investment;

  // 只使用投资者**真实可用资金**（余额 − 全部有效预留），绝不侵占已承诺给融资报价的钱
  const investor = INVESTORS.find(
    (item) =>
      availableSubjectBalance(draft.finance, 'investor', investorAccountId(item.id)) >=
      targetFundingCents,
  );
  if (!investor) {
    // 资金不足：保留待招商，按既有游戏日节点重试，不凭空发钱
    noteEnterpriseAttempt(draft.cityDevelopment, slot.id, nowMinute);
    return false;
  }

  const investorId = investorAccountId(investor.id);
  const holderId = `inv:${investor.id}`;
  const now = dateAtMinute(nowMinute, TIME.calendar);
  const ctx = { atMinute: nowMinute, monthKey: now.monthKey };
  const seq =
    Object.keys(draft.enterprises.companies).filter((id) =>
      id.startsWith(CITY_ENTERPRISE_ID_PREFIX),
    ).length + 1;

  // 1) 企业身份
  const company = createEnterprise({
    id: companyId,
    role: 'ai',
    name: enterpriseNameOf(seq),
    nowMinute,
    monthKey: now.monthKey,
  });
  draft.enterprises.companies[companyId] = company;

  // 2) 科技状态：真实研发起点（不赠送产品）
  const tech = ensureTechCompany(draft.technology, companyId);
  tech.accumulation = initialTechLevel;

  // 3) 股权：股份归实际出资主体；做市商不获得任何无偿股份
  createCompanyBook(draft.equity, {
    companyId,
    securityId: `sec-${companyId}`,
    founderId: holderId,
    marketMakerId: 'market-maker',
    founderRatio: 1,
    sponsorRatio: 0,
    historyNote: '城市科技新区招商：由真实投资者出资创立，股份归实际出资主体，不赠送上市状态',
  });
  const book = bookOfCompany(draft.equity, companyId);
  if (book) book.ceoId = holderId;

  // 4) 账户与真实出资划转（投资者 → 企业账户，计入股权融资而非经营收入）
  openBusinessAccount(draft.finance, companyId, ctx);
  transferFunds(draft.finance, {
    ...ctx,
    operationId: operationId('city-enterprise'),
    from: subjectRef('investor', investorId),
    to: businessAccountRef(companyId),
    amount: targetFundingCents,
    category: 'equity-financing',
    memo: '科技新区招商出资',
  });

  // 5) AI 记忆：走与既有 AI 完全相同的经营决策路径
  draft.businessAi.companies[companyId] = { lastDecisionMinute: null, productSeq: 1 };

  // 6) 建筑业务引用 + 招商槽位永久标记
  bindBuildingCompany(draft.cityLayout, slot.buildingId, companyId);
  markEnterpriseCreated(draft.cityDevelopment, slot.id, companyId, nowMinute);
  return true;
}
