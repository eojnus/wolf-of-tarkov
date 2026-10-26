/**
 * 存档入口 —— 槽位读写、快照构建、导入导出与读档流程编排。
 *
 * 具体职责已经分开：
 *  - `save-types`：公共类型；
 *  - `save-database`：IndexedDB 原始读写（不懂玩法）；
 *  - `save-migrations`：v1 → v15 迁移链与受控旧数据修复；
 *  - `save-validation`：字段与跨切片一致性校验。
 *
 * 本文件只做编排：读原始数据 → 迁移 → 校验 → 返回快照；写快照 → 先备份上一份。
 * 读档失败绝不替换当前有效游戏（回退上一份有效快照，仍失败则明确报错）。
 */

import { BRANDING, SAVE } from '../content/config';
import { getRaw, putRaw, deleteRaw, slotKey } from './save-database';
import { migrateIfNeeded, normalizeLoadedState } from './save-migrations';
import { assertObject, assertString, fail, validateSaveState } from './save-validation';
import type {
  LoadResult,
  PersistedState,
  SaveReason,
  SaveSlot,
  SaveSnapshot,
} from './save-types';

export type { LoadResult, PersistedState, SaveReason, SaveSlot, SaveSnapshot, WorldSaveData } from './save-types';

export async function writeSnapshot(slot: SaveSlot, snapshot: SaveSnapshot): Promise<void> {
  const key = slotKey(slot);
  const existing = await getRaw(key);
  if (existing !== null && existing !== undefined) {
    await putRaw(slotKey(`${slot}-prev`), existing);
  }
  await putRaw(key, snapshot);
}

/** 读取槽位：优先当前快照，损坏时回退上一份。 */
export async function readSnapshot(slot: SaveSlot): Promise<LoadResult> {
  const primary = await getRaw(slotKey(slot));
  if (primary === null || primary === undefined) {
    return { ok: false, reason: '没有找到存档' };
  }
  try {
    return { ok: true, snapshot: parseSnapshot(primary), usedBackup: false, warning: null };
  } catch (error) {
    const primaryReason = error instanceof Error ? error.message : '存档损坏';
    const backup = await getRaw(slotKey(`${slot}-prev`));
    if (backup === null || backup === undefined) {
      return { ok: false, reason: `存档已损坏：${primaryReason}` };
    }
    try {
      return {
        ok: true,
        snapshot: parseSnapshot(backup),
        usedBackup: true,
        warning: `当前存档损坏（${primaryReason}），已回退到上一份有效快照`,
      };
    } catch (backupError) {
      const backupReason = backupError instanceof Error ? backupError.message : '备份存档也损坏';
      return { ok: false, reason: `存档与备份均不可用：${primaryReason} / ${backupReason}` };
    }
  }
}

export async function hasSnapshot(slot: SaveSlot): Promise<boolean> {
  const raw = await getRaw(slotKey(slot));
  return raw !== null && raw !== undefined;
}

export async function clearSlot(slot: SaveSlot): Promise<void> {
  await deleteRaw(slotKey(slot));
  await deleteRaw(slotKey(`${slot}-prev`));
}

export function buildSnapshot(state: PersistedState, reason: SaveReason): SaveSnapshot {
  return {
    format: SAVE.formatTag,
    version: SAVE.formatVersion,
    savedAt: new Date().toISOString(),
    reason,
    state,
  };
}

export function parseSnapshot(raw: unknown): SaveSnapshot {
  const root = assertObject(raw, '存档');
  if (root.format !== SAVE.formatTag) fail('这不是本游戏的存档文件');
  const version = root.version;
  if (typeof version !== 'number' || !Number.isInteger(version)) fail('存档版本号缺失');
  const { state: migratedState, migratedFrom } = migrateIfNeeded(root, version);
  // 读档后的兼容规范化（速度镜像对齐）必须先于校验，且不改动任何玩法数据
  if (migratedState && typeof migratedState === 'object') {
    normalizeLoadedState(migratedState as Record<string, unknown>);
  }
  assertString(root.savedAt, 'savedAt');
  const reason = root.reason;
  if (reason !== 'manual' && reason !== 'auto' && reason !== 'import') {
    fail('存档来源标记非法');
  }

  const state = validateSaveState(migratedState);
  return {
    format: SAVE.formatTag,
    version: SAVE.formatVersion,
    savedAt: String(root.savedAt),
    reason,
    ...(migratedFrom !== null ? { migratedFrom } : {}),
    state: state as unknown as PersistedState,
  };
}

/* --------------------------------------------------------- 导入 / 导出 */

export function serializeSnapshot(snapshot: SaveSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export function downloadSnapshot(snapshot: SaveSnapshot, fileName?: string): void {
  const blob = new Blob([serializeSnapshot(snapshot)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download =
    fileName ?? `${BRANDING.gameTitle}-存档-${snapshot.savedAt.replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
