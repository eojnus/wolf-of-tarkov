/**
 * 桌面平台适配层（渲染进程侧）。
 *
 * 只认识 preload 暴露的受限桥；不导入 Electron、Node.js 或 IPC。
 * 浏览器中不存在 `window.wolfDesktop`，调用方走原有行为。
 */

export interface DesktopBridge {
  readonly platform: string;
  onBeforeClose(handler: () => Promise<void> | void): void;
}

declare global {
  interface Window {
    readonly wolfDesktop?: DesktopBridge;
  }
}

/**
 * 注册窗口关闭前的等待回调（等待尚未完成的自动保存写入）。
 * 返回是否运行在 Electron 桌面壳中；浏览器返回 false，不改变任何行为。
 */
export function registerDesktopCloseHandler(handler: () => Promise<void> | void): boolean {
  const bridge = window.wolfDesktop;
  if (!bridge) return false;
  bridge.onBeforeClose(handler);
  return true;
}
