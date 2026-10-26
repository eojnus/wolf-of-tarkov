/**
 * 城市政府模块 —— 机构、职位、人物、任职记录与当前生效政策。
 *
 * 与 features/governance（公司股东表决与 CEO 任免）完全是两套系统，不得混用。
 *
 * 表达方式：
 *  - 机构与职位是静态配置（名称、头衔），不单独存成可变实体；
 *  - 「人物」以 office holder 快照表达（当前只有过渡负责人或当选人）；
 *  - 任职记录（terms）按时间顺序追加，记录每届负责人、起止时间、方向与**政策效果快照**；
 *  - `offices` 是可扩展的职位/部门数据表达：本轮只有真实存在的一个最高行政职位，
 *    不建空壳部门。
 *
 * 政策口径（唯一生效来源）：
 *  - 每个真实任期在形成时把 `direction` 与该方向的效果快照写进任职记录；
 *  - 当前生效效果只读 `currentHolder.effects`（与 `terms` 中在任记录一致），
 *    切换任期时整体替换，不累乘、不叠加；
 *  - 连任同一候选人只再写一份同样的快照，企业基础数据不会被乘两次；
 *  - 已立项研发使用立项时的倍率快照，属于 technology 的既有字段，本模块不参与。
 *
 * 本模块不直接修改企业、市场、人口或财务的任何内部字段。
 */

import { BRANDING } from '../../content/config';
import {
  NEUTRAL_POLICY_EFFECTS,
  POLICY_EFFECTS,
  POLICY_LABELS,
  candidateConfig,
  type CandidateId,
  type GovernmentPolicyEffects,
  type PolicyId,
} from '../../content/government';
import type { DeepReadonly } from '../../core/readonly';

/** 机构正式名称（显示单一来源）。 */
export const GOVERNMENT_INSTITUTION = `${BRANDING.cityStem}管理式民主政府`;

/** 首版唯一的最高行政职位。 */
export const GOVERNMENT_OFFICE_TITLE = '首席行政负责人';

/** 过渡负责人的固定人物标识：不享有任何候选人产业政策。 */
export const CARETAKER_PERSON_ID = 'caretaker';

/**
 * 政府切片结构版本：写入每届任职记录，配置改版后可以识别旧任期快照。
 */
export const GOVERNMENT_CONFIG_VERSION = 1;

/**
 * 唯一最高行政职位的稳定 id（`offices` 数据表达用，不随界面改名）。
 * 与旧档迁移写入的 id 保持一致，读档不得重排或换 id。
 */
export const GOVERNMENT_OFFICE_ID = 'chief-executive';

/** 一层任职记录的来源：真实选举 / 开局过渡 / 旧档接入。 */
export type GovernmentTermSource = 'election' | 'caretaker' | 'migration';

/** 一届任职记录。 */
export interface GovernmentTermRecord {
  /** 记录 id：term-<序号>，随存档稳定。 */
  readonly id: string;
  /** 人物标识：候选人 id 或 caretaker。 */
  readonly personId: string;
  /** 显示名。 */
  readonly name: string;
  /** 任职开始时刻（游戏分钟）。 */
  readonly startMinute: number;
  /** 任职结束时刻；仍在任为 null。 */
  endMinute: number | null;
  /** 当届生效政策；过渡负责人为 null。 */
  readonly policy: PolicyId | null;
  /** 备注（当选 / 过渡 / 零票留任等）。 */
  readonly note: string;
  /** 本任期方向（候选人 A/B/C）；过渡负责人与接入前任期为 null。 */
  readonly direction: CandidateId | null;
  /** 本任期政策效果快照（唯一生效来源，切换任期时整体替换，不累乘）。 */
  readonly effects: GovernmentPolicyEffects;
  /** 生成快照时的配置版本（配置改版后可识别旧任期）。 */
  readonly configVersion: number;
  /** 任期来源：选举产生 / 开局过渡 / 旧档接入。 */
  readonly source: GovernmentTermSource;
}

export interface GovernmentState {
  /** 机构正式名称快照（读档展示用，不再从旧档文本改写）。 */
  readonly institution: string;
  /** 当前在任负责人快照；无合法状态时为 null（由校验器拒绝，不静默补人）。 */
  currentHolder: {
    personId: string;
    name: string;
    /** 当选候选人的政策；过渡负责人为 null。 */
    policy: PolicyId | null;
    candidateId: CandidateId | null;
    sinceMinute: number;
    /** 当前真实任期 id（与 terms 中 endMinute === null 的记录一致）。 */
    termId: string;
    /** 当前真实任期方向；过渡负责人与接入前任期为 null。 */
    readonly direction: CandidateId | null;
    /** 当前真实任期的政策效果快照（唯一生效来源）。 */
    readonly effects: GovernmentPolicyEffects;
  } | null;
  /** 任职记录（按时间追加，有限长度）。 */
  terms: GovernmentTermRecord[];
  /** 下一个记录序号。 */
  nextTermSeq: number;
  /** 可扩展的职位数据表达：本轮只有真实存在的一个最高行政职位。 */
  offices: Array<{
    readonly id: string;
    readonly title: string;
    readonly holderPersonId: string | null;
  }>;
}

const MAX_TERMS = 24;

/** 当前政策对应的效果快照：无政策时为中性 1/1/1。 */
export function policyEffectsFor(policy: PolicyId | null): GovernmentPolicyEffects {
  if (policy === null) return NEUTRAL_POLICY_EFFECTS;
  // 显式放宽为可空局部量：损坏存档里的非法政策 id 回退中性，而不是靠调用方猜测。
  const effects: GovernmentPolicyEffects | undefined = POLICY_EFFECTS[policy];
  return effects ?? NEUTRAL_POLICY_EFFECTS;
}

function appendTerm(
  state: GovernmentState,
  input: {
    personId: string;
    name: string;
    policy: PolicyId | null;
    direction: CandidateId | null;
    effects: GovernmentPolicyEffects;
    source: GovernmentTermSource;
    startMinute: number;
    note: string;
  },
): GovernmentTermRecord {
  const record: GovernmentTermRecord = {
    id: `term-${state.nextTermSeq}`,
    personId: input.personId,
    name: input.name,
    startMinute: input.startMinute,
    endMinute: null,
    policy: input.policy,
    note: input.note,
    direction: input.direction,
    effects: input.effects,
    configVersion: GOVERNMENT_CONFIG_VERSION,
    source: input.source,
  };
  state.nextTermSeq += 1;
  state.terms.push(record);
  if (state.terms.length > MAX_TERMS) {
    state.terms.splice(0, state.terms.length - MAX_TERMS);
  }
  return record;
}

export function createGovernmentState(nowMinute: number): GovernmentState {
  const state: GovernmentState = {
    institution: GOVERNMENT_INSTITUTION,
    currentHolder: null,
    terms: [],
    nextTermSeq: 1,
    offices: [
      { id: GOVERNMENT_OFFICE_ID, title: GOVERNMENT_OFFICE_TITLE, holderPersonId: null },
    ],
  };
  // 开局过渡负责人：方向与政策效果都是中性，不享有任何候选人的产业政策。
  const term = appendTerm(state, {
    personId: CARETAKER_PERSON_ID,
    name: '中性过渡负责人',
    policy: null,
    direction: null,
    effects: NEUTRAL_POLICY_EFFECTS,
    source: 'caretaker',
    startMinute: nowMinute,
    note: '开局过渡：不享有任何候选人的产业政策，也不获得现任竞选加分',
  });
  state.currentHolder = {
    personId: term.personId,
    name: term.name,
    policy: null,
    candidateId: null,
    sinceMinute: nowMinute,
    termId: term.id,
    direction: null,
    effects: NEUTRAL_POLICY_EFFECTS,
  };
  const office = state.offices[0];
  if (office) {
    state.offices[0] = { id: office.id, title: office.title, holderPersonId: term.personId };
  }
  return state;
}

/**
 * 任命新负责人（真实选举产生）。
 *
 * 关闭上一届记录、写入新一届（含方向与效果快照），当前生效效果整体替换；
 * 连任同一候选人只写一份相同快照，不叠加任何倍率。
 */
export function appointGovernmentLeader(
  state: GovernmentState,
  input: {
    candidateId: CandidateId | null;
    personName: string;
    atMinute: number;
    note: string;
  },
): GovernmentTermRecord {
  const current = state.terms[state.terms.length - 1];
  if (current && current.endMinute === null) current.endMinute = input.atMinute;

  const policy = input.candidateId === null ? null : candidateConfig(input.candidateId).policy;
  const direction = input.candidateId;
  const effects = policyEffectsFor(policy);
  const record = appendTerm(state, {
    personId: direction ?? CARETAKER_PERSON_ID,
    name: input.personName,
    policy,
    direction,
    effects,
    source: 'election',
    startMinute: input.atMinute,
    note: input.note,
  });
  state.currentHolder = {
    personId: record.personId,
    name: record.name,
    policy,
    candidateId: direction,
    sinceMinute: input.atMinute,
    termId: record.id,
    direction,
    effects,
  };
  const office = state.offices[0];
  if (office) {
    state.offices[0] = { id: office.id, title: office.title, holderPersonId: record.personId };
  }
  return record;
}

/**
 * 旧档接入：把当前在任记录标记为 migration 来源。
 *
 * - 不更换负责人、不补写历史、不补做建设判断；
 * - 方向与效果按调用方给出的现有效果快照写入（旧档没有快照时用中性或按现有政策重建）；
 * - 幂等：重复接入只是再次写入同一组值，不新增任期记录。
 */
export function adoptLegacyTerm(
  state: GovernmentState,
  input: {
    direction: CandidateId | null;
    effects: GovernmentPolicyEffects;
    note: string;
  },
): void {
  const holder = state.currentHolder;
  if (!holder) return;
  let index = -1;
  for (let cursor = state.terms.length - 1; cursor >= 0; cursor -= 1) {
    if (state.terms[cursor]?.endMinute === null) {
      index = cursor;
      break;
    }
  }
  // 没有在任记录属于损坏存档（校验器会拒绝）；这里只做无副作用返回，不补造历史。
  if (index < 0) return;
  const inOffice = state.terms[index];
  if (!inOffice) return;
  const adopted: GovernmentTermRecord = {
    ...inOffice,
    direction: input.direction,
    effects: input.effects,
    configVersion: GOVERNMENT_CONFIG_VERSION,
    source: 'migration',
    note: input.note,
  };
  state.terms[index] = adopted;
  state.currentHolder = {
    personId: inOffice.personId,
    name: inOffice.name,
    policy: inOffice.policy,
    // 接入前任期沿用旧档的负责人身份：方向为 null 时就是过渡负责人，
    // 不凭空补造候选人身份。
    candidateId: input.direction,
    sinceMinute: inOffice.startMinute,
    termId: adopted.id,
    direction: input.direction,
    effects: input.effects,
  };
}

/** 当前生效政策（过渡负责人为 null = 无政策）。 */
export function activePolicyOf(
  state: GovernmentState | DeepReadonly<GovernmentState>,
): PolicyId | null {
  return state.currentHolder?.policy ?? null;
}

/**
 * 当前政策效果：只读 `currentHolder.effects` 快照，缺失时回退中性 1/1/1。
 *
 * 这是唯一的政策效果口径。快照在任期形成时整体写入，切换任期时整体替换，
 * 因此连任、重复读档或连续换届都不会把倍率累乘到企业基础数据上。
 */
export function currentPolicyEffects(
  state: GovernmentState | DeepReadonly<GovernmentState>,
): GovernmentPolicyEffects {
  const effects = state.currentHolder?.effects;
  return effects ?? NEUTRAL_POLICY_EFFECTS;
}

/** 当前负责人视图（只读）。 */
export function currentHolderOf(
  state: GovernmentState | DeepReadonly<GovernmentState>,
): DeepReadonly<NonNullable<GovernmentState['currentHolder']>> | null {
  return state.currentHolder;
}

/** 现任是否是某位候选人（过渡负责人不算现任候选人）。 */
export function isIncumbentCandidate(
  state: GovernmentState | DeepReadonly<GovernmentState>,
  candidateId: CandidateId,
): boolean {
  return state.currentHolder?.candidateId === candidateId;
}

/** 政策说明文案（界面用）。 */
export function policyLabelOf(policy: PolicyId | null): string {
  return policy ? POLICY_LABELS[policy] : '无（过渡负责人不执行任何产业政策）';
}

/** 当前在任记录（按 `currentHolder.termId` 查；缺失时为 null）。 */
export function activeTermOf(
  state: GovernmentState | DeepReadonly<GovernmentState>,
): DeepReadonly<GovernmentTermRecord> | null {
  const termId = state.currentHolder?.termId;
  if (!termId) return null;
  const terms: readonly DeepReadonly<GovernmentTermRecord>[] = state.terms;
  for (const term of terms) {
    if (term.id === termId) return term;
  }
  return null;
}
