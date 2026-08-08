"""Build a complete Grand Slam draw from Wikipedia's bracket templates.

The draw articles encode every match as template parameters, with the winner's
name and winning set scores wrapped in wiki bold. That is enough to reconstruct
the whole tournament: 128 players, 127 matches, seven rounds, set by set.

Running this reproduces the shipped JSON exactly:

    python tools/build_draw.py --slam wimbledon-2026-men
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

WIKI_API = "https://en.wikipedia.org/w/api.php"

VENUES = {
    "australian-open": {
        "page": "2026 Australian Open",
        "tournament": "Australian Open",
        "surface": "Hard",
        "venue": "Melbourne Park",
        "city": "Melbourne",
        "men": "Men's singles",
        "women": "Women's singles",
    },
    "french-open": {
        "page": "2026 French Open",
        "tournament": "Roland-Garros",
        "surface": "Clay",
        "venue": "Stade Roland Garros",
        "city": "Paris",
        "men": "Men's singles",
        "women": "Women's singles",
    },
    "wimbledon": {
        "page": "2026 Wimbledon Championships",
        "tournament": "Wimbledon",
        "surface": "Grass",
        "venue": "All England Lawn Tennis and Croquet Club",
        "city": "London",
        "men": "Men's singles",
        "women": "Women's singles",
    },
    "us-open": {
        "page": "2026 US Open (tennis)",
        "tournament": "US Open",
        "surface": "Hard",
        "venue": "USTA Billie Jean King National Tennis Center",
        "city": "New York",
        "men": "Men's singles",
        "women": "Women's singles",
    },
}

EVENT_LABEL = {
    ("wimbledon", "men"): "Gentlemen's Singles",
    ("wimbledon", "women"): "Ladies' Singles",
}


def slam_spec(key: str) -> dict:
    venue_key, _, tour = key.rpartition("-")
    if venue_key not in VENUES or tour not in ("men", "women"):
        raise SystemExit(f"unknown slam {key}")
    venue = VENUES[venue_key]
    return {
        "page": f"{venue['page']} – {venue[tour]}",
        "tournament": venue["tournament"],
        "year": 2026,
        "event": EVENT_LABEL.get(
            (venue_key, tour), "Men's Singles" if tour == "men" else "Women's Singles"
        ),
        "surface": venue["surface"],
        "venue": venue["venue"],
        "city": venue["city"],
        "bestOf": 5 if tour == "men" else 3,
        "tour": tour,
    }


SLAMS = [f"{v}-{t}" for v in VENUES for t in ("men", "women")]

ROUND_NAMES = [
    "First round",
    "Second round",
    "Third round",
    "Fourth round",
    "Quarterfinals",
    "Semifinals",
    "Final",
]


def fetch_wikitext(page: str) -> str:
    query = urllib.parse.urlencode(
        {"action": "parse", "page": page, "prop": "wikitext", "format": "json"}
    )
    request = urllib.request.Request(
        f"{WIKI_API}?{query}", headers={"User-Agent": "draw-build/1.0 (static site data)"}
    )
    # Wikipedia rate-limits bursts. Backing off is the difference between a
    # build that reproduces and one that half-reproduces.
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                payload = json.load(response)
            break
        except urllib.error.HTTPError as error:
            if error.code != 429 or attempt == 4:
                raise
            time.sleep(4 * (attempt + 1))
    else:
        raise SystemExit(f"wikipedia: gave up fetching {page}")
    if "error" in payload:
        raise SystemExit(f"wikipedia: {payload['error'].get('info')}")
    return payload["parse"]["wikitext"]["*"]


def split_templates(wikitext: str, name: str) -> list[str]:
    """Return the body of every {{name ...}} call, respecting nested braces."""
    bodies = []
    for match in re.finditer(r"\{\{" + re.escape(name), wikitext):
        depth, index = 0, match.start()
        while index < len(wikitext):
            if wikitext.startswith("{{", index):
                depth += 1
                index += 2
            elif wikitext.startswith("}}", index):
                depth -= 1
                index += 2
                if depth == 0:
                    break
            else:
                index += 1
        bodies.append(wikitext[match.start() : index])
    return bodies


def parse_params(body: str) -> dict[str, str]:
    """Split a template body on top-level pipes only."""
    inner = body.strip()
    if inner.startswith("{{"):
        inner = inner[2:]
    if inner.endswith("}}"):
        inner = inner[:-2]
    params, depth, current = {}, 0, ""
    for index, char in enumerate(inner):
        if inner.startswith("{{", index) or inner.startswith("[[", index):
            depth += 1
        elif inner.startswith("}}", index) or inner.startswith("]]", index):
            depth -= 1
        if char == "|" and depth == 0:
            if "=" in current:
                key, _, value = current.partition("=")
                params[key.strip()] = value.strip()
            current = ""
        else:
            current += char
    if "=" in current:
        key, _, value = current.partition("=")
        params[key.strip()] = value.strip()
    return params


COUNTRY = re.compile(r"\{\{flagicon\|([A-Za-z]{2,3})\}\}")
LINK = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]")


def parse_player(raw: str) -> dict | None:
    if not raw:
        return None
    # Wikipedia bolds the winner, but not always from the first character:
    # the flag template can come first, so the markers wrap only the name.
    won = "'''" in raw
    country = COUNTRY.search(raw)
    link = LINK.search(raw)
    if link:
        article = link.group(1).strip()
        shown = (link.group(2) or link.group(1)).strip()
    else:
        cleaned = COUNTRY.sub("", raw).replace("'''", "").strip()
        if not cleaned:
            return None
        article = shown = cleaned
    # "Nuno Borges (tennis)" is a disambiguation, not part of anyone's name.
    full = re.sub(r"\s*\([^)]*\)\s*$", "", article).strip()
    return {
        "name": full,
        "short": shown.replace("'''", "").strip(),
        "country": (country.group(1).upper() if country else None),
        "won": won,
    }


SET_SCORE = re.compile(r"^(\d+)(?:<sup>(\d+)</sup>)?$")


def parse_set(raw: str) -> dict | None:
    if raw is None:
        return None
    value = raw.strip()
    if not value:
        return None
    won = value.startswith("'''")
    value = value.replace("'''", "").strip()
    if value.lower() in {"r", "ret.", "ret", "w/o", "walkover", "def.", "def"}:
        return {"games": None, "tiebreak": None, "won": False, "note": value}
    match = SET_SCORE.match(value)
    if not match:
        return {"games": None, "tiebreak": None, "won": won, "note": value}
    return {
        "games": int(match.group(1)),
        "tiebreak": int(match.group(2)) if match.group(2) else None,
        "won": won,
    }


def read_bracket(body: str, slots: int, rounds: int, pad: bool) -> list[list[dict]]:
    """Read one bracket template into rounds of matches, top slot first."""
    params = parse_params(body)
    out = []
    for round_index in range(1, rounds + 1):
        count = slots >> (round_index - 1)
        entries = []
        for slot in range(1, count + 1):
            key = f"{slot:02d}" if pad else str(slot)
            player = parse_player(params.get(f"RD{round_index}-team{key}", ""))
            if player is None:
                entries.append(None)
                continue
            seed = params.get(f"RD{round_index}-seed{key}", "").strip() or None
            sets = []
            for set_index in range(1, 6):
                parsed = parse_set(params.get(f"RD{round_index}-score{key}-{set_index}"))
                if parsed:
                    sets.append(parsed)
            entries.append({**player, "seed": seed, "sets": sets})
        matches = [
            {"top": entries[i], "bottom": entries[i + 1]} for i in range(0, len(entries), 2)
        ]
        out.append(matches)
    return out


def slug(name: str) -> str:
    stripped = unicodedata.normalize("NFKD", name)
    stripped = "".join(c for c in stripped if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "-", stripped.lower()).strip("-")


def build(key: str) -> dict:
    meta = slam_spec(key)
    wikitext = fetch_wikitext(meta["page"])

    # Best-of-five and best-of-three draws use different bracket templates.
    suffix = f"Tennis{meta['bestOf']}"
    sections = split_templates(wikitext, f"16TeamBracket-Compact-{suffix}")
    finals = split_templates(wikitext, f"8TeamBracket-{suffix}")
    if len(sections) != 8:
        raise SystemExit(f"expected 8 section brackets, found {len(sections)}")
    if len(finals) != 1:
        raise SystemExit(f"expected 1 finals bracket, found {len(finals)}")

    # Rounds 1-4 come from the eight 16-player sections, read top to bottom so
    # slot order matches the physical draw sheet.
    rounds: list[list[dict]] = [[] for _ in range(7)]
    for body in sections:
        for round_index, matches in enumerate(read_bracket(body, 16, 4, pad=True)):
            rounds[round_index].extend(matches)
    for round_index, matches in enumerate(read_bracket(finals[0], 8, 3, pad=False)):
        rounds[4 + round_index].extend(matches)

    players: dict[str, dict] = {}
    out_rounds = []
    for round_index, matches in enumerate(rounds):
        out_matches = []
        for position, match in enumerate(matches):
            sides = []
            for side in ("top", "bottom"):
                entry = match[side]
                if entry is None:
                    sides.append(None)
                    continue
                player_id = slug(entry["name"])
                known = players.setdefault(
                    player_id,
                    {
                        "id": player_id,
                        "name": entry["name"],
                        "short": entry["short"],
                        "country": entry["country"],
                        "seed": entry["seed"],
                    },
                )
                if known["seed"] is None and entry["seed"]:
                    known["seed"] = entry["seed"]
                sides.append(
                    {"player": player_id, "seed": entry["seed"], "sets": entry["sets"]}
                )
            winner = None
            for side, entry in zip(sides, (match["top"], match["bottom"])):
                if entry and entry["won"] and side:
                    winner = side["player"]
            out_matches.append(
                {
                    "id": f"r{round_index + 1}m{position + 1}",
                    "round": round_index + 1,
                    "position": position,
                    "sides": sides,
                    "winner": winner,
                }
            )
        out_rounds.append({"round": round_index + 1, "name": ROUND_NAMES[round_index], "matches": out_matches})

    return {
        "id": key,
        "tournament": meta["tournament"],
        "year": meta["year"],
        "event": meta["event"],
        "surface": meta["surface"],
        "venue": meta["venue"],
        "city": meta["city"],
        "bestOf": meta["bestOf"],
        "source": {
            "wikipedia": meta["page"],
            "url": "https://en.wikipedia.org/wiki/"
            + urllib.parse.quote(meta["page"].replace(" ", "_")),
        },
        "players": players,
        "rounds": out_rounds,
    }


def verify(draw: dict) -> list[str]:
    """A draw that does not survive these is not publishable."""
    problems = []
    counts = [len(r["matches"]) for r in draw["rounds"]]
    if counts != [64, 32, 16, 8, 4, 2, 1]:
        problems.append(f"round sizes are {counts}, expected [64,32,16,8,4,2,1]")

    for round_data in draw["rounds"]:
        for match in round_data["matches"]:
            filled = [s for s in match["sides"] if s]
            if len(filled) != 2:
                problems.append(f"{match['id']} has {len(filled)} players")
            elif match["winner"] is None:
                problems.append(f"{match['id']} has no winner")
            elif match["winner"] not in [s["player"] for s in filled]:
                problems.append(f"{match['id']} winner is not in the match")

    # Every winner must appear in the next round, in the right half of the draw.
    for index in range(len(draw["rounds"]) - 1):
        here = draw["rounds"][index]["matches"]
        nxt = draw["rounds"][index + 1]["matches"]
        for position, match in enumerate(here):
            if match["winner"] is None:
                continue
            target = nxt[position // 2]
            if match["winner"] not in [s["player"] for s in target["sides"] if s]:
                problems.append(
                    f"{match['id']} winner {match['winner']} missing from {target['id']}"
                )

    entrants = {s["player"] for m in draw["rounds"][0]["matches"] for s in m["sides"] if s}
    if len(entrants) != 128:
        problems.append(f"{len(entrants)} first-round entrants, expected 128")
    return problems


def write(draw: dict, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(draw, ensure_ascii=False, indent=1) + "\n")
    champion = draw["rounds"][-1]["matches"][0]["winner"]
    print(
        f"{draw['id']}: 128 players, 127 matches, "
        f"champion {draw['players'][champion]['name']} -> {destination} "
        f"({destination.stat().st_size // 1024} KB)"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slam", choices=sorted(SLAMS) + ["all"], required=True)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    if args.slam == "all":
        failures = 0
        for index, key in enumerate(sorted(SLAMS)):
            if index:
                time.sleep(2)
            try:
                draw = build(key)
            except SystemExit as error:
                print(f"{key}: unavailable ({error})")
                continue
            problems = verify(draw)
            if problems:
                failures += 1
                print(f"{key}: REJECTED, {len(problems)} problem(s)", file=sys.stderr)
                for problem in problems[:6]:
                    print("    -", problem, file=sys.stderr)
                continue
            write(draw, Path(f"public/draws/{key}.json"))
        return 1 if failures else 0

    draw = build(args.slam)
    problems = verify(draw)
    if problems:
        print(f"REJECTED {args.slam}: {len(problems)} problem(s)", file=sys.stderr)
        for problem in problems[:25]:
            print("  -", problem, file=sys.stderr)
        return 1

    write(draw, Path(args.out or f"public/draws/{args.slam}.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
