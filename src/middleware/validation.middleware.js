const { isValidEmail } = require('../utils/email');
const roles = require('../constants/roles');
const { ApiError } = require('../utils/errors');

function validateLogin(req, res, next) {
  const { email, password, role } = req.body || {};

  if (!isValidEmail(email) ||
      typeof password !== 'string' || !password.length || Buffer.byteLength(password) > 72 ||
      !roles.includes(role)) throw new ApiError(400, 'VALIDATION_FAILED', 'Provide email, password (1-72 bytes), and a supported role');
  req.body = { email: email.trim().toLowerCase(), password, role };
  next();
}

function refreshToken(req) {
  const token = req.body?.refreshToken ?? req.cookies?.refreshToken;
  if (typeof token !== 'string' || !token.length || token.length > 4096) throw new ApiError(401, 'UNAUTHORIZED', 'Refresh token required');
  return token;
}

module.exports = { validateLogin, refreshToken };
