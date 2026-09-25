class ServiceRequestRepository {
  constructor(pool) { this.pool=pool; }
  async transaction(work) {
    const client=await this.pool.connect();
    try { await client.query('BEGIN'); const result=await work(client); await client.query('COMMIT'); return result; }
    catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async lockIdentity(client,user,reference) {
    const identity=(user.role==='VENDOR' ? user.vendorId : user.id)+':'+reference;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[identity]);
  }
  async duplicate(client,user,reference) {
    const vendor=user.role==='VENDOR';
    return (await client.query('SELECT trip_id FROM service_requests WHERE '+(vendor?'vendor_id=$1':'vendor_id IS NULL AND created_by_user_id=$1')+' AND source_booking_reference=$2',
      [vendor?user.vendorId:user.id,reference])).rows[0];
  }
  async references(client,data,user) {
    const airport=(await client.query("SELECT *, to_char(CURRENT_TIMESTAMP AT TIME ZONE timezone,'YYYY-MM-DD') AS local_today FROM airports WHERE airport_code=$1 AND status='ACTIVE'",[data.airportCode])).rows[0];
    const service=(await client.query("SELECT * FROM service_types WHERE code=$1 AND status='ACTIVE'",[data.serviceType])).rows[0];
    const terminal=airport && data.terminal ? (await client.query("SELECT * FROM terminals WHERE airport_id=$1 AND terminal_code=$2 AND status='ACTIVE'",[airport.id,data.terminal])).rows[0]:null;
    const vendor=user.role==='VENDOR' ? (await client.query("SELECT id FROM vendors WHERE id=$1 AND status='ACTIVE'",[user.vendorId])).rows[0]:null;
    return {airport,service,terminal,vendor};
  }
  async reserve(client,refs,data) {
    // Deterministic locking serializes overlapping requests before checking capacity.
    const slots=(await client.query("SELECT * FROM capacity_slots WHERE airport_id=$1 AND service_type_id=$2 AND slot_date=$3 AND window_start<=$4::time AND window_end>$4::time AND status='ACTIVE' ORDER BY window_start,id FOR UPDATE",
      [refs.airport.id,refs.service.id,data.flightDate,data.flightTime])).rows;
    const slot=slots.find(s=>s.total_capacity-s.reserved_capacity>=data.passenger.count);
    if (!slot) return {slot:null,reason:slots.length?'SLOT_NO_CAPACITY':'SLOT_NOT_CONFIGURED'};
    await client.query('UPDATE capacity_slots SET reserved_capacity=reserved_capacity+$2,version=version+1,updated_at=now() WHERE id=$1',[slot.id,data.passenger.count]);
    return {slot};
  }
  async insert(client,user,data,refs,reservation) {
    const sequence=(await client.query("SELECT nextval('trip_id_sequence') AS value")).rows[0].value;
    const tripId='PRN-'+data.airportCode+'-'+data.flightDate.replaceAll('-','')+'-'+String(sequence).padStart(6,'0');
    const status=reservation.slot?'CONFIRMED':'REJECTED';
    const reason=reservation.reason || null;
    const message=reason==='SLOT_NO_CAPACITY'?'Insufficient capacity for the passenger count':reason?'No active capacity slot matches the requested service time':null;
    const fields={
      trip_id:tripId,vendor_id:user.role==='VENDOR'?user.vendorId:null,created_by_user_id:user.id,
      source_channel:data.sourceChannel,source_booking_reference:data.sourceBookingReference,
      passenger_name:data.passenger.name,passenger_count:data.passenger.count,mobile:data.passenger.mobile,email:data.passenger.email,
      airport_id:refs.airport.id,terminal_id:refs.terminal?.id || null,flight_number:data.flightNumber,flight_date:data.flightDate,
      flight_time:data.flightTime,movement_type:data.movementType,service_type_id:refs.service.id,
      preferred_language:data.passenger.preferredLanguage,passenger_category:data.passenger.category,
      special_requirements:data.specialRequirements,additional_notes:data.additionalNotes,status,
      capacity_slot_id:reservation.slot?.id || null,rejection_reason_code:reason,rejection_reason_message:message,
      confirmed_at:reservation.slot?new Date():null,
    };
    const keys=Object.keys(fields);
    const row=(await client.query('INSERT INTO service_requests('+keys.join(',')+') VALUES('+keys.map((_,i)=>'$'+(i+1)).join(',')+') RETURNING *',Object.values(fields))).rows[0];
    const transitions=['RECEIVED','VALIDATING','CAPACITY_CHECK',...(reservation.slot?['CAPACITY_RESERVED','CONFIRMED']:['REJECTED'])];
    for(let i=0;i<transitions.length;i++) await client.query("INSERT INTO request_status_history(service_request_id,from_status,to_status,reason_code,remarks,changed_by_user_id,changed_by_type) VALUES($1,$2,$3,$4,$5,$6,'USER')",
      [row.id,i?transitions[i-1]:null,transitions[i],transitions[i]==='REJECTED'?reason:null,transitions[i]==='REJECTED'?message:null,user.id]);
    return {...row,airport_code:data.airportCode,service_type:data.serviceType,terminal_code:data.terminal};
  }
  scope(user,params) {
    if(user.role==='VENDOR') {params.push(user.vendorId);return 'sr.vendor_id=$'+params.length;}
    if(user.role==='CUSTOMER') {params.push(user.id);return 'sr.created_by_user_id=$'+params.length;}
    return 'TRUE';
  }
  select() {return 'SELECT sr.*, a.airport_code, st.code AS service_type, t.terminal_code FROM service_requests sr JOIN airports a ON a.id=sr.airport_id JOIN service_types st ON st.id=sr.service_type_id LEFT JOIN terminals t ON t.id=sr.terminal_id';}
  async get(user,tripId) {
    const values=[tripId],scope=this.scope(user,values);
    return (await this.pool.query(this.select()+' WHERE sr.trip_id=$1 AND '+scope,values)).rows[0];
  }
  async list(user,filter) {
    const values=[],conditions=[this.scope(user,values)];
    if(filter.status){values.push(filter.status);conditions.push('sr.status=$'+values.length);}
    if(filter.airportCode){values.push(filter.airportCode);conditions.push('a.airport_code=$'+values.length);}
    const where=' WHERE '+conditions.join(' AND ');
    const total=Number((await this.pool.query('SELECT count(*) FROM service_requests sr JOIN airports a ON a.id=sr.airport_id'+where,values)).rows[0].count);
    values.push(filter.pageSize,(filter.page-1)*filter.pageSize);
    const items=(await this.pool.query(this.select()+where+' ORDER BY sr.created_at DESC,sr.id DESC LIMIT $'+(values.length-1)+' OFFSET $'+values.length,values)).rows;
    return {items,total};
  }
  async timeline(id) {
    return (await this.pool.query('SELECT from_status AS "fromStatus",to_status AS "toStatus",reason_code AS "reasonCode",remarks,changed_by_user_id AS "changedByUserId",created_at AS "createdAt" FROM request_status_history WHERE service_request_id=$1 ORDER BY created_at, CASE to_status WHEN \'RECEIVED\' THEN 1 WHEN \'VALIDATING\' THEN 2 WHEN \'CAPACITY_CHECK\' THEN 3 WHEN \'CAPACITY_RESERVED\' THEN 4 ELSE 5 END,id',[id])).rows;
  }
}
module.exports={ServiceRequestRepository};

