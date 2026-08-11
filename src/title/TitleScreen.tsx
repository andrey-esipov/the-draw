import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SlamId } from '../data/types';
import { sound, SoundToggle } from '../audio/sound';
import { DRAW_DATE_SHORT } from '../ui/Forthcoming';
import { bootDone } from '../boot';
import { themeFor } from '../ui/theme';
import { createTitleScene, GRID_ASPECT, titleSlams, type TitleScene, type TitleTour } from './scene';

/**
 * The doorway. Four cups, one line of type, and nothing to read.
 *
 * The cups are drawn in WebGL but chosen through real buttons stacked over the
 * canvas, so the whole screen is operable from the keyboard and announces
 * itself properly without any of that being simulated against a canvas that
 * cannot be focused.
 */

/* The walk was 1500ms with the three unchosen cups clear by t=0.67, which left
   roughly 600ms of one small cup on a wireframe court with the bottom half of
   the frame empty. Nothing in the title scene can fill that space — the thing
   that belongs under the trophy is the bracket, and only the board can draw it.
   So the walk hands over sooner and the cups take longer over leaving, which
   cuts the lonely beat to about a quarter of a second and lets the board's own
   build outward from the final be what fills the frame. */
const APPROACH_MS = 1250;
/* Short and shallow, and it has to stay in step with `.title-wipe`'s own
   transition duration in title.css. The wipe is cover for the renderer swap,
   not a dissolve: it opens late enough that the cup's walk plays in the clear. */
const WIPE_MS = 260;
/* Slower than the outward walk. Going in, the viewer has just chosen and wants
   to arrive; coming back, they are leaving something and the room reassembling
   is the thing worth watching. */
const RETURN_MS = 1450;

/**
 * Only the draws that exist on file. The 2026 US Open has not been made yet, and
 * saying so here is better than opening an empty room and letting the viewer
 * work out that nothing is wrong.
 */
const DRAWN: Record<string, boolean> = {
  'australian-open-men': true,
  'australian-open-women': true,
  'french-open-men': true,
  'french-open-women': true,
  'wimbledon-men': true,
  'wimbledon-women': true,
  'us-open-men': false,
  'us-open-women': false,
};

interface Props {
  onEnter: (slam: SlamId) => void;
  /**
   * The slam being returned from, when the viewer has come back off a board.
   *
   * Arriving cold and arriving back are different moments and cannot share an
   * entrance. Cold, the room builds: type rises, cups rise in sequence. Coming
   * back, the room is already standing and the only thing that has changed is
   * which cup is where — so the walk is played in reverse instead, the chosen
   * cup returning to its plinth while the other three come back up around it.
   */
  returnFrom?: SlamId | null;
}

export function TitleScreen({ onEnter, returnFrom = null }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<TitleScene | null>(null);
  const [anchors, setAnchors] = useState<{ x: number; y: number }[]>([]);
  const [grid, setGrid] = useState(false);
  // The bed follows whatever cup is being considered, so the room changes as
  // the eye moves along the shelf and the tournament is audible before it is
  // chosen. SoundToggle owns the actual call.
  const [bedSlam, setBedSlam] = useState<SlamId>('wimbledon-men');
  const [tour, setTour] = useState<TitleTour>(returnFrom?.endsWith('-women') ? 'women' : 'men');
  // Memoised because the callbacks below close over it, and a fresh array each
  // render meant the entry handler kept handing back whichever tour was current
  // when it was first created.
  const slams = useMemo(() => titleSlams(tour), [tour]);
  const [leaving, setLeaving] = useState<number | null>(null);
  const [wipe, setWipe] = useState(false);
  // Held for the length of the reverse walk, then dropped, so the class only
  // suppresses the cold entrance and never sticks to a screen at rest.
  const [returning, setReturning] = useState(returnFrom !== null);
  // Read once. The prop is only meaningful for the mount it arrives on, and the
  // effect below must not re-run and replay the walk if a parent re-renders.
  const returnIdxRef = useRef(returnFrom ? titleSlams(returnFrom.endsWith('-women') ? 'women' : 'men').indexOf(returnFrom) : -1);

  useEffect(() => {
    const host = hostRef.current;
    const holder = canvasRef.current;
    if (!host || !holder) return;

    // A canvas whose context has been force-lost can never get another one, and
    // handing the GPU back is exactly what this scene does when it tears down.
    // Reusing the element across a remount therefore yields a null context and a
    // blank screen, which is what happens under StrictMode in development every
    // time. Each mount gets its own canvas instead.
    const canvas = document.createElement('canvas');
    canvas.className = 'title-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    holder.append(canvas);

    // The claim above the cups and the choices below them are different heights
    // on a phone, a tablet and a laptop, so the room left for the trophies is
    // measured from the elements themselves rather than assumed.
    // Layout offsets rather than bounding boxes: the masthead animates in on a
    // transform, and a rect measured mid-animation reports where the type is
    // flying from rather than where it will sit.
    const measureBand = (b: { width: number; height: number }) => {
      const headEl = host.querySelector('.title-head') as HTMLElement | null;
      const belowEls = [
        host.querySelector('.title-sub'),
        host.querySelector('.title-cups'),
      ] as (HTMLElement | null)[];
      const headBottom = headEl ? headEl.offsetTop + headEl.offsetHeight : b.height * 0.24;
      const pad = Math.max(14, b.height * 0.025);
      // In a row the names hang off the plinths instead of sitting in a block of
      // their own, and the list that holds them is a full-bleed overlay, so
      // nothing in the DOM marks where the cups have to stop. Reserve the foot
      // of the frame for the names by hand there. What decides this is whether
      // the scene drew a row, not whether the frame is landscape: a tablet held
      // upright gets a row too, and reading the DOM there let the cups fill to
      // the floor and pushed their own names off the bottom of the screen.
      const row = b.width / b.height >= GRID_ASPECT;
      // A portrait row hangs larger names off the plinths and puts the tour
      // control under them, so it keeps more of the foot back than a landscape
      // frame where the names sit close to the bottom edge.
      const foot = b.width / b.height >= 1.05 ? 0.82 : 0.89;
      let belowTop = row ? b.height * foot : b.height;
      if (!row) {
        for (const el of belowEls) {
          if (!el) continue;
          if (el.offsetWidth < 2 || el.offsetHeight < 2 || el.offsetTop < 2) continue;
          belowTop = Math.min(belowTop, el.offsetTop);
        }
      }
      return [(headBottom + pad) / b.height, (belowTop - pad) / b.height] as const;
    };

    const r = host.getBoundingClientRect();
    const scene = createTitleScene(canvas, Math.max(1, r.width), Math.max(1, r.height));
    const reband = () => {
      const b = host.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) return;
      scene.setBand(...measureBand(b));
      scene.resize(b.width, b.height);
      setAnchors(scene.anchors());
    };
    reband();
    // Web fonts change the height of the claim after first paint, which moves
    // the floor of the room the cups are given.
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.ready.then(reband).catch(() => undefined);
    const settle = window.setTimeout(reband, 700);
    sceneRef.current = scene;
    setAnchors(scene.anchors());
    setGrid(scene.isGrid());

    // Coming back off a board, play the walk backwards. `approach` is a pure
    // function of t against the pose it was first called from, so putting it
    // straight to 1 snapshots the resting row and places the scene in the walked
    // state — chosen cup centred, camera at the board's framing, the other three
    // gone — and running t down to 0 returns every one of those to where it
    // started. The cup goes back to its plinth, the room comes back up around it,
    // and the court fades off, all on the same curve the outward walk used.
    let backRaf = 0;
    const backIdx = returnIdxRef.current;
    if (backIdx >= 0) {
      scene.setSelected(backIdx);
      scene.approach(backIdx, 1);
      const t0 = performance.now();
      const back = () => {
        const t = Math.min(1, (performance.now() - t0) / RETURN_MS);
        scene.approach(backIdx, 1 - t);
        if (t < 1) {
          backRaf = requestAnimationFrame(back);
        } else {
          scene.setSelected(null);
          setReturning(false);
        }
      };
      backRaf = requestAnimationFrame(back);
    }
    // The hold painted by index.html comes down on the first frame there is
    // something to look at, and on a first visit that frame is this one.
    bootDone();

    const ro = new ResizeObserver(() => {
      const b = host.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) return;
      scene.setBand(...measureBand(b));
      scene.resize(b.width, b.height);
      setAnchors(scene.anchors());
      setGrid(scene.isGrid());
    });
    ro.observe(host);

    return () => {
      window.clearTimeout(settle);
      cancelAnimationFrame(backRaf);
      ro.disconnect();
      scene.dispose();
      canvas.remove();
      sceneRef.current = null;
    };
  }, []);

  const enter = useCallback(
    (i: number) => {
      if (leaving !== null) return;
      const slam = slams[i];
      if (!slam) return;

      setLeaving(i);
      sound.select();
      sceneRef.current?.setSelected(i);
      // The bed changes the moment the cup is chosen, so the room you are
      // walking into is already audible before it is visible.
      sound.bed(slam);
      sound.glide(APPROACH_MS / 1000, true);

      const t0 = performance.now();
      let raf = 0;
      const step = () => {
        const t = Math.min(1, (performance.now() - t0) / APPROACH_MS);
        sceneRef.current?.approach(i, t);
        if (t < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);

      // The wash has to be fully up before this screen goes away, or the frame
      // cuts from a half-lit wipe straight to a dark board. App carries the same
      // wash on the other side and fades it off the arriving scene.
      window.setTimeout(() => setWipe(true), APPROACH_MS - WIPE_MS);
      window.setTimeout(() => {
        cancelAnimationFrame(raf);
        onEnter(slam);
      }, APPROACH_MS + 40);
    },
    [leaving, onEnter, slams],
  );

  const hover = useCallback(
    (i: number | null) => {
      if (leaving !== null) return;
      sceneRef.current?.setHover(i);
      if (i !== null) {
        const next = slams[i];
        if (next) setBedSlam(next);
        sound.hover();
      }
    },
    [leaving, slams],
  );

  return (
    <div
      className={`title${leaving !== null ? ' is-leaving' : ''}${grid ? ' is-grid' : ''}${returning ? ' is-returning' : ''}`}
      ref={hostRef}
    >
      <div className="title-canvas-holder" ref={canvasRef} aria-hidden="true" />

      <div className="title-cluster">
        <SoundToggle slam={bedSlam} />
      </div>

      <div className="title-head">
        <p className="title-word">The Draw</p>
        <h1 className="title-claim">
          <span>128 players.</span> <span>One route to the trophy.</span>
        </h1>
        <div className="title-tour" role="radiogroup" aria-label="Draw">
          {(['men', 'women'] as TitleTour[]).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={tour === t}
              className={`title-tour-btn${tour === t ? ' is-on' : ''}`}
              onClick={() => {
                if (t === tour) return;
                setTour(t);
                sceneRef.current?.setTour(t);
                sound.select();
              }}
            >
              {t === 'men' ? "Men's" : "Women's"}
            </button>
          ))}
        </div>
        <p className="title-sub">Choose a tournament</p>
      </div>

      <ul className="title-cups">
        {slams.map((slam, i) => {
          const theme = themeFor(slam);
          const drawn = DRAWN[slam] ?? false;
          return (
            <li
              key={slam}
              className="title-cup"
              style={
                {
                  left: `${(anchors[i]?.x ?? 0.5) * 100}%`,
                  top: `${(anchors[i]?.y ?? 0.7) * 100}%`,
                  '--flare': theme.flare,
                } as React.CSSProperties
              }
            >
              <button
                type="button"
                className="title-pick"
                onPointerEnter={() => hover(i)}
                onPointerLeave={() => hover(null)}
                onFocus={() => hover(i)}
                onBlur={() => hover(null)}
                onClick={() => enter(i)}
                aria-describedby={drawn ? undefined : `title-note-${i}`}
              >
                <span className="title-name">{theme.label}</span>
                <span className="title-state">
                  {/* Not "Not yet drawn". Under a piece that is itself a draw,
                      that reads as the app being unfinished rather than as the
                      tournament not having been made yet. Naming the date says
                      the same thing and says it about the tennis. */}
                  {drawn ? '128 players' : `Draw out ${DRAW_DATE_SHORT}`}
                </span>
              </button>
              {!drawn && (
                <span id={`title-note-${i}`} className="title-hidden">
                  The 2026 draw has not been made yet, so this tournament opens empty.
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <div className={`title-wipe${wipe ? ' is-on' : ''}`} aria-hidden="true" />
    </div>
  );
}
