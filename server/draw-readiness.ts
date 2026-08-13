// Pure decision logic for /api/ready, factored out of server/index.ts so it can be unit-tested
// without booting the whole app (DB migrations, background workers, static/Vite serving). Kept
// separate from /api/health, which is liveness-only and never gates on this.
import type { DrawSourceHealthState } from './draw-operations.js';

export interface DrawReadinessInput {
  isProd: boolean;
  sourceWorkerEnabled: boolean;
  retentionWorkerEnabled: boolean;
  drawSource: { events: Array<{ state: DrawSourceHealthState }> };
  drawEmail: { state: string };
  drawRetention: { state: string };
}

// A draw that has not been announced yet ("never_fetched") is a valid, expected awaiting state,
// not a failure — only a source that tried and failed, drifted stale, or was withheld by
// reconciliation counts against readiness.
const UNHEALTHY_SOURCE_STATES: ReadonlySet<DrawSourceHealthState> = new Set(['delayed', 'stale', 'conflicting']);

export function computeDrawReadinessReasons(input: DrawReadinessInput): string[] {
  const reasons: string[] = [];
  if (input.isProd && !input.sourceWorkerEnabled) reasons.push('draw_source_worker_disabled');
  if (input.isProd && !input.retentionWorkerEnabled) reasons.push('draw_retention_worker_disabled');
  if (input.drawSource.events.some((event) => UNHEALTHY_SOURCE_STATES.has(event.state))) {
    reasons.push('draw_source_unhealthy');
  }
  if (input.drawEmail.state === 'unhealthy') reasons.push('draw_email_unhealthy');
  if (input.drawRetention.state === 'unhealthy') reasons.push('draw_retention_unhealthy');
  return reasons;
}
