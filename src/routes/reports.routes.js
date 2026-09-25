const {Router}=require('express');
const {authenticate}=require('../middleware/auth.middleware');
const {validateReports}=require('../middleware/reports.validation');
const {reportsController}=require('../controllers/reports.controller');
function reportsRoutes(authService,service) {
  const router=Router();
  router.use(authenticate(authService));
  router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
  for(const kind of ['service-overview','gro-utilization','vendor-analysis']) {
    router.get('/'+kind,validateReports,reportsController(service,kind));
  }
  return router;
}
module.exports={reportsRoutes};

