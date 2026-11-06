import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { createPostgresStore, postgresConfig } from '../storage/postgres.js';
import { createApp } from '../server.js';

// Reserved loopback only. Never read production DATABASE_URL in tests.
const env = { DATABASE_URL: 'postgresql://test:synthetic-password@127.0.0.1:5432/test_db' };
test('PostgreSQL設定はTLS検証・接続数とタイムアウトを固定し、危険なSSL上書きを拒否', () => {
  const config = postgresConfig(env);
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.max, 3); assert.equal(config.connectionTimeoutMillis, 10000);
  assert.equal(config.idleTimeoutMillis, 30000); assert.equal(config.statement_timeout, 10000);
  assert.equal(config.query_timeout, 12000); assert.equal(config.lock_timeout, 5000);
  assert.equal(config.idle_in_transaction_session_timeout, 15000);
  assert.equal(config.connectionString, undefined);
  assert.equal(postgresConfig({ DATABASE_URL: env.DATABASE_URL + '?sslmode=verify-full' }).ssl.rejectUnauthorized, true);
  for (const suffix of ['?sslmode=disable', '?sslmode=require', '?sslmode=no-verify', '?sslcert=secret', '?host=remote.invalid']) {
    assert.throws(() => postgresConfig({ DATABASE_URL: env.DATABASE_URL + suffix }), error => !error.message.includes('synthetic-password') && !error.message.includes('postgresql://'));
  }
  for (const value of [undefined, '', 'not-a-url', 'https://invalid.example', 'postgresql://test@127.0.0.1/db']) assert.throws(() => postgresConfig({ DATABASE_URL: value }));
  assert.throws(() => postgresConfig({ ...env, DATABASE_CA_CERT_PATH: '/nonexistent-ca-file' }), /TLS設定/);
});

test('設定未登録の通常起動は秘密値を出さず失敗し、SQLiteへ切り替えない', () => {
  const result = spawnSync(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH, STORAGE_BACKEND: 'postgres' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /起動できません/);
  assert.doesNotMatch(result.stderr, /postgresql:\/\/|password=/i); assert.doesNotMatch(result.stdout, /listening/);
});

test('接続失敗は無害化され、閉じたローカルポートでもSQLiteへ切り替えない', async () => {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const store = createPostgresStore({ env: { DATABASE_URL: `postgresql://test:synthetic-password@127.0.0.1:${port}/test_db` } });
  try { await assert.rejects(store.ready(), error => error.message === 'データベースを利用できません。'); }
  finally { await store.close(); }
});

test('トランザクション失敗時はROLLBACK・接続返却を行い、例外に秘密値を出さない', async () => {
  const commands = []; let released;
  class BrokenPool extends EventEmitter {
    async connect() { return { query: async sql => { commands.push(sql); if (sql.startsWith('SELECT pg_advisory')) throw new Error(env.DATABASE_URL); return { rows: [] }; }, release: bad => { released = bad; } }; }
    async end() {}
  }
  const store = createPostgresStore({ env, Pool: BrokenPool });
  await assert.rejects(store.login({ client: '127.0.0.1', time: 1000, valid: true, hasCredentials: true }), /利用できません/);
  assert.equal(commands.at(-1), 'ROLLBACK'); assert.equal(released, false); await store.close();
});

test('DB障害時は管理者認証・一覧を閉じ、フォーム保存も失敗として返す', async () => {
  const storage = { ready: async () => {}, close: async () => {}, login: async () => { throw new Error(env.DATABASE_URL); }, insert: async () => { throw new Error(env.DATABASE_URL); } };
  const app = createApp({ storage, adminPassword: 'test-only' }); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    for (const route of ['/admin', '/api/applications']) {
      const response = await fetch(base + route, { headers: { Authorization: 'Basic ' + Buffer.from('admin:test-only').toString('base64') } });
      assert.equal(response.status, 503); assert(!(await response.text()).includes('synthetic-password'));
    }
    const response = await fetch(base + '/api/consultations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '検証用', email: 'test@example.com', preference: '土日祝', consent: true }) });
    assert.equal(response.status, 500); assert.match(await response.text(), /保存できません/);
  } finally { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); await app.storageClosed; }
});
