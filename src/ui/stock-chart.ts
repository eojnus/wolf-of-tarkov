/**
 * K 线绘制与交互 —— 行情、持仓卡片与详情窗共用同一份数据与同一套画法。
 *
 * 只画「已经聚合好的蜡烛」，不做任何取数、补算或指标推算：
 * 数据来自 features/stock 的已收盘 K 线与当前未收盘 K 线。
 *
 * 交互（只在 `.chart-block` 结构里启用）：
 *  - 悬停十字线，并联动时间轴、价格轴标签与开高低收；
 *  - 滚轮缩放（以光标位置为中心），拖动平移；
 *  - 「返回最新」回到最新一根并恢复默认窗口；
 *  - 最新价用虚线标记，绘图区用深石墨蓝，网格与坐标轴保持轻淡。
 *
 * 缩放与平移只存在于当前会话内存里，不写存档、不影响任何业务数值。
 */

import { dateAtMinute } from '../core/calendar';
import { formatMoney } from '../core/money';
import { TIME } from '../content/config';
import type { Candle } from '../features/stock';

export interface ChartInput {
  readonly closed: readonly Candle[];
  readonly current: Candle | null;
}

const COLOR = {
  bg: '#232f3c',
  grid: 'rgba(255,255,255,0.07)',
  axis: 'rgba(255,255,255,0.42)',
  axisText: 'rgba(232,240,246,0.62)',
  up: '#e07363',
  down: '#4fb08a',
  flat: '#8ea3b5',
  crosshair: 'rgba(226,236,244,0.55)',
  lastLine: 'rgba(226,236,244,0.35)',
  tag: '#e8f0f6',
};

const PAD = { top: 10, right: 56, bottom: 18, left: 8 };
/** 默认窗口：最多显示多少根蜡烛 */
const DEFAULT_VISIBLE = 90;
const MIN_VISIBLE = 12;

function priceText(cents: number): string {
  return formatMoney(cents);
}

function timeText(minute: number): string {
  const date = dateAtMinute(minute, TIME.calendar);
  const hh = String(date.hour).padStart(2, '0');
  const mm = String(date.minute).padStart(2, '0');
  return `${date.month}月${date.day}日 ${hh}:${mm}`;
}

interface Geometry {
  width: number;
  height: number;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  min: number;
  max: number;
  slot: number;
  from: number;
  to: number;
  /** 小尺寸（卡片、详情窗）使用更紧凑的轴与字号 */
  compact: boolean;
  /** 右侧价格轴宽度 */
  axisWidth: number;
}

export class CandleChart {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private tip: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private legendEl: HTMLElement | null = null;
  private block: HTMLElement | null = null;

  private data: ChartInput = { closed: [], current: null };
  private all: Candle[] = [];
  private visible = DEFAULT_VISIBLE;
  /** 默认窗口（跟随历史增长）；用户缩放过一次后固定为那个根数 */
  private autoVisible = true;
  /** 视窗右端在 all 里的索引（含） */
  private end = 0;
  /** 是否跟随最新一根：平移后停止跟随，数据继续增长也不抢回视窗 */
  private follow = true;
  private hover: { x: number; y: number } | null = null;
  private drag: { pointerId: number; startX: number; endAtStart: number } | null = null;
  private geometry: Geometry | null = null;
  private observer: ResizeObserver | null = null;

  constructor(canvasEl: HTMLCanvasElement) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.block = canvasEl.closest('.chart-block');
    const frame = canvasEl.closest('.chart-frame');
    this.tip = frame?.querySelector('.chart-tip') ?? null;
    // 卡片与详情窗都可能有空状态文案：先找图表框，再退回直接父级
    this.emptyEl =
      frame?.querySelector('.chart-empty') ??
      canvasEl.parentElement?.querySelector('.chart-empty') ??
      null;
    this.legendEl =
      this.block?.querySelector('[data-chart-legend]') ??
      this.block?.querySelector('.chart-legend') ??
      null;

    canvasEl.addEventListener('pointermove', this.handlePointerMove);
    canvasEl.addEventListener('pointerleave', this.handlePointerLeave);
    canvasEl.addEventListener('pointerdown', this.handlePointerDown);
    canvasEl.addEventListener('pointerup', this.handlePointerUp);
    canvasEl.addEventListener('pointercancel', this.handlePointerUp);
    canvasEl.addEventListener('wheel', this.handleWheel, { passive: false });
    this.block?.querySelector('[data-chart-reset]')?.addEventListener('click', this.handleReset);

    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(() => this.paint());
      this.observer.observe(canvasEl);
    }
  }

  update(input: ChartInput): void {
    this.data = input;
    this.all = input.current ? [...input.closed, input.current] : [...input.closed];
    const total = this.all.length;
    if (this.autoVisible) {
      // 默认窗口随历史增长：一开始只有一根也不会把窗口缩成 1 根后不再恢复
      this.visible = Math.min(DEFAULT_VISIBLE, Math.max(1, total));
    } else if (this.visible > total) {
      // 用户缩放过：只在数据变少时收缩，不擅自放大回默认值
      this.visible = Math.max(1, total);
    }
    if (this.follow || this.end <= 0 || this.end >= total - 1) {
      this.end = Math.max(0, total - 1);
    }
    this.paint();
  }

  destroy(): void {
    const canvas = this.canvas;
    if (canvas) {
      canvas.removeEventListener('pointermove', this.handlePointerMove);
      canvas.removeEventListener('pointerleave', this.handlePointerLeave);
      canvas.removeEventListener('pointerdown', this.handlePointerDown);
      canvas.removeEventListener('pointerup', this.handlePointerUp);
      canvas.removeEventListener('pointercancel', this.handlePointerUp);
      canvas.removeEventListener('wheel', this.handleWheel);
      this.block
        ?.querySelector('[data-chart-reset]')
        ?.removeEventListener('click', this.handleReset);
    }
    this.observer?.disconnect();
    this.observer = null;
    this.canvas = null;
    this.ctx = null;
    this.tip = null;
    this.emptyEl = null;
    this.legendEl = null;
    this.block = null;
    this.geometry = null;
    this.hover = null;
    this.drag = null;
    this.all = [];
  }

  /* --------------------------------------------------------------- 绘制 */

  private ensureSize(): number {
    const canvas = this.canvas;
    if (!canvas) return 1;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const width = Math.max(40, Math.floor(canvas.clientWidth));
    const height = Math.max(30, Math.floor(canvas.clientHeight));
    const pixelWidth = Math.floor(width * dpr);
    const pixelHeight = Math.floor(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    return dpr;
  }

  private paint(): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;
    const dpr = this.ensureSize();
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (cssWidth < 8 || cssHeight < 8) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    // 只有一根蜡烛时还谈不上走势：保持空状态，等第二根形成再画
    const hasData = this.all.length >= 2;
    if (this.emptyEl) this.emptyEl.hidden = hasData;
    if (!hasData) {
      this.geometry = null;
      if (this.tip) this.tip.hidden = true;
      this.setLegend(null);
      return;
    }

    const geom = this.computeGeometry(cssWidth, cssHeight);
    this.geometry = geom;

    const hoverIndex = this.hover ? this.indexAt(geom, this.hover.x) : null;
    this.drawGrid(ctx, geom);
    this.drawCandles(ctx, geom);
    this.drawAxes(ctx, geom, hoverIndex);
    this.drawLastPrice(ctx, geom);
    if (this.hover) this.drawCrosshair(ctx, geom, this.hover);
    this.updateHoverReadout(geom);
  }

  private computeGeometry(width: number, height: number): Geometry {
    const compact = width < 340 || height < 140;
    const axisWidth = compact ? 44 : PAD.right;
    const plotLeft = PAD.left;
    const plotRight = Math.max(plotLeft + 20, width - axisWidth);
    const plotTop = PAD.top;
    const plotBottom = Math.max(plotTop + 16, height - (compact ? 15 : PAD.bottom));

    const from = Math.max(0, this.end - this.visible + 1);
    const to = Math.min(this.all.length - 1, this.end);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = from; i <= to; i += 1) {
      const candle = this.all[i]!;
      if (candle.low < min) min = candle.low;
      if (candle.high > max) max = candle.high;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0;
      max = 1;
    }
    if (max - min < 1) {
      min -= 1;
      max += 1;
    }
    // 上下各留一点呼吸空间，避免最高/最低影线贴边
    const pad = (max - min) * 0.08;
    min -= pad;
    max += pad;

    const slot = (plotRight - plotLeft) / Math.max(1, to - from + 1);
    return {
      width,
      height,
      plotLeft,
      plotRight,
      plotTop,
      plotBottom,
      min,
      max,
      slot,
      from,
      to,
      compact,
      axisWidth,
    };
  }

  private font(geom: Geometry): string {
    const size = geom.compact ? 9 : 10.5;
    return `${size}px "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;
  }

  private yOf(geom: Geometry, price: number): number {
    return (
      geom.plotBottom - ((price - geom.min) / (geom.max - geom.min)) * (geom.plotBottom - geom.plotTop)
    );
  }

  private xOf(geom: Geometry, index: number): number {
    return geom.plotLeft + (index - geom.from) * geom.slot + geom.slot / 2;
  }

  private drawGrid(ctx: CanvasRenderingContext2D, geom: Geometry): void {
    ctx.save();
    ctx.strokeStyle = COLOR.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i += 1) {
      const y = Math.round(geom.plotTop + ((geom.plotBottom - geom.plotTop) * i) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(geom.plotLeft, y);
      ctx.lineTo(geom.plotRight, y);
      ctx.stroke();
    }
    for (let i = 0; i <= 3; i += 1) {
      const x = Math.round(geom.plotLeft + ((geom.plotRight - geom.plotLeft) * i) / 3) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, geom.plotTop);
      ctx.lineTo(x, geom.plotBottom);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawCandles(ctx: CanvasRenderingContext2D, geom: Geometry): void {
    const bodyWidth = Math.max(1.2, Math.min(9, geom.slot * 0.62));
    for (let i = geom.from; i <= geom.to; i += 1) {
      const candle = this.all[i]!;
      const x = this.xOf(geom, i);
      const rising = candle.close > candle.open;
      const falling = candle.close < candle.open;
      const color = rising ? COLOR.up : falling ? COLOR.down : COLOR.flat;
      const isCurrent = i === this.all.length - 1 && this.data.current !== null;
      ctx.globalAlpha = isCurrent ? 0.68 : 1;

      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const xMid = Math.round(x) + 0.5;
      ctx.moveTo(xMid, this.yOf(geom, candle.high));
      ctx.lineTo(xMid, this.yOf(geom, candle.low));
      ctx.stroke();

      const openY = this.yOf(geom, candle.open);
      const closeY = this.yOf(geom, candle.close);
      const top = Math.min(openY, closeY);
      const bodyHeight = Math.max(1.2, Math.abs(closeY - openY));
      ctx.fillStyle = color;
      ctx.fillRect(
        Math.round(x - bodyWidth / 2),
        Math.round(top),
        Math.max(1, Math.round(bodyWidth)),
        Math.round(bodyHeight),
      );
      ctx.globalAlpha = 1;
    }
  }

  private drawAxes(
    ctx: CanvasRenderingContext2D,
    geom: Geometry,
    skipIndex: number | null = null,
  ): void {
    ctx.save();
    ctx.fillStyle = COLOR.axisText;
    ctx.font = this.font(geom);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let i = 0; i <= 4; i += 1) {
      const y = geom.plotTop + ((geom.plotBottom - geom.plotTop) * i) / 4;
      const price = geom.max - ((geom.max - geom.min) * i) / 4;
      ctx.fillText(priceText(Math.round(price)), geom.plotRight + 6, y);
    }

    // 时间轴：最多 3 个刻度，避开十字线所在位置，并按文字宽度夹在绘图区内
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const skipRange = Math.max(1, Math.round((geom.to - geom.from + 1) * 0.14));
    const ticks = geom.compact ? 2 : 3;
    for (let i = 0; i < ticks; i += 1) {
      const index = Math.round(geom.from + ((geom.to - geom.from) * i) / (ticks - 1));
      const candle = this.all[index];
      if (!candle) continue;
      if (skipIndex !== null && Math.abs(index - skipIndex) <= skipRange) continue;
      const label = timeText(candle.minute);
      const half = ctx.measureText(label).width / 2;
      const x = Math.min(
        geom.plotRight - half,
        Math.max(geom.plotLeft + half, this.xOf(geom, index)),
      );
      ctx.fillText(label, x, geom.plotBottom + 4);
    }
    ctx.restore();
  }

  private drawLastPrice(ctx: CanvasRenderingContext2D, geom: Geometry): void {
    const last = this.all[this.all.length - 1];
    if (!last) return;
    const y = Math.round(this.yOf(geom, last.close)) + 0.5;
    if (y < geom.plotTop || y > geom.plotBottom) return;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = COLOR.lastLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(geom.plotLeft, y);
    ctx.lineTo(geom.plotRight, y);
    ctx.stroke();
    ctx.setLineDash([]);

    const text = priceText(last.close);
    ctx.font = this.font(geom);
    const width = ctx.measureText(text).width + 10;
    ctx.fillStyle = 'rgba(232,240,246,0.16)';
    ctx.fillRect(geom.plotRight + 1, y - 8, Math.min(width, geom.axisWidth - 8), 16);
    ctx.fillStyle = COLOR.tag;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(text, geom.plotRight + 6, y);
    ctx.restore();
  }

  private drawCrosshair(
    ctx: CanvasRenderingContext2D,
    geom: Geometry,
    hover: { x: number; y: number },
  ): void {
    const index = this.indexAt(geom, hover.x);
    const candle = this.all[index];
    if (!candle) return;
    const x = Math.round(this.xOf(geom, index)) + 0.5;
    const y = Math.round(Math.min(geom.plotBottom, Math.max(geom.plotTop, hover.y))) + 0.5;

    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = COLOR.crosshair;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, geom.plotTop);
    ctx.lineTo(x, geom.plotBottom);
    ctx.moveTo(geom.plotLeft, y);
    ctx.lineTo(geom.plotRight, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 价格轴标签
    const price = geom.max - ((y - geom.plotTop) / (geom.plotBottom - geom.plotTop)) * (geom.max - geom.min);
    const priceTag = priceText(Math.round(price));
    ctx.font = this.font(geom);
    const tagWidth = ctx.measureText(priceTag).width + 10;
    ctx.fillStyle = 'rgba(20,30,40,0.92)';
    ctx.fillRect(geom.plotRight + 1, y - 8, Math.min(tagWidth, geom.axisWidth - 8), 16);
    ctx.fillStyle = COLOR.tag;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(priceTag, geom.plotRight + 6, y);

    // 时间轴标签
    const label = timeText(candle.minute);
    const timeWidth = ctx.measureText(label).width + 10;
    const timeX = Math.min(Math.max(x - timeWidth / 2, geom.plotLeft), geom.plotRight - timeWidth);
    ctx.fillStyle = 'rgba(20,30,40,0.92)';
    ctx.fillRect(timeX, geom.plotBottom + 1, timeWidth, 15);
    ctx.fillStyle = COLOR.tag;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(label, timeX + timeWidth / 2, geom.plotBottom + 3);
    ctx.restore();
  }

  private indexAt(geom: Geometry, x: number): number {
    const raw = geom.from + Math.floor((x - geom.plotLeft) / geom.slot);
    return Math.min(geom.to, Math.max(geom.from, raw));
  }

  /** 提示框与图例：显示当前悬停蜡烛，或最新一根。 */
  private updateHoverReadout(geom: Geometry): void {
    const index = this.hover ? this.indexAt(geom, this.hover.x) : this.all.length - 1;
    const candle = this.all[index];
    if (!candle) return;
    const previous = this.all[index - 1];
    const diff = previous ? candle.close - previous.close : 0;
    const diffPct = previous && previous.close !== 0 ? (diff / previous.close) * 100 : 0;
    const tone = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
    this.setLegend(candle, diff, diffPct, tone);

    const tip = this.tip;
    if (!tip) return;
    if (!this.hover) {
      tip.hidden = true;
      return;
    }
    const row = (key: string, value: string): string =>
      `<div class="tip-row"><span class="tip-key">${key}</span><span>${value}</span></div>`;
    tip.innerHTML = [
      row('时间', timeText(candle.minute)),
      row('开盘', priceText(candle.open)),
      row('最高', priceText(candle.high)),
      row('最低', priceText(candle.low)),
      row('收盘', priceText(candle.close)),
      previous
        ? row('较前收', `${diff >= 0 ? '+' : ''}${priceText(diff)}（${diffPct.toFixed(2)}%）`)
        : '',
    ].join('');
    tip.hidden = false;

    const frame = this.canvas?.closest('.chart-frame');
    if (!frame) return;
    const frameRect = frame.getBoundingClientRect();
    const tipWidth = tip.offsetWidth;
    const tipHeight = tip.offsetHeight;
    let left = this.hover.x + 14;
    let top = this.hover.y + 12;
    if (left + tipWidth > frameRect.width - 4) left = Math.max(4, this.hover.x - tipWidth - 14);
    if (top + tipHeight > frameRect.height - 4) top = Math.max(4, this.hover.y - tipHeight - 12);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  private setLegend(
    candle: Candle | null,
    diff = 0,
    diffPct = 0,
    tone = '',
  ): void {
    const legend = this.legendEl;
    if (!legend) return;
    if (!candle) {
      legend.textContent = '';
      return;
    }
    const previousTone = tone === 'up' ? 'up' : tone === 'down' ? 'down' : '';
    legend.innerHTML = `
      <span>${timeText(candle.minute)}</span>
      <span>开<b class="num">${priceText(candle.open)}</b></span>
      <span>高<b class="num">${priceText(candle.high)}</b></span>
      <span>低<b class="num">${priceText(candle.low)}</b></span>
      <span>收<b class="num">${priceText(candle.close)}</b></span>
      <span class="${previousTone}">${diff >= 0 ? '+' : ''}${priceText(diff)}（${diffPct.toFixed(2)}%）</span>
    `;
  }

  /* --------------------------------------------------------------- 交互 */

  private localPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const canvas = this.canvas!;
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.canvas) return;
    const point = this.localPoint(event);
    if (this.drag) {
      const geom = this.geometry;
      if (!geom) return;
      const shift = Math.round((event.clientX - this.drag.startX) / Math.max(1, geom.slot));
      const next = Math.min(
        this.all.length - 1,
        Math.max(0, this.drag.endAtStart - shift),
      );
      if (next !== this.end) {
        this.end = next;
        this.follow = next >= this.all.length - 1;
        this.paint();
      }
      return;
    }
    this.hover = point;
    this.paint();
  };

  private readonly handlePointerLeave = (): void => {
    this.hover = null;
    if (this.tip) this.tip.hidden = true;
    this.paint();
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    if (!this.canvas) return;
    this.drag = { pointerId: event.pointerId, startX: event.clientX, endAtStart: this.end };
    this.canvas.setPointerCapture?.(event.pointerId);
    this.canvas.style.cursor = 'grabbing';
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (!this.drag) return;
    this.canvas?.releasePointerCapture?.(event.pointerId);
    if (this.canvas) this.canvas.style.cursor = 'crosshair';
    this.drag = null;
  };

  /** 滚轮缩放：以光标所在的蜡烛为中心，保持它不动。 */
  private readonly handleWheel = (event: WheelEvent): void => {
    const geom = this.geometry;
    if (!geom) return;
    event.preventDefault();
    const point = this.localPoint(event as unknown as PointerEvent);
    const anchor = this.indexAt(geom, point.x);
    const target = Math.round(this.visible * (event.deltaY > 0 ? 1.18 : 0.85));
    // 历史不足 MIN_VISIBLE 根时下限跟着历史走，避免窗口比数据还宽
    const next = Math.max(
      Math.min(MIN_VISIBLE, this.all.length),
      Math.min(this.all.length, target),
    );
    if (next === this.visible) return;
    const ratio = (anchor - geom.from) / Math.max(1, geom.to - geom.from);
    this.visible = next;
    // 用户主动缩放：之后不再跟随历史自动展开
    this.autoVisible = false;
    const nextFrom = Math.round(anchor - ratio * (next - 1));
    this.end = Math.min(this.all.length - 1, Math.max(next - 1, nextFrom + next - 1));
    this.follow = this.end >= this.all.length - 1;
    this.hover = point;
    this.paint();
  };

  private readonly handleReset = (): void => {
    this.follow = true;
    // 回到默认窗口，并重新跟随历史增长
    this.autoVisible = true;
    this.visible = Math.min(DEFAULT_VISIBLE, Math.max(1, this.all.length));
    this.end = this.all.length - 1;
    this.hover = null;
    this.paint();
  };
}

/**
 * 一张画布对应一个控制器；重复调用只更新数据，不重建 canvas，
 * 因此悬停、缩放、平移与拖动中的位置都不会被打断。
 */
const charts = new WeakMap<HTMLCanvasElement, CandleChart>();

export function paintStockCharts(
  root: HTMLElement,
  lookup: (stockId: string) => ChartInput | null,
): void {
  for (const canvas of root.querySelectorAll<HTMLCanvasElement>('canvas[data-chart]')) {
    const id = canvas.dataset.stock;
    if (!id) continue;
    const input = lookup(id);
    if (!input) continue;
    let chart = charts.get(canvas);
    if (!chart) {
      chart = new CandleChart(canvas);
      charts.set(canvas, chart);
    }
    chart.update(input);
  }
}

/**
 * 子树被移除或正文被整体替换前调用：解绑监听与 ResizeObserver，
 * 避免已经脱离文档的画布还被观察器攥着。
 */
export function destroyStockCharts(root: ParentNode | null | undefined): void {
  if (!root) return;
  for (const canvas of root.querySelectorAll<HTMLCanvasElement>('canvas[data-chart]')) {
    const chart = charts.get(canvas);
    if (!chart) continue;
    chart.destroy();
    charts.delete(canvas);
  }
}
