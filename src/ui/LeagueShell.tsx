import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { bootDone } from '../boot';
import {
  createLeague,
  emailLeagueReturnLink,
  joinLeague,
  LeagueApiError,
  readLeagueDraft,
  refreshLeague,
  saveLeagueDraft,
  submitLeagueBracket,
  type DrawDraftAccess,
  type LeagueAccessState,
  type LeagueCapability,
} from '../data/league-api';
import { BracketPicker } from './BracketPicker';
import { LeagueEntry } from './LeagueEntry';
import { LeagueStandings } from './LeagueStandings';
import { safeLiteralText } from './safe-text';
import type { Draw } from '../data/types';
import { DrawIcon } from './DrawIcon';
import { createLeaguePreviewFetch, type LeaguePreviewMode } from '../data/league-preview';

function Signature() {
  return <p className="league-signature">The Draw</p>;
}

function Failure({ kind }: { kind: 'invalid-access' | 'source-delay' | 'network-failure' | 'load-failure' }) {
  const content = {
    'invalid-access': ['Private draw unavailable', 'This private link is no longer valid', 'Ask the organizer for the current invitation. If you declined email and lost your private return link, there is no other recovery path.'],
    'source-delay': ['Source check in progress', 'The tournament draw is still being verified', 'No bracket is shown until the published draw passes its source checks. Try this link again shortly.'],
    'network-failure': ['Connection interrupted', 'The league could not be reached', 'Your private link has not changed. Check your connection, then refresh this page.'],
    'load-failure': ['Draft unavailable', 'Your picks could not be loaded', 'Nothing approximate is shown. Keep this private link and try again when the connection is restored.'],
  }[kind];
  return (
    <main className="league-shell">
      <section className="league-status" role="alert">
        <p className="league-kicker"><DrawIcon name="warning" />{content[0]}</p>
        <h1>{content[1]}</h1>
        <p>{content[2]}</p>
      </section>
      <Signature />
    </main>
  );
}

interface Props {
  state: LeagueAccessState;
  capability?: LeagueCapability;
  onVisualChange?: (draw: Draw | null, playerId: string | null) => void;
  previewDraw?: Draw | null;
  previewFetch?: typeof fetch;
  previewMode?: LeaguePreviewMode;
  onCapabilityChange?: (capability: LeagueCapability) => void;
}

function accessIdentity(state: LeagueAccessState, capability?: LeagueCapability): string {
  if (state.kind === 'create') return `create:${state.eventSlug}`;
  if (state.kind === 'invitation') {
    return `invitation:${state.invitation.leagueId}:${capability?.kind === 'invitation' ? capability.token : ''}`;
  }
  if (state.kind === 'participant') {
    return `participant:${state.league.league.id}:${state.league.participantId}:${capability?.kind === 'participant' ? capability.token : ''}`;
  }
  return state.kind;
}

export function LeagueShell({
  state: initialState,
  capability: initialCapability,
  onVisualChange,
  previewDraw,
  previewFetch,
  previewMode,
  onCapabilityChange,
}: Props) {
  const [state, setState] = useState(initialState);
  const [capability, setCapability] = useState(initialCapability);
  const [draft, setDraft] = useState<DrawDraftAccess | null>(null);
  const [links, setLinks] = useState<{ invitationLink?: string; returnLink: string } | null>(null);
  const [draftFailure, setDraftFailure] = useState(false);
  const refreshActive = useRef(false);
  const draftPending = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const activeAccessIdentity = useRef<string | null>(null);
  const participantLoadGeneration = useRef(0);
  const previewEventSlug = initialState.kind === 'create' ? initialState.eventSlug : 'us-open-2026-men';
  const fetcher = useMemo(() => (
    previewFetch
      ?? (previewDraw !== undefined
      ? createLeaguePreviewFetch(previewDraw, previewEventSlug, previewMode)
      : fetch)
  ), [previewDraw, previewEventSlug, previewFetch, previewMode]);

  useEffect(() => {
    bootDone();
  }, []);

  const surface = links
    ? 'links'
    : draftFailure
      ? 'load-failure'
      : state.kind === 'participant'
        ? state.league.league.revealed
          ? 'standings'
          : draft
            ? 'picker'
            : 'draft-loading'
        : state.kind;

  useLayoutEffect(() => {
    document.querySelector<HTMLElement>('.league-layer')?.scrollTo({ top: 0, behavior: 'auto' });
  }, [surface]);

  useEffect(() => {
    if (surface !== 'picker') onVisualChange?.(null, null);
  }, [onVisualChange, surface]);

  const loadParticipant = useCallback(async (
    participantCapability: LeagueCapability & { kind: 'participant' },
    knownState?: LeagueAccessState,
  ) => {
    const generation = ++participantLoadGeneration.current;
    setCapability(participantCapability);
    setDraftFailure(false);
    try {
      const access = knownState?.kind === 'participant'
        ? { league: knownState.league, checkedAt: knownState.checkedAt }
        : await refreshLeague(participantCapability, fetcher);
      if (generation !== participantLoadGeneration.current) return;
      setState({ kind: 'participant', ...access });
      if (access.league.league.revealed) return;
      const loaded = await readLeagueDraft(participantCapability, fetcher);
      if (generation !== participantLoadGeneration.current) return;
      setDraft(loaded);
    } catch (error) {
      if (generation !== participantLoadGeneration.current) return;
      if (error instanceof LeagueApiError && error.code === 'source_unavailable') {
        setState({ kind: 'source-delay' });
      } else if (error instanceof LeagueApiError && [401, 403, 404].includes(error.status)) {
        setState({ kind: 'invalid-access' });
      } else if (error instanceof LeagueApiError && error.code === 'locked') {
        try {
          const current = await refreshLeague(participantCapability, fetcher);
          if (generation !== participantLoadGeneration.current) return;
          setState({ kind: 'participant', ...current });
          setDraft(null);
          if (!current.league.league.revealed) setDraftFailure(true);
        } catch {
          if (generation === participantLoadGeneration.current) setDraftFailure(true);
        }
      } else {
        setDraftFailure(true);
      }
    }
  }, [fetcher]);

  useEffect(() => {
    const identity = accessIdentity(initialState, initialCapability);
    if (activeAccessIdentity.current === identity) return;
    activeAccessIdentity.current = identity;
    participantLoadGeneration.current += 1;
    refreshActive.current = false;
    setState(initialState);
    setCapability(initialCapability);
    setDraft(null);
    setLinks(null);
    setDraftFailure(false);
    if (initialState.kind === 'participant' && initialCapability?.kind === 'participant') {
      void loadParticipant(initialCapability, initialState);
    }
  }, [initialCapability, initialState, loadParticipant]);

  const refresh = useCallback(async () => {
    if (capability?.kind !== 'participant' || refreshActive.current) return;
    const generation = participantLoadGeneration.current;
    refreshActive.current = true;
    try {
      const current = await refreshLeague(capability, fetcher);
      if (generation !== participantLoadGeneration.current) return;
      setState({ kind: 'participant', ...current });
      if (!current.league.league.revealed && draft) {
        const currentDraft = await readLeagueDraft(capability, fetcher);
        if (generation !== participantLoadGeneration.current) return;
        if (
          currentDraft.acceptedRevisionId !== draft.acceptedRevisionId
          || currentDraft.affectedMatchIds.length
        ) {
          if (!draftPending.current) setDraft(currentDraft);
        }
      }
    } catch (error) {
      if (generation !== participantLoadGeneration.current) return;
      if (error instanceof LeagueApiError && error.code === 'source_unavailable') setState({ kind: 'source-delay' });
      else if (error instanceof LeagueApiError && [401, 403, 404].includes(error.status)) setState({ kind: 'invalid-access' });
    } finally {
      if (generation === participantLoadGeneration.current) refreshActive.current = false;
    }
  }, [capability, draft, fetcher]);
  refreshRef.current = refresh;

  const reloadDraft = useCallback(async () => {
    if (capability?.kind !== 'participant') return;
    const generation = participantLoadGeneration.current;
    const loaded = await readLeagueDraft(capability, fetcher);
    if (generation === participantLoadGeneration.current) setDraft(loaded);
  }, [capability, fetcher]);

  useEffect(() => {
    if (capability?.kind !== 'participant') return;
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 60_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(interval);
    };
  }, [capability, refresh]);

  if (state.kind === 'loading') {
    return <main className="league-shell" aria-busy="true"><section className="league-status" aria-live="polite"><p className="league-kicker">Private draw</p><h1>Opening your league</h1><p>The invitation and tournament source are being checked.</p></section><Signature /></main>;
  }
  if (state.kind === 'invalid-access' || state.kind === 'source-delay' || state.kind === 'network-failure') {
    return <Failure kind={state.kind} />;
  }
  if (draftFailure) return <Failure kind="load-failure" />;

  if (links && capability?.kind === 'participant') {
    return (
      <main className="league-shell">
        <LeagueEntry
          mode="links"
          {...links}
          emailState="idle"
          onEmail={async (email) => {
            const result = await emailLeagueReturnLink(capability, email, fetcher);
            return result.delivery.state === 'unconfirmed' ? 'failed' : result.delivery.state;
          }}
          onContinue={() => {
            setLinks(null);
            onCapabilityChange?.(capability);
            void loadParticipant(capability);
          }}
        />
        <Signature />
      </main>
    );
  }

  if (state.kind === 'create') {
    return (
      <main className="league-shell">
        <LeagueEntry
          mode="create"
          eventName={state.eventName}
          onCreate={async (leagueName, displayName, idempotencyKey) => {
            const result = await createLeague(state.eventSlug, leagueName, displayName, fetcher, idempotencyKey);
            setCapability(result.capability);
            const nextLinks = { invitationLink: result.invitationLink, returnLink: result.returnLink };
            setLinks(nextLinks);
            return nextLinks;
          }}
        />
        <Signature />
      </main>
    );
  }

  if (state.kind === 'invitation') {
    const invitationCapability = capability?.kind === 'invitation' ? capability : null;
    return (
      <main className="league-shell">
        <LeagueEntry
          mode="join"
          leagueName={state.invitation.leagueName}
          seatsRemaining={state.invitation.seatsRemaining}
          lockAt={state.invitation.lockAt}
          onJoin={async (displayName, idempotencyKey) => {
            if (!invitationCapability) throw new LeagueApiError('invalid_access', 404);
            try {
              const result = await joinLeague(invitationCapability, displayName, fetcher, idempotencyKey);
              setCapability(result.capability);
              const nextLinks = { returnLink: result.returnLink };
              setLinks(nextLinks);
              return nextLinks;
            } catch (error) {
              if (error instanceof LeagueApiError) {
                if (error.code === 'league_full') throw new Error('league_full', { cause: error });
                if (error.status === 404) throw new Error('invitation_closed', { cause: error });
              }
              throw error;
            }
          }}
        />
        <p className="league-invite-freshness" role="status">Checked {new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(state.checkedAt))}</p>
        <Signature />
      </main>
    );
  }

  if (state.kind === 'participant') {
    const participantCapability = capability?.kind === 'participant' ? capability : null;
    if (!participantCapability) {
      return (
        <main className="league-shell">
          <section className="league-status">
            <p className="league-kicker">Your private draw</p>
            <h1>{state.league.league.name}</h1>
            <p className="league-event">{state.league.league.eventKind === 'mens_singles' ? "Men's singles" : "Women's singles"}</p>
            <p className="league-context">Your place is confirmed. Reopen your private return link to restore prediction controls.</p>
          </section>
          <Signature />
        </main>
      );
    }
    if (state.league.league.revealed) {
      if (!state.league.projection) {
        return <Failure kind="load-failure" />;
      }
      return (
        <LeagueStandings
          leagueName={state.league.league.name}
          eventKind={state.league.league.eventKind}
          viewerParticipantId={state.league.participantId}
          participantCount={state.league.participantCount}
          projection={state.league.projection}
        />
      );
    }
    if (!draft || !participantCapability) {
      return <main className="league-shell" aria-busy="true"><section className="league-status"><p className="league-kicker">Private draft</p><h1>Restoring your picks</h1><p>Your saved bracket is being read from the server.</p></section><Signature /></main>;
    }
    return (
      <div className="league-bracket-shell">
        <div className="league-social">
          <strong>{safeLiteralText(state.league.league.name, 80)}</strong>
          <span>{state.league.participantCount} {state.league.participantCount === 1 ? 'friend has' : 'friends have'} joined</span>
        </div>
        <BracketPicker
          key={`${draft.acceptedRevisionId}:${draft.version}:${draft.affectedMatchIds.join(',')}`}
          draw={draft.draw}
          initialPicks={draft.picks}
          version={draft.version}
          affectedMatchIds={draft.affectedMatchIds}
          locked={draft.locked}
          lockAt={state.league.league.lockAt}
          initialSubmitted={state.league.viewer.submission.active}
          onSave={(version, picks) => saveLeagueDraft(participantCapability, version, picks, fetcher)}
          onSubmit={(version) => submitLeagueBracket(participantCapability, version, fetcher)}
          onReload={reloadDraft}
          onPendingChange={(pending) => {
            const settled = draftPending.current && !pending;
            draftPending.current = pending;
            if (settled) void refreshRef.current();
          }}
          onVisualChange={onVisualChange}
        />
      </div>
    );
  }

  return <Failure kind="network-failure" />;
}
