class PassengerAssistanceRepository {
  constructor(pool) { this.pool = pool; }
  async find(tripId, userId) {
    const { rows } = await this.pool.query(`SELECT r.trip_id AS "tripId",r.status,
      a.airport_code AS "airportCode",a.airport_name AS "airportName",
      r.flight_number AS "flightNumber",to_char(r.flight_date,'YYYY-MM-DD') AS "flightDate",
      CASE WHEN g.id IS NULL THEN NULL ELSE json_build_object(
        'name',g.full_name,'phone',g.mobile,'assignmentStatus',assigned.status) END AS gro
      FROM service_requests r JOIN airports a ON a.id=r.airport_id
      LEFT JOIN assignments assigned ON assigned.service_request_id=r.id
        AND assigned.status IN ('ACCEPTED','IN_PROGRESS')
        AND r.status IN ('GRO_ASSIGNED','IN_PROGRESS')
      LEFT JOIN gros g ON g.id=assigned.gro_id AND g.airport_id=r.airport_id
      WHERE r.trip_id=$1 AND r.customer_user_id=$2`,[tripId,userId]);
    return rows[0];
  }
}
module.exports = { PassengerAssistanceRepository };
