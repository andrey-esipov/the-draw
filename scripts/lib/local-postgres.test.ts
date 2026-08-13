import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  localPostgresUrl,
  loopbackPgHba,
  resolveLocalPostgresTools,
} from './local-postgres';
import { startLocalPostgres } from './local-postgres';

describe('local Postgres runner helper', () => {
  it('builds a loopback-only URL without a password or external host', () => {
    expect(localPostgresUrl({ user: 'runner', database: 'acceptance', port: 54321 }))
      .toBe('postgresql://runner@127.0.0.1:54321/acceptance');
  });

  it('writes host trust rules only for loopback addresses', () => {
    expect(loopbackPgHba()).toBe('host all all 127.0.0.1/32 trust\n');
    expect(loopbackPgHba()).not.toContain('local all all');
    expect(loopbackPgHba()).not.toContain('::1');
  });

  it('prefers one PATH bin dir that already contains every required tool', () => {
    const resolved = resolveLocalPostgresTools(['initdb', 'pg_ctl', 'createdb'], {
      env: {
        PATH: '/usr/local/bin:/usr/bin',
        LOCAL_POSTGRES_BIN_DIR: '/override/bin',
      },
      exists: (candidate) => [
        '/usr/local/bin/initdb',
        '/usr/local/bin/pg_ctl',
        '/usr/local/bin/createdb',
        '/override/bin/initdb',
        '/override/bin/pg_ctl',
        '/override/bin/createdb',
      ].includes(candidate),
      listDir: () => [],
    });
    expect(resolved).toEqual({
      initdb: '/usr/local/bin/initdb',
      pg_ctl: '/usr/local/bin/pg_ctl',
      createdb: '/usr/local/bin/createdb',
    });
  });

  it('falls back to the highest installed /usr/lib/postgresql/<ver>/bin dir when PATH lacks the tools', () => {
    const resolved = resolveLocalPostgresTools(['initdb', 'pg_ctl', 'createdb'], {
      env: { PATH: '/usr/local/bin' },
      exists: (candidate) => [
        '/usr/lib/postgresql/15/bin/initdb',
        '/usr/lib/postgresql/15/bin/pg_ctl',
        '/usr/lib/postgresql/15/bin/createdb',
        '/usr/lib/postgresql/16/bin/initdb',
        '/usr/lib/postgresql/16/bin/pg_ctl',
        '/usr/lib/postgresql/16/bin/createdb',
      ].includes(candidate),
      listDir: (dir) => dir === '/usr/lib/postgresql' ? ['15', '16'] : [],
    });
    expect(resolved).toEqual({
      initdb: '/usr/lib/postgresql/16/bin/initdb',
      pg_ctl: '/usr/lib/postgresql/16/bin/pg_ctl',
      createdb: '/usr/lib/postgresql/16/bin/createdb',
    });
  });

  it('re-resolves against the current filesystem instead of caching a stale installed version', () => {
    let activeVersion = '15';
    const resolve = () => resolveLocalPostgresTools(['initdb', 'pg_ctl', 'createdb'], {
      env: { PATH: '' },
      exists: (candidate) => candidate.startsWith(`/usr/lib/postgresql/${activeVersion}/bin/`),
      listDir: (dir) => dir === '/usr/lib/postgresql' ? ['15', '16'] : [],
    });
    expect(resolve()).toEqual({
      initdb: '/usr/lib/postgresql/15/bin/initdb',
      pg_ctl: '/usr/lib/postgresql/15/bin/pg_ctl',
      createdb: '/usr/lib/postgresql/15/bin/createdb',
    });
    activeVersion = '16';
    expect(resolve()).toEqual({
      initdb: '/usr/lib/postgresql/16/bin/initdb',
      pg_ctl: '/usr/lib/postgresql/16/bin/pg_ctl',
      createdb: '/usr/lib/postgresql/16/bin/createdb',
    });
  });

  it('passes the selected role to initdb and createdb', async () => {
    const dataDir = join(process.cwd(), `.local-postgres-test-${randomUUID()}`);
    const calls: Array<{ command: string; args: string[] }> = [];
    const commandRunner = async (command: string, args: string[]) => {
      calls.push({ command, args });
      return { status: 0, stderr: '' };
    };
    try {
      const postgres = await startLocalPostgres({
        dataDir,
        user: 'runner_role',
        commandRunner,
        resolveTool: (name) => name,
        allocatePort: async () => 54321,
      });
      expect(calls[0]).toEqual(expect.objectContaining({
        command: 'initdb',
        args: expect.arrayContaining(['--username', 'runner_role']),
      }));
      expect(calls[2]).toEqual(expect.objectContaining({
        command: 'createdb',
        args: expect.arrayContaining(['-U', 'runner_role']),
      }));
      expect(postgres.url).toContain('runner_role@127.0.0.1');
      // TCP is the test contract; disabling Unix sockets avoids compiled-in directories
      // that may be unwritable and long macOS socket paths.
      const pgCtlCall = calls[1];
      expect(pgCtlCall.command).toBe('pg_ctl');
      const dashOIndex = pgCtlCall.args.indexOf('-o');
      expect(dashOIndex).toBeGreaterThanOrEqual(0);
      expect(pgCtlCall.args[dashOIndex + 1]).toContain("unix_socket_directories=''");
      await postgres.stop();
      expect(existsSync(dataDir)).toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['initdb', 1],
    ['pg_ctl', 1],
    ['createdb', 1],
  ])('removes the data directory when %s fails', async (failedCommand, status) => {
    const dataDir = join(process.cwd(), `.local-postgres-test-${randomUUID()}`);
    const commandRunner = async (command: string) => ({
      status: command === failedCommand ? status : 0,
      stderr: command === failedCommand ? 'expected failure' : '',
    });
    try {
      await expect(startLocalPostgres({
        dataDir,
        commandRunner,
        resolveTool: (name) => name,
        allocatePort: async () => 54321,
      })).rejects.toThrow();
      expect(existsSync(dataDir)).toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
