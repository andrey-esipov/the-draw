import express from 'express';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mountDrawStatic } from './draw-static';

const fixtures: string[] = [];
const servers: Server[] = [];

async function fixture() {
  const root = await mkdtemp(join(process.cwd(), '.draw-static-test-'));
  fixtures.push(root);
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html><title>The Draw</title><div id="draw-shell"></div>');
  await writeFile(join(root, 'assets', 'index-AbCd1234.js'), 'console.log("draw")');
  return root;
}

async function start(root: string) {
  const app = express();
  app.get('/api/draw/probe', (_req, res) => res.json({ drawApi: true }));
  mountDrawStatic(app, { dist: root });
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('production Draw static mount', () => {
  it('serves the Draw shell at the root and private deep routes', async () => {
    const base = await start(await fixture());
    for (const path of ['/', '/leagues/private-return']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('id="draw-shell"');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(await (await fetch(`${base}/api/draw/probe`)).json()).toEqual({ drawApi: true });
  });

  it('makes hashed assets immutable and applies an enforcing script policy', async () => {
    const base = await start(await fixture());
    const asset = await fetch(`${base}/assets/index-AbCd1234.js`);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const missingAsset = await fetch(`${base}/assets/missing.js`);
    expect(missingAsset.status).toBe(404);
    expect(await missingAsset.text()).not.toContain('draw-shell');

    const html = await fetch(`${base}/`);
    const csp = html.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/(?:^|;\s*)script-src 'self' blob:(?:;|$)/);
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).toMatch(/(?:^|;\s*)font-src 'self' data:(?:;|$)/);
    expect(csp).toMatch(/(?:^|;\s*)worker-src 'self' blob:(?:;|$)/);
    expect(csp).toMatch(/(?:^|;\s*)connect-src 'self'(?:;|$)/);
    const scriptPolicy = csp.match(/(?:^|;\s*)script-src ([^;]+)/)?.[1] ?? '';
    expect(scriptPolicy).not.toContain('unsafe-inline');
    expect(scriptPolicy).not.toContain('unsafe-eval');
    expect(scriptPolicy).not.toContain('http:');
    expect(scriptPolicy).not.toContain('https:');
    expect(csp).not.toContain('https:');
    expect(csp).not.toContain('*');
    expect(html.headers.get('content-security-policy-report-only')).toBeNull();
    expect(html.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
