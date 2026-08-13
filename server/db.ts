// DB factory. A real DATABASE_URL uses postgres-js (Replit Postgres / Neon / any
// standard Postgres — portable via pg_dump). With no URL we fall back to embedded
// pglite so the app runs with zero config (data in ./.dev-db; ephemeral on
// Autoscale, durable on a Reserved VM). The schema + migrations are identical for
// both — Drizzle abstracts the driver, so nothing in app code is Replit-specific.
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import postgres from 'postgres';
import { PGlite } from '@electric-sql/pglite';
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as schema from './schema.js';
import { DATABASE_POOL_MAX, DATABASE_URL, hasPostgres } from './env.js';

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

// Both drivers expose the same Drizzle query-builder API, but their static types
// don't unify (method overloads differ), which breaks `.returning()` / column
// access on a `pg | pglite` union. Pin the exported type to the postgres-js shape
// (the production driver) and adapt the pglite instance to it — runtime behavior
// is identical, the cast only reconciles the two compile-time shapes.
type DB = ReturnType<typeof drizzlePg<typeof schema>>;

let _db: DB;
let _kind: 'postgres' | 'pglite' | 'test';
let _close: () => Promise<void>;

if (process.env.VITEST === 'true') {
  _db = new Proxy({} as DB, {
    get() {
      throw new Error('Vitest database access requires an injected test database');
    },
  });
  _kind = 'test';
  _close = async () => undefined;
} else if (hasPostgres) {
  const sql = postgres(DATABASE_URL, { max: DATABASE_POOL_MAX });
  _db = drizzlePg(sql, { schema });
  _kind = 'postgres';
  _close = () => sql.end();
} else {
  const client = new PGlite('./.dev-db');
  _db = drizzlePglite(client, { schema }) as unknown as DB;
  _kind = 'pglite';
  _close = () => client.close();
}

export const db = _db;
export const dbKind = _kind;

export async function closeDatabase() {
  await _close();
}

// Apply migrations on boot for BOTH drivers (the generated SQL in ./drizzle is the
// single source of truth). For postgres you can also run `npm run db:push`. The
// generated SQL is idempotent (CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
// constraints guarded by duplicate_object) so re-applying against a DB that was
// previously `db:push`-ed is a no-op rather than a "column already exists" failure.
//
// Boot migration MUST fail loudly: a swallowed error means a half-migrated
// production deploy boots and then 500s on the first query against the missing
// column/table. We rethrow so the process exits at boot instead of serving a
// broken schema silently.
export async function runMigrations() {
  try {
    if (_kind === 'test') throw new Error('Vitest migrations require an injected test database');
    if (_kind === 'postgres') await migratePg(_db as any, { migrationsFolder });
    else await migratePglite(_db as any, { migrationsFolder });
    return true;
  } catch (e) {
    console.error('[the-draw] FATAL: boot migration failed — refusing to start with an un-migrated schema. Run `npm run db:generate` then `npm run db:push` to reconcile:', (e as Error).message);
    throw e;
  }
}
