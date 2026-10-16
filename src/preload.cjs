const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('vibe',{
 snapshot:()=>ipcRenderer.invoke('vibe:snapshot'),refresh:provider=>ipcRenderer.invoke('vibe:refresh',provider),
 saveSettings:patch=>ipcRenderer.invoke('vibe:settings',patch),
 dismissAccount:accountId=>ipcRenderer.invoke('vibe:dismiss-account',accountId),
 restoreDismissedAccounts:()=>ipcRenderer.invoke('vibe:restore-dismissed-accounts'),
 loginProvider:providerId=>ipcRenderer.invoke('vibe:login-provider',providerId),
 addClaudeProfile:()=>ipcRenderer.invoke('vibe:add-profile'),
 pin:()=>ipcRenderer.invoke('vibe:pin'),hide:()=>ipcRenderer.invoke('vibe:hide'),
 launch:options=>ipcRenderer.invoke('vibe:launch',options),
 previewSmartLaunch:()=>ipcRenderer.invoke('vibe:preview-smart-launch'),
 smartLaunch:options=>ipcRenderer.invoke('vibe:smart-launch',options),
 executeHandover:options=>ipcRenderer.invoke('vibe:execute-handover',options),
 handoverToCodex:()=>ipcRenderer.invoke('vibe:handover-to-codex'),
 listSessions:options=>ipcRenderer.invoke('vibe:list-sessions',options),
 selectDirectory:options=>ipcRenderer.invoke('vibe:select-directory',options),
 getDefaultProjectDir:()=>ipcRenderer.invoke('vibe:get-default-project-dir'),
 getDiscoveredModels:()=>ipcRenderer.invoke('vibe:get-discovered-models'),
 onSnapshot:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('vibe:update',listener);return ()=>ipcRenderer.removeListener('vibe:update',listener);}
});
