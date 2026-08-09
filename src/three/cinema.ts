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
  pos: new THREE.Vector3(18, 6, 68),
  look: new THREE.Vector3(4, 0.6, 0),
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
}

/**
 * A run down a player's route: start tight on the first-round plate, then pull
 * back and rise as the rounds thin out, landing on the final.
 */
export function buildCinematic(path: PlateNode[], podium: { x: number; y: number; z: number }): Cinematic {
  if (path.length === 0) {
    return { duration: 0, seek: () => 0 };
  }

  const beats: Beat[] = [];
  let t = 0;

  const first = path[0]!;
  beats.push({
    at: 0,
    dur: 1.15,
    pose: {
      pos: new THREE.Vector3(first.x * 0.86, first.y + 0.6, first.z + 11),
      look: new THREE.Vector3(first.x, first.y, first.z),
    },
  });
  t = 1.15;

  path.forEach((n, i) => {
    if (i === 0) return;
    const share = i / (path.length - 1);
    const back = 11 + share * 13;
    const lift = 0.6 + share * 1.6;
    beats.push({
      at: t,
      dur: 1.0,
      pose: {
        pos: new THREE.Vector3(n.x * (1 - share * 0.75), n.y + lift, n.z + back),
        look: new THREE.Vector3(n.x * (1 - share), n.y * (1 - share * 0.5), n.z),
      },
    });
    t += 1.0;
  });

  const last = path[path.length - 1]!;
  beats.push({
    at: t,
    dur: 1.5,
    pose: {
      pos: new THREE.Vector3(0, last.y + 3.4, last.z + 15),
      look: new THREE.Vector3(0, last.y + 2.2, last.z),
    },
  });
  t += 1.5;

  const crown = (last.y + podium.y) / 2;
  beats.push({
    at: t,
    dur: 1.7,
    pose: {
      pos: new THREE.Vector3(0, crown + 1.2, podium.z + 13),
      look: new THREE.Vector3(0, crown, podium.z),
    },
  });
  t += 1.7;

  beats.push({
    at: t,
    dur: 1.9,
    pose: {
      pos: new THREE.Vector3(0, podium.y - 0.6, podium.z + 7.4),
      look: new THREE.Vector3(0, podium.y + 1.1, podium.z),
    },
  });
  t += 1.9;

  beats.push({ at: t, dur: 2.6, pose: ESTABLISH });
  const duration = t + 2.6;

  const drawEnd = beats[beats.length - 4]!.at;

  const pos = new THREE.Vector3();
  const look = new THREE.Vector3();

  function seek(time: number, camera: THREE.PerspectiveCamera): number {
    const clamped = Math.max(0, Math.min(duration, time));
    let idx = 0;
    for (let i = 0; i < beats.length; i++) if (clamped >= beats[i]!.at) idx = i;
    const b = beats[idx]!;
    const next = beats[idx + 1];
    const local = next ? Math.min(1, (clamped - b.at) / b.dur) : 1;
    const target = next ? next.pose : b.pose;
    const from = b.pose;
    const e = idx === 0 ? easeOut(local) : easeInOut(local);
    pos.copy(from.pos).lerp(target.pos, e);
    look.copy(from.look).lerp(target.look, e);
    camera.position.copy(pos);
    camera.lookAt(look);
    return Math.min(1, clamped / Math.max(0.001, drawEnd));
  }

  return { duration, seek };
}

/** Gentle idle drift so the establishing shot is never dead still. */
export function idleDrift(camera: THREE.PerspectiveCamera, time: number, pointer: THREE.Vector2) {
  const bx = Math.sin(time * 0.00016) * 0.9 + pointer.x * 1.9;
  const by = Math.cos(time * 0.00021) * 0.45 + pointer.y * -1.0;
  camera.position.set(ESTABLISH.pos.x + bx, ESTABLISH.pos.y + by, ESTABLISH.pos.z);
  camera.lookAt(ESTABLISH.look);
}
