import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Draw, SlamId } from './data/types';
import { indexDraw, upsetMatchIds } from './data/analysis';
import { buildGeometry } from './bracket/geometry';
import { Bracket, CENTER, SCALE } from './bracket/Bracket';
import { Broadcast } from './bracket/Broadcast';
import { Rail } from './ui/Rail';
import { Forthcoming } from './ui/Forthcoming';
import { HollowBracket } from './bracket/HollowBracket';
import { SLAM_ORDER, SLAM_ORDER_WOMEN, themeFor } from './ui/theme';
import { Search } from './ui/Search';
import { sound, SoundToggle } from './audio/sound';
import { SlamMenu } from './ui/SlamMenu';
import { Controls } from './ui/Controls';

type Tour = 'men' | 'women';

export function App() {
  const [slam, setSlam] = useState<SlamId>('wimbledon-men');
  const [tour, setTour] = useState<Tour>('men');
  const [draw, setDraw] = useState<Draw | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [prediction, setPrediction] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [view, setView] = useState<'board' | 'radial'>('board');
  const [playToken, setPlayToken] = useState(0);
  const [running, setRunning] = useState(false);

  const forthcoming = slam.startsWith('us-open');

  const handleHover = useCallback((id: string | null) => { if (id) sound.hover(); setHover(id); }, []);
  const handleSelect = useCallback((id: string) => { sound.select(); setPicked((p) => (p === id ? null : id)); }, []);

  useEffect(() => { sound.slamChange(); }, [slam]);

  useEffect(() => {
    setPicked(null);
    setHover(null);
    if (forthcoming) { setDraw(null); setLoadFailed(false); return; }
    let live = true;
    setLoadFailed(false);
    fetch(`${import.meta.env.BASE_URL}draws/${slam}.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`${slam} unavailable`);
        return r.json();
      })
      .then((d) => { if (live) setDraw(d); })
      .catch(() => { if (live) { setDraw(null); setLoadFailed(true); } });
    return () => { live = false; };
  }, [slam, forthcoming]);

  const geo = useMemo(() => (draw ? buildGeometry(draw, SCALE, CENTER) : null), [draw]);
  const index = useMemo(() => (draw ? indexDraw(draw) : null), [draw]);
  const theme = useMemo(() => themeFor(slam), [slam]);
  const upsets = useMemo(() => (index ? upsetMatchIds(index) : []), [index]);

  const activeId = hover ?? picked;
  const shownId = activeId ?? index?.champion?.id ?? null;
  const shown = shownId && draw ? (draw.players[shownId] ?? null) : null;

  const slams = tour === 'men' ? SLAM_ORDER : SLAM_ORDER_WOMEN;

  const handlePickMatch = useCallback(
    (matchId: string | null) => {
      if (!matchId || !draw) { setPicked(null); return; }
      for (const r of draw.rounds) {
        const m = r.matches.find((x) => x.id === matchId);
        if (m?.winner) { sound.select(); setPicked((p) => (p === m.winner ? null : m.winner!)); return; }
      }
    },
    [draw],
  );
  const handleRunEnd = useCallback(() => setRunning(false), []);

  return (
    <main
      className={`stage${view === 'radial' ? ' is-radial' : ''}${shown ? ' has-player-detail' : ''}${running ? ' is-running' : ''}`}
      style={
        {
          background: theme.groundDeep,
          color: theme.chalk,
          '--ground': theme.ground,
          '--ground-deep': theme.groundDeep,
        } as React.CSSProperties
      }
    >
      <div className="scrim" aria-hidden="true" />
      <header className="mark" style={{ '--flare': theme.flare } as React.CSSProperties}>
        <p className="mark-word">The Draw</p>
        <h1 className="mark-slam">{theme.label}</h1>
        <span className="mark-rule" aria-hidden="true" />
        <p className="mark-meta">
          2026 <span className="dot">·</span> {forthcoming ? 'Not yet drawn' : draw ? draw.event : ' '}
        </p>
      </header>

      <div className="cluster">
        <SoundToggle slam={slam} />
        <SlamMenu
          slam={slam}
          tour={tour}
          slams={slams}
          onSlam={setSlam}
          onTour={(t) => {
            setTour(t);
            setSlam(slam.replace(/-(men|women)$/, `-${t}`) as SlamId);
          }}
        />
      </div>

      {forthcoming && (
        <>
          <Forthcoming
            theme={theme}
            tour={tour}
            pick={prediction}
            onPick={(id, name) => { setPrediction(id); setPendingName(name); }}
          />
          <div className="field">
            <HollowBracket slam={slam} theme={theme} pickName={pendingName} />
          </div>
        </>
      )}

      {!forthcoming && !draw && !loadFailed && (
        <div className="rail">
          <p className="eyebrow">Loading</p>
          <h1 className="player-name">Reading the draw</h1>
        </div>
      )}

      {loadFailed && !forthcoming && (
        <div className="rail">
          <p className="eyebrow">Unavailable</p>
          <h1 className="player-name">This draw did not load</h1>
          <p className="forth-note">
            The data for this tournament could not be fetched, so nothing is shown rather
            than something approximate. Try another tournament.
          </p>
        </div>
      )}

      {draw && geo && index && (
        <>
          <Rail index={index} theme={theme} player={shown} traced={activeId !== null} />
          <div className="field">
            {view === 'board' ? (
              <Broadcast
                slam={slam}
                draw={draw}
                theme={theme}
                lit={shownId}
                playToken={playToken}
                onPick={handlePickMatch}
                onRunEnd={handleRunEnd}
              />
            ) : (
              <Bracket
                draw={draw}
                geo={geo}
                theme={theme}
                upsets={upsets}
                championId={index.champion?.id ?? null}
                activeId={activeId}
                focused={activeId !== null}
                onHoverPlayer={(id) => { if (id) sound.hover(); setHover(id); }}
                onSelectPlayer={(id) => { sound.select(); setPicked((p) => (p === id ? null : id)); }}
              />
            )}
          </div>

          <div className="viewbar">
            <button
              type="button"
              className="run"
              disabled={running || !shownId}
              onClick={() => { setRunning(true); setPlayToken((n) => n + 1); }}
            >
              <span className="run-glyph" aria-hidden="true" />
              {running ? 'Running the draw' : 'Run the draw'}
            </button>
            <div className="viewswap" role="group" aria-label="View">
              <button
                type="button"
                className={view === 'board' ? 'on' : ''}
                onClick={() => setView('board')}
              >
                Board
              </button>
              <button
                type="button"
                className={view === 'radial' ? 'on' : ''}
                onClick={() => setView('radial')}
              >
                Radial
              </button>
            </div>
          </div>
        </>
      )}

      {!forthcoming && draw && view === 'board' && <Controls />}

      {!forthcoming && draw && view === 'radial' && (
        <div className="legend">
          <span className="legend-item">
            <svg className="legend-glyph" viewBox="0 0 30 10" aria-hidden="true">
              <path d="M1 4.7 Q15 4.4 29 2.2 L29 7.8 Q15 5.6 1 5.3 Z" fill="currentColor" />
            </svg>
            Thicker thread, more decisive the win
          </span>
          <span className="legend-item">
            <svg className="legend-glyph" viewBox="0 0 12 12" aria-hidden="true">
              <circle cx="6" cy="6" r="3.4" stroke="currentColor" strokeWidth="1" fill="none" />
            </svg>
            A seed falling early
          </span>
          <span className="legend-item legend-act">Hover or search any name to trace all seven rounds</span>
        </div>
      )}

      {!forthcoming && draw && (
        <p className="compact-note">Search a name to trace their tournament</p>
      )}

      {!forthcoming && draw && (
        <Search
          draw={draw}
          flare={theme.flare}
          onHover={handleHover}
          onSelect={handleSelect}
        />
      )}
    </main>
  );
}
