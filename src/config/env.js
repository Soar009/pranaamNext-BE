require('dotenv').config();

function loadConfig(env = process.env) {
  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
    if (!env[key] || Buffer.byteLength(env[key]) < 32) throw new Error(key + ' must contain at least 32 bytes');
  }
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) throw new Error('JWT secrets must be different');
  const seconds = (key, fallback) => {
    const value = Number(env[key] || fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(key + ' must be positive seconds');
    return value;
  };
  const sameSite = env.COOKIE_SAME_SITE || 'lax';
  const secure = env.NODE_ENV === 'production' || env.COOKIE_SECURE === 'true';
  if (!['strict', 'lax', 'none'].includes(sameSite) || (sameSite === 'none' && !secure)) throw new Error('Invalid cookie configuration');
  const origins = (env.CORS_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim()).filter(Boolean);
  if (origins.includes('*')) throw new Error('CORS_ORIGINS must list explicit origins');
  return { accessSecret: env.JWT_ACCESS_SECRET, refreshSecret: env.JWT_REFRESH_SECRET,
    accessSeconds: seconds('JWT_ACCESS_TTL_SECONDS', 900), refreshSeconds: seconds('JWT_REFRESH_TTL_SECONDS', 604800),
    issuer: 'pranaam-api', audience: 'pranaam-client', origins, cookie: { httpOnly: true, secure, sameSite, path: '/' } };
}
module.exports = { loadConfig };
