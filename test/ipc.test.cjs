const {test}=require('node:test');const assert=require('node:assert/strict');
const {assertSender,validateRefresh,validateAccountLabel}=require('../src/ipc-policy.cjs');
test('only the local main frame may invoke privileged actions',()=>{
 const frame={url:'file:///app/index.html'};
 assert.doesNotThrow(()=>assertSender({senderFrame:frame,sender:{mainFrame:frame}},frame.url));
 assert.throws(()=>assertSender({senderFrame:{url:'https://evil.example'},sender:{mainFrame:frame}},frame.url));
 assert.throws(()=>assertSender({senderFrame:{url:frame.url},sender:{mainFrame:frame}},frame.url));
});
test('refresh accepts only known provider names',()=>{
 assert.equal(validateRefresh('claude'),'claude');assert.equal(validateRefresh(),undefined);
 assert.throws(()=>validateRefresh('../private'));assert.throws(()=>validateRefresh({}));
});
test('account label must remain bounded plain text',()=>{
 assert.equal(validateAccountLabel('İş hesabı'),'İş hesabı');
 assert.throws(()=>validateAccountLabel('x'.repeat(1000)));assert.throws(()=>validateAccountLabel('\u0000'));
});
