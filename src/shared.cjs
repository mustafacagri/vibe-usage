(function(root){
 const numeric=value=>typeof value==='number'&&Number.isFinite(value);
 const percent=value=>new Intl.NumberFormat('tr-TR',{maximumFractionDigits:1}).format(value);
 function formatWindow(window){
  const remaining=numeric(window.remainingPercent)?Math.max(0,Math.min(100,window.remainingPercent)):null;
  const used=numeric(window.usedPercent)?Math.max(0,Math.min(100,window.usedPercent)):null;
  let value=remaining===null?'Veri yok':`%${percent(remaining)}`;
  const passiveModel=window.active===false&&!!window.scope;
  if(passiveModel)value=used===null?'Kaynakta pasif':`%${percent(used)} kullanılan`;
  if(typeof window.valueText==='string'&&window.valueText.length<=100)value=window.valueText;
  const resetDate=window.resetsAt?new Date(window.resetsAt):null;
  const reset=resetDate&&Number.isFinite(resetDate.getTime())?new Intl.DateTimeFormat('tr-TR',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(resetDate):'';
  return {value,percent:passiveModel?null:remaining,reset,note:passiveModel?'Kaynakta pasif; model erişimi doğrulanmadı':window.detail||''};
 }
 function formatFreshness(iso,status,now=Date.now()){
  if(!iso)return 'Henüz ölçülmedi';
  const date=new Date(iso);if(!Number.isFinite(date.getTime()))return 'Ölçüm zamanı bilinmiyor';
  const minutes=Math.max(0,Math.floor((now-date.getTime())/60000));
  const age=minutes===0?'az önce':`${minutes} dk önce`;
  return `${status==='stale'?'Eski veri · ':''}${age}`;
 }
 const api={formatWindow,formatFreshness};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.VibeFormat=api;
})(typeof globalThis!=='undefined'?globalThis:this);
