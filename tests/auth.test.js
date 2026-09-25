const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config/env');
const { AuthService } = require('../src/services/auth.service');
const { authenticate, authorize } = require('../src/middleware/auth.middleware');
const express = require('express');
const config = loadConfig({ JWT_ACCESS_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40), CORS_ORIGINS: 'http://localhost:5173' });
const password = 'Valid-password-123';
const passwordHash = bcrypt.hashSync(password, 4);
function fixture() {
  const user = { id: randomUUID(), first_name: 'Demo', last_name: 'User', email: 'demo@example.com', mobile: null, vendor_id: null, status: 'ACTIVE', roles: ['CUSTOMER'], password_hash: passwordHash };
  const sessions = new Map();
  const repo = {
    findUser: async (field, value) => user[field] === value ? user : undefined,
    createSession: async s => { sessions.set(s.id, s); },
    getSession: async id => sessions.get(id),
    rotate: async (id, oldHash, newHash) => {
      const s = sessions.get(id);
      if (!s || s.revoked_at || s.refresh_hash !== oldHash || s.expires_at <= new Date()) return false;
      s.refresh_hash = newHash;
      return true;
    },
    revoke: async id => { const s = sessions.get(id); if (s) s.revoked_at = new Date(); },
  };
  const service = new AuthService(repo, config);
  return { app: createApp({ service, config }), service, user, sessions };
}
const credentials = { email: 'demo@example.com', password, role: 'CUSTOMER' };
test('login returns safe profile, JWT pair and HttpOnly cookies; aliases work', async () => {
  const { app, sessions } = fixture();
  const res = await request(app).post('/api/v1/auth/login').send(credentials).expect(200);
  assert.equal(res.body.user.email, 'demo@example.com');
  assert.equal(res.body.user.password_hash, undefined);
  assert.equal(res.body.tokenType, 'Bearer');
  assert.equal(jwt.verify(res.body.accessToken, config.accessSecret).type, 'access');
  assert.ok(res.headers['set-cookie'].every(c => c.includes('HttpOnly') && c.includes('SameSite=Lax')));
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal([...sessions.values()][0].refresh_hash, createHash('sha256').update(res.body.refreshToken).digest('hex'));
  await request(app).get('/me').set('Authorization', 'Bearer ' + res.body.accessToken).expect(200);
});
test('invalid password, unknown user, wrong role and inactive user fail', async () => {
  const { app, user } = fixture();
  for (const override of [{ password: 'wrong' }, { email: 'missing@example.com' }, { role: 'PLATFORM_ADMIN' }]) {
    await request(app).post('/login').send({ ...credentials, ...override }).expect(401);
  }
  user.status = 'INACTIVE';
  await request(app).post('/login').send(credentials).expect(401);
});
test('validates input and malformed JSON', async () => {
  const { app } = fixture();
  for (const body of [{}, { ...credentials, role: 'ROOT' }, { ...credentials, email: {} }, { ...credentials, password: 'a'.repeat(73) }]) {
    await request(app).post('/login').send(body).expect(400);
  }
  await request(app).post('/login').set('Content-Type', 'application/json').send('{').expect(400);
});
test('refresh rotates both tokens and returns the current user profile', async () => {
  const { app, user } = fixture();
  const login = await request(app).post('/login').send(credentials);
  user.first_name = 'Updated';
  const refreshed = await request(app).post('/refresh').send({ refreshToken: login.body.refreshToken }).expect(200);
  assert.equal(refreshed.body.user.firstName, 'Updated');
  assert.notEqual(refreshed.body.refreshToken, login.body.refreshToken);
  assert.notEqual(refreshed.body.accessToken, login.body.accessToken);
  await request(app).post('/refresh').send({ refreshToken: login.body.refreshToken }).expect(401);
  await request(app).get('/me').set('Authorization', 'Bearer ' + refreshed.body.accessToken).expect(401);
});
test('cookie login, refresh and logout revoke access and refresh tokens', async () => {
  const { app } = fixture();
  const agent = request.agent(app);
  await agent.post('/login').send(credentials).expect(200);
  await agent.get('/me').expect(200);
  const refreshed = await agent.post('/refresh').send({}).expect(200);
  const logout = await agent.post('/logout').send({}).expect(200);
  assert.ok(logout.headers['set-cookie'].every(c => c.includes('Expires=Thu, 01 Jan 1970')));
  await agent.get('/me').expect(401);
  await request(app).get('/me').set('Authorization', 'Bearer ' + refreshed.body.accessToken).expect(401);
  await request(app).post('/refresh').send({ refreshToken: refreshed.body.refreshToken }).expect(401);
  await agent.post('/logout').expect(200);
});
test('rejects tampered, expired and wrong-type tokens', async () => {
  const { app, service } = fixture();
  const login = await service.login(credentials);
  await request(app).get('/me').set('Authorization', 'Bearer ' + login.refreshToken).expect(401);
  await request(app).get('/me').set('Authorization', 'Bearer ' + login.accessToken + 'x').expect(401);
  await request(app).post('/refresh').send({ refreshToken: login.accessToken }).expect(401);
  const claims = jwt.decode(login.accessToken);
  delete claims.exp;
  const expired = jwt.sign(claims, config.accessSecret, { expiresIn: -1 });
  await request(app).get('/me').set('Authorization', 'Bearer ' + expired).expect(401);
});
test('role removal, account disable and session expiration invalidate tokens', async () => {
  for (const change of [
    f => { f.user.roles = []; },
    f => { f.user.status = 'LOCKED'; },
    f => { [...f.sessions.values()][0].expires_at = new Date(0); },
  ]) {
    const f = fixture();
    const tokens = await f.service.login(credentials);
    change(f);
    await request(f.app).get('/me').set('Authorization', 'Bearer ' + tokens.accessToken).expect(401);
    await request(f.app).post('/refresh').send({ refreshToken: tokens.refreshToken }).expect(401);
  }
});
test('RBAC uses authenticated selected role', async () => {
  const { service } = fixture();
  const tokens = await service.login(credentials);
  const app = express();
  app.get('/customer', authenticate(service), authorize('CUSTOMER'), (req, res) => res.sendStatus(200));
  app.get('/admin', authenticate(service), authorize('PLATFORM_ADMIN'), (req, res) => res.sendStatus(200));
  app.use((err, req, res, next) => res.sendStatus(err.status || 500));
  await request(app).get('/customer').set('Authorization', 'Bearer ' + tokens.accessToken).expect(200);
  await request(app).get('/admin').set('Authorization', 'Bearer ' + tokens.accessToken).expect(403);
});
test('rejects untrusted browser origins and permits configured credentialed CORS', async () => {
  const { app } = fixture();
  await request(app).post('/login').set('Origin', 'https://evil.example').send(credentials).expect(403);
  await request(app).post('/logout').set('Sec-Fetch-Site', 'cross-site').expect(403);
  const res = await request(app).options('/login').set('Origin', 'http://localhost:5173').set('Access-Control-Request-Method', 'POST').expect(204);
  assert.equal(res.headers['access-control-allow-credentials'], 'true');
});
test('production cookies are Secure and secrets are validated', () => {
  assert.equal(loadConfig({ JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32), NODE_ENV: 'production' }).cookie.secure, true);
  assert.throws(() => loadConfig({}));
  assert.throws(() => loadConfig({ JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'a'.repeat(32) }));
});
test('rate limits repeated login attempts', async () => {
  const { app } = fixture();
  for (let i = 0; i < 30; i++) await request(app).post('/login').send({}).expect(400);
  await request(app).post('/login').send({}).expect(429);
});
test('concurrent refresh permits only one rotation and replay revokes the session', async () => {
  const { app, service } = fixture();
  const tokens = await service.login(credentials);
  const results = await Promise.all([1, 2].map(() => request(app).post('/refresh').send({ refreshToken: tokens.refreshToken })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
  await request(app).get('/me').set('Authorization', 'Bearer ' + results.find(r => r.status === 200).body.accessToken).expect(401);
});


test('email login normalizes case and spaces and rejects username-only requests', async () => {
  const { app } = fixture();
  const response = await request(app).post('/login').send({ ...credentials, email: '  DEMO@EXAMPLE.COM  ' }).expect(200);
  assert.equal(response.body.user.email, 'demo@example.com');
  assert.equal('username' in response.body.user, false);
  const refreshed = await request(app).post('/refresh').send({ refreshToken: response.body.refreshToken }).expect(200);
  assert.equal(refreshed.body.user.email, 'demo@example.com');
  assert.equal('username' in refreshed.body.user, false);
  await request(app).post('/login').send({ username: 'demo', password, role: 'CUSTOMER' }).expect(400);
  for (const email of ['demo', 'demo@', '@example.com', 'demo @example.com', 'a'.repeat(250) + '@example.com']) {
    await request(app).post('/login').send({ ...credentials, email }).expect(400);
  }
});
