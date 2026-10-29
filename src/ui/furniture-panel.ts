/**
 * 家具仓库面板 —— 独立于 PanelManager 的右侧浮层。
 *
 * 只渲染已收纳实例并发起拖动意图；不读 GameState、不写世界。
 */

import { FURNITURE_DEFINITION_BY_ID } from '../content/interior';
import type { ReadonlyFurnitureState } from '../features/furniture';

export interface FurniturePanelHandlers {
  onExit(): void;
  onWarehouseDragStart(id: string, pointerId: number, clientX: number, clientY: number): void;
  onWarehouseDragMove(pointerId: number, clientX: number, clientY: number): void;
  onWarehouseDragEnd(pointerId: number, clientX: number, clientY: number): void;
  onWarehouseDragCancel(): void;
  onCandidateSelect(id: string): void;
  onResize(): void;
}

export class FurniturePanel {
  private readonly root: HTMLElement;
  private readonly handlers: FurniturePanelHandlers;
  private readonly section: HTMLElement;
  private readonly list: HTMLElement;
  private readonly candidates: HTMLElement;
  private readonly selected: HTMLElement;
  private layout: ReadonlyFurnitureState | null = null;
  private drag: { id: string; pointerId: number } | null = null;
  private readonly onResize = (): void => this.handlers.onResize();
  private readonly onWindowBlur = (): void => this.cancelDrag();
  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.handlers.onWarehouseDragMove(event.pointerId, event.clientX, event.clientY);
  };
  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.handlers.onWarehouseDragEnd(event.pointerId, event.clientX, event.clientY);
    this.endDrag();
  };
  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.handlers.onWarehouseDragCancel();
    this.endDrag();
  };
  private readonly onLostPointerCapture = (): void => {
    if (!this.drag) return;
    this.handlers.onWarehouseDragCancel();
    this.endDrag();
  };
  private readonly handleCandidateClick = (event: MouseEvent): void => {
    const target = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-candidate-id]',
    );
    const id = target?.dataset.candidateId;
    if (!id) return;
    event.preventDefault();
    this.handlers.onCandidateSelect(id);
  };

  constructor(root: HTMLElement, handlers: FurniturePanelHandlers) {
    this.root = root;
    this.handlers = handlers;
    this.section = document.createElement('section');
    this.section.className = 'furniture-panel';
    this.section.setAttribute('role', 'dialog');
    this.section.setAttribute('aria-label', '家具仓库');
    this.section.hidden = true;
    this.section.innerHTML = `
      <header class="furniture-panel-head">
        <div>
          <p class="furniture-kicker">个人住宅</p>
          <h2>家具仓库</h2>
        </div>
        <button type="button" class="furniture-done" data-furniture-close>完成</button>
      </header>
      <p class="furniture-help">拖动卡片到房间摆放 · E 或 Esc 退出编辑</p>
      <p class="furniture-selected" data-furniture-selected hidden></p>
      <div class="furniture-candidates" data-furniture-candidates hidden></div>
      <div class="furniture-list" data-furniture-list></div>
    `;
    this.root.appendChild(this.section);
    this.list = this.section.querySelector<HTMLElement>('[data-furniture-list]')!;
    this.candidates = this.section.querySelector<HTMLElement>(
      '[data-furniture-candidates]',
    )!;
    this.selected = this.section.querySelector<HTMLElement>(
      '[data-furniture-selected]',
    )!;
    this.candidates.addEventListener('click', this.handleCandidateClick);
    this.section
      .querySelector<HTMLElement>('[data-furniture-close]')
      ?.addEventListener('click', () => this.handlers.onExit());
    this.root.addEventListener('pointermove', this.onPointerMove);
    this.root.addEventListener('pointerup', this.onPointerUp);
    this.root.addEventListener('pointercancel', this.onPointerCancel);
    this.root.addEventListener('lostpointercapture', this.onLostPointerCapture);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('blur', this.onWindowBlur);
    this.list.addEventListener('pointerdown', this.handlePointerDown);
  }

  show(layout: ReadonlyFurnitureState): void {
    this.layout = layout;
    this.section.hidden = false;
    this.render();
    this.handlers.onResize();
  }

  hide(): void {
    this.endDrag();
    this.setSelection(null);
    this.setCandidates([]);
    this.section.hidden = true;
  }

  update(layout: ReadonlyFurnitureState): void {
    this.layout = layout;
    if (!this.section.hidden) this.render();
  }

  setSelection(name: string | null): void {
    this.selected.hidden = !name;
    this.selected.textContent = name ? `已选中：${name}` : '';
  }

  setCandidates(candidates: readonly { id: string; name: string }[]): void {
    if (candidates.length <= 1) {
      this.candidates.hidden = true;
      this.candidates.innerHTML = '';
      return;
    }
    this.candidates.hidden = false;
    this.candidates.innerHTML = candidates
      .map(
        (candidate) =>
          `<button type="button" class="furniture-candidate" data-candidate-id="${candidate.id}">${candidate.name}</button>`,
      )
      .join('');
  }

  getRect(): DOMRect {
    return this.section.getBoundingClientRect();
  }

  cancelDrag(): void {
    if (!this.drag) return;
    this.handlers.onWarehouseDragCancel();
    this.endDrag();
  }

  dispose(): void {
    this.endDrag();
    this.root.removeEventListener('pointermove', this.onPointerMove);
    this.root.removeEventListener('pointerup', this.onPointerUp);
    this.root.removeEventListener('pointercancel', this.onPointerCancel);
    this.root.removeEventListener('lostpointercapture', this.onLostPointerCapture);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('blur', this.onWindowBlur);
    this.list.removeEventListener('pointerdown', this.handlePointerDown);
    this.candidates.removeEventListener('click', this.handleCandidateClick);
    this.section.remove();
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-furniture-id]');
    const id = target?.dataset.furnitureId;
    if (!id || !this.layout) return;
    event.preventDefault();
    event.stopPropagation();
    this.drag = { id, pointerId: event.pointerId };
    target.classList.add('is-dragging');
    target.setPointerCapture?.(event.pointerId);
    this.handlers.onWarehouseDragStart(id, event.pointerId, event.clientX, event.clientY);
  };

  private endDrag(): void {
    if (!this.drag) return;
    this.section
      .querySelectorAll<HTMLElement>('[data-furniture-id].is-dragging')
      .forEach((node) => node.classList.remove('is-dragging'));
    this.drag = null;
  }

  private render(): void {
    if (!this.layout) return;
    const stored = Object.values(this.layout.items)
      .filter((item) => item.status === 'stored')
      .sort((a, b) => a.definitionId.localeCompare(b.definitionId));
    if (this.drag) this.endDrag();
    if (stored.length === 0) {
      this.list.innerHTML = `
        <div class="furniture-empty">
          <p class="furniture-empty-title">仓库为空</p>
          <p class="furniture-empty-hint">在房间中选中家具后可收纳</p>
        </div>
      `;
      return;
    }
    this.list.innerHTML = stored
      .map(
        (item) => `
          <button type="button" class="furniture-card" data-furniture-id="${item.id}">
            <span class="furniture-card-name">${nameOf(item.definitionId)}</span>
            <span class="furniture-card-meta">已收纳</span>
          </button>
        `,
      )
      .join('');
  }
}

function nameOf(definitionId: string): string {
  return FURNITURE_DEFINITION_BY_ID[definitionId]?.name ?? definitionId;
}
