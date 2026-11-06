import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setDefaultResultOrder } from 'node:dns';
import { createPostgresStore, postgresConfig } from '../storage/postgres.js';
import { createApp } from '../server.js';
import pg from 'pg';
setDefaultResultOrder('ipv4first');
// Inputs are set only by the isolated local runner. Do not use a production URL.
const port = Number(process.env.PG_LOCAL_TEST_PORT);
if (!Number.isInteger(port) || port < 1 || !process.env.PG_LOCAL_TEST_CA) throw new Error('ローカルテスト専用ランナーを使用してください。');
const env = { DATABASE_URL: `postgresql://money_app:local-test-only@127.0.0.1:${port}/postgres`, DATABASE_CA_CERT_PATH: process.env.PG_LOCAL_TEST_CA };
const auth = { Authorization: 'Basic ' + Buffer.from('admin:local-admin-test').toString('base64') };
const wrong = { Authorization: 'Basic ' + Buffer.from('admin:wrong-test').toString('base64') };
async function serve(storage, clock = Date.now) { const app = createApp({ storage, adminPassword: 'local-admin-test', now: clock }); await app.ready(); app.listen(0, '127.0.0.1'); await once(app, 'listening'); return { app, base: `http://127.0.0.1:${app.address().port}` }; }
async function stop(app) { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); await app.storageClosed; }

test('実PostgreSQL: TLSで申込保存・管理者一覧・同じDBへの再接続後の保持', async () => {
  let running = await serve(createPostgresStore({ env }));
  try {
    const health = await fetch(running.base + '/healthz');
    assert.equal(health.status, 200); assert.deepEqual(await health.json(), { status: 'ok' });
    assert.equal((await fetch(running.base + '/api/applications')).status, 401);
    assert.equal((await fetch(running.base + '/api/consultations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ローカル検証専用', email: 'local-test@example.com', preference: '土日祝', message: '<script>test</script>', consent: true }) })).status, 201);
    let response = await fetch(running.base + '/api/applications', { headers: auth });
    let data = await response.json(); assert.equal(data.applications.length, 1); assert.equal(data.applications[0].email, 'local-test@example.com');
    assert.equal(typeof data.applications[0].id, 'number'); assert.match(data.applications[0].created_at, /Z$/);
    assert.equal(data.applications[0].message, '<script>test</script>');
    await stop(running.app); running = await serve(createPostgresStore({ env }));
    data = await (await fetch(running.base + '/api/applications', { headers: auth })).json(); assert.equal(data.applications.length, 1);
  } finally { await stop(running.app); }
});

test('実PostgreSQL: 同時10回の失敗を直列化し、2プール・再接続後もロックを共有', async () => {
  let time = 2000000;
  let a = await serve(createPostgresStore({ env }), () => time);
  const b = await serve(createPostgresStore({ env }), () => time);
  try {
    const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => fetch((i % 2 ? a : b).base + '/admin', { headers: wrong })));
    assert.equal(responses.filter(r => r.status === 401).length, 4); assert.equal(responses.filter(r => r.status === 429).length, 6);
    assert.equal((await fetch(b.base + '/api/applications', { headers: auth })).status, 429);
    await stop(a.app); a = await serve(createPostgresStore({ env }), () => time);
    assert.equal((await fetch(a.base + '/admin', { headers: auth })).status, 429);
    time += 900000;
    assert.equal((await fetch(a.base + '/admin', { headers: auth })).status, 200);
    for (let i = 0; i < 4; i++) assert.equal((await fetch(b.base + '/admin', { headers: wrong })).status, 401);
    assert.equal((await fetch(a.base + '/admin', { headers: auth })).status, 200);
    assert.equal((await fetch(b.base + '/admin', { headers: wrong })).status, 401);
  } finally { await stop(a.app); await stop(b.app); }
});

test('実PostgreSQL: 信頼していない証明書・ホスト名不一致は拒否、最小権限ではDDL不可', async () => {
  for (const badEnv of [{ DATABASE_URL: env.DATABASE_URL }, { ...env, DATABASE_URL: env.DATABASE_URL.replace('127.0.0.1', 'localhost') }]) {
    const store = createPostgresStore({ env: badEnv });
    try { await assert.rejects(store.ready(), /利用できません/); } finally { await store.close(); }
  }
  const client = new pg.Client(postgresConfig(env));
  try {
    await client.connect(); const tls = await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()'); assert.equal(tls.rows[0].ssl, true);
    await assert.rejects(client.query('CREATE TABLE money_private.forbidden(id integer)'), error => error.code === '42501');
  } finally { await client.end(); }
});


test('実PostgreSQL: 非同期INSERTが同時でも申込上限10件を超えない', async () => {
  const running = await serve(createPostgresStore({ env }));
  try {
    const responses = await Promise.all(Array.from({length: 15}, (_, i) => fetch(running.base + '/api/consultations', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ name: '並列送信検証', email: `parallel-${i}@example.com`, preference: '土日祝', consent: true })
    })));
    assert.equal(responses.filter(r => r.status === 201).length, 10);
    assert.equal(responses.filter(r => r.status === 429).length, 5);
  } finally { await stop(running.app); }
});
