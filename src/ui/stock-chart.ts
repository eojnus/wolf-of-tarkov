/**
 * K 线绘制 —— 卡片与详情窗共用同一份数据与同一套画法。
 *
 * 只画「已经聚合好的蜡烛」，不做任何取数或补算：
 * 数据来自 features/stock 的已收盘 K 线与当前未收盘 K 线。
 */

import type { Candle } from '../features/stock';

export interface ChartInput {
  readonly closed: readonly Candle[];
  readonly current: Candle | null;
}

const UP_COLOR = '#e07070';
const DOWN_COLOR = '#5fbf8a';
const FLAT_COLOR = '#8aa4b8';

function ensureSize(canvas: HTMLCanvasElement): number {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(60, Math.floor(canvas.clientWidth));
  const height = Math.max(40, Math.floor(canvas.clientHeight));
  const pixelWidth = Math.floor(width * dpr);
  const pixelHeight = Math.floor(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    return dpr;
  }
  return dpr;
}

/** 画一次。返回 false 表示还没有可画的蜡烛（调用方显示空状态文案）。 */
export function paintCandleChart(canvas: HTMLCanvasElement, input: ChartInput): boolean {
  const all: Candle[] = [...input.closed];
  if (input.current) all.push(input.current);
  if (all.length === 0) return false;

  const dpr = ensureSize(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;

  const width = canvas.width;
  const height = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.scale(dpr, dpr);

  const w = width / dpr;
  const h = height / dpr;
  const padTop = 8;
  const padBottom = 8;
  const usable = Math.max(10, h - padTop - padBottom);

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const candle of all) {
    if (candle.low < min) min = candle.low;
    if (candle.high > max) max = candle.high;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return false;
  if (max - min < 1) {
    min -= 1;
    max += 1;
  }
  const span = max - min;

  const yOf = (price: number): number => padTop + usable - ((price - min) / span) * usable;
  const slot = w / Math.max(1, all.length);
  const bodyWidth = Math.max(1.5, Math.min(7, slot * 0.62));

  // 参考线
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i += 1) {
    const y = padTop + (usable * i) / 4;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const drawOne = (candle: Candle, index: number, closedCandle: boolean): void => {
    const x = slot * index + slot / 2;
    const rising = candle.close > candle.open;
    const falling = candle.close < candle.open;
    const color = rising ? UP_COLOR : falling ? DOWN_COLOR : FLAT_COLOR;
    ctx.globalAlpha = closedCandle ? 1 : 0.55;

    // 影线
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yOf(candle.high));
    ctx.lineTo(x, yOf(candle.low));
    ctx.stroke();

    // 实体：一字板时给最小高度，避免看不见
    const openY = yOf(candle.open);
    const closeY = yOf(candle.close);
    const top = Math.min(openY, closeY);
    const bodyHeight = Math.max(1.2, Math.abs(closeY - openY));
    ctx.fillStyle = color;
    ctx.fillRect(x - bodyWidth / 2, top, bodyWidth, bodyHeight);
    ctx.globalAlpha = 1;
  };

  input.closed.forEach((candle, index) => drawOne(candle, index, true));
  if (input.current) drawOne(input.current, all.length - 1, false);

  return true;
}

/** 批量重绘：容器内所有 [data-chart] 画布按 data-stock 找数据。 */
export function paintStockCharts(
  root: HTMLElement,
  lookup: (stockId: string) => ChartInput | null,
): void {
  for (const canvas of root.querySelectorAll<HTMLCanvasElement>('canvas[data-chart]')) {
    const id = canvas.dataset.stock;
    if (!id) continue;
    const input = lookup(id);
    if (!input) continue;
    const drawn = paintCandleChart(canvas, input);
    canvas.dataset.empty = drawn ? '0' : '1';
    const hint = canvas.parentElement?.querySelector<HTMLElement>('.chart-empty');
    if (hint) hint.hidden = drawn;
  }
}
