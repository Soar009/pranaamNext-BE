// Both vendor ownership and configured airport access apply to every request read.
const SOURCE = `FROM service_requests r JOIN airports a ON a.id=r.airport_id
 JOIN service_types st ON st.id=r.service_type_id
 JOIN vendor_airports va ON va.airport_id=a.id AND va.vendor_id=r.vendor_id
 WHERE r.vendor_id=$1`;
const RANGE = ` AND ($2::text IS NULL OR a.airport_code=$2)
 AND r.created_at >= ($3::date::timestamp AT TIME ZONE a.timezone)
 AND r.created_at < (($4::date + 1)::timestamp AT TIME ZONE a.timezone)`;
const COLUMNS = `r.id, r.trip_id AS "tripId", r.passenger_name AS "passengerName",
 r.flight_number AS "flightNumber", to_char(r.flight_date,'YYYY-MM-DD') AS "flightDate",
 a.airport_code AS "airportCode", json_build_object('code',st.code,'name',st.name) AS "serviceType",
 r.status, r.created_at AS "createdAt"`;
const ORDER = ' ORDER BY r.created_at DESC,r.id DESC';
class DashboardRepository {
  constructor(pool) { this.pool = pool; }
  async snapshot(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  }
  async airports(vendorId) {
    return (await this.pool.query(`SELECT a.id,a.airport_code AS code,a.airport_name AS name,a.timezone
      FROM airports a JOIN vendor_airports va ON va.airport_id=a.id WHERE va.vendor_id=$1 ORDER BY a.airport_code`, [vendorId])).rows;
  }
  async hasAirport(vendorId, code) {
    return (await this.pool.query(`SELECT 1 FROM vendor_airports va JOIN airports a ON a.id=va.airport_id
      WHERE va.vendor_id=$1 AND a.airport_code=$2`, [vendorId, code])).rowCount > 0;
  }
  async dashboard(vendorId, f) {
    return this.snapshot(async client => {
      const counts = async (from, to) => (await client.query(`SELECT count(*) AS "totalRequests",
        count(*) FILTER (WHERE r.status='CONFIRMED') AS confirmed,
        count(*) FILTER (WHERE r.status='IN_PROGRESS') AS "inProgress",
        count(*) FILTER (WHERE r.status='REJECTED') AS rejected ${SOURCE}${RANGE}`,
      [vendorId, f.airportCode, from, to])).rows[0];
      const current = await counts(f.from, f.to);
      const previous = await counts(f.previousFrom, f.previousTo);
      const recentRequests = (await client.query(`SELECT ${COLUMNS} ${SOURCE}${RANGE}${ORDER} LIMIT $5`,
        [vendorId, f.airportCode, f.from, f.to, f.limit])).rows;
      return { current, previous, recentRequests };
    });
  }
  async list(vendorId, f) {
    return this.snapshot(async client => {
      const where = SOURCE + RANGE + ' AND ($5::text IS NULL OR r.status=$5)';
      const args = [vendorId, f.airportCode, f.from, f.to, f.status];
      const total = Number((await client.query(`SELECT count(*) AS total ${where}`, args)).rows[0].total);
      const items = (await client.query(`SELECT ${COLUMNS} ${where}${ORDER} LIMIT $6 OFFSET $7`,
        [...args, f.pageSize, (f.page - 1) * f.pageSize])).rows;
      return { items, pagination: { page: f.page, pageSize: f.pageSize, total, totalPages: Math.ceil(total / f.pageSize) } };
    });
  }
  async detail(vendorId, id) {
    return (await this.pool.query(`SELECT ${COLUMNS},r.passenger_count AS "passengerCount",
      r.movement_type AS "movementType",r.mobile,r.email,r.special_requirements AS "specialRequirements"
      ${SOURCE} AND r.id=$2`, [vendorId, id])).rows[0];
  }
}
module.exports = { DashboardRepository };
