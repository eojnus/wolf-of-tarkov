/**
 * 确定性随机 —— 建筑外观变化（阳台选跨、屋顶设备摆放）只从这里取值。
 *
 * 不使用 `Math.random`、时间、遍历顺序或任何业务状态：
 * 同一组种子部件永远得到同一条序列，因此同一栋楼重进场景后外观不变。
 */

/** FNV-1a 32 位字符串散列（稳定、跨平台、无依赖）。 */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 把任意种子部件混合成一个 32 位无符号整数。 */
export function hashSeed(parts: readonly (string | number)[]): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const text = typeof part === 'number' ? `#${part}` : part;
    hash = (hash ^ hashString(text)) >>> 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32：小而稳定的 PRNG，序列只由种子决定。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从数组里按种子取一个元素；空数组直接报错，避免静默拿到 undefined。 */
export function pickOne<T>(random: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new Error('[buildings] 空集合无法取值');
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))];
}

/** 0..1 区间内的确定性抖动，用于设备箱位置等细节。 */
export function jitter(random: () => number, amplitude: number): number {
  return (random() * 2 - 1) * amplitude;
}
