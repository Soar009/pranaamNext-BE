const { loadConfig } = require('./src/config/env');
const { createApp } = require('./src/app');
const { AuthRepository } = require('./src/repositories/auth.repository');
const { AuthService } = require('./src/services/auth.service');
const pool = require('./src/config/database');
const config = loadConfig();
const service = new AuthService(new AuthRepository(pool), config);
const app = createApp({ service, config, pool });
const server = app.listen(process.env.PORT || 3000, () => console.log('Pranaam API is running'));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => pool.end()));
}
