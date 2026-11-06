import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.js';
const valid = { name: '山田 花子', email: 'hanako@example.com', preference: '平日の日中', message: '<script>alert(1)</script>', consent: true };
const auth = { Authorization: `Basic ${Buffer.from('admin:test-password').toString('base64')}` };
async function start(options) { const app = createApp(options); app.listen(0, '127.0.0.1'); await once(app, 'listening'); return { app, base: `http://127.0.0.1:${app.address().port}` }; }
async function stop(app) { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
function post(base, data, headers = {}) { return fetch(`${base}/api/consultations`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) }); }
test('申込の保存・認証・再起動後の永続化', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tsumugi-')); const options = { dbPath: path.join(dir, 'app.sqlite'), adminPassword: 'test-password' };
  let running = await start(options);
  try {
    const page = await fetch(running.base); assert.equal(page.status, 200); assert.match(await page.text(), /無料相談のお申込み/);
    assert.equal((await fetch(running.base + '/admin')).status, 401);
    assert.equal((await fetch(running.base + '/api/applications')).status, 401);
    assert.equal((await fetch(running.base + '/api/applications', { headers: { Authorization: 'Basic ' + Buffer.from('admin:wrong').toString('base64') } })).status, 401);
    assert.equal((await post(running.base, { ...valid, consent: false })).status, 400);
    assert.equal((await post(running.base, { ...valid, email: 'invalid' })).status, 400);
    assert.equal((await post(running.base, { ...valid, name: '' })).status, 400);
    assert.equal((await post(running.base, valid, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(running.base, valid)).status, 201);
    let response = await fetch(running.base + '/api/applications', { headers: auth });
    let data = await response.json(); assert.equal(data.applications.length, 1); assert.equal(data.applications[0].name, valid.name); assert.equal(data.applications[0].message, valid.message);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    await stop(running.app); running = await start(options);
    data = await (await fetch(running.base + '/api/applications', { headers: auth })).json(); assert.equal(data.applications.length, 1);
    assert.equal((await fetch(running.base + '/admin', { headers: auth })).status, 200);
    for (let i = 0; i < 10; i++) assert.equal((await post(running.base, valid)).status, 201);
    assert.equal((await post(running.base, valid)).status, 429);
  } finally { await stop(running.app); rmSync(dir, { recursive: true, force: true }); }
});
test('管理者パスワード未設定時は情報を公開しない', async () => {
  const { app, base } = await start({ dbPath: ':memory:', adminPassword: '' });
  try { assert.equal((await fetch(base + '/api/applications')).status, 503); assert.equal((await fetch(base + '/admin')).status, 503); }
  finally { await stop(app); }
});

test('認証形式・不正JSON・個人情報ファイルの保護', async () => {
  const { app, base } = await start({ dbPath: ':memory:', adminPassword: 'test-password' });
  try {
    for (const authorization of [Buffer.from('admin:test-password').toString('base64'), 'Bearer ' + Buffer.from('admin:test-password').toString('base64'), 'Basic ' + Buffer.from('other:test-password').toString('base64'), 'Basic ' + Buffer.from('test-password').toString('base64')]) {
      assert.equal((await fetch(base + '/api/applications', { headers: { Authorization: authorization } })).status, 401);
    }
    for (const input of [null, [], 'string', { ...valid, name: '   ' }, { ...valid, message: 'a'.repeat(1001) }, { ...valid, preference: 'unknown' }]) assert.equal((await post(base, input)).status, 400);
    assert.equal((await fetch(base + '/api/consultations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await post(base, { ...valid, message: 'a'.repeat(17000) })).status, 413);
    assert.equal((await fetch(base + '/api/consultations', { method: 'POST', body: 'hello' })).status, 415);
    for (const url of ['/data/app.sqlite', '/data/app.sqlite-wal', '/.env', '/server.js', '/test/app.test.js']) assert.equal((await fetch(base + url)).status, 404);
    const res = await fetch(base + '/admin', { headers: auth });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await (await fetch(base + '/api/applications', { headers: auth })).json()).applications.length, 0);
  } finally { await stop(app); }
});

test('SQLite書込み失敗は成功扱いにせず、個人情報や内部例外を返さない', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { statSync } = await import('node:fs');
  const dir = mkdtempSync(path.join(tmpdir(), 'money-db-failure-'));
  const dbPath = path.join(dir, 'app.sqlite');
  const { app, base } = await start({ dbPath, adminPassword: 'test-password' });
  const control = new DatabaseSync(dbPath);
  try {
    assert.equal(statSync(dbPath).mode & 0o777, 0o600);
    control.exec("CREATE TRIGGER reject_test BEFORE INSERT ON applications BEGIN SELECT RAISE(ABORT, 'internal diagnostic'); END;");
    const response = await post(base, valid); assert.equal(response.status, 500);
    const body = await response.text(); assert.match(body, /保存できませんでした/); assert.doesNotMatch(body, /internal diagnostic|hanako|script/);
    assert.equal((await (await fetch(base + '/api/applications', { headers: auth })).json()).applications.length, 0);
    control.exec('DROP TRIGGER reject_test');
    assert.equal((await post(base, valid)).status, 201);
  } finally { control.close(); await stop(app); rmSync(dir, { recursive: true, force: true }); }
});

test('5回連続失敗で両管理者ルートを15分制限し、再起動後も保持・期限後に解除', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'money-login-lock-'));
  let time = 1000000;
  const options = { dbPath: path.join(dir, 'app.sqlite'), adminPassword: 'test-password', now: () => time };
  const wrong = { Authorization: 'Basic ' + Buffer.from('admin:wrong').toString('base64') };
  let running = await start(options);
  try {
    // An initial browser challenge must not count as a password failure.
    for (let i = 0; i < 6; i++) assert.equal((await fetch(running.base + '/admin')).status, 401);
    for (let i = 0; i < 4; i++) assert.equal((await fetch(running.base + (i % 2 ? '/admin' : '/api/applications'), { headers: wrong })).status, 401);
    let response = await fetch(running.base + '/admin', { headers: wrong });
    assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '900');
    assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('cache-control'), 'no-store');
    await stop(running.app); running = await start(options);
    for (const route of ['/admin', '/api/applications']) {
      response = await fetch(running.base + route, { headers: { ...auth, 'X-Forwarded-For': '198.51.100.42' } });
      assert.equal(response.status, 429);
      assert.doesNotMatch(await response.text(), /test-password|wrong|applications":/);
    }
    // Requests made while locked do not extend the lock.
    time += 899000;
    response = await fetch(running.base + '/api/applications', { headers: auth });
    assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '1');
    time += 1000;
    response = await fetch(running.base + '/api/applications', { headers: auth });
    assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
    assert.equal((await fetch(running.base + '/admin', { headers: wrong })).status, 401);
    // Public LP and form are unaffected by a login lock.
    for (let i = 0; i < 4; i++) await fetch(running.base + '/admin', { headers: wrong });
    assert.equal((await fetch(running.base)).status, 200);
    assert.equal((await post(running.base, valid)).status, 201);
  } finally { await stop(running.app); rmSync(dir, { recursive: true, force: true }); }
});

test('認証成功で連続失敗数をリセットし、15分間操作なしでも失敗履歴を期限切れにする', async () => {
  let time = 1000000;
  const { app, base } = await start({ dbPath: ':memory:', adminPassword: 'test-password', now: () => time });
  const wrong = { Authorization: 'Basic ' + Buffer.from('admin:wrong').toString('base64') };
  try {
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 4; i++) assert.equal((await fetch(base + '/admin', { headers: wrong })).status, 401);
      assert.equal((await fetch(base + '/api/applications', { headers: auth })).status, 200);
    }
    for (let i = 0; i < 4; i++) await fetch(base + '/admin', { headers: wrong });
    time += 900000;
    assert.equal((await fetch(base + '/admin', { headers: wrong })).status, 401);
    assert.equal((await fetch(base + '/admin', { headers: auth })).status, 200);
  } finally { await stop(app); }
});

test('環境変数のパスワードを使い、HTTP応答にもログにも認証情報を出さずCookieを発行しない', async () => {
  const { randomBytes } = await import('node:crypto');
  const original = process.env.ADMIN_PASSWORD;
  const secret = randomBytes(24).toString('hex');
  process.env.ADMIN_PASSWORD = secret;
  let running;
  const logs = []; const originalLog = console.log; const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' ')); console.error = (...args) => logs.push(args.join(' '));
  try {
    running = await start({ dbPath: ':memory:', secureCookie: true });
    const authorization = 'Basic ' + Buffer.from('admin:' + secret).toString('base64');
    for (const route of ['/admin', '/api/applications']) {
      const response = await fetch(running.base + route, { headers: { Authorization: authorization } });
      assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
      assert(!JSON.stringify([...response.headers]).includes(secret)); assert(!(await response.text()).includes(secret));
    }
    for (let i = 0; i < 5; i++) {
      const response = await fetch(running.base + '/admin', { headers: { Authorization: 'Basic ' + Buffer.from('admin:invalid-' + secret).toString('base64') } });
      assert(!(await response.text()).includes(secret));
    }
    assert(!logs.join('\n').includes(secret)); assert(!logs.join('\n').includes(authorization));
  } finally {
    console.log = originalLog; console.error = originalError;
    if (running) await stop(running.app);
    if (original === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = original;
  }
});
