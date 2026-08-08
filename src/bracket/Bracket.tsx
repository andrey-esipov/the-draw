import { useEffect, useMemo, useRef, useState } from 'react';
import { useReveal } from '../motion/useReveal';
import type { Draw } from '../data/types';
import type { DrawGeometry } from './geometry';
import { polar, ringRadius } from './geometry';
import type { SlamTheme } from '../ui/theme';

export const VIEW = 1200;
export const CENTER = { x: VIEW / 2, y: VIEW / 2 };
export const SCALE = 448;

/** Base stroke weight per round survived. Threads thicken as the field thins. */
const WEIGHT = [0, 0.62, 0.86, 1.16, 1.58, 2.15, 2.95, 3.9, 4.7];
const ALPHA = [0, 0.42, 0.53, 0.65, 0.77, 0.88, 0.96, 1, 1];
const RING_LABEL = ['', 'R1', 'R2', 'R3', 'R4', 'QF', 'SF', 'F'];

/** The name that belongs at the centre: what a crowd would actually shout. */
function surname(name: string) {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ') : name;
}

interface Props {
  upsets: string[];
  draw: Draw;
  geo: DrawGeometry;
  theme: SlamTheme;
  championId: string | null;
  activeId: string | null;
  /** True while a player is deliberately picked out, which ghosts the rest of the field. */
  focused: boolean;
  onHoverPlayer: (id: string | null) => void;
  onSelectPlayer: (id: string) => void;
}

export function Bracket({
  draw,
  geo,
  theme,
  upsets,
  championId,
  activeId,
  focused,
  onHoverPlayer,
  onSelectPlayer,
}: Props) {
  const edges = useMemo(() => [...geo.edges].sort((a, b) => a.round - b.round), [geo]);
  const litId = activeId ?? championId;
  const litEdges = useMemo(() => edges.filter((e) => e.player === litId && e.advanced), [edges, litId]);
  const exit = litEdges[litEdges.length - 1];
  /** Gold is the title. Anyone else being followed is traced in ivory, over a dimmed champion route. */
  const isChampion = litId !== null && litId === championId;
  const litColor = isChampion ? theme.flare : theme.trace;
  const ghostEdges = useMemo(
    () => (isChampion ? [] : edges.filter((e) => e.player === championId && e.advanced)),
    [edges, championId, isChampion],
  );
  /** Push the label outward along its own radius so it never lands on the medallion. */
  const exitPoint = useMemo(() => {
    if (!exit || isChampion) return null;
    const p = geo.matches.get(exit.matchId)?.point;
    if (!p) return null;
    const dx = p.x - CENTER.x;
    const dy = p.y - CENTER.y;
    const len = Math.hypot(dx, dy) || 1;
    const out = 46;
    const lx = p.x + (dx / len) * out;
    const ly = p.y + (dy / len) * out + 5;
    return { ...p, lx, ly, anchor: 'middle' as const };
  }, [exit, isChampion, geo]);

  const exitNote = useMemo(() => {
    if (!exit || isChampion) return null;
    const round = draw.rounds.find((r) => r.round === exit.round);
    const match = round?.matches.find((m) => m.id === exit.matchId);
    const next = draw.rounds.find((r) => r.round === exit.round + 1);
    const beaten = next?.matches.find((m) => m.sides.some((sd) => sd.player === litId));
    const winner = beaten?.winner ? draw.players[beaten.winner] : null;
    if (!match || !winner) return null;
    return `${RING_LABEL[exit.round + 1] ?? ''} · lost to ${surname(winner.name)}`;
  }, [exit, isChampion, draw, litId]);
  const svgRef = useRef<SVGSVGElement>(null);
  useReveal(svgRef, draw.id);

  const seats = useMemo(() => geo.leaves.filter((l) => l.player), [geo]);
  const [seat, setSeat] = useState(0);
  const [rimFocus, setRimFocus] = useState(false);
  const rimRef = useRef<SVGGElement>(null);

  useEffect(() => setSeat(0), [draw.id]);

  useEffect(() => {
    const el = rimRef.current;
    if (!el || document.activeElement !== el) return;
    const id = seats[seat]?.player ?? null;
    onHoverPlayer(id);
  }, [seat, seats, onHoverPlayer]);

  return (
    <>
    {rimFocus && (
      <p className="rim-cue">Arrow keys walk the draw <span className="dot">·</span> Enter pins a player</p>
    )}
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      className={`bracket${focused ? ' is-focused' : ''}`}
      role="img"
      aria-label={`${draw.tournament} ${draw.year} ${draw.event}: the full 128-player draw`}
    >
      <defs>
        <filter id="flareGlow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="coreGlow" x="-600%" y="-600%" width="1300%" height="1300%">
          <feGaussianBlur stdDeviation="12" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <radialGradient id="coreVeil">
          <stop offset="0%" stopColor={theme.groundDeep} stopOpacity={0.72} />
          <stop offset="46%" stopColor={theme.groundDeep} stopOpacity={0.6} />
          <stop offset="100%" stopColor={theme.groundDeep} stopOpacity={0} />
        </radialGradient>
      </defs>

      <g className="rings" fill="none" stroke={theme.chalk} strokeOpacity={0.06}>
        {[1, 2, 3, 4, 5, 6, 7].map((r) => (
          <circle key={r} cx={CENTER.x} cy={CENTER.y} r={ringRadius(r) * SCALE} strokeWidth={0.6} />
        ))}
      </g>

      <g className="ring-labels" fill={theme.chalkDim}>
        {/* The last two rings sit under the champion's name, which says it better. */}
        {[1, 2, 3, 4, 5].map((r) => (
          <text
            key={r}
            className="ring-label"
            x={CENTER.x}
            y={CENTER.y - ringRadius(r) * SCALE}
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {RING_LABEL[r]}
          </text>
        ))}
      </g>

      <g className="threads" fill="none" strokeLinecap="round">
        {edges.map((e, i) => (
          <path
            key={i}
            className="thread"
            data-round={e.round}
            d={e.d}
            stroke={theme.chalk}
            strokeOpacity={(e.advanced ? ALPHA[e.round]! : ALPHA[e.round]! * 0.5) * 0.8}
            strokeWidth={WEIGHT[e.round]! * (e.advanced ? e.weight : e.weight * 0.72)}
          />
        ))}
      </g>

      <g className="ghost-lit" fill="none" strokeLinecap="round" filter="url(#flareGlow)">
        {ghostEdges.map((e) => (
          <path
            key={`g-${e.matchId}-${e.side}`}
            d={e.d}
            stroke={theme.flare}
            strokeOpacity={0.28}
            strokeWidth={Math.max(2.2, WEIGHT[e.round]! * e.weight * 1.2)}
          />
        ))}
      </g>

      <g className="lit" fill="none" strokeLinecap="round" filter="url(#flareGlow)">
        {litEdges.map((e) => (
          <path
            key={`${e.matchId}-${e.side}`}
            className="lit-thread"
            d={e.d}
            stroke={litColor}
            strokeWidth={Math.max(2.9, WEIGHT[e.round]! * e.weight * 1.5)}
          />
        ))}
      </g>

      {exit && !isChampion && exitPoint && (
        <g className="exit-mark">
          <circle cx={exitPoint.x} cy={exitPoint.y} r={3.4} fill={theme.trace} />
          {exitNote && (
            <text
              className="exit-note"
              x={exitPoint.lx}
              y={exitPoint.ly}
              textAnchor={exitPoint.anchor}
              fill={theme.trace}
            >
              {exitNote}
            </text>
          )}
        </g>
      )}

      <g className="upsets" fill="none" stroke={theme.chalk}>
        {upsets.map((id) => {
          const m = geo.matches.get(id)!;
          return <circle key={id} className="upset" cx={m.point.x} cy={m.point.y} r={3.6} strokeWidth={0.9} />;
        })}
      </g>

      <g className="rim-ticks" fill={theme.chalk}>
        {geo.leaves.map((leaf) => {
          if (!leaf.player) return null;
          const p = polar(leaf.angleDeg, 1.02, SCALE, CENTER);
          const lit = leaf.player === litId;
          return (
            <circle
              key={leaf.index}
              cx={p.x}
              cy={p.y}
              r={lit ? 3 : 1.5}
              fill={lit ? theme.flare : theme.chalk}
              fillOpacity={lit ? 1 : draw.players[leaf.player]?.seed ? 0.5 : 0.25}
            />
          );
        })}
      </g>

      <g
        className="rim"
        ref={rimRef}
        tabIndex={0}
        role="listbox"
        aria-label="Entrants, in draw order. Use arrow keys."
        aria-activedescendant={seats[seat] ? `seat-${seats[seat].index}` : undefined}
        onFocus={() => { setRimFocus(true); onHoverPlayer(seats[seat]?.player ?? null); }}
        onBlur={() => { setRimFocus(false); onHoverPlayer(null); }}
        onKeyDown={(e) => {
          const n = seats.length;
          if (n === 0) return;
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); setSeat((i) => (i + 1) % n); }
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); setSeat((i) => (i - 1 + n) % n); }
          else if (e.key === 'Home') { e.preventDefault(); setSeat(0); }
          else if (e.key === 'End') { e.preventDefault(); setSeat(n - 1); }
          else if (e.key === 'Enter' || e.key === ' ') {
            const id = seats[seat]?.player;
            if (id) { e.preventDefault(); onSelectPlayer(id); }
          }
        }}
      >
        {geo.leaves.map((leaf) => {
          if (!leaf.player) return null;
          const player = draw.players[leaf.player];
          if (!player) return null;
          const p = polar(leaf.angleDeg, 1.024, SCALE, CENTER);
          const flip = Math.cos((leaf.angleDeg * Math.PI) / 180) < 0;
          const lit = leaf.player === litId;
          return (
            <text
              key={leaf.index}
              id={`seat-${leaf.index}`}
              role="option"
              aria-selected={lit}
              x={p.x}
              y={p.y}
              className={`rim-name${player.seed ? ' is-seed' : ''}${lit ? ' is-lit' : ''}`}
              fill={lit ? theme.flare : player.seed ? theme.chalk : theme.chalkDim}
              textAnchor={flip ? 'end' : 'start'}
              dominantBaseline="middle"
              transform={`rotate(${flip ? leaf.angleDeg + 180 : leaf.angleDeg} ${p.x} ${p.y})`}
              onPointerEnter={() => onHoverPlayer(leaf.player)}
              onPointerLeave={() => onHoverPlayer(null)}
              onClick={() => onSelectPlayer(leaf.player!)}
            >
              {player.short}
            </text>
          );
        })}
      </g>

      <g className="core">
        <circle
          cx={CENTER.x}
          cy={CENTER.y}
          r={ringRadius(7) * SCALE * 0.66}
          fill="none"
          stroke={theme.flare}
          strokeOpacity={0.28}
          strokeWidth={0.7}
        />
        <circle
          className="core-dot"
          cx={CENTER.x}
          cy={CENTER.y}
          r={4}
          fill={theme.flare}
          filter="url(#coreGlow)"
        />
        <circle className="core-veil" cx={CENTER.x} cy={CENTER.y} r={104} fill="url(#coreVeil)" />
        {championId && draw.players[championId] && (
          <g className="core-name">
            <text x={CENTER.x} y={CENTER.y - 34} textAnchor="middle" fill={theme.flare} className="core-title">
              CHAMPION
            </text>
            <text x={CENTER.x} y={CENTER.y + 38} textAnchor="middle" fill={theme.chalk} className="core-surname">
              {surname(draw.players[championId]!.name)}
            </text>
          </g>
        )}
      </g>
    </svg>
    </>
  );
}
