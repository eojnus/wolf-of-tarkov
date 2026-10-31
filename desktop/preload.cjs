'use strict';

/**
 * 沙箱 preload：只暴露「窗口关闭前等待异步写入结束」这一项能力。
 *
 * 不暴露 ipcRenderer、send/invoke、文件系统、shell 或任意 IPC 通道。
 * 游戏尚未注册回调时，关闭请求立即确认，避免主进程无谓等待。
 */

const { contextBridge, ipcRenderer } = require('electron');

let closeHandler = null;

ipcRenderer.on('desktop:before-close', () => {
  Promise.resolve()
    .then(() => (closeHandler ? closeHandler() : undefined))
    .catch(() => {
      /* 写入失败由游戏内提示负责；主进程超时后仍会关闭 */
    })
    .finally(() => {
      ipcRenderer.send('desktop:close-ready');
    });
});

contextBridge.exposeInMainWorld('wolfDesktop', {
  platform: process.platform,
  onBeforeClose(handler) {
    if (typeof handler !== 'function' || closeHandler) return;
    closeHandler = handler;
  },
});
