# The Draw

The 2026 Grand Slam singles draws, rendered as radial bundled dendrograms.

128 entrants sit on the rim. Threads bundle inward through seven rounds. The champion
is at dead centre. Stroke weight carries two things at once: how many rounds a player
survived, and how one-sided each win was — the share of total games taken in that match.
The ground is the court surface: grass, terre battue, hard court.

Every result is real. Nothing is modelled, smoothed, or predicted.

## Data

`tools/build_draw.py` reads the published draw sheets from Wikipedia's wikitext,
parses seeds, countries, and set scores, and writes verified JSON into `public/draws/`.
It refuses to emit a draw that does not reconcile: 127 matches, one winner per match,
each round's entrants drawn from the previous round's winners.

```bash
python3 tools/build_draw.py --slam all
```

Six draws are complete for 2026 — Australian Open, Roland-Garros, and Wimbledon, men's
and women's. The US Open is played in late August, so the site shows the structure with
nobody in it yet, alongside a form guide counted from the season's own results.

## Running it

```bash
npm install
npm run dev      # http://localhost:5210
npm run build
```

## How it is built

- Screen-space SVG for the draw itself. 128 names have to be crisp, selectable, and
  readable by a screen reader, which rules out canvas and WebGL text.
- GSAP for the reveal: the field assembles round by round from the rim inward, decays
  to its resting hierarchy, then the champion's thread ignites.
- Fraunces for the display serif, Geist Sans for interface, Geist Mono for figures.

`prefers-reduced-motion` skips straight to the resting state. A pointer press at any
point during the reveal completes it immediately.
