/**
 * 治理模块 —— 简化董事会：提案、表决与 CEO 任免。
 *
 * 首轮不创建董事人物、派系或忠诚度：
 * 股东按「一股一票」表决，库存股不投票，超过 50% 有效表决权才算通过（恰好 50% 不通过）。
 * 其他股东按公司经营状况与自身风险偏好投票，不会无条件支持玩家。
 *
 * 提案有两种来源：
 *  - `player`：玩家作为股东提出，默认投赞成，提交时立即结算；
 *  - `shareholder`：外部股东在固定节点提出，必须有明确的表决窗口；
 *    玩家的股份**不会**被自动算成赞成，未投票按弃权处理。
 *
 * 本模块只算票、记状态与改 CEO 字段，不碰资金、不碰经营、不碰界面。
 */

import type { DeepReadonly } from '../../core/readonly';
import { BusinessError } from '../../core/errors';
import { EQUITY_RULES, findInvestor } from '../../content/capital';
import { effectiveShares, isValidCeoIdentity, sharesOf, votingPower, type ShareBook } from '../equity';
import { investorIdOfHolder } from '../investors';

export type ProposalKind = 'appoint-ceo' | 'remove-ceo';
export type ProposalStatus = 'open' | 'passed' | 'rejected';
export type ProposalOrigin = 'player' | 'shareholder';
export type VoteChoice = 'yes' | 'no' | 'abstain';

export interface Proposal {
  readonly id: string;
  readonly companyId: string;
  readonly kind: ProposalKind;
  readonly targetHolderId: string;
  readonly proposedBy: string;
  readonly origin: ProposalOrigin;
  readonly createdAtMinute: number;
  /** 外部股东提案的表决截止时刻；玩家提案为 null（提交即结算）。 */
  deadlineMinute: number | null;
  /** 玩家在外部提案上的明确投票；null 表示尚未投票（结算时按弃权）。 */
  playerVote: VoteChoice | null;
  resolvedAtMinute: number | null;
  status: ProposalStatus;
  yesShares: number;
  noShares: number;
  abstainShares: number;
  /** 结果说明（谁支持、为什么没通过），直接用于界面。 */
  note: string;
}

export interface GovernanceState {
  proposals: Record<string, Proposal[]>;
  /** 每家公司上一次外部股东提案的时刻，用于冷却。 */
  lastExternalProposalMinute: Record<string, number | null>;
  nextSeq: number;
}

export function createGovernanceState(): GovernanceState {
  return { proposals: {}, lastExternalProposalMinute: {}, nextSeq: 1 };
}

export function proposalsOf(state: GovernanceState, companyId: string): Proposal[];
export function proposalsOf(
  state: DeepReadonly<GovernanceState>,
  companyId: string,
): readonly DeepReadonly<Proposal>[];
export function proposalsOf(
  state: GovernanceState | DeepReadonly<GovernanceState>,
  companyId: string,
): readonly (Proposal | DeepReadonly<Proposal>)[] {
  return state.proposals[companyId] ?? [];
}

/** 是否还有未决提案（首轮一家公司同时最多一个未决任免提案）。 */
export function openProposalOf(
  state: GovernanceState | DeepReadonly<GovernanceState>,
  companyId: string,
): Proposal | DeepReadonly<Proposal> | null {
  for (const proposal of proposalsOf(state, companyId)) {
    if (proposal.status === 'open') return proposal;
  }
  return null;
}

export function findProposal(
  state: GovernanceState,
  companyId: string,
  proposalId: string,
): Proposal | null {
  return proposalsOf(state, companyId).find((proposal) => proposal.id === proposalId) ?? null;
}

export function pushProposal(
  state: GovernanceState,
  input: {
    readonly companyId: string;
    readonly kind: ProposalKind;
    readonly targetHolderId: string;
    readonly proposedBy: string;
    readonly origin: ProposalOrigin;
    readonly nowMinute: number;
    readonly deadlineMinute: number | null;
  },
): Proposal {
  const proposal: Proposal = {
    id: `prop-${state.nextSeq}`,
    companyId: input.companyId,
    kind: input.kind,
    targetHolderId: input.targetHolderId,
    proposedBy: input.proposedBy,
    origin: input.origin,
    createdAtMinute: input.nowMinute,
    deadlineMinute: input.deadlineMinute,
    playerVote: null,
    resolvedAtMinute: null,
    status: 'open',
    yesShares: 0,
    noShares: 0,
    abstainShares: 0,
    note: '',
  };
  state.nextSeq += 1;
  const list = state.proposals[input.companyId] ?? [];
  list.push(proposal);
  if (list.length > 12) list.splice(0, list.length - 12);
  state.proposals[input.companyId] = list;
  if (input.origin === 'shareholder') {
    state.lastExternalProposalMinute[input.companyId] = input.nowMinute;
  }
  return proposal;
}

export interface VoteContext {
  /** 最近一个结算月是否盈利（没有月报时按当前累计判断）。 */
  readonly profitable: boolean;
  /** 是否还有未付应付。 */
  readonly payablesPressure: boolean;
  /** 有效科技水平，用于判断长期潜力。 */
  readonly techLevel: number;
}

/**
 * 单个机构股东的表决：支持玩家需要「公司赚钱且不欠钱」，
 * 高风险偏好的机构在技术潜力高时也愿意给机会；
 * 罢免现任 CEO 时，只要经营不佳就倾向于赞成。
 */
function votesYes(holderId: string, kind: ProposalKind, context: VoteContext): boolean | null {
  const investorId = investorIdOfHolder(holderId);
  if (investorId === null) return null; // 非机构股东（做市商）弃权
  const investor = findInvestor(investorId);
  if (!investor) return null;

  const healthy = context.profitable && !context.payablesPressure;
  if (kind === 'remove-ceo') return !healthy;
  // appoint-ceo：经营健康基本支持；技术潜力高的公司对激进机构有额外吸引力
  if (healthy) return true;
  return investor.risk >= 0.7 && context.techLevel >= 30;
}

/** 提案通过后由应用层落地的结果；`blocked` 表示票数通过但业务上不能生效。 */
export interface ResolutionOptions {
  /**
   * 票数通过后的落地检查：返回非空字符串表示拒绝生效（例如首轮最多管理一家公司），
   * 该说明会写进 proposal.note，状态记为未通过。
   */
  readonly allowEffect?: (proposal: Proposal) => string | null;
}

/**
 * 结算提案。
 *
 * 只有 `origin === 'player'` 的提案才默认把玩家持股算作赞成；
 * 外部股东提案必须等玩家显式投票（`playerVote`），未投票按弃权处理。
 * 通过条件：赞成股数 > 有效股份的 50%（恰好 50% 视为不通过）。
 */
export function resolveProposal(
  proposal: Proposal,
  book: ShareBook,
  context: VoteContext,
  nowMinute: number,
  options: ResolutionOptions = {},
): Proposal {
  if (proposal.status !== 'open') return proposal;

  let yes = 0;
  let no = 0;
  let abstain = 0;
  const playerShares = sharesOf(book, 'player');
  // 玩家本人的票：自己的提案默认赞成，外部提案只认明确投票
  const playerChoice: VoteChoice =
    proposal.origin === 'player' ? 'yes' : (proposal.playerVote ?? 'abstain');

  for (const [holderId, shares] of Object.entries(book.holdings)) {
    if (shares <= 0) continue;
    if (holderId === 'player') {
      if (playerChoice === 'yes') yes += shares;
      else if (playerChoice === 'no') no += shares;
      else abstain += shares;
      continue;
    }
    const decision = votesYes(holderId, proposal.kind, context);
    if (decision === null) abstain += shares;
    else if (decision) yes += shares;
    else no += shares;
  }

  const base = effectiveShares(book);
  const passed = base > 0 && yes * 2 > base;

  proposal.yesShares = yes;
  proposal.noShares = no;
  proposal.abstainShares = abstain;
  proposal.resolvedAtMinute = nowMinute;

  const playerNote =
    proposal.origin === 'player'
      ? ''
      : playerShares <= 0
        ? '；你已不是股东，持股按弃权处理'
        : playerChoice === 'abstain'
          ? '；你的持股按弃权处理'
          : '';

  if (!passed) {
    proposal.status = 'rejected';
    proposal.note = `赞成 ${(votingShare(yes, base) * 100).toFixed(1)}%，未超过半数，提案未通过${playerNote}`;
    return proposal;
  }

  const blocked = options.allowEffect?.(proposal) ?? null;
  if (blocked !== null) {
    proposal.status = 'rejected';
    proposal.note = `赞成 ${(votingShare(yes, base) * 100).toFixed(1)}%，但${blocked}`;
    return proposal;
  }

  proposal.status = 'passed';
  proposal.note = `赞成 ${(votingShare(yes, base) * 100).toFixed(1)}%，提案通过${playerNote}`;
  if (proposal.kind === 'appoint-ceo') book.ceoId = proposal.targetHolderId;
  else if (book.ceoId === proposal.targetHolderId) book.ceoId = null;
  return proposal;
}

function votingShare(shares: number, base: number): number {
  return base > 0 ? shares / base : 0;
}

/**
 * 提出 CEO 任免前的静态检查。
 *
 * 目标资格与提案人资格分开：
 *  - `appoint-ceo`：候选人必须是股东（首轮任命规则），且不能是现任；
 *  - `remove-ceo`：只要求目标确实是现任 CEO 且身份合法，**不要求其仍持股**——
 *    否则「卖光股份但仍在职」的 CEO 永远无法被股东手动罢免；
 *  - 提案人资格（必须是该公司股东）由应用层 `requireShareholderPosition` 校验，
 *    不在这里把两件事混成一条「目标必须持股」。
 */
export function assertProposalValid(
  book: ShareBook,
  kind: ProposalKind,
  targetHolderId: string,
): void {
  if (kind === 'appoint-ceo') {
    if (sharesOf(book, targetHolderId) <= 0) {
      throw new BusinessError('NOT_A_SHAREHOLDER', '只有股东才能被任命为 CEO');
    }
    if (book.ceoId === targetHolderId) {
      throw new BusinessError('ALREADY_CEO', '该股东已经是现任 CEO');
    }
    return;
  }

  if (book.ceoId === null) {
    throw new BusinessError('NO_CEO', '该公司目前没有 CEO');
  }
  if (book.ceoId !== targetHolderId) {
    throw new BusinessError('NOT_CEO', '该股东不是现任 CEO');
  }
  if (!isValidCeoIdentity(targetHolderId)) {
    throw new BusinessError('INVALID_CEO', '现任 CEO 的身份不合法，无法提出罢免');
  }
}

/** 首轮最多管理一家的限制：任命玩家为第二家公司的 CEO 必须明确拒绝。 */
export function assertManageLimit(alreadyManages: boolean): void {
  if (alreadyManages && EQUITY_RULES.maxManagedCompanies <= 1) {
    throw new BusinessError(
      'MANAGE_LIMIT',
      '首轮最多同时管理一家公司：你已经是另一家公司的 CEO，不能接任第二家',
    );
  }
}

/** 玩家是否还有股东权利（投票、提案）。卖光股份后只剩下交易与分红权。 */
export function hasShareholderRights(book: ShareBook, holderId = 'player'): boolean {
  return votingPower(book, holderId) > 0;
}
