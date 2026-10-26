/**
 * 政策适配 —— 唯一「当前生效政策」的读取口径。
 *
 * 本轮起改为读取**当前真实任期**的效果快照（`government.currentHolder.effects`）：
 *  - 快照在任期形成时整体写入，切换任期时整体替换，不累乘、不叠加；
 *  - 连任同一候选人只再写一份同样的快照，企业基础数据不会被乘两次；
 *  - 过渡负责人与接入前任期使用中性倍率 1/1/1；
 *  - 旧任期效果被整体替换，不会以任何方式累加到新任期的企业基础数据上
 *    （已立项研发按立项时的倍率快照继续，那是 technology 的既有字段）。
 *
 * 业务模块（经营结算、研发立项、界面展示）不直接读政府切片，
 * 由应用层把政策效果作为**显式输入**交给它们：
 *  - 研发增长倍率只作用于「研发增量部分」（见 features/technology）；
 *  - 运营成本倍率只作用于既有固定运营费用；
 *  - 销售成本倍率只作用于生效区间内新发生的销售成本。
 */

import type { GovernmentPolicyEffects } from '../content/government';
import { currentPolicyEffects } from '../features/government';
import type { ReadonlyGameState } from './state';

export function activePolicyEffects(state: ReadonlyGameState): GovernmentPolicyEffects {
  return currentPolicyEffects(state.government);
}
