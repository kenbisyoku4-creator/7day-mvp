import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createPostgresStore } from './storage/postgres.js';
import { createSqliteStore } from './storage/sqlite.js';
import { timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
export function createApp(options = {}) {
  const { adminPassword = process.env.ADMIN_PASSWORD, secureCookie = process.env.NODE_ENV === 'production', now = Date.now, privateSite = process.env.SITE_ACCESS === 'private' || (process.env.NODE_ENV === 'production' && process.env.SITE_ACCESS !== 'public') } = options;
  const backend = process.env.STORAGE_BACKEND || 'postgres';
  if (!options.storage && !Object.hasOwn(options, 'dbPath') && !['sqlite', 'postgres'].includes(backend)) throw new Error('保存方式の設定を確認してください。');
  const storage = options.storage || (Object.hasOwn(options, 'dbPath') || backend === 'sqlite'
    ? createSqliteStore(options.dbPath || path.join(root, 'data/app.sqlite'))
    : createPostgresStore());
  const limits = new Map();
  // Share slow probes so repeated health checks cannot fill the DB connection pool.
  let healthInFlight;
  function databaseHealth() {
    if (!healthInFlight) {
      healthInFlight = Promise.resolve().then(() => storage.health()).finally(() => { healthInFlight = undefined; });
    }
    return healthInFlight;
  }
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
    if (privateSite) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      res.setHeader('Cache-Control', 'no-store');
    }
    if (url.pathname === '/healthz') {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD');
        return send(405, { status: 'method_not_allowed' });
      }
      let timer;
      try {
        await Promise.race([
          databaseHealth(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('health timeout')), 3000); }),
        ]);
        return send(200, { status: 'ok' });
      } catch { return send(503, { status: 'unavailable' }); }
      finally { clearTimeout(timer); }
    }
    const adminRoute = url.pathname === '/admin' || url.pathname === '/api/applications';
    if (privateSite || adminRoute) {
      res.setHeader('Cache-Control', 'no-store');
      if (!adminPassword) return send(503, { error: '管理者パスワードが設定されていません。' });
      // Use the socket peer only: untrusted forwarding headers must not bypass limits.
      const client = req.socket.remoteAddress || 'unknown';
      const time = now();
      let result;
      try { result = await storage.login({ client, time, valid: authorized(req), hasCredentials: req.headers.authorization !== undefined }); }
      catch { return send(503, { error: '管理者認証を確認できません。時間をおいて再度お試しください。' }); }
      if (result.lockedUntil > time) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((result.lockedUntil - time) / 1000))));
        return send(429, { error: 'ログインの失敗が続いたため、一時的に制限しています。15分後に再度お試しください。' });
      }
      if (!result.authorized) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Applications", charset="UTF-8"');
        return send(401, { error: '管理者認証が必要です。' });
      }
      if (adminRoute && req.method !== 'GET') return send(405, { error: '許可されていない操作です。' });
      if (url.pathname === '/api/applications') {
        try { return send(200, { applications: await storage.list() }); }
        catch { return send(503, { error: '申込情報を取得できません。時間をおいて再度お試しください。' }); }
      }
    }
    if (url.pathname === '/api/consultations' && req.method === 'POST') {
      if (req.headers.origin && req.headers.origin !== `${secureCookie ? 'https' : 'http'}://${req.headers.host}`) return send(403, { error: '送信元を確認できません。' });
      if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'JSONで送信してください。' });
      const key = req.socket.remoteAddress;
      const now = Date.now();
      for (const [ip, entry] of limits) if (now - entry.time > 3600000) limits.delete(ip);
      const record = limits.get(key) || { time: now, count: 0 };
      limits.set(key, record);
      if (record.count >= 10) return send(429, { error: 'お申込みが集中しています。時間をおいてお試しください。' });
      let body = '';
      let reserved = false;
      try {
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) return send(413, { error: '入力内容が長すぎます。' }); }
        const input = JSON.parse(body);
        if (!input || typeof input !== 'object' || Array.isArray(input)) return send(400, { error: '入力形式をご確認ください。' });
        const { name, email, preference, message = '', consent } = input;
        if (typeof name !== 'string' || !name.trim() || name.length > 80 || typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !['平日の日中', '平日の夕方以降', '土日祝', '相談して決めたい'].includes(preference) || typeof message !== 'string' || message.length > 1000 || consent !== true) return send(400, { error: 'お名前、メールアドレス、ご希望の時間帯、同意内容をご確認ください。' });
        // Reserve before async INSERT so simultaneous submissions share the limit.
        if (record.count >= 10) return send(429, { error: 'お申込みが集中しています。時間をおいてお試しください。' });
        record.count++; reserved = true;
        await storage.insert({ name: name.trim(), email: email.trim().toLowerCase(), preference, message: message.trim(), created_at: new Date().toISOString() });
        reserved = false;
        return send(201, { message: '無料相談のお申込みを受け付けました。' });
      } catch (error) { if (reserved) record.count--; return send(error instanceof SyntaxError ? 400 : 500, { error: error instanceof SyntaxError ? '入力形式をご確認ください。' : '保存できませんでした。時間をおいて再度お試しください。' }); }
    }
    const files = { '/': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/admin': ['admin.html', 'text/html'], '/admin.js': ['admin.js', 'text/javascript'] };
    if (req.method !== 'GET' || !files[url.pathname]) return send(404, { error: 'ページが見つかりません。' });
    const [file, type] = files[url.pathname];
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(readFileSync(path.join(root, 'public', file)));
  });
  server.ready = () => storage.ready();
  server.storageClosed = Promise.resolve();
  server.on('close', () => { server.storageClosed = Promise.resolve(storage.close()).catch(() => {}); });
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let server;
  try {
    server = createApp();
    await server.ready();
    const port = Number(process.env.PORT || 3000);
    server.on('error', () => { console.error('アプリを起動できません。設定を確認してください。'); process.exitCode = 1; server.close(); });
    server.listen(port, '0.0.0.0', () => console.log(`Server listening on port ${port}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeIdleConnections(); });
  } catch (error) {
    // Print only an allowlisted diagnostic code; never print raw driver errors.
    const codes = new Set(['DB_CONFIG_INVALID', 'DB_UNAVAILABLE', '28P01', '28000', '3D000', '3F000', '42P01', '42703', '42501', '53300', '57P03', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']);
    const code = codes.has(error?.code) ? error.code : 'STARTUP_FAILED';
    console.error('起動診断コード: ' + code);
    console.error('アプリを起動できません。データベースとTLSの設定を確認してください。');
    if (server) { server.close(); await server.storageClosed; }
    process.exitCode = 1;
  }
}
