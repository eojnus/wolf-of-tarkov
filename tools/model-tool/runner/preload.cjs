// 唯一暴露给渲染页的能力：提交结果、写输出目录内的新文件。
// 没有 fs、没有 child_process、没有任意 IPC 通道。
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('modelTool', {
  submit(result) {
    return ipcRenderer.invoke('model-tool:submit', result);
  },
  write(payload) {
    return ipcRenderer.invoke('model-tool:write', payload);
  },
});
