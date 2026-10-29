/**
 * 家具命令 —— 编辑态的唯一写入口。
 *
 * 每次操作都是一次 GameStore.run 原子提交；成功后请求原自动保存队列。
 * 这里不持有 Three.js、DOM 或相机；只验证当前住宅编辑会话，然后调用纯规则。
 */

import { BusinessError, describeError } from '../core/errors';
import type { GameStore } from '../core/store';
import {
  moveFurniture,
  placeFurniture,
  rotateFurniture,
  storeFurniture,
  type FurnitureCommandResult,
} from '../features/furniture';
import type { GameState } from './state';

export interface FurnitureCommandHooks {
  canEdit(): boolean;
  session(): number;
  requestAutoSave(): void;
}

export class FurnitureCommands {
  constructor(
    private readonly gameStore: GameStore<GameState>,
    private readonly hooks: FurnitureCommandHooks,
  ) {}

  move(session: number, id: string, cellX: number, cellZ: number): FurnitureCommandResult {
    return this.run(session, (draft) => moveFurniture(draft.furniture, id, cellX, cellZ));
  }

  rotate(session: number, id: string, direction: -1 | 1): FurnitureCommandResult {
    return this.run(session, (draft) => rotateFurniture(draft.furniture, id, direction));
  }

  store(session: number, id: string): FurnitureCommandResult {
    return this.run(session, (draft) => storeFurniture(draft.furniture, id));
  }

  place(session: number, id: string, cellX: number, cellZ: number): FurnitureCommandResult {
    return this.run(session, (draft) => placeFurniture(draft.furniture, id, cellX, cellZ));
  }

  private run(
    session: number,
    mutate: (draft: GameState) => void,
  ): FurnitureCommandResult {
    if (!this.hooks.canEdit() || this.hooks.session() !== session) {
      return { ok: false, message: '家具编辑会话已结束' };
    }
    try {
      this.gameStore.run((draft) => {
        if (draft.furniture.residenceId !== 'home-001') {
          throw new BusinessError('WRONG_RESIDENCE', '只能编辑当前个人住宅的家具');
        }
        mutate(draft);
      });
      this.hooks.requestAutoSave();
      return {
        ok: true,
        message: null,
        layout: this.gameStore.state.furniture,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof BusinessError ? error.message : describeError(error),
      };
    }
  }
}
