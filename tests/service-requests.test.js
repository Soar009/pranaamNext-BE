const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const bcrypt=require('bcryptjs');
const request=require('supertest');
const {createApp}=require('../src/app');
const {loadConfig}=require('../src/config/env');
const {AuthService}=require('../src/services/auth.service');
const {AuthRepository}=require('../src/repositories/auth.repository');
const {ServiceRequestRepository}=require('../src/repositories/service-request.repository');
const {ServiceRequestService}=require('../src/services/service-request.service');
const {ReportsService}=require('../src/services/reports.service');
const {ReportsRepository}=require('../src/repositories/reports.repository');
const {validateCreate}=require('../src/middleware/service-request.validation');
const input=()=>({sourceChannel:'CUSTOMER_PORTAL',sourceBookingReference:randomUUID(),
  passenger:{name:'Test Passenger',count:1,email:'passenger@example.test'},airportCode:'TST',
  terminal:'T1',flightNumber:'AI302',flightDate:'2099-01-01',flightTime:'12:00',movementType:'ARRIVAL',serviceType:'TEST_SERVICE'});
test('validates required fields and rejects authorization overrides before persistence',()=>{
  for(const change of [
    x=>delete x.passenger.name,x=>x.passenger.count=0,x=>delete x.passenger.email,
    x=>x.flightDate='2099-02-30',x=>x.flightTime='25:00',x=>x.vendorId=randomUUID(),
    x=>x.status='CONFIRMED',x=>x.passenger.email='bad',x=>x.movementType='OTHER',
  ]){
    const body=input();change(body);
    assert.throws(()=>validateCreate({body},{},()=>{}),error=>error.status===400&&error.details.length>0);
  }
});
test('PostgreSQL service request API and capacity concurrency', {skip:process.env.AUTH_TEST_POSTGRES!=='true'},async t=>{
  const pool=require('../src/config/database');
  const schema='test_requests_'+randomUUID().replaceAll('-','');
  // Clone live table definitions into a unique, disposable test namespace.
  // No production rows are copied or modified.
  await pool.query('CREATE SCHEMA '+schema);
  const scoped={
    async connect(){const c=await pool.connect();try{await c.query("SELECT set_config('search_path',$1,false)",[schema+',public']);}catch(e){c.release();throw e;}
      return {query:(sql,values)=>c.query(sql,values),release:()=>{c.release();}};},
    async query(sql,values){const c=await this.connect();try{return await c.query(sql,values);}finally{c.release();}},
  };
  try{
    for(const table of ['users','roles','user_roles','vendors','airports','terminals','service_types','capacity_slots','service_requests','request_status_history','auth_sessions','gros','assignments']){
      await pool.query('CREATE TABLE '+schema+'.'+table+' (LIKE public.'+table+' INCLUDING ALL)');
    }
    await scoped.query('CREATE SEQUENCE '+schema+'.trip_id_sequence');
    const airport=randomUUID(),type=randomUUID(),slot=randomUUID();
    await scoped.query("INSERT INTO airports(id,airport_code,airport_name,city,timezone) VALUES($1,'TST','Test','Test','Asia/Kolkata')",[airport]);
    await scoped.query("INSERT INTO terminals(airport_id,terminal_code) VALUES($1,'T1')",[airport]);
    await scoped.query("INSERT INTO service_types(id,code,name) VALUES($1,'TEST_SERVICE','Test service')",[type]);
    await scoped.query("INSERT INTO capacity_slots(id,airport_id,service_type_id,slot_date,window_start,window_end,total_capacity) VALUES($1,$2,$3,'2099-01-01','11:00','13:00',20)",[slot,airport,type]);
    const config=loadConfig({JWT_ACCESS_SECRET:randomUUID(),JWT_REFRESH_SECRET:randomUUID()});
    const auth=new AuthService(new AuthRepository(scoped),config);
    const passwordHash=await bcrypt.hash('test-password-123',4);
    const tokens={};
    for(const [key,role] of [['customer','CUSTOMER'],['other','CUSTOMER'],['vendor','VENDOR'],['otherVendor','VENDOR'],['gro','GRO'],['ops','OPERATIONS']]){
      const id=randomUUID(),email=key+'@example.test',vendor=role==='VENDOR'?randomUUID():null;
      if(vendor)await scoped.query('INSERT INTO vendors(id,vendor_code,vendor_name) VALUES($1,$2,$2)',[vendor,key]);
      await scoped.query('INSERT INTO users(id,email,first_name,last_name,password_hash,vendor_id) VALUES($1,$2,$3,$3,$4,$5)',[id,email,key,passwordHash,vendor]);
      await scoped.query('INSERT INTO roles(code,name) VALUES($1,$1) ON CONFLICT(code) DO NOTHING',[role]);
      await scoped.query('INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code=$2',[id,role]);
      tokens[key]=await auth.login({email,password:'test-password-123',role});
    }
    const repository=new ServiceRequestRepository(scoped);
    const app=createApp({service:auth,config,requestService:new ServiceRequestService(repository),reportsService:new ReportsService(new ReportsRepository(scoped))});
    const api='/api/v1/service-requests';
    const post=(body,key='customer')=>request(app).post(api).set('Authorization','Bearer '+tokens[key].accessToken).send(body);
    const get=(path,key='customer')=>request(app).get(api+path).set('Authorization','Bearer '+tokens[key].accessToken);
    await t.test('requires an access token and permitted role',async()=>{
      await request(app).post(api).send(input()).expect(401);
      await request(app).get(api).set('Authorization','Bearer '+tokens.customer.refreshToken).expect(401);
      await post(input(),'gro').expect(403);
      await post({...input(),sourceChannel:'VENDOR_PORTAL'}).expect(403);
    });
    let tripId;
    await t.test('creates a confirmed request, reserves passenger count, and saves timeline',async()=>{
      const body=input();body.passenger.count=2;
      const r=await post(body).expect(201);tripId=r.body.tripId;
      assert.equal(r.body.status,'CONFIRMED');
      assert.equal(r.body.flightDate,'2099-01-01');
      assert.equal((await scoped.query('SELECT reserved_capacity FROM capacity_slots WHERE id=$1',[slot])).rows[0].reserved_capacity,2);
      await post(body).expect(409);
      const history=await get('/'+tripId+'/timeline').expect(200);
      assert.deepEqual(history.body.items.map(x=>x.toStatus),['RECEIVED','VALIDATING','CAPACITY_CHECK','CAPACITY_RESERVED','CONFIRMED']);
    });
    await t.test('isolates customers and vendors on detail, list and timeline',async()=>{
      await get('/'+tripId,'other').expect(404);
      await get('/'+tripId+'/timeline','other').expect(404);
      assert.equal((await get('','other')).body.pagination.total,0);
      const r=await post({...input(),sourceChannel:'VENDOR_PORTAL'},'vendor').expect(201);
      await get('/'+r.body.tripId,'otherVendor').expect(404);
      await get('/'+r.body.tripId+'/timeline','otherVendor').expect(404);
      assert.equal((await get('','otherVendor')).body.pagination.total,0);
      await get('/'+r.body.tripId,'ops').expect(200);
    });
    await t.test('returns field errors and rejects unknown reference data or past dates',async()=>{
      const bad=await post({...input(),passenger:{name:'Test',count:0}}).expect(400);assert.ok(bad.body.details.length);
      for(const changes of [{airportCode:'UNKNOWN'},{terminal:'T9'},{serviceType:'UNKNOWN'},{flightDate:'2000-01-01'}])await post({...input(),...changes}).expect(422);
    });
    await t.test('records a business rejection when no capacity slot matches',async()=>{
      const r=await post({...input(),flightTime:'18:00'}).expect(201);
      assert.equal(r.body.status,'REJECTED');assert.equal(r.body.rejection.code,'SLOT_NOT_CONFIGURED');
      const h=await get('/'+r.body.tripId+'/timeline').expect(200);
      assert.equal(h.body.items.at(-1).toStatus,'REJECTED');
    });
    await t.test('two requests competing for the last unit cannot overbook',async()=>{
      await scoped.query('UPDATE capacity_slots SET total_capacity=reserved_capacity+1 WHERE id=$1',[slot]);
      const responses=await Promise.all([post(input()),post(input())]);
      assert.ok(responses.every(r=>r.status===201));
      assert.deepEqual(responses.map(r=>r.body.status).sort(),['CONFIRMED','REJECTED']);
      assert.equal(responses.find(r=>r.body.status==='REJECTED').body.rejection.code,'SLOT_NO_CAPACITY');
      const s=(await scoped.query('SELECT * FROM capacity_slots WHERE id=$1',[slot])).rows[0];
      assert.equal(s.reserved_capacity,s.total_capacity);
    });
    await t.test('concurrent duplicate submissions create exactly one record',async()=>{
      const body=input();const results=await Promise.all([post(body),post(body)]);
      assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
    });
    await t.test('failure after reservation rolls back capacity and request',async()=>{
      await scoped.query('UPDATE capacity_slots SET total_capacity=reserved_capacity+2 WHERE id=$1',[slot]);
      const before=(await scoped.query('SELECT reserved_capacity FROM capacity_slots WHERE id=$1',[slot])).rows[0].reserved_capacity;
      class FailingRepository extends ServiceRequestRepository {async insert(...args){await super.insert(...args);throw new Error('Simulated history/write failure');}}
      const broken=createApp({service:auth,config,requestService:new ServiceRequestService(new FailingRepository(scoped))});
      const body=input();
      await request(broken).post(api).set('Authorization','Bearer '+tokens.customer.accessToken).send(body).expect(500);
      assert.equal((await scoped.query('SELECT reserved_capacity FROM capacity_slots WHERE id=$1',[slot])).rows[0].reserved_capacity,before);
      assert.equal((await scoped.query('SELECT id FROM service_requests WHERE source_booking_reference=$1',[body.sourceBookingReference])).rowCount,0);
    });
    await t.test('reports aggregate real data, enforce tenant scope, and validate filters',async()=>{
      const vendor=(await scoped.query("SELECT id FROM vendors WHERE vendor_code='vendor'")).rows[0].id;
      const otherVendor=(await scoped.query("SELECT id FROM vendors WHERE vendor_code='otherVendor'")).rows[0].id;
      const ids=[randomUUID(),randomUUID(),randomUUID()];
      for(let i=0;i<3;i++)await scoped.query("INSERT INTO service_requests(id,trip_id,vendor_id,source_channel,source_booking_reference,passenger_name,passenger_count,email,airport_id,flight_number,flight_date,movement_type,service_type_id,status) VALUES($1,$2,$3,'VENDOR_PORTAL',$2,'Report Test',$4,'test@example.test',$5,'AI302','2098-01-01','ARRIVAL',$6,$7)",
        [ids[i],'REPORT-'+ids[i],i===2?otherVendor:vendor,i+1,airport,type,i===1?'REJECTED':'COMPLETED']);
      const gro=randomUUID(),idle=randomUUID();
      for(const id of [gro,idle])await scoped.query("INSERT INTO gros(id,gro_code,airport_id,full_name) VALUES($1,$2,$3,'Report GRO')",[id,id,airport]);
      await scoped.query("INSERT INTO assignments(service_request_id,gro_id,allocation_attempt,status,started_at,completed_at) VALUES($1,$3,1,'REJECTED',NULL,NULL),($1,$3,2,'COMPLETED','2098-01-01 10:00Z','2098-01-01 10:30Z'),($2,$3,1,'COMPLETED',NULL,NULL)",[ids[0],ids[2],gro]);
      const base='/api/v1/reports/';
      const report=(kind,key='ops',extra='')=>request(app).get(base+kind+'?from=2098-01-01&to=2098-01-01'+extra).set('Authorization','Bearer '+tokens[key].accessToken);
      await request(app).get(base+'service-overview').expect(401);
      await report('service-overview','gro').expect(403);
      await report('service-overview','customer').expect(403);
      await report('gro-utilization','vendor').expect(403);
      await report('vendor-analysis','vendor','&vendorId='+otherVendor).expect(403);
      const overview=(await report('service-overview','ops','&pageSize=1').expect(200)).body;
      assert.equal(overview.summary.totalRequests,3);assert.equal(overview.summary.totalPassengers,6);
      assert.equal(overview.summary.completed,2);assert.equal(overview.items.length,1);assert.equal(overview.pagination.total,3);
      const own=(await report('service-overview','vendor').expect(200)).body;
      assert.equal(own.summary.totalRequests,2);assert.ok(own.items.every(x=>x.vendorId===vendor));
      const vendors=(await report('vendor-analysis','vendor').expect(200)).body;
      assert.equal(vendors.items.length,1);assert.equal(vendors.items[0].vendorId,vendor);
      assert.equal(vendors.items[0].totalRequests,2);assert.equal(vendors.items[0].completionRate,50);
      const utilization=(await report('gro-utilization').expect(200)).body;
      assert.equal(utilization.summary.totalGros,2);assert.equal(utilization.summary.totalAssignments,3);
      const busy=utilization.items.find(x=>x.groId===gro);
      assert.equal(busy.uniqueRequests,2);assert.equal(busy.completed,2);assert.equal(busy.acceptanceRate,66.67);
      assert.equal(busy.recordedServiceMinutes,30);assert.equal(busy.averageServiceMinutes,30);assert.equal(busy.timedCompletions,1);
      assert.equal(utilization.items.find(x=>x.groId===idle).averageServiceMinutes,null);
      const filtered=(await report('gro-utilization','ops','&vendorId='+vendor+'&airportCode=TST&serviceType=TEST_SERVICE').expect(200)).body;
      assert.equal(filtered.summary.totalAssignments,2);
      const empty=(await report('service-overview','ops','&airportCode=NONE').expect(200)).body;
      assert.equal(empty.summary.totalRequests,0);assert.deepEqual(empty.items,[]);
      for(const query of ['from=2098-02-30','from=2099-01-01&to=2098-01-01','vendorId=invalid','pageSize=101','from=x&from=y']){
        await request(app).get(base+'service-overview?'+query).set('Authorization','Bearer '+tokens.ops.accessToken).expect(400);
      }
    });
    await t.test('pagination, filters, and revoked access tokens',async()=>{
      const r=await get('?page=1&pageSize=1&status=CONFIRMED').expect(200);assert.equal(r.body.items.length,1);
      await get('?pageSize=101').expect(400);
      await auth.logout(tokens.customer.refreshToken,'refresh');
      await get('').expect(401);
    });
  }finally{
    await pool.query('DROP SCHEMA '+schema+' CASCADE');
    await pool.end();
  }
});

