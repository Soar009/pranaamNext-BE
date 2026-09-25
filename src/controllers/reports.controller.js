function reportsController(service,kind) {
  return async(req,res)=>res.json(await service.get(req.user,kind,req.reportFilters));
}
module.exports={reportsController};

