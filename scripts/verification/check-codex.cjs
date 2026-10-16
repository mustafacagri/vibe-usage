// Read-only account diagnostics. No model calls, login/logout or token refresh requests.
// Existing credentials never appear in output. Negative controls use EMPTY task-owned homes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname,'../..');
const binary = process.env.VIBE_CODEX_BINARY || path.join(os.homedir(),'AppData/Local/Programs/OpenAI/Codex/bin/codex.exe');
const baseHome = process.env.CODEX_HOME || path.join(os.homedir(),'.codex');
const output = {platform:process.platform,checks:[],limitations:[]};
const hashFile = file => {try{return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}catch{return null;}};
const authPath = path.join(baseHome,'auth.json');
const authBefore = hashFile(authPath);

function environment(home) {
  const env={...process.env};
  // Do not let an inherited inference key make the empty-home controls appear signed in.
  for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN','ACCESS_TOKEN']) delete env[key];
  if(home) env.CODEX_HOME=home;
  return env;
}
function run(args,home,timeoutMs=10000) {
  return new Promise(resolve=>{
    const child=spawn(binary,args,{cwd:root,env:environment(home),windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);
    child.stdout.on('data',b=>{stdout+=b.toString();});
    child.stderr.on('data',b=>{stderr+=b.toString();});
    child.on('error',()=>{clearTimeout(timer);resolve({exitCode:null,kind:'process_start_failed'});});
    child.on('close',exitCode=>{
      clearTimeout(timer);
      const combined=stdout+'\n'+stderr;
      let auth='unclassified';
      if(/not logged in|not authenticated/i.test(combined)) auth='not_logged_in';
      else if(/logged in using chatgpt/i.test(combined)) auth='chatgpt';
      else if(/logged in using an api key|logged in using api key/i.test(combined)) auth='api_key';
      resolve({exitCode,auth,timedOut,permissionWarning:/access is denied|permission denied/i.test(combined),version:stdout.match(/codex-cli\s+[\d.]+/)?.[0]});
    });
  });
}
async function accountProbe(home=baseHome,fetchQuota=true) {
  const child=spawn(binary,['app-server','--listen','stdio://'],{cwd:root,env:environment(home),windowsHide:true,stdio:['pipe','pipe','pipe']});
  const waiting=new Map();let serial=0,buffer='',permissionWarning=false,closed=false;
  child.stderr.on('data',b=>{permissionWarning ||= /access is denied|permission denied/i.test(b.toString());});
  const rejectAll=()=>{closed=true;for(const p of waiting.values())p.reject(new Error('server_closed'));waiting.clear();};
  child.on('error',rejectAll);child.on('close',rejectAll);
  child.stdout.on('data',b=>{
    buffer+=b.toString();
    while(buffer.includes('\n')) {
      const at=buffer.indexOf('\n');const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
      let packet;try{packet=JSON.parse(line);}catch{continue;}
      const request=waiting.get(packet.id);
      if(!request)continue;
      waiting.delete(packet.id);
      if(packet.error)request.reject(new Error('rpc_error_'+String(packet.error.code)));
      else request.resolve(packet.result);
    }
  });
  function request(method,params) {
    return new Promise((resolve,reject)=>{
      if(closed)return reject(new Error('server_closed'));
      const id=++serial;const timeout=setTimeout(()=>{waiting.delete(id);reject(new Error('rpc_timeout'));},12000);
      waiting.set(id,{resolve:v=>{clearTimeout(timeout);resolve(v);},reject:e=>{clearTimeout(timeout);reject(e);}});
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,...(params?{params}:{})})+'\n');
    });
  }
  const result={check:'app_server_read_only',initialized:false,accountRead:false,quotaRead:false};
  try {
    await request('initialize',{clientInfo:{name:'vibe_usage_verifier',title:'Vibe read-only verification',version:'0.0.1'},capabilities:{experimentalApi:false}});
    result.initialized=true;
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized'})+'\n');
    const account=await request('account/read',{refreshToken:false});
    result.accountRead=true;
    result.accountType=account?.account?.type || null;
    result.plan=account?.account?.planType || null;
    if(!fetchQuota || !account?.account) {result.noAccount=!account?.account;return result;}
    const quota=await request('account/rateLimits/read');
    result.quotaRead=true;
    const buckets=quota?.rateLimitsByLimitId || (quota?.rateLimits?{default:quota.rateLimits}:{});
    result.buckets=Object.entries(buckets).map(([id,b])=>({
      id,plan:b.planType || null,
      windows:['primary','secondary'].filter(key=>b[key]).map(key=>({kind:key,usedPercent:b[key].usedPercent,windowMinutes:b[key].windowDurationMins,hasReset:Number.isFinite(b[key].resetsAt)})),
      hasCreditFields:b.credits!==undefined
    }));
  } catch(error) { result.error=/^(rpc_error_-?\d+|rpc_timeout|server_closed)$/.test(error.message)?error.message:'probe_failed'; }
  finally {
    result.permissionWarning=permissionWarning;
    child.stdin.end();
    if(!child.killed)child.kill();
    await new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)resolve();else {const timer=setTimeout(resolve,2000);child.once('close',()=>{clearTimeout(timer);resolve();});}});
    result.ownedProcessExited=child.exitCode!==null||child.signalCode!==null;
  }
  return result;
}
(async()=>{
  output.checks.push({check:'installed_version',...await run(['--version'])});
  output.checks.push({check:'current_login_status',...await run(['login','status'])});
  for(const name of ['codex-empty-a','codex-empty-b']) {
    const home=path.join(root,'artifacts','verification',name);
    fs.mkdirSync(home,{recursive:true});
    if(fs.existsSync(path.join(home,'auth.json')))throw new Error('negative_control_contains_credentials');
    const config=path.join(home,'config.toml');
    if(!fs.existsSync(config))fs.writeFileSync(config,'cli_auth_credentials_store = "file"\n');
    output.checks.push({check:name,...await run(['login','status'],home)});
  }
  output.checks.push({...await accountProbe(path.join(root,'artifacts','verification','codex-empty-a'),false),check:'empty_home_app_server_negative_control'});
  // Skip an expired file-backed OAuth token: this probe must not cause token renewal.
  let expired=false;
  try {
    const auth=JSON.parse(fs.readFileSync(authPath,'utf8'));
    const token=auth.tokens?.access_token;
    if(typeof token==='string') {
      const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());
      expired=typeof claims.exp==='number'&&claims.exp*1000<=Date.now()+60000;
    }
  } catch { /* OS-store credentials are handled by the installed client, never printed. */ }
  if(expired)output.checks.push({check:'app_server_read_only',skipped:'existing_file_token_expired_no_refresh_allowed'});
  else output.checks.push(await accountProbe());
  output.checks.push({check:'existing_auth_file_unchanged',unchanged:authBefore===hashFile(authPath)});
  output.limitations.push('No second authenticated account was selected or tested.');
  output.limitations.push('No model request, quota exhaustion, cross-account resume or running desktop account switch was tested.');
  const result=JSON.stringify(output,null,2);
  const outputPath=path.join(root,'artifacts','verification','codex-sanitized.json');
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});fs.writeFileSync(outputPath,result);
  process.stdout.write(result+'\n');
})().catch(error=>{process.stderr.write(['negative_control_contains_credentials'].includes(error.message)?error.message:'Verification failed without exposing process output.');process.exitCode=1;});
