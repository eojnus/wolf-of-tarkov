/**
 * 环形图（人口、政治群体、产业产出共用）。
 *
 * 只用原生 SVG：扇区按真实比例绘制，悬停时沿中线轻微外移并提亮；
 * 外移用 CSS transform 实现，不参与布局，因此不会改变统计值、也不会让容器尺寸跳动。
 *
 * 交互：扇区与图例双向联动；小比例扇区另有更宽的透明命中环，避免 0.3% 的扇区点不到。
 * 键盘：扇区与图例项都可用 Tab 聚焦，聚焦时显示同样的提示。
 * 数据更新：形状不变时只改弧长与文字，保留当前悬停对象与提示，不重播入场。
 */

export interface PieDatum {
  readonly id: string;
  readonly label: string;
  /** 真实数值（人数、金额等），只用于计算比例与提示 */
  readonly value: number;
  /** 已格式化的数值文本（例如「12.3 万」） */
  readonly valueText: string;
  /** 0–1 的占比 */
  readonly ratio: number;
}

export interface PieCenter {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
}

export interface PieOptions {
  readonly ariaLabel: string;
  readonly center: PieCenter;
  /** 单位说明，出现在提示与图例里，例如「人」 */
  readonly unit: string;
  readonly colors?: readonly string[];
}

export const PIE_COLORS: readonly string[] = [
  '#2b7c8f',
  '#5b93b8',
  '#4f9f83',
  '#b5813c',
  '#8a7aa8',
  '#c06c5a',
  '#6f8a5a',
  '#a06a86',
];

const R = 46;
const CIRCUMFERENCE = 2 * Math.PI * R;
const OFFSET = 3.2;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pctText(ratio: number): string {
  return `${(Math.max(0, ratio) * 100).toFixed(1)}%`;
}

interface SliceNodes {
  arc: SVGCircleElement;
  hit: SVGCircleElement;
  legend: HTMLElement;
}

export class DonutPie {
  private host: HTMLElement | null = null;
  private svg: SVGSVGElement | null = null;
  private legendEl: HTMLElement | null = null;
  private tipEl: HTMLElement | null = null;
  private centerLabelEl: SVGTextElement | null = null;
  private centerValueEl: SVGTextElement | null = null;
  private centerSubEl: SVGTextElement | null = null;
  private readonly nodes: SliceNodes[] = [];
  private data: readonly PieDatum[] = [];
  private options: PieOptions | null = null;
  private shape = '';
  private hot: number | null = null;

  /** 首次挂载：创建骨架并绑定事件。重复调用无副作用。 */
  mount(host: HTMLElement): void {
    if (this.host === host && this.svg) return;
    this.host = host;
    host.classList.add('pie-host');
    host.innerHTML = `
      <div class="pie-wrap">
        <svg class="pie-chart" viewBox="0 0 120 120" role="img"></svg>
        <ul class="pie-legend"></ul>
      </div>
      <div class="pie-tip" hidden></div>
    `;
    this.svg = host.querySelector('svg.pie-chart');
    this.legendEl = host.querySelector('.pie-legend');
    this.tipEl = host.querySelector('.pie-tip');
    this.nodes.length = 0;
    this.shape = '';

    if (this.svg) {
      this.svg.insertAdjacentHTML(
        'afterbegin',
        `<circle class="pie-track" cx="60" cy="60" r="${R}"></circle><g data-arcs></g><g data-hits></g>`,
      );
      this.svg.insertAdjacentHTML(
        'beforeend',
        `<text class="pie-center-label" x="60" y="52" data-center-label></text>
         <text class="pie-center-value" x="60" y="72" data-center-value></text>
         <text class="pie-center-sub" x="60" y="87" data-center-sub></text>`,
      );
      this.centerLabelEl = this.svg.querySelector('[data-center-label]');
      this.centerValueEl = this.svg.querySelector('[data-center-value]');
      this.centerSubEl = this.svg.querySelector('[data-center-sub]');
    }

    this.svg?.addEventListener('pointerover', this.handlePointerOver);
    this.svg?.addEventListener('pointerout', this.handlePointerOut);
    this.svg?.addEventListener('focusin', this.handleFocusIn);
    this.svg?.addEventListener('focusout', this.handleFocusOut);
    this.legendEl?.addEventListener('pointerover', this.handlePointerOver);
    this.legendEl?.addEventListener('pointerout', this.handlePointerOut);
    this.legendEl?.addEventListener('focusin', this.handleFocusIn);
    this.legendEl?.addEventListener('focusout', this.handleFocusOut);
  }

  /** 更新数据：形状不变则原地改弧长与文字，保留悬停对象。 */
  update(data: readonly PieDatum[], options: PieOptions): void {
    if (!this.svg || !this.legendEl) return;
    this.data = data;
    this.options = options;
    const colors = options.colors ?? PIE_COLORS;
    const shape = data.map((item) => `${item.id}:${item.label}`).join('|');

    if (shape !== this.shape) {
      this.shape = shape;
      this.build(data, colors);
    }

    const arcs = this.svg.querySelector('[data-arcs]');
    const hits = this.svg.querySelector('[data-hits]');
    if (!arcs || !hits) return;

    const total = data.reduce((sum, item) => sum + Math.max(0, item.value), 0);
    let offset = 0;
    data.forEach((item, index) => {
      const nodes = this.nodes[index];
      if (!nodes) return;
      const ratio = total > 0 ? Math.max(0, item.value) / total : 0;
      const length = CIRCUMFERENCE * ratio;
      const dash = `${length.toFixed(3)} ${(CIRCUMFERENCE - length).toFixed(3)}`;
      nodes.arc.setAttribute('stroke-dasharray', dash);
      nodes.arc.setAttribute('stroke-dashoffset', (-offset).toFixed(3));
      nodes.arc.setAttribute('stroke', colors[index % colors.length] ?? PIE_COLORS[0]!);
      nodes.hit.setAttribute('stroke-dasharray', dash);
      nodes.hit.setAttribute('stroke-dashoffset', (-offset).toFixed(3));
      const mid = ((offset + length / 2) / CIRCUMFERENCE) * Math.PI * 2 - Math.PI / 2;
      const dx = (Math.cos(mid) * OFFSET).toFixed(2);
      const dy = (Math.sin(mid) * OFFSET).toFixed(2);
      nodes.arc.style.setProperty('--pie-dx', `${dx}px`);
      nodes.arc.style.setProperty('--pie-dy', `${dy}px`);
      const label = `${item.label}：${item.valueText}${options.unit}，占 ${pctText(ratio)}`;
      nodes.arc.setAttribute('aria-label', label);
      nodes.hit.setAttribute('aria-label', label);
      nodes.legend.innerHTML = `
        <i class="dot" style="background:${colors[index % colors.length] ?? PIE_COLORS[0]}"></i>
        <span>${escapeHtml(item.label)}</span>
        <b>${escapeHtml(item.valueText)}</b>
        <em>${pctText(ratio)}</em>`;
      offset += length;
    });

    this.setCenter(options.center);
    this.svg.setAttribute('aria-label', options.ariaLabel);
    if (this.hot !== null && this.hot < data.length) this.applyHot(this.hot);
    else this.clearHot();
  }

  destroy(): void {
    this.svg?.removeEventListener('pointerover', this.handlePointerOver);
    this.svg?.removeEventListener('pointerout', this.handlePointerOut);
    this.svg?.removeEventListener('focusin', this.handleFocusIn);
    this.svg?.removeEventListener('focusout', this.handleFocusOut);
    this.legendEl?.removeEventListener('pointerover', this.handlePointerOver);
    this.legendEl?.removeEventListener('pointerout', this.handlePointerOut);
    this.legendEl?.removeEventListener('focusin', this.handleFocusIn);
    this.legendEl?.removeEventListener('focusout', this.handleFocusOut);
    this.nodes.length = 0;
    this.shape = '';
    this.hot = null;
    this.host = null;
  }

  /** 形状变化才重建节点：分类数量或名称变了，旧节点无法对应。 */
  private build(data: readonly PieDatum[], colors: readonly string[]): void {
    const arcs = this.svg?.querySelector('[data-arcs]');
    const hits = this.svg?.querySelector('[data-hits]');
    if (!arcs || !hits || !this.legendEl) return;
    this.hot = null;
    arcs.innerHTML = '';
    hits.innerHTML = '';
    this.legendEl.innerHTML = '';
    this.nodes.length = 0;

    data.forEach((_item, index) => {
      const color = colors[index % colors.length] ?? PIE_COLORS[0]!;
      const arc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      arc.setAttribute('class', 'pie-slice');
      arc.setAttribute('cx', '60');
      arc.setAttribute('cy', '60');
      arc.setAttribute('r', String(R));
      arc.setAttribute('stroke', color);
      arc.setAttribute('tabindex', '0');
      arc.dataset.pieIndex = String(index);

      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      hit.setAttribute('class', 'pie-hit');
      hit.setAttribute('cx', '60');
      hit.setAttribute('cy', '60');
      hit.setAttribute('r', String(R));
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-width', '26');
      hit.setAttribute('fill', 'none');
      hit.dataset.pieIndex = String(index);

      const legend = document.createElement('li');
      legend.dataset.pieIndex = String(index);
      legend.setAttribute('tabindex', '0');

      arcs.appendChild(arc);
      hits.appendChild(hit);
      this.legendEl!.appendChild(legend);
      this.nodes.push({ arc, hit, legend });
    });
  }

  private setCenter(center: PieCenter): void {
    if (!this.centerLabelEl || !this.centerValueEl || !this.centerSubEl) return;
    // 中心文字不能长过内圈：过长的分类名截断，完整名称在图例与提示里
    const label = center.label.length > 8 ? `${center.label.slice(0, 7)}…` : center.label;
    if (this.centerLabelEl.textContent !== label) {
      this.centerLabelEl.textContent = label;
    }
    if (this.centerValueEl.textContent !== center.value) {
      this.centerValueEl.textContent = center.value;
    }
    const sub = center.sub ?? '';
    this.centerSubEl.textContent = sub;
    this.centerSubEl.style.display = sub ? '' : 'none';
    this.fitValue(center.value);
  }

  /** 中心数值可能很长（例如 116 万人）：按位数缩小字号，保证不压到圆环上。 */
  private fitValue(text: string): void {
    if (!this.centerValueEl) return;
    const size = text.length >= 6 ? 15 : text.length >= 5 ? 17 : 19;
    this.centerValueEl.style.fontSize = `${size}px`;
  }

  /** 当前悬停/聚焦的对象；null 表示恢复总览摘要。 */
  private applyHot(index: number, pointer?: { x: number; y: number }): void {
    const item = this.data[index];
    const options = this.options;
    if (!item || !options) return;
    this.hot = index;
    const total = this.data.reduce((sum, row) => sum + Math.max(0, row.value), 0);
    const ratio = total > 0 ? Math.max(0, item.value) / total : 0;
    this.nodes.forEach((nodes, i) => {
      nodes.arc.classList.toggle('is-hot', i === index);
      nodes.legend.classList.toggle('is-hot', i === index);
    });
    if (this.centerLabelEl && this.centerValueEl && this.centerSubEl) {
      this.centerLabelEl.textContent =
        item.label.length > 8 ? `${item.label.slice(0, 7)}…` : item.label;
      this.centerValueEl.textContent = item.valueText;
      this.centerSubEl.textContent = `占 ${pctText(ratio)}`;
      this.centerSubEl.style.display = '';
      this.fitValue(item.valueText);
    }
    this.showTip(index, pointer);
  }

  private clearHot(): void {
    this.hot = null;
    for (const nodes of this.nodes) {
      nodes.arc.classList.remove('is-hot');
      nodes.legend.classList.remove('is-hot');
    }
    if (this.options) this.setCenter(this.options.center);
    if (this.tipEl) this.tipEl.hidden = true;
  }

  private showTip(index: number, pointer?: { x: number; y: number }): void {
    const host = this.host;
    const tip = this.tipEl;
    const item = this.data[index];
    const options = this.options;
    const nodes = this.nodes[index];
    if (!host || !tip || !item || !options || !nodes) return;
    const total = this.data.reduce((sum, row) => sum + Math.max(0, row.value), 0);
    const ratio = total > 0 ? Math.max(0, item.value) / total : 0;
    tip.innerHTML = `<b>${escapeHtml(item.label)}</b><br />
      <span>${escapeHtml(item.valueText)}${escapeHtml(options.unit)} · 占 ${pctText(ratio)}</span>`;
    tip.hidden = false;

    // 位置：跟随指针（键盘聚焦时用扇区中点），再按容器边界夹紧，保证不超出窗口
    const hostRect = host.getBoundingClientRect();
    const arcRect = nodes.arc.getBoundingClientRect();
    const anchorX = (pointer?.x ?? arcRect.left + arcRect.width / 2) - hostRect.left;
    const anchorY = (pointer?.y ?? arcRect.top + arcRect.height / 2) - hostRect.top;
    const tipWidth = tip.offsetWidth;
    const tipHeight = tip.offsetHeight;
    let left = anchorX + 16;
    let top = anchorY - tipHeight - 12;
    if (left + tipWidth > hostRect.width) left = Math.max(0, anchorX - tipWidth - 16);
    if (top < 0) top = anchorY + 18;
    top = Math.min(top, Math.max(0, hostRect.height - tipHeight));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  private indexOf(target: EventTarget | null): number | null {
    const el = target instanceof Element ? target.closest<HTMLElement>('[data-pie-index]') : null;
    const raw = el?.dataset.pieIndex;
    if (raw === undefined) return null;
    const index = Number(raw);
    return Number.isInteger(index) && index >= 0 && index < this.data.length ? index : null;
  }

  private readonly handlePointerOver = (event: Event): void => {
    const index = this.indexOf(event.target);
    if (index === null || index === this.hot) return;
    const pointerEvent = event as PointerEvent;
    const point =
      typeof pointerEvent.clientX === 'number'
        ? { x: pointerEvent.clientX, y: pointerEvent.clientY }
        : undefined;
    this.applyHot(index, point);
  };

  private readonly handlePointerOut = (event: Event): void => {
    const related = (event as PointerEvent).relatedTarget;
    if (this.indexOf(related) !== null) return;
    this.clearHot();
  };

  private readonly handleFocusIn = (event: Event): void => {
    const index = this.indexOf(event.target);
    if (index !== null) this.applyHot(index);
  };

  private readonly handleFocusOut = (): void => {
    this.clearHot();
  };
}
