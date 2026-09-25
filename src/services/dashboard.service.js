const { ApiError } = require('../utils/errors');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['RECEIVED', 'VALIDATING', 'CAPACITY_CHECK', 'CAPACITY_RESERVED', 'CONFIRMED', 'WAITLISTED', 'REJECTED', 'GRO_ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'FAILED'];
const invalid = message => { throw new ApiError(400, 'VALIDATION_FAILED', message); };
function date(value, key) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value || value < '1900-01-01') invalid(key + ' must be a valid YYYY-MM-DD date');
  return value;
}
function integer(value, fallback, max, key) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) invalid(key + ' is out of range');
  return Number(value);
}
function filters(query, list = false) {
  const allowed = ['from', 'to', 'airportCode', ...(list ? ['page', 'pageSize', 'status'] : ['recentLimit'])];
  if (Object.keys(query).some(k => !allowed.includes(k))) invalid('Unsupported query parameter');
  const from = date(query.from, 'from'), to = date(query.to, 'to');
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  if (days < 1 || days > 92) invalid('Date range must be between 1 and 92 days');
  if (query.airportCode !== undefined && (typeof query.airportCode !== 'string' || !/^[A-Z]{3}$/.test(query.airportCode))) invalid('airportCode must be a three-letter uppercase code');
  if (query.status !== undefined && !STATUSES.includes(query.status)) invalid('Invalid status');
  const shift = n => new Date(Date.parse(from) - n * 86400000).toISOString().slice(0, 10);
  return { from, to, airportCode: query.airportCode || null, previousFrom: shift(days), previousTo: shift(1),
    limit: integer(query.recentLimit, 5, 50, 'recentLimit'),
    page: integer(query.page, 1, 100000, 'page'), pageSize: integer(query.pageSize, 20, 100, 'pageSize'), status: query.status || null };
}
class DashboardService {
  constructor(repository) { this.repo = repository; }
  async scoped(user, query, list = false) {
    const f = filters(query, list);
    if (f.airportCode && !await this.repo.hasAirport(user.vendorId, f.airportCode)) throw new ApiError(403, 'FORBIDDEN', 'Airport is not available to this vendor');
    return f;
  }
  async dashboard(user, query) {
    const f = await this.scoped(user, query);
    const { current, previous, recentRequests } = await this.repo.dashboard(user.vendorId, f);
    const summary = {};
    for (const key of ['totalRequests', 'confirmed', 'inProgress', 'rejected']) {
      const count = Number(current[key] || 0), before = Number(previous[key] || 0);
      summary[key] = { count, changePercent: before ? Math.round((count - before) / before * 10000) / 100 : null };
    }
    return { filters: { airportCode: f.airportCode, from: f.from, to: f.to }, summary,
      comparisonPeriod: { from: f.previousFrom, to: f.previousTo }, recentRequests };
  }
  async list(user, query) { return this.repo.list(user.vendorId, await this.scoped(user, query, true)); }
  async detail(user, id) {
    if (!UUID.test(id)) invalid('Invalid request ID');
    const item = await this.repo.detail(user.vendorId, id);
    if (!item) throw new ApiError(404, 'NOT_FOUND', 'Request not found');
    return item;
  }
  airports(user) { return this.repo.airports(user.vendorId); }
}
module.exports = { DashboardService, filters };
