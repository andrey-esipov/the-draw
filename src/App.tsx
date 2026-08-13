import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Draw, SlamId } from './data/types';
import { indexDraw, upsetMatchIds } from './data/analysis';
import { buildGeometry } from './bracket/geometry';
import { Bracket, CENTER, SCALE } from './bracket/Bracket';
import { Broadcast } from './bracket/Broadcast';
import { Rail } from './ui/Rail';
import { DRAW_DATE_SHORT, Forthcoming } from './ui/Forthcoming';
import { HollowBracket } from './bracket/HollowBracket';
import { SLAM_ORDER, SLAM_ORDER_WOMEN, themeFor } from './ui/theme';
import { Search } from './ui/Search';
import { sound, SoundToggle } from './audio/sound';
import { SlamMenu } from './ui/SlamMenu';
import { Controls } from './ui/Controls';
import { drawControlsBus } from './three/controls';
import { bootDone } from './boot';
import { TitleScreen } from './title/TitleScreen';
import { LeagueShell } from './ui/LeagueShell';
import {
  loadLeagueAccess,
  parseCapabilityFragment,
  type LeagueAccessState,
} from './data/league-api';
import { leagueSlam } from './data/league-visual';
import { useDeferredLowPowerTier } from './performance-tier';
import { blankDraw, emptyDraw } from './data/form';
import { DrawIcon } from './ui/DrawIcon';
import {
  createLeaguePreviewDraw,
  createLeaguePreviewFetch,
  type LeaguePreviewMode,
} from './data/league-preview';

type Tour = 'men' | 'women';

function eventSlugFor(slam: SlamId, tour: Tour): string {
  return `${slam.replace(/-(men|women)$/, '')}-2026-${tour}`;
}

/** `?enter=1` walks straight onto the board, which is what the capture rigs want. */
const SKIP_TITLE =
  new URLSearchParams(window.location.search).has('enter') ||
  new URLSearchParams(window.location.search).has('slam');

/**
 * `?slam=` opens straight onto one draw.
 *
 * It used to be read only as a reason to skip the title and was then thrown
 * away, so every such link — including the ones the capture rigs run on —
 * quietly served Wimbledon whatever it asked for. A parameter that is accepted
 * and ignored is worse than one that is rejected: it answers confidently with
 * the wrong tournament. Both the full id and the bare tournament are taken, so
 * `?slam=australian-open` and `?slam=australian-open-women` both work, and
 * anything unrecognised falls back rather than opening a draw at random.
 */
const SLAM_PARAM: SlamId | null = (() => {
  const raw = new URLSearchParams(window.location.search).get('slam');
  if (!raw) return null;
  const want = raw.trim().toLowerCase();
  const all = [...SLAM_ORDER, ...SLAM_ORDER_WOMEN];
  return all.find((id) => id === want) ?? all.find((id) => id === `${want}-men`) ?? null;
})();

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
const LOCAL_LEAGUE_PREVIEW =
  import.meta.env.DEV && new URLSearchParams(window.location.search).has('league-preview');
const LOCAL_LEAGUE_PREVIEW_MODE: LeaguePreviewMode | null = (() => {
  if (!LOCAL_LEAGUE_PREVIEW) return null;
  const value = new URLSearchParams(window.location.search).get('league-preview');
  if (value === 'awaiting' || value === 'open' || value === 'live') return value;
  return 'auto';
})();
const LEAGUE_CREATION_AVAILABLE =
  import.meta.env.VITE_DRAW_LEAGUES_ENABLED === 'true' || LOCAL_LEAGUE_PREVIEW;

function useLowPowerTier(): boolean {
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
  const [lowPower, setLowPower] = useState(saveData);

  useEffect(() => {
    if (saveData) return;
    let frame = 0;
    let slowStreak = 0;
    let previous = performance.now();
    let raf = 0;
    const measure = (now: number) => {
      const frameTime = now - previous;
      previous = now;
      frame += 1;
      if (frame > 12) slowStreak = frameTime > 24 ? slowStreak + 1 : Math.max(0, slowStreak - 2);
      if (slowStreak >= 45) setLowPower(true);
      else if (frame < 180) raf = requestAnimationFrame(measure);
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [saveData]);

  return lowPower;
}

export function App() {
  const [capabilityBootstrap, setCapabilityBootstrap] = useState(() => parseCapabilityFragment(window.location.hash));
  const [leagueAccess, setLeagueAccess] = useState<LeagueAccessState | null>(() => (
    capabilityBootstrap.kind === 'invalid' ? { kind: 'invalid-access' }
      : capabilityBootstrap.kind === 'capability' ? { kind: 'loading' }
        : null
  ));
  const [slam, setSlam] = useState<SlamId>(SLAM_PARAM ?? 'wimbledon-men');
  const [titled, setTitled] = useState(!SKIP_TITLE && HAS_WEBGL);
  const [handedOver, setHandedOver] = useState(false);
  const [cameFromTitle, setCameFromTitle] = useState(false);
  const [tour, setTour] = useState<Tour>(SLAM_PARAM?.endsWith('-women') ? 'women' : 'men');
  const [draw, setDraw] = useState<Draw | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [prediction, setPrediction] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [drawAwaiting, setDrawAwaiting] = useState(false);
  const [view, setView] = useState<'board' | 'radial'>(
    HAS_WEBGL && !window.matchMedia('(max-width: 700px)').matches ? 'board' : 'radial',
  );
  const [playToken, setPlayToken] = useState(0);
  const [running, setRunning] = useState(false);
  const [landed, setLanded] = useState(false);
  // Which board the viewer came back off, so the title can reverse that walk.
  const [returnedFrom, setReturnedFrom] = useState<SlamId | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [flown, setFlown] = useState(false);
  const detectedLowPower = useLowPowerTier();
  const lowPower = useDeferredLowPowerTier(detectedLowPower, running);
  const [leagueVisual, setLeagueVisual] = useState<{ draw: Draw; playerId: string | null } | null>(null);
  const previewEventSlug = eventSlugFor(slam, tour);
  const explicitPreviewDraw = useMemo(
    () => LOCAL_LEAGUE_PREVIEW_MODE === 'open' || LOCAL_LEAGUE_PREVIEW_MODE === 'live'
      ? createLeaguePreviewDraw(previewEventSlug)
      : null,
    [previewEventSlug],
  );
  const previewTransportDraw = LOCAL_LEAGUE_PREVIEW_MODE === 'auto' ? draw : explicitPreviewDraw;
  const effectivePreviewMode: LeaguePreviewMode | null = LOCAL_LEAGUE_PREVIEW_MODE === 'auto'
    ? (draw ? 'open' : 'awaiting')
    : LOCAL_LEAGUE_PREVIEW_MODE;
  const previewFetcher = useMemo(
    () => LOCAL_LEAGUE_PREVIEW_MODE
      ? createLeaguePreviewFetch(previewTransportDraw, previewEventSlug, effectivePreviewMode ?? 'awaiting')
      : undefined,
    [effectivePreviewMode, previewEventSlug, previewTransportDraw],
  );
  const handleLeagueVisualChange = useCallback((nextDraw: Draw | null, playerId: string | null) => {
    setLeagueVisual(nextDraw ? { draw: nextDraw, playerId } : null);
  }, []);
  const handleCapabilityChange = useCallback((capability: { kind: 'invitation' | 'participant'; token: string }) => {
    const url = new URL(window.location.href);
    url.hash = `${capability.kind === 'invitation' ? 'invite' : 'return'}=${capability.token}`;
    window.history.replaceState(window.history.state, '', url);
    setCapabilityBootstrap({ kind: 'capability', capability });
  }, []);

  const upcoming = slam.startsWith('us-open');
  const forthcoming = upcoming && drawAwaiting;

  useEffect(() => {
    const syncCapability = () => {
      const next = parseCapabilityFragment(window.location.hash);
      setCapabilityBootstrap(next);
      setLeagueVisual(null);
      setLeagueAccess(
        next.kind === 'invalid' ? { kind: 'invalid-access' }
          : next.kind === 'capability' ? { kind: 'loading' }
            : null,
      );
    };
    window.addEventListener('hashchange', syncCapability);
    return () => window.removeEventListener('hashchange', syncCapability);
  }, []);

  useEffect(() => {
    if (capabilityBootstrap.kind !== 'capability') return;
    let live = true;
    loadLeagueAccess(capabilityBootstrap.capability, previewFetcher).then((state) => {
      if (live) setLeagueAccess(state);
    });
    return () => { live = false; };
  }, [capabilityBootstrap, previewFetcher]);

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

  useEffect(() => { setFlown(false); setLanded(false); }, [slam, view]);

  // The board lifts the hold itself on its first rendered frame. Every other
  // landing — the radial view, a tournament not yet drawn, a draw that failed
  // to load — has to say so rather than hold a visitor on a splash.
  useEffect(() => {
    if (view !== 'board' || forthcoming || loadFailed) bootDone();
  }, [view, forthcoming, loadFailed]);

  useEffect(() => {
    setPicked(null);
    setHover(null);
    let live = true;
    setDraw(null);
    setDrawAwaiting(false);
    setLoadFailed(false);
    const load = async (): Promise<Draw | null> => {
      if (LOCAL_LEAGUE_PREVIEW_MODE === 'awaiting') return null;
      if (LOCAL_LEAGUE_PREVIEW_MODE === 'open' || LOCAL_LEAGUE_PREVIEW_MODE === 'live') {
        return explicitPreviewDraw;
      }
      if (upcoming) {
        const eventSlug = eventSlugFor(slam, tour);
        try {
          const response = await fetch(`/api/draw/events/${encodeURIComponent(eventSlug)}`, {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          });
          if (
            response.ok
            && response.headers.get('content-type')?.includes('application/json')
          ) {
            const availability = await response.json() as
              | { state: 'awaiting' }
              | { state: 'ready'; draw: Draw };
            if (availability.state === 'awaiting') return null;
            if (availability.state === 'ready' && availability.draw) return availability.draw;
          }
          if (!import.meta.env.DEV) throw new Error(`${slam} availability unavailable`);
        } catch (error) {
          if (!import.meta.env.DEV) throw error;
        }
      }
      const response = await fetch(`${import.meta.env.BASE_URL}draws/${slam}.json`, {
        headers: { Accept: 'application/json' },
      });
      if (response.status === 404 && upcoming) return null;
      if (!response.ok) throw new Error(`${slam} unavailable`);
      if (upcoming && !response.headers.get('content-type')?.includes('application/json')) return null;
      return response.json() as Promise<Draw>;
    };
    void load()
      .then((d) => {
        if (!live) return;
        setDraw(d);
        setDrawAwaiting(d === null && upcoming);
      })
      .catch(() => {
        if (live) {
          setDraw(null);
          setDrawAwaiting(false);
          setLoadFailed(true);
        }
      });
    return () => { live = false; };
  }, [explicitPreviewDraw, slam, tour, upcoming]);

  const privateSlam = leagueAccess ? leagueSlam(leagueAccess) : null;
  const isLeagueEntry = leagueAccess?.kind === 'create' && leagueVisual === null;
  const entryPreviewDraw = useMemo(() => {
    if (!isLeagueEntry) return null;
    return draw ? blankDraw(draw) : emptyDraw(slam, `${themeFor(slam).label} ${tour === 'men' ? "men's" : "women's"} singles`);
  }, [draw, isLeagueEntry, slam, tour]);
  useEffect(() => {
    if (!isLeagueEntry || !HAS_WEBGL || !window.matchMedia('(max-width: 900px)').matches) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => drawControlsBus.current?.frame('final'));
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [isLeagueEntry]);
  const visualDraw = leagueAccess ? leagueVisual?.draw ?? entryPreviewDraw : draw;
  const geo = useMemo(() => (visualDraw ? buildGeometry(visualDraw, SCALE, CENTER) : null), [visualDraw]);
  const index = useMemo(() => (visualDraw ? indexDraw(visualDraw) : null), [visualDraw]);
  const theme = useMemo(() => {
    const base = themeFor(privateSlam ?? slam);
    if (!leagueAccess || privateSlam) return base;
    return {
      ...base,
      ground: '#18211d',
      groundDeep: '#07110d',
      chalk: '#edf1e8',
      chalkDim: '#aab5ac',
      flare: '#d8c56a',
      flareGlow: '#bfa53f',
      trace: '#c4cec6',
      heritage: '#66746b',
      rim: '#849087',
      fog: '#050b08',
      label: 'Draw Room',
      city: '',
    };
  }, [leagueAccess, privateSlam, slam]);
  const upsets = useMemo(() => (index ? upsetMatchIds(index) : []), [index]);

  const activeId = hover ?? picked;
  const shownId = activeId ?? index?.champion?.id ?? null;
  const shown = shownId && visualDraw ? (visualDraw.players[shownId] ?? null) : null;

  const slams = tour === 'men' ? SLAM_ORDER : SLAM_ORDER_WOMEN;
  const localPreviewHref = useMemo(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('slam', slam);
    url.searchParams.set('league-preview', 'open');
    return url.toString();
  }, [slam]);
  const localPreviewModeHref = useCallback((mode: LeaguePreviewMode) => {
    const url = new URL(window.location.href);
    url.searchParams.set('slam', slam);
    url.searchParams.set('league-preview', mode);
    const capability = capabilityBootstrap.kind === 'capability'
      ? capabilityBootstrap.capability
      : { kind: 'participant' as const, token: 'local-preview-participant' };
    url.hash = `${capability.kind === 'invitation' ? 'invite' : 'return'}=${capability.token}`;
    return url.toString();
  }, [capabilityBootstrap, slam]);

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
  // The title screen is the piece's front door, and until now it was a one-way
  // one: once you were on a board the only way to another slam was the trophy
  // menu, and there was no way back to the four cups at all. The wordmark is the
  // way home, which is where a wordmark always goes.
  const goHome = useCallback(() => {
    setReturnedFrom(slam);
    setTitled(true);
    setHandedOver(false);
    setLanded(false);
    setFlown(false);
    setRunning(false);
    setPicked(null);
    setPrediction(null);
    setPendingName(null);
    setView(HAS_WEBGL ? 'board' : 'radial');
  }, [slam]);

  const handleRunEnd = useCallback(() => {
    setRunning(false);
    setLanded(true);
  }, []);

  // The run lands tight on the trophy with the champion engraved on it. That
  // frame is the one moment the piece is built to be remembered by, and every
  // standing control was printed across it: the search, the whole camera rack,
  // the run button, the view toggle, the corner icons. A signature that
  // resolves into the same busy screen as everywhere else throws away its own
  // climax, so the chrome stays down after the run and the trophy holds the
  // frame alone. Anything the viewer does brings it straight back.
  useEffect(() => {
    if (!landed) return;
    const wake = () => setLanded(false);
    // Pointer movement counts too, after a grace window: the board answers a
    // hover by tracing that player's route, so the chrome should already be
    // back by the time anyone is reading it. The delay keeps an idle mouse from
    // cutting the arrival short.
    const at = performance.now();
    const wakeOnMove = () => { if (performance.now() - at > 1400) setLanded(false); };
    const opts = { passive: true } as const;
    window.addEventListener('pointerdown', wake, opts);
    window.addEventListener('wheel', wake, opts);
    window.addEventListener('keydown', wake, opts);
    window.addEventListener('touchstart', wake, opts);
    window.addEventListener('pointermove', wakeOnMove, opts);
    return () => {
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('wheel', wake);
      window.removeEventListener('keydown', wake);
      window.removeEventListener('touchstart', wake);
      window.removeEventListener('pointermove', wakeOnMove);
    };
  }, [landed]);

  const handleEnter = useCallback((next: SlamId) => {
    setReturnedFrom(null);
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

  if (titled && !leagueAccess) return <TitleScreen onEnter={handleEnter} returnFrom={returnedFrom} />;

  return (
    <main
      className={`stage${view === 'radial' ? ' is-radial' : ''}${shown ? ' has-player-detail' : ''}${running ? ' is-running' : ''}${landed ? ' is-landed' : ''}${flown && view === 'board' ? ' is-flown' : ''}${leagueAccess ? ' has-league' : ''}${isLeagueEntry ? ' is-league-entry' : ''}${lowPower ? ' is-low-power' : ''}`}
      style={
        {
          background: theme.groundDeep,
          color: theme.chalk,
          '--ground': theme.ground,
          '--ground-deep': theme.groundDeep,
          '--chalk': theme.chalk,
          '--chalk-dim': theme.chalkDim,
          '--flare': theme.flare,
        } as React.CSSProperties
      }
    >
      <div className="scrim" aria-hidden="true" />
      {handedOver && <div className="handoff" aria-hidden="true" />}
      <header className="mark" style={{ '--flare': theme.flare } as React.CSSProperties}>
        {HAS_WEBGL && (!leagueAccess || isLeagueEntry) ? (
          <button
            type="button"
            className="mark-word mark-home"
            aria-label={isLeagueEntry ? `Back to the ${theme.label} draw` : undefined}
            onClick={() => {
              if (isLeagueEntry) {
                setLeagueAccess(null);
                setLeagueVisual(null);
              } else {
                goHome();
              }
            }}
          >
            The Draw
          </button>
        ) : (
          <p className="mark-word">The Draw</p>
        )}
        <h1 className="mark-slam">{theme.label}</h1>
        <span className="mark-rule" aria-hidden="true" />
        <p className="mark-meta">
          {leagueAccess
            ? privateSlam
              ? <>2026 <span className="dot">·</span> {privateSlam.endsWith('-women') ? "Women's singles" : "Men's singles"}</>
              : 'Private league'
            : <>2026 <span className="dot">·</span>{' '}{forthcoming ? `Draw out ${DRAW_DATE_SHORT}` : draw ? draw.event : ' '}</>}
        </p>
      </header>

      <div className="cluster">
        <SoundToggle slam={slam} />
        {!leagueAccess && (
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
        )}
      </div>

      {LEAGUE_CREATION_AVAILABLE && !leagueAccess && (
        <button
          type="button"
          className="league-launch"
          onClick={() => setLeagueAccess({
            kind: 'create',
            eventSlug: eventSlugFor(slam, tour),
            eventName: `${theme.label} ${tour === 'men' ? "men's" : "women's"}`,
          })}
        >
          <DrawIcon name="invitation" />
          Start a private league
        </button>
      )}

      {forthcoming && !leagueAccess && (
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

      {!leagueAccess && !forthcoming && !draw && !loadFailed && (
        <div className="rail">
          <p className="eyebrow">Loading</p>
          <h1 className="player-name">Reading the draw</h1>
        </div>
      )}

      {!leagueAccess && loadFailed && !forthcoming && (
        <div className="rail">
          <p className="eyebrow">Unavailable</p>
          <h1 className="player-name">This draw did not load</h1>
          <p className="forth-note">
            The data for this tournament could not be fetched, so nothing is shown rather
            than something approximate. Try another tournament.
          </p>
        </div>
      )}

      {visualDraw && geo && index && (
        <>
          {!leagueAccess && <Rail index={index} theme={theme} player={shown} traced={activeId !== null} />}
          <div
            className="field"
            aria-hidden={leagueAccess && !isLeagueEntry ? true : undefined}
            inert={leagueAccess && !isLeagueEntry ? true : undefined}
          >
            {view === 'board' || (isLeagueEntry && HAS_WEBGL) ? (
              <Broadcast
                slam={privateSlam ?? slam}
                draw={visualDraw}
                theme={theme}
                lit={leagueAccess ? leagueVisual?.playerId ?? null : shownId}
                playToken={playToken}
                focusToken={focusToken}
                onPick={handlePickMatch}
                onRunEnd={handleRunEnd}
                settled={cameFromTitle}
                lowPower={lowPower}
              />
            ) : (
              <Bracket
                draw={visualDraw}
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

          {!leagueAccess && <div className="viewbar">
            <button
              type="button"
              className="run"
              disabled={running || !shownId}
              onClick={() => { setRunning(true); setLanded(false); setPlayToken((n) => n + 1); }}
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
                    {/* The bracket from the app's own mark: two feeders meeting a
                        spine, and the trophy waiting at the end of it. */}
                    <svg className="viewswap-mark" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                      <g fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2.4 3.9h2.9V8h3.1" />
                        <path d="M2.4 12.1h2.9V8" />
                      </g>
                      <circle cx="11.6" cy="8" r="1.7" fill="currentColor" />
                    </svg>
                    Board
                  </button>
                  <button
                    type="button"
                    className={view === 'radial' ? 'on' : ''}
                    onClick={() => setView('radial')}
                  >
                    {/* The same draw seen from its centre: every position spoked
                        out from the one place they are all trying to reach. */}
                    <svg className="viewswap-mark" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                      <g fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round">
                        <path d="M8 1.9v2.2M8 11.9v2.2M1.9 8h2.2M11.9 8h2.2" />
                        <path d="M3.7 3.7 5.3 5.3M10.7 10.7l1.6 1.6M12.3 3.7 10.7 5.3M5.3 10.7l-1.6 1.6" />
                      </g>
                      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
                    </svg>
                    Radial
                  </button>
                </>
              )}
            </div>
          </div>}
        </>
      )}

      {(!leagueAccess || isLeagueEntry) && !forthcoming && draw && view === 'board' && <Controls running={running} />}

      {!leagueAccess && !forthcoming && draw && view === 'radial' && (
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

      {!leagueAccess && !forthcoming && draw && (
        <p className="compact-note">Search a name to trace their tournament</p>
      )}

      {!leagueAccess && !forthcoming && draw && (
        <Search
          draw={draw}
          flare={theme.flare}
          onHover={handleHover}
          onSelect={handleSelect}
        />
      )}

      {leagueAccess && (
        <div className="league-layer">
          {LOCAL_LEAGUE_PREVIEW && (
            <div className="league-preview-console">
              <p className="league-preview-flag" role="status">
                Local preview <span>Nothing leaves this browser</span>
              </p>
              <nav aria-label="Local preview state">
                {([
                  ['awaiting', 'Awaiting draw'],
                  ['open', 'Picks open'],
                  ['live', 'Live clubhouse'],
                ] as const).map(([mode, label]) => (
                  <a
                    key={mode}
                    href={localPreviewModeHref(mode)}
                    aria-current={effectivePreviewMode === mode ? 'page' : undefined}
                  >
                    {label}
                  </a>
                ))}
              </nav>
            </div>
          )}
          {import.meta.env.DEV && !LOCAL_LEAGUE_PREVIEW && isLeagueEntry && (
            <a className="league-preview-switch" href={localPreviewHref}>
              Run local simulation <span>No backend required</span>
            </a>
          )}
          <LeagueShell
            state={leagueAccess}
            capability={capabilityBootstrap.kind === 'capability' ? capabilityBootstrap.capability : undefined}
            onVisualChange={handleLeagueVisualChange}
            previewDraw={LOCAL_LEAGUE_PREVIEW ? draw : undefined}
            previewFetch={previewFetcher}
            previewMode={effectivePreviewMode ?? undefined}
            onCapabilityChange={handleCapabilityChange}
          />
        </div>
      )}
    </main>
  );
}
