const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tdDesktop', {
  readProfile: () => ipcRenderer.sendSync('td:profile:read'),
  writeProfile: (raw) => ipcRenderer.sendSync('td:profile:write', raw),
  display: (mode, resolution) => ipcRenderer.invoke('td:display', mode, resolution),
});
