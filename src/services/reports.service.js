const { ApiError }=require('../utils/errors');
class ReportsService {
  constructor(repository){this.repo=repository;}
  scope(user,kind,filters) {
    if(!user)throw new ApiError(401,'UNAUTHORIZED','Authentication required');
    if(['OPERATIONS','PLATFORM_ADMIN'].includes(user.role))return {...filters};
    if(user.role!=='VENDOR'||kind==='gro-utilization')throw new ApiError(403,'FORBIDDEN','Role not permitted for this report');
    if(!user.vendorId)throw new ApiError(403,'FORBIDDEN','Vendor account has no tenant');
    if(filters.vendorId&&filters.vendorId!==user.vendorId.toLowerCase())throw new ApiError(403,'FORBIDDEN','Cannot report on another vendor');
    return {...filters,vendorId:user.vendorId};
  }
  async get(user,kind,filters) {
    const scoped=this.scope(user,kind,filters);
    const result=await this.repo.report(kind,scoped);
    return {report:kind,filters:scoped,dateBasis:'flightDate',...result,
      pagination:{page:scoped.page,pageSize:scoped.pageSize,total:result.total,totalPages:Math.ceil(result.total/scoped.pageSize)}};
  }
}
module.exports={ReportsService};

