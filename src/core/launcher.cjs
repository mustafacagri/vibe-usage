'use strict';
const fs=require('node:fs/promises');const path=require('node:path');const {spawn}=require('node:child_process');const {randomBytes}=require('node:crypto');
const {findBinary,cleanEnvironment}=require('../providers/common.cjs');const {validateConfigDir}=require('./settings.cjs');
function shellQuote(value){if(typeof value!=='string'||/[\x00-\x1f]/.test(value))throw Error('invalid_argument');return "'"+value.replace(/'/g,"'\\''")+"'";}
function launchEnvironment(account,source=process.env){
 const env={...source};for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_PROFILE','CLAUDE_SECURESTORAGE_CONFIG_DIR','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'])delete env[key];
 if(account.id==='claude:default')delete env.CLAUDE_CONFIG_DIR;else env.CLAUDE_CONFIG_DIR=account.configDir;return env;
}
function launchWarnings(snapshot,account,{model}={}){
 const warnings=['Yeni süreç açılır; devam eden iş devredilmez.','Model ve ücretli kullanım/kredi tercihlerini Claude Code yönetir. Fable planınıza göre kullanım kredisi gerektirebilir.'];
 const measured=snapshot.providers.find(p=>p.id==='claude')?.accounts.find(a=>a.id===account.id);
 const family=model?.toLowerCase().match(/fable|sonnet|opus|haiku/)?.[0];
 const scoped=(measured?.windows||[]).filter(w=>w.scope&&(!family||w.scope.toLowerCase().includes(family)));
 const relevant=[...(measured?.windows||[]).filter(w=>!w.scope),...scoped];
 const unknown=measured?.status!=='ok'||!measured.fetchedAt||Date.now()-Date.parse(measured.fetchedAt)>300000||relevant.some(w=>w.stale||w.remainingPercent===null||(w.scope&&w.active===false))||(family==='fable'&&!scoped.length);
 if(unknown)warnings.push('Bu hesabın tüm ilgili limitleri doğrulanamadı; hesap seçimi yeterli kota garantisi değildir.');
 if(relevant.some(w=>w.remainingPercent===0))warnings.push('Seçilen kapsamda dolu bir limit var; Claude Code isteği durdurabilir.');return warnings;
}
function selectClaudeAccount(snapshot,{accountId,model}={}){
 const profiles=snapshot.settings.accounts.filter(a=>a.providerId==='claude'&&a.enabled!==false);
 const measured=snapshot.providers.find(p=>p.id==='claude')?.accounts||[];
 if(accountId){const account=profiles.find(a=>a.id===accountId);if(!account)throw Error('Hesap bulunamadı.');return account;}
 for(const account of [...profiles].sort((a,b)=>Number(b.primary)-Number(a.primary))){
  const value=measured.find(a=>a.id===account.id);if(value?.status!=='ok'||!value.fetchedAt||Date.now()-Date.parse(value.fetchedAt)>300000)continue;
  const general=value.windows.filter(w=>!w.scope);if(!general.some(w=>w.id==='five_hour')||!general.some(w=>w.id==='seven_day'))continue;
  const family=model?.toLowerCase().includes('fable')?'fable':model?.toLowerCase().includes('opus')?'opus':model?.toLowerCase().includes('sonnet')?'sonnet':null;
  const scoped=family?value.windows.filter(w=>w.scope?.toLowerCase().includes(family)):value.windows.filter(w=>w.scope);
  if(family==='fable'&&!scoped.length)continue;
  if([...general,...scoped].every(w=>!w.stale&&!(w.scope&&w.active===false)&&typeof w.remainingPercent==='number'&&Number.isFinite(w.remainingPercent)&&w.remainingPercent>0))return account;
 }
 throw Error('Güncel ve yeterli kota doğrulanamadı. --account ile açık hesap seçebilirsiniz.');
}
async function launchExternal({account,projectDir,dataDir}){
 const configDir=validateConfigDir(account.configDir);const cwd=validateConfigDir(projectDir);
 if(!(await fs.stat(cwd)).isDirectory()||!(await fs.stat(configDir)).isDirectory())throw Error('Klasör bulunamadı');
 const binary=await findBinary('claude');let child;
 if(process.platform==='win32'){
  const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const helper=path.resolve(__dirname,'../launchers/claude.ps1').replace(/([\\/])app\.asar([\\/])/,'$1app.asar.unpacked$2');
  child=spawn(ps,['-NoLogo','-NoProfile','-NoExit','-ExecutionPolicy','Bypass','-File',helper,'-ConfigDirectory',configDir,'-ProjectDirectory',cwd,'-ClaudeBinary',binary,...(account.id==='claude:default'?['-DefaultProfile']:[])],{shell:false,detached:true,windowsHide:false,stdio:'ignore',env:launchEnvironment(account)});
 }else if(process.platform==='darwin'){
  const launchDir=path.join(dataDir,'launchers');await fs.mkdir(launchDir,{recursive:true});const script=path.join(launchDir,`claude-${randomBytes(6).toString('hex')}.command`);
  const content=`#!/bin/zsh\ncd -- ${shellQuote(cwd)} || exit 1\nunset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_PROFILE CLAUDE_SECURESTORAGE_CONFIG_DIR CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY\n${account.id==='claude:default'?'unset CLAUDE_CONFIG_DIR':`export CLAUDE_CONFIG_DIR=${shellQuote(configDir)}`}\nexec ${shellQuote(binary)}\n`;
  await fs.writeFile(script,content,{mode:0o700});child=spawn('/usr/bin/open',['-a','Terminal',script],{shell:false,detached:true,stdio:'ignore'});
 }else throw Error('Bu platformda terminal başlatma desteklenmiyor');
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(Error('Terminal açılamadı')));});child.unref();
}
module.exports={selectClaudeAccount,shellQuote,launchEnvironment,launchWarnings,launchExternal};
