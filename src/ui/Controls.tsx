import { useEffect, useRef, useState } from 'react';
import { drawControlsBus, type FrameTarget } from '../three/controls';
import '../styles/controls.css';

interface Preset {
  id: FrameTarget;
  label: string;
  /** One-line broadcast description, shown as a caption on hover/focus. */
  note: string;
}

const PRESETS: Preset[] = [
  { id: 'all', label: 'Whole draw', note: 'The full board, from above' },
  { id: 'champion', label: "Champion's half", note: 'The winning side of the sheet' },
  { id: 'final', label: 'The final', note: 'Tight on the last match' },
  { id: 'courtside', label: 'Courtside', note: 'Low and close to the plates' },
];

/**
 * The camera chrome: named broadcast framings plus a quiet first-load affordance
 * that teaches the drag/scroll gesture and then gets out of the way for good.
 *
 * It never talks to the renderer directly — it drives whatever DrawControls rig
 * Broadcast has published on the shared bus, so it stays a thin, declarative skin.
 */
export function Controls() {
  const [ready, setReady] = useState(!!drawControlsBus.current);
  const [moved, setMoved] = useState(drawControlsBus.current?.hasMoved ?? false);
  const [active, setActive] = useState<FrameTarget | null>('all');
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const attach = () => {
      const c = drawControlsBus.current;
      setReady(!!c);
      if (!c) return;
      setMoved(c.hasMoved);
      c.onFirstMove = () => setMoved(true);
    };
    attach();
    return drawControlsBus.subscribe(attach);
  }, []);

  const go = (id: FrameTarget) => {
    setActive(id);
    setMoved(true);
    drawControlsBus.current?.frame(id);
  };

  const reset = () => {
    setActive('all');
    drawControlsBus.current?.reset();
  };

  if (!ready) return null;

  return (
    <div className="camctl" ref={wrapRef} aria-label="Camera">
      <div className={`camctl-hint${moved ? ' is-gone' : ''}`} aria-hidden={moved}>
        <span className="camctl-hint-verb">Fly the draw</span>
        <span className="camctl-hint-keys">
          Drag to orbit · Scroll to zoom · Hold space to pan · Click any match
        </span>
      </div>

      <div className="camctl-rack" role="group" aria-label="Camera framings">
        <span className="camctl-eyebrow">Camera</span>
        <div className="camctl-presets">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`camctl-preset${active === p.id ? ' is-on' : ''}`}
              onClick={() => go(p.id)}
              title={p.note}
            >
              <span className="camctl-preset-label">{p.label}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`camctl-reset${moved ? ' is-live' : ''}`}
          onClick={reset}
          aria-hidden={!moved}
          tabIndex={moved ? 0 : -1}
        >
          Reset framing
        </button>
      </div>
    </div>
  );
}
