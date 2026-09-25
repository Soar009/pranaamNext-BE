const fs = require('node:fs/promises');
const path = require('node:path');
const pool = require('../src/config/database');
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(782341)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const files = (await fs.readdir(path.join(__dirname, '../migrations'))).filter(f => f.endsWith('.sql')).sort();
    for (const name of files) {
      if ((await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount) continue;
      await client.query(await fs.readFile(path.join(__dirname, '../migrations', name), 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
      console.log('Applied ' + name);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
migrate().catch(e => { console.error('Migration failed:', e.message); process.exitCode = 1; }).finally(() => pool.end());
