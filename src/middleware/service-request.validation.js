const { ApiError } = require('../utils/errors');
const { isValidEmail } = require('../utils/email');
const statuses = ['RECEIVED','VALIDATING','CAPACITY_CHECK','CAPACITY_RESERVED','CONFIRMED','WAITLISTED','REJECTED','GRO_ASSIGNED','IN_PROGRESS','COMPLETED','FAILED','ALLOCATION_PENDING'];
function invalid(errors) {
  const error = new ApiError(400, 'VALIDATION_FAILED', 'Service request validation failed');
  error.details = errors;
  throw error;
}
function validateCreate(req, res, next) {
  const body = req.body;
  const errors = [];
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(body)) invalid([{ field: 'body', message: 'A JSON object is required' }]);
  const allowed = ['sourceChannel','sourceBookingReference','passenger','airportCode','terminal','flightNumber','flightDate','flightTime','movementType','serviceType','specialRequirements','additionalNotes'];
  for (const key of Object.keys(body)) if (!allowed.includes(key)) errors.push({ field: key, message: 'Unsupported or server-controlled field' });
  const str = (value, field, max, required = true) => {
    if (value === undefined && !required) return null;
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
      errors.push({ field, message: 'Must be a nonempty string of at most ' + max + ' characters' }); return null;
    }
    return value.trim();
  };
  const p = object(body.passenger) ? body.passenger : {};
  if (!object(body.passenger)) errors.push({ field: 'passenger', message: 'Passenger object is required' });
  for (const key of Object.keys(p)) if (!['name','count','mobile','email','preferredLanguage','category'].includes(key)) errors.push({field:'passenger.'+key,message:'Unsupported field'});
  const data = {
    sourceChannel: str(body.sourceChannel,'sourceChannel',50),
    sourceBookingReference: str(body.sourceBookingReference,'sourceBookingReference',100),
    airportCode: str(body.airportCode,'airportCode',10),
    terminal: str(body.terminal,'terminal',20,false),
    flightNumber: str(body.flightNumber,'flightNumber',30),
    flightDate: str(body.flightDate,'flightDate',10),
    flightTime: str(body.flightTime,'flightTime',5),
    movementType: str(body.movementType,'movementType',30),
    serviceType: str(body.serviceType,'serviceType',50),
    specialRequirements: str(body.specialRequirements,'specialRequirements',5000,false),
    additionalNotes: str(body.additionalNotes,'additionalNotes',5000,false),
    passenger: { name: str(p.name,'passenger.name',200), count:p.count,
      mobile: str(p.mobile,'passenger.mobile',30,false), email:str(p.email,'passenger.email',255,false),
      preferredLanguage:str(p.preferredLanguage,'passenger.preferredLanguage',10,false), category:str(p.category,'passenger.category',50,false) },
  };
  if (!Number.isInteger(p.count) || p.count < 1 || p.count > 2147483647) errors.push({field:'passenger.count',message:'Must be a positive integer'});
  if (!data.passenger.mobile && !data.passenger.email) errors.push({field:'passenger',message:'Mobile or email is required'});
  if (data.passenger.email && !isValidEmail(data.passenger.email)) errors.push({field:'passenger.email',message:'Invalid email'});
  if (data.passenger.mobile && !/^\+?[0-9 ()-]{7,30}$/.test(data.passenger.mobile)) errors.push({field:'passenger.mobile',message:'Invalid phone number'});
  if (!['VENDOR_PORTAL','CUSTOMER_PORTAL','OPERATIONS','EXTERNAL_API','BULK_UPLOAD'].includes(data.sourceChannel)) errors.push({field:'sourceChannel',message:'Unsupported source channel'});
  if (!['ARRIVAL','DEPARTURE','TRANSFER'].includes(data.movementType)) errors.push({field:'movementType',message:'Use ARRIVAL, DEPARTURE, or TRANSFER'});
  if (data.flightDate && (!/^\d{4}-\d{2}-\d{2}$/.test(data.flightDate) || !Number.isFinite(Date.parse(data.flightDate)) || new Date(data.flightDate).toISOString().slice(0,10) !== data.flightDate)) errors.push({field:'flightDate',message:'Use a valid YYYY-MM-DD date'});
  if (data.flightTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.flightTime)) errors.push({field:'flightTime',message:'Use HH:mm (24-hour airport-local time)'});
  if (data.flightNumber && !/^[A-Z0-9]{2,3}\s?\d{1,4}[A-Z]?$/.test(data.flightNumber.toUpperCase())) errors.push({field:'flightNumber',message:'Invalid flight number format'});
  if (errors.length) invalid(errors);
  data.airportCode = data.airportCode.toUpperCase();
  data.flightNumber = data.flightNumber.toUpperCase().replace(/\s/g,'');
  data.serviceType = data.serviceType.toUpperCase();
  req.input = data;
  next();
}
function validateList(req,res,next) {
  const errors=[];
  const integer = (key, fallback, max) => {
    const value=req.query[key] ?? String(fallback);
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value)>max) {
      errors.push({field:key,message:'Invalid pagination value'}); return fallback;
    }
    return Number(value);
  };
  const page=integer('page',1,1000000), pageSize=integer('pageSize',20,100);
  const status=req.query.status, airportCode=req.query.airportCode;
  if (status !== undefined && !statuses.includes(status)) errors.push({field:'status',message:'Unsupported status'});
  if (airportCode !== undefined && (typeof airportCode !== 'string' || !/^[A-Za-z0-9]{2,10}$/.test(airportCode))) errors.push({field:'airportCode',message:'Invalid airport code'});
  if (errors.length) invalid(errors);
  req.input={page,pageSize,status,airportCode:airportCode?.toUpperCase()};
  next();
}
function validateTrip(req,res,next) {
  if (!/^PRN-[A-Z0-9]{2,10}-\d{8}-\d+$/.test(req.params.tripId)) invalid([{field:'tripId',message:'Invalid Trip ID'}]);
  next();
}
module.exports={validateCreate,validateList,validateTrip};

