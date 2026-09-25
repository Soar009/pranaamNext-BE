const BATCH = `SELECT b.id AS "batchId", b.batch_reference AS "batchReference",b.file_name AS "fileName",
 b.status,b.created_at AS "createdAt",b.submitted_at AS "submittedAt",
 count(i.id)::integer AS "totalRows",
 count(i.id) FILTER (WHERE i.validation_status='VALID')::integer AS "validRows",
 count(i.id) FILTER (WHERE i.validation_status='INVALID')::integer AS "invalidRows",
 count(i.id) FILTER (WHERE i.validation_status='DUPLICATE')::integer AS "duplicateRows",
 count(i.id) FILTER (WHERE i.validation_status='SUBMITTED')::integer AS "submittedRows",
 count(i.id) FILTER (WHERE i.validation_status='FAILED')::integer AS "failedRows"
 FROM bulk_upload_batches b LEFT JOIN bulk_upload_items i ON i.batch_id=b.id
 WHERE b.id=$1 AND b.vendor_id=$2 GROUP BY b.id`;
const ITEM = `i.id,i.row_number AS "rowNumber",i.raw_payload->>'passengerName' AS "passengerName",
 i.raw_payload->>'flightNumber' AS "flightNumber",i.raw_payload->>'serviceType' AS "serviceType",
 i.validation_status AS "validationStatus",i.reason_code AS "reasonCode",i.reason_message AS "reasonMessage"`;
class BulkUploadRepository {
  constructor(pool) { this.pool = pool; }
  async transaction(fn) {
    const c = await this.pool.connect();
    try { await c.query('BEGIN'); const value = await fn(new BulkUploadTransaction(c)); await c.query('COMMIT'); return value; }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async summary(id, vendor) { return (await this.pool.query(BATCH,[id,vendor])).rows[0]; }
  async items(id, vendor, statuses, limit, offset) {
    const where = `FROM bulk_upload_items i JOIN bulk_upload_batches b ON b.id=i.batch_id
      WHERE b.id=$1 AND b.vendor_id=$2 AND ($3::text[] IS NULL OR i.validation_status=ANY($3::text[]))`;
    // Count and page in one statement, including when the requested page is empty.
    const { rows } = await this.pool.query(`WITH filtered AS (SELECT ${ITEM} ${where}),
      page AS (SELECT * FROM filtered ORDER BY "rowNumber",id LIMIT $4 OFFSET $5)
      SELECT (SELECT count(*)::integer FROM filtered) AS total,
      COALESCE((SELECT json_agg(page ORDER BY "rowNumber",id) FROM page),'[]'::json) AS items`, [id,vendor,statuses,limit,offset]);
    return rows[0];
  }
}
class BulkUploadTransaction {
  constructor(client) { this.c = client; }
  async lockBatch(id, vendor) { return (await this.c.query('SELECT * FROM bulk_upload_batches WHERE id=$1 AND vendor_id=$2 FOR UPDATE',[id,vendor])).rows[0]; }
  async rows(id) { return (await this.c.query('SELECT * FROM bulk_upload_items WHERE batch_id=$1 ORDER BY row_number LIMIT 1001 FOR UPDATE',[id])).rows; }
  async airport(vendor, code) { return (await this.c.query('SELECT a.id FROM airports a JOIN vendor_airports va ON va.airport_id=a.id WHERE va.vendor_id=$1 AND a.airport_code=$2',[vendor,code])).rows[0]; }
  async serviceType(code) { return (await this.c.query('SELECT id FROM service_types WHERE code=$1',[code])).rows[0]; }
  async insertRequest({ id,tripId,vendorId,airportId,typeId,p }) {
    return (await this.c.query(`INSERT INTO service_requests
      (id,trip_id,vendor_id,airport_id,service_type_id,source_channel,source_booking_reference,
       passenger_name,passenger_count,mobile,email,flight_number,flight_date,movement_type,special_requirements,status)
      VALUES ($1,$2,$3,$4,$5,'BULK_UPLOAD',$6,$7,$8,$9,$10,$11,$12,$13,$14,'RECEIVED')
      ON CONFLICT (vendor_id,source_booking_reference) DO NOTHING RETURNING id`,
    [id,tripId,vendorId,airportId,typeId,p.sourceBookingReference,p.passengerName,p.passengerCount,p.mobile,p.email,p.flightNumber,p.flightDate,p.movementType,p.specialRequirements])).rowCount > 0;
  }
  async history(id, requestId, userId) { await this.c.query(`INSERT INTO request_status_history
    (id,service_request_id,to_status,reason_code,changed_by_user_id,changed_by_type)
    VALUES ($1,$2,'RECEIVED','BULK_SUBMITTED',$3,'USER')`,[id,requestId,userId]); }
  async mark(id,status,requestId,code,message) { await this.c.query(`UPDATE bulk_upload_items SET validation_status=$2,
    service_request_id=$3,reason_code=$4,reason_message=$5,processed_at=now() WHERE id=$1`,[id,status,requestId,code,message]); }
  async finish(id,result) { await this.c.query('UPDATE bulk_upload_batches SET status=$2,submission_result=$3,submitted_at=now() WHERE id=$1',[id,result.status,result]); }
}
module.exports = { BulkUploadRepository };
