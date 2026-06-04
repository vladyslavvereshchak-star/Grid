const { contextBridge, ipcRenderer } = require('electron');

// Безопасный мост между renderer (index.html) и main процессом
contextBridge.exposeInMainWorld('electronAPI', {
  minimize:  () => ipcRenderer.send('win-minimize'),
  maximize:  () => ipcRenderer.send('win-maximize'),
  close:     () => ipcRenderer.send('win-close'),
  isMaximized: () => ipcRenderer.sendSync('win-is-max'),
  notify:    (title, body) => ipcRenderer.send('notify', { title, body }),
  platform:  process.platform,
});
