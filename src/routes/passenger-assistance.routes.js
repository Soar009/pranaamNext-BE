const { Router } = require('express');
const { authenticate, authorize } = require('../middleware/auth.middleware');
const { ApiError } = require('../utils/errors');
function passengerAssistanceRoutes(auth,service) {
  const router = Router();
  router.get('/trips/:tripId/assistance', (req,res,next)=>{res.set('Cache-Control','no-store');next();},
    authenticate(auth),authorize('CUSTOMER'),async(req,res)=>{
      if (Object.keys(req.query).length) throw new ApiError(400,'VALIDATION_FAILED','Query parameters are not supported');
      res.json(await service.get(req.user,req.params.tripId));
    });
  return router;
}
module.exports = { passengerAssistanceRoutes };
