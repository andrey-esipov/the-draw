import { useEffect, useState } from 'react';
import type { Draw } from '../data/types';
import type { FormLine } from '../data/form';
import { COMPLETED, seasonForm } from '../data/form';
import type { SlamTheme } from './theme';

const OPEN_DATE = 'Monday 24 August';
const DRAW_DATE = 'Thursday 20 August';

interface Props {
  theme: SlamTheme;
  tour: 'men' | 'women';
  pick: string | null;
  onPick: (id: string | null, name: string | null) => void;
}

/**
 * The draw for this tournament has not been made. Rather than inventing one, the
 * page says so and offers what the season's own results already support: who is
 * arriving in form, and a pick you can commit to before the real draw lands.
 */
export function Forthcoming({ theme, tour, pick, onPick }: Props) {
  const [form, setForm] = useState<FormLine[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setForm(null);
    setFailed(false);
    Promise.all(
      COMPLETED[tour].map((id) =>
        fetch(`${import.meta.env.BASE_URL}draws/${id}.json`).then((r) => {
          if (!r.ok) throw new Error(`${id} unavailable`);
          return r.json() as Promise<Draw>;
        }),
      ),
    )
      .then((draws) => { if (live) setForm(seasonForm(draws)); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [tour]);

  const picked = form?.find((f) => f.player.id === pick) ?? null;

  return (
    <div className="forthcoming">
      <div className="forth-head">
        <p className="eyebrow">
          {picked ? 'Your champion' : `Flushing Meadows, New York · ${tour === 'men' ? "Men's" : "Women's"} Singles`}
        </p>
        <h1 className="forth-title">
          {picked ? picked.player.name : 'Nobody has a thread yet'}
        </h1>
        <p className="forth-note">
          {picked ? (
            <>Your pick for the title. The draw is made {DRAW_DATE}.</>
          ) : (
            <>
              Play begins {OPEN_DATE}. The draw is made {DRAW_DATE}. Until then these 128
              positions are empty, and the season so far is all anyone has to go on.
            </>
          )}
        </p>
      </div>

      <div className="forth-form">
        <p className="forth-label">The season so far</p>

        {failed && (
          <p className="forth-error">
            The completed 2026 draws could not be loaded, so the form guide is unavailable.
          </p>
        )}

        {!form && !failed && <p className="forth-loading">Counting the season…</p>}

        {form && (
          <ol className="form-list">
            {form.map((line) => (
              <li key={line.player.id}>
                <button
                  className={`form-row${pick === line.player.id ? ' is-picked' : ''}`}
                  style={{ '--flare': theme.flare } as React.CSSProperties}
                  aria-pressed={pick === line.player.id}
                  onClick={() =>
                    pick === line.player.id
                      ? onPick(null, null)
                      : onPick(line.player.id, line.player.name)
                  }
                >
                  <span className="form-name">{line.player.name}</span>
                  <span className="form-stat">
                    {line.titles > 0 && (
                      <span className="form-titles">
                        {line.titles} {line.titles === 1 ? 'title' : 'titles'}
                      </span>
                    )}
                    <span className="form-wins">{line.wins}W</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}

        {form && (
          <p className="forth-foot">
            Counted from the {COMPLETED[tour].length} completed 2026 draws. Tap a name to pick
            your champion.
          </p>
        )}
      </div>
    </div>
  );
}
