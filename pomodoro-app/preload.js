const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getState: () => ipcRenderer.invoke('get-state'),
  saveState: (data) => ipcRenderer.invoke('save-state', data),
  showNotification: (opts) => ipcRenderer.invoke('show-notification', opts),
  updateTrayTimer: (timeStr) => ipcRenderer.invoke('update-tray-timer', timeStr),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  getDataPath: () => ipcRenderer.invoke('get-data-path'),
});
