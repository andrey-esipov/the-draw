import 'express-async-errors';
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStartupGate, type StartupGate } from './startup-gate.js';

type ApplicationInitializer = (app: Express, startupGate: StartupGate) => Promise<void>;

interface BootstrapOptions {
  port?: number;
  initialize?: ApplicationInitializer;
}

interface BootstrapResult {
  server: Server;
  initialization: Promise<void>;
}

async function initializeApplication(app: Express, startupGate: StartupGate) {
  const server = await import('./index.js');
  await server.initializeApplication(app, startupGate);
}

export async function startBootstrap({
  port = Number(process.env.PORT) || 3000,
  initialize = initializeApplication,
}: BootstrapOptions = {}): Promise<BootstrapResult> {
  const app = express();
  const startupGate = createStartupGate();
  app.use(startupGate.middleware);

  const server = app.listen(port, '0.0.0.0');
  await once(server, 'listening');
  console.log(`[the-draw] :${port} startup checks in progress`);

  return {
    server,
    initialization: initialize(app, startupGate),
  };
}

const isEntryPoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isEntryPoint) {
  startBootstrap()
    .then(({ initialization }) => initialization)
    .catch((error) => {
      console.error('fatal boot error:', error);
      process.exit(1);
    });
}
