import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { Draw, SlamId } from '../data/types';
import type { SlamTheme } from '../ui/theme';
import { buildBracketLayout, routeOf, type PlateNode } from '../three/layout';
import { createStage } from '../three/stage';
import { createWorld } from '../three/world';
import { createPlates, createConnectors } from '../three/plates';
import { createRoute, type Route } from '../three/route';
import { buildCinematic, idleDrift, ESTABLISH, type Cinematic } from '../three/cinema';
import { createPodium } from '../three/podium';

interface Props {
  slam: SlamId;
  draw: Draw;
  theme: SlamTheme;
  /** Player whose route is lit, or null for the resting board. */
  lit: string | null;
  /** Bumped by the parent to (re)start the cinematic run. */
  playToken: number;
  onPick: (matchId: string | null) => void;
  onRunEnd: () => void;
}

export function Broadcast({ slam, draw, theme, lit, playToken, onPick, onRunEnd }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const api = useRef<{
    setLit: (id: string | null) => void;
    play: () => void;
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

    const layout = buildBracketLayout(draw);
    const plates = createPlates(layout, draw, theme);
    const connectors = createConnectors(layout, theme);
    stage.scene.add(plates.group, connectors);


    const finalMatch = draw.rounds[draw.rounds.length - 1]?.matches[0];
    const championId = finalMatch?.winner ?? null;
    const championName = championId ? (draw.players[championId]?.short ?? '') : '';
    const podium = createPodium(slam, theme, championName, { year: draw.year, event: draw.event });
    podium.group.position.set(layout.podium.x, layout.podium.y, layout.podium.z);
    podium.group.scale.setScalar(2.15);
    stage.scene.add(podium.group);
    podium.setReveal(1);

    let route: Route | null = null;
    let cinema: Cinematic | null = null;
    let runStart = 0;
    let running = false;
    let litId: string | null = null;

    const pointer = new THREE.Vector2();
    const ndc = new THREE.Vector2();
    const ray = new THREE.Raycaster();
    let hovering = false;

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
        plates.setHighlight(new Set(), null);
        return;
      }
      const path: PlateNode[] = routeOf(layout, draw, id);
      plates.setHighlight(new Set(path.map((n) => n.match.id)), id);
      if (path.length === 0) return;
      const champion = draw.rounds[draw.rounds.length - 1]?.matches[0]?.winner === id;
      route = createRoute(path, theme, champion, w, h);
      stage.scene.add(route.group);
      route.setProgress(reduced ? 1 : 0);
      cinema = buildCinematic(path, layout.podium);
      if (reduced) route.setProgress(1);
    }

    function play() {
      if (!cinema) return;
      if (reduced) {
        route?.setProgress(1);
        onRunEnd();
        return;
      }
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
      clock.getDelta();

      if (camOverride) {
        stage.camera.position.copy(camOverride.pos);
        stage.camera.lookAt(camOverride.look);
      } else if (running && cinema) {
        const t = (now - runStart) / 1000;
        const p = cinema.seek(t, stage.camera);
        route?.setProgress(p);
        podium.setReveal(p);
        if (t >= cinema.duration) {
          running = false;
          route?.setProgress(1);
          podium.setReveal(1);
          onRunEnd();
        }
      } else if (!reduced) {
        idleDrift(stage.camera, now, pointer);
        route?.setProgress(1);
      } else {
        stage.camera.position.copy(ESTABLISH.pos);
        stage.camera.lookAt(ESTABLISH.look);
      }

      podium.update(now);
      plates.updateDetail(stage.camera, h);
      stage.render();
    }
    frame();

    function onMove(e: PointerEvent) {
      const r = host!.getBoundingClientRect();
      pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
      ndc.set(pointer.x, -pointer.y);
      if (running) return;
      ray.setFromCamera(ndc, stage.camera);
      const hit = plates.pick(ray);
      const next = hit !== null;
      if (next !== hovering) {
        hovering = next;
        host!.style.cursor = next ? 'pointer' : 'default';
      }
    }

    function onClick() {
      if (running) return;
      ray.setFromCamera(ndc, stage.camera);
      const hit = plates.pick(ray);
      onPick(hit ? hit.match.id : null);
    }

    function resize() {
      w = host!.clientWidth;
      h = host!.clientHeight;
      stage.resize(w, h);
      route?.resize(w, h);
    }

    host.addEventListener('pointermove', onMove);
    host.addEventListener('click', onClick);
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    api.current = { setLit, play, resize };
    setLit(lit);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('click', onClick);
      clearRoute();
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
    if (playToken > 0) api.current?.play();
  }, [playToken]);

  return (
    <div className="broadcast" ref={hostRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}
