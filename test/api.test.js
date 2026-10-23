const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.NODE_ENV = 'test';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'test-password-strong';
process.env.JWT_SECRET = 'test-secret-please-change-1234567890123456';
process.env.SQLITE_PATH = ':memory:';
const request = require('supertest');
const { app, db } = require('../src/app');
const { openDatabase } = require('../src/db');

let token, keysViewToken, key, id;
const auth = () => ({ Authorization: `Bearer ${token}`, ...(keysViewToken ? { 'X-Keys-View-Token': keysViewToken } : {}) });
const login = () => request(app).post('/admin/auth/login').send({ username: 'admin', password: 'test-password-strong' });

test('health e autenticação', async () => {
  assert.equal((await request(app).get('/health')).status, 200);
  assert.equal((await login()).status, 200);
  token = (await login()).body.token;
  const wrong = await request(app).post('/admin/keys/unlock').set(auth()).send({ code: '00000' });
  assert.equal(wrong.status, 403);
  const unlocked = await request(app).post('/admin/keys/unlock').set(auth()).send({ code: '20009' });
  assert.equal(unlocked.status, 200); keysViewToken = unlocked.body.token;
});

test('cria key e lista', async () => {
  const r = await request(app).post('/admin/keys').set(auth()).send({ type: 'daily', duration: 2, username: 'Ana' });
  assert.equal(r.status, 201); key = r.body.license.key; id = r.body.license.id;
  assert.match(key, /^IOSPRIVATE-DAILY-/);
  const l = await request(app).get('/admin/keys').set(auth());
  assert.equal(l.body.total, 1);
});

test('bind concorrente permite somente um dispositivo', async () => {
  const results = await Promise.all([
    request(app).post('/v1/bind').send({ key, device: 'device-a' }),
    request(app).post('/v1/bind').send({ key, device: 'device-b' })
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const winner = results.find(r => r.status === 200).body.license.device;
  assert.ok(['device-a', 'device-b'].includes(winner));
});

test('sessão automática exige HWID vinculado e retorna token de cliente', async () => {
  const device = db.prepare('SELECT device FROM licenses WHERE id=?').get(id).device;
  const success = await request(app).post('/v1/session').send({ device });
  assert.equal(success.status, 200);
  assert.equal(success.body.authenticated, true);
  assert.ok(success.body.access_token);
  assert.equal((await request(app).post('/v1/session').send({ device: 'unknown-device' })).status, 401);
  assert.equal((await request(app).post('/v1/session').send({ device: '' })).status, 400);
});

test('valida, desvincula, bloqueia e reativa', async () => {
  const device = db.prepare('SELECT device FROM licenses WHERE id=?').get(id).device;
  assert.equal((await request(app).post('/v1/validate').send({ key, device })).body.valid, true);
  assert.equal((await request(app).post('/v1/unbind').send({ key, device })).status, 200);
  assert.equal((await request(app).patch(`/admin/keys/${id}/status`).set(auth()).send({ status: 'blocked' })).status, 200);
  assert.equal((await request(app).post('/v1/validate').send({ key, device })).status, 403);
  assert.equal((await request(app).patch(`/admin/keys/${id}/status`).set(auth()).send({ status: 'active' })).status, 200);
});

test('expiração é calculada pelo servidor', async () => {
  const created = await request(app).post('/admin/keys').set(auth()).send({ type: 'hourly', duration: 1, username: 'Expira' });
  const expiredId = created.body.license.id;
  db.prepare("UPDATE licenses SET expires_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), expiredId);
  const result = await request(app).post('/v1/validate').send({ key: created.body.license.key, device: 'any-device' });
  assert.equal(result.status, 403); assert.equal(result.body.reason, 'expired');
  assert.equal((await request(app).get('/admin/stats').set(auth())).body.expired, 1);
});

test('protege admin e valida entradas', async () => {
  assert.equal((await request(app).get('/admin/stats')).status, 401);
  assert.equal((await request(app).post('/v1/bind').send({ key: 'x' })).status, 400);
});

test('migração idempotente e persistência em arquivo', () => {
  const filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iosprivate-')), 'data.sqlite');
  const first = openDatabase(filename);
  first.prepare("INSERT INTO licenses (key,username,type,status,created_at,updated_at) VALUES (?,?,?,?,?,?)").run('IOSPRIVATE-PERM-PERSIST', 'Persist', 'perm', 'active', new Date().toISOString(), new Date().toISOString());
  first.close();
  const second = openDatabase(filename);
  assert.equal(second.prepare('SELECT COUNT(*) count FROM licenses').get().count, 1);
  assert.equal(second.prepare('SELECT COUNT(*) count FROM schema_migrations').get().count, 1);
  second.close(); fs.rmSync(path.dirname(filename), { recursive: true, force: true });
});
