import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawRecapViewModel } from '../../shared/draw/contracts';
import * as recapExport from '../lib/recap-export';
import { LeagueRecap } from './LeagueRecap';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function viewModel(): DrawRecapViewModel {
  return {
    leagueName: 'Friends',
    eventLabel: "US Open 2026 · Women's singles",
    round: 4,
    roundLabel: 'Quarterfinals',
    headline: 'Quarterfinals changed the clubhouse',
    acceptedRevisionId: 'revision-2',
    sourceRevisionId: '202',
    acceptedAt: '2026-08-24T15:02:00.000Z',
    sourceFreshness: 'current',
    correctionReplay: 'not_needed',
    delayReason: null,
    movements: [{
      participantId: 'you', displayName: '<script>Ada</script>', previousRank: 3, rank: 1, score: 23, movement: 2,
    }],
    rarestCorrectCall: {
      participantId: 'you', displayName: '<script>Ada</script>', playerId: 'a', playerName: 'A Player',
      matchId: 'r4m1', pickCount: 1, submittedCount: 8,
    },
    highestImpactMiss: null,
    survivingChampions: [{
      participantId: 'you', displayName: '<script>Ada</script>', playerId: 'a', playerName: 'A Player',
    }],
  };
}

describe('round paper', () => {
  it('renders the canonical text contract literally with honest empty facts and provenance', () => {
    const model = viewModel();
    render(<LeagueRecap recap={{ state: 'current', acceptedRevisionId: model.acceptedRevisionId, viewModel: model }} />);
    const content = recapExport.recapTextContent(model);
    expect(screen.getByRole('heading', { name: content.title })).toBeTruthy();
    for (const section of content.sections) {
      expect(screen.getByRole('heading', { name: section.label })).toBeTruthy();
      for (const line of section.lines) expect(screen.getByText(line)).toBeTruthy();
    }
    for (const line of content.provenance) expect(screen.getByText(line)).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
  });

  it('never shows a stale recap as current during correction replay', () => {
    render(<LeagueRecap recap={{ state: 'updating', acceptedRevisionId: 'new-revision' }} />);
    expect(screen.getByRole('heading', { name: /Rebuilding this round/ })).toBeTruthy();
    expect(screen.getByText(/previous recap is not shown as current/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
  });

  it('shows a distinct unavailable state instead of pretending recap is still updating', () => {
    render(<LeagueRecap recap={{ state: 'unavailable', acceptedRevisionId: 'new-revision' }} />);
    expect(screen.getByRole('heading', { name: /could not be computed/ })).toBeTruthy();
    expect(screen.getByText(/new-revision/)).toBeTruthy();
    expect(screen.queryByText(/Rebuilding this round/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
  });

  it('exports only after explicit keyboard action and keeps retry on failure', async () => {
    const download = vi.spyOn(recapExport, 'downloadRecapPng')
      .mockRejectedValueOnce(new recapExport.RecapExportError('encode_failed'))
      .mockResolvedValueOnce();
    const model = viewModel();
    render(<LeagueRecap recap={{ state: 'current', acceptedRevisionId: model.acceptedRevisionId, viewModel: model }} />);
    expect(download).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: 'Download round paper' });
    button.focus();
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.click(button);
    expect(await screen.findByText(/could not encode/)).toBeTruthy();
    await vi.waitFor(() => expect(document.activeElement).toBe(button));
    fireEvent.click(button);
    expect(await screen.findByText(/stayed on this device/)).toBeTruthy();
    await vi.waitFor(() => expect(document.activeElement).toBe(button));
    expect(download).toHaveBeenCalledTimes(2);
  });
});
