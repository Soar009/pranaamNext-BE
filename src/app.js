const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { randomUUID } = require('node:crypto');
const { ApiError } = require('./utils/errors');
const { authRoutes } = require('./routes/auth.routes');
function createApp({ service, config, pool }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => { req.correlationId = randomUUID(); res.set('X-Correlation-ID', req.correlationId); next(); });
  // Explicit origin allowlist also protects cookie-authenticated mutations from CSRF.
  app.use((req, res, next) => {
    const origin = req.get('Origin');
    if ((origin && !config.origins.includes(origin)) ||
        (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('Sec-Fetch-Site') === 'cross-site' && !origin)) {
      throw new ApiError(403, 'FORBIDDEN', 'Origin not allowed');
    }
    next();
  });
  app.use(cors({ origin: config.origins, credentials: true }));
  app.use(express.json({ limit: '16kb' }));
  app.use(cookieParser());
  const routes = authRoutes(service, config);
  app.use('/api/v1/auth', routes);
  // Exact endpoint aliases requested by clients.
  app.use('/', routes);
  if (pool) app.get('/api/data', async (req, res) => {
    const result = await pool.query('SELECT * FROM your_table LIMIT 10');
    res.json(result.rows);
  });
  app.use((req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'Endpoint not found' }));
  app.use((err, req, res, next) => {
    const status = err instanceof ApiError ? err.status : err.type === 'entity.parse.failed' ? 400 : err.type === 'entity.too.large' ? 413 : 500;
    res.status(status).json({ code: err instanceof ApiError ? err.code : status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST',
      message: status === 500 ? 'Internal server error' : err instanceof ApiError ? err.message : 'Invalid request body',
      details: null, correlationId: req.correlationId });
  });
  return app;
}
module.exports = { createApp };
