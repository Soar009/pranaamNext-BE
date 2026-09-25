const { ApiError } = require('../utils/errors');

function accessToken(req) {
  if (req.headers.authorization) {
    const match = /^Bearer ([^ ]+)$/i.exec(req.headers.authorization);
    if (!match) throw new ApiError(401, 'UNAUTHORIZED', 'Invalid authorization header');
    return match[1];
  }
  return req.cookies?.accessToken;
}

const authenticate = service => async (req, res, next) => {
  req.user = await service.authenticate(accessToken(req));
  next();
};

const authorize = (...roles) => (req, res, next) => {
  if (!req.user) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
  if (!roles.includes(req.user.role)) throw new ApiError(403, 'FORBIDDEN', 'Role not permitted');
  next();
};

module.exports = { accessToken, authenticate, authorize };
