/** The customer display receives the sale from the till (window.tillDisplay); see web/src/pos/display.ts. */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tillDisplay', {
  onUpdate: (listener) => ipcRenderer.on('display:state', (_e, state) => listener(state)),
});
