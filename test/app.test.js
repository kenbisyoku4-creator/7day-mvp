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
