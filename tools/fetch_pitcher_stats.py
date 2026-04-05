"""
fetch_pitcher_stats.py
Fetches advanced pitcher statistics for a given pitcher.
Uses pybaseball to pull from Baseball Savant (Statcast) and FanGraphs.

Usage:
    python tools/fetch_pitcher_stats.py "Bailey Ober" 641927 2026
    python tools/fetch_pitcher_stats.py --player-id 641927

Output: JSON to stdout with season stats, last 5 starts, and splits.
"""

import sys
import json
import warnings
from datetime import date, timedelta

warnings.filterwarnings("ignore")

try:
    import pybaseball
    pybaseball.cache.enable()
    import pandas as pd
except ImportError:
    print(json.dumps({"error": "pybaseball not installed. Run: pip3 install pybaseball"}))
    sys.exit(1)


# ---------------------------------------------------------------------------
# Season pitching stats (FanGraphs via pybaseball)
# ---------------------------------------------------------------------------

def get_season_stats(pitcher_name: str, year: int = None) -> dict:
    year = year or date.today().year
    try:
        df = pybaseball.pitching_stats(year, year, qual=0)
        df.columns = [c.strip() for c in df.columns]

        # Match by full name first, then last name only as fallback
        name_lower = pitcher_name.lower()
        last_name = name_lower.split()[-1]

        # Try full name match first
        full_mask = df["Name"].str.lower().str.contains(name_lower, na=False)
        matches = df[full_mask]

        if matches.empty:
            # Fallback: last name only — take exact last-name word match
            last_mask = df["Name"].str.lower().str.split().str[-1] == last_name
            matches = df[last_mask]

        if matches.empty:
            return {"error": f"No season stats found for '{pitcher_name}' in {year}"}

        # Take best match (most innings pitched if multiple)
        if len(matches) > 1:
            matches = matches.sort_values("IP", ascending=False)
        row = matches.iloc[0]

        def safe(col, default=None):
            val = row.get(col, default)
            if pd.isna(val):
                return default
            return round(float(val), 3) if isinstance(val, float) else val

        return {
            "name": str(row.get("Name", pitcher_name)),
            "team": str(row.get("Team", "UNK")),
            "year": year,
            "games": int(safe("G", 0)),
            "games_started": int(safe("GS", 0)),
            "ip": safe("IP"),
            "era": safe("ERA"),
            "fip": safe("FIP"),
            "xfip": safe("xFIP"),
            "whip": safe("WHIP"),
            "k_per_9": safe("K/9"),
            "bb_per_9": safe("BB/9"),
            "hr_per_9": safe("HR/9"),
            "k_pct": safe("K%"),
            "bb_pct": safe("BB%"),
            "babip": safe("BABIP"),
            "lob_pct": safe("LOB%"),
            "gb_pct": safe("GB%"),
            "hr_fb_pct": safe("HR/FB"),
            "war": safe("WAR"),
            "data_source": "fangraphs_via_pybaseball",
        }
    except Exception as e:
        return {"error": f"Season stats fetch failed: {e}"}


# ---------------------------------------------------------------------------
# Recent starts (last N games) via MLB Stats API
# ---------------------------------------------------------------------------

def get_recent_starts(player_id: int, n: int = 5) -> list:
    """Fetches last N starts for a pitcher from MLB Stats API game log."""
    import urllib.request
    import urllib.error

    url = (
        f"https://statsapi.mlb.com/api/v1/people/{player_id}/stats"
        f"?stats=gameLog&group=pitching&season={date.today().year}&gameType=R"
    )
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        return [{"error": f"Recent starts fetch failed: {e}"}]

    splits = data.get("stats", [{}])[0].get("splits", [])
    # Filter starts only (IP > 0 and game was started)
    starts = [s for s in splits if float(s.get("stat", {}).get("inningsPitched", "0")) >= 1.0]
    starts = starts[-n:]  # last N

    result = []
    for s in starts:
        stat = s.get("stat", {})
        game = s.get("game", {})
        team = s.get("opponent", {})
        result.append({
            "date": s.get("date"),
            "opponent": team.get("name", "UNK"),
            "ip": stat.get("inningsPitched"),
            "er": stat.get("earnedRuns"),
            "k": stat.get("strikeOuts"),
            "bb": stat.get("baseOnBalls"),
            "hr": stat.get("homeRuns"),
            "hits": stat.get("hits"),
            "era_this_start": round(
                float(stat.get("earnedRuns", 0)) / max(float(stat.get("inningsPitched", 1) or 1), 0.001) * 9, 2
            ),
        })

    # Summary stats
    if result:
        total_er = sum(float(s.get("er") or 0) for s in result)
        total_ip = sum(float(s.get("ip") or 0) for s in result)
        recent_era = round(total_er / max(total_ip, 0.001) * 9, 2) if total_ip > 0 else None
    else:
        recent_era = None

    return {
        "last_n_starts": n,
        "recent_era": recent_era,
        "starts": result,
    }


# ---------------------------------------------------------------------------
# Handedness splits (vs LHB and vs RHB) via MLB Stats API
# ---------------------------------------------------------------------------

def get_splits(player_id: int, year: int = None) -> dict:
    """Fetches pitcher splits vs left-handed and right-handed batters."""
    import urllib.request
    year = year or date.today().year

    url = (
        f"https://statsapi.mlb.com/api/v1/people/{player_id}/stats"
        f"?stats=statSplits&group=pitching&season={year}&gameType=R"
        f"&sitCodes=vl,vr"
    )
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        return {"error": f"Splits fetch failed: {e}"}

    splits_data = {}
    for stat_group in data.get("stats", []):
        for split in stat_group.get("splits", []):
            sit = split.get("split", {}).get("code", "")
            stat = split.get("stat", {})
            if sit in ("vl", "vr"):
                label = "vs_LHB" if sit == "vl" else "vs_RHB"
                splits_data[label] = {
                    "era": stat.get("era"),
                    "whip": stat.get("whip"),
                    "avg": stat.get("avg"),
                    "ops": stat.get("ops"),
                    "k_per_9": stat.get("strikeoutsPer9Inn"),
                    "bb_per_9": stat.get("walksPer9Inn"),
                    "ip": stat.get("inningsPitched"),
                    "at_bats": stat.get("atBats"),
                }

    return splits_data if splits_data else {"error": "No split data available"}


# ---------------------------------------------------------------------------
# Home/road splits
# ---------------------------------------------------------------------------

def get_home_road_splits(player_id: int, year: int = None) -> dict:
    import urllib.request
    year = year or date.today().year
    url = (
        f"https://statsapi.mlb.com/api/v1/people/{player_id}/stats"
        f"?stats=statSplits&group=pitching&season={year}&gameType=R"
        f"&sitCodes=h,a"
    )
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        return {"error": f"Home/road splits fetch failed: {e}"}

    result = {}
    for stat_group in data.get("stats", []):
        for split in stat_group.get("splits", []):
            sit = split.get("split", {}).get("code", "")
            stat = split.get("stat", {})
            if sit == "h":
                result["home"] = {"era": stat.get("era"), "whip": stat.get("whip"), "ip": stat.get("inningsPitched")}
            elif sit == "a":
                result["road"] = {"era": stat.get("era"), "whip": stat.get("whip"), "ip": stat.get("inningsPitched")}
    return result if result else {"error": "No home/road split data"}


# ---------------------------------------------------------------------------
# Combined pitcher profile
# ---------------------------------------------------------------------------

def get_pitcher_profile(pitcher_name: str, player_id: int = None, year: int = None) -> dict:
    year = year or date.today().year

    # Get handedness from MLB API
    handedness = "R"
    if player_id:
        try:
            import urllib.request
            url = f"https://statsapi.mlb.com/api/v1/people/{player_id}"
            with urllib.request.urlopen(url, timeout=10) as resp:
                pdata = json.loads(resp.read().decode())
            handedness = pdata.get("people", [{}])[0].get("pitchHand", {}).get("code", "R")
        except Exception:
            pass

    season = get_season_stats(pitcher_name, year)
    recent = get_recent_starts(player_id, n=5) if player_id else {"error": "No player ID provided"}
    splits = get_splits(player_id, year) if player_id else {"error": "No player ID provided"}
    home_road = get_home_road_splits(player_id, year) if player_id else {}

    return {
        "pitcher_name": pitcher_name,
        "player_id": player_id,
        "handedness": handedness,
        "season_stats": season,
        "recent_starts": recent,
        "handedness_splits": splits,
        "home_road_splits": home_road,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    args = sys.argv[1:]
    if not args:
        print(json.dumps({"usage": "python tools/fetch_pitcher_stats.py 'Pitcher Name' [player_id] [year]"}))
        return

    name = args[0]
    player_id = int(args[1]) if len(args) > 1 and args[1].isdigit() else None
    year = int(args[2]) if len(args) > 2 and args[2].isdigit() else date.today().year

    profile = get_pitcher_profile(name, player_id, year)
    print(json.dumps(profile, indent=2, default=str))


if __name__ == "__main__":
    main()
