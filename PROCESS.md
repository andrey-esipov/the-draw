# How 762 matches were reconciled

The Draw shows six completed 2026 Grand Slam singles draws: the Australian Open,
Roland-Garros and Wimbledon, men's and women's. That is 127 matches each, 762 in
total. Every score in the piece is a real score. This is how they got there, and
what was thrown away along the way.

## The source

Wikipedia's draw articles are the only place all six draws exist in one
consistent, openly licensed format. Each one is a set of wikitext bracket
templates: `{{16TeamBracket-Compact-Tennis5}}` and its relatives, one per
quarter, with seeds, country codes, entry status and set scores as positional
parameters.

`tools/build_draw.py` parses that wikitext directly. It does not scrape rendered
HTML, because rendered HTML loses the bracket's structure — you get a table of
cells and have to guess which cell feeds which. The templates carry the tree.

## The parse

Each bracket template yields, per match, two sides and a set of set scores. The
parser resolves:

- **Names.** Wikipedia writes players as `{{flagicon|ITA}} [[Jannik Sinner]]`,
  sometimes piped, sometimes with a disambiguator, sometimes with a `sortname`
  wrapper. All four forms are folded to one canonical string per player.
- **Seeds and entry status.** A leading integer is a seed. `Q`, `WC`, `LL`, `PR`
  and `ALT` are entry routes, not seeds, and are kept separately.
- **Set scores.** `7<sup>10</sup>` is a tiebreak, `r.` is a retirement, `w/o` is
  a walkover. Retirements and walkovers still have a winner and still count as a
  match, but they carry no meaningful games total, so they are excluded from the
  dominance weighting rather than silently scored as blowouts.
- **Byes and empty slots.** A first round with fewer than 128 named entrants is
  a parse failure, not a draw with byes. Grand Slam singles draws never have
  byes.

## The gate

A draw that does not survive `verify()` is not written to disk. There is no
partial output and no "close enough" mode. The checks:

1. Round sizes are exactly `[64, 32, 16, 8, 4, 2, 1]`.
2. Every match has exactly two named players.
3. Every match has a winner.
4. Every winner is one of the two players in that match.
5. **Every winner appears in the next round, in the correct half of the draw.**
   This is the check that catches everything else. A misparsed name, a swapped
   quarter, a template read in the wrong order — all of them surface here as a
   player who won a match and then vanished.
6. The first round contains exactly 128 distinct entrants.

Check 5 is why the piece can claim the tree is real rather than plausible. The
bracket is only internally consistent if the parse was right, and a 127-match
tree has no slack in it: one wrong name and the chain breaks somewhere downstream.

## What the visual encoding is actually measuring

Two independent quantities ride on every thread.

**Radius** is rounds survived. Seven rings, from the rim (128 entrants) to the
centre (the champion). The falloff is `((7 - r) / 7) ^ 1.35` rather than linear,
because linear spacing left the closing rounds spread across a hollow middle and
the object read as a doughnut instead of converging on a point.

**Stroke weight** is how decisive each win was. For a given match, a player's
weight is their doubled share of total games won: 1.0 for a match split evenly,
around 1.5 for a straight-sets rout, around 0.5 for the player being routed. It
is a games ratio, not a sets ratio, so a 7-6, 7-6, 7-6 win and a 6-0, 6-0, 6-0
win do not look the same. They should not.

Threads for players who lost a given match are drawn at 72% weight and half
opacity, so the object thins as the field thins, without erasing anyone.

A small open circle marks a seed inside the top 16 losing to someone seeded more
than eight places below them, or unseeded. Those are the early exits worth
finding by eye.

## Things that were built and then removed

- **A rendered-HTML scraper.** Abandoned once it became clear the bracket
  structure was only recoverable from the templates.
- **Orthogonal arcs between rounds**, in the style of a circular dendrogram from
  a phylogenetics package. Correct, and generic. Every thread now leaves its
  child and arrives at its parent on a radial heading, so the whole field reads
  as flowing inward rather than spiralling.
- **Tangential rim labels.** Researched, recommended, rejected: 128 tangential
  labels at this radius collide catastrophically. The labels rotate to their
  leaf angle and flip 180° with `text-anchor: end` on the left half, which is
  the convention iTOL and OneZoom settled on for the same reason.
- **An SVG rectangle for the court-surface ground.** It produced a hard vertical
  seam where the diagram met the text column. The ground is a CSS radial
  gradient on the container instead.
- **A resting scorecard.** The default view used to carry the champion's full
  seven-round score table. At thumbnail scale it read as a grey comb competing
  with the diagram. The table is now what you earn by tracing someone.
- **Champion gold on any traced player.** Following a player who lost painted
  their route in the same gold that crowns the winner, so the diagram
  contradicted the text. Losing routes are ivory, over a dimmed gold champion
  route, and the exit point says which round ended the run and who ended it.

## The one draw that is empty

The 2026 US Open draw is made on 20 August. Until then those 128 positions do
not exist, so the piece does not invent them. That state shows the structure
waiting, and lets you put one name at the centre — a prediction, marked as a
prediction, never dressed up as a result.

## Reproducing it

```bash
python tools/build_draw.py            # rebuilds every draw JSON from source
npm ci && npm run build
```

The JSON in `public/draws/` is generated output. Every file carries the
Wikipedia revision it was built from.
