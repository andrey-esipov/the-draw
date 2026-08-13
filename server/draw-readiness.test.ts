import { describe, expect, it } from 'vitest';
import { computeDrawReadinessReasons, type DrawReadinessInput } from './draw-readiness.js';

function healthyInput(): DrawReadinessInput {
  return {
    isProd: true,
    sourceWorkerEnabled: true,
    retentionWorkerEnabled: true,
    drawSource: { events: [{ state: 'current' }] },
    drawEmail: { state: 'disabled' },
    drawRetention: { state: 'current' },
  };
}

describe('computeDrawReadinessReasons', () => {
  it('is ready when every production worker is enabled and every subsystem reports healthy', () => {
    expect(computeDrawReadinessReasons(healthyInput())).toEqual([]);
  });

  it('treats "never_fetched" as a valid awaiting state, not a readiness failure', () => {
    const input = healthyInput();
    input.drawSource = { events: [{ state: 'never_fetched' as const }] };
    expect(computeDrawReadinessReasons(input)).toEqual([]);
  });

  it('fails readiness when the source polling worker is disabled in production', () => {
    const input = healthyInput();
    input.sourceWorkerEnabled = false;
    expect(computeDrawReadinessReasons(input)).toContain('draw_source_worker_disabled');
  });

  it('fails readiness when the retention worker is disabled in production', () => {
    const input = healthyInput();
    input.retentionWorkerEnabled = false;
    expect(computeDrawReadinessReasons(input)).toContain('draw_retention_worker_disabled');
  });

  it('does not require worker flags outside production', () => {
    const input = healthyInput();
    input.isProd = false;
    input.sourceWorkerEnabled = false;
    input.retentionWorkerEnabled = false;
    expect(computeDrawReadinessReasons(input)).toEqual([]);
  });

  it('fails readiness for a delayed, stale, or conflicting source event', () => {
    for (const state of ['delayed', 'stale', 'conflicting'] as const) {
      const input = healthyInput();
      input.drawSource = { events: [{ state }] };
      expect(computeDrawReadinessReasons(input)).toContain('draw_source_unhealthy');
    }
  });

  it('fails readiness when email or retention subsystems report genuinely unhealthy', () => {
    const emailUnhealthy = healthyInput();
    emailUnhealthy.drawEmail = { state: 'unhealthy' };
    expect(computeDrawReadinessReasons(emailUnhealthy)).toContain('draw_email_unhealthy');

    const retentionUnhealthy = healthyInput();
    retentionUnhealthy.drawRetention = { state: 'unhealthy' };
    expect(computeDrawReadinessReasons(retentionUnhealthy)).toContain('draw_retention_unhealthy');
  });

  it('does not fail readiness for email left disabled/canary-pending (email may stay off explicitly)', () => {
    for (const state of ['disabled', 'canary_required', 'provider_unavailable']) {
      const input = healthyInput();
      input.drawEmail = { state };
      expect(computeDrawReadinessReasons(input)).toEqual([]);
    }
  });

  it('excludes a source event from readiness when readinessRelevant is explicitly false', () => {
    const input = healthyInput();
    input.drawSource = { events: [{ state: 'stale' as const, readinessRelevant: false }] };
    expect(computeDrawReadinessReasons(input)).toEqual([]);
  });

  it('still fails readiness for an unhealthy event when readinessRelevant is true or omitted', () => {
    const explicit = healthyInput();
    explicit.drawSource = { events: [{ state: 'delayed' as const, readinessRelevant: true }] };
    expect(computeDrawReadinessReasons(explicit)).toContain('draw_source_unhealthy');

    const omitted = healthyInput();
    omitted.drawSource = { events: [{ state: 'conflicting' as const }] };
    expect(computeDrawReadinessReasons(omitted)).toContain('draw_source_unhealthy');
  });
});
