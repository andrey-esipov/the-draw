import * as THREE from 'three';

/**
 * The room the trophies are lit in.
 *
 * A polished cup has no diffuse term, so it only looks like metal if there is
 * something bright for it to reflect. Both rooms these cups appear in are dark,
 * which left the bowls reflecting nothing and reading as black chrome with a
 * few white scratches on them. This is a photographer's set: soft panels above
 * and to each side to draw the edges, and a broad dim card across the camera
 * hemisphere so the belly of a bowl has a value to sit at.
 *
 * Both scenes share it, so the trophy carried from the title screen to the
 * board is lit by the same room at both ends of the move.
 */
const cache = new WeakMap<THREE.WebGLRenderer, THREE.Texture>();

/**
 * A real softbox is brightest at its centre and falls away to its edges. A flat
 * one reflects as a band of constant value, which clips to pure white across
 * the whole belly of a bowl and reads as a blown-out render rather than a
 * highlight. This gives every panel a gradient to fall off with.
 */
function panelFalloff(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 58, 4, 64, 64, 78);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.45, '#c8c8c8');
  grad.addColorStop(0.78, '#5a5a5a');
  grad.addColorStop(1, '#101010');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export function vesselStudioEnv(renderer: THREE.WebGLRenderer): THREE.Texture {
  const hit = cache.get(renderer);
  if (hit) return hit;

  const room = new THREE.Scene();
  room.background = new THREE.Color('#0a1710');
  const falloff = panelFalloff();
  const panel = (w: number, h: number, colour: THREE.Color, pos: [number, number, number]) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: colour, map: falloff, side: THREE.DoubleSide }),
    );
    m.position.set(...pos);
    m.lookAt(0, 0.6, 0);
    room.add(m);
  };
  panel(11, 6.6, new THREE.Color(9.4, 9.6, 10.1), [-1.6, 4.2, 6.4]);
  panel(4, 7, new THREE.Color(8.0, 6.9, 5.5), [7.6, 2.2, 3.4]);
  panel(4, 7, new THREE.Color(5.4, 7.0, 8.7), [-7.6, 2.2, 3.4]);
  panel(18, 11, new THREE.Color(1.5, 1.66, 1.56), [0, 1.4, 10.5]);
  panel(19, 19, new THREE.Color(1.95, 2.08, 2.05), [0, 9, 0]);
  // A cup looked down on reflects the ground more than the panels, and a black
  // ground there means a black cup on a phone.
  panel(26, 26, new THREE.Color(0.34, 0.4, 0.36), [0, -3.2, 0]);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(room, 0.035);
  falloff.dispose();
  room.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  });
  pmrem.dispose();
  cache.set(renderer, rt.texture);
  return rt.texture;
}
