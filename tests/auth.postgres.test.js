const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { AuthRepository } = require('../src/repositories/auth.repository');
const { AuthService } = require('../src/services/auth.service');
const { loadConfig } = require('../src/config/env');

test('PostgreSQL role lookup, login, rotation and logout', { skip: process.env.AUTH_TEST_POSTGRES !== 'true' }, async () => {
  const pool = require('../src/config/database');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = randomUUID();
    const email = id + '@example.test';
    const password = randomUUID();
    await client.query('INSERT INTO users(id,email,first_name,last_name,password_hash) VALUES($1,$2,$3,$4,$5)', [id,email,'Auth','Test',await bcrypt.hash(password,4)]);
    const assigned = await client.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='GRO' RETURNING user_id", [id]);
    assert.equal(assigned.rowCount, 1);
    // Keep all repository transactions inside this test's rollback boundary.
    const scopedClient = {
      query: (sql, values) => client.query(({ BEGIN: 'SAVEPOINT auth_test', COMMIT: 'RELEASE SAVEPOINT auth_test', ROLLBACK: 'ROLLBACK TO SAVEPOINT auth_test' })[sql] || sql, values),
      release() {},
    };
    const repository = new AuthRepository({ query: (sql, values) => client.query(sql, values), connect: async () => scopedClient });
    const config = loadConfig({ JWT_ACCESS_SECRET: randomUUID(), JWT_REFRESH_SECRET: randomUUID() });
    const service = new AuthService(repository, config);
    const login = await service.login({ email, password, role: 'GRO' });
    assert.equal(login.user.role, 'GRO');
    const refreshed = await service.refresh(login.refreshToken);
    assert.equal((await service.authenticate(refreshed.accessToken)).email, email);
    await service.logout(refreshed.refreshToken, 'refresh');
    await assert.rejects(service.authenticate(refreshed.accessToken), { status: 401 });
    await assert.rejects(service.refresh(refreshed.refreshToken), { status: 401 });
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
