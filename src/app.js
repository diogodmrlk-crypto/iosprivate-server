// Configuração embutida para deploy sem preenchimento manual no Render.
// Este repositório deve permanecer privado: não publique estes valores.
process.env.NODE_ENV ||= 'production';
process.env.SQLITE_PATH ||= '/var/data/iosprivate.sqlite';
process.env.REQUIRE_PERSISTENT_DISK ||= 'false';
process.env.ADMIN_USERNAME ||= 'admin';
process.env.ADMIN_PASSWORD ||= 'IRZVltWkFZ3gVDHoGfJVnvOz';
process.env.JWT_SECRET ||= 'IWayDoawcEXJdH6PAaJVLiCH+u2K6dxM3cQay6pNQBDqyDiGlJqNpAJ9WIscJYlH';
process.env.KEYS_VIEW_CODE ||= '20009';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { openDatabase } = require('./db');

const TYPES = ['hourly','daily','weekly','monthly','perm'];
const app = express();
const db = openDatabase();
const now = () => new Date().toISOString();
const json = (res, status, body) => res.status(status).json(body);
const jwtSecret = process.env.JWT_SECRET || (process.env.NODE_ENV === 'test' ? 'test-secret-please-change-1234567890123456' : '');
if (process.env.NODE_ENV !== 'test' && jwtSecret.length < 32) throw new Error('JWT_SECRET deve ter pelo menos 32 caracteres.');
const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || '';
const adminHash = adminPassword ? bcrypt.hashSync(adminPassword, 12) : '';
const keysViewCode = process.env.KEYS_VIEW_CODE || '20009';

app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', methods: ['GET','POST','PATCH','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '32kb' }));
app.use('/admin/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }));
app.use('/v1', rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));

function publicLicense(row) {
  if (!row) return null;
  return { ...row, used: Boolean(row.used) };
}
function keyFor(type) { return `IOSPRIVATE-${type.toUpperCase()}-${crypto.randomBytes(12).toString('hex').toUpperCase()}`; }
function expiryFor(type, duration) {
  if (type === 'perm') return null;
  const n = Number(duration);
  if (!Number.isInteger(n) || n < 1 || n > 8760) throw new Error('duration deve ser um inteiro entre 1 e 8760.');
  const ms = { hourly: 3600000, daily: 86400000, weekly: 604800000, monthly: 2592000000 }[type] * n;
  return new Date(Date.now() + ms).toISOString();
}
function isExpired(row) { return row.expires_at !== null && Date.parse(row.expires_at) <= Date.now(); }
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try { req.admin = jwt.verify(token, jwtSecret); next(); } catch { return json(res, 401, { error: 'Autenticação necessária.' }); }
}
function keysViewAuth(req, res, next) {
  const token = (req.headers['x-keys-view-token'] || '').trim();
  try {
    const payload = jwt.verify(token, jwtSecret);
    if (payload.scope !== 'keys:view') throw new Error('invalid scope');
    next();
  } catch { return json(res, 403, { error: 'Desbloqueie a visualização das keys primeiro.' }); }
}
const typeSchema = z.object({ type: z.enum(TYPES), duration: z.number().int().min(1).max(8760).optional(), username: z.string().trim().max(120).optional().default('') });
const deviceSchema = z.object({ key: z.string().trim().min(1).max(200), device: z.string().trim().min(1).max(255) });

app.get('/health', (req, res) => { try { db.prepare('SELECT 1').get(); return json(res, 200, { ok: true, database: 'connected', timestamp: now() }); } catch { return json(res, 503, { ok: false, database: 'unavailable' }); } });
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.post('/v1/validate', (req, res) => {
  const parsed = deviceSchema.safeParse(req.body); if (!parsed.success) return json(res, 400, { error: 'key e device são obrigatórios.' });
  const row = db.prepare('SELECT * FROM licenses WHERE key = ?').get(parsed.data.key);
  if (!row) return json(res, 404, { valid: false, reason: 'not_found' });
  if (row.status !== 'active') return json(res, 403, { valid: false, reason: row.status });
  if (isExpired(row)) { db.prepare("UPDATE licenses SET status='revoked', updated_at=? WHERE id=? AND status='active'").run(now(), row.id); return json(res, 403, { valid: false, reason: 'expired' }); }
  if (row.device && row.device !== parsed.data.device) return json(res, 409, { valid: false, reason: 'device_mismatch' });
  db.prepare('UPDATE licenses SET last_online_at=?, updated_at=? WHERE id=?').run(now(), now(), row.id);
  return json(res, 200, { valid: true, license: publicLicense({ ...row, last_online_at: now() }) });
});
function automaticSession(req, res) {
  const parsed = z.object({ device: z.string().trim().min(1).max(255) }).safeParse(req.body);
  if (!parsed.success) return json(res, 400, { authenticated: false, reason: 'device_required' });
  const rows = db.prepare("SELECT * FROM licenses WHERE device=? AND status='active' ORDER BY id DESC").all(parsed.data.device);
  const valid = rows.filter(row => !isExpired(row));
  if (!valid.length) return json(res, 401, { authenticated: false, reason: 'no_active_bound_license' });
  if (valid.length > 1) return json(res, 409, { authenticated: false, reason: 'multiple_bound_licenses' });
  const row = valid[0];
  const timestamp = now();
  db.prepare('UPDATE licenses SET last_online_at=?, updated_at=? WHERE id=?').run(timestamp, timestamp, row.id);
  const accessToken = jwt.sign({ sub: `license:${row.id}`, license_id: row.id, device: row.device, scope: 'client' }, jwtSecret, { expiresIn: '1h' });
  return json(res, 200, { authenticated: true, access_token: accessToken, expires_in: 3600, license: publicLicense({ ...row, last_online_at: timestamp }) });
}
app.post('/v1/session', automaticSession);
app.post('/v1/auto-login', automaticSession);
app.post('/v1/bind', (req, res) => {
  const parsed = deviceSchema.safeParse(req.body); if (!parsed.success) return json(res, 400, { error: 'key e device são obrigatórios.' });
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT * FROM licenses WHERE key=?').get(parsed.data.key);
    if (!row) return { status: 404, body: { valid: false, reason: 'not_found' } };
    if (row.status !== 'active') return { status: 403, body: { valid: false, reason: row.status } };
    if (isExpired(row)) { db.prepare("UPDATE licenses SET status='revoked', updated_at=? WHERE id=?").run(now(), row.id); return { status: 403, body: { valid: false, reason: 'expired' } }; }
    if (row.device && row.device !== parsed.data.device) return { status: 409, body: { valid: false, reason: 'already_bound' } };
    const timestamp = now();
    db.prepare('UPDATE licenses SET used=1, device=?, activated_at=COALESCE(activated_at, ?), last_online_at=?, updated_at=? WHERE id=?').run(parsed.data.device, timestamp, timestamp, timestamp, row.id);
    return { status: 200, body: { valid: true, license: publicLicense(db.prepare('SELECT * FROM licenses WHERE id=?').get(row.id)) } };
  });
  const result = tx(); return json(res, result.status, result.body);
});
app.post('/v1/unbind', (req, res) => {
  const parsed = deviceSchema.safeParse(req.body); if (!parsed.success) return json(res, 400, { error: 'key e device são obrigatórios.' });
  const result = db.prepare('UPDATE licenses SET used=0, device=NULL, updated_at=? WHERE key=? AND device=?').run(now(), parsed.data.key, parsed.data.device);
  if (!result.changes) return json(res, 404, { success: false, error: 'Licença não encontrada para este dispositivo.' });
  return json(res, 200, { success: true });
});

app.post('/admin/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!adminHash || username !== adminUsername || typeof password !== 'string' || !bcrypt.compareSync(password, adminHash)) return json(res, 401, { error: 'Credenciais inválidas.' });
  return json(res, 200, { token: jwt.sign({ sub: adminUsername, role: 'admin' }, jwtSecret, { expiresIn: '12h' }) });
});
app.post('/admin/keys/unlock', auth, (req, res) => {
  if (typeof req.body?.code !== 'string' || req.body.code !== keysViewCode) return json(res, 403, { unlocked: false, error: 'Código inválido.' });
  return json(res, 200, { unlocked: true, token: jwt.sign({ sub: req.admin.sub, scope: 'keys:view' }, jwtSecret, { expiresIn: '15m' }) });
});
app.get('/admin/keys', auth, keysViewAuth, (req, res) => {
  const { search = '', status = '', username = '', page = '1', limit = '50' } = req.query;
  const p = Math.max(1, Number(page) || 1), l = Math.min(100, Math.max(1, Number(limit) || 50)), params = [];
  const where = [];
  if (search) { where.push('(key LIKE ? OR username LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (status && ['active','blocked','revoked'].includes(status)) { where.push('status=?'); params.push(status); }
  if (username) { where.push('username LIKE ?'); params.push(`%${username}%`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) count FROM licenses ${clause}`).get(...params).count;
  const rows = db.prepare(`SELECT * FROM licenses ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, l, (p - 1) * l).map(publicLicense);
  return json(res, 200, { data: rows, page: p, limit: l, total });
});
app.post('/admin/keys', auth, (req, res) => {
  const parsed = typeSchema.safeParse(req.body); if (!parsed.success) return json(res, 400, { error: 'type, duration e username inválidos.' });
  try {
    const { type, duration, username } = parsed.data, timestamp = now(), key = keyFor(type), expires = expiryFor(type, duration);
    const result = db.prepare('INSERT INTO licenses (key, username, type, status, used, created_at, expires_at, updated_at) VALUES (?,?,?,\'active\',0,?,?,?)').run(key, username || '', type, timestamp, expires, timestamp);
    return json(res, 201, { license: publicLicense(db.prepare('SELECT * FROM licenses WHERE id=?').get(result.lastInsertRowid)) });
  } catch (e) { return json(res, 400, { error: e.message }); }
});
app.get('/admin/keys/:id', auth, keysViewAuth, (req, res) => { const row = db.prepare('SELECT * FROM licenses WHERE id=?').get(Number(req.params.id)); return row ? json(res, 200, { license: publicLicense(row) }) : json(res, 404, { error: 'Licença não encontrada.' }); });
app.patch('/admin/keys/:id/status', auth, (req, res) => { const status = z.enum(['active','blocked','revoked']).safeParse(req.body?.status); if (!status.success) return json(res, 400, { error: 'status inválido.' }); const r = db.prepare('UPDATE licenses SET status=?, updated_at=? WHERE id=?').run(status.data, now(), Number(req.params.id)); return r.changes ? json(res, 200, { license: publicLicense(db.prepare('SELECT * FROM licenses WHERE id=?').get(Number(req.params.id))) }) : json(res, 404, { error: 'Licença não encontrada.' }); });
app.post('/admin/keys/:id/unbind', auth, (req, res) => { const r = db.prepare('UPDATE licenses SET used=0, device=NULL, updated_at=? WHERE id=?').run(now(), Number(req.params.id)); return r.changes ? json(res, 200, { success: true }) : json(res, 404, { error: 'Licença não encontrada.' }); });
app.delete('/admin/keys/:id', auth, (req, res) => { const r = db.prepare('DELETE FROM licenses WHERE id=?').run(Number(req.params.id)); return r.changes ? json(res, 204, null) : json(res, 404, { error: 'Licença não encontrada.' }); });
app.get('/admin/stats', auth, (req, res) => { const total = db.prepare('SELECT COUNT(*) count FROM licenses').get().count; const active = db.prepare("SELECT COUNT(*) count FROM licenses WHERE status='active' AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))").get().count; const bound = db.prepare('SELECT COUNT(*) count FROM licenses WHERE used=1').get().count; const expired = db.prepare("SELECT COUNT(*) count FROM licenses WHERE expires_at IS NOT NULL AND julianday(expires_at) <= julianday('now')").get().count; return json(res, 200, { total, active, bound, expired }); });
app.use((err, req, res, next) => { console.error('request_error', err.message); return json(res, 500, { error: 'Erro interno.' }); });
module.exports = { app, db };
