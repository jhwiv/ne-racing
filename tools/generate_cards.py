#!/usr/bin/env python3
"""Generate synthetic but realistic entry files for Railbird AI dev.

Schema matches the existing /data/entries-AQU-2026-04-16.json format
(snake_case at rest; the Cloudflare worker normalizes to camelCase).
"""
import json
import random
import os
from pathlib import Path

random.seed(417)  # Stable output

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)


# --------------------------------------------------------------------------
# Horse name components (not real horses — stable synthetic data)
# --------------------------------------------------------------------------
NAME_ADJ = [
    "Royal", "Silver", "Golden", "Midnight", "Southern", "Bourbon", "Stormy",
    "Quiet", "Sudden", "Rowdy", "Lucky", "Quick", "Mighty", "Lonesome",
    "Sharp", "Tiny", "Humble", "Gritty", "Noble", "Wicked",
]
NAME_NOUN = [
    "Dancer", "Thunder", "Blaze", "Spark", "Duke", "Runner", "Whisper", "Ghost",
    "Cruiser", "Outlaw", "Cowboy", "Rebel", "Son", "Echo", "Mission", "Breeze",
    "Tide", "Shadow", "Star", "Charm", "Gamble", "Bandit", "Hunter", "Dream",
]
NAME_SUFFIX = ["", "", "", " Jr.", " Again", " Express", " Edition", " Man", " Lad", " Kid"]


def make_name(used):
    for _ in range(30):
        n = random.choice(NAME_ADJ) + " " + random.choice(NAME_NOUN) + random.choice(NAME_SUFFIX)
        n = n.strip()
        if n not in used:
            used.add(n)
            return n
    # Fallback with a number
    return f"Colt {random.randint(100,999)}"


# --------------------------------------------------------------------------
# Jockey / trainer rosters by track circuit (realistic enough for dev)
# --------------------------------------------------------------------------
NYRA_JOCKEYS = [
    "Manuel Franco", "Dylan Davis", "Kendrick Carmouche", "Jaime Rodriguez",
    "Jose Lezcano", "Dalila A. Rivera", "Ruben Silvera", "Edgard J. Zayas",
    "Christopher Elliott", "Reylu Gutierrez", "Jorge A. Vargas, Jr.",
    "Ricardo Santana, Jr.", "Omar Hernandez Moreno", "Eric Cancel",
]
NYRA_TRAINERS = [
    "Chad C. Brown", "Todd A. Pletcher", "Linda Rice", "Rudy R. Rodriguez",
    "Jorge R. Abreu", "Ilkay Kantarmaci", "Mark A. Hennig", "Danny Gargan",
    "Miguel Clement", "Michael J. Maker", "H. James Bond", "Anthony W. Dutrow",
    "Horacio De Paz", "Rob Atras", "Kenneth G. McPeek",
]
CT_JOCKEYS = [
    "Arnaldo Bocachica", "Oscar Flores", "Christian Hiraldo", "Denis Araujo",
    "Antonio Lopez", "Gerald Almodovar", "Darwin Lopez", "Angel Cruz",
    "Fredy Peltroche", "J. D. Acosta", "Marshall Mendez", "Luis Batista",
]
CT_TRAINERS = [
    "Jeff C. Runco", "Tim D. Grams", "John D. Locke", "Ronney W. Brown",
    "Javier Contreras", "Ollie L. Figgins III", "Tim E. Shepherd",
    "Anthony Lewis Farrior", "James W. Casey", "Bobby Creager",
    "Kirsten Kotowski", "Jerald L. Robb", "Timothy C. Kreiser",
]


def pct():
    return random.randint(7, 24)


def speed_figs(base, spread=8):
    """Return 3 recent speed figs, occasionally with a null."""
    figs = []
    for i in range(3):
        if i > 0 and random.random() < 0.2:
            figs.append(None)
        else:
            figs.append(max(30, base + random.randint(-spread, spread)))
    return figs


def running_style():
    return random.choice(["E", "E/P", "P", "P", "S", "S"])


def ml_odds(rank):
    """Assign morning-line odds roughly by implied rank in the field."""
    table = ["8/5", "9/5", "5/2", "3/1", "7/2", "4/1", "5/1", "6/1",
             "8/1", "10/1", "12/1", "15/1", "20/1", "20/1", "30/1"]
    return table[min(rank, len(table) - 1)]


# --------------------------------------------------------------------------
# Expert picks generator — creates 5 sources with partially-overlapping picks
# --------------------------------------------------------------------------
def gen_expert_picks(num_horses, nyra=True):
    sources = (
        ["NYRA - Serling", "NYRA - Aragona", "DRF Consensus", "NY Racing Journal", "TimeformUS"]
        if nyra else
        ["DRF Consensus", "TDN Picks", "Equibase Selector", "Brisnet", "TimeformUS"]
    )
    # Pick a "true favorite" for 60% agreement
    fav = random.randint(1, min(num_horses, 6))
    picks = []
    for src in sources:
        if random.random() < 0.55:
            top = fav
        else:
            top = random.randint(1, num_horses)
        rest = random.sample([i for i in range(1, num_horses + 1) if i != top],
                             min(3, num_horses - 1))
        picks.append({
            "source": src,
            "pick": top,
            "picks": [top] + rest,
            "horseName": None,  # Filled in by caller
        })
    return picks


# --------------------------------------------------------------------------
# Race card templates
# --------------------------------------------------------------------------
def aqu_race_types():
    """NYRA-style card: maidens, claimers, allowances, stakes spice."""
    return [
        ("MCL", "Maiden Claiming", 40000),
        ("CLM", "Claiming", 28000),
        ("MCL", "Maiden Claiming", 34000),
        ("MSW", "Maiden Special Weight", 80000),
        ("ALW", "Allowance", 77000),
        ("AOC", "Allowance Optional Claiming", 77000),
        ("STK-L", "Plenty of Grace Stakes (Listed)", 150000),
        ("MSW", "Maiden Special Weight", 75000),
    ]


def ct_race_types():
    """Charles Town evening card: shorter distances, lower purses, claimers-heavy."""
    return [
        ("MCL", "Maiden Claiming", 17000),
        ("CLM", "Claiming", 15000),
        ("MCL", "Maiden Claiming", 18000),
        ("CLM", "Claiming", 16000),
        ("ALW", "Allowance", 32000),
        ("CLM", "Starter Allowance", 24000),
        ("AOC", "Allowance Optional Claiming", 34000),
        ("STK-L", "West Virginia Division Stakes (Listed)", 75000),
        ("CLM", "Claiming", 15000),
    ]


def post_times_aqu(start_hour=13, start_min=10, interval=31):
    """Returns list of 'H:MM PM' strings."""
    out = []
    h, m = start_hour, start_min
    for _ in range(9):
        ampm = "PM" if h >= 12 else "AM"
        disp_h = h if h <= 12 else h - 12
        out.append(f"{disp_h}:{m:02d} {ampm}")
        m += interval
        while m >= 60:
            h += 1; m -= 60
    return out


def post_times_ct(start_hour=19, start_min=0, interval=26):
    return post_times_aqu(start_hour, start_min, interval)


def distance_for(race_idx, track):
    if track == "AQU":
        opts = ["6F", "1M", "6F", "6F", "1 1/16M", "7F", "1M (Turf)", "1 1/8M", "1M (Turf)"]
    else:  # CT
        opts = ["4 1/2F", "7F", "6 1/2F", "4 1/2F", "7F", "6 1/2F", "7F", "7F", "4 1/2F"]
    return opts[race_idx % len(opts)]


def surface_for(race_idx, track):
    if track == "AQU":
        turf_idxs = {6, 8}  # turf stakes + final MSW
        return "Turf" if race_idx in turf_idxs else "Dirt"
    return "Dirt"


# --------------------------------------------------------------------------
# Generator
# --------------------------------------------------------------------------
def build_card(track_code, track_name, date_str, race_types, post_times,
               jockeys, trainers, field_range=(6, 9)):
    used_names = set()
    races = []
    for idx, (rtype_code, rtype_name, purse) in enumerate(race_types):
        race_num = idx + 1
        num_horses = random.randint(*field_range)
        if "STK" in rtype_code:
            num_horses = max(num_horses, 8)

        # Assign a base speed-fig range by class
        base_fig = {"MCL": 52, "CLM": 60, "MSW": 68, "ALW": 78, "AOC": 80,
                    "STK-L": 88, "STK-G3": 92, "STK-G2": 96, "STK-G1": 100}.get(rtype_code, 65)

        entries = []
        rank_order = list(range(1, num_horses + 1))
        random.shuffle(rank_order)  # Shuffle so ML doesn't track post position
        for pp in range(1, num_horses + 1):
            rank = rank_order[pp - 1]
            entries.append({
                "pp": pp,
                "name": make_name(used_names),
                "jockey": random.choice(jockeys),
                "trainer": random.choice(trainers),
                "weight": str(random.choice([118, 119, 120, 122, 123, 124, 126])),
                "scratched": False,
                "ml": ml_odds(rank - 1),
                "equibaseUrl": None,
                "speedFigs": speed_figs(base_fig - (rank * 2), spread=6),
                "runningStyle": running_style(),
                "lastClass": rtype_code if "MCL" not in rtype_code else "MCL",
                "jockeyPct": pct(),
                "trainerPct": pct(),
                "lastRaceDate": f"2026-0{random.choice([2,3])}-{random.randint(10,28):02d}",
                "dataCompleteness": round(random.uniform(0.82, 0.98), 2),
            })

        # Build expert picks referencing real pp numbers
        picks = gen_expert_picks(num_horses, nyra=(track_code == "AQU"))
        name_by_pp = {e["pp"]: e["name"] for e in entries}
        for p in picks:
            p["horseName"] = name_by_pp.get(p["pick"])

        race = {
            "race_number": race_num,
            "post_time": post_times[idx],
            "purse": f"${purse:,}",
            "race_type": rtype_name,
            "race_type_code": rtype_code,
            "conditions": None,
            "distance": distance_for(idx, track_code),
            "surface": surface_for(idx, track_code),
            "entries": entries,
            "expertPicks": picks,
        }
        races.append(race)

    return {
        "track": track_code,
        "venue": track_name,
        "date": date_str,
        "lastUpdated": "2026-04-17T11:30:00.000Z",
        "source": "seed-dev-data",
        "races": races,
    }


def write_expert_picks_file(card, track_code, date_str):
    """Separate expert-picks JSON mirror (some consumers read this)."""
    payload = {
        "track": track_code,
        "date": date_str,
        "races": [
            {
                "race_number": r["race_number"],
                "picks": r["expertPicks"],
            }
            for r in card["races"]
        ],
    }
    p = DATA_DIR / f"expert-picks-{track_code}-{date_str}.json"
    p.write_text(json.dumps(payload, indent=2))
    return p


def write_speed_figs_file(card, track_code):
    """Per-track speed-figure database (used by advice engine)."""
    db = {}
    for r in card["races"]:
        for e in r["entries"]:
            db[e["name"]] = {
                "figs": [f for f in e["speedFigs"] if f is not None],
                "avg": round(sum(f for f in e["speedFigs"] if f is not None) /
                              max(1, len([f for f in e["speedFigs"] if f is not None])), 1),
                "last_updated": "2026-04-17",
            }
    # Append rather than overwrite if file exists
    path = DATA_DIR / f"speed-figures-{track_code}.json"
    if path.exists():
        try:
            existing = json.loads(path.read_text())
            existing.update(db)
            db = existing
        except Exception:
            pass
    path.write_text(json.dumps(db, indent=2))
    return path


def main():
    date_str = "2026-04-17"

    # Aqueduct - 8 race daytime card
    aqu_card = build_card(
        "AQU", "Aqueduct", date_str,
        aqu_race_types(), post_times_aqu(),
        NYRA_JOCKEYS, NYRA_TRAINERS,
        field_range=(6, 10),
    )
    aqu_path = DATA_DIR / f"entries-AQU-{date_str}.json"
    aqu_path.write_text(json.dumps(aqu_card, indent=2))
    write_expert_picks_file(aqu_card, "AQU", date_str)
    write_speed_figs_file(aqu_card, "AQU")
    print(f"AQU card: {len(aqu_card['races'])} races -> {aqu_path}")

    # Charles Town - 9 race evening card
    ct_card = build_card(
        "CT", "Charles Town", date_str,
        ct_race_types(), post_times_ct(),
        CT_JOCKEYS, CT_TRAINERS,
        field_range=(6, 8),
    )
    ct_path = DATA_DIR / f"entries-CT-{date_str}.json"
    ct_path.write_text(json.dumps(ct_card, indent=2))
    write_expert_picks_file(ct_card, "CT", date_str)
    write_speed_figs_file(ct_card, "CT")
    print(f"CT card: {len(ct_card['races'])} races -> {ct_path}")


if __name__ == "__main__":
    main()
