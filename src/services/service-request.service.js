const { ApiError }=require('../utils/errors');
const allowedRoles=['VENDOR','CUSTOMER','OPERATIONS','PLATFORM_ADMIN'];
function dto(row) {
  return {tripId:row.trip_id,status:row.status,sourceChannel:row.source_channel,sourceBookingReference:row.source_booking_reference,
    passenger:{name:row.passenger_name,count:row.passenger_count,mobile:row.mobile,email:row.email,preferredLanguage:row.preferred_language,category:row.passenger_category},
    airportCode:row.airport_code,terminal:row.terminal_code,flightNumber:row.flight_number,
    flightDate:row.flight_date instanceof Date?row.flight_date.toLocaleDateString('en-CA'):row.flight_date,
    flightTime:row.flight_time,movementType:row.movement_type,serviceType:row.service_type,
    specialRequirements:row.special_requirements,additionalNotes:row.additional_notes,
    rejection:row.rejection_reason_code?{code:row.rejection_reason_code,message:row.rejection_reason_message}:null,
    createdAt:row.created_at,confirmedAt:row.confirmed_at};
}
class ServiceRequestService {
  constructor(repository){this.repo=repository;}
  checkUser(user) {
    if(!user || !allowedRoles.includes(user.role)) throw new ApiError(403,'FORBIDDEN','Role not permitted for service request intake');
    if(user.role==='VENDOR'&&!user.vendorId)throw new ApiError(403,'FORBIDDEN','Vendor account has no tenant');
  }
  async create(user,data) {
    this.checkUser(user);
    const channels={VENDOR:['VENDOR_PORTAL','EXTERNAL_API','BULK_UPLOAD'],CUSTOMER:['CUSTOMER_PORTAL'],OPERATIONS:['OPERATIONS','EXTERNAL_API','BULK_UPLOAD'],PLATFORM_ADMIN:['OPERATIONS','EXTERNAL_API','BULK_UPLOAD']};
    if(!channels[user.role].includes(data.sourceChannel))throw new ApiError(403,'FORBIDDEN','Source channel is not permitted for this role');
    try {
      return await this.repo.transaction(async client=>{
        await this.repo.lockIdentity(client,user,data.sourceBookingReference);
        const duplicate=await this.repo.duplicate(client,user,data.sourceBookingReference);
        if(duplicate) throw new ApiError(409,'DUPLICATE_REQUEST','Source booking reference already exists');
        const refs=await this.repo.references(client,data,user);
        if(user.role==='VENDOR'&&!refs.vendor)throw new ApiError(403,'FORBIDDEN','Vendor is not active');
        if(!refs.airport)throw new ApiError(422,'INVALID_AIRPORT','Airport is unknown or inactive');
        if(!refs.service)throw new ApiError(422,'SERVICE_NOT_SUPPORTED','Service type is unknown or inactive');
        if(data.terminal&&!refs.terminal)throw new ApiError(422,'INVALID_TERMINAL','Terminal must be active and belong to the airport');
        if(data.flightDate<refs.airport.local_today)throw new ApiError(422,'INVALID_FLIGHT_DATE','Flight date cannot precede today at the airport');
        const reservation=await this.repo.reserve(client,refs,data);
        return dto(await this.repo.insert(client,user,data,refs,reservation));
      });
    }catch(error){if(error.code==='23505')throw new ApiError(409,'DUPLICATE_REQUEST','Request conflicts with an existing booking');throw error;}
  }
  async get(user,tripId){this.checkUser(user);const row=await this.repo.get(user,tripId);if(!row)throw new ApiError(404,'NOT_FOUND','Service request not found');return dto(row);}
  async list(user,filter){this.checkUser(user);const {items,total}=await this.repo.list(user,filter);return {items:items.map(dto),pagination:{page:filter.page,pageSize:filter.pageSize,total,totalPages:Math.ceil(total/filter.pageSize)}};}
  async timeline(user,tripId){this.checkUser(user);const row=await this.repo.get(user,tripId);if(!row)throw new ApiError(404,'NOT_FOUND','Service request not found');return {tripId,items:await this.repo.timeline(row.id)};}
}
module.exports={ServiceRequestService};

