const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { DashboardService } = require('../src/services/dashboard.service');
const { DashboardRepository } = require('../src/repositories/dashboard.repository');
const { ApiError } = require('../src/utils/errors');
const vendorId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const range = 'from=2026-09-25&to=2026-09-25';
function fixture() {
  const calls = [];
  const user = { role: 'VENDOR', vendorId };
  const repo = {
    hasAirport: async (vendor, code) => vendor === vendorId && code === 'BOM',
    dashboard: async (vendor, f) => { calls.push({ vendor, f }); return { current: { totalRequests: 15, confirmed: 5 }, previous: { totalRequests: 10, confirmed: 0 }, recentRequests: [] }; },
    airports: async vendor => { calls.push({ vendor }); return [{ code: 'BOM' }]; },
    list: async (vendor, f) => { calls.push({ vendor, f }); return { items: [], pagination: { page: f.page, pageSize: f.pageSize, total: 0, totalPages: 0 } }; },
    detail: async (vendor, requestId) => { calls.push({ vendor, requestId }); return undefined; },
  };
  const service = { authenticate: async token => { if (token !== 'valid') throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required'); return user; } };
  const app = createApp({ service, config: { origins: [] }, dashboardService: new DashboardService(repo) });
  const get = url => request(app).get(url).set('Authorization', 'Bearer valid');
  return { app, get, user, calls, repo };
}
test('dashboard computes comparisons and propagates authenticated vendor scope', async () => {
  const { get, calls } = fixture();
  const res = await get('/api/v1/dashboard/vendor?' + range + '&airportCode=BOM').expect(200);
  assert.deepEqual(res.body.summary.totalRequests, { count: 15, changePercent: 50 });
  assert.deepEqual(res.body.summary.confirmed, { count: 5, changePercent: null });
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.body.comparisonPeriod, { from: '2026-09-24', to: '2026-09-24' });
  assert.equal(calls[0].vendor, vendorId);
});
test('all dashboard routes require authentication, vendor role and membership', async () => {
  for (const path of ['/dashboard/vendor?' + range, '/airports', '/service-requests?' + range, '/service-requests/' + id]) {
    const { app, get, user, calls } = fixture();
    await request(app).get('/api/v1' + path).expect(401);
    user.role = 'CUSTOMER';
    await get('/api/v1' + path).expect(403);
    user.role = 'VENDOR'; user.vendorId = null;
    await get('/api/v1' + path).expect(403);
    assert.equal(calls.length, 0);
  }
});
test('rejects malformed, duplicate, oversized and tenant override filters', async () => {
  const { get, calls } = fixture();
  for (const query of ['', 'from=2026-02-30&to=2026-03-01', 'from=2026-09-26&to=2026-09-25',
    'from=2026-01-01&to=2026-12-31', range + '&from=2026-09-24', range + '&recentLimit=0',
    range + '&recentLimit=51', range + '&vendorId=another', range + '&airportCode=bom']) {
    await get('/api/v1/dashboard/vendor?' + query).expect(400);
  }
  await get('/api/v1/dashboard/vendor?' + range + '&airportCode=DEL').expect(403);
  assert.equal(calls.length, 0);
});
test('airport lookup, pagination and request detail keep vendor scope', async () => {
  const { get, calls } = fixture();
  assert.equal((await get('/api/v1/airports').expect(200)).body.items[0].code, 'BOM');
  const res = await get('/api/v1/service-requests?' + range + '&page=2&pageSize=10&status=CONFIRMED').expect(200);
  assert.equal(res.body.pagination.page, 2);
  await get('/api/v1/service-requests?' + range + '&status=UNKNOWN').expect(400);
  await get('/api/v1/service-requests/not-a-uuid').expect(400);
  await get('/api/v1/service-requests/' + id).expect(404);
  assert.ok(calls.every(c => c.vendor === vendorId));
});
test('database errors do not masquerade as empty dashboards or expose SQL', async () => {
  const { get, repo } = fixture();
  repo.dashboard = async () => { throw new Error('private database details'); };
  const res = await get('/api/v1/dashboard/vendor?' + range).expect(500);
  assert.equal(res.body.message, 'Internal server error');
  assert.ok(res.body.correlationId);
});
test('empty aggregates return zero counts and null comparisons', async () => {
  const { get, repo } = fixture();
  repo.dashboard = async () => ({ current: {}, previous: {}, recentRequests: [] });
  const res = await get('/api/v1/dashboard/vendor?' + range).expect(200);
  assert.ok(Object.values(res.body.summary).every(v => v.count === 0 && v.changePercent === null));
});
test('snapshot failure rolls back and releases connection', async () => {
  const events = [];
  const client = { query: async sql => events.push(sql), release: () => events.push('release') };
  const repo = new DashboardRepository({ connect: async () => client });
  await assert.rejects(repo.snapshot(async () => { throw new Error('query failed'); }), /query failed/);
  assert.deepEqual(events, ['BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK', 'release']);
});
