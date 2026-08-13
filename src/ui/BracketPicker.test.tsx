// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Draw } from '../data/types';
import { fillRemainingBySeed } from '../data/bracket-draft';
import { BracketPicker } from './BracketPicker';
import { sound } from '../audio/sound';

function smallDraw(): Draw {
  const players = Object.fromEntries(Array.from({ length: 8 }, (_, i) => {
    const id = `p${i + 1}`;
    return [id, { id, name: i === 0 ? 'A very long literal <player> name that remains readable' : `Player ${i + 1}`, short: `P${i + 1}`, country: null, seed: i < 4 ? String(i + 1) : null }];
  }));
  return {
    id: 'test', tournament: 'Wimbledon', year: 2026, event: "Men's Singles", surface: 'Grass',
    venue: 'Wimbledon', city: 'London', bestOf: 5, source: { wikipedia: 'x', url: 'x' }, players,
    rounds: [
      { round: 1, name: 'First round', matches: Array.from({ length: 4 }, (_, i) => ({ id: `r1m${i + 1}`, round: 1, position: i, sides: [{ player: `p${i * 2 + 1}`, seed: null, sets: [] }, { player: `p${i * 2 + 2}`, seed: null, sets: [] }], winner: null })) },
      { round: 2, name: 'Semifinals', matches: Array.from({ length: 2 }, (_, i) => ({ id: `r2m${i + 1}`, round: 2, position: i, sides: [], winner: null })) },
      { round: 3, name: 'Final', matches: [{ id: 'r3m1', round: 3, position: 0, sides: [], winner: null }] },
    ],
  };
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bracket picker', () => {
  it('uses semantic matchup groups, one-tap progression, and keyboard choices', () => {
    render(<BracketPicker draw={smallDraw()} initialPicks={{}} version={0} affectedMatchIds={[]} locked={false} lockAt="2026-08-24T15:00:00Z" onSave={vi.fn()} onSubmit={vi.fn()} />);
    const group = screen.getByRole('group', { name: /First round, match 1/i });
    const choices = group.querySelectorAll('button');
    expect(choices).toHaveLength(2);
    expect(choices[0]!.getAttribute('aria-pressed')).toBe('false');
    fireEvent.keyDown(choices[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(choices[1]);
    fireEvent.keyDown(choices[1]!, { key: 'Enter' });
    expect(choices[1]!.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/1 of 7/)).toBeTruthy();
  });

  it('never claims saved after failure and retries the latest unsaved draft', async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ version: 1, picks: { r1m1: 'p1' }, acceptedRevisionId: 'rev', acceptedRevisionChecksum: 'sum', affectedMatchIds: [] });
    render(<BracketPicker draw={smallDraw()} initialPicks={{}} version={0} affectedMatchIds={[]} locked={false} lockAt="2026-08-24T15:00:00Z" onSave={save} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /A very long literal/ }));
    expect(await screen.findByText(/not saved/i, {}, { timeout: 1500 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('loads the authoritative draft after a conflict without retrying stale picks', async () => {
    const save = vi.fn().mockRejectedValue({
      code: 'draft_conflict',
      details: { currentVersion: 3, currentPicks: { r1m1: 'p2' } },
    });
    render(<BracketPicker draw={smallDraw()} initialPicks={{}} version={0} affectedMatchIds={[]} locked={false} lockAt="2026-08-24T15:00:00Z" onSave={save} onSubmit={vi.fn()} />);
    const group = screen.getByRole('group', { name: /First round, match 1/i });
    fireEvent.click(group.querySelectorAll('button')[0]!);
    expect(await screen.findByText('Newer draft loaded')).toBeTruthy();
    expect(group.querySelectorAll('button')[1]!.getAttribute('aria-pressed')).toBe('true');
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('allows a complete authoritative conflict draft to submit without another edit', async () => {
    const draw = smallDraw();
    const complete = fillRemainingBySeed(draw, {});
    const save = vi.fn().mockRejectedValue({
      code: 'draft_conflict',
      details: { currentVersion: 3, currentPicks: complete },
    });
    const submit = vi.fn().mockResolvedValue({ active: true });
    render(<BracketPicker draw={draw} initialPicks={{}} version={0} affectedMatchIds={[]} locked={false} lockAt="2026-08-24T15:00:00Z" onSave={save} onSubmit={submit} />);
    fireEvent.click(screen.getByRole('button', { name: /A very long literal/ }));
    expect(await screen.findByText('Newer draft loaded')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Submit bracket' });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(submit).toHaveBeenCalledWith(3));
  });

  it.each(['draft_conflict', 'revision_conflict'])('reloads the authoritative draft after submit %s', async (code) => {
    const draw = smallDraw();
    const reload = vi.fn().mockResolvedValue(undefined);
    const submit = vi.fn().mockRejectedValue({ code });
    render(<BracketPicker
      draw={draw}
      initialPicks={fillRemainingBySeed(draw, {})}
      version={7}
      affectedMatchIds={[]}
      locked={false}
      lockAt="2026-08-24T15:00:00Z"
      onSave={vi.fn()}
      onSubmit={submit}
      onReload={reload}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Submit bracket' }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(screen.getByText(/Reloading your saved bracket/i)).toBeTruthy();
  });

  it('marks stale affected branches for repair and blocks submission', () => {
    render(<BracketPicker draw={smallDraw()} initialPicks={{ r1m1: 'p1' }} version={2} affectedMatchIds={['r1m1', 'r2m1']} locked={false} lockAt="2026-08-24T15:00:00Z" onSave={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByText(/2 picks need repair/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Submit bracket/ }).hasAttribute('disabled')).toBe(true);
    expect(document.activeElement?.closest('[data-match-id]')?.getAttribute('data-match-id')).toBe('r1m1');
  });

  it('turns read-only when lock refresh arrives and does not expose another draft', () => {
    const { rerender } = render(<BracketPicker draw={smallDraw()} initialPicks={{}} version={0} affectedMatchIds={[]} locked={false} lockAt="2026-08-24T15:00:00Z" onSave={vi.fn()} onSubmit={vi.fn()} />);
    rerender(<BracketPicker draw={smallDraw()} initialPicks={{}} version={0} affectedMatchIds={[]} locked lockAt="2026-08-24T15:00:00Z" onSave={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByText(/Predictions are locked/)).toBeTruthy();
    expect(screen.queryByText(/competitor draft/i)).toBeNull();
    expect(screen.getAllByRole('button', { name: /Player/ }).every((button) => button.hasAttribute('disabled'))).toBe(true);
  });

  it('quick fill is transparent, reversible, and never submits', () => {
    const submit = vi.fn();
    render(<BracketPicker draw={smallDraw()} initialPicks={{ r1m1: 'p2' }} version={0} affectedMatchIds={[]} locked={false} lockAt="2026-08-24T15:00:00Z" onSave={vi.fn()} onSubmit={submit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fill remaining by seed' }));
    expect(screen.getByText('7 of 7')).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Undo seed fill' }));
    expect(screen.getByText('1 of 7')).toBeTruthy();
  });

  it('projects partial and champion picks into the persistent court route', async () => {
    const visual = vi.fn();
    render(<BracketPicker draw={smallDraw()} initialPicks={{}} version={0} affectedMatchIds={[]} locked={false} lockAt="2026-08-24T15:00:00Z" onSave={vi.fn()} onSubmit={vi.fn()} onVisualChange={visual} />);
    fireEvent.click(screen.getByRole('button', { name: /A very long literal/ }));
    await waitFor(() => expect(visual.mock.calls.at(-1)?.[1]).toBe('p1'));
    expect(visual.mock.calls.at(-1)?.[0].rounds[0].matches[0].winner).toBe('p1');
    fireEvent.click(screen.getByRole('button', { name: 'Fill remaining by seed' }));
    await waitFor(() => expect(visual.mock.calls.at(-1)?.[0].rounds.at(-1).matches[0].winner).toBeTruthy());
    expect(screen.getByText('Your champion')).toBeTruthy();
  });

  it('highlights the player from the latest edit even when an earlier pick key is replaced', async () => {
    const visual = vi.fn();
    render(<BracketPicker
      draw={smallDraw()}
      initialPicks={{ r1m1: 'p1', r1m2: 'p3' }}
      version={0}
      affectedMatchIds={[]}
      locked={false}
      lockAt="2026-08-24T15:00:00Z"
      onSave={vi.fn()}
      onSubmit={vi.fn()}
      onVisualChange={visual}
    />);
    const firstMatch = screen.getByRole('group', { name: /First round, match 1/i });
    fireEvent.click(firstMatch.querySelectorAll('button')[1]!);
    await waitFor(() => expect(visual.mock.calls.at(-1)?.[1]).toBe('p2'));
  });

  it('fires one layered material cue on a confirmed route extension', () => {
    const confirm = vi.spyOn(sound, 'confirmPick');
    render(<BracketPicker
      draw={smallDraw()}
      initialPicks={{ r1m1: 'p1', r1m2: 'p3', r1m3: 'p5' }}
      version={0}
      affectedMatchIds={[]}
      locked={false}
      lockAt="2026-08-24T15:00:00Z"
      onSave={vi.fn()}
      onSubmit={vi.fn()}
    />);
    fireEvent.click(screen.getByRole('button', { name: /Player 7/ }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(true);
  });

  it('submits only a complete possible-lineage saved bracket and confirms the exact hidden-until-lock boundary', async () => {
    const draw = smallDraw();
    const complete = fillRemainingBySeed(draw, {});
    const submit = vi.fn().mockResolvedValue({ active: true });
    render(<BracketPicker draw={draw} initialPicks={complete} version={7} affectedMatchIds={[]} locked={false} lockAt="2026-08-24T15:00:00Z" onSave={vi.fn()} onSubmit={submit} />);
    const button = screen.getByRole('button', { name: 'Submit bracket' });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(submit).toHaveBeenCalledWith(7));
    expect(screen.getByRole('heading', { name: 'Your bracket is in' })).toBeTruthy();
    expect(screen.getByText(/stay hidden from everyone else until/i)).toBeTruthy();
  });

  it('coalesces rapid submit clicks while one submission is in flight', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const draw = smallDraw();
    const submit = vi.fn(() => pending);
    render(<BracketPicker draw={draw} initialPicks={fillRemainingBySeed(draw, {})} version={7} affectedMatchIds={[]} locked={false} lockAt="2026-08-24T15:00:00Z" onSave={vi.fn()} onSubmit={submit} />);
    const button = screen.getByRole('button', { name: 'Submit bracket' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(submit).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Submitting bracket' }).hasAttribute('disabled')).toBe(true);
    finish();
    expect(await screen.findByRole('heading', { name: 'Your bracket is in' })).toBeTruthy();
  });

  it('serializes auto-saves so an older response cannot overwrite a newer pick', async () => {
    let resolveFirst!: (value: {
      version: number;
      picks: Record<string, string>;
      acceptedRevisionId: string;
      acceptedRevisionChecksum: string;
      affectedMatchIds: string[];
    }) => void;
    const first = new Promise<Parameters<typeof resolveFirst>[0]>((resolve) => { resolveFirst = resolve; });
    const save = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ version: 2, picks: { r1m1: 'p1', r1m2: 'p3' }, acceptedRevisionId: 'rev', acceptedRevisionChecksum: 'sum', affectedMatchIds: [] });
    render(<BracketPicker draw={smallDraw()} initialPicks={{}} version={0} affectedMatchIds={[]} locked={false} lockAt="2026-08-24T15:00:00Z" onSave={save} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /A very long literal/ }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 1500 });
    const secondMatch = screen.getByRole('group', { name: /First round, match 2/i });
    fireEvent.click(secondMatch.querySelectorAll('button')[0]!);
    expect(save).toHaveBeenCalledTimes(1);
    resolveFirst({ version: 1, picks: { r1m1: 'p1' }, acceptedRevisionId: 'rev', acceptedRevisionChecksum: 'sum', affectedMatchIds: [] });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]?.[0]).toBe(1);
    expect(save.mock.calls[1]?.[1]).toMatchObject({ r1m1: 'p1', r1m2: 'p3' });
  });

  it('cancels a queued autosave retry when the picker unmounts', async () => {
    let resolveFirst!: (value: {
      version: number;
      picks: Record<string, string>;
      acceptedRevisionId: string;
      acceptedRevisionChecksum: string;
      affectedMatchIds: string[];
    }) => void;
    const first = new Promise<Parameters<typeof resolveFirst>[0]>((resolve) => { resolveFirst = resolve; });
    const save = vi.fn().mockReturnValue(first);
    const { unmount } = render(<BracketPicker draw={smallDraw()} initialPicks={{}} version={0} affectedMatchIds={[]} locked={false} lockAt="2026-08-24T15:00:00Z" onSave={save} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /A very long literal/ }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce(), { timeout: 1500 });
    fireEvent.click(screen.getByRole('group', { name: /First round, match 2/i }).querySelectorAll('button')[0]!);
    unmount();
    resolveFirst({ version: 1, picks: { r1m1: 'p1' }, acceptedRevisionId: 'rev', acceptedRevisionChecksum: 'sum', affectedMatchIds: [] });
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(save).toHaveBeenCalledOnce();
  });
});
