'use strict';
const { _electron:electron }=require('playwright');const path=require('node:path');const fs=require('node:fs/promises');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
(async()=>{
 const dataDir=path.join(root,'artifacts',`smoke-${Date.now()}`);await fs.mkdir(dataDir,{recursive:true});
 const env={...process.env,VIBE_DATA_DIR:dataDir,VIBE_START_HIDDEN:'1'};delete env.ELECTRON_RUN_AS_NODE;
 const executablePath=process.env.VIBE_SMOKE_EXECUTABLE||require('electron');
 const app=await electron.launch({executablePath,args:process.env.VIBE_SMOKE_EXECUTABLE?[]:[root],cwd:root,env,timeout:30000});
 try{
  const page=await app.firstWindow();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>!!window.vibe);
  const snapshot=await page.evaluate(()=>window.vibe.refresh());assert.equal(snapshot.providers.length,4);
  console.log(JSON.stringify({liveStatus:snapshot.providers.map(p=>({id:p.id,status:p.status,accounts:p.accounts.map(a=>({id:a.id,status:a.status}))}))}));
  assert.equal(JSON.stringify(snapshot).includes('accessToken'),false);assert.equal(JSON.stringify(snapshot).includes('refreshToken'),false);
  const claude=snapshot.providers.find(p=>p.id==='claude');assert.ok(claude.accounts.length>=2,'Expected two configured Claude accounts');
  assert.ok(claude.accounts.every(a=>a.status==='ok'),'Claude read-only quota reads must work');
  for(const id of ['codex','cursor'])assert.equal(snapshot.providers.find(p=>p.id===id).status,'ok',`${id} live quota read`);
  await page.getByLabel('Claude hesabı').selectOption('claude:secondary');
  assert.equal(await page.getByLabel('Claude hesabı').inputValue(),'claude:secondary');
  const before=await page.locator('#pin').getAttribute('aria-pressed');await page.locator('#pin').click();await page.waitForFunction(before=>document.querySelector('#pin').getAttribute('aria-pressed')!==before,before);
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isAlwaysOnTop()),before!=='true');
  await page.getByLabel('Ayarlar',{exact:true}).click();await page.locator('#interval').selectOption('300');await page.waitForFunction(async()=>(await window.vibe.snapshot()).settings.intervalSeconds===300);
  await page.locator('#settings-dialog').getByRole('button',{name:'Kapat'}).click();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());
  const screenshot=path.join(root,'artifacts','desktop-live.png');await page.screenshot({path:screenshot,fullPage:true,timeout:15000});
  const hidden=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.show();w.close();return !w.isDestroyed()&&!w.isVisible();});assert.equal(hidden,true,'Close must hide window and leave tray alive');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({providers:snapshot.providers.map(p=>({id:p.id,status:p.status,accounts:p.accounts.length,windows:p.accounts.reduce((sum,a)=>sum+a.windows.length,0)})),checks:['real quota reads','two Claude profiles','account selector','pin','settings persistence','close hides to tray','no renderer errors','no credential fields in snapshot'],screenshot},null,2));
 }finally{await app.close();}
})().catch(error=>{console.error('Desktop smoke failed:',error.message);process.exitCode=1;});
