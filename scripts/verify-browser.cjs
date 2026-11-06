const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, mkdirSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const { tmpdir } = require('node:os');
const path = require('node:path');
(async()=>{
 const {createApp}=await import(require('node:url').pathToFileURL(path.resolve(__dirname, '../server.js')).href);
 const {DatabaseSync}=await import('node:sqlite');
 const dir=mkdtempSync(path.join(tmpdir(),'money-browser-'));
 const password=randomBytes(24).toString('hex');
 const dbPath=path.join(dir,'app.sqlite');
 const app=createApp({dbPath,adminPassword:password});
 await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.address().port}`;
 const out=process.env.REPORT_DIR || path.join(tmpdir(),'money-prelaunch-artifacts');mkdirSync(out,{recursive:true});
 let browser,db;
 try{
  browser=await chromium.launch({executablePath:'/usr/lib/chromium/chromium',headless:true,timeout:20000,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
  for(const width of [320,390,760,1440]){
   await page.setViewportSize({width,height:844});await page.goto(base,{waitUntil:'load'});
   const metrics=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,body:parseFloat(getComputedStyle(document.body).fontSize),card:parseFloat(getComputedStyle(document.querySelector('.cards p')).fontSize),buttons:[...document.querySelectorAll('.button,.header-link')].map(e=>e.getBoundingClientRect().height)}));
   assert.equal(metrics.scroll,width);assert(metrics.body>=18&&metrics.card>=18);assert(metrics.buttons.every(h=>h>=44));
   console.log('PASS layout',JSON.stringify(metrics));
  }
  await page.setViewportSize({width:390,height:844});await page.goto(base);
  await page.screenshot({path:out+'/mobile.png',fullPage:true});
  let posts=0;page.on('request',req=>{if(req.method()==='POST')posts++});
  await page.locator('button[type=submit]').click();assert.equal(posts,0);
  assert.equal(await page.locator('#name').evaluate(e=>e.validity.valueMissing),true);
  await page.locator('#name').fill('動作確認専用 架空ユーザー');await page.locator('#email').fill('invalid');
  await page.locator('#preference').selectOption('平日の日中');await page.locator('[name=consent]').check();
  await page.locator('button[type=submit]').click();assert.equal(posts,0);assert.equal(await page.locator('#email').evaluate(e=>e.validity.typeMismatch),true);
  await page.locator('#email').fill('lp-test@example.com');await page.locator('[name=consent]').uncheck();
  await page.locator('button[type=submit]').click();assert.equal(posts,0);await page.locator('[name=consent]').check();
  const malicious='<img src=x onerror="window.injected=true"><script>window.injected=true</script>';
  await page.locator('#message').fill(malicious);
  const sent=page.waitForResponse(r=>r.url().endsWith('/api/consultations')&&r.status()===201);await page.locator('button[type=submit]').click();await sent;
  await page.waitForFunction(()=>document.querySelector('#form-status').textContent.includes('受付が完了'));
  assert.equal(await page.locator('#name').inputValue(),'');
  await page.locator('#form-status').screenshot({path:out+'/success.png'});
  const adminContext=await browser.newContext({httpCredentials:{username:'admin',password},viewport:{width:1200,height:900}});
  const admin=await adminContext.newPage();await admin.goto(base+'/admin');await admin.waitForFunction(()=>document.querySelector('#admin-status').textContent==='1件の申込');
  assert((await admin.locator('#applications').innerText()).includes('lp-test@example.com'));
  assert((await admin.locator('#applications').innerText()).includes(malicious));assert.equal(await admin.locator('#applications img, #applications script').count(),0);assert.equal(await admin.evaluate(()=>window.injected),undefined);
  await admin.screenshot({path:out+'/admin-synthetic-data.png',fullPage:true});
  console.log('PASS real browser submit, native required/email/consent validation, admin listing and stored XSS protection');
  await admin.route('**/api/applications',route=>route.fulfill({status:401,contentType:'application/json',body:'{}'}));
  await admin.locator('#reload').click();await admin.waitForFunction(()=>document.querySelector('#admin-status').textContent.includes('取得できません'));
  assert.equal(await admin.locator('.application').count(),0);await adminContext.close();
  await page.locator('#name').fill('送信失敗検証 架空ユーザー');await page.locator('#email').fill('failure-test@example.com');await page.locator('#preference').selectOption('土日祝');await page.locator('[name=consent]').check();
  db=new DatabaseSync(dbPath);db.exec("CREATE TRIGGER reject_browser BEFORE INSERT ON applications BEGIN SELECT RAISE(ABORT, 'test-only'); END;");
  await page.locator('button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#form-status').textContent.includes('保存できません'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM applications').get().n,1);
  assert.equal(await page.locator('#name').inputValue(),'送信失敗検証 架空ユーザー');assert.equal(await page.locator('button[type=submit]').isEnabled(),true);
  await page.locator('#consultation-form').screenshot({path:out+'/save-failure.png'});db.exec('DROP TRIGGER reject_browser');
  await page.route('**/api/consultations',route=>route.fulfill({status:502,contentType:'text/html',body:'<html>Bad gateway</html>'}));
  await page.locator('button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#form-status').textContent.includes('応答を確認できません'));
  await page.unroute('**/api/consultations');await page.route('**/api/consultations',route=>route.abort('failed'));
  await page.locator('button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#form-status').textContent.includes('通信に失敗しました'));
  assert.equal(await page.locator('#email').inputValue(),'failure-test@example.com');assert.equal(await page.locator('[name=consent]').isChecked(),true);
  await page.locator('#consultation-form').screenshot({path:out+'/network-failure.png'});
  console.log('PASS real DB write failure, non-JSON 502, network failure, Japanese error text, retained inputs, retry enabled, stale admin data cleared');
  console.log('PASS synthetic data only; temporary DB will be deleted');
 }finally{
  if(db)db.close();if(browser)await browser.close();app.closeAllConnections();await new Promise(resolve=>app.close(resolve));rmSync(dir,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1});
