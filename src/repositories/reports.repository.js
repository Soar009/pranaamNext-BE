class ReportsRepository {
  constructor(pool){this.pool=pool;}
  async report(kind,filters) {
    const values=[],conditions=[];
    const param=value=>{values.push(value);return '$'+values.length;};
    if(filters.from)conditions.push('sr.flight_date>='+param(filters.from)+'::date');
    if(filters.to)conditions.push('sr.flight_date<='+param(filters.to)+'::date');
    const airport=filters.airportCode?param(filters.airportCode):null;
    const vendor=filters.vendorId?param(filters.vendorId):null;
    if(airport)conditions.push('a.airport_code='+airport);
    if(vendor)conditions.push('sr.vendor_id='+vendor+'::uuid');
    if(filters.serviceType)conditions.push('st.code='+param(filters.serviceType));
    const cte="WITH filtered AS (SELECT sr.*,a.airport_code,st.code AS service_type,v.vendor_name FROM service_requests sr JOIN airports a ON a.id=sr.airport_id JOIN service_types st ON st.id=sr.service_type_id LEFT JOIN vendors v ON v.id=sr.vendor_id"+(conditions.length?' WHERE '+conditions.join(' AND '):'')+')';
    const limit=param(filters.pageSize),offset=param((filters.page-1)*filters.pageSize);
    let sql;
    if(kind==='service-overview') {
      sql=cte+`, summary AS (
        SELECT count(*)::int AS "totalRequests",COALESCE(sum(passenger_count),0)::int AS "totalPassengers",
        count(*) FILTER(WHERE status='COMPLETED')::int AS completed,
        count(*) FILTER(WHERE status='REJECTED')::int AS rejected,
        count(*) FILTER(WHERE status='CONFIRMED')::int AS confirmed,
        count(*) FILTER(WHERE status='IN_PROGRESS')::int AS "inProgress"
        FROM filtered
      ), statuses AS (SELECT status,count(*)::int AS count FROM filtered GROUP BY status),
      services AS (SELECT service_type AS "serviceType",count(*)::int AS count FROM filtered GROUP BY service_type),
      items AS (SELECT trip_id AS "tripId",status,source_booking_reference AS "sourceBookingReference",
        passenger_name AS "passengerName",passenger_count AS "passengerCount",
        airport_code AS "airportCode",flight_number AS "flightNumber",to_char(flight_date,'YYYY-MM-DD') AS "flightDate",
        flight_time AS "flightTime",service_type AS "serviceType",vendor_id AS "vendorId",vendor_name AS "vendorName",
        rejection_reason_code AS "rejectionReasonCode",created_at AS "createdAt"
        FROM filtered ORDER BY flight_date DESC,created_at DESC,id DESC LIMIT ${limit} OFFSET ${offset})
      SELECT (SELECT row_to_json(summary) FROM summary) AS summary,
        COALESCE((SELECT json_agg(statuses ORDER BY status) FROM statuses),'[]') AS "statusBreakdown",
        COALESCE((SELECT json_agg(services ORDER BY "serviceType") FROM services),'[]') AS "serviceTypeBreakdown",
        COALESCE((SELECT json_agg(items) FROM items),'[]') AS items,
        (SELECT count(*)::int FROM filtered) AS total`;
    } else if(kind==='vendor-analysis') {
      sql=cte+`, stats AS (
        SELECT vendor_id,count(*)::int AS requests,COALESCE(sum(passenger_count),0)::int AS passengers,
          count(*) FILTER(WHERE status='COMPLETED')::int AS completed,
          count(*) FILTER(WHERE status='REJECTED')::int AS rejected,
          count(*) FILTER(WHERE status='IN_PROGRESS')::int AS "inProgress",
          count(*) FILTER(WHERE status='CONFIRMED')::int AS confirmed
        FROM filtered WHERE vendor_id IS NOT NULL GROUP BY vendor_id
      ), rows AS (
        SELECT v.id AS "vendorId",v.vendor_code AS "vendorCode",v.vendor_name AS "vendorName",v.status,
          COALESCE(s.requests,0) AS "totalRequests",COALESCE(s.passengers,0) AS "totalPassengers",
          COALESCE(s.completed,0) AS completed,COALESCE(s.rejected,0) AS rejected,
          COALESCE(s."inProgress",0) AS "inProgress",COALESCE(s.confirmed,0) AS confirmed,
          COALESCE(round(100.0*s.completed/NULLIF(s.requests,0),2),0)::float8 AS "completionRate"
        FROM vendors v LEFT JOIN stats s ON s.vendor_id=v.id ${vendor?'WHERE v.id='+vendor+'::uuid':''}
      ), items AS (SELECT * FROM rows ORDER BY "totalRequests" DESC,"vendorId" LIMIT ${limit} OFFSET ${offset})
      SELECT json_build_object('totalVendors',count(*)::int,'totalRequests',COALESCE(sum("totalRequests"),0)::int,
        'totalPassengers',COALESCE(sum("totalPassengers"),0)::int,'completed',COALESCE(sum(completed),0)::int,
        'rejected',COALESCE(sum(rejected),0)::int) AS summary,
        COALESCE((SELECT json_agg(items) FROM items),'[]') AS items,count(*)::int AS total FROM rows`;
    } else if(kind==='gro-utilization') {
      sql=cte+`, stats AS (
        SELECT x.gro_id,count(*)::int AS assignments,count(DISTINCT x.service_request_id)::int AS trips,
          count(*) FILTER(WHERE x.status IN ('ACCEPTED','IN_PROGRESS','COMPLETED'))::int AS accepted,
          count(*) FILTER(WHERE x.status='COMPLETED')::int AS completed,
          count(*) FILTER(WHERE x.status='REJECTED')::int AS rejected,
          count(*) FILTER(WHERE x.status='TIMED_OUT')::int AS "timedOut",
          count(*) FILTER(WHERE x.status IN ('ACCEPTED','IN_PROGRESS'))::int AS active,
          COALESCE(sum(EXTRACT(EPOCH FROM (x.completed_at-x.started_at))/60)
            FILTER(WHERE x.status='COMPLETED' AND x.started_at IS NOT NULL AND x.completed_at>=x.started_at),0)::float8 AS minutes,
          count(*) FILTER(WHERE x.status='COMPLETED' AND x.started_at IS NOT NULL AND x.completed_at>=x.started_at)::int AS timed
        FROM assignments x JOIN filtered f ON f.id=x.service_request_id GROUP BY x.gro_id
      ), rows AS (
        SELECT g.id AS "groId",g.gro_code AS "groCode",g.full_name AS "groName",a.airport_code AS "homeAirportCode",
          g.status AS "currentStatus",COALESCE(s.assignments,0) AS "totalAssignments",COALESCE(s.trips,0) AS "uniqueRequests",
          COALESCE(s.accepted,0) AS accepted,COALESCE(s.completed,0) AS completed,COALESCE(s.rejected,0) AS rejected,
          COALESCE(s."timedOut",0) AS "timedOut",COALESCE(s.active,0) AS "activeAssignments",
          COALESCE(s.minutes,0) AS "recordedServiceMinutes",COALESCE(s.timed,0) AS "timedCompletions",
          COALESCE(round(100.0*s.accepted/NULLIF(s.assignments,0),2),0)::float8 AS "acceptanceRate",
          CASE WHEN s.timed>0 THEN s.minutes/s.timed ELSE NULL END AS "averageServiceMinutes"
        FROM gros g JOIN airports a ON a.id=g.airport_id LEFT JOIN stats s ON s.gro_id=g.id
        ${airport?'WHERE (a.airport_code='+airport+' OR s.gro_id IS NOT NULL)':''}
      ), items AS (SELECT * FROM rows ORDER BY "totalAssignments" DESC,"groId" LIMIT ${limit} OFFSET ${offset})
      SELECT json_build_object('totalGros',count(*)::int,'assignedGros',count(*) FILTER(WHERE "totalAssignments">0)::int,
        'totalAssignments',COALESCE(sum("totalAssignments"),0)::int,'completed',COALESCE(sum(completed),0)::int,
        'recordedServiceMinutes',COALESCE(sum("recordedServiceMinutes"),0)::float8) AS summary,
        COALESCE((SELECT json_agg(items) FROM items),'[]') AS items,count(*)::int AS total FROM rows`;
    } else {throw new Error('Unknown report');}
    return (await this.pool.query(sql,values)).rows[0];
  }
}
module.exports={ReportsRepository};

