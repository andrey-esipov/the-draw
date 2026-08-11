import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Draw, Player } from '../data/types';

interface Props {
  draw: Draw;
  flare: string;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}

function fold(s: string) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Type any part of a name. 128 entrants is more than the eye should have to scan. */
export function Search({ draw, flare, onHover, onSelect }: Props) {
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const all = useMemo(() => {
    const seen = new Set<string>();
    const out: Player[] = [];
    for (const round of draw.rounds) {
      for (const match of round.matches) {
        for (const side of match.sides) {
          if (seen.has(side.player)) continue;
          seen.add(side.player);
          const p = draw.players[side.player];
          if (p) out.push(p);
        }
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [draw]);

  const hits = useMemo(() => {
    const q = fold(query.trim());
    if (!q) return [];
    return all.filter((p) => fold(p.name).includes(q)).slice(0, 7);
  }, [all, query]);

  useEffect(() => setCursor(0), [query]);

  const previewId = open && hits.length > 0 ? (hits[cursor]?.id ?? null) : null;
  useEffect(() => { onHover(previewId); }, [previewId, onHover]);
  useEffect(() => () => onHover(null), [onHover]);
  useEffect(() => { setQuery(''); setOpen(false); }, [draw.id]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  function commit(p: Player) {
    onSelect(p.id);
    setQuery(p.name);
    setOpen(false);
    onHover(null);
  }

  const listOpen = open && query.trim() !== '';
  const listboxId = `${searchId}-listbox`;
  const activeOptionId = listOpen && hits[cursor] ? `${searchId}-option-${hits[cursor].id}` : undefined;

  return (
    <div className="search" ref={boxRef} style={{ '--flare': flare } as React.CSSProperties}>
      <svg className="search-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M10.3 10.3 13.6 13.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      <input
        className="search-input"
        type="search"
        value={query}
        placeholder="Find a player"
        aria-label="Find a player in this draw"
        role="combobox"
        aria-expanded={listOpen}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId}
        autoComplete="off"
        spellCheck={false}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (hits.length > 0) {
              setOpen(true);
              setCursor((c) => Math.min(c + 1, hits.length - 1));
            }
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (hits.length > 0) {
              setOpen(true);
              setCursor((c) => Math.max(c - 1, 0));
            }
          } else if (e.key === 'Enter' && hits[cursor]) { e.preventDefault(); commit(hits[cursor]); }
          else if (e.key === 'Escape') {
            e.preventDefault();
            if (listOpen) setOpen(false);
            else setQuery('');
            onHover(null);
          }
        }}
      />

      {listOpen && (
        <ul id={listboxId} className="search-results" role="listbox" aria-label="Matching players">
          {hits.length === 0 && <li className="search-none">No one by that name in this draw</li>}
          {hits.map((p, i) => (
            <li key={p.id}>
              <button
                id={`${searchId}-option-${p.id}`}
                className={`search-hit${i === cursor ? ' is-cursor' : ''}`}
                role="option"
                aria-selected={i === cursor}
                onPointerEnter={() => setCursor(i)}
                onClick={() => commit(p)}
              >
                <span className="search-hit-name">{p.name}</span>
                {p.seed && <span className="search-hit-seed">Seed {p.seed}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
