const {test}=require('node:test');const assert=require('node:assert/strict');
const {selectClaudeAccount,shellQuote,launchEnvironment,launchWarnings}=require('../src/core/launcher.cjs');
const make=(id,primary,windows,status='ok')=>({id,providerId:'claude',configDir:'C:\\Users\\fixture\\'+id,label:id,primary,enabled:true,status,fetchedAt:new Date().toISOString(),windows});
const full=[{id:'five_hour',remainingPercent:20},{id:'seven_day',remainingPercent:40}];
function snapshot(accounts){return {settings:{accounts:accounts.map(({windows,status,fetchedAt,...a})=>a)},providers:[{id:'claude',accounts}]};}
test('new job prefers primary account and skips exhausted primary',()=>{
 assert.equal(selectClaudeAccount(snapshot([make('a',true,full),make('b',false,full)]),{}).id,'a');
 assert.equal(selectClaudeAccount(snapshot([make('a',true,[{id:'five_hour',remainingPercent:0},full[1]]),make('b',false,full)]),{}).id,'b');
});
test('unknown weekly data or stale data never silently qualify for auto selection',()=>{
 assert.throws(()=>selectClaudeAccount(snapshot([make('a',true,[full[0],{id:'seven_day',remainingPercent:null}])]),{}));
 assert.throws(()=>selectClaudeAccount(snapshot([make('a',true,full,'stale')]),{}));
 assert.throws(()=>selectClaudeAccount(snapshot([make('a',true,[full[0]])]),{}));
});
test('explicit account choice remains distinct from changing primary',()=>{
 assert.equal(selectClaudeAccount(snapshot([make('a',true,full),make('b',false,full)]),{accountId:'b'}).id,'b');
 assert.throws(()=>selectClaudeAccount(snapshot([make('a',true,full)]),{accountId:'unknown'}));
});
test('passive Fable metadata is not inferred as included entitlement',()=>{
 assert.throws(()=>selectClaudeAccount(snapshot([make('a',true,[...full,{id:'fable',scope:'Fable',remainingPercent:100,active:false}])]),{model:'fable'}));
});
test('unknown default model never bypasses known exhausted scoped windows',()=>{
 assert.throws(()=>selectClaudeAccount(snapshot([make('a',true,[...full,{id:'sonnet',scope:'Sonnet',remainingPercent:0}])]),{}));
 assert.throws(()=>selectClaudeAccount(snapshot([make('a',true,[...full,{id:'sonnet',scope:'Sonnet',remainingPercent:null}])]),{model:'custom-model'}));
});
test('Mac command arguments quote literal shell metacharacters',()=>{
 assert.equal(shellQuote("a'b;$(touch nope)"),"'a'\\''b;$(touch nope)'");
 assert.throws(()=>shellQuote('x\ncommand'));
});
test('launch environment uses the same unset default credential selector as monitoring',()=>{
 const source={CLAUDE_CONFIG_DIR:'/wrong',CLAUDE_SECURESTORAGE_CONFIG_DIR:'/wrong-store',ANTHROPIC_API_KEY:'fixture'};
 const env=launchEnvironment({id:'claude:default',configDir:'/home/fixture/.claude'},source);
 assert.equal(env.CLAUDE_CONFIG_DIR,undefined);assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR,undefined);assert.equal(env.ANTHROPIC_API_KEY,undefined);
 assert.equal(launchEnvironment({id:'claude:secondary',configDir:'/secondary'},source).CLAUDE_CONFIG_DIR,'/secondary');
 assert.equal(source.CLAUDE_CONFIG_DIR,'/wrong');
});
test('explicit launch warns about unresolved scoped limits',()=>{
 const account=make('a',true,[...full,{id:'sonnet',scope:'Sonnet',remainingPercent:null}]);
 assert.ok(launchWarnings(snapshot([account]),account,{model:'sonnet'}).some(w=>/limitleri doğrulanamadı/.test(w)));
 assert.ok(launchWarnings(snapshot([make('a',true,full)]),account,{model:'fable'}).some(w=>/kredisi/.test(w)));
});
