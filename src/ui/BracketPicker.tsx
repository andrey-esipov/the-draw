import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Draw, Match, Round } from '../data/types';
import {
  clearAffectedPicks,
  fillRemainingBySeed,
  matchEntrants,
  pickWinner,
  validPickCount,
} from '../data/bracket-draft';
import type { LeagueApiError } from '../data/league-api';
import { BracketStatus } from './BracketStatus';
import { safeLiteralText } from './safe-text';
import { sound } from '../audio/sound';
import { DrawIcon } from './DrawIcon';

type SaveResponse = {
  version: number;
  picks: Record<string, string>;
  acceptedRevisionId: string;
  acceptedRevisionChecksum: string;
  affectedMatchIds: string[];
};

interface Props {
  draw: Draw;
  initialPicks: Record<string, string>;
  version: number;
  affectedMatchIds: string[];
  locked: boolean;
  lockAt: string;
  initialSubmitted?: boolean;
  onSave: (version: number, picks: Record<string, string>) => Promise<SaveResponse>;
  onSubmit: (version: number) => Promise<unknown>;
  onReload?: () => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
  onVisualChange?: (draw: Draw, playerId: string | null) => void;
}

function exactTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(value));
}

function matchElement(matchId: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[data-match-id]')]
    .find((element) => element.dataset.matchId === matchId);
}

function forecastDraw(draw: Draw, picks: Record<string, string>): Draw {
  return {
    ...draw,
    rounds: draw.rounds.map((round) => ({
      ...round,
      matches: round.matches.map((match) => ({ ...match, winner: picks[match.id] ?? null })),
    })),
  };
}

function highlightedPlayer(draw: Draw, picks: Record<string, string>): string | null {
  for (let roundIndex = draw.rounds.length - 1; roundIndex >= 0; roundIndex -= 1) {
    const matches = draw.rounds[roundIndex]?.matches ?? [];
    for (let matchIndex = matches.length - 1; matchIndex >= 0; matchIndex -= 1) {
      const playerId = picks[matches[matchIndex]!.id];
      if (playerId) return playerId;
    }
  }
  return null;
}

function Matchup({
  draw,
  match,
  round,
  picks,
  affected,
  locked,
  onPick,
}: {
  draw: Draw;
  match: Match;
  round: Round;
  picks: Record<string, string>;
  affected: boolean;
  locked: boolean;
  onPick: (matchId: string, playerId: string) => void;
}) {
  const entrants = matchEntrants(picks, match);
  return (
    <div
      className={`matchup${affected ? ' needs-repair' : ''}`}
      role="group"
      aria-label={`${round.name}, match ${match.position + 1}${affected ? ', needs repair' : ''}`}
      data-match-id={match.id}
      tabIndex={-1}
    >
      <div className="matchup-meta">
        <span>Match {match.position + 1}</span>
        {affected && <span className="repair-label">Repick</span>}
      </div>
      <div className="matchup-choices">
        {entrants.length === 2 ? entrants.map((playerId, index) => {
          const player = draw.players[playerId];
          return (
            <button
              key={playerId}
              type="button"
              className={picks[match.id] === playerId ? 'is-picked' : ''}
              aria-pressed={picks[match.id] === playerId}
              disabled={locked}
              onClick={() => onPick(match.id, playerId)}
              onKeyDown={(event) => {
                const buttons = [...event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('button')];
                if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) {
                  event.preventDefault();
                  const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
                  buttons[(index + delta + buttons.length) % buttons.length]?.focus();
                } else if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onPick(match.id, playerId);
                }
              }}
            >
              <span className="player-seed">{player?.seed ?? '—'}</span>
              <span className="player-choice-name">{safeLiteralText(player?.name ?? playerId)}</span>
              <span className="advance-word">{picks[match.id] === playerId ? 'Advanced' : 'Advance'}</span>
            </button>
          );
        }) : (
          <p className="matchup-waiting">Complete both feeding matches first.</p>
        )}
      </div>
    </div>
  );
}

export function BracketPicker({
  draw,
  initialPicks,
  version: initialVersion,
  affectedMatchIds: initialAffected,
  locked,
  lockAt,
  initialSubmitted = false,
  onSave,
  onSubmit,
  onReload,
  onPendingChange,
  onVisualChange,
}: Props) {
  const initialRepaired = useMemo(
    () => clearAffectedPicks(initialPicks, initialAffected),
    [initialPicks, initialAffected],
  );
  const [picks, setPicks] = useState(initialRepaired);
  const [version, setVersion] = useState(initialVersion);
  const [affected, setAffected] = useState(initialAffected);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed' | 'stale' | 'repick' | 'conflict'>(
    initialAffected.length ? 'repick' : 'saved',
  );
  const [activeRound, setActiveRound] = useState(() => {
    const affectedRound = initialAffected[0] ? Number(initialAffected[0].match(/^r(\d+)/)?.[1]) : 0;
    return affectedRound || 1;
  });
  const [fillSnapshot, setFillSnapshot] = useState<Record<string, string> | null>(null);
  const [submitted, setSubmitted] = useState(initialSubmitted);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [clockLocked, setClockLocked] = useState(() => Date.now() >= new Date(lockAt).getTime());
  const [visualPlayer, setVisualPlayer] = useState(() => highlightedPlayer(draw, initialRepaired));
  const picksRef = useRef(picks);
  const versionRef = useRef(version);
  const saveStateRef = useRef(saveState);
  const savedRef = useRef(JSON.stringify(initialRepaired));
  const savingRef = useRef('');
  const inFlight = useRef(false);
  const queued = useRef(false);
  const performSaveRef = useRef<() => Promise<void>>(async () => {});
  const mounted = useRef(true);
  const timer = useRef<number | null>(null);
  const retryTimer = useRef<number | null>(null);
  const total = draw.rounds.reduce((sum, round) => sum + round.matches.length, 0);
  const effectiveLocked = locked || clockLocked;
  const draftPersisted = saveState === 'saved' || saveState === 'conflict';

  useEffect(() => {
    onVisualChange?.(forecastDraw(draw, picks), visualPlayer);
  }, [draw, onVisualChange, picks, visualPlayer]);

  useEffect(() => {
    const remaining = new Date(lockAt).getTime() - Date.now();
    if (remaining <= 0) {
      setClockLocked(true);
      return;
    }
    const timeout = window.setTimeout(() => setClockLocked(true), Math.min(remaining, 2_147_483_647));
    return () => window.clearTimeout(timeout);
  }, [lockAt]);

  useEffect(() => {
    picksRef.current = picks;
  }, [picks]);
  useEffect(() => {
    versionRef.current = version;
  }, [version]);
  useEffect(() => {
    saveStateRef.current = saveState;
  }, [saveState]);
  useEffect(() => {
    onPendingChange?.(
      inFlight.current
      || saveState === 'saving'
      || JSON.stringify(picks) !== savedRef.current,
    );
  }, [onPendingChange, picks, saveState]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) window.clearTimeout(timer.current);
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
    };
  }, []);

  const performSave = useCallback(async () => {
    if (!mounted.current) return;
    if (effectiveLocked || inFlight.current) {
      queued.current = true;
      return;
    }
    const sent = picksRef.current;
    if (JSON.stringify(sent) === savedRef.current) return;
    savingRef.current = JSON.stringify(sent);
    inFlight.current = true;
    setSaveState('saving');
    try {
      const result = await onSave(versionRef.current, sent);
      if (!mounted.current) return;
      versionRef.current = result.version;
      setVersion(result.version);
      savedRef.current = JSON.stringify(sent);
      if (result.affectedMatchIds.length) {
        const repaired = clearAffectedPicks(picksRef.current, result.affectedMatchIds);
        picksRef.current = repaired;
        setPicks(repaired);
        setVisualPlayer(highlightedPlayer(draw, repaired));
        setAffected(result.affectedMatchIds);
        setSaveState('repick');
        setActiveRound(Number(result.affectedMatchIds[0]?.match(/^r(\d+)/)?.[1]) || 1);
      } else {
        setSaveState(JSON.stringify(picksRef.current) === savedRef.current ? 'saved' : 'idle');
      }
    } catch (error) {
      if (!mounted.current) return;
      const apiError = error as LeagueApiError;
      const ids = Array.isArray(apiError.details?.affectedMatchIds)
        ? apiError.details.affectedMatchIds.filter((id): id is string => typeof id === 'string')
        : [];
      if (ids.length) {
        const repaired = clearAffectedPicks(picksRef.current, ids);
        picksRef.current = repaired;
        setPicks(repaired);
        setVisualPlayer(highlightedPlayer(draw, repaired));
        setAffected(ids);
        setSaveState('stale');
        setActiveRound(Number(ids[0]?.match(/^r(\d+)/)?.[1]) || 1);
      } else if (apiError.code === 'draft_conflict' && Number.isInteger(apiError.details?.currentVersion)) {
        const currentPicks = apiError.details?.currentPicks;
        const authoritative = currentPicks && typeof currentPicks === 'object'
          ? Object.fromEntries(Object.entries(currentPicks).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ))
          : {};
        versionRef.current = Number(apiError.details!.currentVersion);
        setVersion(versionRef.current);
        picksRef.current = authoritative;
        setPicks(authoritative);
        savedRef.current = JSON.stringify(authoritative);
        setVisualPlayer(highlightedPlayer(draw, authoritative));
        setSaveState('conflict');
      } else {
        setSaveState('failed');
      }
    } finally {
      inFlight.current = false;
      if (mounted.current && queued.current) {
        queued.current = false;
        retryTimer.current = window.setTimeout(() => void performSaveRef.current(), 0);
      }
    }
  }, [draw, effectiveLocked, onSave]);
  performSaveRef.current = performSave;

  useEffect(() => {
    if (effectiveLocked || JSON.stringify(picks) === savedRef.current || saveStateRef.current === 'failed') return;
    if (saveStateRef.current === 'saving') {
      if (JSON.stringify(picks) !== savingRef.current) queued.current = true;
      return;
    }
    setSaveState(affected.length ? 'repick' : 'idle');
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void performSave(), 450);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [picks, affected.length, effectiveLocked, performSave]);

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (JSON.stringify(picksRef.current) !== savedRef.current) event.preventDefault();
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, []);

  useEffect(() => {
    if (!initialAffected[0]) return;
    matchElement(initialAffected[0])?.focus();
  }, [initialAffected]);

  const count = validPickCount(draw, picks);
  const round = draw.rounds.find((item) => item.round === activeRound) ?? draw.rounds[0]!;
  const remainingThisRound = round.matches.filter((match) => !picks[match.id]).length;
  const canSubmit = count === total && affected.length === 0 && draftPersisted && !effectiveLocked && !submitting;

  const choose = (matchId: string, playerId: string) => {
    if (effectiveLocked) return;
    const result = pickWinner(draw, picksRef.current, matchId, playerId);
    picksRef.current = result.picks;
    setPicks(result.picks);
    setVisualPlayer(playerId);
    setSubmitted(false);
    setFillSnapshot(null);
    setAffected((ids) => ids.filter((id) => id !== matchId && !result.cleared.includes(id)));
    const currentRound = draw.rounds.find((item) => item.matches.some((match) => match.id === matchId))!;
    const next = currentRound.matches.find((match) => !result.picks[match.id]);
    if (next) {
      sound.confirmPick();
      window.setTimeout(() => matchElement(next.id)?.querySelector<HTMLButtonElement>('button')?.focus(), 0);
    } else if (currentRound.round < draw.rounds.length) {
      sound.confirmPick(true);
      setActiveRound(currentRound.round + 1);
    } else {
      sound.crown();
    }
  };

  const seedFill = () => {
    setFillSnapshot(picksRef.current);
    const filled = fillRemainingBySeed(draw, picksRef.current);
    picksRef.current = filled;
    setPicks(filled);
    setVisualPlayer(highlightedPlayer(draw, filled));
    setAffected([]);
    setActiveRound(draw.rounds.length);
  };

  const undoFill = () => {
    if (!fillSnapshot) return;
    picksRef.current = fillSnapshot;
    setPicks(fillSnapshot);
    setVisualPlayer(highlightedPlayer(draw, fillSnapshot));
    setFillSnapshot(null);
    const first = draw.rounds.find((item) => item.matches.some((match) => !fillSnapshot[match.id]));
    setActiveRound(first?.round ?? 1);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      await onSubmit(versionRef.current);
      setSubmitted(true);
    } catch (error) {
      const apiError = error as LeagueApiError;
      if (apiError.code === 'locked') setSubmitError('The bracket locked before this submission reached the server.');
      else if (apiError.code === 'draft_conflict' || apiError.code === 'revision_conflict') {
        setSubmitError('The draw changed. Reloading your saved bracket.');
        await onReload?.();
      }
      else setSubmitError('The bracket was not submitted. Your saved draft is still here; try again.');
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  };

  return (
    <main className={`bracket-picker${effectiveLocked ? ' is-locked' : ''}`}>
      <header className="picker-head">
        <div>
          <p className="league-kicker">{draw.tournament} · {draw.event}</p>
          <h1>{effectiveLocked ? 'Predictions are locked' : submitted ? 'Your bracket is in' : 'Build the path to the title'}</h1>
          <p>{effectiveLocked
            ? `Entry closed at ${exactTime(lockAt)}. Only submitted brackets can appear after lock.`
            : submitted
              ? `Your picks stay hidden from everyone else until ${exactTime(lockAt)}. You can still revise and resubmit before then.`
              : `Choose every winner. Your picks stay private until ${exactTime(lockAt)}.`}</p>
        </div>
        <div className="picker-tools">
          {!effectiveLocked && (fillSnapshot
            ? <button type="button" onClick={undoFill}>Undo seed fill</button>
            : <button type="button" onClick={seedFill}>Fill remaining by seed</button>)}
          <span>Seed fill chooses the lower seed number only where you have not picked. It never submits.</span>
        </div>
      </header>

      <BracketStatus picked={count} total={total} remainingThisRound={remainingThisRound} saveState={saveState} affectedCount={affected.length} onRetry={() => void performSave()} />

      <div className="picker-workspace">
        <section className="round-drawer mobile-round-drawer" aria-label="Round picker">
          <div className="round-tabs-shell">
            <nav className="round-tabs" aria-label="Rounds">
            {draw.rounds.map((item) => {
              const complete = item.matches.every((match) => picks[match.id]);
              return <button type="button" key={item.round} aria-current={item.round === activeRound ? 'step' : undefined} onClick={() => { sound.roundNavigate(); setActiveRound(item.round); }}>{item.name}<span>{complete ? 'Complete' : `${item.matches.filter((match) => !picks[match.id]).length} left`}</span></button>;
            })}
            </nav>
            <span className="round-tabs-cue" aria-hidden="true"><DrawIcon name="round" />Rounds</span>
          </div>
          <div className="round-heading">
            <p>Round {round.round} of {draw.rounds.length}</p>
            <h2>{round.name}</h2>
          </div>
          <div className="matchup-list">
            {round.matches.map((match) => <Matchup key={match.id} draw={draw} match={match} round={round} picks={picks} affected={affected.includes(match.id)} locked={effectiveLocked} onPick={choose} />)}
          </div>
          {round.round === draw.rounds.length && picks[round.matches[0]?.id ?? ''] && (
            <div className="champion-ceremony" role="status">
              <span>Your champion</span>
              <strong>{safeLiteralText(draw.players[picks[round.matches[0]!.id]!]?.name ?? '')}</strong>
              <p>The complete path is ready for your final check.</p>
            </div>
          )}
        </section>
      </div>

      <footer className="picker-submit">
        <div>
          <strong>{count === total ? `All ${total} paths resolved` : `${total - count} picks to go`}</strong>
          <span>{affected.length ? 'Repair the marked branch before submitting.' : !draftPersisted ? 'Wait for the draft to save before submitting.' : 'You can change and resubmit until lock.'}</span>
        </div>
        <button type="button" disabled={!canSubmit} onClick={() => void submit()}>{submitting ? 'Submitting bracket' : 'Submit bracket'}</button>
        {submitError && <p role="alert">{submitError}</p>}
      </footer>
    </main>
  );
}
