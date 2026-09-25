const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { authController } = require('../controllers/auth.controller');
const { validateLogin } = require('../middleware/validation.middleware');
const { authenticate } = require('../middleware/auth.middleware');

function authRoutes(service, config) {
  const router = express.Router();
  const controller = authController(service, config);
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { code: 'RATE_LIMITED', message: 'Too many authentication attempts; try again later' } });
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.post('/login', limiter, validateLogin, controller.login);
  router.post('/refresh', limiter, controller.refresh);
  router.post('/logout', controller.logout);
  router.get('/me', authenticate(service), controller.me);
  
  return router;
}

module.exports = { authRoutes };
