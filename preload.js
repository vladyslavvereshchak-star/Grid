const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize:     () => ipcRenderer.send('win-minimize'),
  maximize:     () => ipcRenderer.send('win-maximize'),
  close:        () => ipcRenderer.send('win-close'),
  isMaximized:  () => ipcRenderer.sendSync('win-is-max'),
  notify:       (title, body) => ipcRenderer.send('notify', { title, body }),
  checkUpdates: () => ipcRenderer.send('check-updates'),
  platform:     process.platform,

  // Слушаем изменение maximize из main процесса
  onMaximizeChange: (cb) => ipcRenderer.on('maximize-change', (e, isMax) => cb(isMax)),

  // Слушаем статус обновления
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (e, data) => cb(data)),
  // Версия приложения
  getVersion: () => require('electron').app ? require('electron').app.getVersion() : ipcRenderer.sendSync('get-version'),
});
