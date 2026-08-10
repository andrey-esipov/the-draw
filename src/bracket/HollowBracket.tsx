import { useMemo } from 'react';
import { buildGeometry, polar, ringRadius } from './geometry';
import { CENTER, SCALE, VIEW } from './Bracket';
import { emptyDraw } from '../data/form';
import type { SlamId } from '../data/types';
import type { SlamTheme } from '../ui/theme';

interface Props {
  slam: SlamId;
  theme: SlamTheme;
  /** Name shown at the centre once a pick is committed. */
  pickName: string | null;
}

/** The draw with nobody in it: the structure that is waiting. */
export function HollowBracket({ slam, theme, pickName }: Props) {
  const geo = useMemo(() => buildGeometry(emptyDraw(slam, ''), SCALE, CENTER), [slam]);

  return (
    <svg viewBox={`0 0 ${VIEW} ${VIEW}`} className="bracket is-hollow" role="img" aria-label="The 2026 US Open draw, not yet made">
      <defs>
        <filter id="hollowGlow" x="-600%" y="-600%" width="1300%" height="1300%">
          <feGaussianBlur stdDeviation="10" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <radialGradient id="hollowVeil">
          <stop offset="0%" stopColor={theme.groundDeep} stopOpacity={0.86} />
          <stop offset="52%" stopColor={theme.groundDeep} stopOpacity={0.72} />
          <stop offset="100%" stopColor={theme.groundDeep} stopOpacity={0} />
        </radialGradient>
      </defs>

      <g fill="none" stroke={theme.chalk} strokeOpacity={0.1}>
        {[1, 2, 3, 4, 5, 6, 7].map((r) => (
          <circle key={r} cx={CENTER.x} cy={CENTER.y} r={ringRadius(r) * SCALE} strokeWidth={0.6} />
        ))}
      </g>

      <g className="hollow-threads" fill="none" stroke={theme.chalk} strokeLinecap="round">
        {geo.edges.map((e, i) => (
          <path key={i} d={e.d} strokeWidth={0.9} strokeOpacity={0.36} />
        ))}
      </g>

      <g className="hollow-rim" fill={theme.chalk}>
        {geo.leaves.map((leaf) => {
          const p = polar(leaf.angleDeg, 1.018, SCALE, CENTER);
          return <circle key={leaf.index} cx={p.x} cy={p.y} r={1.6} fillOpacity={0.62} />;
        })}
      </g>

      <g className="hollow-core">
        <circle
          cx={CENTER.x}
          cy={CENTER.y}
          r={22}
          fill="none"
          stroke={theme.chalk}
          strokeOpacity={pickName ? 0.14 : 0.42}
          strokeWidth={1}
          strokeDasharray={pickName ? 'none' : '3 5'}
        />
        {pickName && (
          <circle cx={CENTER.x} cy={CENTER.y} r={4} fill={theme.flare} filter="url(#hollowGlow)" />
        )}
      </g>

      <circle cx={CENTER.x} cy={CENTER.y} r={112} fill="url(#hollowVeil)" pointerEvents="none" />
      {/* The veil has to darken the middle so the ask can be read, but a soft
          blob with no boundary reads as a render fault. This is its edge. */}
      <circle
        cx={CENTER.x}
        cy={CENTER.y}
        r={104}
        fill="none"
        stroke={theme.chalk}
        strokeOpacity={0.16}
        strokeWidth={0.8}
        pointerEvents="none"
      />

      {pickName ? (
        <text className="hollow-name" x={CENTER.x} y={CENTER.y + 52} textAnchor="middle" fill={theme.flare}>
          {pickName}
        </text>
      ) : (
        <g>
          <text className="hollow-ask" x={CENTER.x} y={CENTER.y + 44} textAnchor="middle" fill={theme.chalk}>
            PICK WHO REACHES HERE
          </text>
          <text className="hollow-hint" x={CENTER.x} y={CENTER.y + 80} textAnchor="middle" fill={theme.chalk}>
            Select a name from the season list
          </text>
        </g>
      )}
    </svg>
  );
}
