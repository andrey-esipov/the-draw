import * as THREE from 'three';
import { FLAG_ATLAS, flagCell, loadFlagImage } from './flag-atlas';

export interface MarkAtlas {
  texture: THREE.Texture;
  /** UV rect for a country code: [u0, v0, u1, v1]. */
  uv: (country: string) => [number, number, number, number];
  dispose: () => void;
}

const { width: W, height: H } = FLAG_ATLAS;

export function buildMarkAtlas(): MarkAtlas {
  const texture = new THREE.Texture();
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;

  loadFlagImage()
    .then((img) => {
      texture.image = img;
      texture.needsUpdate = true;
    })
    .catch((err) => console.error('[flags]', err));

  const uv = (country: string): [number, number, number, number] => {
    const { x, y, w, h } = flagCell(country);
    return [x / W, 1 - (y + h) / H, (x + w) / W, 1 - y / H];
  };

  return {
    texture,
    uv,
    dispose: () => texture.dispose(),
  };
}
