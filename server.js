import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, openSync, closeSync, chmodSync } from 'node:fs';
import { timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
export function createApp({ dbPath = path.join(root, 'data/app.sqlite'), adminPassword = process.env.ADMIN_PASSWORD, secureCookie = process.env.NODE_ENV === 'production' } = {}) {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    closeSync(openSync(dbPath, 'a', 0o600));
    chmodSync(dbPath, 0o600);
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS applications (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, preference TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);`);
  const limits = new Map();
  function authorized(req) {
    if (!adminPassword) return false;
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(req.headers.authorization || '');
    if (!match) return false;
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0 || decoded.slice(0, separator) !== 'admin') return false;
    const password = decoded.slice(separator + 1);
    return timingSafeEqual(createHash('sha256').update(password).digest(), createHash('sha256').update(adminPassword).digest());
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/admin' || url.pathname === '/api/applications') {
      res.setHeader('Cache-Control', 'no-store');
      if (!adminPassword) return send(503, { error: '管理者パスワードが設定されていません。' });
      if (!authorized(req)) { res.setHeader('WWW-Authenticate', 'Basic realm="Applications", charset="UTF-8"'); return send(401, { error: '管理者認証が必要です。' }); }
      if (req.method !== 'GET') return send(405, { error: '許可されていない操作です。' });
      if (url.pathname === '/api/applications') return send(200, { applications: db.prepare('SELECT * FROM applications ORDER BY id DESC LIMIT 500').all() });
    }
    if (url.pathname === '/api/consultations' && req.method === 'POST') {
      if (req.headers.origin && req.headers.origin !== `${secureCookie ? 'https' : 'http'}://${req.headers.host}`) return send(403, { error: '送信元を確認できません。' });
      if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'JSONで送信してください。' });
      const key = req.socket.remoteAddress;
      const now = Date.now();
      for (const [ip, entry] of limits) if (now - entry.time > 3600000) limits.delete(ip);
      const record = limits.get(key) || { time: now, count: 0 };
      if (record.count >= 10) return send(429, { error: 'お申込みが集中しています。時間をおいてお試しください。' });
      let body = '';
      try {
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) return send(413, { error: '入力内容が長すぎます。' }); }
        const input = JSON.parse(body);
        if (!input || typeof input !== 'object' || Array.isArray(input)) return send(400, { error: '入力形式をご確認ください。' });
        const { name, email, preference, message = '', consent } = input;
        if (typeof name !== 'string' || !name.trim() || name.length > 80 || typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !['平日の日中', '平日の夕方以降', '土日祝', '相談して決めたい'].includes(preference) || typeof message !== 'string' || message.length > 1000 || consent !== true) return send(400, { error: 'お名前、メールアドレス、ご希望の時間帯、同意内容をご確認ください。' });
        db.prepare('INSERT INTO applications(name,email,preference,message,created_at) VALUES(?,?,?,?,?)').run(name.trim(), email.trim().toLowerCase(), preference, message.trim(), new Date().toISOString());
        record.count++; limits.set(key, record);
        return send(201, { message: '無料相談のお申込みを受け付けました。' });
      } catch (error) { return send(error instanceof SyntaxError ? 400 : 500, { error: error instanceof SyntaxError ? '入力形式をご確認ください。' : '保存できませんでした。時間をおいて再度お試しください。' }); }
    }
    const files = { '/': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/admin': ['admin.html', 'text/html'], '/admin.js': ['admin.js', 'text/javascript'] };
    if (req.method !== 'GET' || !files[url.pathname]) return send(404, { error: 'ページが見つかりません。' });
    const [file, type] = files[url.pathname];
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(readFileSync(path.join(root, 'public', file)));
  });
  server.on('close', () => db.close());
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, '0.0.0.0', () => console.log(`Server listening on port ${port}`));
}
