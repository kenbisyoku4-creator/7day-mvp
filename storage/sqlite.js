import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync, chmodSync } from 'node:fs';
import path from 'node:path';

// Explicit local development/test adapter; never used as an error fallback.
export function createSqliteStore(dbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    closeSync(openSync(dbPath, 'a', 0o600));
    chmodSync(dbPath, 0o600);
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS applications (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, preference TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);`);
  // Persist only failure counts/times, never passwords or Authorization headers.
  db.exec(`CREATE TABLE IF NOT EXISTS admin_login_attempts (
    client TEXT PRIMARY KEY, failures INTEGER NOT NULL,
    locked_until INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );`);
  const loginLockMs = 15 * 60 * 1000;
  const loginAttempt = db.prepare('SELECT locked_until FROM admin_login_attempts WHERE client = ?');
  const clearLogin = db.prepare('DELETE FROM admin_login_attempts WHERE client = ?');
  const expireLogins = db.prepare('DELETE FROM admin_login_attempts WHERE updated_at <= ?');
  const failLogin = db.prepare(`INSERT INTO admin_login_attempts(client, failures, locked_until, updated_at)
    VALUES (?, 1, 0, ?)
    ON CONFLICT(client) DO UPDATE SET
      failures = failures + 1,
      locked_until = CASE WHEN failures + 1 >= 5 THEN excluded.updated_at + ? ELSE 0 END,
      updated_at = excluded.updated_at
    RETURNING locked_until`);

  return {
    health: () => { if (db.prepare('SELECT 1 AS ok').get().ok !== 1) throw new Error('データベースを利用できません。'); },
    ready: async () => {},
    insert: input => db.prepare('INSERT INTO applications(name,email,preference,message,created_at) VALUES(?,?,?,?,?)').run(input.name,input.email,input.preference,input.message,input.created_at),
    list: () => db.prepare('SELECT id,name,email,preference,message,created_at FROM applications ORDER BY id DESC LIMIT 500').all(),
    login: ({ client, time, valid, hasCredentials }) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        expireLogins.run(time - loginLockMs);
        const locked = loginAttempt.get(client);
        let result;
        if (locked?.locked_until > time) result = { authorized: false, lockedUntil: locked.locked_until };
        else if (valid) { clearLogin.run(client); result = { authorized: true, lockedUntil: 0 }; }
        else if (hasCredentials) result = { authorized: false, lockedUntil: failLogin.get(client, time, loginLockMs).locked_until };
        else result = { authorized: false, lockedUntil: 0 };
        db.exec('COMMIT');
        return result;
      } catch { db.exec('ROLLBACK'); throw new Error('データベースを利用できません。'); }
    },
    close: () => db.close(),
  };
}
