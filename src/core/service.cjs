'use strict';
const {loadSettings,saveSettings,defaultSettingsPath,DEFAULT_SETTINGS,validateSettings}=require('./settings.cjs');
const {normalizeWindow}=require('./model.cjs');const {safeError,now}=require('../providers/common.cjs');
const MESSAGES={auth_missing:'Bu cihazda giriş bulunamadı.',auth_expired:'Oturum süresi dolmuş; sağlayıcıda yeniden giriş gerekli.',auth_invalid:'Kayıtlı oturum okunamadı.',auth_rejected:'Sağlayıcı oturumu kabul etmedi.',rate_limited:'Okuma sıklığı sınırlandı; yeniden denemeden önce bekleniyor.',app_closed:'Kota için Antigravity uygulamasını açın.',unsupported_platform:'Bu işletim sisteminde bu veri kaynağı henüz desteklenmiyor.',unsupported_profile:'Bu profilin kimlik deposu henüz desteklenmiyor.',keychain_unavailable:'Keychain girişi okunamadı.',binary_missing:'Gerekli yerel uygulama veya CLI bulunamadı.',transport_error:'Sağlayıcıya bağlanılamadı.',local_service_unavailable:'Antigravity yerel servisine ulaşılamadı.'};
MESSAGES.tls_certificate_error='TLS sertifikası doğrulanamadı. Ağın ve sistemin sertifika güvenini kontrol edin.';
MESSAGES.trust_store_unavailable='İşletim sisteminin sertifika deposu okunamadı. Kurulumu ve desteklenen Node.js sürümünü kontrol edin.';
const copy=value=>structuredClone(value);
async function createService(options={}){
 const clock=options.clock||Date.now;const settingsPath=options.settingsPath||defaultSettingsPath();
 const adapters=options.providers||[
  require('../providers/codex.cjs').createCodexProvider(),require('../providers/claude.cjs').createClaudeProvider(),require('../providers/cursor.cjs').createCursorProvider(),require('../providers/antigravity.cjs').createAntigravityProvider()
 ];
 let settings=await loadSettings(settingsPath)||copy(DEFAULT_SETTINGS);let changed=false;
 for(const adapter of adapters){const found=await adapter.discover();for(const account of found){if(!settings.accounts.some(a=>a.id===account.id)){settings.accounts.push({...account,primary:account.primary&&!settings.accounts.some(a=>a.providerId===adapter.id&&a.primary)});changed=true;}}}
 settings=validateSettings(settings);if(changed)await saveSettings(settingsPath,settings);
 let providers=adapters.map(p=>({id:p.id,name:p.name,status:'pending',accounts:[]}));let refreshing=false,pendingRefresh=null,pendingSave=Promise.resolve();const cooldown=new Map();
 function rebuild(){for(const provider of providers){const old=provider.accounts;provider.accounts=settings.accounts.filter(a=>a.providerId===provider.id&&a.enabled!==false).map(a=>{const previous=old.find(b=>b.id===a.id);return previous&&previous.configDir===a.configDir?{...previous,...a}:{...a,status:'pending',windows:[]};});}}
 rebuild();
 function snapshot(){return copy({providers,refreshing,settings});}
 async function refresh(providerId){
  if(providerId!==undefined&&!adapters.some(a=>a.id===providerId))throw Error('invalid_provider');
  if(pendingRefresh){await pendingRefresh;if(providerId)return refresh(providerId);return snapshot();}
  refreshing=true;
  pendingRefresh=(async()=>{
   await Promise.all(adapters.filter(a=>providerId===undefined||a.id===providerId).map(async adapter=>{
    const provider=providers.find(p=>p.id===adapter.id);provider.lastAttemptAt=new Date(now(clock)).toISOString();
    await Promise.all(provider.accounts.map(async account=>{
     const attempt=now(clock);if((cooldown.get(account.id)||0)>attempt)return;
     account.lastAttemptAt=new Date(attempt).toISOString();
     try{
      const result=await adapter.fetch(account);const stamp=new Date(now(clock)).toISOString();const windows=(result.windows||[]).map(normalizeWindow);
      for(const prior of account.windows||[])if(!windows.some(w=>w.id===prior.id))windows.push({...prior,stale:true,detail:'Önceki ölçüm; son yanıtta bu kapsam bildirilmedi.'});
      account.windows=windows;account.status='ok';account.message=result.message||'';account.fetchedAt=stamp;if(result.plan)account.plan=result.plan;
     }catch(error){const code=safeError(error);account.status=account.fetchedAt?'stale':code;account.message=MESSAGES[code]||'Kullanım verisi okunamadı. Bir sonraki yenilemede tekrar denenecek.';
      if(code==='rate_limited')cooldown.set(account.id,attempt+(error.retryAfterSeconds||120)*1000);
     }
    }));
    const allOk=provider.accounts.length>0&&provider.accounts.every(a=>a.status==='ok');provider.status=allOk?'ok':provider.accounts.some(a=>a.fetchedAt)?'stale':provider.accounts[0]?.status||'unavailable';
    if(allOk)provider.fetchedAt=new Date(now(clock)).toISOString();provider.message=provider.accounts.length?'':'Bağlı hesap bulunamadı.';
   }));
  })();
  try{await pendingRefresh;}finally{pendingRefresh=null;refreshing=false;}return snapshot();
 }
 async function updateSettings(patch){
  const operation=pendingSave.catch(()=>{}).then(async()=>{if(patch.accounts&&pendingRefresh)await pendingRefresh;const next=validateSettings({...settings,...patch});await saveSettings(settingsPath,next);if(patch.accounts)while(pendingRefresh)await pendingRefresh;settings=next;if(patch.accounts)rebuild();return snapshot();});pendingSave=operation;return operation;
 }
 return {snapshot,refresh,updateSettings};
}
module.exports={createService};
