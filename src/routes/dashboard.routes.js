const { Router } = require('express');
const { authenticate, authorize } = require('../middleware/auth.middleware');
const { ApiError } = require('../utils/errors');
function dashboardRoutes(authService, dashboard) {
  const router = Router();
  const guard = [authenticate(authService), authorize('VENDOR'), (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user.vendorId) throw new ApiError(403, 'FORBIDDEN', 'Vendor membership required');
    next();
  }];
  router.get('/dashboard/vendor', ...guard, async (req, res) => res.json(await dashboard.dashboard(req.user, req.query)));
  router.get('/airports', ...guard, async (req, res) => res.json({ items: await dashboard.airports(req.user) }));
  router.get('/service-requests', ...guard, async (req, res) => res.json(await dashboard.list(req.user, req.query)));
  router.get('/service-requests/:id', ...guard, async (req, res) => res.json(await dashboard.detail(req.user, req.params.id)));
  return router;
}
module.exports = { dashboardRoutes };
