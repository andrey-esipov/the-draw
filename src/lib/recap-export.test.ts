import { describe, expect, it, vi } from 'vitest';
import type { DrawRecapViewModel } from '../../shared/draw/contracts';
import {
  downloadRecapPng,
  recapLiteral,
  recapTextContent,
  RecapExportError,
  renderRecapPng,
  wrappedLines,
} from './recap-export';

function model(name = '<b>Ada</b>\u202e\ud800'): DrawRecapViewModel {
  return {
    leagueName: 'Friday friends',
    eventLabel: "US Open 2026 · Women's singles",
    round: 4,
    roundLabel: 'Quarterfinals',
    headline: 'Quarterfinals changed the clubhouse',
    acceptedRevisionId: 'revision',
    sourceRevisionId: '202',
    acceptedAt: '2026-08-24T15:02:00.000Z',
    sourceFreshness: 'delayed',
    correctionReplay: 'replayed',
    delayReason: 'source_timeout',
    movements: [{ participantId: 'p1', displayName: name, previousRank: 3, rank: 1, score: 23, movement: 2 }],
    rarestCorrectCall: {
      participantId: 'p1', displayName: name, playerId: 'a', playerName: 'A Player',
      matchId: 'r4m1', pickCount: 1, submittedCount: 8,
    },
    highestImpactMiss: {
      participantId: 'p2', displayName: 'Mina', playerId: 'b', playerName: 'B Player',
      matchId: 'r4m2', lostFuturePoints: 48,
    },
    survivingChampions: [{ participantId: 'p1', displayName: name, playerId: 'a', playerName: 'A Player' }],
  };
}

function environment(options: { fonts?: boolean; context?: boolean; blob?: boolean } = {}) {
  const text: string[] = [];
  const context = {
    fillStyle: '', strokeStyle: '', font: '',
    fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    fillText: vi.fn((value: string, _x: number, _y: number, _maxWidth?: number) => { text.push(value); }),
    measureText: vi.fn((value: string) => ({ width: value.length * 10 })),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => options.context === false ? null : context),
    toBlob: vi.fn((callback: BlobCallback) => callback(options.blob === false ? null : new Blob(['png'], { type: 'image/png' }))),
  };
  const documentLike = {
    fontsReady: vi.fn(() => options.fonts !== false),
    createCanvas: vi.fn(() => canvas),
  };
  return { documentLike, canvas, context, text };
}

describe('local recap PNG', () => {
  it('keeps unsafe, malformed, and oversized names bounded literal text', () => {
    const safe = recapLiteral(`<script>${'x'.repeat(100)}\u202e\ud800</script>`, 20);
    expect(safe).toBe('<script>xxxxxxxxxxx…');
    expect(document.querySelector('script')).toBeNull();
  });

  it('uses the exact canonical preview text in the raster', async () => {
    const fixture = model('Ada');
    const content = recapTextContent(fixture);
    const fake = environment();
    await renderRecapPng(fixture, fake.documentLike);
    const rasterText = fake.text.join('\n');
    for (const value of [
      content.title,
      content.deck,
      ...content.provenance,
      ...content.sections.flatMap((section) => [section.label, ...section.lines]),
    ]) {
      const words = value.split(/\s+/u);
      for (const word of words) expect(rasterText).toContain(word);
    }
    expect(fake.canvas.width).toBe(1200);
    expect(fake.canvas.height).toBe(1500);
    expect(content.provenance).toEqual([
      'Accepted source revision: 202',
      'Accepted at: 2026-08-24T15:02:00.000Z',
      'Source freshness: delayed',
      'Correction replay status: replayed',
      'Delay reason: source_timeout',
    ]);
    expect(fake.context.fillText.mock.calls.every(([, x, y, maxWidth]) => (
      x >= 0 && x <= fake.canvas.width && y >= 0 && y <= fake.canvas.height && maxWidth === undefined
    ))).toBe(true);
    expect(fake.context.fillText.mock.calls.every(([value, x]) => (
      x + fake.context.measureText(value).width <= fake.canvas.width
    ))).toBe(true);
  });

  it('measures and wraps unbroken text without horizontal compression', () => {
    const measureText = (value: string) => ({ width: [...value].length * 12 });
    const lines = wrappedLines({ measureText }, `Name ${'x'.repeat(80)} final`, 120);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.every((line) => measureText(line).width <= 120)).toBe(true);
    expect(lines.join(' ').replace(/\s/gu, '')).toBe(`Name${'x'.repeat(80)}final`);
  });

  it('grows the paper for the bounded 32-person worst case and keeps every draw in bounds', async () => {
    const fixture = model('N'.repeat(80));
    fixture.movements = Array.from({ length: 32 }, (_, index) => ({
      participantId: `p${index}`,
      displayName: `${'N'.repeat(29)}${index}`,
      previousRank: 32,
      rank: index + 1,
      score: 999_999,
      movement: 31 - index,
    }));
    fixture.survivingChampions = Array.from({ length: 32 }, (_, index) => ({
      participantId: `p${index}`,
      displayName: `${'C'.repeat(29)}${index}`,
      playerId: `player${index}`,
      playerName: `${'P'.repeat(29)}${index}`,
    }));
    const fake = environment();
    await renderRecapPng(fixture, fake.documentLike);
    expect(fake.canvas.height).toBeGreaterThan(1500);
    expect(fake.context.fillText.mock.calls.length).toBeGreaterThan(130);
    expect(fake.context.fillText.mock.calls.every(([, x, y, maxWidth]) => (
      x >= 0 && x <= fake.canvas.width && y >= 0 && y <= fake.canvas.height && maxWidth === undefined
    ))).toBe(true);
    expect(fake.context.fillText.mock.calls.every(([value, x]) => (
      x + fake.context.measureText(value).width <= fake.canvas.width
    ))).toBe(true);
  });

  it.each([
    [{ fonts: false }, 'font_not_ready'],
    [{ context: false }, 'canvas_unavailable'],
    [{ blob: false }, 'encode_failed'],
  ] as const)('surfaces %s as an explicit export failure', async (options, code) => {
    await expect(renderRecapPng(model(), environment(options).documentLike))
      .rejects.toMatchObject({ code });
  });

  it('revokes local resources and reports a failed download without uploading', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const originalCreate = document.createElement.bind(document);
    const canvas = originalCreate('canvas');
    const context = environment().documentLike.createCanvas().getContext();
    Object.defineProperties(canvas, {
      getContext: { configurable: true, value: () => context },
      toBlob: { configurable: true, value: (callback: BlobCallback) => callback(new Blob(['png'])) },
    });
    vi.spyOn(document, 'createElement').mockImplementation((tag) => tag === 'canvas' ? canvas : originalCreate(tag));
    Object.defineProperty(document, 'fonts', { configurable: true, value: { check: () => true } });
    const url = vi.fn(() => 'blob:recap');
    const revoke = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: url },
      revokeObjectURL: { configurable: true, value: revoke },
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('blocked'); });
    await expect(downloadRecapPng(model())).rejects.toEqual(new RecapExportError('download_failed'));
    expect(url).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:recap');
    expect(document.querySelector('a[download]')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
