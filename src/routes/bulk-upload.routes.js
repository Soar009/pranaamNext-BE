const { Router } = require('express');
const { authenticate, authorize } = require('../middleware/auth.middleware');
const { ApiError } = require('../utils/errors');
function bulkUploadRoutes(auth,service) {
  const router = Router();
  router.use((req,res,next)=>{res.set('Cache-Control','no-store'); next();},authenticate(auth),authorize('VENDOR'),(req,res,next)=>{
    if (!req.user.vendorId) throw new ApiError(403,'FORBIDDEN','Vendor membership required'); next();
  });
  router.get('/:batchId',async(req,res)=>res.json(await service.summary(req.user,req.params.batchId)));
  router.get('/:batchId/items',async(req,res)=>res.json(await service.items(req.user,req.params.batchId,req.query)));
  router.get('/:batchId/errors/download',async(req,res)=>{
    const csv = await service.download(req.user,req.params.batchId);
    res.set('X-Content-Type-Options','nosniff').attachment(`bulk-${req.params.batchId}-errors.csv`).type('text/csv').send(csv);
  });
  router.post('/:batchId/submit',async(req,res)=>{
    if (Object.keys(req.query).length) throw new ApiError(400,'VALIDATION_FAILED','Submit does not accept query parameters');
    res.json(await service.submit(req.user,req.params.batchId,req.body));
  });
  return router;
}
module.exports = { bulkUploadRoutes };
