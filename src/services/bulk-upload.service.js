const { ApiError } = require('../utils/errors');
const { RequestIntakeService } = require('./request-intake.service');
const invalid = message => { throw new ApiError(400,'VALIDATION_FAILED',message); };
const missing = () => { throw new ApiError(404,'NOT_FOUND','Batch not found'); };
const MAX_ROWS = 1000;
function batchId(id) { if (typeof id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) invalid('Invalid batch ID'); return id; }
function number(value, fallback, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || Number(value)>max) invalid('Invalid pagination');
  return Number(value);
}
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"','""') + '"';
}
class BulkUploadService {
  constructor(repo, intake = new RequestIntakeService()) { this.repo = repo; this.intake = intake; }
  async summary(user,id) { const result = await this.repo.summary(batchId(id),user.vendorId); if (!result) missing(); return result; }
  async items(user,id,query) {
    if (Object.keys(query).some(k=>!['validationStatus','page','pageSize'].includes(k))) invalid('Unsupported query parameter');
    const page = number(query.page,1,100000), pageSize = number(query.pageSize,20,100);
    let statuses = null;
    if (query.validationStatus !== undefined) {
      if (typeof query.validationStatus !== 'string') invalid('Invalid validationStatus');
      statuses = query.validationStatus.split(',');
      if (!statuses.length || statuses.some(s=>!['VALID','INVALID','DUPLICATE','SUBMITTED','FAILED'].includes(s))) invalid('Invalid validationStatus');
    }
    await this.summary(user,id);
    const result = await this.repo.items(id,user.vendorId,statuses,pageSize,(page-1)*pageSize);
    return { items: result.items, pagination: { page,pageSize,total:result.total,totalPages:Math.ceil(result.total/pageSize) } };
  }
  async download(user,id) {
    await this.summary(user,id);
    const { items,total } = await this.repo.items(id,user.vendorId,['INVALID','DUPLICATE','FAILED'],MAX_ROWS,0);
    if (total > MAX_ROWS) throw new ApiError(409,'BATCH_TOO_LARGE','Maximum supported batch size is 1000 rows');
    const keys = ['rowNumber','passengerName','flightNumber','serviceType','validationStatus','reasonCode','reasonMessage'];
    return [keys.map(csvCell).join(','),...items.map(item=>keys.map(k=>csvCell(item[k])).join(','))].join('\r\n')+'\r\n';
  }
  async submit(user,id,body) {
    batchId(id);
    if (body != null && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)) invalid('Submit takes an empty body; rows come from stored validation');
    return this.repo.transaction(async tx=>{
      const batch = await tx.lockBatch(id,user.vendorId);
      if (!batch) missing();
      if (batch.submission_result) return batch.submission_result;
      if (batch.status !== 'VALIDATED') throw new ApiError(409,'BATCH_NOT_READY','Batch must be validated before submission');
      const rows = await tx.rows(id);
      if (rows.length>MAX_ROWS) throw new ApiError(409,'BATCH_TOO_LARGE','Maximum supported batch size is 1000 rows');
      if (!rows.some(r=>r.validation_status==='VALID')) throw new ApiError(409,'NO_VALID_ROWS','Batch has no valid rows to submit');
      if (rows.some(r=>!['VALID','INVALID','DUPLICATE'].includes(r.validation_status))) throw new ApiError(409,'BATCH_NOT_READY','Batch contains already processed rows');
      let submittedRows=0, skippedRows=0, failedRows=0;
      for (const row of rows) {
        if (row.validation_status!=='VALID') { skippedRows++; continue; }
        let requestId;
        try { requestId = await this.intake.receive(tx,user,row); }
        catch (e) {
          if (!(e instanceof ApiError)) throw e;
          await tx.mark(row.id,'FAILED',null,e.code,e.message);
          failedRows++; continue;
        }
        if (requestId) { await tx.mark(row.id,'SUBMITTED',requestId,null,null); submittedRows++; }
        else { await tx.mark(row.id,'DUPLICATE',null,'DUPLICATE_REQUEST','Source booking reference already exists'); skippedRows++; }
      }
      const status = submittedRows ? (skippedRows || failedRows ? 'PARTIAL_SUCCESS' : 'COMPLETED') : 'FAILED';
      const result = { batchId:id,status,totalRows:rows.length,submittedRows,skippedRows,failedRows,requestStatus:'RECEIVED' };
      await tx.finish(id,result);
      return result;
    });
  }
}
module.exports = { BulkUploadService, csvCell };
