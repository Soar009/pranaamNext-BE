function serviceRequestController(service) {
  return {
    create:async(req,res)=>{const result=await service.create(req.user,req.input);res.location('/api/v1/service-requests/'+result.tripId).status(201).json(result);},
    list:async(req,res)=>res.json(await service.list(req.user,req.input)),
    get:async(req,res)=>res.json(await service.get(req.user,req.params.tripId)),
    timeline:async(req,res)=>res.json(await service.timeline(req.user,req.params.tripId)),
  };
}
module.exports={serviceRequestController};

