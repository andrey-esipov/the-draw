import * as THREE from 'three';

/**
 * A bespoke, broadcast-crane camera controller for the draw.
 *
 * Not OrbitControls. The whole point is the feel: every input feeds a *goal*
 * (spherical orbit + a panned target), and the live camera trails that goal
 * through an exponential smoother, so nothing is ever snappy — the rig carries
 * weight and settles like a heavy jib arm. Presets ("Whole draw", "The final",
 * …) are timed, eased flights on top of the same state, so they land on a
 * composed frame instead of drifting there.
 *
 * The camera is caged so the user can never get lost: azimuth stays in front of
 * the board, the polar angle never dips under the ground or climbs to a plan
 * view, distance clamps at both ends, and the panned target is held inside the
 * board's footprint. Getting lost is the failure mode this rig refuses.
 */

export type FrameTarget = 'all' | 'final' | 'champion' | 'courtside';

export interface CameraPose {
  pos: THREE.Vector3;
  look: THREE.Vector3;
}

export interface ControlBounds {
  /** Board footprint, from layout.bounds. */
  width: number;
  height: number;
  depth: number;
}

export interface DrawControls {
  /** Advance the smoother and write the camera. Called from the rAF loop. */
  update(dt: number): void;
  /** Cinema flips this off during scripted playback; on to hand control back. */
  enabled: boolean;
  /** Timed, eased flight to an explicit pose. Resolves when it lands. */
  flyTo(pose: CameraPose, dur?: number): Promise<void>;
  /** Fly to one of the named broadcast framings. */
  frame(target: FrameTarget): void;
  /** Return to the resting "whole draw" framing. */
  reset(): void;
  /** Adopt the camera's *current* pose without a jump (used after cinema). */
  adopt(): void;
  /** The rig's current resting pose, for capture-and-return interactions. */
  pose(): CameraPose;
  /**
   * Re-fit the resting framing to the viewport so the whole board sits inside the
   * frame with air around it at any aspect. Called on mount and on resize.
   */
  fit(aspect: number): void;
  /**
   * Tell the resting framing which slice of the board carries the lit route, in
   * world x, as outer edges rather than plate centres. Round one runs off the
   * sides at the resting distance by design, so without this a champion who
   * came through the outer edge has their own first match cropped away. Framing
   * slides toward them instead of pulling back, which would cost every slam
   * legibility to fix one.
   */
  focusSpan(minX: number | null, maxX?: number): void;
  /** The resting framing the board returns to, as a pose. */
  restPose(): CameraPose;
  /** True while space is held: the board is in grab-to-pan mode. */
  panMode: boolean;
  /** True once the user has moved the camera at all — drives the hint. */
  hasMoved: boolean;
  /** Fired exactly once, the first time the user moves the camera. */
  onFirstMove?: () => void;
  /**
   * Same signal, but for anyone who is not the camera chrome.
   *
   * onFirstMove is a single slot, so the last component to mount silently took
   * it off whoever mounted first. Anything else that needs to know the board is
   * no longer at rest registers here instead.
   */
  watchFirstMove(fn: () => void): () => void;
  dispose(): void;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface Cage {
  radiusMin: number;
  radiusMax: number;
  phiMin: number;
  phiMax: number;
  thetaMin: number;
  thetaMax: number;
  panX: number;
  panYMin: number;
  panYMax: number;
  panZ: number;
}

interface Named {
  target: THREE.Vector3;
  radius: number;
  theta: number;
  phi: number;
}

/**
 * A lightweight bus so the React chrome (Controls.tsx) can drive the live rig
 * that lives inside Broadcast's effect, without either owning the other.
 */
export const drawControlsBus = {
  current: null as DrawControls | null,
  listeners: new Set<() => void>(),
  set(c: DrawControls | null) {
    this.current = c;
    this.listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  },
};

export function createControls(
  camera: THREE.PerspectiveCamera,
  domElement: HTMLElement,
  bounds: ControlBounds,
): DrawControls {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const halfW = bounds.width / 2;
  let focus: { minX: number; maxX: number } | null = null;
  let lastAspect = Math.max(0.35, camera.aspect || 1.6);
  const cage: Cage = {
    radiusMin: 15,
    radiusMax: 135,
    // 0 = straight down, PI/2 = level with the target. Never a plan view, never
    // under the deck: the low bound keeps the horizon above the board's back rail.
    phiMin: 0.62,
    phiMax: 1.5,
    // The board's face is +Z (theta 0). Stay in front of it — a modest arc so
    // you can peek round the sides but never see the back of the plates.
    thetaMin: -0.66,
    thetaMax: 0.66,
    panX: halfW * 0.42,
    panYMin: -3.5,
    panYMax: 11,
    panZ: 5.5,
  };

  // ── Named broadcast framings ────────────────────────────────────────────
  const framings: Record<FrameTarget, Named> = {
    all: {
      target: new THREE.Vector3(-1.5, 2.6, -0.5),
      radius: 62,
      theta: 0.16,
      phi: 1.34,
    },
    champion: {
      target: new THREE.Vector3(-11, 3.2, -1),
      radius: 43,
      theta: -0.24,
      phi: 1.4,
    },
    final: {
      target: new THREE.Vector3(0, 5.6, 1),
      radius: 26,
      theta: 0.05,
      phi: 1.4,
    },
    courtside: {
      target: new THREE.Vector3(-1, 3.4, 3.4),
      radius: 18.5,
      theta: 0.36,
      phi: 1.47,
    },
  };

  // The frame the board actually rests on, arrives at, and returns to. On a wide
  // screen it is the whole draw. On a portrait phone the whole draw is a field of
  // sub-pixel specks, so rest slides onto the champion's half and the late rounds
  // instead — where names are readable — while "Whole draw" stays a deliberate
  // zoom-out away rather than the thing you are dropped into.
  const restFraming: Named = {
    target: framings.all.target.clone(),
    radius: framings.all.radius,
    theta: framings.all.theta,
    phi: framings.all.phi,
  };
  // Below this aspect the frame is too near-square to hold 128 legible nodes: a
  // phone upright, but also a tablet in portrait, whose canvas lands around 1.07.
  // Fitting the whole sheet into a near-square frame is width-bound, so it recedes
  // to a speck floating in a band of dead floor. Those shapes rest on the late
  // rounds instead. A wide monitor never trips it, so desktop rests on the whole
  // draw as before, and "Whole draw" stays a deliberate zoom-out away.
  const PORTRAIT_ASPECT = 1.2;

  // ── Live state ──────────────────────────────────────────────────────────
  // `goal*` is where input pushes; `cur*` trails it through the smoother, and
  // that lag *is* the inertia. The camera reads from `cur*` only.
  const goalTarget = framings.all.target.clone();
  const curTarget = framings.all.target.clone();
  let goalRadius = framings.all.radius;
  let curRadius = framings.all.radius;
  let goalTheta = framings.all.theta;
  let curTheta = framings.all.theta;
  let goalPhi = framings.all.phi;
  let curPhi = framings.all.phi;

  const sph = new THREE.Spherical();
  const offset = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const camUp = new THREE.Vector3();
  const forward = new THREE.Vector3();

  const controls: DrawControls = {
    enabled: true,
    hasMoved: false,
    panMode: false,
    onFirstMove: undefined,
    watchFirstMove(fn: () => void) {
      if (controls.hasMoved) { fn(); return () => {}; }
      movers.add(fn);
      return () => { movers.delete(fn); };
    },
    update,
    flyTo,
    frame,
    reset,
    adopt,
    pose,
    fit,
    focusSpan,
    restPose,
    dispose,
  };

  // ── Flight (timed preset / flyTo) ───────────────────────────────────────
  interface Flight {
    start: number;
    dur: number;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    fromRadius: number;
    toRadius: number;
    fromTheta: number;
    toTheta: number;
    fromPhi: number;
    toPhi: number;
    resolve: () => void;
  }
  let flight: Flight | null = null;

  const movers = new Set<() => void>();

  function markMoved() {
    if (!controls.hasMoved) {
      controls.hasMoved = true;
      controls.onFirstMove?.();
      movers.forEach((fn) => fn());
    }
  }

  function cancelFlight() {
    if (flight) {
      flight.resolve();
      flight = null;
    }
  }

  function applyGoalClamps() {
    goalRadius = clamp(goalRadius, cage.radiusMin, cage.radiusMax);
    goalPhi = clamp(goalPhi, cage.phiMin, cage.phiMax);
    goalTheta = clamp(goalTheta, cage.thetaMin, cage.thetaMax);
    goalTarget.x = clamp(goalTarget.x, -cage.panX, cage.panX);
    goalTarget.y = clamp(goalTarget.y, cage.panYMin, cage.panYMax);
    goalTarget.z = clamp(goalTarget.z, -cage.panZ, cage.panZ);
  }

  function writeCamera(target: THREE.Vector3, radius: number, theta: number, phi: number) {
    sph.set(radius, phi, theta);
    offset.setFromSpherical(sph);
    camera.position.copy(target).add(offset);
    camera.lookAt(target);
  }

  // ── Input → goal ────────────────────────────────────────────────────────
  const ROTATE_SPEED = 0.0042;
  const PAN_SPEED = 0.0016;
  const WHEEL_ZOOM = 0.0012;
  const PINCH_ZOOM = 0.012;
  const KEY_ZOOM = 0.06;

  let dragging: false | 'rotate' | 'pan' = false;
  let lastX = 0;
  let lastY = 0;
  let downX = 0;
  let downY = 0;
  let dragMoved = false;
  let activePointer = -1;

  function rotateBy(dx: number, dy: number) {
    goalTheta -= dx * ROTATE_SPEED;
    goalPhi -= dy * ROTATE_SPEED;
    applyGoalClamps();
    markMoved();
  }

  /** Pan the target across the camera's own right/up plane, scaled by reach. */
  function panBy(dx: number, dy: number) {
    camera.getWorldDirection(forward);
    right.crossVectors(forward, up).normalize();
    camUp.crossVectors(right, forward).normalize();
    const reach = PAN_SPEED * goalRadius;
    goalTarget.addScaledVector(right, -dx * reach);
    goalTarget.addScaledVector(camUp, dy * reach);
    applyGoalClamps();
    markMoved();
  }

  function zoomBy(amount: number) {
    // Multiplicative so the step feels even across the whole distance range.
    goalRadius *= Math.exp(amount);
    applyGoalClamps();
    markMoved();
  }

  function onPointerDown(e: PointerEvent) {
    if (!controls.enabled) return;
    if (e.button !== 0 && e.button !== 2) return;
    cancelFlight();
    dragging = e.button === 2 || e.shiftKey || controls.panMode ? 'pan' : 'rotate';
    activePointer = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    downX = e.clientX;
    downY = e.clientY;
    dragMoved = false;
    domElement.setPointerCapture?.(e.pointerId);
    domElement.classList.add('is-dragging');
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging || e.pointerId !== activePointer) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (!dragMoved && Math.hypot(e.clientX - downX, e.clientY - downY) > 4) dragMoved = true;
    if (dragging === 'pan') panBy(dx, dy);
    else rotateBy(dx, dy);
  }

  function endDrag(e: PointerEvent) {
    if (e.pointerId !== activePointer) return;
    dragging = false;
    activePointer = -1;
    domElement.releasePointerCapture?.(e.pointerId);
    domElement.classList.remove('is-dragging');
  }

  function onWheel(e: WheelEvent) {
    if (!controls.enabled) return;
    e.preventDefault();
    cancelFlight();
    // macOS trackpad pinch surfaces as wheel + ctrlKey — treat it as a firm zoom.
    if (e.ctrlKey) {
      zoomBy(e.deltaY * PINCH_ZOOM);
      return;
    }
    // A deliberate horizontal two-finger swipe pans; vertical scroll zooms.
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.4) {
      panBy(-e.deltaX, 0);
      return;
    }
    if (e.shiftKey) {
      panBy(-e.deltaY, 0);
      return;
    }
    zoomBy(e.deltaY * WHEEL_ZOOM);
  }

  function onContextMenu(e: MouseEvent) {
    if (controls.enabled) e.preventDefault();
  }

  // A drag ends in a browser-synthesised click. Swallow it in the capture phase
  // so an orbit never falls through to the board's own pick handler.
  function onClickCapture(e: MouseEvent) {
    if (dragMoved) {
      e.stopImmediatePropagation();
      e.preventDefault();
      dragMoved = false;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (!controls.enabled) return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
    // Space arms grab-to-pan, the gesture every canvas tool shares. Held, not
    // toggled, so the board can never be left in a mode the viewer forgot about.
    if (e.code === 'Space') {
      if (!controls.panMode) {
        controls.panMode = true;
        domElement.classList.add('is-pannable');
      }
      e.preventDefault();
      return;
    }
    const step = 26;
    switch (e.key) {
      case 'ArrowLeft':
        panBy(step, 0);
        break;
      case 'ArrowRight':
        panBy(-step, 0);
        break;
      case 'ArrowUp':
        if (e.shiftKey) rotateBy(0, -step);
        else panBy(0, -step);
        break;
      case 'ArrowDown':
        if (e.shiftKey) rotateBy(0, step);
        else panBy(0, step);
        break;
      case '+':
      case '=':
        zoomBy(-KEY_ZOOM * 3);
        break;
      case '-':
      case '_':
        zoomBy(KEY_ZOOM * 3);
        break;
      case '0':
      case 'r':
      case 'R':
        reset();
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  function onKeyUp(e: KeyboardEvent) {
    if (e.code !== 'Space') return;
    controls.panMode = false;
    domElement.classList.remove('is-pannable');
  }

  // Losing the window mid-hold would otherwise strand the board in pan mode.
  function onBlur() {
    controls.panMode = false;
    domElement.classList.remove('is-pannable');
  }

  domElement.addEventListener('pointerdown', onPointerDown);
  domElement.addEventListener('pointermove', onPointerMove);
  domElement.addEventListener('pointerup', endDrag);
  domElement.addEventListener('pointercancel', endDrag);
  domElement.addEventListener('wheel', onWheel, { passive: false });
  domElement.addEventListener('contextmenu', onContextMenu);
  domElement.addEventListener('click', onClickCapture, true);
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  // ── Frame / flyTo ───────────────────────────────────────────────────────
  function startFlight(to: Named, dur: number): Promise<void> {
    markMoved();
    if (reduced || dur <= 0) {
      cancelFlight();
      goalTarget.copy(to.target);
      goalRadius = to.radius;
      goalTheta = to.theta;
      goalPhi = to.phi;
      curTarget.copy(to.target);
      curRadius = to.radius;
      curTheta = to.theta;
      curPhi = to.phi;
      applyGoalClamps();
      return Promise.resolve();
    }
    cancelFlight();
    return new Promise<void>((resolve) => {
      flight = {
        start: performance.now(),
        dur: dur * 1000,
        fromTarget: curTarget.clone(),
        toTarget: to.target.clone(),
        fromRadius: curRadius,
        toRadius: to.radius,
        fromTheta: curTheta,
        toTheta: to.theta,
        fromPhi: curPhi,
        toPhi: to.phi,
        resolve,
      };
    });
  }

  /** Convert an explicit pos/look pose into our orbit parameters. */
  function poseToNamed(pose: CameraPose): Named {
    const off = pose.pos.clone().sub(pose.look);
    const s = new THREE.Spherical().setFromVector3(off);
    return {
      target: pose.look.clone(),
      radius: clamp(s.radius, cage.radiusMin, cage.radiusMax),
      theta: clamp(s.theta, cage.thetaMin, cage.thetaMax),
      phi: clamp(s.phi, cage.phiMin, cage.phiMax),
    };
  }

  function flyTo(pose: CameraPose, dur = 1.6): Promise<void> {
    // A programmatic flight leaves the resting frame just as surely as a drag
    // does, so the chrome that only belongs at rest has to hear about it.
    markMoved();
    return startFlight(poseToNamed(pose), dur);
  }

  function frame(target: FrameTarget) {
    void startFlight(framings[target], 1.7);
  }

  function reset() {
    void startFlight(restFraming, 1.5);
  }

  function adopt() {
    // Read the camera's current forward and rebuild the orbit around a target a
    // sensible distance ahead of it, so re-enabling never jumps the frame.
    camera.getWorldDirection(forward);
    const r = clamp(curRadius, cage.radiusMin, cage.radiusMax);
    goalTarget.copy(camera.position).addScaledVector(forward, r);
    goalTarget.x = clamp(goalTarget.x, -cage.panX, cage.panX);
    goalTarget.y = clamp(goalTarget.y, cage.panYMin, cage.panYMax);
    goalTarget.z = clamp(goalTarget.z, -cage.panZ, cage.panZ);
    curTarget.copy(goalTarget);
    offset.copy(camera.position).sub(curTarget);
    const s = new THREE.Spherical().setFromVector3(offset);
    curRadius = goalRadius = clamp(s.radius, cage.radiusMin, cage.radiusMax);
    curTheta = goalTheta = clamp(s.theta, cage.thetaMin, cage.thetaMax);
    curPhi = goalPhi = clamp(s.phi, cage.phiMin, cage.phiMax);
    cancelFlight();
  }

    /**
   * How far the resting frame slides along x so the lit route stays inside it.
   * Zero whenever the route already fits, which is most of the time — the shift
   * only pays out for a champion who came through the outer rounds.
   */
  function shiftFor(radius: number, aspect: number): number {
    if (!focus) return 0;
    const vFov = (camera.fov * Math.PI) / 180;
    const visibleHalf = Math.tan(vFov / 2) * Math.max(0.35, aspect) * radius;
    // Keep real air between the outermost lit card and the edge. The thread
    // does not stop at the plate: it carries a terminal stroke past the first
    // match and is drawn with screen-space width, so a pad measured to the card
    // edge alone still let the corner of the route touch the frame.
    const pad = 2.9;
    let shift = 0;
    if (focus.maxX + pad > visibleHalf) shift = focus.maxX + pad - visibleHalf;
    if (focus.minX - pad < -visibleHalf) shift = Math.min(shift, focus.minX - pad + visibleHalf);
    // Never slide so far that we frame empty floor beyond the board's own edge.
    const room = Math.max(0, bounds.width / 2 + 3.2 - visibleHalf);
    return clamp(shift, -room, room);
  }

  function focusSpan(minX: number | null, maxX?: number): void {
    focus = minX === null ? null : { minX, maxX: maxX ?? minX };
    fit(lastAspect);
  }

  /**
   * Fit the whole board into frame for the given viewport aspect.
   *
   * A bracket of 127 matches is only impressive if you can see all of it, and a
   * fixed distance cannot do that: a wide monitor and a narrow panel need very
   * different pull-backs. We solve for the distance where the board's half-width
   * lands inside the horizontal half-FOV, then take the greater of that and the
   * vertical fit so nothing is ever cropped at either edge.
   */
  function fit(aspect: number): void {
    lastAspect = aspect;
    const vFov = (camera.fov * Math.PI) / 180;
    const margin = 1.02;
    // Past the outermost column the route still has work to do: it carries a
    // terminal stroke beyond the first match, drawn with screen-space width.
    // Padded to the plate edge alone, a champion seeded at the very top of a
    // half had the end of their run sliced off by the frame.
    const halfBoardW = bounds.width / 2 + 3.8;
    const halfBoardH = bounds.height / 2 + 1.4;
    const byWidth = (halfBoardW * margin) / (Math.tan(vFov / 2) * Math.max(0.35, aspect));
    const byHeight = (halfBoardH * margin) / Math.tan(vFov / 2);
    // Past a point, fitting every last round costs more than it buys: the board
    // recedes until 127 matches are a field of unreadable specks. But a bracket
    // that has had one half sliced off by the frame is worse than a small one —
    // it reads as broken rather than distant, and at anything near square a hard
    // cap did exactly that: a viewport sitting right on the old 1.2 step fell to
    // the tight side and truncated the fit. So the cap eases from 118 at square
    // to 88 by the time the frame is comfortably wide, with no edge to fall off.
    const legibleMax = 88 + 30 * clamp((1.35 - aspect) / 0.35, 0, 1);
    const radius = clamp(Math.min(Math.max(byWidth, byHeight), legibleMax), cage.radiusMin, cage.radiusMax);

    framings.all.radius = radius;
    // Board centre, lifted only slightly. Lifted hard it left a dead band under
    // the draw while the bottom rows sank into the floor scrim, and the whole
    // sheet read as though its last rounds had been cut off.
    framings.all.target.set(shiftFor(radius, aspect), 0.35, -0.5);
    framings.all.theta = 0;
    framings.all.phi = 1.4;

    computeRest(aspect, radius);

    if (controls.hasMoved) return;
    goalTarget.copy(restFraming.target);
    curTarget.copy(restFraming.target);
    goalRadius = curRadius = restFraming.radius;
    goalTheta = curTheta = restFraming.theta;
    goalPhi = curPhi = restFraming.phi;
    writeCamera(curTarget, curRadius, curTheta, curPhi);
  }

  /**
   * Set the resting frame for the viewport shape.
   *
   * On a wide frame it is the whole draw, unchanged. On a portrait phone the
   * whole draw is illegible, so rest drops onto the business end of the sheet —
   * the semis, final and trophy — with the champion's thread traced through
   * them. It is framed dead centre so both vertical edges land in the clear
   * gutter outside the semi-final column, which holds for every draw (the
   * columns are fixed) and at any phone aspect, so no card is ever sliced by the
   * screen edge. The quarters and the pulled-back whole draw stay a pinch away.
   */
  function computeRest(aspect: number, wholeRadius: number): void {
    if (aspect >= PORTRAIT_ASPECT) {
      restFraming.target.copy(framings.all.target);
      restFraming.radius = wholeRadius;
      restFraming.theta = framings.all.theta;
      restFraming.phi = framings.all.phi;
      return;
    }
    // World x of the gutter just outside the semi-final column. Framed to it, the
    // final and both semis read in full and the vertical edges fall on clear
    // floor; the quarters sit a pinch-out away. Measured to the semis, whose row
    // sits on the centre line, so the downward tilt never pulls a card's corner
    // across the frame edge the way it does for the stacked quarter-final rows.
    const EDGE_X = 12.4;
    const vFov = (camera.fov * Math.PI) / 180;
    // The vertical framing rides on radius alone — the FOV is fixed — so the
    // nearer a near-square portrait tablet pulls in, the higher the trophy climbs
    // until its lid is sliced off by the header band. A phone rests near 47 and
    // sits clean, so the tablet is not allowed any closer than that; the extra
    // width it has just buys clear air either side of the semis.
    const radius = clamp(
      EDGE_X / (Math.tan(vFov / 2) * Math.max(0.35, aspect)),
      44,
      cage.radiusMax,
    );
    restFraming.target.set(0, 2.4, -0.3);
    restFraming.radius = radius;
    restFraming.theta = 0;
    restFraming.phi = 1.4;
  }

  /** The pose the board rests on. Drives the idle drift and the run's landing. */
  function restPose(): CameraPose {
    const a = restFraming;
    sph.set(a.radius, a.phi, a.theta);
    const off = new THREE.Vector3().setFromSpherical(sph);
    return { pos: a.target.clone().add(off), look: a.target.clone() };
  }

  /** The rig's current resting pose. Lets a caller return to exactly here later. */
  function pose(): CameraPose {
    sph.set(curRadius, curPhi, curTheta);
    const off = new THREE.Vector3().setFromSpherical(sph);
    return { pos: curTarget.clone().add(off), look: curTarget.clone() };
  }

  // ── The smoother ────────────────────────────────────────────────────────
  function update(dt: number) {
    if (!controls.enabled) return;
    const step = Math.min(dt, 0.05);

    if (flight) {
      const now = performance.now();
      const t = clamp((now - flight.start) / flight.dur, 0, 1);
      const e = easeInOut(t);
      curTarget.lerpVectors(flight.fromTarget, flight.toTarget, e);
      curRadius = THREE.MathUtils.lerp(flight.fromRadius, flight.toRadius, e);
      curTheta = THREE.MathUtils.lerp(flight.fromTheta, flight.toTheta, e);
      curPhi = THREE.MathUtils.lerp(flight.fromPhi, flight.toPhi, e);
      // Keep goals pinned to the destination so the smoother has nowhere to pull
      // once the flight resolves.
      goalTarget.copy(flight.toTarget);
      goalRadius = flight.toRadius;
      goalTheta = flight.toTheta;
      goalPhi = flight.toPhi;
      writeCamera(curTarget, curRadius, curTheta, curPhi);
      if (t >= 1) {
        const done = flight;
        flight = null;
        done.resolve();
      }
      return;
    }

    // Exponential smoothing, framerate-independent. Lower lambda = heavier arm.
    const lambda = reduced ? 60 : 7.5;
    const k = 1 - Math.exp(-lambda * step);
    curTarget.lerp(goalTarget, k);
    curRadius += (goalRadius - curRadius) * k;
    curTheta += (goalTheta - curTheta) * k;
    curPhi += (goalPhi - curPhi) * k;
    writeCamera(curTarget, curRadius, curTheta, curPhi);
  }

  function dispose() {
    domElement.removeEventListener('pointerdown', onPointerDown);
    domElement.removeEventListener('pointermove', onPointerMove);
    domElement.removeEventListener('pointerup', endDrag);
    domElement.removeEventListener('pointercancel', endDrag);
    domElement.removeEventListener('wheel', onWheel);
    domElement.removeEventListener('contextmenu', onContextMenu);
    domElement.removeEventListener('click', onClickCapture, true);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    domElement.classList.remove('is-dragging');
    domElement.classList.remove('is-pannable');
    cancelFlight();
    if (drawControlsBus.current === controls) drawControlsBus.set(null);
  }

  // Seat the camera on the resting framing immediately, no jump on first frame.
  writeCamera(curTarget, curRadius, curTheta, curPhi);

  return controls;
}
