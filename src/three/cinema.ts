import * as THREE from 'three';
import type { PlateNode } from './layout';

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export interface CameraPose {
  pos: THREE.Vector3;
  look: THREE.Vector3;
}

/** The establishing shot: the whole board, slightly above, slightly off-axis. */
export const ESTABLISH: CameraPose = {
  pos: new THREE.Vector3(4, 4.6, 55),
  look: new THREE.Vector3(-5, 2.5, 0),
};

interface Beat {
  /** Seconds from the start of the run. */
  at: number;
  dur: number;
  pose: CameraPose;
}

export interface Cinematic {
  duration: number;
  /** Advance to absolute time t, writing camera and returning route progress 0→1. */
  seek: (t: number, camera: THREE.PerspectiveCamera) => number;
  /** The pose at absolute time t, without touching a camera. For controls handoff. */
  poseAt: (t: number) => CameraPose;
  /** The pose the run rests on at t ≥ duration — champion establish, or the loss. */
  endPose: CameraPose;
  /**
   * The climactic held frame: the trophy hero for a champion, the match they lost
   * for everyone else. Reduced motion cuts straight here instead of travelling,
   * so the payoff still lands without any movement.
   */
  payoffPose: CameraPose;
}

export interface CinematicExtras {
  /**
   * World-space centre of the trophy cup, for the champion's crowning frames. When
   * omitted it is derived from the podium geometry (see fallback below). Pass the
   * real centre once the podium exports it and the framing tracks the cup exactly.
   */
  trophyCenter?: THREE.Vector3;
  /**
   * True only when the selected player won the final. The route array cannot tell a
   * champion from a runner-up on its own (routeOf stops at the match a player lost,
   * so both reach the final), so the caller must say. When omitted we fall back to
   * "reached the final", which is honest for everyone except the runner-up.
   */
  isChampion?: boolean;
  /**
   * The framing the board rests on, which depends on the viewport. The run settles
   * back onto it so the ending matches the shot the viewer started from.
   */
  rest?: CameraPose;
}

/**
 * A run down a player's route. It starts tight on the first-round plate and travels
 * the real path, round by round, then lands one of two honest endings:
 *
 *  - Champion: builds and rises through the rounds and resolves on the trophy — the
 *    final match, a low heroic angle, a wide held hero, then a push-in that settles
 *    on the whole trophy with the champion's engraved name legible. The run ends on
 *    the trophy, not back on the overview it started from.
 *  - Everyone else: travels their route and stops where their tournament stopped,
 *    settling cold and still on the match they lost. No faked crowning, no trophy.
 *
 * The whole thing scales to the path: a first-round loss is a short, composed move,
 * not eight seconds held over nothing.
 */
export function buildCinematic(
  path: PlateNode[],
  podium: { x: number; y: number; z: number },
  extras: CinematicExtras = {},
): Cinematic {
  if (path.length === 0) {
    const rest = extras.rest ?? ESTABLISH;
    return {
      duration: 0,
      seek: (_t, camera) => {
        camera.position.copy(rest.pos);
        camera.lookAt(rest.look);
        return 1;
      },
      poseAt: () => ({ pos: rest.pos.clone(), look: rest.look.clone() }),
      endPose: { pos: rest.pos.clone(), look: rest.look.clone() },
      payoffPose: { pos: rest.pos.clone(), look: rest.look.clone() },
    };
  }

  const isChampion = extras.isChampion ?? path.length >= 7;
  const rest = extras.rest ?? ESTABLISH;

  // The trophy cup's world centre. Derived from the podium origin plus a fixed offset
  // (plinth top 1.72, vessel scale 2.5, group scale 2.15 → cup centre ≈ 6.99 above the
  // podium origin). This tracks podium.y automatically, but a change to the vessel
  // scale would drift it — so the caller can pass the exact centre via extras.
  const trophyCenter =
    extras.trophyCenter ?? new THREE.Vector3(podium.x, podium.y + 6.99, podium.z);

  const lastIndex = path.length - 1;
  const dest = path[lastIndex]!;
  const beats: Beat[] = [];
  let t = 0;

  /**
   * The framing that puts one match in the middle of frame. Distance scales with
   * the plate so a dense round-one slab and the final read at the same size, and
   * the look target is the plate itself — never an offset point — which is what
   * guarantees the match the thread is currently drawing is actually on screen.
   */
  function station(n: PlateNode, share: number): CameraPose {
    const back = 7.4 + n.w * 1.15 + share * 3.4;
    const lift = 0.42 + n.h * 0.28 + share * 0.9;
    return {
      pos: new THREE.Vector3(n.x, n.y + lift, n.z + back),
      look: new THREE.Vector3(n.x, n.y, n.z),
    };
  }

  // ── The travel: one continuous move down the route ──────────────────────────
  // Every station centres its own match, and the camera passes through them on a
  // Catmull-Rom spline rather than easing to a halt at each one. That is the
  // difference between a run that flows and the stop-start crawl of per-beat
  // easing: velocity is continuous across the whole route.
  const stations = path.map((n, i) => station(n, lastIndex === 0 ? 0 : i / lastIndex));
  const travelDur = lastIndex === 0 ? 1.15 : Math.min(7.2, 1.5 + lastIndex * 0.78);

  const posCurve = new THREE.CatmullRomCurve3(
    stations.map((s) => s.pos),
    false,
    'centripetal',
    0.42,
  );
  const lookCurve = new THREE.CatmullRomCurve3(
    stations.map((s) => s.look),
    false,
    'centripetal',
    0.42,
  );

  t = travelDur;

  // The thread has finished tracing by here — progress hits 1, and for a champion the
  // trophy is fully revealed for everything that follows.
  const drawEnd = t;
  const travelEndPose: CameraPose = stations[lastIndex]!;

  let endPose: CameraPose;
  let payoffPose: CameraPose;

  // The travel hands off to the finale here. Everything after this point is
  // authored as held frames and cuts, so it keeps its own beat list.
  const handoffDur = isChampion ? 0.9 : 1.0;
  beats.push({ at: t, dur: handoffDur, pose: travelEndPose });
  t += handoffDur;

  if (isChampion) {
    // The climax is cut, not glided. Three composed frames — the final match, a low
    // heroic angle on the trophy, then the wide hero — each held, joined by two hard
    // cuts. Cutting keeps every held frame clean (no mid-move crop) and gives the
    // ending a rhythm the continuous glide never had: hold, cut, hold, cut, hold.
    //
    // A hold is two adjacent beats sharing a pose (the camera interpolates from a pose
    // to itself). A cut is a beat with a near-zero duration into a very different pose.

    // 1. The final match, held.
    const finalPose: CameraPose = {
      pos: new THREE.Vector3(0, dest.y + 2.8, dest.z + 13),
      look: new THREE.Vector3(0, dest.y + 1.3, dest.z),
    };
    beats.push({ at: t, dur: 1.1, pose: finalPose });
    t += 1.1;
    beats.push({ at: t, dur: 0.06, pose: finalPose });
    t += 0.06;

    // 2. CUT to a low, heroic angle: the whole cup fills the upper frame, the
    //    champion's plate large beneath it. Intimate and unresolved — a beat of
    //    tension. Anchored to the cup centre so it tracks the trophy if it moves.
    const heroic: CameraPose = {
      pos: new THREE.Vector3(0, trophyCenter.y - 4.9, trophyCenter.z + 21.4),
      look: new THREE.Vector3(0, trophyCenter.y - 0.4, trophyCenter.z),
    };
    beats.push({ at: t, dur: 1.1, pose: heroic });
    t += 1.1;
    beats.push({ at: t, dur: 0.06, pose: heroic });
    t += 0.06;

    // 3. CUT out to the hero, and hold. Wide enough that the whole cup sits in frame
    //    with air around it, and framed high: the look target sits below the cup so
    //    the trophy rises into the upper two-thirds and the standing chrome along the
    //    bottom of the page never prints across the engraving.
    const hero: CameraPose = {
      pos: new THREE.Vector3(0, trophyCenter.y - 1.5, trophyCenter.z + 30.4),
      look: new THREE.Vector3(0, trophyCenter.y - 1.5, trophyCenter.z),
    };
    beats.push({ at: t, dur: 2.2, pose: hero });
    t += 2.2;

    // 4. Push in and settle on the trophy — the crescendo. The camera dollies in from
    //    the wide hero and eases up the plinth so the *whole* cup sits in frame with
    //    real air above the finial, the champion's engraved name large and legible
    //    across the plinth, and the last of the gold thread rising into frame beneath.
    //    The distance is set to clear the tallest vessel (Wimbledon's lidded cup with
    //    its pineapple finial) with headroom, so the shorter slams keep even more air;
    //    and because the vertical FOV is fixed, the trophy frames identically at every
    //    viewport aspect. It is pulled far enough that the trophy — not the bottom
    //    control chrome — owns the frame and the final's card tucks behind the plinth
    //    instead of fighting the toolbar. This is the frame the run lands on and hands
    //    back to the viewer: the payoff is the trophy and the name, never the god's-eye
    //    overview the board already rested on before the run began. The pose sits inside
    //    the orbit cage (radius ~22.5, phi ~1.49 < 1.5), so handing back through
    //    controls.flyTo reproduces it exactly with no clamp or jump.
    const arrival: CameraPose = {
      pos: new THREE.Vector3(2.0, trophyCenter.y - 1.19, trophyCenter.z + 22.5),
      look: new THREE.Vector3(0, trophyCenter.y - 3.09, trophyCenter.z + 0.2),
    };
    beats.push({ at: t, dur: 2.6, pose: hero });
    t += 2.6;
    beats.push({ at: t, dur: 2.4, pose: arrival });
    t += 2.4;
    // The board still rests on the whole draw *before* a run (endPose drives the
    // idle breathing then), so that is unchanged. But the run itself now resolves
    // on the trophy: the animated path ends on `arrival` above, and reduced motion
    // cuts straight to it through payoffPose, so both land in the same close frame.
    endPose = { pos: rest.pos.clone(), look: rest.look.clone() };
    payoffPose = { pos: arrival.pos.clone(), look: arrival.look.clone() };
  } else {
    // Not a champion: stop where the tournament stopped. Settle cold and still on the
    // match they lost — straight-on, centred, pulled to a quiet distance that scales
    // with the plate so a first-round exit and a semi-final exit read alike. No trophy,
    // no crowning; the restraint is the point.
    const back = 8.5 + dest.h * 2.6;
    const lift = 1.4 + dest.h * 0.7;
    const lost: CameraPose = {
      pos: new THREE.Vector3(dest.x, dest.y + lift, dest.z + back),
      look: new THREE.Vector3(dest.x, dest.y + 0.15, dest.z),
    };

    // For longer routes, a deliberate slow push-in from a wider, higher framing into
    // the cold static frame reads as authored. Short routes (a one- or two-match path)
    // skip it and settle directly, so they stay composed rather than fussy.
    if (lastIndex >= 2) {
      const approach: CameraPose = {
        pos: new THREE.Vector3(dest.x, dest.y + lift + 2.2, dest.z + back + 5),
        look: lost.look.clone(),
      };
      beats.push({ at: t, dur: 1.3, pose: approach });
      t += 1.3;
    }

    const holdDur = 2.9;
    beats.push({ at: t, dur: holdDur, pose: lost });
    t += holdDur;
    endPose = { pos: lost.pos.clone(), look: lost.look.clone() };
    payoffPose = { pos: lost.pos.clone(), look: lost.look.clone() };
  }

  const duration = t;

  function evalPose(time: number, outPos: THREE.Vector3, outLook: THREE.Vector3): void {
    const clamped = Math.max(0, Math.min(duration, time));

    // The travel is one continuous spline. A single eased mapping over the whole
    // route means the camera accelerates away from round one and settles into the
    // last match without ever stopping in between.
    if (clamped < drawEnd) {
      if (lastIndex === 0) {
        const only = stations[0]!;
        outPos.copy(only.pos);
        outLook.copy(only.look);
        return;
      }
      const raw = clamped / drawEnd;
      const e = easeInOut(raw);
      posCurve.getPoint(e, outPos);
      lookCurve.getPoint(e, outLook);
      return;
    }

    let idx = 0;
    for (let i = 0; i < beats.length; i++) if (clamped >= beats[i]!.at) idx = i;
    const b = beats[idx]!;
    const next = beats[idx + 1];
    const local = next ? Math.min(1, (clamped - b.at) / b.dur) : 1;
    const target = next ? next.pose : b.pose;
    const e = idx === 0 ? easeOut(local) : easeInOut(local);
    outPos.copy(b.pose.pos).lerp(target.pos, e);
    outLook.copy(b.pose.look).lerp(target.look, e);
  }

  const scratchPos = new THREE.Vector3();
  const scratchLook = new THREE.Vector3();

  function seek(time: number, camera: THREE.PerspectiveCamera): number {
    evalPose(time, scratchPos, scratchLook);
    camera.position.copy(scratchPos);
    camera.lookAt(scratchLook);
    const clamped = Math.max(0, Math.min(duration, time));
    // The thread is drawn on the same eased curve the camera rides, so the line
    // always arrives at the match currently centred in frame.
    return Math.min(1, easeInOut(Math.min(1, clamped / Math.max(0.001, drawEnd))));
  }

  function poseAt(time: number): CameraPose {
    const p = new THREE.Vector3();
    const l = new THREE.Vector3();
    evalPose(time, p, l);
    return { pos: p, look: l };
  }

  return { duration, seek, poseAt, endPose, payoffPose };
}

/**
 * Gentle idle drift so a resting shot is never dead still. Defaults to the establish
 * pose (the landing state), but accepts any pose so controls can idle around wherever
 * a run ended — e.g. the cold frame a non-champion route settled on.
 */
export function idleDrift(
  camera: THREE.PerspectiveCamera,
  time: number,
  pointer: THREE.Vector2,
  pose: CameraPose = ESTABLISH,
) {
  const bx = Math.sin(time * 0.00016) * 0.9 + pointer.x * 1.9;
  const by = Math.cos(time * 0.00021) * 0.45 + pointer.y * -1.0;
  camera.position.set(pose.pos.x + bx, pose.pos.y + by, pose.pos.z);
  camera.lookAt(pose.look);
}
