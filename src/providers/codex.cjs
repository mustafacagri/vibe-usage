'use strict';
const path=require('node:path');const os=require('node:os');const {spawn}=require('node:child_process');
const {normalizeWindow,isoDate,safeText}=require('../core/model.cjs');const common=require('./common.cjs');
function durationMeta(minutes){
 if(minutes===10080)return {label:'Haftalık',labelKey:'labelWeekly',durationMinutes:10080};
 if(minutes===300)return {label:'5 saat',labelKey:'label5Hours',durationMinutes:300};
 if(Number.isFinite(minutes)&&minutes>0){
  if(minutes%60===0)return {label:`${minutes/60} saat`,labelKey:'labelNHours',labelParams:{n:minutes/60},durationMinutes:minutes};
  return {label:`${minutes} dakika`,labelKey:'labelNMins',labelParams:{n:minutes},durationMinutes:minutes};
 }
 return {label:'Dönem bildirilmedi',labelKey:'labelNoPeriodReported'};
}
function duration(minutes){return durationMeta(minutes).label;}
function parseCodexRateLimits(response){
 if(!response||typeof response!=='object'||Array.isArray(response))throw new common.ProviderError('invalid_response');
 if(!response.rateLimitsByLimitId&&!response.rateLimits)throw new common.ProviderError('invalid_response');
 const buckets=response.rateLimitsByLimitId||(response.rateLimits?{codex:response.rateLimits}:{});const windows=[];
 for(const [bucketId,bucket] of Object.entries(buckets))for(const key of ['primary','secondary']){
  const raw=bucket?.[key];if(!raw)continue;
  const d=durationMeta(raw.windowDurationMins);
  windows.push(normalizeWindow({id:`${bucketId}:${key}`,label:d.label,labelKey:d.labelKey,labelParams:d.labelParams,durationMinutes:d.durationMinutes,usedPercent:raw.usedPercent,resetsAt:isoDate(raw.resetsAt,true),...(bucketId!=='codex'?{scope:safeText(bucketId)}:{})}));
 }
 const result={windows};
 if(!windows.length)result.status='no_limits_reported';
 return result;
}
async function probeAccount(binary,configDir){
 const child=spawn(binary,['app-server','--listen','stdio://'],{shell:false,windowsHide:true,env:common.cleanEnvironment({CODEX_HOME:configDir}),stdio:['pipe','pipe','pipe']});
 let buffer='',closed=false;const pending=new Map();let id=0;
 function rejectAll(){closed=true;for(const item of pending.values())item.reject(new common.ProviderError('server_closed'));pending.clear();}
 child.on('error',rejectAll);child.on('close',rejectAll);child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
 child.stdout.on('data',chunk=>{
  buffer+=chunk.toString();if(buffer.length>1024*1024){rejectAll();child.kill();return;}
  while(buffer.includes('\n')){const at=buffer.indexOf('\n');const line=buffer.slice(0,at);buffer=buffer.slice(at+1);let packet;try{packet=JSON.parse(line);}catch{continue;}const item=pending.get(packet.id);if(!item)continue;pending.delete(packet.id);if(packet.error)item.reject(new common.ProviderError('rpc_error'));else item.resolve(packet.result);}
 });
 function request(method,params){return new Promise((resolve,reject)=>{
  if(closed)return reject(new common.ProviderError('server_closed'));const serial=++id;const timeout=setTimeout(()=>{pending.delete(serial);reject(new common.ProviderError('rpc_timeout'));},10000);
  pending.set(serial,{resolve:value=>{clearTimeout(timeout);resolve(value);},reject:error=>{clearTimeout(timeout);reject(error);}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:serial,method,...(params?{params}:{})})+'\n');
 });}
 try{
  await request('initialize',{clientInfo:{name:'vibe_usage',title:'Vibe Usage',version:'0.1.0'},capabilities:{experimentalApi:false}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized'})+'\n');
  const account=await request('account/read',{refreshToken:false});if(!account?.account)throw new common.ProviderError('auth_missing');
  const result=parseCodexRateLimits(await request('account/rateLimits/read'));
  if(typeof account.account.planType==='string')result.plan=safeText(account.account.planType);return result;
 }finally{
  child.stdin.end();child.kill();
  await new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();const timer=setTimeout(resolve,2000);child.once('close',()=>{clearTimeout(timer);resolve();});});
  rejectAll();
 }
}
function createCodexProvider(options={}){
 const home=options.home||os.homedir();
 return {id:'codex',name:'Codex',discover:async()=>[{id:'codex:default',providerId:'codex',label:'Mevcut hesap',configDir:process.env.CODEX_HOME||path.join(home,'.codex'),primary:true,enabled:true}],async fetch(account){
  const configDir=account.configDir||path.join(home,'.codex');
  try{const auth=await common.readJson(path.join(configDir,'auth.json'));const token=auth.tokens?.access_token;if(typeof token==='string'){let claims;try{claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));}catch{throw new common.ProviderError('auth_invalid');}if(Number.isFinite(claims.exp)&&claims.exp*1000<=common.now(options.clock)+60000)throw new common.ProviderError('auth_expired');}}
  catch(error){if(error.code!=='auth_missing')throw error;}
  return probeAccount(await common.findBinary('codex',options),configDir);
 }};
}
module.exports={parseCodexRateLimits,createCodexProvider,probeAccount};
