const {Router}=require('express');
const {authenticate}=require('../middleware/auth.middleware');
const {validateCreate,validateList,validateTrip}=require('../middleware/service-request.validation');
const {serviceRequestController}=require('../controllers/service-request.controller');
function serviceRequestRoutes(authService,service) {
  const router=Router(),controller=serviceRequestController(service);
  router.use(authenticate(authService));
  router.use((req,res,next)=>{service.checkUser(req.user);res.set('Cache-Control','no-store');next();});
  router.post('/',validateCreate,controller.create);
  router.get('/',validateList,controller.list);
  router.get('/:tripId/timeline',validateTrip,controller.timeline);
  router.get('/:tripId',validateTrip,controller.get);
  return router;
}
module.exports={serviceRequestRoutes};

