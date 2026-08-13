// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeagueEntry } from './LeagueEntry';

afterEach(cleanup);

describe('private league entry', () => {
  it('joins with a bounded literal name and returns the private link immediately', async () => {
    const join = vi.fn().mockResolvedValue({ returnLink: 'https://example.test/draw/#return=secret' });
    render(<LeagueEntry mode="join" leagueName={'<b>Friends</b>\u202e'} seatsRemaining={3} lockAt="2026-08-24T15:00:00Z" onJoin={join} />);
    expect(screen.getByRole('heading').textContent).toBe('<b>Friends</b>');
    fireEvent.change(screen.getByLabelText('Your display name'), { target: { value: 'A'.repeat(61) } });
    expect(screen.getByRole('button', { name: 'Join the bracket' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Your display name'), { target: { value: 'Andrey\u202eadmin' } });
    expect(screen.getByRole('button', { name: 'Join the bracket' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Your display name'), { target: { value: 'Andrey' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join the bracket' }));
    await waitFor(() => expect(join).toHaveBeenCalledWith('Andrey', expect.any(String)));
    expect(screen.getByText(/only way back/i)).toBeTruthy();
  });

  it('reuses a request key for retries and rotates it when the logical input changes', async () => {
    const join = vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ returnLink: 'https://example.test/draw/#return=secret' });
    render(<LeagueEntry mode="join" leagueName="Friends" seatsRemaining={3} lockAt="2026-08-24T15:00:00Z" onJoin={join} />);
    const name = screen.getByLabelText('Your display name');
    fireEvent.change(name, { target: { value: 'Andrey' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join the bracket' }));
    await waitFor(() => expect(join).toHaveBeenCalledTimes(1));
    const firstKey = join.mock.calls[0]![1];
    fireEvent.click(screen.getByRole('button', { name: 'Join the bracket' }));
    await waitFor(() => expect(join).toHaveBeenCalledTimes(2));
    expect(join.mock.calls[1]![1]).toBe(firstKey);
    fireEvent.change(name, { target: { value: 'Andre' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join the bracket' }));
    await waitFor(() => expect(join).toHaveBeenCalledTimes(3));
    expect(join.mock.calls[2]![1]).not.toBe(firstKey);
  });

  it('shows full and closed invitations as specific terminal states', () => {
    const { rerender } = render(<LeagueEntry mode="join" leagueName="Friends" seatsRemaining={0} lockAt="2026-08-24T15:00:00Z" onJoin={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'This league is full' })).toBeTruthy();
    rerender(<LeagueEntry mode="closed" />);
    expect(screen.getByRole('heading', { name: 'This invitation has closed' })).toBeTruthy();
  });

  it('reports clipboard failure instead of claiming the return link was copied', async () => {
    const copy = vi.fn().mockRejectedValue(new Error('denied'));
    render(<LeagueEntry mode="links" invitationLink="https://invite" returnLink="https://return" onContinue={vi.fn()} copy={copy} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy private return link' }));
    expect(await screen.findByText(/could not copy/i)).toBeTruthy();
    expect(screen.queryByText('Copied')).toBeNull();
  });

  it('states when optional email delivery is unavailable while preserving the on-screen link', async () => {
    render(<LeagueEntry
      mode="links"
      returnLink="https://return"
      onContinue={vi.fn()}
      onEmail={vi.fn().mockResolvedValue('unavailable')}
    />);
    fireEvent.change(screen.getByLabelText('Optional email copy'), { target: { value: 'friend@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email my return link' }));
    expect(await screen.findByText(/Email delivery is unavailable/)).toBeTruthy();
    expect(screen.getByDisplayValue('https://return')).toBeTruthy();
  });
});
