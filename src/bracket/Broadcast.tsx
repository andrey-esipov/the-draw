import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { Draw, SlamId } from '../data/types';
import type { SlamTheme } from '../ui/theme';
import { buildBracketLayout, routeOf, type PlateNode } from '../three/layout';
import { createStage } from '../three/stage';
import { createWorld } from '../three/world';
import { createPlates, createConnectors } from '../three/plates';
import { createRoute, type Route } from '../three/route';
import { CARD_ASPECT } from '../three/matchcard';
import { sound } from '../audio/sound';
import { buildCinematic, idleDrift, type Cinematic } from '../three/cinema';
import { createPodium, PLINTH_TOP, PODIUM_SCALE } from '../three/podium';
import { createControls, drawControlsBus, type CameraPose } from '../three/controls';
import { bootDone } from '../boot';

interface Props {
  slam: SlamId;
  draw: Draw;
  theme: SlamTheme;
  /** Player whose route is lit, or null for the resting board. */
  lit: string | null;
  /** Bumped by the parent to (re)start the cinematic run. */
  playToken: number;
  /** Bumped when a name is committed from search, to fly to their last match. */
  focusToken: number;
  onPick: (matchId: string | null) => void;
  onRunEnd: () => void;
  /** True when the board is taking over a trophy the title screen already placed. */
  settled?: boolean;
}

export function Broadcast({ slam, draw, theme, lit, playToken, focusToken, onPick, onRunEnd, settled }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const api = useRef<{
    setLit: (id: string | null) => void;
    play: () => void;
    reveal: () => void;
    resize: () => void;
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let w = host.clientWidth;
    let h = host.clientHeight;

    const stage = createStage(canvas, w, h);
    const world = createWorld(stage.scene, stage.renderer);
    world.setSlam(slam, theme);
    // Reveal the freshly-built slam through a light-wipe rather than a hard
    // cut. The world is already set above, so the wash resolves straight into
    // it, hiding both the palette swap and 127 plates changing their text.
    //
    // Except when the title screen hands over. There the cup is already being
    // walked in under a dark dissolve, and the board draws itself out from the
    // final — a white wash on top of that is a third handover fighting the
    // other two, and seen through the dissolve it turns the whole frame to
    // grey mud. One handover at a time.
    if (settled !== true) void stage.beginTransition(reduced ? 300 : 760, { reduced });

    const layout = buildBracketLayout(draw);
    const plates = createPlates(layout, draw, theme);
    const connectors = createConnectors(layout, theme);
    stage.scene.add(plates.group, connectors);
    world.warm();


    const finalMatch = draw.rounds[draw.rounds.length - 1]?.matches[0];
    const championId = finalMatch?.winner ?? null;
    const championName = championId ? (draw.players[championId]?.short ?? '') : '';
    const podium = createPodium(
      slam,
      theme,
      championName,
      { year: draw.year, event: draw.event, reduced },
      stage.renderer,
    );
    podium.group.position.set(layout.podium.x, layout.podium.y, layout.podium.z);
    podium.group.scale.setScalar(PODIUM_SCALE);
    stage.scene.add(podium.group);

    // ── Arrival ──────────────────────────────────────────────────────────
    // The board is not cut to. The camera comes in from a little further out
    // and below, the draw settles into its resting frame, and the trophy is the
    // last thing to arrive — so the first five seconds read as a broadcast
    // opening rather than a page that finished loading.
    const ARRIVE = 2600;
    // The board draws itself in from the final outward. It runs on its own
    // clock rather than the camera's, because arriving from the title screen
    // skips the arrival entirely — and that is the path most people take.
    const BUILD = 2050;
    const BUILD_DELAY = settled === true ? 240 : 90;
    let buildAt = 0;
    let built = reduced;
    plates.setBuild(reduced ? 1 : 0);
    connectors.setBuild(reduced ? 1 : 0);
    let arriveAt = 0;
    // Arriving from the title screen, the trophy has just been walked into
    // place and the board is crossfading in around it. Flying the camera in on
    // top of that would move the one object that has to stay still.
    let arrived = reduced || settled === true;
    let landed = reduced;
    // Order matters: this used to run after the line above and reset the reveal
    // to zero every time, so a trophy walked in from the title screen was set
    // present and then immediately hidden, with no arrival left to bring it
    // back. The payoff of the whole flow was an empty plinth.
    podium.setReveal(arrived ? 1 : 0);

    const controls = createControls(stage.camera, host, layout.bounds);
    controls.fit(w / h);
    drawControlsBus.set(controls);

    let route: Route | null = null;
    let cinema: Cinematic | null = null;
    let runStart = 0;
    let running = false;
    let litRounds = 0;
    let advancedTo = 0;
    let crowned = false;
    let championRun = false;
    let litId: string | null = null;
    /** The lit player's run, kept so search can fly to where it ended. */
    let litPath: PlateNode[] = [];

    const pointer = new THREE.Vector2();
    const ndc = new THREE.Vector2();
    const ray = new THREE.Raycaster();
    let hovering = false;
    /** The rig pose to return to when an opened match card is dismissed. */
    let restorePose: CameraPose | null = null;

    /** Frame one match so its expanded card fills a comfortable part of frame. */
    function inspectPose(n: PlateNode): CameraPose {
      // Close enough that every set score is legible, far enough that the plates
      // either side and the trophy above stay in frame. Reading one match should
      // never cost you your place in the draw.
      // The card opens rightward from the plate's left edge, so frame its centre
      // rather than the plate's, or half the score sits outside the shot.
      const cardW = Math.max(1.86, n.h * 1.12) * CARD_ASPECT;
      const cx = n.x - n.w / 2 + cardW / 2;
      return {
        pos: new THREE.Vector3(cx, n.y + 0.9, n.z + 7.4 + cardW * 0.92),
        look: new THREE.Vector3(cx, n.y + 0.1, n.z),
      };
    }

    function openCard(n: PlateNode) {
      if (plates.expanded()?.match.id === n.match.id) return;
      if (!restorePose) restorePose = controls.pose();
      plates.setExpanded(n);
      sound.select();
      sound.expand();
      if (!reduced) sound.glide(0.85, true);
      void controls.flyTo(inspectPose(n), reduced ? 0 : 0.85);
    }

    function closeCard() {
      if (!plates.expanded()) return;
      plates.closeExpanded();
      sound.dismiss();
      if (restorePose) {
        if (!reduced) sound.glide(0.9, false);
        void controls.flyTo(restorePose, reduced ? 0 : 0.9);
        restorePose = null;
      }
    }

    function clearRoute() {
      route?.dispose();
      route = null;
      cinema = null;
      running = false;
    }

    function setLit(id: string | null) {
      litId = id;
      clearRoute();
      if (!id) {
        litPath = [];
        plates.setHighlight(new Set(), null);
        controls.focusSpan(null);
        return;
      }
      const path: PlateNode[] = routeOf(layout, draw, id);
      litPath = path;
      plates.setHighlight(new Set(path.map((n) => n.match.id)), id);
      litRounds = path.length;
      if (path.length === 0) {
        controls.focusSpan(null);
        return;
      }
      // The thread runs a short stroke out past the first-round plate, so the
      // span it has to be framed by is wider than the plates it joins.
      const TAIL = 0.9;
      controls.focusSpan(
        Math.min(...path.map((n) => n.x - n.w / 2)) - TAIL,
        Math.max(...path.map((n) => n.x + n.w / 2)) + TAIL,
      );
      const champion = draw.rounds[draw.rounds.length - 1]?.matches[0]?.winner === id;
      championRun = champion;
      // Only the winner's thread climbs to the plinth. Everyone else's route
      // stops where their tournament stopped, which is the whole point.
      const apex = champion
        ? { x: layout.podium.x, y: layout.podium.y + PLINTH_TOP * PODIUM_SCALE, z: layout.podium.z + 1.75 }
        : undefined;
      route = createRoute(path, theme, champion, w, h, apex);
      stage.scene.add(route.group);
      route.setProgress(reduced ? 1 : 0);
      cinema = buildCinematic(path, layout.podium, {
        isChampion: champion,
        rest: controls.restPose(),
      });
      if (reduced) route.setProgress(1);
    }

    /**
     * Fly to where a searched player's tournament ended.
     *
     * Naming someone in a 127-match board and being left to hunt for them is
     * the whole problem search exists to solve, so the camera goes and stands
     * at their last match — close enough to read it, wide enough to see who
     * put them out.
     */
    function reveal() {
      const n = litPath[litPath.length - 1];
      if (!n) return;
      plates.closeExpanded();
      restorePose = null;
      if (!reduced) sound.glide(0.95, true);
      void controls.flyTo(
        {
          pos: new THREE.Vector3(n.x, n.y + 1.5, n.z + 12.5 + n.w * 1.15),
          look: new THREE.Vector3(n.x, n.y, n.z),
        },
        reduced ? 0 : 1.15,
      );
    }

    function play() {
      if (!cinema) return;
      advancedTo = 0;
      crowned = false;
      plates.closeExpanded();
      restorePose = null;
      if (reduced) {
        // No travel, but the run must still deliver its ending. Cut straight to
        // the held payoff frame — the trophy, or the match they lost — with the
        // route already drawn. The destination is the point; the flight was only
        // ever the way of getting there.
        route?.setProgress(1);
        podium.setReveal(championRun ? 1 : 0);
        void controls.flyTo(cinema.payoffPose, 0);
        sound.crown();
        onRunEnd();
        return;
      }
      sound.runStart();
      controls.enabled = false;
      runStart = performance.now();
      running = true;
    }

    let raf = 0;
    const clock = new THREE.Clock();
    let camOverride: { pos: THREE.Vector3; look: THREE.Vector3 } | null = null;

    (window as unknown as Record<string, unknown>).__cam = (
      x: number, y: number, z: number, lx = 0, ly = 0.8, lz = 0,
    ) => {
      camOverride = { pos: new THREE.Vector3(x, y, z), look: new THREE.Vector3(lx, ly, lz) };
    };
    (window as unknown as Record<string, unknown>).__camOff = () => {
      camOverride = null;
    };

    function frame() {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      const dt = clock.getDelta();

      // Taking the camera cancels the arrival outright: nobody should have a
      // trophy fade in over a frame they are already flying.
      if (!arrived && (controls.hasMoved || running)) { arrived = true; podium.setReveal(1); }

      // The build is never cancelled by a camera grab — half a bracket is not a
      // state anyone should be left holding. It only ever runs to completion.
      if (!built) {
        if (!buildAt) buildAt = now + BUILD_DELAY;
        const b = Math.min(1, Math.max(0, (now - buildAt) / BUILD));
        plates.setBuild(b);
        connectors.setBuild(b);
        if (b >= 1) built = true;
      }

      if (!arrived) {
        if (!arriveAt) arriveAt = now;
        const t = Math.min(1, (now - arriveAt) / ARRIVE);
        const ease = t * t * (3 - 2 * t);
        const rest = controls.restPose();
        // Pure dolly on Z. The resting whole-draw frame already views the board
        // at a shallow, near-horizontal elevation, so the floor sits close to
        // grazing and the round-one thread runs edge-on along the lower-left. The
        // old arrival dropped the camera below that line on its way in: the floor
        // filled the frame as a flat grey wash and the thread bloomed into a
        // white sweep. Dollying straight in holds the resting elevation for the
        // whole move, so no frame rakes the floor and every one holds as a still.
        stage.camera.position.set(
          rest.pos.x,
          rest.pos.y,
          rest.pos.z + (1 - ease) * 8.4,
        );
        stage.camera.lookAt(rest.look);
        // The trophy takes the back half of the arrival on its own, so the eye
        // lands on it once the draw has stopped moving.
        podium.setReveal(Math.max(0, Math.min(1, (t - 0.5) / 0.5)));
        if (!landed && t > 0.62) { landed = true; sound.crown(); }
        if (t >= 1) { arrived = true; podium.setReveal(1); }
      } else if (camOverride) {
        stage.camera.position.copy(camOverride.pos);
        stage.camera.lookAt(camOverride.look);
      } else if (running && cinema) {
        const t = (now - runStart) / 1000;
        const p = cinema.seek(t, stage.camera);
        route?.setProgress(p);
        podium.setReveal(championRun ? p : 0);
        // The thread's own progress drives the build, so a pip fires as it
        // crosses each round and the crown lands the instant it arrives.
        const roundNow = Math.min(litRounds, Math.floor(p * litRounds) + 1);
        while (advancedTo < roundNow) { advancedTo++; sound.advance(advancedTo, litRounds); }
        if (!crowned && p >= 0.999) { crowned = true; sound.crown(); }
        if (t >= cinema.duration) {
          running = false;
          route?.setProgress(1);
          podium.setReveal(1);
          controls.adopt();
          controls.enabled = true;
          onRunEnd();
        }
      } else if (controls.hasMoved) {
        controls.update(dt);
        route?.setProgress(1);
      } else if (!reduced) {
        // Until the viewer takes the camera, keep the board breathing. A dead
        // still frame is the difference between a render and a live broadcast,
        // and this is the frame most people will only ever see.
        idleDrift(stage.camera, now, pointer, cinema?.endPose ?? controls.restPose());
        controls.adopt();
        route?.setProgress(1);
      } else {
        const rest = controls.restPose();
        stage.camera.position.copy(rest.pos);
        stage.camera.lookAt(rest.look);
      }

      podium.update(now);
      plates.updateDetail(stage.camera, h);
      route?.syncScale(stage.camera, h);
      stage.render();
      bootDone();
    }
    frame();

    function onMove(e: PointerEvent) {
      const r = host!.getBoundingClientRect();
      pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
      ndc.set(pointer.x, -pointer.y);
      if (running) return;
      ray.setFromCamera(ndc, stage.camera);
      const hit = plates.pick(ray);
      // The stroke is what tells you a plate is a thing you may touch. Without it
      // the board looks like a picture rather than a surface.
      plates.setHover(hit);
      const next = hit !== null;
      if (next !== hovering) {
        hovering = next;
        host!.style.cursor = next ? 'pointer' : 'default';
        if (next) sound.hover();
      }
    }

    function onClick() {
      if (running) return;
      ray.setFromCamera(ndc, stage.camera);
      // A click on the open card itself is not a dismissal — it is the viewer
      // reading it. Only a click on the board beyond the card closes it.
      if (plates.pickExpanded(ray)) return;
      const hit = plates.pick(ray);
      if (hit) {
        openCard(hit);
        onPick(hit.match.id);
        return;
      }
      closeCard();
      onPick(null);
    }

    function onEscape(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (!plates.expanded()) return;
      closeCard();
      onPick(null);
    }

    function resize() {
      w = host!.clientWidth;
      h = host!.clientHeight;
      stage.resize(w, h);
      route?.resize(w, h);
      controls.fit(w / h);
    }

    host.addEventListener('pointermove', onMove);
    host.addEventListener('click', onClick);
    window.addEventListener('keydown', onEscape);
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    api.current = { setLit, play, reveal, resize };
    setLit(lit);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onEscape);
      clearRoute();
      controls.dispose();
      podium.dispose();
      plates.dispose();
      connectors.geometry.dispose();
      (connectors.material as THREE.Material).dispose();
      world.dispose();
      stage.dispose();
      api.current = null;
      void litId;
    };
  }, [slam, draw, theme, onPick, onRunEnd]);

  useEffect(() => {
    api.current?.setLit(lit);
  }, [lit]);

  useEffect(() => {
    if (focusToken > 0) api.current?.reveal();
  }, [focusToken]);

  useEffect(() => {
    if (playToken > 0) api.current?.play();
  }, [playToken]);

  return (
    <div className="broadcast" ref={hostRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}
