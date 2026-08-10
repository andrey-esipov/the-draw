import { FLAG_ATLAS } from './flag-atlas.data';

export { FLAG_ATLAS };

export interface FlagCell {
  x: number;
  y: number;
  w: number;
  h: number;
  known: boolean;
}

const cells = FLAG_ATLAS.cells as Record<string, readonly [number, number, number, number]>;
const warned = new Set<string>();

export function flagCell(country: string | null | undefined): FlagCell {
  const code = country?.trim().toUpperCase() ?? '';
  const hit = code ? cells[code] : undefined;
  if (!hit) {
    if (code && !warned.has(code)) {
      warned.add(code);
      console.warn(`[flags] no flag for country code "${code}" — showing neutral chip`);
    }
    const [x, y, w, h] = cells[FLAG_ATLAS.fallback]!;
    return { x, y, w, h, known: false };
  }
  const [x, y, w, h] = hit;
  return { x, y, w, h, known: true };
}

let imagePromise: Promise<HTMLImageElement> | null = null;
let loadedImage: HTMLImageElement | null = null;

export function loadFlagImage(): Promise<HTMLImageElement> {
  if (imagePromise) return imagePromise;
  imagePromise = new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      loadedImage = img;
      resolve(img);
    };
    img.onerror = () => reject(new Error('failed to load flag atlas'));
    img.src = FLAG_ATLAS.src;
  });
  return imagePromise;
}

export function getLoadedFlagImage(): HTMLImageElement | null {
  return loadedImage;
}
