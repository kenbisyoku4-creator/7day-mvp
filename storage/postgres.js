import pg from 'pg';
import { readFileSync } from 'node:fs';

const unavailable = () => new Error('データベースを利用できません。');
export function postgresConfig(env = process.env) {
  try {
    if (!env.DATABASE_URL?.trim()) throw unavailable();
    const url = new URL(env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || url.hash || !url.pathname.slice(1)) throw unavailable();
    // Never pass a connectionString to pg: its SSL parameters can replace ssl options.
    for (const [key, value] of url.searchParams) if (key !== 'sslmode' || value !== 'verify-full') throw unavailable();
    return {
      host: url.hostname, port: Number(url.port || 5432),
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
      ssl: { rejectUnauthorized: true, ...(env.DATABASE_CA_CERT_PATH ? { ca: readFileSync(env.DATABASE_CA_CERT_PATH, 'utf8') } : {}) },
      max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000,
      statement_timeout: 10000, query_timeout: 12000, lock_timeout: 5000,
      idle_in_transaction_session_timeout: 15000,
      application_name: 'money-mind-happy',
    };
  } catch { throw new Error('DATABASE_URLまたはTLS設定を確認してください。'); }
}

export function createPostgresStore({ env = process.env, Pool = pg.Pool } = {}) {
  const pool = new Pool(postgresConfig(env));
  // pg emits idle connection errors; never log raw errors containing connection details.
  pool.on('error', () => {});
  let closed;
  async function safe(operation) { try { return await operation(); } catch { throw unavailable(); } }
  return {
    health: () => safe(async () => {
      const { rows } = await pool.query({ text: 'SELECT 1 AS ok', query_timeout: 2000 });
      if (rows[0]?.ok !== 1) throw unavailable();
    }),
    ready: () => safe(async () => {
      await pool.query('SELECT id, name, email, preference, message, created_at FROM money_private.applications LIMIT 0');
      await pool.query('SELECT client, failures, locked_until, updated_at FROM money_private.admin_login_attempts LIMIT 0');
    }),
    insert: input => safe(() => pool.query('INSERT INTO money_private.applications(name,email,preference,message,created_at) VALUES($1,$2,$3,$4,$5)', [input.name, input.email, input.preference, input.message, input.created_at])),
    list: () => safe(async () => {
      const { rows } = await pool.query('SELECT id,name,email,preference,message,created_at FROM money_private.applications ORDER BY id DESC LIMIT 500');
      return rows.map(row => ({ ...row, created_at: new Date(row.created_at).toISOString() }));
    }),
    login: ({ client, time, valid, hasCredentials }) => safe(async () => {
      const connection = await pool.connect();
      let discard = false;
      try {
        await connection.query('BEGIN');
        // Serialize all decisions for an IP across processes, even before its row exists.
        await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [client]);
        await connection.query('DELETE FROM money_private.admin_login_attempts WHERE client=$1 AND updated_at <= $2', [client, time - 900000]);
        const { rows } = await connection.query('SELECT failures,locked_until FROM money_private.admin_login_attempts WHERE client=$1 FOR UPDATE', [client]);
        const lockedUntil = Number(rows[0]?.locked_until || 0);
        if (!Number.isSafeInteger(lockedUntil)) throw unavailable();
        let result;
        if (lockedUntil > time) result = { authorized: false, lockedUntil };
        else if (valid) {
          await connection.query('DELETE FROM money_private.admin_login_attempts WHERE client=$1', [client]);
          result = { authorized: true, lockedUntil: 0 };
        } else if (hasCredentials) {
          const failures = (rows[0]?.failures || 0) + 1;
          const until = failures >= 5 ? time + 900000 : 0;
          await connection.query(`INSERT INTO money_private.admin_login_attempts(client,failures,locked_until,updated_at) VALUES($1,$2,$3,$4)
            ON CONFLICT(client) DO UPDATE SET failures=excluded.failures,locked_until=excluded.locked_until,updated_at=excluded.updated_at`, [client, failures, until, time]);
          result = { authorized: false, lockedUntil: until };
        } else result = { authorized: false, lockedUntil: 0 };
        await connection.query('COMMIT');
        return result;
      } catch {
        try { await connection.query('ROLLBACK'); } catch { discard = true; }
        throw unavailable();
      } finally { connection.release(discard); }
    }),
    close: () => closed ||= pool.end(),
  };
}
