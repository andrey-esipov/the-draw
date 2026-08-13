import { useMemo, useRef, useState } from 'react';
import type { DrawRecapProjection } from '../../shared/draw/contracts';
import { downloadRecapPng, recapTextContent, RecapExportError } from '../lib/recap-export';
import { DrawIcon } from './DrawIcon';

interface Props {
  recap: DrawRecapProjection;
}

const errorCopy = {
  font_not_ready: 'The recap typefaces are not ready. Wait a moment, then try again.',
  canvas_unavailable: 'This browser cannot create the recap image.',
  encode_failed: 'The browser could not encode the recap image. Try again.',
  download_failed: 'The download did not start. Check browser download permissions, then try again.',
} as const;

export function LeagueRecap({ recap }: Props) {
  const [exportState, setExportState] = useState<'idle' | 'working' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);
  const exportButton = useRef<HTMLButtonElement>(null);
  const content = useMemo(
    () => recap.state === 'current' ? recapTextContent(recap.viewModel) : null,
    [recap],
  );

  if (recap.state === 'none') return null;
  if (recap.state === 'unavailable') {
    return (
      <section className="round-paper is-unavailable" aria-live="polite">
        <p className="round-paper-edition">Round paper · unavailable</p>
        <h2>This round&rsquo;s recap could not be computed</h2>
        <p>Standings above still reflect the accepted revision. Try reloading in a moment.</p>
        <code>Accepted revision {recap.acceptedRevisionId.slice(0, 12)}</code>
      </section>
    );
  }
  if (recap.state === 'updating') {
    return (
      <section className="round-paper is-updating" aria-live="polite" aria-busy="true">
        <p className="round-paper-edition">Round paper · updating</p>
        <h2>Rebuilding this round after the accepted result changed</h2>
        <p>The previous recap is not shown as current. Standings above already use the accepted revision.</p>
        <code>Accepted revision {recap.acceptedRevisionId.slice(0, 12)}</code>
      </section>
    );
  }

  const exportPng = async () => {
    setExportState('working');
    setError(null);
    try {
      await downloadRecapPng(recap.viewModel);
      setExportState('saved');
    } catch (cause) {
      setExportState('idle');
      const code = cause instanceof RecapExportError ? cause.code : 'download_failed';
      setError(errorCopy[code]);
    } finally {
      requestAnimationFrame(() => exportButton.current?.focus());
    }
  };

  return (
    <article className="round-paper" aria-labelledby="round-paper-title">
      <header>
        <div>
          <p className="round-paper-edition">Round paper · {content!.deck}</p>
          <h2 id="round-paper-title">{content!.title}</h2>
        </div>
        <div className="round-paper-export">
          <button ref={exportButton} type="button" onClick={() => void exportPng()} disabled={exportState === 'working'}>
            <DrawIcon name="export" />{exportState === 'working' ? 'Preparing PNG' : 'Download round paper'}
          </button>
          <span aria-live="polite">
            {error ?? (exportState === 'saved' ? 'Download started. The image stayed on this device.' : 'Local PNG · no upload')}
          </span>
        </div>
      </header>
      <div className="round-paper-body">
        {content!.sections.map((section, index) => (
          <section key={section.label} className={index === 0 ? 'round-paper-movement' : undefined}>
            <h3>{section.label}</h3>
            {section.lines.map((line) => <p key={line}>{line}</p>)}
          </section>
        ))}
      </div>
      <footer>{content!.provenance.map((line) => <span key={line}>{line}</span>)}</footer>
    </article>
  );
}
