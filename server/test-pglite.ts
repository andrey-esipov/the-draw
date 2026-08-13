import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { sql, getTableName, is, Table } from 'drizzle-orm';
import * as schema from './schema';
import type { db } from './db';

// Each test used to spin up a *brand new* PGlite instance + re-run every
// migration from scratch (`mkdtemp` + `new PGlite()` + `migrate()`), which
// takes several seconds under load. With a dozen-plus `withDb` calls per
// file that blew straight through vitest's 5000ms default `testTimeout`,
// so `account-auth.test.ts`/`account-admin.test.ts` failed nondeterministically
// depending on machine load rather than on any actual bug. Fix: migrate ONCE
// per test file (module-scoped PGlite instance) and just TRUNCATE all tables
// between tests to reset state — orders of magnitude cheaper than re-migrating.
export function useTestDb(namePrefix: string) {
  let dir: string;
  let client: PGlite;
  let database: ReturnType<typeof drizzlePglite>;

  // Spinning up PGlite + running every migration is normally well under a
  // second, but under heavy CI/dev-box CPU contention (other workflows,
  // parallel test files, etc.) it can take several seconds. Give this
  // one-time-per-file setup a generous ceiling well above vitest's 10s
  // default hookTimeout so contention doesn't turn into a flaky failure.
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), `${namePrefix}-`));
    client = new PGlite(dir);
    database = drizzlePglite(client, { schema });
    await migratePglite(database, { migrationsFolder: './drizzle' });
  }, 60_000);

  beforeEach(async () => {
    // TRUNCATE every table the schema knows about; CASCADE handles FKs and
    // RESTART IDENTITY keeps sequences deterministic across tests.
    const tableNames = Object.values(schema)
      .filter((value) => is(value, Table))
      .map((table) => getTableName(table as Table));
    if (tableNames.length > 0) {
      await database.execute(sql.raw(`TRUNCATE TABLE ${tableNames.map((n) => `"${n}"`).join(', ')} RESTART IDENTITY CASCADE`));
    }
  }, 30_000);

  afterAll(async () => {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  return {
    // Kept as an async function (matching the old `withDb` shape) so call
    // sites don't need to change: it just hands back the already-migrated,
    // freshly-truncated shared database instead of building a new one.
    withDb: async <T>(fn: (database: typeof db) => Promise<T>): Promise<T> => {
      return fn(database as unknown as typeof db);
    },
  };
}
