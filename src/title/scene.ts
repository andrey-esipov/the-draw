import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';

import type { SlamId } from '../data/types';
import { createVessel } from '../three/vessels';
import { vesselStudioEnv } from '../three/vessels/studio';
import { themeFor } from '../ui/theme';

/**
 * The room the tournaments wait in.
 *
 * Four cups on a shallow arc, each in its own pool of light, over a floor dark
 * enough to hold them. The board is a place; this is the doorway to it, so it
 * carries no data at all — just the objects, lit the way the board lights its
 * own trophy, so arriving on a draw reads as walking further into the same
 * building rather than cutting to a different film.
 */

export const TITLE_TOURNAMENTS = ['australian-open', 'french-open', 'wimbledon', 'us-open'] as const;

export type TitleTour = 'men' | 'women';

export function titleSlams(tour: TitleTour): SlamId[] {
  return TITLE_TOURNAMENTS.map((t) => `${t}-${tour}` as SlamId);
}

/** Kept for the four fixed positions on the shelf. */
export const TITLE_SLAMS: SlamId[] = titleSlams('men');

/**
 * Below this the frame is too narrow for four cups side by side and the scene
 * draws them as a two by two block instead. The layout has to agree with the
 * scene about which it is, so the choices sit with the cups rather than as a
 * list under a picture, which is why this is shared rather than repeated.
 *
 * A tablet held upright clears the width for a row and keeps one, because four
 * cups in a line is the shape this screen is. It cannot fill a frame that tall,
 * so the layout spends the slack on a larger claim rather than trying to grow
 * the cups into it.
 */
export const GRID_ASPECT = 0.62;

const SPAN = 1.94;
const ARC_DEPTH = 0.5;
/** Every cup is normalised to this height so four different objects read as a set. */
const CUP_HEIGHT = 1.16;
/** Where the chosen cup ends up: the middle, where the board keeps its trophy. */
const CENTRE_Z = 0;
/**
 * The framing the board opens on. The cup has to finish this move at the size
 * and place the board's own trophy occupies, so the two can be crossfaded and
 * read as one continuous object rather than a cut.
 */
const MATCH_POS = new THREE.Vector3(0, 1.62, 12.0);
const MATCH_LOOK = new THREE.Vector3(0, -1.14, 0);

export interface TitleScene {
  /** Screen position of each cup, 0..1 on both axes. */
  anchors: () => { x: number; y: number }[];
  /** Swaps in the other tour's trophies, which are different objects. */
  setTour: (tour: TitleTour) => void;
  /** True when the cups are stacked for a portrait frame rather than in a row. */
  isGrid: () => boolean;
  /** The vertical slice of the frame the layout leaves free, as 0..1 fractions. */
  setBand: (top: number, bottom: number) => void;
  setHover: (i: number | null) => void;
  setSelected: (i: number | null) => void;
  resize: (w: number, h: number) => void;
  /** Push in on one cup, t running 0..1. */
  approach: (i: number, t: number) => void;
  dispose: () => void;
}

/** A soft ellipse of dark, so each plinth touches the floor instead of hovering. */
function contactTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.42, 'rgba(255,255,255,0.42)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/**
 * A turned plinth rather than a truncated cone. Two stacked cones with flat
 * tops was the loudest default-three.js tell on the screen, and a lathed
 * profile with a chamfered top edge and a recessed base costs the same single
 * draw call.
 */
function podiumFor(theme: ReturnType<typeof themeFor>): THREE.Mesh {
  const p: THREE.Vector2[] = [];
  const add = (x: number, y: number) => p.push(new THREE.Vector2(x, y));
  add(0, 0);
  add(0.6, 0);
  add(0.645, -0.018);
  add(0.66, -0.055);
  add(0.66, -0.2);
  add(0.712, -0.246);
  add(0.79, -0.29);
  add(0.806, -0.33);
  add(0.8, -0.352);
  add(0, -0.352);
  const geo = new THREE.LatheGeometry(p, 72);
  geo.computeVertexNormals();
  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      // A base, not a statement. Barely tinted by the tournament, and dark
      // enough that the object standing on it stays the brightest thing here.
      // The multiplier used to be a way of finding the tint against a dim
      // environment; with a real set behind it, the same figure turned the
      // plinths into saturated discs competing with the trophies.
      color: new THREE.Color(theme.fog).lerp(new THREE.Color(theme.heritage), 0.1).multiplyScalar(0.55),
      roughness: 0.52,
      metalness: 0.35,
      envMapIntensity: 0.34,
    }),
  );
}

/** The light the room is lit by, so the empty half of the frame has a reason. */
function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,0.5)');
  grad.addColorStop(0.28, 'rgba(255,255,255,0.2)');
  grad.addColorStop(0.62, 'rgba(255,255,255,0.05)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

export function createTitleScene(canvas: HTMLCanvasElement, w: number, h: number): TitleScene {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.24;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#04120c');
  scene.fog = new THREE.FogExp2('#04120c', 0.052);

  // The cups are lit by the shared studio room, so the trophy chosen here is
  // lit by exactly the same set once it is standing over the final.
  scene.environment = vesselStudioEnv(renderer);
  scene.environmentIntensity = 1.0;

  const camera = new THREE.PerspectiveCamera(34, w / h, 0.1, 120);
  const HOME = new THREE.Vector3(0, 0.86, 9.35);
  const LOOK = new THREE.Vector3(0, 0.9, 0);

  /**
   * Four cups side by side need a frame wider than it is tall. A phone held
   * upright is the opposite, and fitting a row into it either crops the outer
   * two or shrinks all four to nothing, so portrait gets a two by two set
   * instead of a row.
   */
  function layoutFor(aspect: number) {
    // A tablet held upright is still wide enough for four cups side by side,
    // and a row needs far less vertical room than a two by two block, which is
    // what the layout has to spare there. Only a phone gets the grid.
    const grid = aspect < GRID_ASPECT;
    return TITLE_SLAMS.map((_, i) => {
      if (grid) {
        const col = i % 2;
        const row = Math.floor(i / 2);
        // Columns stay aligned so each name can hang under its own cup without
        // colliding with its neighbour. The rows are separated by looking down
        // on them from well above instead of by splaying them apart, which put
        // the outer names off the side of a phone.
        // The rows have to clear each other in screen space, not just in the
        // scene. At this pitch a three unit gap moved the back row by almost
        // exactly one cup height, so the two rows landed on top of each other.
        return {
          x: (col - 0.5) * SPAN * 1.18,
          z: -3.1 + row * 6.2,
          turn: (col - 0.5) * -0.2,
        };
      }
      const x = (i - (TITLE_SLAMS.length - 1) / 2) * SPAN;
      // The arc turns the outer cups a few degrees inward, so they read as a set
      // rather than four things that happen to share a row.
      return { x, z: -Math.abs(x / (SPAN * 1.5)) * ARC_DEPTH, turn: -x * 0.055 };
    });
  }

  let isGrid = false;
  // The band of the screen the layout leaves for the cups, measured from the
  // real elements rather than guessed, because the claim above them and the
  // choices below them are different heights on every device.
  let band = { top: 0.3, bottom: 0.57 };

  function fit(nw: number, nh: number) {
    const aspect = nw / nh;
    camera.aspect = aspect;
    // A tablet held upright is still wide enough for four cups side by side,
    // and a row needs far less vertical room than a two by two block, which is
    // what the layout has to spare there. Only a phone gets the grid.
    const grid = aspect < GRID_ASPECT;
    isGrid = grid;
    courtStrength.value = grid ? 0 : 1;
    // Looked down on, a bowl reflects the floor rather than the panels in front
    // of it, so the same room reads a stop darker from a phone's camera.
    scene.environmentIntensity = grid ? 1.65 : 1.0;

    const places = layoutFor(aspect);
    places.forEach((p, i) => {
      const g = holders[i];
      if (!g) return;
      g.position.set(p.x, 0, p.z);
      g.rotation.y = p.turn;
    });

    // A longer lens on the phone. At the wide angle the row nearest the camera
    // rendered half again as large as the row behind it, which read as a
    // mistake rather than as depth.
    const fov = grid ? 27 : 34;
    camera.fov = fov;
    const halfV = Math.tan((fov * Math.PI) / 360);
    const rowHalf = Math.max(...places.map((p) => Math.abs(p.x))) + 0.92;
    const depth = Math.max(...places.map((p) => p.z)) - Math.min(...places.map((p) => p.z));
    const stackHalf = grid ? 1.1 + depth * 0.3 : 1.05;

    const byWidth = rowHalf / (halfV * aspect);
    const byHeight = stackHalf / halfV;
    // The grid only reads as two rows from high enough that the back pair clears
    // the front pair. Level with them, the front row simply hides the back one.
    HOME.set(0, grid ? 5.2 : 0.86, Math.min(24, Math.max(5.4, Math.max(byWidth, byHeight) * 1.08)));
    LOOK.set(0, grid ? -0.35 : 0.62, grid ? 0.75 : 0);
    camera.position.copy(HOME);
    camera.lookAt(LOOK);
    camera.updateProjectionMatrix();

    // Portrait hands the lower half of the screen to the list of choices and
    // the upper part to the claim, so fitting the cups to the whole viewport is
    // fitting them to space they do not have. On a tablet that put the back row
    // behind the headline and the front row under the toggle. Solve instead for
    // the band the layout actually leaves, by measuring where the cluster lands
    // and correcting until it sits inside it.
    {
      const wantH = band.bottom - band.top;
      const wantC = (band.top + band.bottom) / 2;
      // The name under the outermost cup is centred on it and is wider than the
      // plinth, so cups taken right to the edge of the frame push their own
      // labels off it. A portrait row is narrow enough that the label is a
      // larger share of the frame, so it keeps more margin back.
      const wantW = aspect >= 1.05 ? 0.86 : 0.88;
      const probe = new THREE.Vector3();
      for (let pass = 0; pass < 14; pass++) {
        camera.updateMatrixWorld();
        let top = 1;
        let bottom = 0;
        let left = 1;
        let right = 0;
        for (const p of places) {
          for (const y of [-0.35, CUP_HEIGHT * 0.6, CUP_HEIGHT * 1.24]) {
            for (const dx of [-0.62, 0.62]) {
              probe.set(p.x + dx, y, p.z).project(camera);
              const sy = (1 - probe.y) / 2;
              const sx = (probe.x + 1) / 2;
              if (sy < top) top = sy;
              if (sy > bottom) bottom = sy;
              if (sx < left) left = sx;
              if (sx > right) right = sx;
            }
          }
        }
        const haveH = Math.max(1e-4, bottom - top);
        const haveC = (top + bottom) / 2;
        const haveW = Math.max(1e-4, right - left);
        // Whichever axis runs out first is the one that sets the size.
        const over = Math.max(haveH / wantH, haveW / wantW);
        const dir = camera.position.clone().sub(LOOK);
        dir.multiplyScalar(1 + (over - 1) * 0.7);
        camera.position.copy(LOOK).add(dir);
        const reach = 2 * dir.length() * Math.tan((fov * Math.PI) / 360);
        LOOK.y -= (haveC - wantC) * reach * 0.8;
        camera.lookAt(LOOK);
        camera.updateProjectionMatrix();
      }
      HOME.copy(camera.position);
    }
  }

  // A trophy is always photographed on a polished surface, and the bottom of
  // this frame was flat grey doing nothing. The reflection is deliberately weak
  // and blurred, and it fades out before it reaches the names, so it reads as a
  // sheen on dark stone rather than a mirror.
  const floor = new Reflector(new THREE.PlaneGeometry(160, 160), {
    textureWidth: 1024,
    textureHeight: 1024,
    clipBias: 0.0035,
    // Reflector overwrites whatever the shader declares for this uniform with
    // its own option, so the base tone has to be handed in here.
    color: 0x08130e,
    shader: {
      uniforms: {
        color: { value: new THREE.Color('#08130e') },
        tDiffuse: { value: null },
        textureMatrix: { value: new THREE.Matrix4() },
        uCourt: { value: 1 },
      },
      vertexShader: `
        uniform mat4 textureMatrix;
        varying vec4 vUv;
        varying vec3 vLocal;
        void main() {
          vLocal = position;
          vUv = textureMatrix * vec4( position, 1.0 );
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: `
        uniform vec3 color;
        uniform sampler2D tDiffuse;
        uniform float uCourt;
        varying vec4 vUv;
        varying vec3 vLocal;

        // Screen-space width, so a line a long way off stays a line rather than
        // dissolving into the floor or aliasing into a dashed one.
        float mark( float v, float at, float thick ) {
          float w = fwidth( v ) * 0.9 + 0.004;
          return 1.0 - smoothstep( thick, thick + w, abs( v - at ) );
        }
        void main() {
          vec2 uv = vUv.xy / vUv.w;
          // A handful of taps standing in for a rough surface. A sharp mirror
          // reads as glass; trophies stand on polished stone.
          vec3 refl = vec3( 0.0 );
          refl += texture2D( tDiffuse, uv ).rgb * 0.4;
          refl += texture2D( tDiffuse, uv + vec2(  0.0025, 0.0 ) ).rgb * 0.15;
          refl += texture2D( tDiffuse, uv + vec2( -0.0025, 0.0 ) ).rgb * 0.15;
          refl += texture2D( tDiffuse, uv + vec2( 0.0,  0.004 ) ).rgb * 0.15;
          refl += texture2D( tDiffuse, uv + vec2( 0.0, -0.004 ) ).rgb * 0.15;
          // Local +y runs away from the camera. The mirror lives in a band
          // around the cups and dies out before it reaches the far edge, and
          // the whole plane fades into the backdrop so the horizon has no seam.
          // Local +y runs away from the camera. A real floor reflects hardly
          // anything underfoot and almost everything at a grazing angle, and
          // leaning on that is also what hides the horizon: out there the floor
          // is reflecting the same backdrop that sits above it, so there is no
          // seam to see.
          // Distance runs into a handful of pixels near the horizon, so the
          // blend that hides the join has to start almost at the cups.
          float horizon = smoothstep( -3.0, 16.0, vLocal.y );
          float grazing = smoothstep( 4.0, 20.0, vLocal.y );
          // Held tight to the base of each plinth. Let it run any further
          // toward the camera and the bright part of the cup lands as a smudge
          // beside the tournament's name, detached from the object it belongs to.
          float footing = smoothstep( -1.3, 0.9, vLocal.y ) * ( 1.0 - smoothstep( 1.4, 5.0, vLocal.y ) );
          float k = footing * 0.11 + grazing * 0.9;
          float wide = 1.0 - smoothstep( 9.0, 17.0, abs( vLocal.x ) ) * 0.55;
          // The cups carry specular values far above one, so scaling alone
          // still clips to white. Compress first, then scale.
          vec3 tone = refl / ( 1.0 + refl * 0.62 );
          // The trophies are standing on a court. Real dimensions, in metres,
          // with the net line running through the row of plinths, so the first
          // thing on the screen says tennis before anything is chosen.
          float cx = vLocal.x;
          // Shifted so the cups stand inside the baseline and the court runs
          // away from them. Laid the other way it points its centre service
          // line straight at the viewer and cuts the frame in half, which is
          // exactly what happened when the foreground was tried that way.
          float cz = -vLocal.y + 13.1;
          float thick = 0.028;
          float lines = 0.0;
          float inCourt = step( abs( cz ), 11.885 ) * step( abs( cx ), 5.485 );
          lines += mark( abs( cx ), 5.485, thick ) * step( abs( cz ), 11.885 );
          lines += mark( abs( cx ), 4.115, thick ) * step( abs( cz ), 11.885 );
          lines += mark( abs( cz ), 11.885, thick ) * step( abs( cx ), 5.485 );
          lines += mark( abs( cz ), 6.4, thick ) * step( abs( cx ), 4.115 );
          // The centre service line is the mark that makes a court unmistakable
          // from a corner. Without it the rest reads as a set of stripes.
          lines += mark( cx, 0.0, thick ) * step( abs( cz ), 6.4 );
          lines += mark( cx, 0.0, thick ) * ( 1.0 - step( abs( cz ), 11.685 ) ) * step( abs( cz ), 11.885 );
          lines = clamp( lines, 0.0, 1.0 ) * inCourt;
          // Fades out well before the frame edge so the court reads as lit by
          // the same pool of light the cups are standing in.
          float reach = 1.0 - smoothstep( 4.6, 18.0, length( vec2( vLocal.x, vLocal.y * 0.82 ) ) );
          // Chalk on grass, lit by the pool the cups stand in. Held at a value
          // that reads as tennis from the first frame without competing with the
          // metal, which is the only thing here allowed to be bright.
          vec3 base = color + vec3( 0.15, 0.163, 0.142 ) * lines * reach * uCourt;
          gl_FragColor = vec4( base + tone * k * wide, 1.0 );
        }`,
    },
  });
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.24;
  scene.add(floor);
  // Seen from almost overhead, as a phone frames this, the court stops reading
  // as a court and becomes a set of diagonals across the type.
  const courtStrength = (floor.material as THREE.ShaderMaterial).uniforms.uCourt!;

  // The upper half of the frame was empty background doing nothing. A broad
  // soft source hanging over the set gives the room a reason to be lit from
  // above and turns that emptiness into air the cups are standing in.
  const glowTex = glowTexture();
  const roomGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 8),
    new THREE.MeshBasicMaterial({
      map: glowTex,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      color: new THREE.Color('#8fb9a4'),
      fog: false,
    }),
  );
  // Its lower half used to run below the floor, and the line where the two
  // planes crossed read as a hard horizon seam across the whole frame.
  roomGlow.position.set(0, 6.4, -7.2);
  roomGlow.renderOrder = -30;
  scene.add(roomGlow);

  scene.add(new THREE.HemisphereLight('#1b2c26', '#030806', 0.66));
  const key = new THREE.DirectionalLight('#fff6e8', 2.1);
  key.position.set(3.4, 6.2, 5.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight('#cfe6ff', 1.75);
  rim.position.set(-2.4, 3.6, -6);
  scene.add(rim);

  // Silver has no diffuse term at all, so in a dark room a mirror-finish cup
  // reflects the dark and reads as black chrome with a few white scratches.
  // Point sources cannot fix that: they return a pinprick. What silver needs is
  // a large bright shape to reflect, which is why every real trophy photograph
  // is shot into softboxes. These are those softboxes.
  RectAreaLightUniformsLib.init();
  const softbox = (
    w: number,
    h: number,
    intensity: number,
    colour: string,
    pos: [number, number, number],
  ) => {
    const panel = new THREE.RectAreaLight(new THREE.Color(colour), intensity, w, h);
    panel.position.set(...pos);
    panel.lookAt(0, 0.55, 0);
    scene.add(panel);
    return panel;
  };
  softbox(9, 5.2, 3.1, '#eaf4ff', [0, 4.1, 5.6]);
  softbox(2.2, 4.4, 4.6, '#fff2e0', [-6.2, 2.3, 3.4]);
  softbox(2.2, 4.4, 4.6, '#dff0ff', [6.2, 2.3, 3.4]);

  /**
   * The curve the vessels carry by default is tuned for a bright set. Here it
   * puts its black point above almost every value in the room, which is what
   * turned the silver cups into silhouettes. Ease it off and roughen the finish
   * so the panels above read as a broad sheen down the bowl rather than a
   * mirrored point.
   */
  function dressForRoom(cup: THREE.Group) {
    cup.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
        const phys = mat as THREE.MeshPhysicalMaterial;
        if (!phys.isMeshPhysicalMaterial) continue;
        phys.roughness = Math.max(phys.roughness, 0.29);
        phys.envMapIntensity = Math.max(phys.envMapIntensity, 1.6);
        const curve = phys.userData.metalCurve as
          | { uContrast: { value: number }; uBlackPoint: { value: number } }
          | undefined;
        if (curve) {
          curve.uContrast.value = 1.2;
          curve.uBlackPoint.value = 0.004;
        }
      }
    });
  }

  const cups: THREE.Group[] = [];
  const holders: THREE.Group[] = [];
  const spots: THREE.SpotLight[] = [];
  const baseY: number[] = [];
  const cupMats: THREE.Material[][] = [];
  const podMats: THREE.Material[] = [];
  const shades: THREE.Mesh[] = [];
  const pairs: [THREE.Group, THREE.Group][] = [];
  const pairBase: [number, number][] = [];
  const contactTex = contactTexture();

  TITLE_SLAMS.forEach((slam, i) => {
    const theme = themeFor(slam);
    const holder = new THREE.Group();
    scene.add(holder);
    holders.push(holder);

    const pod = podiumFor(theme);
    podMats.push(pod.material as THREE.Material);
    holder.add(pod);
    const shade = new THREE.Mesh(
      new THREE.PlaneGeometry(2.5, 2.5),
      new THREE.MeshBasicMaterial({
        map: contactTex,
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
        color: 0x000000,
        fog: false,
      }),
    );
    shade.rotation.x = -Math.PI / 2;
    // This sat below the floor and behind it in the draw order, so the contact
    // shadow it exists to cast was never visible and every cup looked like it
    // was hovering a little above the surface.
    shade.position.y = -0.2335;
    shade.renderOrder = 3;
    shades.push(shade);
    holder.add(shade);

    // Both draws are built once and one is hidden, so switching tour is a
    // visibility flip rather than a scene rebuild. The women's trophies are
    // genuinely different objects, not the same cup relabelled.
    const mats: THREE.Material[] = [];
    const build = (id: SlamId) => {
      const c = createVessel(id, { metal: theme.flare, accent: theme.chalk });
      dressForRoom(c);
      // The four trophies differ in height by more than half, and normalising
      // on height alone shrank Wimbledon, whose finial inflates the box without
      // adding visual mass. The larger of height and width makes them read as
      // one set on a shelf.
      const box = new THREE.Box3().setFromObject(c);
      const size = box.getSize(new THREE.Vector3());
      // The women's Wimbledon prize is the Venus Rosewater Dish, a plate rather
      // than a cup. Measured by the rule that suits a two-handled cup it came
      // out as a disc wider than every other trophy is tall, so anything much
      // wider than it is high is sized on its width instead.
      const wide = size.x / Math.max(size.y, 1e-6) > 2;
      const raw = Math.max(0.0001, wide ? size.x : Math.max(size.y, size.x * 0.86));
      const lift = wide ? 0.92 : id.startsWith('wimbledon') ? 1.16 : 1;
      const k = (CUP_HEIGHT / raw) * lift;
      c.scale.setScalar(k);
      c.position.y = -box.min.y * k;
      c.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (Array.isArray(m)) mats.push(...m);
        else if (m) mats.push(m);
      });
      holder.add(c);
      return c;
    };
    const menCup = build(`${TITLE_TOURNAMENTS[i]}-men` as SlamId);
    const womenCup = build(`${TITLE_TOURNAMENTS[i]}-women` as SlamId);
    womenCup.visible = false;
    pairs.push([menCup, womenCup]);
    pairBase.push([menCup.position.y, womenCup.position.y]);
    const cup = menCup;
    baseY.push(cup.position.y);
    cupMats.push(mats);
    cups.push(cup);

    const spot = new THREE.SpotLight(theme.flare, 19, 8.4, 0.33, 0.86, 2);
    spot.position.set(0, 3.9, 1.15);
    spot.target.position.set(0, 0.5, 0);
    holder.add(spot);
    holder.add(spot.target);
    spots.push(spot);
  });

  // Placing the cups is part of fitting them, so this has to run once the
  // holders exist rather than at camera-construction time.
  fit(w, h);

  let hovered: number | null = null;
  let selected: number | null = null;
  const lift = new Float32Array(TITLE_SLAMS.length);
  const spin = new Float32Array(TITLE_SLAMS.length);
  const glow = new Float32Array(TITLE_SLAMS.length);
  const BASE_SPOT = 46;

  const project = new THREE.Vector3();
  /** Screen position of each plinth, so the type hangs off the object it names. */
  function anchors(): { x: number; y: number }[] {
    const out = holders.map((g) => {
      project.set(g.position.x, -0.34, g.position.z).project(camera);
      return { x: (project.x + 1) / 2, y: (1 - project.y) / 2 };
    });
    // In a row the arc sets the outer cups further back, which projected their
    // labels higher and left the names looking accidentally stepped, so they
    // share the frontmost baseline. In the portrait grid the rows are genuinely
    // at different depths and each name has to stay with its own cup.
    if (isGrid) return out;
    const base = Math.max(...out.map((a) => a.y));
    return out.map((a) => ({ x: a.x, y: base }));
  }

  function update(now: number, dt: number) {
    const k = Math.min(1, dt * 7.5);
    for (let i = 0; i < cups.length; i++) {
      const active = hovered === i || selected === i;
      lift[i] += ((active ? 1 : 0) - lift[i]!) * k;
      glow[i] += ((active ? 1 : selected === null ? 0.34 : 0) - glow[i]!) * k;
      // Only the cup being pointed at turns. Four objects idling at once is a
      // screensaver.
      if (!reduced) spin[i] += ((active ? 0.55 : 0) - spin[i]!) * k * 0.5;

      const c = cups[i]!;
      // Once a cup starts walking to the centre it has to come back down onto
      // its plinth. Left raised on the hover lift, it arrives on the board
      // hovering half an inch above the base it is supposed to be standing on.
      const seat = i === approachIdx ? 1 - approachE : 1;
      const breathe = reduced ? 0 : Math.sin(now * 0.0009 + i * 1.7) * 0.012;
      c.position.y = (baseY[i] ?? 0) + (lift[i]! * 0.19 + breathe) * seat;
      c.rotation.y += spin[i]! * dt * seat;
      spots[i]!.intensity = BASE_SPOT * (0.5 + glow[i]! * 0.9);
    }
  }

  const leaveFrom = new THREE.Vector3();
  const leaveLookFrom = new THREE.Vector3();
  const leaveLook = new THREE.Vector3();
  const holderFrom: THREE.Vector3[] = [];
  let leaveSet = -1;
  let approachIdx = -1;
  let approachE = 0;

  /**
   * The chosen tournament walks to the middle while the other three go out, and
   * the camera settles to the framing the board will pick up on: same object,
   * same place, same size. Everything after this is the draw arriving around a
   * trophy that never moved.
   */
  function approach(i: number, t: number) {
    const g = holders[i];
    if (!g) return;
    if (leaveSet !== i) {
      leaveSet = i;
      leaveFrom.copy(camera.position);
      leaveLookFrom.copy(LOOK);
      holderFrom.length = 0;
      holders.forEach((h) => holderFrom.push(h.position.clone()));
    }
    const e = t * t * (3 - 2 * t);
    approachIdx = i;
    approachE = e;
    // The other three used to be gone by just over half way, which left the last
    // third of the walk as one cup and an empty floor. They hold while the
    // camera is still moving and clear only as it settles.
    //
    // They also used to wait a quarter of the walk before starting, and the type
    // had already gone by then, so there was a window of roughly 200ms showing
    // four fully lit cups, none of them moving, with nothing on screen to say a
    // choice had been made: a still frame with no subject. They start almost at
    // once now and take longer over it, so the click is answered immediately and
    // the type hands over to something already in motion.
    const out = Math.min(1, Math.max(0, (t - 0.05) / 0.75));
    const outE = out * out * (3 - 2 * out);

    holders.forEach((h, k) => {
      const from = holderFrom[k];
      if (!from) return;
      if (k === i) {
        h.position.x = from.x * (1 - e);
        h.position.z = from.z + (CENTRE_Z - from.z) * e;
        h.rotation.y = h.rotation.y * (1 - e * 0.25);
      }
      // Half transparent metal is glass, and three cups turning to glass on the
      // way out looked like a bug. They lose their light first and go dark, and
      // only fade at the very end when there is almost nothing left to see.
      const dim = k === i ? 1 : 1 - outE;
      const a = k === i ? 1 : Math.min(1, dim * 2.4);
      for (const m of cupMats[k] ?? []) {
        const phys = m as THREE.MeshPhysicalMaterial;
        if (phys.isMeshPhysicalMaterial) {
          phys.userData.baseEnvIntensity ??= phys.envMapIntensity;
          phys.envMapIntensity = (phys.userData.baseEnvIntensity as number) * dim;
        }
        m.transparent = true;
        m.opacity = a;
        m.depthWrite = a > 0.5;
      }
      const pm = podMats[k];
      if (pm) {
        pm.transparent = true;
        pm.opacity = a;
      }
      const sp = spots[k];
      if (sp && k !== i) sp.intensity = BASE_SPOT * 1.4 * (1 - outE);
      if (shades[k]) (shades[k]!.material as THREE.MeshBasicMaterial).opacity = 0.82 * a;
    });

    camera.position.lerpVectors(leaveFrom, MATCH_POS, e);
    leaveLook.lerpVectors(leaveLookFrom, MATCH_LOOK, e);
    camera.lookAt(leaveLook);

    // Bring the court up as the cups go. Measured, the walk used to drain the
    // frame: ink coverage fell from 17.9% at the click to 0.5% by the end, so
    // its last stretch was one small trophy on an empty black field, and the
    // transition read as everything leaving rather than as a handover. The
    // court is the thing that is *arriving* — the board is about to lay a draw
    // out on it — so it takes over the frame as the cups clear it. It also
    // narrows the gap to the board's own, more present court, which the next
    // renderer picks up on.
    if (!isGrid) courtStrength.value = 1 + outE * 1.5;
  }

  // The board glows its trophy through a bloom pass, so these have to as well
  // or the gilt reads flat next to it. Nothing here is hairline type, so this
  // can be a plain full-scene bloom rather than the board's layered one.
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.16, 0.6, 0.95);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  let raf = 0;
  let last = performance.now();
  function frame() {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(now, dt);
    composer.render();
  }
  frame();

  return {
    anchors,
    setTour: (t: TitleTour) => {
      const women = t === 'women';
      pairs.forEach((pair, i) => {
        const show = women ? pair[1] : pair[0];
        const hide = women ? pair[0] : pair[1];
        show.visible = true;
        hide.visible = false;
        cups[i] = show;
        baseY[i] = pairBase[i]![women ? 1 : 0];
        show.position.y = baseY[i]!;
      });
    },
    isGrid: () => isGrid,
    setBand: (top, bottom) => {
      if (!(bottom > top)) return;
      band = { top, bottom };
    },
    setHover: (i) => {
      hovered = i;
    },
    setSelected: (i) => {
      selected = i;
    },
    approach,
    resize: (nw, nh) => {
      fit(nw, nh);
      renderer.setSize(nw, nh, false);
      composer.setSize(nw, nh);
    },
    dispose: () => {
      cancelAnimationFrame(raf);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry?.dispose();
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else (mat as THREE.Material | undefined)?.dispose();
      });
      contactTex.dispose();
      glowTex.dispose();
      composer.dispose();
      renderer.dispose();
      // The board builds its own renderer the moment this one goes away. Without
      // handing the context back first both live at once, and the tab lost the
      // GPU process partway through the handover.
      renderer.forceContextLoss();
    },
  };
}
