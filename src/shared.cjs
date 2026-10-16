(function(root){
 const numeric=value=>typeof value==='number'&&Number.isFinite(value);
 const LOCALE_MAP = {
  en: 'en-US', tr: 'tr-TR', de: 'de-DE', es: 'es-ES', fr: 'fr-FR',
  it: 'it-IT', pt: 'pt-BR', nl: 'nl-NL', pl: 'pl-PL', ja: 'ja-JP',
  ko: 'ko-KR', zh: 'zh-CN', ru: 'ru-RU'
 };
 function getLocale() {
  if (root.VibeI18n && typeof root.VibeI18n.getCurrentLanguage === 'function') {
   const lang = root.VibeI18n.getCurrentLanguage();
   return LOCALE_MAP[lang] || 'en-US';
  }
  return 'tr-TR';
 }
 function formatWindow(window, customLocale, now=Date.now()){
  const locale = customLocale || getLocale();
  const isTr = locale.startsWith('tr');
  const percent=value=>new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(value);
  const remaining=numeric(window.remainingPercent)?Math.max(0,Math.min(100,window.remainingPercent)):null;
  const used=numeric(window.usedPercent)?Math.max(0,Math.min(100,window.usedPercent)):null;
  let value;
  if (remaining === null) {
   value = isTr ? 'Veri yok' : (root.VibeI18n?.t ? root.VibeI18n.t('noData') : 'No data');
  } else {
   value = isTr ? `%${percent(remaining)}` : `${percent(remaining)}%`;
  }
  const passiveModel=window.active===false&&!!window.scope;
  if(passiveModel) {
   const passiveLabel = isTr ? 'Kaynakta pasif' : (root.VibeI18n?.t ? root.VibeI18n.t('passiveSource') : 'Passive at source');
   const usedLabel = isTr ? 'kullanılan' : (root.VibeI18n?.t ? root.VibeI18n.t('used') : 'used');
   value=used===null ? passiveLabel : (isTr ? `%${percent(used)} ${usedLabel}` : `${percent(used)}% ${usedLabel}`);
  }
  if(typeof window.valueText==='string'&&window.valueText&&window.valueText.length<=100)value=window.valueText;
  const resetDate=window.resetsAt?new Date(window.resetsAt):null;
  const reset=resetDate&&Number.isFinite(resetDate.getTime())?new Intl.DateTimeFormat(locale,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hour12:false}).format(resetDate):'';
  const defaultNote = passiveModel ? (isTr ? 'Kaynakta pasif; model erişimi doğrulanmadı' : (root.VibeI18n?.t ? root.VibeI18n.t('passiveSourceDetail') : 'Passive at source; model access not verified')) : (window.detail||'');
  const resetInMs=reset?resetDate.getTime()-now:null;
  const resetIn=resetInMs===null?'':formatDuration(resetInMs,locale);
  return {value,percent:passiveModel?null:remaining,reset,resetIn,resetInMs,note:defaultNote};
 }
 // Compact, localized countdown: 42m · 3h 11m · 49h · 4d 5h. Coarser as the distance grows.
 function formatDuration(ms,locale){
  const total=Math.max(1,Math.round(Math.max(0,ms)/60000));
  let parts;
  if(total<60)parts={minutes:total};
  else if(total<600)parts={hours:Math.floor(total/60),minutes:total%60};
  else if(total<72*60)parts={hours:Math.round(total/60)};
  else{const hours=Math.round(total/60);parts={days:Math.floor(hours/24),hours:hours%24};}
  for(const k of Object.keys(parts))if(!parts[k])delete parts[k];
  if(typeof Intl.DurationFormat==='function'){
   // CLDR's narrow units are ambiguous in some languages (tr: '3s 11d' = 3 hours 11 minutes; ja falls back to Latin '3h11m').
   const style=/^(tr|de|nl|ja)\b/i.test(locale)?'short':'narrow';
   try{return new Intl.DurationFormat(locale,{style}).format(parts);}catch{}
  }
  return [['days','d'],['hours','h'],['minutes','m']].filter(([k])=>parts[k]).map(([k,u])=>`${parts[k]}${u}`).join(' ');
 }
 function formatFreshness(iso,status,now=Date.now(),customLocale){
  const locale = customLocale || getLocale();
  const isTr = locale.startsWith('tr');
  if(!iso)return isTr ? 'Henüz ölçülmedi' : (root.VibeI18n?.t ? root.VibeI18n.t('notMeasuredYet') : 'Not measured yet');
  const date=new Date(iso);if(!Number.isFinite(date.getTime()))return isTr ? 'Ölçüm zamanı bilinmiyor' : (root.VibeI18n?.t ? root.VibeI18n.t('measurementTimeUnknown') : 'Measurement time unknown');
  const minutes=Math.max(0,Math.floor((now-date.getTime())/60000));
  let age;
  if (root.VibeI18n?.t) {
   age = minutes === 0 ? root.VibeI18n.t('justNow') : root.VibeI18n.t('minsAgo', { n: minutes });
  } else {
   age = minutes === 0 ? (isTr ? 'az önce' : 'just now') : (isTr ? `${minutes} dk önce` : `${minutes}m ago`);
  }
  const stalePrefix = status === 'stale' ? (root.VibeI18n?.t ? root.VibeI18n.t('stalePrefix') : (isTr ? 'Eski veri · ' : 'Stale data · ')) : '';
  return `${stalePrefix}${age}`;
 }
 const api={formatWindow,formatFreshness,formatDuration};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.VibeFormat=api;
})(typeof globalThis!=='undefined'?globalThis:this);
