// Isolated local-only PostgreSQL integration runner. Never uses DATABASE_URL from the environment.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import pg from 'pg';
const bin = process.env.PG_TEST_BIN || '/usr/lib/postgresql/17/bin';
const root = path.resolve(import.meta.dirname, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'money-postgres-'));
let running = false;
function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 60000, ...options });
  if (result.status !== 0) throw new Error('ローカルPostgreSQLテストの準備に失敗しました。');
}
try {
  if (!existsSync(path.join(bin, 'initdb'))) throw new Error('PG_TEST_BINにローカルPostgreSQLのbinディレクトリを指定してください。');
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  run(path.join(bin, 'initdb'), ['-D', path.join(dir, 'data'), '-U', 'test_owner', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'server.key'), '-out', path.join(dir, 'server.crt'), '-days', '1', '-subj', '/CN=local-postgres-test', '-addext', 'subjectAltName=IP:127.0.0.1']);
  // OpenSSL creates the private key with restricted permissions. All files are inside a 0700 temp directory.
  writeFileSync(path.join(dir, 'data', 'pg_hba.conf'), 'local all all trust\nhostssl all all 127.0.0.1/32 trust\n');
  writeFileSync(path.join(dir, 'data', 'postgresql.conf'), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories='${dir}'\nssl=on\nssl_cert_file='${dir}/server.crt'\nssl_key_file='${dir}/server.key'\nlog_statement='none'\nlog_min_error_statement=panic\n`);
  run(path.join(bin, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-l', path.join(dir, 'postgres.log'), '-w', 'start']); running = true;
  const owner = new pg.Client({ host: '127.0.0.1', port, user: 'test_owner', database: 'postgres', ssl: { ca: readFileSync(path.join(dir, 'server.crt'), 'utf8'), rejectUnauthorized: true } });
  try {
    await owner.connect();
    await owner.query(readFileSync(path.join(root, 'migrations/001-postgres.sql'), 'utf8'));
    await owner.query(`CREATE ROLE money_app LOGIN;
      GRANT USAGE ON SCHEMA money_private TO money_app;
      GRANT SELECT, INSERT ON money_private.applications TO money_app;
      GRANT USAGE ON SEQUENCE money_private.applications_id_seq TO money_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON money_private.admin_login_attempts TO money_app;`);
  } finally { await owner.end(); }
  const result = spawnSync(process.execPath, ['--test', 'scripts/postgres-cases.js'], { cwd: root, stdio: 'inherit', timeout: 90000,
    env: { PATH: process.env.PATH, PG_LOCAL_TEST_PORT: String(port), PG_LOCAL_TEST_CA: path.join(dir, 'server.crt') } });
  if (result.status !== 0) process.exitCode = 1;
} catch (error) {
  console.error(error.message === 'PG_TEST_BINにローカルPostgreSQLのbinディレクトリを指定してください。' ? error.message : 'ローカルDB検証に失敗しました。秘密値を保護するため詳細例外は表示しません。');
  process.exitCode = 1;
} finally {
  if (running) { try { run(path.join(bin, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-m', 'immediate', '-w', 'stop']); } catch { process.exitCode = 1; } }
  rmSync(dir, { recursive: true, force: true });
}
