const {app,BrowserWindow,Tray,Menu,nativeImage,ipcMain,dialog,screen,session}=require('electron');
const path=require('node:path');const fs=require('node:fs');const crypto=require('node:crypto');const {pathToFileURL}=require('node:url');
const {createService}=require('./core/service.cjs');const {assertSender,validateRefresh}=require('./ipc-policy.cjs');
const {launchExternal}=require('./core/launcher.cjs');
app.setName('Vibe Usage');
if(process.env.VIBE_DATA_DIR)app.setPath('userData',path.resolve(process.env.VIBE_DATA_DIR));
let win,tray,service,poll,quitting=false,boundsTimer;
const html=path.join(__dirname,'ui/index.html');const expectedUrl=pathToFileURL(html).href;
function publish(){const snapshot=service.snapshot();if(win&&!win.isDestroyed())win.webContents.send('vibe:update',snapshot);return snapshot;}
async function refresh(provider){const pending=service.refresh(provider);publish();try{await pending;}finally{publish();}return service.snapshot();}
function schedule(){clearInterval(poll);poll=setInterval(()=>{refresh().catch(()=>{});},service.snapshot().settings.intervalSeconds*1000);}
function show(){if(!win||win.isDestroyed())return;if(win.isMinimized())win.restore();win.show();win.focus();}
function handler(name,fn){ipcMain.handle('vibe:'+name,async(event,...args)=>{assertSender(event,expectedUrl);return fn(...args);});}
if(!app.requestSingleInstanceLock())app.quit();else{
 app.on('second-instance',show);
 app.whenReady().then(async()=>{
  service=await createService({settingsPath:path.join(app.getPath('userData'),'settings.json')});
  const settings=service.snapshot().settings;const area=screen.getPrimaryDisplay().workArea;
  const saved=settings.window||{};const width=Math.min(Math.max(saved.width||430,340),Math.min(area.width,620));const height=Math.min(Math.max(saved.height||900,420),area.height-30);
  const bounds={width,height};if(Number.isFinite(saved.x)&&Number.isFinite(saved.y)&&screen.getAllDisplays().some(d=>saved.x>=d.workArea.x&&saved.x+width<=d.workArea.x+d.workArea.width&&saved.y>=d.workArea.y&&saved.y+height<=d.workArea.y+d.workArea.height)){bounds.x=saved.x;bounds.y=saved.y;}
  win=new BrowserWindow({...bounds,minWidth:340,minHeight:420,title:'Vibe Usage',frame:false,show:false,alwaysOnTop:!!settings.pinned,backgroundColor:'#171a1e',icon:path.join(__dirname,'../assets/icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  session.defaultSession.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());
  win.on('close',event=>{if(!quitting){event.preventDefault();win.hide();}});
  function saveBounds(){clearTimeout(boundsTimer);boundsTimer=setTimeout(()=>{if(!win.isDestroyed())service.updateSettings({window:win.getBounds()}).catch(()=>{});},500);}
  win.on('resize',saveBounds);win.on('move',saveBounds);
  const icon=nativeImage.createFromPath(path.join(__dirname,'../assets/tray.png'));tray=new Tray(icon);tray.setToolTip('Vibe Usage');
  tray.setContextMenu(Menu.buildFromTemplate([{label:'Vibe Usage aç',click:show},{label:'Kotaları yenile',click:()=>refresh().catch(()=>{})},{type:'separator'},{label:'Çıkış',click:()=>{quitting=true;app.quit();}}]));tray.on('click',()=>win.isVisible()?win.hide():show());
  handler('snapshot',()=>service.snapshot());handler('refresh',provider=>refresh(validateRefresh(provider)));
  handler('settings',async patch=>{await service.updateSettings(patch);win.setAlwaysOnTop(!!service.snapshot().settings.pinned);schedule();return publish();});
  handler('pin',async()=>{await service.updateSettings({pinned:!service.snapshot().settings.pinned});win.setAlwaysOnTop(!!service.snapshot().settings.pinned);return publish();});
  handler('hide',()=>win.hide());
  handler('add-profile',async()=>{
   const choice=await dialog.showOpenDialog(win,{title:'Giriş yapılmış Claude profil klasörünü seç',properties:['openDirectory','showHiddenFiles']});if(choice.canceled)return {message:'İptal edildi.'};
   const configDir=choice.filePaths[0];if(!fs.existsSync(path.join(configDir,'.credentials.json'))&&process.platform!=='darwin')return {message:'Bu klasörde kayıtlı Claude girişi bulunamadı.'};
   const accounts=service.snapshot().settings.accounts;if(accounts.some(a=>a.providerId==='claude'&&a.configDir===configDir))return {message:'Bu profil zaten bağlı.'};
   await service.updateSettings({accounts:[...accounts,{id:'claude:'+crypto.createHash('sha256').update(configDir).digest('hex').slice(0,12),providerId:'claude',configDir,label:path.basename(configDir),primary:!accounts.some(a=>a.providerId==='claude'),enabled:true}]});await refresh('claude');return {message:'Profil eklendi.'};
  });
  handler('launch',async options=>{
   if(!options||typeof options.accountId!=='string')throw Error('Hesap gerekli');
   const account=service.snapshot().settings.accounts.find(a=>a.id===options.accountId&&a.providerId==='claude'&&a.enabled!==false);if(!account)throw Error('Geçersiz hesap');
   const choice=await dialog.showOpenDialog(win,{title:'Claude Code için proje klasörü',properties:['openDirectory']});if(choice.canceled)return {message:'İptal edildi.'};
   await launchExternal({account,projectDir:choice.filePaths[0],dataDir:app.getPath('userData')});return {message:'Yeni Claude Code terminali açıldı. Devam eden görüşmeler değiştirilmedi.'};
  });
  await win.loadFile(html);win.once('ready-to-show',()=>{if(process.env.VIBE_START_HIDDEN!=='1')show();});
  if(process.env.VIBE_START_HIDDEN!=='1')show();schedule();await refresh();
 }).catch(()=>{dialog.showErrorBox('Vibe Usage','Uygulama başlatılamadı. Yerel ayar klasörünü ve kurulum dosyalarını kontrol edin.');quitting=true;app.quit();});
}
app.on('before-quit',()=>{quitting=true;clearInterval(poll);clearTimeout(boundsTimer);});
app.on('window-all-closed',()=>{});
