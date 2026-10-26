/**
 * 存档公共类型 —— 槽位、快照、持久状态与世界存档。
 *
 * 纯类型模块：不导入数据库、迁移或校验实现，也不产生运行时依赖。
 */

import { type GameState } from '../app/state';

export type SaveSlot = 'auto' | 'manual';
export type SaveReason = 'manual' | 'auto' | 'import';

export interface SaveSnapshot {
  readonly format: string;
  readonly version: number;
  /** ISO 时间字符串。 */
  readonly savedAt: string;
  readonly reason: SaveReason;
  /** 若由旧版本迁移而来，记录原始版本号；不写回存档。 */
  readonly migratedFrom?: number;
  readonly state: PersistedState;
}

/** 存档中的状态：游戏状态 + 世界位置。 */
export interface PersistedState extends GameState {
  world: WorldSaveData;
}

export interface WorldSaveData {
  readonly player: { readonly x: number; readonly z: number; readonly facing: number };
  /** 摄像机环绕角度与距离（可选；旧档缺失时用默认值）。 */
  readonly camera?: { readonly yaw: number; readonly pitch: number; readonly distance: number };
  /** 世界状态版本，便于以后扩展。 */
  readonly revision: number;
}

/** 读档结果：成功时带回快照与是否用了备份，失败时给出明确原因。 */
export type LoadResult =
  | {
      readonly ok: true;
      readonly snapshot: SaveSnapshot;
      readonly usedBackup: boolean;
      readonly warning: string | null;
    }
  | { readonly ok: false; readonly reason: string };
