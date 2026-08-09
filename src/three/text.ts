import { Text } from 'troika-three-text';

const ANGLE = 'ANGLE_instanced_arrays';
const DIVISOR_ANGLE = 0x88fe;
const BLOCKED = 'instanced draw unavailable: ANGLE_instanced_arrays is blocked';

let gpuSdf: boolean | null = null;

/**
 * Troika's CPU glyph path still blits through the helper that asks for
 * ANGLE_instanced_arrays, even though it only ever draws with divisor 0. Hand it
 * a stub covering exactly that case; real instancing throws rather than silently
 * drawing the wrong thing.
 */
function restoreDivisorStub(): void {
  if (typeof WebGLRenderingContext !== 'function') return;
  const proto = WebGLRenderingContext.prototype as WebGLRenderingContext & { __divisorStub?: true };
  if (proto.__divisorStub) return;
  proto.__divisorStub = true;

  const native = proto.getExtension;
  proto.getExtension = function (this: WebGLRenderingContext, name: string) {
    const real = (native as (n: string) => unknown).call(this, name);
    if (real || name !== ANGLE) return real;
    return {
      VERTEX_ATTRIB_ARRAY_DIVISOR_ANGLE: DIVISOR_ANGLE,
      vertexAttribDivisorANGLE(_index: number, divisor: number) {
        if (divisor !== 0) throw new Error(BLOCKED);
      },
      drawArraysInstancedANGLE() {
        throw new Error(BLOCKED);
      },
      drawElementsInstancedANGLE() {
        throw new Error(BLOCKED);
      },
    };
  } as typeof proto.getExtension;
}

/**
 * Brave's fingerprint shield hides WebGL1 extensions from the page's own world,
 * so troika sees no ANGLE_instanced_arrays and every label renders blank. Probe
 * the way troika does, from this world, with troika's own context attributes.
 */
function gpuSdfAvailable(): boolean {
  if (gpuSdf !== null) return gpuSdf;
  gpuSdf = false;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const gl = canvas.getContext('webgl', {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      antialias: false,
      depth: false,
    }) as WebGLRenderingContext | null;
    const get = gl && ((gl.getExtension as unknown) as (n: string) => unknown).bind(gl);
    gpuSdf = !!get && !!get(ANGLE) && !!get('EXT_blend_minmax');
  } catch {
    gpuSdf = false;
  }
  if (!gpuSdf) restoreDivisorStub();
  return gpuSdf;
}

export function createText(): Text {
  const t = new Text();
  t.gpuAccelerateSDF = gpuSdfAvailable();
  return t;
}
