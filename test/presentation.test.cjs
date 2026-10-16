const {test}=require('node:test');
const assert=require('node:assert/strict');
const {formatWindow,formatFreshness}=require('../src/shared.cjs');
test('unknown quota is not treated as full and has no fabricated reset',()=>{
 const result=formatWindow({remainingPercent:null,usedPercent:null,resetsAt:null});
 assert.equal(result.value,'Veri yok');assert.equal(result.percent,null);assert.equal(result.reset,'');
});
test('zero remaining is preserved and inactive model scope remains visible',()=>{
 assert.equal(formatWindow({remainingPercent:0,resetsAt:null}).value,'%0');
 const inactive=formatWindow({remainingPercent:100,usedPercent:0,scope:'Fable',active:false,resetsAt:null});
 assert.equal(inactive.value,'%0 kullanılan');assert.match(inactive.note,/pasif/);
});
test('inactive session metadata never hides measured remaining allowance',()=>{
 assert.equal(formatWindow({remainingPercent:95,usedPercent:5,active:false,resetsAt:null}).value,'%95');
});
test('monetary pools use explicit amount text without inventing a percentage',()=>{
 const result=formatWindow({remainingPercent:null,valueText:'0 cent kalan',detail:'Ek kullanım kapalı.',active:false});
 assert.equal(result.value,'0 cent kalan');assert.equal(result.percent,null);assert.equal(result.note,'Ek kullanım kapalı.');
});
test('invalid numeric and reset fields cannot leak NaN or invalid date into UI',()=>{
 const result=formatWindow({remainingPercent:NaN,resetsAt:'nonsense'});
 assert.equal(result.value,'Veri yok');assert.equal(result.reset,'');
});
test('failed refresh explicitly labels retained data as old',()=>{
 const result=formatFreshness('2026-10-16T09:00:00Z','stale',Date.parse('2026-10-16T09:04:00Z'));
 assert.match(result,/4 dk/);assert.match(result,/Eski/);
});
