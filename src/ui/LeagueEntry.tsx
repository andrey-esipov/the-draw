import { useRef, useState, type FormEvent } from 'react';
import { safeLiteralText } from './safe-text';
import { DrawIcon } from './DrawIcon';

type Props =
  | { mode: 'closed' }
  | {
      mode: 'join';
      leagueName: string;
      seatsRemaining: number;
      lockAt: string;
      onJoin: (displayName: string, idempotencyKey: string) => Promise<{ returnLink: string }>;
    }
  | {
      mode: 'create';
      eventName: string;
      onCreate: (leagueName: string, displayName: string, idempotencyKey: string) => Promise<{ invitationLink: string; returnLink: string }>;
    }
  | {
      mode: 'links';
      invitationLink?: string;
      returnLink: string;
      emailState?: 'idle' | 'unavailable' | 'failed' | 'queued' | 'throttled';
      onEmail?: (email: string) => Promise<'unavailable' | 'failed' | 'queued' | 'throttled'>;
      onContinue: () => void;
      copy?: (text: string) => Promise<void>;
    };

function exactTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(value));
}

export function LeagueEntry(props: Props) {
  const [displayName, setDisplayName] = useState('');
  const [leagueName, setLeagueName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [links, setLinks] = useState<{ invitationLink?: string; returnLink: string } | null>(
    props.mode === 'links' ? props : null,
  );
  const [copyState, setCopyState] = useState<Record<string, 'copied' | 'failed'>>({});
  const [email, setEmail] = useState('');
  const request = useRef<{ signature: string; key: string } | null>(null);
  const [emailState, setEmailState] = useState<'idle' | 'sending' | 'unavailable' | 'failed' | 'queued' | 'throttled'>(
    props.mode === 'links' ? props.emailState ?? 'idle' : 'idle',
  );

  if (props.mode === 'closed') {
    return <section className="league-entry league-terminal"><p className="league-kicker">Private draw</p><h1>This invitation has closed</h1><p>The bracket locked at the tournament’s exact first-match time. Ask your organizer about the next draw.</p></section>;
  }
  if (props.mode === 'join' && props.seatsRemaining === 0) {
    return <section className="league-entry league-terminal"><p className="league-kicker">32 of 32 joined</p><h1>This league is full</h1><p>No place was created. Ask the organizer to start a separate league.</p></section>;
  }

  const activeLinks = links ?? (props.mode === 'links' ? props : null);
  if (activeLinks) {
    const copy = props.mode === 'links' && props.copy ? props.copy : (text: string) => navigator.clipboard.writeText(text);
    const copyLink = async (kind: 'invitation' | 'return', value: string) => {
      try {
        await copy(value);
        setCopyState((state) => ({ ...state, [kind]: 'copied' }));
      } catch {
        setCopyState((state) => ({ ...state, [kind]: 'failed' }));
      }
    };
    const onContinue = props.mode === 'links' ? props.onContinue : () => {};
    return (
      <section className="league-entry league-links">
        <p className="league-kicker">Your place is held</p>
        <h1>Keep the way back</h1>
        <p className="league-recovery">There are no accounts. If you skip email, this private return link is the only way back to your picks.</p>
        <div className="league-link-list">
          {activeLinks.invitationLink && (
            <div className="league-link-row">
              <div><strong><DrawIcon name="invitation" />Invitation</strong><span>Send this multi-use link to friends.</span></div>
              <button type="button" onClick={() => copyLink('invitation', activeLinks.invitationLink!)}>Copy invitation</button>
              {copyState.invitation === 'copied' && <small role="status">Copied</small>}
              {copyState.invitation === 'failed' && <small role="alert">Could not copy. Select the link manually.</small>}
              <input aria-label="Invitation link" readOnly value={activeLinks.invitationLink} onFocus={(event) => event.currentTarget.select()} />
            </div>
          )}
          <div className="league-link-row is-private">
            <div><strong><DrawIcon name="private-link" />Private return link</strong><span>Do not share. It opens and edits your bracket.</span></div>
            <button type="button" onClick={() => copyLink('return', activeLinks.returnLink)}>Copy private return link</button>
            {copyState.return === 'copied' && <small role="status">Copied</small>}
            {copyState.return === 'failed' && <small role="alert">Could not copy. Select the link manually.</small>}
            <input aria-label="Private return link" readOnly value={activeLinks.returnLink} onFocus={(event) => event.currentTarget.select()} />
          </div>
        </div>
        {props.mode === 'links' && props.onEmail && (
          <form
            className="league-email-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!email || emailState === 'sending') return;
              setEmailState('sending');
              try {
                setEmailState(await props.onEmail!(email));
              } catch {
                setEmailState('failed');
              }
            }}
          >
            <label>Optional email copy<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>
            <button type="submit" disabled={emailState === 'sending'}>{emailState === 'sending' ? 'Requesting…' : 'Email my return link'}</button>
          </form>
        )}
        {emailState !== 'idle' && emailState !== 'sending' && (
          <p className="email-state" role="status">
            {emailState === 'queued' ? 'Email queued. Keep the link until it arrives.'
              : emailState === 'throttled' ? 'Too many email requests. Try again later. Your private link still works.'
              : emailState === 'unavailable' ? 'Email delivery is unavailable. Save the private link now.'
                : 'Email could not be sent. Your private link still works.'}
          </p>
        )}
        <button type="button" className="league-primary" onClick={onContinue}>Start picking</button>
      </section>
    );
  }

  if (props.mode !== 'join' && props.mode !== 'create') return null;

  const hasUnsafeCharacter = [...displayName].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127 || code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069;
  });
  const validName = displayName.trim().length > 0 && displayName.trim().length <= 60 && !hasUnsafeCharacter;
  const validLeague = props.mode !== 'create' || (leagueName.trim().length > 0 && leagueName.trim().length <= 80);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!validName || !validLeague) return;
    setBusy(true);
    setError('');
    const signature = props.mode === 'join'
      ? `join:${displayName.trim()}`
      : `create:${leagueName.trim()}:${displayName.trim()}`;
    if (request.current?.signature !== signature) {
      request.current = { signature, key: crypto.randomUUID().replaceAll('-', '') };
    }
    try {
      const result = props.mode === 'join'
        ? await props.onJoin(displayName.trim(), request.current.key)
        : await props.onCreate(leagueName.trim(), displayName.trim(), request.current.key);
      request.current = null;
      setLinks(result);
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : '';
      setError(code === 'league_full' ? 'This league filled before your place could be created.'
        : code === 'invitation_closed' ? 'This invitation closed before your place could be created.'
          : code === 'draw_locked' ? 'This draw has already locked and can no longer accept new leagues.'
            : code === 'draw_unavailable' ? 'This draw is not available for a new league right now.'
              : 'Your place could not be created. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="league-entry">
      <p className="league-kicker">{props.mode === 'join' ? `${props.seatsRemaining} places remain` : 'Private draw'}</p>
      <h1>{props.mode === 'join' ? safeLiteralText(props.leagueName, 80) : `Start a ${safeLiteralText(props.eventName, 80)} bracket`}</h1>
      {props.mode === 'join' && <p className="league-entry-lock">Picks stay hidden until <time dateTime={props.lockAt}>{exactTime(props.lockAt)}</time>.</p>}
      <form onSubmit={submit}>
        {props.mode === 'create' && <label>League name<input value={leagueName} maxLength={80} onChange={(event) => setLeagueName(event.target.value)} autoComplete="off" /></label>}
        <label>Your display name<input value={displayName} maxLength={61} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" aria-describedby="display-name-note" /></label>
        <p id="display-name-note">Shown exactly as entered to the friends who join. 60 characters maximum.</p>
        {error && <p className="league-form-error" role="alert">{error}</p>}
        <button className="league-primary" type="submit" disabled={!validName || !validLeague || busy}>
          {busy ? 'Holding your place…' : props.mode === 'join' ? 'Join the bracket' : 'Create private league'}
        </button>
      </form>
    </section>
  );
}
