import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
const password='test-only-long-password';
const authorization='Basic '+Buffer.from('admin:'+password).toString('base64');
async function app(t, options={}) {
 const storage={ready:async()=>{},close:async()=>{},health:async()=>{},login:async({valid})=>({authorized:valid,lockedUntil:0}),list:async()=>[],insert:async()=>{}};
 const server=createApp({storage,adminPassword:password,privateSite:true,...options});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 return 'http://127.0.0.1:'+server.address().port;
}
test('private by default: page/assets/API/unknown paths protected',async t=>{
 const base=await app(t);
 for(const path of ['/','/styles.css','/app.js','/admin','/admin.js','/api/applications','/unknown']) {
 const r=await fetch(base+path); assert.equal(r.status,401);assert.equal(r.headers.get('cache-control'),'no-store');assert.match(r.headers.get('x-robots-tag'),/noindex/);
 }
 assert.equal((await fetch(base+'/api/consultations',{method:'POST'})).status,401);
});
test('health check works without credentials',async t=>{
 const base=await app(t);assert.equal((await fetch(base+'/healthz')).status,200);
 assert.equal((await fetch(base+'/healthz',{method:'HEAD'})).status,200);
});
test('correct credentials access admin API and form validation',async t=>{
 const base=await app(t);
 assert.equal((await fetch(base+'/api/applications',{headers:{authorization}})).status,200);
 assert.equal((await fetch(base+'/api/consultations',{method:'POST',headers:{authorization,'content-type':'application/json'},body:'{}'})).status,400);
 assert.equal((await fetch(base+'/unknown',{headers:{authorization}})).status,404);
});
test('incorrect credentials denied and missing password fails closed',async t=>{
 const base=await app(t);assert.equal((await fetch(base+'/',{headers:{authorization:'Basic '+Buffer.from('admin:wrong').toString('base64')}})).status,401);
 const missing=await app(t,{adminPassword:''});assert.equal((await fetch(missing+'/')).status,503);
});
test('lockout protects whole private site',async t=>{
 const base=await app(t,{storage:{health:async()=>{},close:async()=>{},login:async()=>({lockedUntil:Date.now()+60000})}});
 assert.equal((await fetch(base+'/')).status,429);
});

