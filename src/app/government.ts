/**
 * 政府命令 —— 玩家在城市政府面板上的可执行操作（当前只有竞选赞助）。
 *
 * 约束：
 *  - 只用个人存款支付，不动用企业资金或贷款；
 *  - 扣款、流水、赞助单据与竞选资源在**同一次**状态提交内完成；
 *  - 同一 requestId 重试不会再次扣款（幂等由选举切片的单据 + 资金流水双重保证）；
 *  - 截止时刻前才可赞助：atMinute >= deadline 一律拒绝；
 *  - 不在命令里重复实现支持率公式。
 */

import { dateAtMinute } from '../core/calendar';
import { BusinessError, describeError } from '../core/errors';
import { formatMoney } from '../core/money';
import { GameStore } from '../core/store';
import { TIME } from '../content/config';
import { candidateConfig, type CandidateId } from '../content/government';
import { externalAccount, PERSONAL_SAVINGS, transferFunds } from '../features/finance';
import { recordSponsorship, useCampaignResources } from '../features/elections';
import type { GameState } from './state';

export type GovernmentNotifyKind = 'info' | 'success' | 'error';

export interface GovernmentHooks {
  notify(kind: GovernmentNotifyKind, message: string): void;
  requestAutoSave(): void;
}

export interface GovernmentCommandOutcome {
  readonly ok: boolean;
  readonly message: string | null;
}

/** 竞选机构作为外部对手方：竞选资源是业务额度，不是第二份现金账户。 */
const CAMPAIGN_ACCOUNT = externalAccount('campaign');

export class GovernmentCommands {
  constructor(
    private readonly store: GameStore<GameState>,
    private readonly hooks: GovernmentHooks,
  ) {}

  /**
   * 赞助一位候选人。
   *
   * `requestId` 由界面生成并复用（同一笔赞助的重试必须用同一个 id），
   * 业务层据此保证不重复扣款。
   */
  sponsor(
    candidateId: CandidateId,
    amountCents: number,
    requestId: string,
  ): GovernmentCommandOutcome {
    try {
      const message = this.store.run((draft) => {
        const elections = draft.elections;
        if (!requestId) {
          throw new BusinessError('MISSING_OPERATION_ID', '赞助请求缺少唯一标识');
        }
        // 幂等：同一请求已入账时直接返回原结果，不再次扣款
        const existing = elections.sponsorshipRecords.find(
          (record) => record.requestId === requestId,
        );
        if (existing) {
          if (existing.candidateId !== candidateId || existing.amountCents !== amountCents) {
            throw new BusinessError(
              'SPONSOR_REQUEST_MISMATCH',
              '同一操作 id 已用于另一笔赞助，不能改写已入账的单据',
            );
          }
          return `该笔赞助已入账（${candidateConfig(candidateId).name} ${formatMoney(
            existing.amountCents,
          )}），未重复扣款`;
        }
        if (elections.phase !== 'campaign') {
          throw new BusinessError('NO_ACTIVE_CAMPAIGN', '当前没有进行中的竞选');
        }
        const nowMinute = draft.clock.totalMinute;
        if (nowMinute >= elections.deadlineMinute) {
          throw new BusinessError('CAMPAIGN_CLOSED', '投票已截止，不能再赞助');
        }
        if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
          throw new BusinessError('INVALID_AMOUNT', '赞助金额必须是正整数（分）');
        }
        if (draft.finance.accounts.savings < amountCents) {
          throw new BusinessError('INSUFFICIENT_SAVINGS', '银行存款不足，无法赞助');
        }
        const monthKey = dateAtMinute(nowMinute, TIME.calendar).monthKey;
        // 先在草稿上解析候选人（非法 id 在扣款前就失败），再结算资源
        const candidate = candidateConfig(candidateId);

        // 到账前先按**旧资源**结清到现在：新赞助只能用于 atMinute 之后的区间，
        // 不能被下一次日结追溯用于赞助到账之前的整段时间。
        useCampaignResources(elections, nowMinute, TIME.calendar.minutesPerDay);

        // 资金：个人存款 → 竞选机构（外部对手方）
        transferFunds(draft.finance, {
          atMinute: nowMinute,
          monthKey,
          operationId: `election-sponsorship:${requestId}`,
          from: PERSONAL_SAVINGS,
          to: CAMPAIGN_ACCOUNT,
          amount: amountCents,
          category: 'election-sponsorship',
          memo: `竞选赞助：${candidate.name}`,
        });

        // 竞选资源与赞助单据：同一次提交内落账
        recordSponsorship(elections, {
          requestId,
          candidateId,
          amountCents,
          atMinute: nowMinute,
          monthKey,
        });

        const remainingDays = Math.max(
          0,
          Math.ceil((elections.deadlineMinute - nowMinute) / TIME.calendar.minutesPerDay),
        );
        return `已赞助 ${candidate.name} ${formatMoney(amountCents)}（不可退款，届末未使用资源失效；` +
          `剩余约 ${remainingDays} 天可用于竞选宣传）`;
      });
      this.hooks.notify('success', message);
      this.hooks.requestAutoSave();
      return { ok: true, message };
    } catch (error) {
      const message = describeError(error);
      this.hooks.notify('error', message);
      return { ok: false, message };
    }
  }
}
