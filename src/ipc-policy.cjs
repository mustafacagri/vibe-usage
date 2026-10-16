const PROVIDERS=new Set(['codex','claude','cursor','antigravity']);
function assertSender(event,expectedUrl){
 if(event.senderFrame!==event.sender.mainFrame||event.senderFrame?.url!==expectedUrl)throw new Error('Kaynak reddedildi');
}
function validateRefresh(value){if(value!==undefined&&!PROVIDERS.has(value))throw new Error('Bilinmeyen hizmet');return value;}
function validateAccountLabel(value){if(typeof value!=='string'||!value.trim()||value.length>64||/[\x00-\x1f]/.test(value))throw new Error('Geçersiz hesap adı');return value.trim();}
module.exports={assertSender,validateRefresh,validateAccountLabel};
