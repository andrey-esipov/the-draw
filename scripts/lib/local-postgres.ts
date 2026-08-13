import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface LocalPostgres {
  url: string;
  port: number;
  dataDir: string;
  stop(): Promise<void>;
}

interface CommandResult {
  status: number | null;
  stderr: string;
}

export type LocalPostgresCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<CommandResult>;

export interface LocalPostgresOptions {
  dataDir: string;
  database?: string;
  user?: string;
  commandRunner?: LocalPostgresCommandRunner;
  resolveTool?: (name: string) => string;
  allocatePort?: () => Promise<number>;
}

const LOCAL_POSTGRES_TOOLS = ['initdb', 'pg_ctl', 'createdb'] as const;
const LOCAL_POSTGRES_BIN_DIR_ENV = 'LOCAL_POSTGRES_BIN_DIR';
const POSTGRES_VERSION_RE = /^\d+(?:\.\d+)*$/;

interface LocalPostgresToolResolveOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  listDir?: (path: string) => string[];
}

function versionParts(version: string): number[] {
  return version.split('.').map((part) => Number.parseInt(part, 10));
}

function compareVersionDesc(a: string, b: string): number {
  const aParts = versionParts(a);
  const bParts = versionParts(b);
  const width = Math.max(aParts.length, bParts.length);
  for (let index = 0; index < width; index++) {
    const diff = (bParts[index] ?? 0) - (aParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function installedPostgresBinDirs(listDir: (path: string) => string[]): string[] {
  try {
    return listDir('/usr/lib/postgresql')
      .filter((entry) => POSTGRES_VERSION_RE.test(entry))
      .sort(compareVersionDesc)
      .map((version) => join('/usr/lib/postgresql', version, 'bin'));
  } catch {
    return [];
  }
}

function directoryHasTools(
  dir: string,
  names: readonly string[],
  exists: (path: string) => boolean,
): boolean {
  return names.every((name) => exists(join(dir, name)));
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function defaultListDir(path: string): string[] {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export function resolveLocalPostgresTools(
  names: readonly string[] = LOCAL_POSTGRES_TOOLS,
  options: LocalPostgresToolResolveOptions = {},
): Record<string, string> {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const listDir = options.listDir ?? defaultListDir;
  const pathDirs = uniqueNonEmpty((env.PATH ?? '').split(delimiter));
  const explicitDir = env[LOCAL_POSTGRES_BIN_DIR_ENV];
  const candidateDirs = uniqueNonEmpty([
    ...pathDirs,
    ...(explicitDir ? [explicitDir] : []),
    ...installedPostgresBinDirs(listDir),
  ]);
  const binDir = candidateDirs.find((dir) => directoryHasTools(dir, names, exists));
  if (!binDir) {
    throw new Error(
      `local Postgres tools missing: ${names.join(', ')}; checked PATH, `
      + `${LOCAL_POSTGRES_BIN_DIR_ENV}, and /usr/lib/postgresql/<ver>/bin`,
    );
  }
  return Object.fromEntries(names.map((name) => [name, join(binDir, name)]));
}

const run: LocalPostgresCommandRunner = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.once('error', reject);
  child.once('exit', (status) => resolve({ status, stderr }));
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('could not allocate a local Postgres port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

export function localPostgresUrl(options: { user: string; database: string; port: number }): string {
  return `postgresql://${encodeURIComponent(options.user)}@127.0.0.1:${options.port}/${encodeURIComponent(options.database)}`;
}

export function loopbackPgHba(): string {
  return [
    'host all all 127.0.0.1/32 trust',
    '',
  ].join('\n');
}

async function requireSuccess(result: CommandResult, step: string): Promise<void> {
  if (result.status === 0) return;
  throw new Error(`${step} failed (exit ${result.status ?? 'unknown'}): ${result.stderr.trim() || 'no diagnostic'}`);
}

export async function startLocalPostgres(options: LocalPostgresOptions): Promise<LocalPostgres> {
  const dataDir = options.dataDir;
  const database = options.database || 'rallo_acceptance';
  const user = options.user || process.env.USER || 'postgres';
  const commandRunner = options.commandRunner || run;
  const tools = options.resolveTool
    ? {
      initdb: options.resolveTool('initdb'),
      pg_ctl: options.resolveTool('pg_ctl'),
      createdb: options.resolveTool('createdb'),
    }
    : resolveLocalPostgresTools();
  const initdb = tools.initdb;
  const pgCtl = tools.pg_ctl;
  const createdb = tools.createdb;
  const port = await (options.allocatePort || freePort)();
  let serverStarted = false;
  let startAttempted = false;

  const stop = async () => {
    let stopError: Error | undefined;
    if (serverStarted || startAttempted || existsSync(join(dataDir, 'postmaster.pid'))) {
      try {
        await requireSuccess(await commandRunner(pgCtl, ['-D', dataDir, '-m', 'fast', '-w', 'stop']), 'pg_ctl stop');
        serverStarted = false;
        startAttempted = false;
      } catch (error) {
        stopError = error instanceof Error ? error : new Error('pg_ctl stop failed');
      }
    }
    await rm(dataDir, { recursive: true, force: true });
    if (stopError) throw stopError;
  };

  try {
    await rm(dataDir, { recursive: true, force: true });
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await requireSuccess(await commandRunner(initdb, [
      '--no-locale',
      '--encoding=UTF8',
      '--auth-host=reject',
      '--auth-local=reject',
      '--username', user,
      '-D', dataDir,
    ]), 'initdb');
    await writeFile(join(dataDir, 'pg_hba.conf'), loopbackPgHba(), { mode: 0o600 });
    const logPath = join(dataDir, 'server.log');
    startAttempted = true;
    const started = await commandRunner(pgCtl, [
      '-D', dataDir,
      '-o', `-h 127.0.0.1 -p ${port} -c unix_socket_directories=''`,
      '-l', logPath,
      '-w', 'start',
    ]);
    if (started.status !== 0) {
      const log = await readFile(logPath, 'utf8').catch(() => '');
      throw new Error(`pg_ctl failed to start (exit ${started.status ?? 'unknown'}): ${[started.stderr, log].join('\n').trim() || 'no diagnostic'}`);
    }
    serverStarted = true;
    await requireSuccess(await commandRunner(createdb, ['-h', '127.0.0.1', '-p', String(port), '-U', user, database]), 'createdb');
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      const primary = error instanceof Error ? error.message : 'local Postgres startup failed';
      const cleanup = cleanupError instanceof Error ? cleanupError.message : 'cleanup failed';
      const combined = new Error(`${primary}; ${cleanup}`) as Error & { cause?: unknown };
      combined.cause = error;
      throw combined;
    }
    throw error;
  }

  return { url: localPostgresUrl({ user, database, port }), port, dataDir, stop };
}
