declare module 'troika-three-text' {
  import * as THREE from 'three';
  export function configureTextBuilder(cfg: { defaultFontURL?: string; sdfGlyphSize?: number }): void;
  export class Text extends THREE.Mesh {
    text: string;
    font: string | { src: string }[];
    fontSize: number;
    color: number | string;
    fillOpacity: number;
    letterSpacing: number;
    lineHeight: number | 'normal';
    maxWidth: number;
    whiteSpace: string;
    overflowWrap: string;
    anchorX: number | string;
    anchorY: number | string;
    textAlign: string;
    outlineWidth: number | string;
    outlineColor: number | string;
    sync(cb?: () => void): void;
    dispose(): void;
  }
}
