const { Router } = require('express');
const { authenticate, authorize } = require('../middleware/auth.middleware');
function operationsRoutes(authService, operations) {
  const router = Router();
  router.get('/dashboard/operations', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); },
    authenticate(authService), authorize('OPERATIONS', 'AIRPORT_ADMIN', 'PLATFORM_ADMIN'),
    async (req, res) => res.json(await operations.dashboard(req.user, req.query)));
  return router;
}
module.exports = { operationsRoutes };
