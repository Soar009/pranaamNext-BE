const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { OperationsService } = require('../src/services/operations.service');
const { OperationsRepository } = require('../src/repositories/operations.repository');
const { ApiError } = require('../src/utils/errors');
const userId = '11111111-1111-4111-8111-111111111111';
const airportId = '22222222-2222-4222-8222-222222222222';
const url = '/api/v1/dashboard/operations?from=2026-09-25&to=2026-09-25';
function fixture() {
  const user = { id: userId, role: 'OPERATIONS' };
  const calls = [];
  const state = { airportIds: [airportId], fail: false, released: false };
  const client = {
    release: () => { state.released = true; },
    query: async (sql, args) => {
      calls.push({ sql, args });
      if (sql.startsWith('SELECT a.id')) return { rows: state.airportIds.map(id => ({ id })) };
      if (sql.includes('AS "totalRequests"')) {
        if (state.fail) throw new Error('private database failure');
        return { rows: [{ totalRequests: 0, confirmed: 0, groAssigned: 0, inProgress: 0, completed: 0, waitlisted: 0, rejected: 0 }] };
      }
      if (sql.includes('FROM gros')) return { rows: [{ count: 2 }] };
      return { rows: [] };
    },
  };
  const repo = new OperationsRepository({ connect: async () => client });
  const service = { authenticate: async token => {
    if (token !== 'valid') throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    return user;
  } };
  const app = createApp({ service, config: { origins: [] }, operationsService: new OperationsService(repo) });
  return { app, user, state, calls, get: path => request(app).get(path).set('Authorization', 'Bearer valid') };
}
test('operations returns aggregate response and binds airport permissions to authenticated user', async () => {
  const { get, calls, state } = fixture();
  const res = await get(url + '&airportCode=BOM&recentLimit=10').expect(200);
  assert.equal(res.body.summary.totalRequests, 0);
  assert.equal(res.body.summary.availableGros, 2);
  assert.deepEqual(res.body.serviceTypeDistribution, []);
  assert.deepEqual(res.body.statusTrend, []);
  assert.deepEqual(res.body.recentRequests, []);
  assert.equal(res.headers['cache-control'], 'no-store');
  const scope = calls.find(c => c.sql.startsWith('SELECT a.id'));
  assert.deepEqual(scope.args, [false, userId, 'BOM']);
  assert.match(scope.sql, /ua.user_id=\$2::uuid/);
  for (const call of calls.filter(c => /FROM service_requests|FROM gros/.test(c.sql))) {
    assert.deepEqual(call.args[0], [airportId]);
    assert.match(call.sql, /airport_id=ANY\(\$1::uuid\[\]\)/);
  }
  assert.equal(calls.at(-1).sql, 'COMMIT');
  assert.ok(state.released);
});
test('platform admin bypass is derived only from authenticated role', async () => {
  const { get, user, calls } = fixture();
  user.role = 'PLATFORM_ADMIN';
  await get(url).expect(200);
  assert.deepEqual(calls.find(c => c.sql.startsWith('SELECT a.id')).args, [true, userId, null]);
});
test('airport admins remain airport scoped', async () => {
  const { get, user, calls } = fixture();
  user.role = 'AIRPORT_ADMIN';
  await get(url).expect(200);
  assert.equal(calls.find(c => c.sql.startsWith('SELECT a.id')).args[0], false);
});
test('anonymous and unrelated roles cannot call operations dashboard', async () => {
  const { app, get, user, calls } = fixture();
  await request(app).get(url).expect(401);
  for (const role of ['VENDOR', 'CUSTOMER', 'GRO', 'FINANCE', 'GRL', 'GRM']) {
    user.role = role;
    await get(url).expect(403);
  }
  assert.equal(calls.length, 0);
});
test('no airport permissions or inaccessible airport fails closed', async () => {
  for (const path of [url, url + '&airportCode=DEL']) {
    const { get, state, calls } = fixture();
    state.airportIds = [];
    await get(path).expect(403);
    assert.equal(calls.at(-1).sql, 'ROLLBACK');
    assert.ok(!calls.some(c => c.sql.includes('FROM service_requests')));
    assert.ok(state.released);
  }
});
test('validates dates, range, limits and rejects client-supplied authorization', async () => {
  const { get, calls } = fixture();
  for (const path of ['/api/v1/dashboard/operations', url + '&vendorId=x', url + '&userId=x',
    url + '&role=PLATFORM_ADMIN', url + '&recentLimit=51', url + '&airportCode=bom',
    url + '&from=2026-09-24', '/api/v1/dashboard/operations?from=2026-02-30&to=2026-03-01',
    '/api/v1/dashboard/operations?from=2026-01-01&to=2026-12-31']) await get(path).expect(400);
  assert.equal(calls.length, 0);
});
test('database failure rolls back, releases connection and hides SQL details', async () => {
  const { get, state, calls } = fixture();
  state.fail = true;
  const res = await get(url).expect(500);
  assert.equal(res.body.message, 'Internal server error');
  assert.ok(res.body.correlationId);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
  assert.ok(state.released);
});
