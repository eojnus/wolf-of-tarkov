/**
 * 存档数据库 —— IndexedDB 打开与原始数据读写、删除。
 *
 * 只认识「键 → 可序列化值」，不理解企业、证券、资金或任何玩法规则；
 * 也不做校验与迁移：那是 save-validation / save-migrations 的职责。
 */

import { SAVE } from '../content/config';
import { BusinessError } from '../core/errors';
import { type SaveSlot } from './save-types';

const DB_TIMEOUT_MS = 4000;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new BusinessError('NO_INDEXEDDB', '当前浏览器不支持本地存档（IndexedDB 不可用）'));
      return;
    }
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new BusinessError('DB_TIMEOUT', '本地存档数据库响应超时'));
    }, DB_TIMEOUT_MS);

    const request = indexedDB.open(SAVE.dbName, SAVE.dbVersion);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SAVE.objectStore)) {
        db.createObjectStore(SAVE.objectStore);
      }
    };
    request.onsuccess = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      dbPromise = null;
      reject(new BusinessError('DB_OPEN_FAILED', '无法打开本地存档数据库'));
    };
  });
  return dbPromise;
}

export function slotKey(slot: SaveSlot | `${SaveSlot}-prev`): string {
  return `snapshot.${slot}`;
}

export async function putRaw(key: string, value: unknown): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SAVE.objectStore, 'readwrite');
    tx.objectStore(SAVE.objectStore).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new BusinessError('DB_WRITE_FAILED', '写入本地存档失败'));
    tx.onabort = () => reject(new BusinessError('DB_WRITE_FAILED', '写入本地存档被中止'));
  });
}

export async function getRaw(key: string): Promise<unknown | null> {
  const db = await openDatabase();
  return new Promise<unknown | null>((resolve, reject) => {
    const tx = db.transaction(SAVE.objectStore, 'readonly');
    const request = tx.objectStore(SAVE.objectStore).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(new BusinessError('DB_READ_FAILED', '读取本地存档失败'));
  });
}

export async function deleteRaw(key: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SAVE.objectStore, 'readwrite');
    tx.objectStore(SAVE.objectStore).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new BusinessError('DB_WRITE_FAILED', '清理本地存档失败'));
  });
}

/**
 * 写入快照：先把现有内容挪到 -prev，再写新内容。
 * 任一步失败都会抛错，由调用方明确告知玩家保存失败。
 */
