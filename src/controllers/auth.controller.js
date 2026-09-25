const { refreshToken } = require('../middleware/validation.middleware');
const { accessToken } = require('../middleware/auth.middleware');

function authController(service, config) {
  const sendTokens = (res, result) => {
    res.cookie('accessToken', result.accessToken, { ...config.cookie, maxAge: result.expiresIn * 1000 });
    res.cookie('refreshToken', result.refreshToken, { ...config.cookie, maxAge: result.refreshExpiresIn * 1000 });
    res.json(result);
  };

  return {
    login: async (req, res) => sendTokens(res, await service.login(req.body)),
    refresh: async (req, res) => sendTokens(res, await service.refresh(refreshToken(req))),
    logout: async (req, res) => {
      // Revoke every valid session credential supplied, even if another token has expired.
      const tokens = [[req.body?.refreshToken, 'refresh'], [req.cookies?.refreshToken, 'refresh'],
        [accessToken(req), 'access'], [req.cookies?.accessToken, 'access']];
      for (const [token, type] of tokens) if (typeof token === 'string') await service.logout(token, type);
      res.clearCookie('accessToken', config.cookie);
      res.clearCookie('refreshToken', config.cookie);
      res.json({ message: 'Logged out successfully' });
    },
    me: (req, res) => res.json({ user: req.user }),
  };
}
module.exports = { authController };
