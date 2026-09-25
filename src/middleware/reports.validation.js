const { ApiError } = require('../utils/errors');
function validateReports(req,res,next) {
  const q=req.query, errors=[], filters={};
  const allowed=['from','to','airportCode','vendorId','serviceType','page','pageSize'];
  for(const key of Object.keys(q)) if(!allowed.includes(key)) errors.push({field:key,message:'Unsupported filter'});
  for(const key of ['from','to']) {
    if(q[key]===undefined) continue;
    const value=q[key];
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'0001-01-01'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value) errors.push({field:key,message:'Use a valid YYYY-MM-DD date'});
    else filters[key]=value;
  }
  if(filters.from&&filters.to&&filters.from>filters.to) errors.push({field:'to',message:'Must be on or after from'});
  for(const [key,pattern] of [['airportCode',/^[A-Za-z0-9]{2,10}$/],['serviceType',/^[A-Za-z0-9_]{1,50}$/],['vendorId',/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i]]) {
    if(q[key]===undefined)continue;
    if(typeof q[key]!=='string'||!pattern.test(q[key]))errors.push({field:key,message:'Invalid filter value'});
    else filters[key]=key==='vendorId'?q[key].toLowerCase():q[key].toUpperCase();
  }
  for(const [key,fallback,max] of [['page',1,1000000],['pageSize',20,100]]) {
    const value=q[key]??String(fallback);
    if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>max)errors.push({field:key,message:'Invalid pagination value'});
    else filters[key]=Number(value);
  }
  if(errors.length){const e=new ApiError(400,'VALIDATION_FAILED','Invalid report filters');e.details=errors;throw e;}
  req.reportFilters=filters;next();
}
module.exports={validateReports};

