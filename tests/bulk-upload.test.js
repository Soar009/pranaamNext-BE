const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { BulkUploadService } = require('../src/services/bulk-upload.service');
const { RequestIntakeService } = require('../src/services/request-intake.service');
const { BulkUploadRepository } = require('../src/repositories/bulk-upload.repository');
const { ApiError } = require('../src/utils/errors');
const id='11111111-1111-4111-8111-111111111111';
const root='/api/v1/bulk-uploads/'+id;
function fixture() {
  const user={id,role:'VENDOR',vendorId:'vendor-a'};
  const batch={status:'VALIDATED',submission_result:null};
  const state={rows:[{id:'1',validation_status:'VALID'},{id:'2',validation_status:'INVALID'}],received:0,marks:[],owner:'vendor-a'};
  const tx={
    lockBatch:async (key,vendor)=> vendor===state.owner ? batch : undefined,
    rows:async()=>state.rows,
    mark:async(...args)=>state.marks.push(args),
    finish:async(key,result)=>{batch.submission_result=result;batch.status=result.status;},
  };
  const repo={
    summary:async(key,vendor)=>vendor===state.owner?{batchId:key,totalRows:2}:undefined,
    items:async(key,vendor,statuses,limit,offset)=>{assert.equal(vendor,state.owner);return {total:1,items:[{rowNumber:2,passengerName:'=SUM(1,2)',reasonMessage:'Missing "flight"\nnumber'}]};},
    transaction:async fn=>fn(tx),
  };
  const intake={receive:async()=>{state.received++;return id;}};
  const service=new BulkUploadService(repo,intake);
  const auth={authenticate:async token=>{if(token!=='valid')throw new ApiError(401,'UNAUTHORIZED','Authentication required');return user;}};
  const app=createApp({service:auth,config:{origins:[]},bulkUploadService:service});
  return {user,batch,state,repo,intake,service,app,get:path=>request(app).get(path).set('Authorization','Bearer valid'),post:()=>request(app).post(root+'/submit').set('Authorization','Bearer valid')};
}
test('review summary and paginated error list',async()=>{
  const f=fixture();
  await f.get(root).expect(200);
  const res=await f.get(root+'/items?validationStatus=INVALID,DUPLICATE&page=1&pageSize=20').expect(200);
  assert.equal(res.body.pagination.total,1);
  assert.equal(res.headers['cache-control'],'no-store');
  await f.get(root+'/items?pageSize=101').expect(400);
  await f.get(root+'/items?validationStatus=BOGUS').expect(400);
  await f.get(root+'/items?vendorId=vendor-b').expect(400);
  await f.get('/api/v1/bulk-uploads/not-uuid').expect(400);
});
test('CSV download escapes formulas, quotes and newlines',async()=>{
  const f=fixture();
  const res=await f.get(root+'/errors/download').expect(200);
  assert.match(res.headers['content-type'],/text\/csv/);
  assert.match(res.headers['content-disposition'],/attachment/);
  assert.ok(res.text.includes('"\'=SUM(1,2)"'));
  assert.ok(res.text.includes('"Missing ""flight""\nnumber"'));
});
test('all four endpoints reject anonymous, wrong-role and cross-vendor access',async()=>{
  for(const suffix of ['', '/items','/errors/download','/submit']) {
    const f=fixture();
    const call=()=>suffix==='/submit'?f.post():f.get(root+suffix);
    await (suffix==='/submit'?request(f.app).post(root+suffix):request(f.app).get(root+suffix)).expect(401);
    f.user.role='OPERATIONS';await call().expect(403);
    f.user.role='VENDOR';f.user.vendorId='vendor-b';await call().expect(404);
    f.user.vendorId=null;await call().expect(403);
    assert.equal(f.state.received,0);
  }
});
test('submit only valid rows, skip invalid rows, replay stored result',async()=>{
  const f=fixture();
  const first=await f.post().send({}).expect(200);
  assert.deepEqual(first.body,{batchId:id,status:'PARTIAL_SUCCESS',totalRows:2,submittedRows:1,skippedRows:1,failedRows:0,requestStatus:'RECEIVED'});
  const second=await f.post().expect(200);
  assert.deepEqual(second.body,first.body);
  assert.equal(f.state.received,1);
  assert.equal(f.state.marks[0][1],'SUBMITTED');
});
test('reject unvalidated, oversized, empty-valid and client-supplied rows',async()=>{
  const f=fixture();
  await f.post().send({rows:[]}).expect(400);
  f.batch.status='UPLOADED';await f.post().expect(409);
  f.batch.status='VALIDATED';f.state.rows=[];await f.post().expect(409);
  f.state.rows=Array(1001).fill({validation_status:'VALID'});await f.post().expect(409);
  assert.equal(f.state.received,0);
});
test('duplicates and business failures are counted separately',async()=>{
  const f=fixture();
  f.state.rows=[{id:'1',validation_status:'VALID'},{id:'2',validation_status:'VALID'}];
  let attempt=0;f.intake.receive=async()=>{if(attempt++===0)return null;throw new ApiError(400,'INVALID_REQUEST','Invalid flight');};
  const res=await f.post().expect(200);
  assert.equal(res.body.skippedRows,1);assert.equal(res.body.failedRows,1);assert.equal(res.body.submittedRows,0);
  assert.deepEqual(f.state.marks.map(m=>m[1]),['DUPLICATE','FAILED']);
});
test('database failures propagate and transaction rolls back',async()=>{
  const calls=[];
  const repo=new BulkUploadRepository({connect:async()=>({query:async sql=>calls.push(sql),release:()=>calls.push('release')})});
  await assert.rejects(repo.transaction(async()=>{throw new Error('database failed');}),/database failed/);
  assert.deepEqual(calls,['BEGIN','ROLLBACK','release']);
  const f=fixture();f.intake.receive=async()=>{throw new Error('private SQL');};
  const res=await f.post().expect(500);assert.equal(res.body.message,'Internal server error');
  assert.equal(f.batch.submission_result,null);
});
test('intake revalidates stored payload and records RECEIVED history only after insert',async()=>{
  const intake=new RequestIntakeService();const events=[];
  const tx={airport:async()=>({id}),serviceType:async()=>({id}),insertRequest:async r=>{events.push(r);return true;},history:async(...args)=>events.push(args)};
  const row={source_booking_reference:'REF-1',raw_payload:{passengerName:'Test',passengerCount:1,airportCode:'BOM',serviceType:'MEET_GREET',flightNumber:'AI302',flightDate:'2026-09-25',movementType:'ARRIVAL',email:'test@example.com'}};
  await intake.receive(tx,{id,vendorId:'v'},row);
  assert.equal(events.length,2);assert.ok(events[0].tripId.length<=50);
  tx.insertRequest=async()=>false;events.length=0;
  assert.equal(await intake.receive(tx,{id,vendorId:'v'},row),null);assert.equal(events.length,0);
  row.raw_payload.flightDate='2026-02-30';await assert.rejects(intake.receive(tx,{id,vendorId:'v'},row),/flightDate/);
});
