import type { DrawRecapViewModel } from '../../shared/draw/contracts';

export class RecapExportError extends Error {
  constructor(readonly code: 'font_not_ready' | 'canvas_unavailable' | 'encode_failed' | 'download_failed') {
    super(code);
  }
}

export interface RecapTextSection {
  label: string;
  lines: string[];
}

export interface RecapTextContent {
  title: string;
  deck: string;
  provenance: string[];
  sections: RecapTextSection[];
}

export interface RecapCanvasContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  fillRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  measureText(text: string): Pick<TextMetrics, 'width'>;
}

export interface RecapCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d'): RecapCanvasContext | null;
  toBlob(callback: BlobCallback, type?: string): void;
}

export interface RecapRenderEnvironment {
  fontsReady(font: string): boolean;
  createCanvas(): RecapCanvas;
}

const browserRenderEnvironment: RecapRenderEnvironment = {
  fontsReady: (font) => Boolean(document.fonts?.check(font)),
  createCanvas: () => document.createElement('canvas'),
};

export function recapLiteral(value: string, maximum = 80): string {
  const safe = [...value].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127 || code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069) return '';
    if (code >= 0xd800 && code <= 0xdfff) return '\ufffd';
    return character;
  }).join('');
  const points = [...safe];
  return points.length <= maximum ? safe : `${points.slice(0, maximum - 1).join('')}…`;
}

function move(movement: number): string {
  return movement > 0 ? `up ${movement}` : movement < 0 ? `down ${Math.abs(movement)}` : 'held';
}

export function recapTextContent(model: DrawRecapViewModel): RecapTextContent {
  const provenance = [
    `Accepted source revision: ${recapLiteral(model.sourceRevisionId, 40)}`,
    `Accepted at: ${new Date(model.acceptedAt).toISOString()}`,
    `Source freshness: ${model.sourceFreshness}`,
    `Correction replay status: ${model.correctionReplay === 'replayed' ? 'replayed' : 'not needed'}`,
  ];
  if (model.delayReason) provenance.push(`Delay reason: ${recapLiteral(model.delayReason, 100)}`);
  return {
    title: recapLiteral(model.headline, 100),
    deck: `${recapLiteral(model.leagueName, 60)} · ${recapLiteral(model.eventLabel, 80)} · ${recapLiteral(model.roundLabel, 40)}`,
    provenance,
    sections: [
      {
        label: 'Standings movement',
        lines: model.movements.length ? model.movements.map((entry) => (
          `${recapLiteral(entry.displayName, 30)} · ${entry.score} points · rank ${entry.previousRank} to ${entry.rank} (${move(entry.movement)})`
        )) : ['No previous rank comparison for this round'],
      },
      {
        label: 'Rarest right call',
        lines: model.rarestCorrectCall ? [
          `${recapLiteral(model.rarestCorrectCall.displayName, 30)} called ${recapLiteral(model.rarestCorrectCall.playerName, 30)} · ${model.rarestCorrectCall.pickCount} of ${model.rarestCorrectCall.submittedCount}`,
        ] : ['No qualifying call this round'],
      },
      {
        label: 'Costliest miss',
        lines: model.highestImpactMiss ? [
          `${recapLiteral(model.highestImpactMiss.displayName, 30)} backed ${recapLiteral(model.highestImpactMiss.playerName, 30)} · ${model.highestImpactMiss.lostFuturePoints} future points lost`,
        ] : ['No qualifying future-point miss this round'],
      },
      {
        label: 'Champion survival',
        lines: model.survivingChampions.length ? model.survivingChampions.map((entry) => (
          `${recapLiteral(entry.displayName, 30)} · ${recapLiteral(entry.playerName, 30)} still alive`
        )) : ['No champion picks remain alive'],
      },
    ],
  };
}

export function wrappedLines(context: Pick<RecapCanvasContext, 'measureText'>, text: string, width: number): string[] {
  const breakWord = (word: string): string[] => {
    const pieces: string[] = [];
    let piece = '';
    for (const character of [...word]) {
      const candidate = `${piece}${character}`;
      if (piece && context.measureText(candidate).width > width) {
        pieces.push(piece);
        piece = character;
      } else {
        piece = candidate;
      }
    }
    if (piece) pieces.push(piece);
    return pieces;
  };
  const words = text.trim().split(/\s+/u).flatMap((word) => (
    context.measureText(word).width > width ? breakWord(word) : [word]
  ));
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && context.measureText(candidate).width > width) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const CANVAS_WIDTH = 1200;
const MIN_CANVAS_HEIGHT = 1500;
const MARGIN = 76;
const TEXT_WIDTH = CANVAS_WIDTH - MARGIN * 2;

interface MeasuredSection {
  label: string;
  lines: string[][];
  height: number;
}

function measureSections(context: RecapCanvasContext, sections: RecapTextSection[], width: number): MeasuredSection[] {
  context.font = '25px "Geist Sans"';
  return sections.map((section) => {
    const lines = section.lines.map((line) => wrappedLines(context, line, width));
    const factHeight = lines.reduce((height, wrapped) => height + wrapped.length * 34 + 50, 0);
    return { label: section.label, lines, height: Math.max(166, 67 + factHeight) };
  });
}

export async function renderRecapPng(
  model: DrawRecapViewModel,
  environment: RecapRenderEnvironment = browserRenderEnvironment,
): Promise<Blob> {
  if (!environment.fontsReady('16px "Geist Sans"') || !environment.fontsReady('16px "Fraunces Variable"')) {
    throw new RecapExportError('font_not_ready');
  }
  const canvas = environment.createCanvas();
  canvas.width = CANVAS_WIDTH;
  canvas.height = MIN_CANVAS_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new RecapExportError('canvas_unavailable');
  const content = recapTextContent(model);
  context.font = '500 70px "Fraunces Variable"';
  const titleLines = wrappedLines(context, content.title, TEXT_WIDTH);
  context.font = '25px "Geist Sans"';
  const deckLines = wrappedLines(context, content.deck, TEXT_WIDTH);
  const headerBottom = 154 + titleLines.length * 78 + 24 + deckLines.length * 36;
  const totalFacts = content.sections.reduce((total, section) => total + section.lines.length, 0);
  const columns = totalFacts > 18 ? 2 : 1;
  const gap = 40;
  const sectionWidth = columns === 2 ? (TEXT_WIDTH - gap) / 2 : TEXT_WIDTH;
  const sections = measureSections(context, content.sections, sectionWidth);
  const columnHeights = Array.from({ length: columns }, () => 0);
  sections.forEach((section, index) => {
    columnHeights[index % columns] += section.height + 24;
  });
  context.font = '19px "Geist Mono"';
  const provenanceLines = content.provenance.flatMap((line) => wrappedLines(context, line, TEXT_WIDTH));
  const bodyTop = headerBottom + 56;
  const bodyBottom = bodyTop + Math.max(...columnHeights);
  const provenanceHeight = provenanceLines.length * 27;
  canvas.height = Math.max(MIN_CANVAS_HEIGHT, Math.ceil(bodyBottom + provenanceHeight + 150));

  context.fillStyle = '#04120c';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#d8c56a';
  context.fillRect(MARGIN, 74, 126, 7);
  context.fillStyle = '#e8ede6';
  context.font = '500 70px "Fraunces Variable"';
  let y = 154;
  for (const line of titleLines) {
    context.fillText(line, MARGIN, y);
    y += 78;
  }
  context.fillStyle = '#aebbb1';
  context.font = '25px "Geist Sans"';
  y += 24;
  for (const line of deckLines) {
    context.fillText(line, MARGIN, y);
    y += 36;
  }
  const sectionYs = Array.from({ length: columns }, () => bodyTop);
  sections.forEach((section, index) => {
    const column = index % columns;
    const x = MARGIN + column * (sectionWidth + gap);
    let sectionY = sectionYs[column];
    context.strokeStyle = 'rgba(232,237,230,.22)';
    context.beginPath();
    context.moveTo(x, sectionY);
    context.lineTo(x + sectionWidth, sectionY);
    context.stroke();
    sectionY += 43;
    context.fillStyle = '#d8c56a';
    context.font = '600 19px "Geist Sans"';
    context.fillText(section.label, x, sectionY);
    context.fillStyle = '#e8ede6';
    context.font = '25px "Geist Sans"';
    for (const value of section.lines) {
      sectionY += 37;
      for (const line of value) {
        context.fillText(line, x, sectionY);
        sectionY += 34;
      }
      sectionY += 13;
    }
    sectionYs[column] += section.height + 24;
  });
  context.fillStyle = '#aebbb1';
  context.font = '19px "Geist Mono"';
  y = canvas.height - MARGIN - provenanceHeight + 19;
  for (const line of provenanceLines) {
    context.fillText(line, MARGIN, y);
    y += 27;
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new RecapExportError('encode_failed')), 'image/png');
  });
}

export async function downloadRecapPng(model: DrawRecapViewModel): Promise<void> {
  const blob = await renderRecapPng(model);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const slug = recapLiteral(`${model.leagueName}-${model.roundLabel}`, 60)
    .normalize('NFKD').replace(/[^a-z0-9]+/giu, '-').replace(/^-|-$/gu, '').toLowerCase() || 'round-recap';
  anchor.download = `${slug}.png`;
  anchor.href = url;
  anchor.hidden = true;
  try {
    document.body.append(anchor);
    anchor.click();
  } catch {
    throw new RecapExportError('download_failed');
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}
