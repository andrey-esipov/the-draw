import { useEffect, useState } from 'react';

export function useDeferredLowPowerTier(detected: boolean, running: boolean): boolean {
  const [applied, setApplied] = useState(detected);
  useEffect(() => {
    if (!running) setApplied(detected);
  }, [detected, running]);
  return applied;
}
