/**
 * 玩家居住与月度应缴 —— 月度结算与界面共用的唯一报价口径。
 *
 * 免租必须在**报价**环节生效：月结与界面读同一个函数，
 * 不用事后返款、不用直接改余额，也不在界面写死「已免租」。
 */

import { quoteMonth, type MonthCharge } from '../features/living';
import { freeResidenceOf } from '../features/real-estate';
import type { GameState, ReadonlyGameState } from './state';

/** 玩家是否拥有永久免费居住权（晴川公寓 001 室，非玩家产权但归玩家永久居住）。 */
export function playerHasFreeResidence(state: GameState | ReadonlyGameState): boolean {
  return freeResidenceOf(state.realEstate) !== null;
}

/** 每月应缴：有永久居住权时房租为 0，基本生活费照常。 */
export function monthChargeOf(state: GameState | ReadonlyGameState): MonthCharge {
  return quoteMonth({ rentExempt: playerHasFreeResidence(state) });
}
