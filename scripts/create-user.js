const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const pool = require('../src/config/database');
const { isValidEmail } = require('../src/utils/email');
const roles = require('../src/constants/roles');
async function createUser() {
  const email = (process.env.AUTH_USER_EMAIL || '').trim().toLowerCase();
  const password = process.env.AUTH_USER_PASSWORD || '';
  const role = process.env.AUTH_USER_ROLE || 'CUSTOMER';
  if (!isValidEmail(email) || password.length < 12 || Buffer.byteLength(password) > 72 || !roles.includes(role)) {
    throw new Error('Set AUTH_USER_EMAIL, AUTH_USER_PASSWORD (12+ characters, max 72 bytes), and AUTH_USER_ROLE');
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = randomUUID();
    await client.query('INSERT INTO users(id, email, password_hash, first_name, last_name, vendor_id) VALUES($1,$2,$3,$4,$5,$6)',
      [id, email, passwordHash, process.env.AUTH_USER_FIRST_NAME || '', process.env.AUTH_USER_LAST_NAME || '', process.env.AUTH_USER_VENDOR_ID || null]);
    await client.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [id, role]);
    await client.query('COMMIT');
    console.log('User created: ' + email);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
createUser().catch(e => { console.error('User creation failed:', e.message); process.exitCode = 1; }).finally(() => pool.end());
