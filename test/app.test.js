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
