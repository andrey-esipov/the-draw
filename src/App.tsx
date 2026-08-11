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
import { drawControlsBus } from './three/controls';
import { bootDone } from './boot';
import { TitleScreen } from './title/TitleScreen';

type Tour = 'men' | 'women';

/** `?enter=1` walks straight onto the board, which is what the capture rigs want. */
const SKIP_TITLE =
  new URLSearchParams(window.location.search).has('enter') ||
  new URLSearchParams(window.location.search).has('slam');

/**
 * Whether this machine can render the 3D board at all.
 *
 * Most of the piece is WebGL, and on a machine without it — a locked-down
 * corporate laptop, a browser with hardware acceleration switched off, a VM —
 * every canvas in it renders nothing and the whole thing is a black screen with
 * some type on it. The Radial view is SVG and shows all 128 positions, so there
 * is a real draw to fall back to rather than an apology. Checked once, up front,
 * because the answer cannot change within a page load.
 */
const HAS_WEBGL = (() => {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
})();

export function App() {
  const [slam, setSlam] = useState<SlamId>('wimbledon-men');
  const [titled, setTitled] = useState(!SKIP_TITLE && HAS_WEBGL);
  const [handedOver, setHandedOver] = useState(false);
  const [cameFromTitle, setCameFromTitle] = useState(false);
  const [tour, setTour] = useState<Tour>('men');
  const [draw, setDraw] = useState<Draw | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [prediction, setPrediction] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [view, setView] = useState<'board' | 'radial'>(HAS_WEBGL ? 'board' : 'radial');
  const [playToken, setPlayToken] = useState(0);
  const [running, setRunning] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  const [flown, setFlown] = useState(false);

  const forthcoming = slam.startsWith('us-open');

  const handleHover = useCallback((id: string | null) => { if (id) sound.hover(); setHover(id); }, []);
  // Committing a name from search is never a toggle: you asked for that player,
  // so they get traced and the camera goes to them.
  const handleSelect = useCallback((id: string) => {
    sound.select();
    setPicked(id);
    setFocusToken((n) => n + 1);
  }, []);

  useEffect(() => { sound.slamChange(); }, [slam]);

  // The masthead owns the frame only while the board is at rest. The moment the
  // viewer takes the camera the title is sitting on top of the very cards they
  // flew in to read, so it stands down to a corner lockup.
  useEffect(() => {
    let drop: (() => void) | undefined;
    const attach = () => {
      drop?.();
      drop = drawControlsBus.current?.watchFirstMove(() => setFlown(true));
    };
    attach();
    const off = drawControlsBus.subscribe(attach);
    return () => { drop?.(); off(); };
  }, []);

  useEffect(() => { setFlown(false); }, [slam, view]);

  // The board lifts the hold itself on its first rendered frame. Every other
  // landing — the radial view, a tournament not yet drawn, a draw that failed
  // to load — has to say so rather than hold a visitor on a splash.
  useEffect(() => {
    if (view !== 'board' || forthcoming || loadFailed) bootDone();
  }, [view, forthcoming, loadFailed]);

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

  const handleEnter = useCallback((next: SlamId) => {
    setSlam(next);
    setTour(next.endsWith('-women') ? 'women' : 'men');
    setTitled(false);
    setCameFromTitle(true);
    // The title screen hands over at full wash. This side picks it up at full
    // wash too and takes it off the arriving board, so the two renderers swap
    // under cover rather than cutting.
    setHandedOver(true);
    // The veil times itself now (a CSS animation, which starts on its own first
    // painted frame), so all that is left here is to stop rendering it once it
    // is done. Generous, because it only removes an already-invisible element.
    window.setTimeout(() => setHandedOver(false), 1500);
  }, []);

  if (titled) return <TitleScreen onEnter={handleEnter} />;

  return (
    <main
      className={`stage${view === 'radial' ? ' is-radial' : ''}${shown ? ' has-player-detail' : ''}${running ? ' is-running' : ''}${flown && view === 'board' ? ' is-flown' : ''}`}
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
      {handedOver && <div className="handoff" aria-hidden="true" />}
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
                focusToken={focusToken}
                onPick={handlePickMatch}
                onRunEnd={handleRunEnd}
                settled={cameFromTitle}
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
              {/* Without WebGL the Board renders nothing, so offering it as a
                  choice would be offering a black screen. The whole control
                  goes, not just the one button: a swap with one option left in
                  it is a toggle with nothing to toggle to. */}
              {HAS_WEBGL && (
                <>
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
                </>
              )}
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
