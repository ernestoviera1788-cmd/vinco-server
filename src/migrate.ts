// Runs versioned SQL migrations from ./migrations in filename order.
// Tracks applied migrations in schema_migrations(name). Idempotent.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from './db';

async function main(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = new Set((await pool.query(`SELECT name FROM schema_migrations`)).rows.map((r: any) => r.name));
  const dir = join(__dirname, '..', 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (applied.has(f)) {
      console.log(`skip ${f}`);
      continue;
    }
    console.log(`apply ${f}`);
    const sql = readFileSync(join(dir, f), 'utf8');
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [f]);
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }
  }
  console.log('migrations done');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
