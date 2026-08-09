import { useEffect, useId, useRef, useState } from 'react';
import type { SlamId } from '../data/types';
import { themeFor } from './theme';

type Tour = 'men' | 'women';

interface Props {
  slam: SlamId;
  tour: Tour;
  slams: SlamId[];
  onSlam: (id: SlamId) => void;
  onTour: (t: Tour) => void;
}

/**
 * The tournament switch, collapsed into a single mark.
 *
 * The mark is the urn every one of these four events hands over: a lidded cup with
 * a finial, a waisted neck, thin looped handles and a stepped plinth. It is drawn
 * as that specific object rather than the two-eared award glyph every icon set
 * ships, and the lid lifts a hair as the panel opens.
 *
 * Inside, each slam is named by its court seen from above — the surround, the
 * playing surface, the service boxes and the net — painted in that tournament's
 * own two colours. A court plan is unmistakably tennis at 20px, which a coloured
 * chip is not.
 */
export function SlamMenu({ slam, tour, slams, onSlam, onTour }: Props) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const active = themeFor(slam);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      btnRef.current?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  return (
    <div
      className={`slammenu${open ? ' is-open' : ''}`}
      ref={boxRef}
      style={{ '--flare': active.flare } as React.CSSProperties}
    >
      <button
        type="button"
        ref={btnRef}
        className="slammenu-btn"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Tournament: ${active.label}. Choose another`}
        onClick={() => setOpen((o) => !o)}
      >
        <svg className="cup" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.15">
            <g className="cup-lid">
              <path d="M12 1.6v1.2" strokeWidth="1" />
              <path d="M8.5 5.4c0-1.9 1.6-2.9 3.5-2.9s3.5 1 3.5 2.9Z" />
            </g>
            <path className="cup-body" d="M8.5 5.4h7l-.5 5.1a3 3 0 0 1-6 0Z" />
            <path className="cup-handle cup-handle-l" d="M8.3 6.2c-1.7.2-2.5 1.2-2.5 2.4s.9 2 2 2.1" strokeWidth="0.95" />
            <path className="cup-handle cup-handle-r" d="M15.7 6.2c1.7.2 2.5 1.2 2.5 2.4s-.9 2-2 2.1" strokeWidth="0.95" />
            <path className="cup-stem" d="M12 13.6v2.3" />
            <path className="cup-foot" d="M9.6 18.1c0-1.3 1.1-2.2 2.4-2.2s2.4.9 2.4 2.2Z" />
            <path className="cup-base" d="M8.2 18.1h7.6M9 20.6h6" strokeWidth="1.1" />
            <path className="cup-plinth" d="M8.2 18.1v2.5h7.6v-2.5" strokeWidth="0.95" />
          </g>
        </svg>
      </button>

      <div className="slammenu-panel" id={panelId} role="group" aria-label="Tournament">
        <div className="slammenu-tour" role="group" aria-label="Tour">
          {(['men', 'women'] as Tour[]).map((t) => (
            <button
              key={t}
              type="button"
              className={`tour-btn${tour === t ? ' is-on' : ''}`}
              tabIndex={open ? 0 : -1}
              onClick={() => onTour(t)}
            >
              {t === 'men' ? "Men's" : "Women's"}
            </button>
          ))}
        </div>

        <ul className="slammenu-list">
          {slams.map((id, i) => {
            const t = themeFor(id);
            const on = slam === id;
            return (
              <li key={id} style={{ '--i': i } as React.CSSProperties}>
                <button
                  type="button"
                  className={`slam-btn${on ? ' is-on' : ''}`}
                  tabIndex={open ? 0 : -1}
                  aria-current={on ? 'true' : undefined}
                  style={
                    {
                      '--surface': t.ground,
                      '--heritage': t.heritage,
                      '--swatch': t.flare,
                    } as React.CSSProperties
                  }
                  onClick={() => {
                    onSlam(id);
                    setOpen(false);
                  }}
                >
                  <svg className="slam-court" viewBox="0 0 26 18" aria-hidden="true" focusable="false">
                    <rect className="slam-court-surround" x="0.5" y="0.5" width="25" height="17" rx="2.5" />
                    <rect className="slam-court-surface" x="4" y="2.6" width="18" height="12.8" rx="1" />
                    <g className="slam-court-lines">
                      <path d="M4 4.6h18M4 13.4h18" />
                      <path d="M7.4 4.6v8.8M18.6 4.6v8.8" />
                      <path d="M7.4 9h11.2" />
                      <path className="slam-court-net" d="M13 1.4v15.2" />
                    </g>
                  </svg>
                  <span className="slam-label">{t.label}</span>
                  <span className="slam-city">{t.city}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
