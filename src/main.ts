/**
 * 主入口 —— 只负责组装与启动，不放置任何业务逻辑。
 */

import './ui/styles.css';
import { Game } from './app/game';
import { describeError } from './core/errors';

/**
 * 旧版 Chromium（如 Edge 92）兼容：`structuredClone` 在 Chrome 98 才提供。
 *
 * 游戏状态与存档全部是普通对象/数组/基本值，因此用等价的递归深拷贝回退，
 * 保证 GameStore 的「一次提交整体成功或失败」语义在旧浏览器也可用。
 * 必须在构造 Game 之前执行；这只补浏览器缺失能力，不改变任何业务规则。
 */
if (typeof globalThis.structuredClone !== 'function') {
  const fallbackClone = <T>(value: T): T => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => fallbackClone(item)) as T;
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = fallbackClone(item);
    }
    return copy as T;
  };
  (globalThis as unknown as { structuredClone: <T>(value: T) => T }).structuredClone =
    fallbackClone;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少页面节点：#${id}`);
  return element as T;
}

function boot(): void {
  const bootScreen = requireElement<HTMLDivElement>('boot-screen');
  const bootHint = requireElement<HTMLParagraphElement>('boot-hint');
  const newButton = requireElement<HTMLButtonElement>('boot-new');
  const loadButton = requireElement<HTMLButtonElement>('boot-load');

  let game: Game;
  try {
    game = new Game({
      viewport: requireElement('viewport'),
      hudRoot: requireElement('hud-layer'),
      panelRoot: requireElement('panel-layer'),
      furnitureRoot: requireElement('furniture-layer'),
      toastRoot: requireElement('toast-layer'),
    });
  } catch (error) {
    bootHint.textContent = `初始化失败：${describeError(error)}。请确认浏览器已启用 WebGL。`;
    bootHint.style.color = '#f08c8c';
    return;
  }

  const enterGame = (): void => {
    bootScreen.classList.add('hidden');
    window.setTimeout(() => bootScreen.remove(), 320);
    game.start();
  };

  newButton.addEventListener('click', () => enterGame());

  loadButton.addEventListener('click', () => {
    void (async () => {
      try {
        const saved = await game.hasAnySave();
        if (!saved) {
          bootHint.textContent = '没有找到可用的存档，请先开始新游戏。';
          return;
        }
        await game.loadFromStorage(false);
        enterGame();
      } catch (error) {
        bootHint.textContent = `读取存档失败：${describeError(error)}`;
      }
    })();
  });

  bootHint.textContent = '正在检查本地存档…';
  void (async () => {
    try {
      const saved = await game.hasAnySave();
      loadButton.disabled = !saved;
      bootHint.textContent = saved ? '检测到本地存档。' : '暂无本地存档，请开始新游戏。';
    } catch (error) {
      loadButton.disabled = true;
      bootHint.textContent = `本地存档不可用：${describeError(error)}`;
    }
  })();
}

boot();
