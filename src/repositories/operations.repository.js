const { DashboardRepository } = require('./dashboard.repository');
const { ApiError } = require('../utils/errors');

// All aggregates share this server-derived airport scope, including GRO counts.
const AIRPORT_SCOPE = `FROM airports a WHERE
 ($1::boolean OR EXISTS (SELECT 1 FROM user_airports ua WHERE ua.airport_id=a.id AND ua.user_id=$2::uuid))
 AND ($3::text IS NULL OR a.airport_code=$3)`;
const REQUEST_SCOPE = `FROM service_requests r JOIN airports a ON a.id=r.airport_id
 JOIN service_types st ON st.id=r.service_type_id
 WHERE r.airport_id=ANY($1::uuid[])
 AND r.created_at >= ($2::date::timestamp AT TIME ZONE a.timezone)
 AND r.created_at < (($3::date + 1)::timestamp AT TIME ZONE a.timezone)`;

class OperationsRepository extends DashboardRepository {
  async operations(user, f) {
    return this.snapshot(async client => {
      const airports = (await client.query(`SELECT a.id ${AIRPORT_SCOPE}`,
        [user.role === 'PLATFORM_ADMIN', user.id, f.airportCode])).rows;
      if (!airports.length) throw new ApiError(403, 'FORBIDDEN', 'No access to the requested airports');
      const ids = airports.map(a => a.id);
      const args = [ids, f.from, f.to];
      const summary = (await client.query(`SELECT count(*)::integer AS "totalRequests",
        count(*) FILTER (WHERE r.status='CONFIRMED')::integer AS confirmed,
        count(*) FILTER (WHERE r.status='GRO_ASSIGNED')::integer AS "groAssigned",
        count(*) FILTER (WHERE r.status='IN_PROGRESS')::integer AS "inProgress",
        count(*) FILTER (WHERE r.status='COMPLETED')::integer AS completed,
        count(*) FILTER (WHERE r.status='WAITLISTED')::integer AS waitlisted,
        count(*) FILTER (WHERE r.status='REJECTED')::integer AS rejected
        ${REQUEST_SCOPE}`, args)).rows[0];
      summary.availableGros = (await client.query(`SELECT count(*)::integer AS count FROM gros
        WHERE airport_id=ANY($1::uuid[]) AND status='AVAILABLE'`, [ids])).rows[0].count;
      const serviceTypeDistribution = (await client.query(`SELECT st.code AS "serviceType", st.name,
        count(*)::integer AS count ${REQUEST_SCOPE} GROUP BY st.code,st.name ORDER BY st.code`, args)).rows;
      const statusTrend = (await client.query(`SELECT to_char(r.created_at AT TIME ZONE a.timezone,'YYYY-MM-DD') AS date,
        r.status,count(*)::integer AS count ${REQUEST_SCOPE} GROUP BY 1,r.status ORDER BY 1,r.status`, args)).rows;
      const recentRequests = (await client.query(`SELECT r.id,r.trip_id AS "tripId",
        r.flight_number AS "flightNumber",to_char(r.flight_date,'YYYY-MM-DD') AS "flightDate",
        a.airport_code AS "airportCode",json_build_object('code',st.code,'name',st.name) AS "serviceType",
        r.status,r.created_at AS "createdAt",r.vendor_id AS "vendorId",
        (SELECT v.vendor_name FROM vendors v WHERE v.id=r.vendor_id) AS "vendorName"
        ${REQUEST_SCOPE} ORDER BY r.created_at DESC,r.id DESC LIMIT $4`, [...args, f.limit])).rows;
      return { summary, serviceTypeDistribution, statusTrend, recentRequests };
    });
  }
}
module.exports = { OperationsRepository };
