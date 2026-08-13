import { createHash } from 'node:crypto';
import type {
  Draw,
  DrawSourceRevisionInput,
  Match,
  MatchTerminality,
  Player,
  SetScore,
  Side,
} from '../shared/draw/contracts.js';
import { validateParsedDrawRevision } from '../shared/draw/validation.js';

export const DRAW_PARSER_VERSION = 'mediawiki-v1';
export const MAX_WIKITEXT_BYTES = 2 * 1024 * 1024;
const MAX_TEMPLATE_PARAMETERS = 10_000;
const ROUND_NAMES = [
  'First round',
  'Second round',
  'Third round',
  'Fourth round',
  'Quarterfinals',
  'Semifinals',
  'Final',
];
const COUNTRY = /\{\{flagicon\|([A-Za-z]{2,3})\}\}/;
const LINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/;
const SET_SCORE = /^(\d+)(?:<sup>(\d+)<\/sup>)?$/;

interface ParsedPlayer {
  name: string;
  short: string;
  country: string | null;
  won: boolean;
}

interface BracketEntry extends ParsedPlayer {
  seed: string | null;
  sets: SetScore[];
}

type ParseResult =
  | { ok: true; revision: import('../shared/draw/contracts.js').ParsedDrawRevision }
  | { ok: false; diagnostics: string[] };

function splitTemplates(wikitext: string, name: string): { bodies: string[]; diagnostic?: string } {
  const bodies: string[] = [];
  let searchFrom = 0;
  const startToken = `{{${name}`;
  while (searchFrom < wikitext.length) {
    const start = wikitext.indexOf(startToken, searchFrom);
    if (start === -1) break;
    const boundary = wikitext[start + startToken.length];
    if (boundary && boundary !== '|' && !/\s/.test(boundary)) {
      searchFrom = start + startToken.length;
      continue;
    }
    let depth = 0;
    let index = start;
    for (; index < wikitext.length; index += 1) {
      if (wikitext.startsWith('{{', index)) {
        depth += 1;
        index += 1;
      } else if (wikitext.startsWith('}}', index)) {
        depth -= 1;
        index += 1;
        if (depth === 0) {
          bodies.push(wikitext.slice(start, index + 1));
          searchFrom = index + 1;
          break;
        }
      }
    }
    if (depth !== 0) return { bodies, diagnostic: `unbalanced braces in ${name} template` };
  }
  return { bodies };
}

function parseParams(body: string): { params: Map<string, string>; diagnostic?: string } {
  const inner = body.slice(2, -2);
  const chunks: string[] = [];
  let current = '';
  let braces = 0;
  let links = 0;
  for (let index = 0; index < inner.length; index += 1) {
    if (inner.startsWith('{{', index)) {
      braces += 1;
      current += '{{';
      index += 1;
      continue;
    }
    if (inner.startsWith('}}', index)) {
      braces -= 1;
      current += '}}';
      index += 1;
      continue;
    }
    if (inner.startsWith('[[', index)) {
      links += 1;
      current += '[[';
      index += 1;
      continue;
    }
    if (inner.startsWith(']]', index)) {
      links -= 1;
      current += ']]';
      index += 1;
      continue;
    }
    const char = inner[index];
    if (char === '|' && braces === 0 && links === 0) {
      chunks.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  chunks.push(current);
  if (braces !== 0 || links !== 0) return { params: new Map(), diagnostic: 'unbalanced nested template or link' };
  if (chunks.length > MAX_TEMPLATE_PARAMETERS) {
    return { params: new Map(), diagnostic: `template exceeds ${MAX_TEMPLATE_PARAMETERS} parameters` };
  }
  const params = new Map<string, string>();
  for (const chunk of chunks.slice(1)) {
    const separator = chunk.indexOf('=');
    if (separator === -1) continue;
    const key = chunk.slice(0, separator).trim();
    if (params.has(key)) return { params, diagnostic: `duplicate template parameter ${key}` };
    params.set(key, chunk.slice(separator + 1).trim());
  }
  return { params };
}

function parsePlayer(raw: string): ParsedPlayer | null {
  if (!raw.trim()) return null;
  const country = COUNTRY.exec(raw);
  const link = LINK.exec(raw);
  const won = raw.includes("'''");
  if (link) {
    const article = link[1].trim();
    return {
      name: article.replace(/\s*\([^)]*\)\s*$/, '').trim(),
      short: (link[2] ?? link[1]).replace(/'''/g, '').trim(),
      country: country?.[1].toUpperCase() ?? null,
      won,
    };
  }
  const cleaned = raw.replace(COUNTRY, '').replace(/'''/g, '').trim();
  if (!cleaned) return null;
  return { name: cleaned.replace(/\s*\([^)]*\)\s*$/, '').trim(), short: cleaned, country: country?.[1].toUpperCase() ?? null, won };
}

function parseSet(raw: string | undefined): SetScore | null {
  if (!raw?.trim()) return null;
  const value = raw.replace(/'''/g, '').trim();
  const score = SET_SCORE.exec(value);
  if (!score) return null;
  return {
    games: Number(score[1]),
    tiebreak: score[2] === undefined ? null : Number(score[2]),
    won: raw.includes("'''"),
  };
}

function slug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function terminality(entries: Array<BracketEntry | null>, status: string | undefined, bestOf: 3 | 5): {
  winner: string | null;
  terminal: MatchTerminality;
  entries: Array<BracketEntry | null>;
  diagnostic?: string;
} {
  const winners = entries.filter((entry): entry is BracketEntry => entry?.won === true);
  if (winners.length > 1) return { winner: null, terminal: 'incomplete', entries, diagnostic: 'both player slots are marked winner' };
  if (winners.length === 0) {
    const withheld = entries.map((entry) => (entry ? { ...entry, sets: [] } : null));
    return { winner: null, terminal: 'incomplete', entries: withheld };
  }
  if (entries.filter(Boolean).length !== 2) {
    return { winner: null, terminal: 'incomplete', entries, diagnostic: 'winner marked before both player slots are known' };
  }
  const normalizedStatus = status?.trim().toLowerCase();
  let terminal: MatchTerminality;
  if (normalizedStatus === 'walkover' || normalizedStatus === 'w/o') terminal = 'walkover';
  else if (normalizedStatus === 'retired' || normalizedStatus === 'ret.') terminal = 'retirement';
  else if (winners[0].sets.filter((set) => set.won).length >= Math.ceil(bestOf / 2)) terminal = 'completed';
  else terminal = 'incomplete';

  if (terminal === 'incomplete') return { winner: null, terminal, entries };

  if (terminal === 'walkover') {
    return { winner: slug(winners[0].name), terminal, entries: entries.map((entry) => (entry ? { ...entry, sets: [] } : null)) };
  }
  if (terminal === 'retirement') {
    const loser = entries.find((entry) => entry && entry.name !== winners[0].name);
    if (loser && loser.sets.length > 0) {
      loser.sets = loser.sets.map((set, index) => index === loser.sets.length - 1 ? { ...set, retired: true } : set);
    }
  }
  return { winner: slug(winners[0].name), terminal, entries };
}

function readBracket(
  body: string,
  slots: number,
  rounds: number,
  padded: boolean,
  bestOf: 3 | 5,
  roundOffset: number,
  matchOffset: (roundIndex: number) => number,
): { rounds: Match[][]; diagnostics: string[] } {
  const parsed = parseParams(body);
  if (parsed.diagnostic) return { rounds: [], diagnostics: [parsed.diagnostic] };
  const result: Match[][] = [];
  const diagnostics: string[] = [];
  for (let localRound = 1; localRound <= rounds; localRound += 1) {
    const count = slots >> (localRound - 1);
    const entries: Array<BracketEntry | null> = [];
    const inferredStatuses = new Map<number, string>();
    for (let slot = 1; slot <= count; slot += 1) {
      const key = padded ? String(slot).padStart(2, '0') : String(slot);
      const player = parsePlayer(parsed.params.get(`RD${localRound}-team${key}`) ?? '');
      if (!player) {
        entries.push(null);
        continue;
      }
      const sets: SetScore[] = [];
      for (let setIndex = 1; setIndex <= 5; setIndex += 1) {
        const rawScore = parsed.params.get(`RD${localRound}-score${key}-${setIndex}`);
        if (setIndex > bestOf && rawScore?.trim()) {
          diagnostics.push(`RD${localRound} slot ${key} has set ${setIndex} beyond bestOf ${bestOf}`);
          continue;
        }
        const set = parseSet(rawScore);
        if (set) sets.push(set);
        else if (rawScore?.trim()) {
          const note = rawScore.replace(/'''/g, '').trim().toLowerCase();
          if (['r', 'ret', 'ret.', 'def', 'def.'].includes(note)) {
            inferredStatuses.set(Math.floor((slot - 1) / 2), 'retired');
          } else if (['w/o', 'walkover'].includes(note)) {
            inferredStatuses.set(Math.floor((slot - 1) / 2), 'walkover');
          } else {
            diagnostics.push(`RD${localRound} slot ${key} has malformed score ${rawScore}`);
          }
        }
      }
      entries.push({
        ...player,
        seed: parsed.params.get(`RD${localRound}-seed${key}`)?.trim() || null,
        sets,
      });
    }
    const matches: Match[] = [];
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 2) {
      const position = matchOffset(localRound) + entryIndex / 2;
      const status =
        parsed.params.get(`RD${localRound}-status${entryIndex / 2 + 1}`) ??
        inferredStatuses.get(entryIndex / 2);
      const outcome = terminality(entries.slice(entryIndex, entryIndex + 2), status, bestOf);
      const round = roundOffset + localRound;
      const id = `r${round}m${position + 1}`;
      if (outcome.diagnostic) diagnostics.push(`${id}: ${outcome.diagnostic}`);
      const sides: Side[] = outcome.entries
        .filter((entry): entry is BracketEntry => entry !== null)
        .map((entry) => ({
          player: slug(entry.name),
          seed: entry.seed,
          sets: entry.sets,
        }));
      matches.push({ id, round, position, sides, winner: outcome.winner, terminal: outcome.terminal });
    }
    result.push(matches);
  }
  return { rounds: result, diagnostics };
}

export function parseMediaWikiRevision(input: DrawSourceRevisionInput): ParseResult {
  const diagnostics: string[] = [];
  if (!input.revisionId.trim()) diagnostics.push('source revision ID is empty');
  else if (!/^\d+$/.test(input.revisionId)) diagnostics.push('source revision ID must be numeric');
  if (!Number.isFinite(Date.parse(input.fetchedAt))) diagnostics.push('source fetch timestamp is invalid');
  try {
    const sourceUrl = new URL(input.source.url);
    if (sourceUrl.protocol !== 'https:' || sourceUrl.hostname !== 'en.wikipedia.org') {
      diagnostics.push('source URL is not an allowlisted HTTPS MediaWiki page');
    }
  } catch {
    diagnostics.push('source URL is invalid');
  }
  if (Buffer.byteLength(input.wikitext, 'utf8') > MAX_WIKITEXT_BYTES) {
    diagnostics.push(`wikitext exceeds ${MAX_WIKITEXT_BYTES} bytes`);
  }
  const checksum = createHash('sha256').update(input.wikitext).digest('hex');
  if (input.checksum && input.checksum !== checksum) diagnostics.push('source checksum does not match wikitext');
  if (diagnostics.some((diagnostic) => diagnostic.includes('exceeds') || diagnostic.includes('checksum'))) {
    return { ok: false, diagnostics };
  }

  const suffix = `Tennis${input.draw.bestOf}`;
  const otherBestOf = input.draw.bestOf === 3 ? 5 : 3;
  const otherSections = splitTemplates(input.wikitext, `16TeamBracket-Compact-Tennis${otherBestOf}`);
  const otherFinals = splitTemplates(input.wikitext, `8TeamBracket-Tennis${otherBestOf}`);
  if (otherSections.bodies.length > 0 || otherFinals.bodies.length > 0) {
    diagnostics.push(`bracket format Tennis${otherBestOf} does not match input draw bestOf ${input.draw.bestOf}`);
  }
  const sections = splitTemplates(input.wikitext, `16TeamBracket-Compact-${suffix}`);
  const finals = splitTemplates(input.wikitext, `8TeamBracket-${suffix}`);
  if (sections.diagnostic) diagnostics.push(sections.diagnostic);
  if (finals.diagnostic) diagnostics.push(finals.diagnostic);
  if (sections.bodies.length !== 8) diagnostics.push(`expected 8 section templates, found ${sections.bodies.length}`);
  if (finals.bodies.length !== 1) diagnostics.push(`expected 1 finals template, found ${finals.bodies.length}`);
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const rounds: Match[][] = Array.from({ length: 7 }, () => []);
  sections.bodies.forEach((body, sectionIndex) => {
    const bracket = readBracket(
      body,
      16,
      4,
      true,
      input.draw.bestOf,
      0,
      (localRound) => sectionIndex * (8 >> (localRound - 1)),
    );
    diagnostics.push(...bracket.diagnostics);
    bracket.rounds.forEach((matches, roundIndex) => rounds[roundIndex].push(...matches));
  });
  const finalBracket = readBracket(finals.bodies[0], 8, 3, false, input.draw.bestOf, 4, () => 0);
  diagnostics.push(...finalBracket.diagnostics);
  finalBracket.rounds.forEach((matches, roundIndex) => rounds[roundIndex + 4].push(...matches));

  const players: Record<string, Player> = {};
  for (const body of [...sections.bodies, ...finals.bodies]) {
    const parsed = parseParams(body);
    for (const [key, value] of parsed.params) {
      if (!/RD\d+-team\d+/.test(key)) continue;
      const player = parsePlayer(value);
      if (!player) continue;
      const id = slug(player.name);
      const existing = players[id];
      if (existing && existing.name !== player.name) diagnostics.push(`player slug collision for ${id}`);
      const seedKey = key.replace('-team', '-seed');
      const seed = parsed.params.get(seedKey)?.trim() || null;
      players[id] = {
        id,
        name: player.name,
        short: player.short,
        country: player.country,
        seed: existing?.seed ?? seed,
      };
      if (players[id].seed === null && seed) players[id].seed = seed;
    }
  }

  const draw: Draw = {
    ...input.draw,
    source: input.source,
    players,
    rounds: rounds.map((matches, index) => ({ round: index + 1, name: ROUND_NAMES[index], matches })),
  };
  const revision = {
    revisionId: input.revisionId,
    checksum,
    fetchedAt: input.fetchedAt,
    parserVersion: DRAW_PARSER_VERSION,
    explicitCorrections: [...new Set(input.explicitCorrections ?? [])].sort(),
    complete: rounds.every((round) => round.every((match) => match.winner !== null)),
    draw,
  };
  diagnostics.push(...validateParsedDrawRevision(revision));
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  return {
    ok: true,
    revision,
  };
}
