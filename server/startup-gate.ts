import type { RequestHandler } from 'express';

export interface StartupGate {
  middleware: RequestHandler;
  markReady(): void;
}

export function createStartupGate(): StartupGate {
  let ready = false;

  return {
    middleware(req, res, next) {
      if (ready) {
        next();
        return;
      }

      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', '1');
      if (req.path === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.status(200).json({ ok: false, status: 'starting' });
        return;
      }

      res.status(503).json({ error: 'service_starting' });
    },
    markReady() {
      ready = true;
    },
  };
}
