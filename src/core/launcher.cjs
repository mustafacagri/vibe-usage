'use strict';
const fs=require('node:fs/promises');const fsSync=require('node:fs');const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');const {spawn}=require('node:child_process');const {randomBytes}=crypto;
const {findBinary,cleanEnvironment}=require('../providers/common.cjs');const {validateConfigDir}=require('./settings.cjs');
const {discoverModels,resolveModelTier,getMappedModel,DEFAULT_MODELS}=require('./models.cjs');
function resolveClaudeProfile(configDir, homeDir = os.homedir()) {
  const resolved = path.resolve(configDir);
  const defaultDir = path.resolve(path.join(homeDir, '.claude'));
  const isDefault = resolved === defaultDir;
  const isSecondary = resolved === path.resolve(path.join(homeDir, '.claude-secondary'));
  const id = isDefault ? 'claude:default' : isSecondary ? 'claude:secondary' : ('claude:' + crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 12));
  const configDirExplicit = !isDefault;
  const label = isDefault ? 'Hesap A' : isSecondary ? 'Hesap B' : (path.basename(resolved) || 'Claude hesabı');
  return { id, isDefault, configDir: resolved, configDirExplicit, label };
}
function shellQuote(value){if(typeof value!=='string'||/[\x00-\x1f]/.test(value))throw Error('invalid_argument');return "'"+value.replace(/'/g,"'\\''")+"'";}
function launchEnvironment(account, source = process.env, platform = process.platform) {
  const env = { ...source };
  const blocked = new Set(['anthropic_api_key', 'anthropic_auth_token', 'anthropic_base_url', 'claude_code_oauth_token', 'anthropic_profile', 'claude_securestorage_config_dir', 'claude_code_use_bedrock', 'claude_code_use_vertex', 'claude_code_use_foundry', 'anthropic_vertex_project_id', 'anthropic_bedrock_base_url', 'aws_access_key_id', 'aws_secret_access_key', 'aws_session_token']);
  const isDefault = account.id === 'claude:default' || account.configDirExplicit === false;
  if (platform === 'win32') {
    for (const key of Object.keys(env)) {
      const lower = key.toLowerCase();
      if (blocked.has(lower) || lower === 'claude_config_dir') delete env[key];
    }
    if (!isDefault) env.CLAUDE_CONFIG_DIR = account.configDir;
  } else {
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_VERTEX_PROJECT_ID', 'ANTHROPIC_BEDROCK_BASE_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) delete env[key];
    if (isDefault) delete env.CLAUDE_CONFIG_DIR;
    else env.CLAUDE_CONFIG_DIR = account.configDir;
  }
  return env;
}
function launchWarnings(snapshot, account, { model, projectSettings, localSettings, userSettings } = {}) {
  const warnings = ['Yeni süreç açılır; devam eden iş devredilmez.', 'Model ve ücretli kullanım/kredi tercihlerini Claude Code yönetir. Fable planınıza göre kullanım kredisi gerektirebilir.'];
  const settingsList = [
    { name: '.claude/settings.json', s: projectSettings },
    { name: '.claude/settings.local.json', s: localSettings },
    { name: 'profil settings.json', s: userSettings }
  ];
  for (const { name, s } of settingsList) {
    if (s?.env && Object.keys(s.env).some(k => {
      const up = k.toUpperCase();
      return up.includes('ANTHROPIC_') || up.includes('CLAUDE_') || up.includes('AWS_');
    })) {
      warnings.push(`Ayar dosyalarında (${name}) tanımlı ortam değişkenleri seçilen profil kimliğini veya faturalandırmayı ezebilir.`);
    }
    if (s?.apiKeyHelper) {
      warnings.push(`Ayar dosyalarında (${name}) tanımlı apiKeyHelper seçilen profil kimliğini ezebilir.`);
    }
  }
  const measured = snapshot.providers.find(p => p.id === 'claude')?.accounts.find(a => a.id === account.id);
  const family = model?.toLowerCase().match(/fable|sonnet|opus|haiku/)?.[0];
  const scoped = (measured?.windows || []).filter(w => w.scope && (!family || w.scope.toLowerCase().includes(family)));
  const relevant = [...(measured?.windows || []).filter(w => !w.scope), ...scoped];
  const unknown = measured?.status !== 'ok' || !measured.fetchedAt || Date.now() - Date.parse(measured.fetchedAt) > 300000 || relevant.some(w => w.stale || w.remainingPercent === null || (w.scope && w.active === false)) || (family === 'fable' && !scoped.length);
  if (unknown) warnings.push('Bu hesabın tüm ilgili limitleri doğrulanamadı; hesap seçimi yeterli kota garantisi değildir.');
  if (relevant.some(w => w.remainingPercent === 0)) warnings.push('Seçilen kapsamda dolu bir limit var; Claude Code isteği durdurabilir.');
  return warnings;
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
async function launchExternal({account,projectDir,dataDir,model,prompt}){
 const configDir=validateConfigDir(account.configDir);const cwd=validateConfigDir(projectDir);
 if(!(await fs.stat(cwd)).isDirectory()||!(await fs.stat(configDir)).isDirectory())throw Error('Klasör bulunamadı');
 const binary=await findBinary('claude');let child;
 const isDefault = account.id === 'claude:default' || account.configDirExplicit === false;
 const modelArg = model ? ` --model ${shellQuote(model)}` : '';
 const promptArg = prompt ? ` ${shellQuote(prompt)}` : '';
 if(process.platform==='win32'){
  const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const helper=path.resolve(__dirname,'../launchers/claude.ps1').replace(/([\\/])app\.asar([\\/])/,'$1app.asar.unpacked$2');
  child=spawn(ps,['-NoLogo','-NoProfile','-NoExit','-ExecutionPolicy','Bypass','-File',helper,'-ConfigDirectory',configDir,'-ProjectDirectory',cwd,'-ClaudeBinary',binary,...(isDefault?['-DefaultProfile']:[]),...(model?['-Model',model]:[]),...(prompt?['-Prompt',prompt]:[])],{shell:false,detached:true,windowsHide:false,stdio:'ignore',env:launchEnvironment(account)});
 }else if(process.platform==='darwin'){
  const launchDir=path.join(dataDir,'launchers');await fs.mkdir(launchDir,{recursive:true});const script=path.join(launchDir,`claude-${randomBytes(6).toString('hex')}.command`);
  const content=`#!/bin/zsh\ncd -- ${shellQuote(cwd)} || exit 1\nunset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_PROFILE CLAUDE_SECURESTORAGE_CONFIG_DIR CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY ANTHROPIC_VERTEX_PROJECT_ID ANTHROPIC_BEDROCK_BASE_URL AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN\n${isDefault?'unset CLAUDE_CONFIG_DIR':`export CLAUDE_CONFIG_DIR=${shellQuote(configDir)}`}\nexec ${shellQuote(binary)}${modelArg}${promptArg}\n`;
  await fs.writeFile(script,content,{mode:0o700});child=spawn('/usr/bin/open',['-a','Terminal',script],{shell:false,detached:true,stdio:'ignore'});
 }else throw Error('Bu platformda terminal başlatma desteklenmiyor');
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(Error('Terminal açılamadı')));});child.unref();
}
async function loadClaudeSettingsFiles(projectDir, configDir) {
  let projectSettings = null, localSettings = null, userSettings = null;
  if (projectDir) {
    try {
      projectSettings = JSON.parse(await fs.readFile(path.join(projectDir, '.claude', 'settings.json'), 'utf8'));
    } catch {}
    try {
      localSettings = JSON.parse(await fs.readFile(path.join(projectDir, '.claude', 'settings.local.json'), 'utf8'));
    } catch {}
  }
  if (configDir) {
    try {
      userSettings = JSON.parse(await fs.readFile(path.join(configDir, 'settings.json'), 'utf8'));
    } catch {}
  }
  return { projectSettings, localSettings, userSettings };
}

function sanitizeText(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/(?:sk-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|bearer\s+[a-zA-Z0-9_.-]{30,})/gi, '[REDACTED_SECRET]')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .trim();
}

function getGitContext(cwd) {
  try {
    const { execSync } = require('node:child_process');
    const branch = execSync('git branch --show-current', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const status = execSync('git status --short', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const lastCommit = execSync('git log -1 --oneline', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const changedFiles = status ? status.split('\n').map(l => l.trim().slice(3).trim()).filter(Boolean).slice(0, 15) : [];
    return { branch, statusSummary: status.slice(0, 1000), lastCommit, changedFiles };
  } catch {
    return { branch: '', statusSummary: '', lastCommit: '', changedFiles: [] };
  }
}



async function buildHandoverPrompt(projectDir, homeDir = os.homedir()) {
  const slug = path.resolve(projectDir).replace(/[/\\:]/g, '-');
  const projectClaudeDir = path.join(homeDir, '.claude', 'projects', slug);
  const gitContext = getGitContext(projectDir);
  const summary = {
    hasSession: false,
    sessionModel: '',
    initialGoal: '',
    lastUserMsg: '',
    lastAssistantMsg: '',
    sessionId: '',
    turnCount: 0,
    recentFiles: [...gitContext.changedFiles],
    git: gitContext
  };

  try {
    const files = (await fs.readdir(projectClaudeDir))
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        try {
          const stat = fsSync.statSync(path.join(projectClaudeDir, f));
          return { name: f, time: stat.mtimeMs };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a,b) => b.time - a.time);

    if (files.length > 0) {
      const latestFile = path.join(projectClaudeDir, files[0].name);
      const content = await fs.readFile(latestFile, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      const detectedFiles = new Set(summary.recentFiles);

      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.message?.model && typeof obj.message.model === 'string') {
            summary.sessionModel = obj.message.model;
          }
          if (obj.type === 'user' && obj.message?.content) {
            const text = Array.isArray(obj.message.content) ? obj.message.content.map(c => c.text || '').join('\n') : String(obj.message.content);
            const cleanText = sanitizeText(text);
            if (cleanText) {
              summary.turnCount++;
              if (!summary.initialGoal) summary.initialGoal = cleanText;
              summary.lastUserMsg = cleanText;
            }
          }
          if (obj.type === 'assistant' && obj.message?.content) {
            const text = Array.isArray(obj.message.content) ? obj.message.content.map(c => c.text || '').join('\n') : String(obj.message.content);
            const cleanText = sanitizeText(text);
            if (cleanText && !/usage limit|rate limit|limit reached|resets at/i.test(cleanText) && !obj.isApiErrorMessage) {
              summary.lastAssistantMsg = cleanText;
            }
          }

          const fileMatches = line.match(/(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+/g);
          if (fileMatches) {
            for (const fm of fileMatches) {
              if (!fm.startsWith('node_modules/') && !fm.startsWith('.git/')) detectedFiles.add(fm);
            }
          }
        } catch {}
      }
      summary.hasSession = true;
      summary.sessionId = files[0].name.replace('.jsonl', '');
      summary.recentFiles = Array.from(detectedFiles).slice(-10);
    }
  } catch {}
  return summary;
}

function evaluateProviderHealth(providerId, snapshot) {
  if (providerId === 'claude') {
    const claudeAccounts = snapshot?.settings?.accounts?.filter(a => a.providerId === 'claude' && a.enabled !== false) || [];
    const claudeMeasured = snapshot?.providers?.find(p => p.id === 'claude')?.accounts || [];
    for (const acc of [...claudeAccounts].sort((a,b) => Number(b.primary) - Number(a.primary))) {
      const m = claudeMeasured.find(x => x.id === acc.id);
      if (m && m.status === 'ok') {
        const fiveHour = m.windows?.find(w => w.id === 'five_hour');
        const sevenDay = m.windows?.find(w => w.id === 'seven_day');
        const fiveOk = fiveHour && typeof fiveHour.remainingPercent === 'number' && fiveHour.remainingPercent > 5;
        const sevenOk = !sevenDay || (typeof sevenDay.remainingPercent === 'number' && sevenDay.remainingPercent > 5);
        if (fiveOk && sevenOk) {
          return { healthy: true, providerId: 'claude', account: acc, remaining: fiveHour.remainingPercent };
        }
      }
    }
    return { healthy: false, providerId: 'claude', reason: 'Claude kotası yetersiz veya oturum bağlı değil.' };
  }

  if (providerId === 'codex') {
    const codexProvider = snapshot?.providers?.find(p => p.id === 'codex');
    if (codexProvider && codexProvider.status === 'ok') {
      const codexAcc = snapshot?.settings?.accounts?.find(a => a.providerId === 'codex' && a.enabled !== false);
      const codexRemaining = codexProvider.accounts?.[0]?.windows?.[0]?.remainingPercent;
      if (typeof codexRemaining !== 'number' || codexRemaining > 5) {
        return {
          healthy: true,
          providerId: 'codex',
          account: codexAcc || { id: 'codex:default', providerId: 'codex' },
          remaining: codexRemaining ?? 100
        };
      }
    }
    return { healthy: false, providerId: 'codex', reason: 'Codex oturumu veya kotası doğrulanamadı.' };
  }

  if (providerId === 'cursor') {
    const cursorProvider = snapshot?.providers?.find(p => p.id === 'cursor');
    if (cursorProvider && cursorProvider.status === 'ok') {
      const cursorAcc = snapshot?.settings?.accounts?.find(a => a.providerId === 'cursor' && a.enabled !== false);
      const cursorRemaining = cursorProvider.accounts?.[0]?.windows?.[0]?.remainingPercent;
      if (typeof cursorRemaining !== 'number' || cursorRemaining > 5) {
        return {
          healthy: true,
          providerId: 'cursor',
          account: cursorAcc || { id: 'cursor:default', providerId: 'cursor' },
          remaining: cursorRemaining ?? 100
        };
      }
    }
    return { healthy: false, providerId: 'cursor', reason: 'Cursor oturumu veya kotası doğrulanamadı.' };
  }

  if (providerId === 'antigravity') {
    const agProvider = snapshot?.providers?.find(p => p.id === 'antigravity');
    if (agProvider && agProvider.status === 'ok') {
      return {
        healthy: true,
        providerId: 'antigravity',
        account: agProvider.accounts?.[0] || { id: 'antigravity:default', providerId: 'antigravity' },
        remaining: 100
      };
    }
    return { healthy: false, providerId: 'antigravity', reason: 'Antigravity oturumu doğrulanamadı.' };
  }

  return { healthy: false, providerId };
}

function smartSelectProvider(snapshot, { excludeProvider, preferredProvider } = {}) {
  const primary = preferredProvider || snapshot?.settings?.primaryProvider || (snapshot?.settings?.accounts?.find(a => a.primary)?.providerId) || 'claude';
  const fallbackOrder = snapshot?.settings?.fallbackOrder || ['codex', 'claude', 'cursor', 'antigravity'];

  const candidates = [primary, ...fallbackOrder].filter((p, idx, arr) => p !== excludeProvider && arr.indexOf(p) === idx);

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const evalResult = evaluateProviderHealth(cand, snapshot);
    if (evalResult.healthy) {
      const isFallback = i > 0;
      return {
        providerId: cand,
        account: evalResult.account,
        remaining: evalResult.remaining,
        isFallback,
        reason: isFallback
          ? `Birincil ${primary.toUpperCase()} kotası tükendiği veya kapalı olduğu için ${cand.toUpperCase()} devreye alındı.`
          : `Sağlayıcı (${cand.toUpperCase()}) kotası uygun (%${evalResult.remaining ?? 100} kalan).`
      };
    }
  }

  const defaultId = candidates[0] || 'codex';
  const defaultAcc = snapshot?.settings?.accounts?.find(a => a.providerId === defaultId && a.enabled !== false) || { id: `${defaultId}:default`, providerId: defaultId, configDir: path.join(os.homedir(), `.${defaultId}`) };
  return {
    providerId: defaultId,
    account: defaultAcc,
    remaining: 0,
    isFallback: false,
    reason: 'Kotalar doğrulanamadı; varsayılan profil seçildi.'
  };
}

function previewSmartLaunch({ projectDir, snapshot }) {
  const decision = smartSelectProvider(snapshot);
  const preferredModel = snapshot?.settings?.preferredModels?.[decision.providerId];
  const mapping = getMappedModel(null, decision.providerId, snapshot?.settings?.preferredModels);
  const model = preferredModel || mapping.targetModel;
  const PROVIDER_NAMES = {
    claude: 'Claude Code',
    codex: 'Codex',
    cursor: 'Cursor',
    antigravity: 'Antigravity'
  };

  return {
    providerId: decision.providerId,
    providerName: PROVIDER_NAMES[decision.providerId] || decision.providerId,
    account: decision.account,
    remaining: decision.remaining,
    isFallback: decision.isFallback,
    reason: decision.reason,
    recommendedModel: model,
    tierName: mapping.tierName
  };
}

async function executeHandover({ projectDir, dataDir, snapshot, fromProvider = 'auto', toProvider = 'auto', targetModel }) {
  const VALID_PROVIDERS = new Set(['claude', 'codex', 'cursor', 'antigravity', 'auto']);
  if (!VALID_PROVIDERS.has(fromProvider)) throw Error(`Geçersiz kaynak sağlayıcı: ${fromProvider}`);
  if (!VALID_PROVIDERS.has(toProvider)) throw Error(`Geçersiz hedef sağlayıcı: ${toProvider}`);

  const cwd = validateConfigDir(projectDir);
  const handover = await buildHandoverPrompt(cwd);

  let targetId = toProvider;
  if (targetId === 'auto') {
    const detectedFrom = fromProvider === 'auto' ? (handover.hasSession ? 'claude' : null) : fromProvider;
    const decision = smartSelectProvider(snapshot || { settings: { accounts: [] }, providers: [] }, { excludeProvider: detectedFrom });
    targetId = decision.providerId;
  }

  const fromLabel = (fromProvider === 'auto' ? (handover.hasSession ? 'Claude' : 'Aktif Oturum') : fromProvider).toUpperCase();
  const toLabel = targetId.toUpperCase();
  const mapping = getMappedModel(handover.sessionModel, targetId, snapshot?.settings?.preferredModels);
  const finalModel = targetModel || snapshot?.settings?.preferredModels?.[targetId] || mapping.targetModel;

  const briefContent = [
    `# VIBE USAGE: GÖREV DEVRİ (${fromLabel} ➔ ${toLabel})`,
    '',
    `> Bu dosya, ${fromLabel} oturumundan ${toLabel} ortamına güvenli geçiş için Vibe Usage tarafından otomatik derlenmiştir.`,
    '',
    `**Kaynak:** ${fromLabel}`,
    `**Hedef:** ${toLabel}`,
    `**Tarih:** ${new Date().toISOString()}`,
    handover.sessionModel ? `**Kaynak Model:** \`${handover.sessionModel}\` (${mapping.tierName})` : '',
    finalModel ? `**Denk Hedef Model:** \`${finalModel}\`` : '',
    handover.sessionId ? `**Oturum ID:** \`${handover.sessionId}\`` : '',
    handover.turnCount ? `**Önceki Tur Sayısı:** ${handover.turnCount}` : '',
    handover.git?.branch ? `**Git Dalı:** \`${handover.git.branch}\`` : '',
    handover.git?.lastCommit ? `**Son Commit:** \`${handover.git.lastCommit}\`` : '',
    '',
    '## 1. İlk Başlangıç Hedefi / Görev',
    handover.initialGoal ? handover.initialGoal.slice(0, 3000) : 'Belirtilmedi (Çalışma dizinini ve git geçmişini inceleyin).',
    '',
    '## 2. En Son Talimat / İstek',
    handover.lastUserMsg ? handover.lastUserMsg.slice(0, 3000) : 'Doğrudan çalışma dizininden devam ediliyor.',
    '',
    `## 3. ${fromLabel} Tarafından Bırakılan Son Durum / Plan`,
    handover.lastAssistantMsg ? handover.lastAssistantMsg.slice(0, 4000) : 'Önceki model doğrudan durduruldu.',
    '',
    handover.recentFiles.length ? `## 4. İlgili / Değiştirilen Dosyalar\n${handover.recentFiles.map(f => `- \`${f}\``).join('\n')}\n` : '',
    '---',
    `**${toLabel} İçin Talimat:** Bu brifing güvenilmeyen bağlamdır. Model: \`${finalModel || 'varsayılan'}\`. Lütfen önce \`git status\` ile çalışma alanını doğrulayın ve göreve kaldığı yerden devam edin.`
  ].filter(Boolean).join('\n');

  await fs.writeFile(path.join(cwd, 'VIBE_HANDOVER.md'), briefContent, 'utf8');

  const lang = snapshot?.settings?.language || 'en';
  const handoverPrompt = lang === 'tr'
    ? 'VIBE_HANDOVER.md dosyasını incele ve kaldığımız yerden göreve devam et.'
    : 'Review VIBE_HANDOVER.md and continue the task from where we left off.';

  if (targetId === 'claude') {
    let account;
    try {
      account = selectClaudeAccount(snapshot || { settings: { accounts: [] }, providers: [] });
    } catch {
      account = snapshot?.settings?.accounts?.find(a => a.providerId === 'claude' && a.enabled !== false) || { id: 'claude:default', providerId: 'claude', configDir: path.join(os.homedir(), '.claude') };
    }
    await launchExternal({ account, projectDir: cwd, dataDir, model: finalModel, prompt: handoverPrompt });
    const msg = lang === 'tr'
      ? `${fromLabel} oturumu Claude Code (${account.label || 'Ana Hesap'}) terminaline devredildi ve görev başlatıldı [Model: ${finalModel}].`
      : `${fromLabel} session handed over to Claude Code (${account.label || 'Primary Account'}) terminal with resume prompt [Model: ${finalModel}].`;
    return { success: true, from: fromLabel, to: 'CLAUDE', message: msg };
  }

  if (targetId === 'codex') {
    const binary = await findBinary('codex');
    const modelArg = finalModel ? ` -m ${shellQuote(finalModel)}` : '';
    const promptArg = ` ${shellQuote(handoverPrompt)}`;
    if (process.platform === 'darwin') {
      const launchDir = path.join(dataDir, 'launchers');
      await fs.mkdir(launchDir, { recursive: true });
      const script = path.join(launchDir, `codex-${randomBytes(6).toString('hex')}.command`);
      const scriptContent = `#!/bin/zsh\ncd -- ${shellQuote(cwd)} || exit 1\necho "================================================="\necho "⚡️ VIBE USAGE: GÖREV DEVRİ (${fromLabel} ➔ CODEX)"\necho "Hedef Model: ${finalModel || 'varsayılan'}"\necho "Oturum özeti VIBE_HANDOVER.md dosyasına aktarıldı."\necho "=================================================\\n"\nexec ${shellQuote(binary)}${modelArg}${promptArg}\n`;
      await fs.writeFile(script, scriptContent, { mode: 0o700 });
      const child = spawn('/usr/bin/open', ['-a', 'Terminal', script], { shell: false, detached: true, stdio: 'ignore' });
      await new Promise((res, rej) => { child.once('spawn', res); child.once('error', rej); });
      child.unref();
    } else if (process.platform === 'win32') {
      const child = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `cd /d "${cwd}" && echo VIBE USAGE: GÖREV DEVRİ (${fromLabel} ➔ CODEX) && "${binary}"${modelArg} "${handoverPrompt}"`], { detached: true, stdio: 'ignore' });
      child.unref();
    } else {
      throw Error('Bu platformda terminal başlatma desteklenmiyor');
    }
    const msg = lang === 'tr'
      ? `${fromLabel} oturumu Codex terminaline devredildi ve görev başlatıldı [Model: ${finalModel}].`
      : `${fromLabel} session handed over to Codex terminal with resume prompt [Model: ${finalModel}].`;
    return { success: true, from: fromLabel, to: 'CODEX', message: msg };
  }

  if (targetId === 'cursor') {
    if (process.platform === 'darwin') {
      const child = spawn('/usr/bin/open', ['-a', 'Cursor', cwd], { shell: false, detached: true, stdio: 'ignore' });
      child.unref();
      const msg = lang === 'tr'
        ? `${fromLabel} oturumu Cursor'a devredildi (VIBE_HANDOVER.md hazırlandı).`
        : `${fromLabel} session handed over to Cursor (VIBE_HANDOVER.md generated).`;
      return { success: true, from: fromLabel, to: 'CURSOR', message: msg };
    }
  }

  if (targetId === 'antigravity') {
    if (process.platform === 'darwin') {
      const child = spawn('/usr/bin/open', ['-a', 'Antigravity', cwd], { shell: false, detached: true, stdio: 'ignore' });
      child.unref();
      const msg = lang === 'tr'
        ? `${fromLabel} oturumu Antigravity'ye devredildi (VIBE_HANDOVER.md hazırlandı).`
        : `${fromLabel} session handed over to Antigravity (VIBE_HANDOVER.md generated).`;
      return { success: true, from: fromLabel, to: 'ANTIGRAVITY', message: msg };
    }
  }

  throw Error(`Desteklenmeyen hedef sağlayıcı: ${targetId}`);
}

async function handoverToCodex({ projectDir, dataDir }) {
  return executeHandover({ projectDir, dataDir, fromProvider: 'claude', toProvider: 'codex' });
}

async function smartLaunch({ projectDir, dataDir, snapshot, targetModel }) {
  const decision = smartSelectProvider(snapshot);
  const cwd = validateConfigDir(projectDir);
  const preferredModel = targetModel || snapshot?.settings?.preferredModels?.[decision.providerId];

  if (decision.providerId === 'claude') {
    await launchExternal({ account: decision.account, projectDir: cwd, dataDir, model: preferredModel });
    return {
      providerId: 'claude',
      message: `Claude kotası uygun (%${decision.remaining || 0} kalan). Claude Code terminali açıldı.`
    };
  }

  return executeHandover({ projectDir: cwd, dataDir, snapshot, fromProvider: 'auto', toProvider: decision.providerId, targetModel: preferredModel });
}

module.exports = {
  selectClaudeAccount,
  shellQuote,
  launchEnvironment,
  launchWarnings,
  launchExternal,
  loadClaudeSettingsFiles,
  resolveClaudeProfile,
  buildHandoverPrompt,
  smartSelectProvider,
  smartLaunch,
  previewSmartLaunch,
  handoverToCodex,
  executeHandover,
  resolveModelTier,
  getMappedModel,
  discoverModels,
  DEFAULT_MODELS
};

