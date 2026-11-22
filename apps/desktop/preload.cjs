/** What the till page may ask of the desktop app (window.tillDesktop); see web/src/pos/platform.ts. */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tillDesktop', {
  version: (process.argv.find((a) => a.startsWith('--till-version=')) || '').slice('--till-version='.length),
  os: process.platform,
  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
    remove: (key) => ipcRenderer.invoke('store:remove', key),
  },
  printers: {
    list: () => ipcRenderer.invoke('printers:list'),
    printHtml: (html, options) => ipcRenderer.invoke('printers:printHtml', html, options),
    sendNetwork: (host, port, data) => ipcRenderer.invoke('printers:sendNetwork', host, port, data),
  },
  display: {
    open: () => ipcRenderer.invoke('display:open'),
    update: (state) => ipcRenderer.send('display:update', state),
    close: () => ipcRenderer.send('display:close'),
  },
});
