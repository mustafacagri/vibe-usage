const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('vibe',{
 snapshot:()=>ipcRenderer.invoke('vibe:snapshot'),refresh:provider=>ipcRenderer.invoke('vibe:refresh',provider),
 saveSettings:patch=>ipcRenderer.invoke('vibe:settings',patch),
 addClaudeProfile:()=>ipcRenderer.invoke('vibe:add-profile'),
 pin:()=>ipcRenderer.invoke('vibe:pin'),hide:()=>ipcRenderer.invoke('vibe:hide'),
 launch:options=>ipcRenderer.invoke('vibe:launch',options),
 onSnapshot:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('vibe:update',listener);return ()=>ipcRenderer.removeListener('vibe:update',listener);}
});
