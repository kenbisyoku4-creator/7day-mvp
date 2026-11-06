import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createApp } from '../server.js';
import { createPostgresStore } from '../storage/postgres.js';

async function start(options) { const app = createApp(options); app.listen(0, '127.0.0.1'); await once(app, 'listening'); return { app, base: `http://127.0.0.1:${app.address().port}` }; }
async function stop(app) { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); await app.storageClosed; }

test('/healthz: 未認証でもDBを確認し、固定JSON・no-storeを返す。申込情報は変えない', async () => {
  const { app, base } = await start({ dbPath: ':memory:', adminPassword: 'health-test-only' });
  try {
    const response = await fetch(base + '/healthz');
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'ok' });
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('www-authenticate'), null);
    const head = await fetch(base + '/healthz', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    const list = await fetch(base + '/api/applications', { headers: { Authorization: 'Basic ' + Buffer.from('admin:health-test-only').toString('base64') } });
    assert.deepEqual((await list.json()).applications, []);
    assert.equal((await fetch(base + '/admin')).status, 401);
  } finally { await stop(app); }
});

test('/healthz: DB障害時は503、秘密値・生の例外・接続先を応答にもログにも出さない', async () => {
  const marker = 'synthetic-private-error-marker';
  const logs = []; const original = console.error; console.error = (...args) => logs.push(args.join(' '));
  const { app, base } = await start({ storage: { health: async () => { throw new Error(marker); }, close: async () => {} } });
  try {
    const response = await fetch(base + '/healthz');
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: 'unavailable' });
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert(!logs.join('').includes(marker));
  } finally { console.error = original; await stop(app); }
});

test('/healthz: POSTはDBへ触れず405、並行したチェックはSQLを共有する', async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const { app, base } = await start({ storage: { health: async () => { calls++; await gate; }, close: async () => {} } });
  try {
    const rejected = await fetch(base + '/healthz', { method: 'POST' }); assert.equal(rejected.status, 405); assert.equal(calls, 0);
    assert.equal(rejected.headers.get('allow'), 'GET, HEAD');
    const responses = Array.from({ length: 4 }, () => fetch(base + '/healthz'));
    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(calls, 1);
    release(); for (const response of await Promise.all(responses)) assert.equal(response.status, 200);
    await fetch(base + '/healthz'); assert.equal(calls, 2);
  } finally { release(); await stop(app); }
});

test('/healthz: DBが応答しなくても3秒で503を返し、後からの回復を確認できる', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { app, base } = await start({ storage: { health: () => gate, close: async () => {} } });
  try {
    const response = await fetch(base + '/healthz'); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: 'unavailable' });
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await fetch(base + '/healthz')).status, 200);
  } finally { release(); await stop(app); }
});

test('PostgreSQLのヘルスチェックSQLは読取専用SELECT 1のみ、2秒のSQL待ち上限', async () => {
  const queries = [];
  class LocalFakePool extends EventEmitter { async query(config) { queries.push(config); return { rows: [{ ok: 1 }] }; } async end() {} }
  const store = createPostgresStore({ env: { DATABASE_URL: 'postgresql://test:fake-test-only@127.0.0.1/local_test' }, Pool: LocalFakePool });
  try {
    await store.health(); assert.deepEqual(queries, [{ text: 'SELECT 1 AS ok', query_timeout: 2000 }]);
  } finally { await store.close(); }
});
