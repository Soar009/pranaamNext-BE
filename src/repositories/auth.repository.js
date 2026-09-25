class AuthRepository {
  constructor(pool) { this.pool = pool; }

  async findUser(field, value) {
    if (!['id', 'email'].includes(field)) throw new Error('Invalid lookup');
    const predicate = field === 'email' ? 'lower(btrim(u.email))=$1' : 'u.id=$1';
    const { rows } = await this.pool.query("SELECT u.*, COALESCE(array_agg(r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id WHERE " + predicate + " GROUP BY u.id", [value]);
    // Ambiguous email identities must never authenticate an arbitrary account.
    return rows.length === 1 ? rows[0] : undefined;
  }

  async createSession(s) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO auth_sessions(id,user_id,role,refresh_hash,expires_at) VALUES($1,$2,$3,$4,$5)', [s.id,s.user_id,s.role,s.refresh_hash,s.expires_at]);
      await client.query('UPDATE users SET last_login_at=now() WHERE id=$1', [s.user_id]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }

  async getSession(id) { return (await this.pool.query('SELECT * FROM auth_sessions WHERE id=$1', [id])).rows[0]; }

  async rotate(id, oldHash, newHash) {
    const result = await this.pool.query('UPDATE auth_sessions SET refresh_hash=$3 WHERE id=$1 AND refresh_hash=$2 AND revoked_at IS NULL AND expires_at>now() RETURNING id', [id, oldHash, newHash]);
    return result.rowCount === 1;
  }
  async revoke(id) { await this.pool.query('UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1', [id]); }
}

module.exports = { AuthRepository };
