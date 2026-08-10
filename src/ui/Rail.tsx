import type { Player } from '../data/types';
import type { DrawIndex, PathStep } from '../data/analysis';
import { pathOf } from '../data/analysis';
import type { SlamTheme } from './theme';

const SHORT_ROUND = ['', 'R1', 'R2', 'R3', 'R4', 'QF', 'SF', 'F'];

function outcome(steps: PathStep[], isChampion: boolean): string {
  if (isChampion) return 'Champion';
  const last = steps[steps.length - 1];
  if (!last) return 'Did not play';
  const name = last.roundName.toLowerCase();
  return `Out in the ${name.replace('quarterfinals', 'quarterfinals').replace('semifinals', 'semifinals')}`;
}

interface Props {
  index: DrawIndex;
  theme: SlamTheme;
  player: Player | null;
  /** True once a player has been deliberately traced, which earns the full card. */
  traced: boolean;
}

export function Rail({ index, theme, player, traced }: Props) {
  if (!player) return null;
  const steps = pathOf(index, player.id);
  const isChampion = index.champion?.id === player.id;
  const wins = steps.filter((s) => s.won).length;

  return (
    <aside className="rail">
      <p className="eyebrow">{traced ? 'Tracing' : 'Champion'}</p>

      <h1 className="player-name">{player.name}</h1>

      <p className="player-meta">
        {!traced && (
          <span className="outcome" style={{ color: theme.flare }}>
            {wins} wins <span className="dot">·</span>{' '}
            {steps.reduce((n, x) => n + x.games, 0)} games
          </span>
        )}
        {player.seed && <span className="seed">Seed {player.seed}</span>}
        {player.country && <span className="country">{player.country}</span>}
        {(traced || !isChampion) && (
          <span className="outcome" style={{ color: isChampion ? theme.flare : undefined }}>
            {outcome(steps, isChampion)}
          </span>
        )}
      </p>

      {!traced && (
        <p className="rail-invite">
          Search or select any of the 128 names to open their tournament.
        </p>
      )}

      {traced && (
      <>
      <ol className="path">
        {steps.map((step) => (
          <li key={step.match.id} className={`step${step.won ? ' is-win' : ' is-loss'}`}>
            <span className="step-round">{SHORT_ROUND[step.match.round]}</span>
            <span className="step-opponent">{step.opponent?.name ?? 'Bye'}</span>
            <span className="step-score">{step.score}</span>
          </li>
        ))}
      </ol>

      <p className="tally">
        <span className="tally-n">{wins}</span> {wins === 1 ? 'win' : 'wins'}
        <span className="dot">·</span>
        <span className="tally-n">{steps.reduce((s, x) => s + x.games, 0)}</span> games played
      </p>
      </>
      )}
    </aside>
  );
}
