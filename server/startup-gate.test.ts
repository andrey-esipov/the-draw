// Pure unit tests for the startup gate middleware that `server/bootstrap.ts`
// mounts before `initializeApplication` (migrations, workers, routes) has
// finished. These test the middleware directly against mocked req/res objects
// — no HTTP server or app boot required — so the pre-ready/post-ready
// contract is covered without the cost of a full integration test.
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createStartupGate } from './startup-gate.js';

function mockResponse() {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: vi.fn((name: string, value: string) => { headers[name] = value; }),
    status: vi.fn(function (this: Response, _code: number) { return res as unknown as Response; }),
    json: vi.fn(function (this: Response, _body: unknown) { return res as unknown as Response; }),
  };
  return { res: res as unknown as Response, headers };
}

function mockRequest(path: string, method: string): Request {
  return { path, method } as Request;
}

describe('createStartupGate', () => {
  it('responds 503 for any non-root request before the app is ready', () => {
    const gate = createStartupGate();
    const next = vi.fn();
    const { res, headers } = mockResponse();
    gate.middleware(mockRequest('/api/draw/events/us-open:2026-men', 'GET'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'service_starting' });
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['Retry-After']).toBe('1');
  });

  it('answers root GET/HEAD with a 200 "starting" body instead of a hard failure before ready', () => {
    const gate = createStartupGate();
    const next = vi.fn();
    for (const method of ['GET', 'HEAD']) {
      const { res } = mockResponse();
      gate.middleware(mockRequest('/', method), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: false, status: 'starting' });
    }
  });

  it('still 503s a non-GET/HEAD method at root before ready (POST is not a passive health probe)', () => {
    const gate = createStartupGate();
    const next = vi.fn();
    const { res } = mockResponse();
    gate.middleware(mockRequest('/', 'POST'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'service_starting' });
  });

  it('passes every request straight through to next() once markReady() has been called', () => {
    const gate = createStartupGate();
    gate.markReady();
    const next = vi.fn();
    const { res } = mockResponse();
    gate.middleware(mockRequest('/', 'GET'), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();

    const next2 = vi.fn();
    const { res: res2 } = mockResponse();
    gate.middleware(mockRequest('/api/draw/events/us-open:2026-men', 'GET'), res2, next2);
    expect(next2).toHaveBeenCalledOnce();
    expect(res2.status).not.toHaveBeenCalled();
  });

  it('never reverts to unready once markReady() has fired', () => {
    const gate = createStartupGate();
    gate.markReady();
    gate.markReady();
    const next = vi.fn();
    const { res } = mockResponse();
    gate.middleware(mockRequest('/', 'GET'), res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
