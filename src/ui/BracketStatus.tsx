interface Props {
  picked: number;
  total: number;
  remainingThisRound: number;
  saveState: 'idle' | 'saving' | 'saved' | 'failed' | 'stale' | 'repick' | 'conflict';
  affectedCount: number;
  onRetry: () => void;
}

const saveCopy: Record<Props['saveState'], string> = {
  idle: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  failed: 'Not saved',
  stale: 'Draw updated',
  repick: 'Needs repick',
  conflict: 'Newer draft loaded',
};

export function BracketStatus({
  picked,
  total,
  remainingThisRound,
  saveState,
  affectedCount,
  onRetry,
}: Props) {
  return (
    <aside className="bracket-status" aria-label="Bracket progress">
      <div className="bracket-meter" aria-hidden="true">
        <span style={{ width: `${total ? picked / total * 100 : 0}%` }} />
      </div>
      <p className="bracket-count"><strong>{picked} of {total}</strong> · {remainingThisRound} left this round</p>
      <div className={`save-state is-${saveState}`} role="status" aria-live="polite">
        <span aria-hidden="true">{saveState === 'saved' ? '✓' : saveState === 'failed' ? '!' : '•'}</span>
        {affectedCount > 0 ? `${affectedCount} ${affectedCount === 1 ? 'pick needs' : 'picks need'} repair` : saveCopy[saveState]}
        {saveState === 'failed' && <button type="button" onClick={onRetry}>Retry save</button>}
      </div>
    </aside>
  );
}
