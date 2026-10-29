/**
 * 室内家具编辑器 —— 射线、选择、拖动预览、操作图标与俯视相机的唯一控制器。
 *
 * 只通过显式 commit 回调提交；不持有 GameStore，不直接改 GameState。
 * 相机仍是 World 的同一个 PerspectiveCamera。
 */

import * as THREE from 'three';
import {
  FURNITURE_CELL_SIZE,
  FURNITURE_DEFINITION_BY_ID,
  INTERIOR,
} from '../../content/interior';
import {
  cellCenter,
  cellFromCenter,
  footprintOf,
  type FurnitureCommandResult,
  type ReadonlyFurnitureState,
} from '../../features/furniture';
import type { InteriorRuntime } from './qingchuan';
import {
  FurnitureIconSet,
  type FurnitureIconAction,
} from './furniture-icons';

export interface FurnitureEditCommit {
  move(id: string, cellX: number, cellZ: number): FurnitureCommandResult;
  rotate(id: string, direction: -1 | 1): FurnitureCommandResult;
  store(id: string): FurnitureCommandResult;
  place(id: string, cellX: number, cellZ: number): FurnitureCommandResult;
}

export interface FurnitureCandidate {
  readonly id: string;
  readonly name: string;
}

export interface FurnitureEditCallbacks {
  onSelectionChange(id: string | null): void;
  onCandidatesChange(candidates: readonly FurnitureCandidate[]): void;
  notify(message: string): void;
}

export interface FurniturePanelRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface FurnitureEditorOptions {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly domElement: HTMLCanvasElement;
  readonly runtime: InteriorRuntime;
  readonly layout: ReadonlyFurnitureState;
  readonly commit: FurnitureEditCommit;
  readonly callbacks: FurnitureEditCallbacks;
}

interface PressedState {
  readonly id: string;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  dragging: boolean;
}

interface DragState {
  readonly id: string;
  readonly source: 'room' | 'warehouse';
  readonly pointerId: number;
  readonly offsetX: number;
  readonly offsetZ: number;
  readonly originalCellX: number;
  readonly originalCellZ: number;
  readonly originalTurn: number;
  previewCellX: number;
  previewCellZ: number;
  pointerX: number;
  pointerY: number;
  valid: boolean;
}

interface GhostEntry {
  readonly mesh: THREE.Mesh;
  readonly original: THREE.Material | THREE.Material[];
  readonly clone: THREE.Material | THREE.Material[];
}

const DRAG_THRESHOLD = 5;
const EDGE_ZONE = 44;
const EDGE_SPEED = 2.1;
/** 轻微南向偏移，接近俯视但让镜子等竖直面有可见面积。 */
const EDIT_TILT_Z = 0.75;

export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** 纯判定：右侧可操作视区止于仓库面板左缘。 */
export function edgePanDirection(input: {
  readonly pointerX: number;
  readonly pointerY: number;
  readonly canvas: ScreenRect;
  readonly rightEdge: number;
  readonly edgeZone: number;
  readonly insidePanel: boolean;
}): { dx: number; dz: number } {
  const { pointerX: x, pointerY: y, canvas, rightEdge, edgeZone, insidePanel } = input;
  if (insidePanel) return { dx: 0, dz: 0 };
  if (x < canvas.left || x > canvas.right || y < canvas.top || y > canvas.bottom) {
    return { dx: 0, dz: 0 };
  }
  if (x >= rightEdge) return { dx: 0, dz: 0 };
  let dx = 0;
  let dz = 0;
  if (x < canvas.left + edgeZone) dx -= 1;
  if (x > rightEdge - edgeZone) dx += 1;
  if (y < canvas.top + edgeZone) dz -= 1;
  if (y > canvas.bottom - edgeZone) dz += 1;
  return { dx, dz };
}

/** 纯判定：房间内表面以内（不含墙面）。 */
export function isRoomPoint(x: number, z: number): boolean {
  const halfWall = INTERIOR.room.wall / 2;
  return (
    x > halfWall &&
    x < INTERIOR.room.width - halfWall &&
    z > halfWall &&
    z < INTERIOR.room.depth - halfWall
  );
}

/** 仓库来源必须落在房间内；房间来源仍允许边界夹取。 */
export function canCommitDrop(input: {
  readonly source: 'room' | 'warehouse';
  readonly insideCanvas: boolean;
  readonly insidePanel: boolean;
  readonly insideRoom: boolean;
}): boolean {
  if (!input.insideCanvas || input.insidePanel) return false;
  return input.source === 'room' || input.insideRoom;
}

export class FurnitureEditor {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly domElement: HTMLCanvasElement;
  private readonly runtime: InteriorRuntime;
  private readonly commit: FurnitureEditCommit;
  private readonly callbacks: FurnitureEditCallbacks;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly target = new THREE.Vector3();
  private readonly originalUp = new THREE.Vector3();
  private layout: ReadonlyFurnitureState;

  private selectedId: string | null = null;
  private hoverId: string | null = null;
  private pressed: PressedState | null = null;
  private pressedIcon: {
    action: FurnitureIconAction;
    pointerId: number;
    startX: number;
    startY: number;
  } | null = null;
  private drag: DragState | null = null;
  private pointerActive = false;
  private pointerX = 0;
  private pointerY = 0;
  private panelRect: FurniturePanelRect | null = null;
  private panSuppressed = false;
  private readonly ghost: GhostEntry[] = [];

  private readonly grid: THREE.LineSegments;
  private readonly hoverOutline: THREE.LineLoop;
  private readonly selectedOutline: THREE.LineLoop;
  private readonly cellFill: THREE.Mesh;
  private readonly cellBorder: THREE.LineLoop;
  private readonly icons = new FurnitureIconSet();

  private readonly onPointerDown = (event: PointerEvent): void => this.handlePointerDown(event);
  private readonly onPointerMove = (event: PointerEvent): void => this.handlePointerMove(event);
  private readonly onPointerUp = (event: PointerEvent): void => this.handlePointerUp(event);
  private readonly onPointerCancel = (): void => this.cancelDrag();
  private readonly onLostPointerCapture = (): void => this.cancelDrag();
  private readonly onBlur = (): void => this.cancelDrag();
  private readonly onVisibility = (): void => {
    if (document.hidden) this.cancelDrag();
  };
  private readonly onContextMenu = (event: MouseEvent): void => event.preventDefault();

  constructor(options: FurnitureEditorOptions) {
    this.scene = options.scene;
    this.camera = options.camera;
    this.domElement = options.domElement;
    this.runtime = options.runtime;
    this.commit = options.commit;
    this.callbacks = options.callbacks;
    this.layout = options.layout;
    this.originalUp.copy(this.camera.up);

    this.target.set(INTERIOR.room.width / 2, 0, INTERIOR.room.depth / 2);
    this.grid = this.buildGrid();
    this.hoverOutline = this.buildOutline(0x4fb3c4, 0.42);
    this.selectedOutline = this.buildOutline(0x4fb3c4, 0.95);
    this.cellFill = this.buildCellFill();
    this.cellBorder = this.buildOutline(0x7ed3e0, 0.95, 0.012);
    this.scene.add(this.grid, this.hoverOutline, this.selectedOutline, this.cellFill, this.cellBorder);
    this.scene.add(this.icons.root);
    this.grid.visible = true;

    this.domElement.style.touchAction = 'none';
    this.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.domElement.addEventListener('contextmenu', this.onContextMenu);
    this.domElement.addEventListener('lostpointercapture', this.onLostPointerCapture);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerCancel);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);

    this.applyCamera();
  }

  setPanelRect(rect: FurniturePanelRect | null): void {
    this.panelRect = rect;
    this.applyCamera();
  }

  setLayout(layout: ReadonlyFurnitureState): void {
    this.layout = layout;
    if (this.selectedId && layout.items[this.selectedId]?.status !== 'placed') {
      this.selectedId = null;
      this.publishCandidates([]);
      this.callbacks.onSelectionChange(null);
    }
    this.refreshOutlines();
    this.refreshIcons();
  }

  update(dtSeconds: number, paused: boolean): void {
    if (this.pointerActive && !paused && !document.hidden && !this.panSuppressed) {
      this.applyEdgePan(dtSeconds);
    }
    this.applyCamera();
    if (this.drag) {
      this.updateDragFromPointer(this.drag.pointerX, this.drag.pointerY);
    } else if (this.pointerActive && !this.pressed && !this.pressedIcon) {
      this.updateHover(this.pointerX, this.pointerY);
    }
    this.refreshIcons();
  }

  resize(): void {
    this.applyCamera();
  }

  startWarehouseDrag(id: string, pointerId: number, clientX: number, clientY: number): void {
    const item = this.layout.items[id];
    if (!item || item.status !== 'stored') return;
    const root = this.runtime.furnitureRoots.get(id);
    if (!root) return;
    if (!root.parent) this.scene.add(root);
    this.pointerX = clientX;
    this.pointerY = clientY;
    this.pointerActive = true;
    this.setGhost(id, true);
    this.drag = {
      id,
      source: 'warehouse',
      pointerId,
      offsetX: 0,
      offsetZ: 0,
      originalCellX: item.cellX,
      originalCellZ: item.cellZ,
      originalTurn: item.quarterTurn,
      previewCellX: item.cellX,
      previewCellZ: item.cellZ,
      pointerX: clientX,
      pointerY: clientY,
      valid: false,
    };
    this.icons.setVisible(false);
    this.updateDragFromPointer(clientX, clientY);
  }

  updateWarehouseDrag(pointerId: number, clientX: number, clientY: number): void {
    if (!this.drag || this.drag.pointerId !== pointerId || this.drag.source !== 'warehouse') {
      return;
    }
    this.pointerX = clientX;
    this.pointerY = clientY;
    this.drag.pointerX = clientX;
    this.drag.pointerY = clientY;
    this.updateDragFromPointer(clientX, clientY);
  }

  endWarehouseDrag(pointerId: number, clientX: number, clientY: number): void {
    if (!this.drag || this.drag.pointerId !== pointerId || this.drag.source !== 'warehouse') {
      return;
    }
    this.drag.pointerX = clientX;
    this.drag.pointerY = clientY;
    this.updateDragFromPointer(clientX, clientY);
    this.finishDrag();
  }

  cancelDrag(): void {
    this.panSuppressed = false;
    const drag = this.drag;
    if (!drag) {
      this.clearPressed();
      return;
    }
    const root = this.runtime.furnitureRoots.get(drag.id);
    this.restoreGhost();
    if (root) {
      if (drag.source === 'warehouse') {
        if (root.parent === this.scene) this.scene.remove(root);
      } else {
        const item = this.layout.items[drag.id];
        if (item) {
          const span = footprintOf(item);
          const center = cellCenter(drag.originalCellX, drag.originalCellZ, span);
          root.position.set(center.x, 0, center.z);
          root.rotation.y = (Math.PI / 2) * drag.originalTurn;
        }
      }
    }
    this.drag = null;
    this.clearPressed();
    this.hideCellPreview();
    this.refreshIcons();
  }

  dispose(): void {
    this.cancelDrag();
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement.removeEventListener('contextmenu', this.onContextMenu);
    this.domElement.removeEventListener('lostpointercapture', this.onLostPointerCapture);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerCancel);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.icons.dispose();
    for (const object of [
      this.grid,
      this.hoverOutline,
      this.selectedOutline,
      this.cellFill,
      this.cellBorder,
      this.icons.root,
    ]) {
      this.scene.remove(object);
    }
    for (const object of [this.grid, this.selectedOutline, this.hoverOutline, this.cellBorder]) {
      object.geometry.dispose();
      const material = object.material;
      if (Array.isArray(material)) for (const item of material) item.dispose();
      else material.dispose();
    }
    this.cellFill.geometry.dispose();
    const fillMaterial = this.cellFill.material;
    if (Array.isArray(fillMaterial)) for (const item of fillMaterial) item.dispose();
    else fillMaterial.dispose();
    this.camera.up.copy(this.originalUp);
    this.camera.updateMatrixWorld(true);
    this.domElement.style.cursor = '';
    this.domElement.style.touchAction = '';
  }

  private buildGrid(): THREE.LineSegments {
    const positions: number[] = [];
    const y = 0.007;
    for (let x = 0; x <= INTERIOR.room.width + 1e-6; x += 0.25) {
      positions.push(x, y, 0, x, y, INTERIOR.room.depth);
    }
    for (let z = 0; z <= INTERIOR.room.depth + 1e-6; z += 0.25) {
      positions.push(0, y, z, INTERIOR.room.width, y, z);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color: 0x4fb3c4,
      transparent: true,
      opacity: 0.07,
      depthWrite: false,
    });
    const grid = new THREE.LineSegments(geometry, material);
    grid.renderOrder = 2;
    return grid;
  }

  private buildOutline(
    color: number,
    opacity: number,
    y = 0.015,
  ): THREE.LineLoop {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Array(12).fill(0), 3));
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
    });
    const line = new THREE.LineLoop(geometry, material);
    line.position.y = y;
    line.renderOrder = 3;
    line.visible = false;
    return line;
  }

  private buildCellFill(): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0x4fb3c4,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.011;
    mesh.renderOrder = 2;
    mesh.visible = false;
    return mesh;
  }

  private applyEdgePan(dtSeconds: number): void {
    const rect = this.domElement.getBoundingClientRect();
    // 右侧可操作视区止于仓库面板左缘；面板内部与面板遮挡区不触发平移。
    const rightEdge = this.panelRect
      ? Math.min(rect.right, this.panelRect.left)
      : rect.right;
    const intent = edgePanDirection({
      pointerX: this.pointerX,
      pointerY: this.pointerY,
      canvas: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      },
      rightEdge,
      edgeZone: EDGE_ZONE,
      insidePanel: this.pointInPanel(this.pointerX, this.pointerY),
    });
    if (intent.dx === 0 && intent.dz === 0) return;
    const step = EDGE_SPEED * Math.max(0, dtSeconds);
    this.target.x = THREE.MathUtils.clamp(this.target.x + intent.dx * step, 0.95, 2.35);
    this.target.z = THREE.MathUtils.clamp(this.target.z + intent.dz * step, 1.8, 4.4);
  }

  private applyCamera(): void {
    const rect = this.domElement.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const panelWidth = this.panelRect
      ? Math.min(this.panelRect.width, width * 0.45)
      : 0;
    const visibleFraction = Math.max(0.35, 1 - panelWidth / width);
    const aspect = width / height;
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const tan = Math.tan(halfFov);
    let cameraHeight = Math.max(6.6, (INTERIOR.room.depth / 2) / tan * 1.12);
    const required = (INTERIOR.room.width * 1.2) / (2 * tan * aspect * visibleFraction);
    cameraHeight = Math.max(cameraHeight, required);
    const worldWidth = 2 * cameraHeight * tan * aspect;
    // 只做有限的取景平移，保证俯视相机仍在房间内；否则射线会从墙体内出发，
    // 所有家具都会被固定壳体误判为“被墙挡住”。
    const shift = Math.min((worldWidth * (panelWidth / width)) / 2, 0.9);
    const lookX = THREE.MathUtils.clamp(
      this.target.x + shift,
      0.6,
      INTERIOR.room.width - 0.6,
    );
    this.camera.position.set(lookX, cameraHeight, this.target.z + EDIT_TILT_Z);
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(lookX, 0, this.target.z);
    this.camera.updateMatrixWorld(true);
    this.camera.updateProjectionMatrix();
  }

  private setPointer(clientX: number, clientY: number): void {
    this.pointerX = clientX;
    this.pointerY = clientY;
    this.pointerActive = true;
  }

  private updatePointerRay(clientX: number, clientY: number): void {
    const rect = this.domElement.getBoundingClientRect();
    this.ndc.set(
      ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
  }

  private handlePointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    if (this.pointInPanel(event.clientX, event.clientY)) return;
    this.setPointer(event.clientX, event.clientY);
    this.updatePointerRay(event.clientX, event.clientY);
    const icon = this.icons.pick(this.raycaster);
    if (icon) {
      this.panSuppressed = true;
      this.pressedIcon = {
        action: icon,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
      this.domElement.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }
    const candidates = this.pickFurnitureCandidates();
    this.publishCandidates(candidates);
    const hit = candidates[0];
    if (!hit) {
      this.publishCandidates([]);
      this.select(null);
      return;
    }
    this.select(hit.id);
    this.pressed = {
      id: hit.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
    this.domElement.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  private handlePointerMove(event: PointerEvent): void {
    this.setPointer(event.clientX, event.clientY);
    if (this.pressedIcon) {
      if (
        Math.hypot(
          event.clientX - this.pressedIcon.startX,
          event.clientY - this.pressedIcon.startY,
        ) > DRAG_THRESHOLD
      ) {
        this.pressedIcon = null;
        this.panSuppressed = false;
      }
      return;
    }
    if (this.drag) {
      if (this.drag.source === 'warehouse') return;
      this.drag.pointerX = event.clientX;
      this.drag.pointerY = event.clientY;
      this.updateDragFromPointer(event.clientX, event.clientY);
      return;
    }
    if (this.pressed) {
      if (
        !this.pressed.dragging &&
        Math.hypot(
          event.clientX - this.pressed.startX,
          event.clientY - this.pressed.startY,
        ) > DRAG_THRESHOLD
      ) {
        this.beginRoomDrag(this.pressed.id, this.pressed.pointerId, event.clientX, event.clientY);
      }
      return;
    }
    this.updateHover(event.clientX, event.clientY);
  }

  private handlePointerUp(event: PointerEvent): void {
    this.setPointer(event.clientX, event.clientY);
    if (this.drag?.source === 'warehouse') {
      // 仓库拖动由 FurniturePanel 捕获并调用 endWarehouseDrag，避免双重提交。
      return;
    }
    if (this.pressedIcon) {
      this.updatePointerRay(event.clientX, event.clientY);
      const icon = this.icons.pick(this.raycaster);
      const action = this.pressedIcon.action;
      const pointerId = this.pressedIcon.pointerId;
      this.pressedIcon = null;
      this.panSuppressed = false;
      if (icon === action && pointerId === event.pointerId) {
        this.executeIcon(action);
      }
      this.releasePointer(event.pointerId);
      return;
    }
    if (this.drag) {
      this.drag.pointerX = event.clientX;
      this.drag.pointerY = event.clientY;
      this.updateDragFromPointer(event.clientX, event.clientY);
      this.finishDrag();
      this.releasePointer(event.pointerId);
      return;
    }
    this.clearPressed();
    this.releasePointer(event.pointerId);
  }

  private clearPressed(): void {
    this.pressed = null;
    this.pressedIcon = null;
  }

  private releasePointer(pointerId: number): void {
    if (this.domElement.hasPointerCapture?.(pointerId)) {
      this.domElement.releasePointerCapture(pointerId);
    }
  }

  private beginRoomDrag(
    id: string,
    pointerId: number,
    clientX: number,
    clientY: number,
  ): void {
    const item = this.layout.items[id];
    if (!item || item.status !== 'placed') return;
    const root = this.runtime.furnitureRoots.get(id);
    if (!root) return;
    const definition = FURNITURE_DEFINITION_BY_ID[item.definitionId];
    const point = this.planePoint(clientX, clientY, definition.dragHeight);
    if (!point) return;
    const span = footprintOf(item);
    const center = cellCenter(item.cellX, item.cellZ, span);
    this.setGhost(id, true);
    this.drag = {
      id,
      source: 'room',
      pointerId,
      offsetX: center.x - point.x,
      offsetZ: center.z - point.z,
      originalCellX: item.cellX,
      originalCellZ: item.cellZ,
      originalTurn: item.quarterTurn,
      previewCellX: item.cellX,
      previewCellZ: item.cellZ,
      pointerX: clientX,
      pointerY: clientY,
      valid: true,
    };
    if (this.pressed) this.pressed.dragging = true;
    this.icons.setVisible(false);
    this.updateDragFromPointer(clientX, clientY);
  }

  private updateDragFromPointer(clientX: number, clientY: number): void {
    const drag = this.drag;
    if (!drag) return;
    const item = this.layout.items[drag.id];
    if (!item) return;
    const definition = FURNITURE_DEFINITION_BY_ID[item.definitionId];
    const point = this.planePoint(clientX, clientY, definition.dragHeight);
    if (!point) return;
    const span = footprintOf(item);
    const centerX = point.x + drag.offsetX;
    const centerZ = point.z + drag.offsetZ;
    const cell = cellFromCenter(centerX, centerZ, span);
    drag.previewCellX = cell.cellX;
    drag.previewCellZ = cell.cellZ;
    drag.valid = canCommitDrop({
      source: drag.source,
      insideCanvas: this.pointInCanvas(clientX, clientY),
      insidePanel: this.pointInPanel(clientX, clientY),
      insideRoom: this.pointInRoom(point),
    });
    const root = this.runtime.furnitureRoots.get(drag.id);
    if (root) {
      const center = cellCenter(cell.cellX, cell.cellZ, span);
      root.position.set(center.x, 0, center.z);
      root.visible = drag.source === 'room' || drag.valid;
    }
    if (drag.source === 'warehouse' && !drag.valid) {
      this.cellFill.visible = false;
      this.cellBorder.visible = false;
      this.hoverOutline.visible = false;
    } else {
      this.showCellPreview(cell.cellX, cell.cellZ, span);
    }
  }

  private finishDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    const item = this.layout.items[drag.id];
    if (!item) {
      this.cancelDrag();
      return;
    }
    // pointerup 时同步重算一次，验证与提交必须使用同一个最终投影。
    const definition = FURNITURE_DEFINITION_BY_ID[item.definitionId];
    const point = this.planePoint(drag.pointerX, drag.pointerY, definition.dragHeight);
    if (!point) {
      this.cancelDrag();
      return;
    }
    if (
      !canCommitDrop({
        source: drag.source,
        insideCanvas: this.pointInCanvas(drag.pointerX, drag.pointerY),
        insidePanel: this.pointInPanel(drag.pointerX, drag.pointerY),
        insideRoom: this.pointInRoom(point),
      })
    ) {
      this.cancelDrag();
      return;
    }
    const span = footprintOf(item);
    const finalCell = cellFromCenter(
      point.x + drag.offsetX,
      point.z + drag.offsetZ,
      span,
    );
    const result =
      drag.source === 'room'
        ? this.commit.move(drag.id, finalCell.cellX, finalCell.cellZ)
        : this.commit.place(drag.id, finalCell.cellX, finalCell.cellZ);
    this.restoreGhost();
    this.drag = null;
    this.hideCellPreview();
    this.clearPressed();
    if (!result.ok || !result.layout) {
      if (drag.source === 'warehouse') {
        const root = this.runtime.furnitureRoots.get(drag.id);
        if (root?.parent === this.scene) this.scene.remove(root);
      } else {
        const root = this.runtime.furnitureRoots.get(drag.id);
        if (root) {
          const current = this.layout.items[drag.id];
          if (current) {
            const oldSpan = footprintOf(current);
            const center = cellCenter(current.cellX, current.cellZ, oldSpan);
            root.position.set(center.x, 0, center.z);
            root.rotation.y = (Math.PI / 2) * current.quarterTurn;
          }
        }
      }
      if (result.message) this.callbacks.notify(result.message);
      this.refreshIcons();
      return;
    }
    this.setLayout(result.layout);
    this.select(drag.id);
    this.refreshIcons();
  }

  private planePoint(
    clientX: number,
    clientY: number,
    planeHeight: number,
  ): THREE.Vector3 | null {
    this.updatePointerRay(clientX, clientY);
    this.plane.constant = -planeHeight;
    const point = this.raycaster.ray.intersectPlane(this.plane, new THREE.Vector3());
    return point;
  }

  private pickFurnitureCandidates(): Array<{
    id: string;
    name: string;
    distance: number;
  }> {
    const roots: THREE.Object3D[] = [];
    for (const item of Object.values(this.layout.items)) {
      if (item.status !== 'placed') continue;
      const root = this.runtime.furnitureRoots.get(item.id);
      if (root && root.parent === this.scene) roots.push(root);
    }
    const hits = this.raycaster.intersectObjects(roots, true);
    const seen = new Set<string>();
    const candidates: Array<{ id: string; name: string; distance: number }> = [];
    for (const hit of hits) {
      if (this.blockedByShell(hit.distance)) continue;
      let object: THREE.Object3D | null = hit.object;
      while (object && !object.userData.furnitureId) object = object.parent;
      const id = object?.userData.furnitureId;
      if (typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      const item = this.layout.items[id];
      const definition = item ? FURNITURE_DEFINITION_BY_ID[item.definitionId] : undefined;
      if (!definition) continue;
      candidates.push({ id, name: definition.name, distance: hit.distance });
    }
    return candidates;
  }

  private pickFurniture(): { id: string; distance: number } | null {
    const candidate = this.pickFurnitureCandidates()[0];
    return candidate ? { id: candidate.id, distance: candidate.distance } : null;
  }

  private publishCandidates(
    candidates: Array<{ id: string; name: string }>,
  ): void {
    this.callbacks.onCandidatesChange(
      candidates.map((candidate) => ({ id: candidate.id, name: candidate.name })),
    );
  }

  selectById(id: string): void {
    if (this.layout.items[id]?.status !== 'placed') return;
    this.select(id);
  }

  private blockedByShell(distance: number): boolean {
    const ray = this.raycaster.ray;
    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    for (const collider of this.runtime.editShellOccluders) {
      // 编辑态隐藏天花与门头；只把落地墙体/门扇当作遮挡。
      if (collider.minY > 0.05) continue;
      box.min.set(collider.minX, collider.minY, collider.minZ);
      box.max.set(collider.maxX, collider.maxY, collider.maxZ);
      if (ray.intersectBox(box, point)) {
        if (ray.origin.distanceTo(point) < distance - 0.002) return true;
      }
    }
    return false;
  }

  private updateHover(clientX: number, clientY: number): void {
    if (this.pointInPanel(clientX, clientY) || !this.pointInCanvas(clientX, clientY)) {
      this.icons.setHover(null);
      this.setHover(null);
      this.domElement.style.cursor = '';
      return;
    }
    this.updatePointerRay(clientX, clientY);
    const icon = this.icons.pick(this.raycaster);
    if (icon) {
      this.icons.setHover(icon);
      this.domElement.style.cursor = 'pointer';
      this.setHover(null);
      return;
    }
    this.icons.setHover(null);
    const hit = this.pickFurniture();
    this.setHover(hit?.id ?? null);
    this.domElement.style.cursor = hit ? 'grab' : '';
  }

  private setHover(id: string | null): void {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this.refreshOutlines();
  }

  private select(id: string | null): void {
    if (id && this.layout.items[id]?.status !== 'placed') id = null;
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.callbacks.onSelectionChange(id);
    this.refreshOutlines();
    this.refreshIcons();
  }

  private refreshOutlines(): void {
    const selected = this.selectedId ? this.layout.items[this.selectedId] : null;
    if (selected && selected.status === 'placed') {
      this.showRect(this.selectedOutline, selected.cellX, selected.cellZ, footprintOf(selected));
      this.selectedOutline.visible = true;
    } else {
      this.selectedOutline.visible = false;
    }
    const hovered =
      this.hoverId && this.hoverId !== this.selectedId
        ? this.layout.items[this.hoverId]
        : null;
    if (hovered && hovered.status === 'placed') {
      this.showRect(this.hoverOutline, hovered.cellX, hovered.cellZ, footprintOf(hovered));
      this.hoverOutline.visible = true;
    } else {
      this.hoverOutline.visible = false;
    }
  }

  private refreshIcons(): void {
    const item = this.selectedId ? this.layout.items[this.selectedId] : null;
    if (!item || item.status !== 'placed' || this.drag) {
      this.icons.setVisible(false);
      return;
    }
    const span = footprintOf(item);
    const center = cellCenter(item.cellX, item.cellZ, span);
    const anchorZ = Math.min(
      INTERIOR.room.depth - 0.18,
      center.z + span.depth * FURNITURE_CELL_SIZE / 2 + 0.16,
    );
    this.icons.placeAt(new THREE.Vector3(center.x, 0.05, anchorZ), this.camera);
  }

  private showCellPreview(
    cellX: number,
    cellZ: number,
    span: { width: number; depth: number },
  ): void {
    const minX = cellX * FURNITURE_CELL_SIZE;
    const minZ = cellZ * FURNITURE_CELL_SIZE;
    const maxX = (cellX + span.width) * FURNITURE_CELL_SIZE;
    const maxZ = (cellZ + span.depth) * FURNITURE_CELL_SIZE;
    this.cellFill.position.set((minX + maxX) / 2, 0.011, (minZ + maxZ) / 2);
    this.cellFill.scale.set(maxX - minX, maxZ - minZ, 1);
    this.cellFill.visible = true;
    this.showRectDirect(this.cellBorder, minX, maxX, minZ, maxZ);
    this.cellBorder.visible = true;
    this.selectedOutline.visible = false;
    this.hoverOutline.visible = false;
  }

  private hideCellPreview(): void {
    this.cellFill.visible = false;
    this.cellBorder.visible = false;
    this.refreshOutlines();
  }

  private showRect(
    line: THREE.LineLoop,
    cellX: number,
    cellZ: number,
    span: { width: number; depth: number },
  ): void {
    this.showRectDirect(
      line,
      cellX * FURNITURE_CELL_SIZE,
      (cellX + span.width) * FURNITURE_CELL_SIZE,
      cellZ * FURNITURE_CELL_SIZE,
      (cellZ + span.depth) * FURNITURE_CELL_SIZE,
    );
  }

  private showRectDirect(
    line: THREE.LineLoop,
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
  ): void {
    const attribute = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    attribute.setXYZ(0, minX, 0, minZ);
    attribute.setXYZ(1, maxX, 0, minZ);
    attribute.setXYZ(2, maxX, 0, maxZ);
    attribute.setXYZ(3, minX, 0, maxZ);
    attribute.needsUpdate = true;
    line.geometry.computeBoundingSphere();
  }

  private executeIcon(action: FurnitureIconAction): void {
    const id = this.selectedId;
    if (!id) return;
    const result =
      action === 'store'
        ? this.commit.store(id)
        : this.commit.rotate(id, action === 'rotate-left' ? -1 : 1);
    if (!result.ok || !result.layout) {
      if (result.message) this.callbacks.notify(result.message);
      return;
    }
    this.setLayout(result.layout);
    if (action === 'store') this.select(null);
    else this.select(id);
  }

  private setGhost(id: string, active: boolean): void {
    this.restoreGhost();
    if (!active) return;
    const root = this.runtime.furnitureRoots.get(id);
    if (!root) return;
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const original = mesh.material;
      const clone = Array.isArray(original)
        ? original.map((item) => item.clone())
        : original.clone();
      const list = Array.isArray(clone) ? clone : [clone];
      for (const material of list) {
        material.transparent = true;
        material.opacity = Math.min(
          typeof material.opacity === 'number' ? material.opacity : 1,
          0.55,
        );
        material.depthWrite = false;
        material.needsUpdate = true;
      }
      mesh.material = clone;
      this.ghost.push({ mesh, original, clone });
    });
  }

  private restoreGhost(): void {
    for (const entry of this.ghost) {
      entry.mesh.material = entry.original;
      const list = Array.isArray(entry.clone) ? entry.clone : [entry.clone];
      for (const material of list) material.dispose();
    }
    this.ghost.length = 0;
  }

  private pointInRoom(point: THREE.Vector3): boolean {
    return isRoomPoint(point.x, point.z);
  }

  private pointInPanel(x: number, y: number): boolean {
    const rect = this.panelRect;
    return !!rect && x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height;
  }

  private pointInCanvas(x: number, y: number): boolean {
    const rect = this.domElement.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }
}
