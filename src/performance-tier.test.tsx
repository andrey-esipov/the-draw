// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { useDeferredLowPowerTier } from './performance-tier';

function TierHarness({ detected }: { detected: boolean }) {
  const [running, setRunning] = useState(false);
  const tier = useDeferredLowPowerTier(detected, running);
  return (
    <>
      <p>{running ? 'running' : 'idle'}:{tier ? 'low' : 'full'}</p>
      <button type="button" onClick={() => setRunning(true)}>Start run</button>
      <button type="button" onClick={() => setRunning(false)}>Run ended</button>
    </>
  );
}

afterEach(cleanup);

describe('performance tier transitions', () => {
  it('defers a low-power stage recreation until the active run reports its ending', () => {
    const { rerender } = render(<TierHarness detected={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    rerender(<TierHarness detected />);
    expect(screen.getByText('running:full')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Run ended' }));
    expect(screen.getByText('idle:low')).toBeTruthy();
  });
});
