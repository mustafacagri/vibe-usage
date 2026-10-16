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
 function formatWindow(window, customLocale){
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
  if(typeof window.valueText==='string'&&window.valueText.length<=100)value=window.valueText;
  const resetDate=window.resetsAt?new Date(window.resetsAt):null;
  const reset=resetDate&&Number.isFinite(resetDate.getTime())?new Intl.DateTimeFormat(locale,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hour12:false}).format(resetDate):'';
  const defaultNote = passiveModel ? (isTr ? 'Kaynakta pasif; model erişimi doğrulanmadı' : (root.VibeI18n?.t ? root.VibeI18n.t('passiveSourceDetail') : 'Passive at source; model access not verified')) : (window.detail||'');
  return {value,percent:passiveModel?null:remaining,reset,note:defaultNote};
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
 const api={formatWindow,formatFreshness};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.VibeFormat=api;
})(typeof globalThis!=='undefined'?globalThis:this);
