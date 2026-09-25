const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { randomUUID, createHash } = require('node:crypto');
const { ApiError } = require('../utils/errors');
const hash = token => createHash('sha256').update(token).digest('hex');
const unauthorized = () => new ApiError(401, 'UNAUTHORIZED', 'Invalid credentials or session');
const dummyHash = bcrypt.hashSync(randomUUID(), 12);
class AuthService {
  constructor(repository, config) { this.repo = repository; this.config = config; }
  verify(token, type) {
    try {
      const claims = jwt.verify(token, type === 'access' ? this.config.accessSecret : this.config.refreshSecret, {
        algorithms: ['HS256'], issuer: this.config.issuer, audience: this.config.audience,
      });
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (claims.type !== type || !uuid.test(claims.sub) || !uuid.test(claims.sid)) throw unauthorized();
      return claims;
    } catch { throw unauthorized(); }
  }
  userData(user, role) {
    return { id: user.id, name: (user.first_name + ' ' + user.last_name).trim(),
      firstName: user.first_name, lastName: user.last_name, email: user.email, mobile: user.mobile,
      role, roles: user.roles, vendorId: user.vendor_id, status: user.status };
  }
  tokens(user, session) {
    const remaining = Math.floor((new Date(session.expires_at).getTime() - Date.now()) / 1000);
    if (remaining <= 0) throw unauthorized();
    const sign = (type, secret, expiresIn) => jwt.sign({ type, sid: session.id, role: session.role, vendorId: user.vendor_id }, secret,
      { algorithm: 'HS256', subject: user.id, issuer: this.config.issuer, audience: this.config.audience, jwtid: randomUUID(), expiresIn });
    return { user: this.userData(user, session.role),
      accessToken: sign('access', this.config.accessSecret, Math.min(this.config.accessSeconds, remaining)),
      refreshToken: sign('refresh', this.config.refreshSecret, remaining), tokenType: 'Bearer',
      expiresIn: Math.min(this.config.accessSeconds, remaining), refreshExpiresIn: remaining };
  }
  async login({ email, password, role }) {
    const user = await this.repo.findUser('email', email.trim().toLowerCase());
    const valid = await bcrypt.compare(password, user?.password_hash || dummyHash);
    if (!user || !valid || user.status !== 'ACTIVE' || !user.roles.includes(role)) throw unauthorized();
    const session = { id: randomUUID(), user_id: user.id, role, expires_at: new Date(Date.now() + this.config.refreshSeconds * 1000) };
    const result = this.tokens(user, session);
    await this.repo.createSession({ ...session, refresh_hash: hash(result.refreshToken) });
    return result;
  }
  async context(token, type) {
    const claims = this.verify(token, type);
    const session = await this.repo.getSession(claims.sid);
    if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now() || session.user_id !== claims.sub || session.role !== claims.role) throw unauthorized();
    const user = await this.repo.findUser('id', claims.sub);
    if (!user || user.status !== 'ACTIVE' || !user.roles.includes(session.role)) throw unauthorized();
    return { user, session };
  }
  async refresh(token) {
    const { user, session } = await this.context(token, 'refresh');
    const result = this.tokens(user, session);
    if (!await this.repo.rotate(session.id, hash(token), hash(result.refreshToken))) {
      await this.repo.revoke(session.id);
      throw unauthorized();
    }
    return result;
  }
  async authenticate(token) {
    const { user, session } = await this.context(token, 'access');
    return this.userData(user, session.role);
  }
  async logout(token, type) {
    let claims;
    try { claims = this.verify(token, type); } catch { return; }
    await this.repo.revoke(claims.sid);
  }
}
module.exports = { AuthService };
