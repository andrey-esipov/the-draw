import express, { type Express, type Response } from 'express';
import { join } from 'node:path';

const DRAW_CSP = [
  "default-src 'self'",
  "script-src 'self' blob:",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function drawHtmlHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', DRAW_CSP);
  res.removeHeader('Content-Security-Policy-Report-Only');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

// The Draw is the whole application here (not a sub-app mounted under another
// site), so its built SPA and assets are served at the root path, not under
// /draw as in the monorepo this was migrated from.
export function mountDrawStatic(app: Express, options: { dist: string }): void {
  const index = join(options.dist, 'index.html');

  app.use('/assets', express.static(join(options.dist, 'assets'), {
    immutable: true,
    maxAge: '1y',
  }));
  app.use('/assets', (_req, res) => {
    res.status(404).setHeader('Cache-Control', 'no-store');
    res.end();
  });
  app.use(express.static(options.dist, {
    index: false,
    redirect: false,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Referrer-Policy', 'no-referrer');
    },
  }));
  app.get('*', (_req, res) => {
    drawHtmlHeaders(res);
    res.type('html').sendFile(index);
  });
}
