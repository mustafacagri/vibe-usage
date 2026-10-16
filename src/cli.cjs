#!/usr/bin/env node
'use strict';
const path=require('node:path');const {spawn}=require('node:child_process');const {createService}=require('./core/service.cjs');const {selectClaudeAccount,launchEnvironment,launchWarnings}=require('./core/launcher.cjs');const {findBinary}=require('./providers/common.cjs');const {formatWindow,formatFreshness}=require('./shared.cjs');
async function main(){
 const args=process.argv.slice(2),command=args.shift()||'status';
 if(command==='help'||command==='--help'){console.log('Vibe Usage\n  status [--json]\n  watch\n  run claude [--account ID] [--cwd PATH] [--model MODEL] [--dry-run]\nHesap devri/resume yok; yalnız yeni süreç başlatılır.');return;}
 if(!['status','watch','run'].includes(command))throw Error('Bilinmeyen komut. --help kullanın.');
 const service=await createService({settingsPath:process.env.VIBE_DATA_DIR?path.join(process.env.VIBE_DATA_DIR,'settings.json'):undefined});
 function render(snapshot){if(process.stdout.isTTY)process.stdout.write('\x1b[2J\x1b[H');console.log('vibe · kullanım hakları\n');for(const p of snapshot.providers){console.log(p.name.toUpperCase());for(const a of p.accounts){console.log(`  ${a.primary?'★ ':''}${a.label}${a.plan?' · '+a.plan:''} · ${formatFreshness(a.fetchedAt,a.status)}`);for(const w of a.windows){const v=formatWindow(w);console.log(`    ${w.label}${w.scope?' / '+w.scope:''}: ${v.value}${v.reset?' · '+v.reset:''}${v.note?' · '+v.note:''}`);}if(a.message)console.log('    '+a.message);}console.log('');}console.log('Ctrl+C: kapat · Bu ekran mevcut IDE hesaplarını değiştirmez.');}
 if(command==='status'){const result=await service.refresh();if(args.includes('--json'))console.log(JSON.stringify(result,null,2));else render(result);return;}
 if(command==='watch'){render(service.snapshot());render(await service.refresh());let busy=false;const timer=setInterval(async()=>{if(busy)return;busy=true;try{render(await service.refresh());}finally{busy=false;}},service.snapshot().settings.intervalSeconds*1000);process.once('SIGINT',()=>{clearInterval(timer);process.exit(0);});return;}
 if(args.shift()!=='claude')throw Error('Bu sürüm yalnız Claude Code başlatır.');
 const options={};let dryRun=false;while(args.length){const flag=args.shift();if(flag==='--dry-run'){dryRun=true;continue;}const keys={'--account':'accountId','--cwd':'cwd','--model':'model'};if(!keys[flag]||!args.length)throw Error('Geçersiz argüman');options[keys[flag]]=args.shift();}
 const snapshot=await service.refresh('claude');const account=selectClaudeAccount(snapshot,options);const cwd=path.resolve(options.cwd||process.cwd());const binary=await findBinary('claude');
 if(options.model&&!/^[A-Za-z0-9_.[\]:/-]{1,100}$/.test(options.model))throw Error('Geçersiz model');
 const warnings=launchWarnings(snapshot,account,options);
 if(dryRun){console.log(JSON.stringify({provider:'claude',accountId:account.id,label:account.label,projectDir:cwd,model:options.model||'default',newProcessOnly:true,warnings},null,2));return;}
 for(const warning of warnings)console.log(warning);
 console.log(`Vibe · ${account.label} · yeni Claude Code süreci`);
 const env=launchEnvironment(account);
 const child=spawn(binary,options.model?['--model',options.model]:[],{cwd,env,shell:false,stdio:'inherit'});child.on('error',()=>{console.error('Claude Code başlatılamadı.');process.exitCode=1;});child.on('close',(code,signal)=>{process.exitCode=typeof code==='number'?code:signal==='SIGINT'?130:1;});
}
main().catch(error=>{console.error(/Hesap|kota|komut|argüman|model|sürüm/.test(error.message)?error.message:'İşlem tamamlanamadı; yerel kurulum ve ayarları kontrol edin.');process.exitCode=1;});
