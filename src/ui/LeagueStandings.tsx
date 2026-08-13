import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DrawLeagueProjection, DrawLeagueStanding, DrawPathState } from '../../shared/draw/contracts';
import { safeLiteralText } from './safe-text';
import { LeagueRecap } from './LeagueRecap';
import { DrawIcon } from './DrawIcon';
import { sound } from '../audio/sound';

interface Props {
  leagueName: string;
  eventKind: 'mens_singles' | 'womens_singles';
  viewerParticipantId: string;
  participantCount: number;
  projection: DrawLeagueProjection;
}

const stateCopy: Record<DrawPathState, { mark: string; label: string }> = {
  alive: { mark: '●', label: 'Alive' },
  broken: { mark: '×', label: 'Broken' },
  unresolved: { mark: '○', label: 'Unresolved' },
  'changed-opponent': { mark: '◇', label: 'Advanced, opponent changed' },
  withdrawn: { mark: '⊘', label: 'Player withdrawn, unscorable' },
};

function defaultRound(standing: DrawLeagueStanding | null): number | null {
  if (!standing?.path.length) return null;
  const attentionRound = standing.path
    .filter((step) => step.state === 'unresolved' || step.state === 'changed-opponent' || step.state === 'withdrawn')
    .reduce<number | null>((earliest, step) => earliest === null ? step.round : Math.min(earliest, step.round), null);
  return attentionRound ?? Math.max(...standing.path.map((step) => step.round));
}

function exactTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'long',
  }).format(new Date(value));
}

export function LeagueStandings({
  leagueName,
  eventKind,
  viewerParticipantId,
  participantCount,
  projection,
}: Props) {
  const defaultId = projection.standings.some((standing) => standing.participantId === viewerParticipantId)
    ? viewerParticipantId
    : projection.standings[0]?.participantId ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(defaultId);
  const selected = projection.standings.find((standing) => standing.participantId === selectedId) ?? null;
  const [selectedRound, setSelectedRound] = useState<number | null>(() => defaultRound(selected));
  const pathPaneRef = useRef<HTMLElement>(null);
  const pathTitleRef = useRef<HTMLHeadingElement>(null);
  const roundNavRef = useRef<HTMLDivElement>(null);
  const standingById = useMemo(
    () => new Map(projection.standings.map((standing) => [standing.participantId, standing])),
    [projection.standings],
  );
  const submittedCount = projection.standings.length;
  const sourceState = projection.canonical.freshness.state;
  const rounds = useMemo(() => {
    const grouped = new Map<number, DrawLeagueStanding['path']>();
    for (const step of selected?.path ?? []) {
      const steps = grouped.get(step.round) ?? [];
      steps.push(step);
      grouped.set(step.round, steps);
    }
    return [...grouped.entries()]
      .sort(([a], [b]) => a - b)
      .map(([round, steps]) => ({ round, name: steps[0].roundName, steps }));
  }, [selected]);
  const visibleRound = rounds.find(({ round }) => round === selectedRound) ?? rounds[0] ?? null;

  useLayoutEffect(() => {
    const nav = roundNavRef.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav && current) {
      nav.scrollLeft = Math.max(0, current.offsetLeft - nav.offsetLeft - 8);
    }
  }, [selectedId, selectedRound]);

  function inspectStanding(standing: DrawLeagueStanding) {
    sound.friendRoute();
    setSelectedId(standing.participantId);
    setSelectedRound(defaultRound(standing));
    if (window.matchMedia?.('(max-width: 900px)').matches) {
      window.requestAnimationFrame(() => {
        pathTitleRef.current?.focus({ preventScroll: true });
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
        pathPaneRef.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
      });
    }
  }

  return (
    <main className="standings-shell">
      <header className="standings-head">
        <div>
          <p className="league-kicker">Live clubhouse · {eventKind === 'mens_singles' ? "Men's singles" : "Women's singles"}</p>
          <h1>{safeLiteralText(leagueName, 80)}</h1>
          <p>{submittedCount} submitted · {participantCount} joined</p>
        </div>
        <div className={`source-proof is-${sourceState}`} role="status">
          <strong>{sourceState === 'current'
            ? 'Accepted source current'
            : sourceState === 'conflicting'
              ? 'Source conflict held'
              : sourceState === 'stale'
                ? 'Source update overdue'
                : 'Source delayed'}</strong>
          <span>Scores through <time dateTime={projection.canonical.acceptedAt}>{exactTime(projection.canonical.acceptedAt)}</time></span>
          <a href={projection.canonical.sourceUrl} target="_blank" rel="noreferrer">Published source (not independently verified)</a>
          <code title={projection.canonical.checksum}>Revision {projection.canonical.sourceRevisionId} · {projection.canonical.checksum.slice(0, 10)}</code>
        </div>
      </header>

      {(sourceState !== 'current' || projection.canonical.corrected) && (
        <section className="projection-notice" aria-label="Scoring update">
          <strong>{projection.canonical.corrected ? 'Correction replayed' : 'Latest source check delayed'}</strong>
          <p>
            {projection.canonical.corrected
              ? 'Every score was recomputed from each locked bracket against this accepted revision.'
              : `Scores remain tied to the last accepted revision${projection.canonical.freshness.delayReason ? ` (${projection.canonical.freshness.delayReason})` : ''}.`}
            {projection.canonical.corrected && sourceState !== 'current'
              ? ` The latest source check is ${sourceState}; scores remain tied to this revision${projection.canonical.freshness.delayReason ? ` (${projection.canonical.freshness.delayReason})` : ''}.`
              : ''}
          </p>
        </section>
      )}

      <LeagueRecap recap={projection.recap} />

      <div className="clubhouse-layout">
        <section className="standings-pane" aria-labelledby="standings-title">
          <div className="standings-section-head">
            <h2 id="standings-title">Standings</h2>
            {!projection.movementAvailable && <span>Movement unavailable before a comparison revision</span>}
          </div>
          {projection.participants.length === 0 ? (
            <p className="standings-empty">No one joined this league.</p>
          ) : (
            <div className="standings-table-wrap">
              <table>
                <caption className="sr-only">League standings and submitted bracket availability</caption>
                <thead>
                  <tr><th scope="col">Rank</th><th scope="col">Friend</th><th scope="col">Points</th><th scope="col">Possible</th><th scope="col">Move</th><th scope="col">Champion</th></tr>
                </thead>
                <tbody>
                  {projection.participants.map((participant) => {
                    const standing = standingById.get(participant.id);
                    const isViewer = participant.id === viewerParticipantId;
                    return (
                      <tr key={participant.id} className={selectedId === participant.id ? 'is-selected' : undefined}>
                        <td className="rank-cell">{standing ? `${standing.tied ? 'T' : ''}${standing.rank}` : '—'}</td>
                        <th scope="row">
                          {standing ? (
                            <button type="button" aria-pressed={selectedId === participant.id} onClick={() => inspectStanding(standing)}>
                              <DrawIcon name="friend-route" />
                              <span>{safeLiteralText(participant.displayName, 60)}</span>
                              {isViewer && <em>You</em>}
                            </button>
                          ) : (
                            <span>
                              {participant.removed && <DrawIcon name="removal" />}
                              {safeLiteralText(participant.displayName, 60)}
                              {participant.removed && <span className="sr-only">, removed</span>}
                              {isViewer && <em>You</em>}
                            </span>
                          )}
                          {!standing && <small>No submitted bracket</small>}
                          {standing?.unscorable && <small className="standing-unscorable">Partial score · a pick is unscorable (player withdrawn)</small>}
                        </th>
                        <td>{standing?.score ?? '—'}</td>
                        <td>{standing?.maxPossible ?? '—'}</td>
                        <td>
                          {standing?.movement === null || standing?.movement === undefined
                            ? '—'
                            : standing.movement === 0
                              ? 'Held'
                              : `${standing.movement > 0 ? '↑' : '↓'} ${Math.abs(standing.movement)}`}
                        </td>
                        <td>{standing ? <span className={`champion-state is-${standing.champion.state}`}><b aria-hidden="true">{standing.champion.state === 'alive' ? '◆' : standing.champion.state === 'broken' ? '×' : '○'}</b>{safeLiteralText(standing.champion.playerName, 40)}</span> : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="path-pane" aria-labelledby="path-title" ref={pathPaneRef}>
          {selected ? (
            <>
              <header>
                <p>{selected.participantId === viewerParticipantId ? 'Your submitted path' : 'Submitted path'}</p>
                <h2 id="path-title" ref={pathTitleRef} tabIndex={-1}>{safeLiteralText(selected.displayName, 60)}</h2>
                <span>{selected.score} points · {selected.maxPossible}-point ceiling</span>
                {selected.unscorable && (
                  <span className="standing-unscorable">A withdrawn player made one pick unscorable; other rounds still score normally.</span>
                )}
              </header>
              {rounds.length > 0 && (
                <nav className="path-rounds" aria-label="Submitted path rounds">
                  <div className="path-rounds-scroll" ref={roundNavRef}>
                    {rounds.map(({ round, name, steps }) => {
                      const attentionCount = steps.filter((step) => step.state === 'unresolved' || step.state === 'changed-opponent' || step.state === 'withdrawn').length;
                      const aliveCount = steps.filter((step) => step.state === 'alive').length;
                      const brokenCount = steps.filter((step) => step.state === 'broken').length;
                      const status = attentionCount > 0
                        ? `${attentionCount} need attention`
                        : brokenCount > 0
                          ? `${aliveCount} alive, ${brokenCount} broken`
                          : `${aliveCount} alive`;
                      return (
                        <button
                          key={round}
                          type="button"
                          aria-current={visibleRound?.round === round ? 'page' : undefined}
                          aria-label={`${name}, ${steps.length} ${steps.length === 1 ? 'match' : 'matches'}: ${status}`}
                          onClick={() => { sound.roundNavigate(); setSelectedRound(round); }}
                        >
                          <strong>{safeLiteralText(name, 30)}</strong>
                          <span>{steps.length} {steps.length === 1 ? 'match' : 'matches'} · {status}</span>
                        </button>
                      );
                    })}
                  </div>
                  <span className="path-rounds-hint" aria-hidden="true"><DrawIcon name="round" />Scroll for every round</span>
                </nav>
              )}
              <ol className="submitted-path" aria-label={visibleRound ? `${visibleRound.name} submitted picks` : undefined}>
                {(visibleRound?.steps ?? []).map((step) => {
                  const copy = stateCopy[step.state];
                  return (
                    <li key={step.matchId} className={`is-${step.state}`}>
                      <span className="path-mark" aria-hidden="true">{copy.mark}</span>
                      <div>
                        <span>{step.roundName} · {step.points} pt{step.points === 1 ? '' : 's'}</span>
                        <strong>{safeLiteralText(step.predictedWinnerName, 60)}</strong>
                        <small>{copy.label}{step.predictedOpponentName ? ` · over ${safeLiteralText(step.predictedOpponentName, 60)}` : ''}</small>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </>
          ) : (
            <div className="path-empty">
              <h2 id="path-title">No submitted brackets</h2>
              <p>Incomplete drafts stayed private when the bracket locked.</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
