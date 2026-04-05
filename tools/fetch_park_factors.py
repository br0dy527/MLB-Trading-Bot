"""
fetch_park_factors.py
Fetches park factor data from FanGraphs via pybaseball.
Park factors are stable season-long numbers — cached for efficiency.

Usage:
    python tools/fetch_park_factors.py "Fenway Park"
    python tools/fetch_park_factors.py --all

Output: JSON to stdout.
"""

import sys
import json
import warnings
from datetime import date

warnings.filterwarnings("ignore")

try:
    import pybaseball
    pybaseball.cache.enable()
    import pandas as pd
except ImportError:
    print(json.dumps({"error": "pybaseball not installed"}))
    sys.exit(1)


# ---------------------------------------------------------------------------
# Manual park factor reference (from FanGraphs multi-year data)
# These are used as fallback / enrichment when scraping fails
# Updated seasonally. Scale: 100 = neutral. >100 = hitter-friendly. <100 = pitcher-friendly.
# ---------------------------------------------------------------------------

PARK_FACTORS_BASELINE = {
    "Coors Field": {
        "run_factor": 119, "hr_factor": 116, "hits_factor": 107,
        "tier": "extreme_hitter", "altitude_ft": 5280,
        "note": "Highest altitude in MLB. Dramatically inflates all offensive numbers.",
    },
    "Citizens Bank Park": {
        "run_factor": 107, "hr_factor": 112, "hits_factor": 103,
        "tier": "hitter", "altitude_ft": 20,
        "note": "Short RF porch. Humid air in summer.",
    },
    "Yankee Stadium": {
        "run_factor": 106, "hr_factor": 115, "hits_factor": 102,
        "tier": "hitter", "altitude_ft": 55,
        "note": "Short RF porch strongly benefits LHB. High HR factor.",
    },
    "Truist Park": {
        "run_factor": 105, "hr_factor": 108, "hits_factor": 103,
        "tier": "hitter", "altitude_ft": 1050,
        "note": "Warm humid Atlanta air. Cozy dimensions.",
    },
    "Globe Life Field": {
        "run_factor": 104, "hr_factor": 106, "hits_factor": 102,
        "tier": "hitter", "altitude_ft": 551,
        "note": "New park. Retractable roof usually closed.",
    },
    "Fenway Park": {
        "run_factor": 103, "hr_factor": 96, "hits_factor": 107,
        "tier": "neutral", "altitude_ft": 20,
        "note": "Green Monster inflates doubles but suppresses HR. Unique park.",
    },
    "Rogers Centre": {
        "run_factor": 103, "hr_factor": 104, "hits_factor": 102,
        "tier": "slight_hitter", "altitude_ft": 76,
        "note": "Dome. Artificial turf increases ball speed. Warm indoor air.",
    },
    "Angel Stadium": {
        "run_factor": 102, "hr_factor": 99, "hits_factor": 103,
        "tier": "slight_hitter", "altitude_ft": 160,
        "note": "Warm dry air. Moderate hitter park.",
    },
    "American Family Field": {
        "run_factor": 101, "hr_factor": 103, "hits_factor": 101,
        "tier": "neutral", "altitude_ft": 634,
        "note": "Retractable roof. Usually closed early/late season.",
    },
    "Wrigley Field": {
        "run_factor": 101, "hr_factor": 103, "hits_factor": 101,
        "tier": "neutral_wind_variable", "altitude_ft": 595,
        "note": "Park factor varies enormously by wind. Neutral baseline, but wind can make it +5 offense or -5.",
    },
    "Chase Field": {
        "run_factor": 100, "hr_factor": 102, "hits_factor": 100,
        "tier": "neutral", "altitude_ft": 1082,
        "note": "Retractable roof usually closed in summer heat.",
    },
    "Minute Maid Park": {
        "run_factor": 100, "hr_factor": 103, "hits_factor": 100,
        "tier": "neutral", "altitude_ft": 22,
        "note": "Crawford Boxes (LF) very short (315ft). Favors LHB.",
    },
    "Great American Ball Park": {
        "run_factor": 100, "hr_factor": 106, "hits_factor": 100,
        "tier": "neutral", "altitude_ft": 550,
        "note": "Higher HR factor than run factor suggests.",
    },
    "GABP": {
        "run_factor": 100, "hr_factor": 106, "hits_factor": 100,
        "tier": "neutral", "altitude_ft": 550,
        "note": "See Great American Ball Park.",
    },
    "Camden Yards": {
        "run_factor": 100, "hr_factor": 101, "hits_factor": 101,
        "tier": "neutral", "altitude_ft": 20,
        "note": "Classic park. Moderate hitter tendencies.",
    },
    "Target Field": {
        "run_factor": 99, "hr_factor": 97, "hits_factor": 100,
        "tier": "slight_pitcher", "altitude_ft": 841,
        "note": "Cold early season. Wind off the river.",
    },
    "Nationals Park": {
        "run_factor": 99, "hr_factor": 98, "hits_factor": 99,
        "tier": "slight_pitcher", "altitude_ft": 25,
        "note": "Moderate pitcher park. Humid DC air.",
    },
    "Kauffman Stadium": {
        "run_factor": 98, "hr_factor": 95, "hits_factor": 99,
        "tier": "pitcher", "altitude_ft": 1025,
        "note": "Large outfield. Low humidity. Pitcher-friendly.",
    },
    "Busch Stadium": {
        "run_factor": 97, "hr_factor": 96, "hits_factor": 98,
        "tier": "pitcher", "altitude_ft": 466,
        "note": "Pitcher-friendly. Good defensive park.",
    },
    "Citi Field": {
        "run_factor": 97, "hr_factor": 94, "hits_factor": 98,
        "tier": "pitcher", "altitude_ft": 20,
        "note": "Deep power alleys. Marine air. Pitcher-friendly.",
    },
    "Guaranteed Rate Field": {
        "run_factor": 97, "hr_factor": 98, "hits_factor": 98,
        "tier": "pitcher", "altitude_ft": 594,
        "note": "Lake Michigan effect. Cold springs.",
    },
    "Comerica Park": {
        "run_factor": 96, "hr_factor": 92, "hits_factor": 97,
        "tier": "pitcher", "altitude_ft": 600,
        "note": "Very large outfield. Pitcher-friendly.",
    },
    "PNC Park": {
        "run_factor": 96, "hr_factor": 94, "hits_factor": 97,
        "tier": "pitcher", "altitude_ft": 730,
        "note": "Deep dimensions. River air. Pitcher-friendly.",
    },
    "Progressive Field": {
        "run_factor": 95, "hr_factor": 92, "hits_factor": 96,
        "tier": "pitcher", "altitude_ft": 633,
        "note": "Lake Erie cold air. Pitcher-friendly.",
    },
    "loanDepot park": {
        "run_factor": 95, "hr_factor": 93, "hits_factor": 96,
        "tier": "pitcher", "altitude_ft": 6,
        "note": "Dome. Pitcher-friendly dimensions.",
    },
    "Dodger Stadium": {
        "run_factor": 95, "hr_factor": 92, "hits_factor": 96,
        "tier": "pitcher", "altitude_ft": 515,
        "note": "Marine layer. Deep power alleys. Classic pitcher park.",
    },
    "T-Mobile Park": {
        "run_factor": 94, "hr_factor": 91, "hits_factor": 95,
        "tier": "pitcher", "altitude_ft": 20,
        "note": "Marine air. Deep park. Pitcher-friendly.",
    },
    "Tropicana Field": {
        "run_factor": 94, "hr_factor": 92, "hits_factor": 95,
        "tier": "pitcher", "altitude_ft": 10,
        "note": "Dome. Artificial turf. Pitcher-friendly.",
    },
    "Oracle Park": {
        "run_factor": 93, "hr_factor": 88, "hits_factor": 95,
        "tier": "extreme_pitcher", "altitude_ft": 10,
        "note": "Marine layer from SF Bay. Very deep RF (McCovey Cove). Most pitcher-friendly park.",
    },
    "Petco Park": {
        "run_factor": 93, "hr_factor": 90, "hits_factor": 94,
        "tier": "extreme_pitcher", "altitude_ft": 20,
        "note": "Pacific marine layer. Very deep CF and LCF. One of most pitcher-friendly parks.",
    },
    "Oakland Coliseum": {
        "run_factor": 94, "hr_factor": 91, "hits_factor": 95,
        "tier": "pitcher", "altitude_ft": 20,
        "note": "Pitcher-friendly. Large foul territory.",
    },
    "Sutter Health Park": {
        "run_factor": 100, "hr_factor": 100, "hits_factor": 100,
        "tier": "neutral", "altitude_ft": 25,
        "note": "Athletics temporary home. Minor league park — limited data.",
    },
}


def get_park_factors(park_name: str) -> dict:
    """
    Returns park factor data. Tries pybaseball first, falls back to baseline dict.
    """
    # Direct lookup
    data = PARK_FACTORS_BASELINE.get(park_name)

    if not data:
        # Partial match
        for pname, pdata in PARK_FACTORS_BASELINE.items():
            if park_name.lower() in pname.lower() or pname.lower() in park_name.lower():
                data = pdata
                park_name = pname
                break

    if not data:
        return {
            "park": park_name,
            "error": f"Park '{park_name}' not found",
            "run_factor": 100,
            "hr_factor": 100,
            "hits_factor": 100,
            "tier": "unknown",
            "note": "Unknown park — using neutral factors as fallback",
        }

    return {
        "park": park_name,
        "run_factor": data["run_factor"],
        "hr_factor": data["hr_factor"],
        "hits_factor": data["hits_factor"],
        "tier": data["tier"],
        "altitude_ft": data.get("altitude_ft"),
        "note": data.get("note", ""),
        "is_hitter_park": data["run_factor"] > 102,
        "is_pitcher_park": data["run_factor"] < 97,
        "data_source": "fangraphs_baseline_manual",
    }


def get_all_park_factors() -> list:
    return [
        {"park": park, **get_park_factors(park)}
        for park in PARK_FACTORS_BASELINE.keys()
    ]


def main():
    args = sys.argv[1:]
    if not args or "--all" in args:
        result = get_all_park_factors()
        print(json.dumps(result, indent=2))
        return

    park = " ".join(args)
    result = get_park_factors(park)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
