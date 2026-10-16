'use strict';
const $=selector=>document.querySelector(selector);
const selection=new Map();let state=null;let toastTimer;
function element(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('#toast').hidden=true;},5000);}
async function action(fn){try{return await fn();}catch{toast('İşlem tamamlanamadı. Oturumu ve bağlantıyı kontrol et.');}}
function accountSection(provider){
 const section=element('section','provider');section.dataset.provider=provider.id;
 const heading=element('div','provider-heading');heading.append(element('h2','',provider.name));
 const accounts=provider.accounts||[];let current=accounts.find(a=>a.id===selection.get(provider.id))||accounts.find(a=>a.primary)||accounts[0];
 if(accounts.length>1){const select=element('select','account-picker');select.setAttribute('aria-label',`${provider.name} hesabı`);for(const account of accounts){const option=element('option','',`${account.primary?'★ ':''}${account.label}${account.plan?' · '+account.plan:''}`);option.value=account.id;select.append(option);}select.value=current.id;select.addEventListener('change',()=>{selection.set(provider.id,select.value);render(state);});heading.append(select);}else if(current){heading.append(element('span','account-label',`${current.label}${current.plan?' · '+current.plan:''}`));}
 section.append(heading);
 if(current){
  let spending;
  for(const window of current.windows||[]){
   const view=VibeFormat.formatWindow(window);const quota=element('div','quota'+(view.percent!==null&&view.percent<=20?' low':''));
   const line=element('div','quota-line');line.append(element('span','',window.label),element('span','quota-value',view.value));quota.append(line);
   const description=[window.scope&&!window.label.includes(window.scope)?window.scope:'',view.reset?`${view.reset} yenilenir`:'',view.note].filter(Boolean).join(' · ');if(description)quota.append(element('div','quota-description',description));
   if(view.percent!==null){const track=element('div','track');const fill=element('div','fill');fill.style.setProperty('--quota',String(view.percent));track.append(fill);track.setAttribute('role','progressbar');track.setAttribute('aria-label',window.label);track.setAttribute('aria-valuenow',String(view.percent));track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');quota.append(track);}
   if(window.valueText){if(!spending){spending=element('details','spending');spending.append(element('summary','','Harcama ve ek kullanım'));section.append(spending);}spending.append(quota);}else section.append(quota);
  }
  if(!current.windows?.length)section.append(element('div','empty',current.message||provider.message||'Henüz kullanım verisi alınamadı.'));
  else if(current.message)section.append(element('div','empty',current.message));
  if(provider.id==='claude'&&current.configDir){const launch=element('button','launch-button','Bu hesapla Claude Code aç ↗');launch.addEventListener('click',()=>action(async()=>{const response=await window.vibe.launch({accountId:current.id});if(response?.message)toast(response.message);}));section.append(launch);section.append(element('div','quota-description','Yeni oturum açılır. Fable kullanım kredisi gerektirebilir; model ve kredi tercihlerini Claude Code yönetir.'));}
 }
 else section.append(element('div','empty',provider.message||'Bağlı hesap bulunamadı.'));
 const accountStatus=current?.status||provider.status;const status=element('div','provider-status'+(accountStatus==='stale'?' stale':''));
 status.append(element('span','',VibeFormat.formatFreshness(current?current.fetchedAt:provider.fetchedAt,accountStatus)),element('span','',accountStatus==='loading'?'Okunuyor…':accountStatus==='stale'?'Yenileme başarısız':accountStatus==='ok'?'Yerel oturum':''));
 section.append(status);return section;
}
function render(snapshot){if(!snapshot)return;state=snapshot;$('#providers').replaceChildren(...snapshot.providers.map(accountSection));$('#overall-status').textContent=snapshot.refreshing?'Kotalar okunuyor…':`${snapshot.providers.length} hizmet · bu cihaz`;$('#refresh').disabled=snapshot.refreshing;$('#pin').setAttribute('aria-pressed',String(!!snapshot.settings.pinned));$('#pin').textContent=snapshot.settings.pinned?'◆':'◇';$('#refresh-label').textContent=`Otomatik yenileme · ${snapshot.settings.intervalSeconds/60} dk`;}
function renderSettings(){
 const interval=$('#interval');interval.value=String(state.settings.intervalSeconds);
 if(!interval.value){const option=element('option','',`${state.settings.intervalSeconds} saniye`);option.value=String(state.settings.intervalSeconds);interval.append(option);interval.value=option.value;}
 const accounts=state.settings.accounts.filter(a=>a.providerId==='claude');const list=$('#account-settings');list.replaceChildren();
 for(const account of accounts){const row=element('div','account-setting');const input=element('input');input.type='text';input.value=account.label;input.maxLength=64;input.setAttribute('aria-label','Hesap etiketi');input.addEventListener('change',()=>action(async()=>{await window.vibe.saveSettings({accounts:state.settings.accounts.map(a=>a.id===account.id?{...a,label:input.value}:a)});}));row.append(input);const label=element('label');const radio=element('input');radio.type='radio';radio.name='primary';radio.checked=!!account.primary;radio.addEventListener('change',()=>action(async()=>{await window.vibe.saveSettings({accounts:state.settings.accounts.map(a=>a.providerId==='claude'?{...a,primary:a.id===account.id}:a)});renderSettings();}));label.append(radio,element('span','','Ana hesap'));row.append(label);list.append(row);}
}
$('#refresh').addEventListener('click',()=>action(()=>window.vibe.refresh()));
$('#pin').addEventListener('click',()=>action(()=>window.vibe.pin()));
$('#hide').addEventListener('click',()=>action(()=>window.vibe.hide()));
$('#settings-button').addEventListener('click',()=>{if(state){renderSettings();$('#settings-dialog').showModal();}});
$('#interval').addEventListener('change',event=>action(()=>window.vibe.saveSettings({intervalSeconds:Number(event.target.value)})));
$('#add-profile').addEventListener('click',()=>action(async()=>{const response=await window.vibe.addClaudeProfile();if(response?.message)$('#settings-message').textContent=response.message;renderSettings();}));
$('#platform-label').textContent=navigator.platform.toLowerCase().includes('mac')?'macOS · menü çubuğu':'Windows · sistem tepsisi';
window.vibe.onSnapshot(render);action(async()=>render(await window.vibe.snapshot()));
