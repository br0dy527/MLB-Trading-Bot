"""
fetch_team_stats.py
Fetches team-level batting, pitching (bullpen), and record stats.

Usage:
    python tools/fetch_team_stats.py MIN 142 2026
    python tools/fetch_team_stats.py --team-id 142

Output: JSON to stdout.
"""

import sys
import json
import urllib.request
import urllib.error
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
# Team name → ID mapping (MLB Stats API team IDs)
# ---------------------------------------------------------------------------

TEAM_NAME_TO_ID = {
    "LAA": 108, "ARI": 109, "BAL": 110, "BOS": 111, "CHC": 112,
    "CIN": 113, "CLE": 114, "COL": 115, "DET": 116, "HOU": 117,
    "KC": 118,  "LAD": 119, "WSH": 120, "NYM": 121, "OAK": 133,
    "PIT": 134, "SD": 135,  "SEA": 136, "SF": 137,  "STL": 138,
    "TB": 139,  "TEX": 140, "TOR": 141, "MIN": 142, "PHI": 143,
    "ATL": 144, "CWS": 145, "MIA": 146, "NYY": 147, "MIL": 158,
}

FANGRAPHS_TEAM_NAMES = {
    "LAA": "Angels", "ARI": "Diamondbacks", "BAL": "Orioles", "BOS": "Red Sox",
    "CHC": "Cubs", "CIN": "Reds", "CLE": "Guardians", "COL": "Rockies",
    "DET": "Tigers", "HOU": "Astros", "KC": "Royals", "LAD": "Dodgers",
    "WSH": "Nationals", "NYM": "Mets", "OAK": "Athletics", "PIT": "Pirates",
    "SD": "Padres", "SEA": "Mariners", "SF": "Giants", "STL": "Cardinals",
    "TB": "Rays", "TEX": "Rangers", "TOR": "Blue Jays", "MIN": "Twins",
    "PHI": "Phillies", "ATL": "Braves", "CWS": "White Sox", "MIA": "Marlins",
    "NYY": "Yankees", "MIL": "Brewers",
}


# ---------------------------------------------------------------------------
# Team W-L record and recent form (MLB Stats API)
# ---------------------------------------------------------------------------

def get_team_record(team_id: int, year: int = None) -> dict:
    year = year or date.today().year
    url = (
        f"https://statsapi.mlb.com/api/v1/standings"
        f"?leagueId=103,104&season={year}&standingsTypes=regularSeason"
        f"&hydrate=team,record,streak,division,sport,league"
    )
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        return {"error": f"Standings fetch failed: {e}"}

    for record in data.get("records", []):
        for team_rec in record.get("teamRecords", []):
            if team_rec.get("team", {}).get("id") == team_id:
                split_records = {}
                for s in team_rec.get("records", {}).get("splitRecords", []):
                    stype = s.get("type", "")
                    split_records[stype] = s.get("wins", 0)
                    split_records[stype + "_losses"] = s.get("losses", 0)
                streak = team_rec.get("streak", {})
                return {
                    "wins": team_rec.get("wins"),
                    "losses": team_rec.get("losses"),
                    "pct": team_rec.get("winningPercentage"),
                    "games_back": team_rec.get("gamesBack"),
                    "streak_type": streak.get("streakType"),
                    "streak_number": streak.get("streakNumber"),
                    "home_wins": split_records.get("home"),
                    "home_losses": split_records.get("home_losses"),
                    "away_wins": split_records.get("away"),
                    "away_losses": split_records.get("away_losses"),
                    "last_10_wins": split_records.get("lastTen"),
                    "last_10_losses": split_records.get("lastTen_losses"),
                    "run_differential": team_rec.get("runDifferential"),
                    "division_rank": team_rec.get("divisionRank"),
                    "league_rank": team_rec.get("leagueRank"),
                    "data_source": "mlb_stats_api",
                }

    return {"error": f"Team ID {team_id} not found in standings"}


# ---------------------------------------------------------------------------
# Team batting stats (FanGraphs via pybaseball)
# ---------------------------------------------------------------------------

def get_team_batting(team_abbr: str, year: int = None) -> dict:
    year = year or date.today().year
    try:
        df = pybaseball.team_batting(year, year)
        df.columns = [c.strip() for c in df.columns]

        fg_name = FANGRAPHS_TEAM_NAMES.get(team_abbr, team_abbr)
        mask = df["Team"].str.contains(fg_name, case=False, na=False)
        matches = df[mask]

        if matches.empty:
            # Try abbreviation
            mask = df["Team"].str.contains(team_abbr, case=False, na=False)
            matches = df[mask]

        if matches.empty:
            return {"error": f"No batting data for '{team_abbr}' in {year}"}

        row = matches.iloc[0]

        def safe(col, default=None):
            val = row.get(col, default)
            try:
                if pd.isna(val):
                    return default
            except Exception:
                pass
            return round(float(val), 3) if isinstance(val, (int, float)) else val

        return {
            "team": team_abbr,
            "year": year,
            "runs": safe("R"),
            "ops": safe("OPS"),
            "obp": safe("OBP"),
            "slg": safe("SLG"),
            "avg": safe("AVG"),
            "wrc_plus": safe("wRC+"),
            "war_bat": safe("WAR"),
            "k_pct": safe("K%"),
            "bb_pct": safe("BB%"),
            "iso": safe("ISO"),
            "babip": safe("BABIP"),
            "woba": safe("wOBA"),
            "data_source": "fangraphs_via_pybaseball",
        }
    except Exception as e:
        return {"error": f"Team batting fetch failed: {e}"}


# ---------------------------------------------------------------------------
# Team pitching stats — full staff (FanGraphs via pybaseball)
# ---------------------------------------------------------------------------

def get_team_pitching(team_abbr: str, year: int = None) -> dict:
    year = year or date.today().year
    try:
        df = pybaseball.team_pitching(year, year)
        df.columns = [c.strip() for c in df.columns]

        fg_name = FANGRAPHS_TEAM_NAMES.get(team_abbr, team_abbr)
        mask = df["Team"].str.contains(fg_name, case=False, na=False)
        matches = df[mask]

        if matches.empty:
            return {"error": f"No pitching data for '{team_abbr}' in {year}"}

        row = matches.iloc[0]

        def safe(col, default=None):
            val = row.get(col, default)
            try:
                if pd.isna(val):
                    return default
            except Exception:
                pass
            return round(float(val), 3) if isinstance(val, (int, float)) else val

        return {
            "team": team_abbr,
            "year": year,
            "era": safe("ERA"),
            "fip": safe("FIP"),
            "whip": safe("WHIP"),
            "k_per_9": safe("K/9"),
            "bb_per_9": safe("BB/9"),
            "hr_per_9": safe("HR/9"),
            "k_pct": safe("K%"),
            "bb_pct": safe("BB%"),
            "gb_pct": safe("GB%"),
            "war_pitch": safe("WAR"),
            "data_source": "fangraphs_via_pybaseball",
        }
    except Exception as e:
        return {"error": f"Team pitching fetch failed: {e}"}


# ---------------------------------------------------------------------------
# Bullpen stats (non-starters, last 7 days) via MLB Stats API
# ---------------------------------------------------------------------------

def get_bullpen_stats(team_id: int, year: int = None) -> dict:
    """Gets team bullpen ERA/saves/blown saves from season stats."""
    year = year or date.today().year

    url = (
        f"https://statsapi.mlb.com/api/v1/teams/{team_id}/stats"
        f"?stats=season&group=pitching&season={year}&gameType=R"
    )
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        return {"error": f"Bullpen stats fetch failed: {e}"}

    for sg in data.get("stats", []):
        stat = sg.get("splits", [{}])[0].get("stat", {})
        return {
            "team_era": stat.get("era"),
            "saves": stat.get("saves"),
            "blown_saves": stat.get("blownSaves"),
            "save_pct": stat.get("saveOpportunities") and (
                stat.get("saves", 0) / max(stat.get("saveOpportunities", 1), 1)
            ),
            "holds": stat.get("holds"),
            "whip": stat.get("whip"),
            "k_per_9": stat.get("strikeoutsPer9Inn"),
            "data_source": "mlb_stats_api",
        }

    return {"error": "No bullpen data found"}


# ---------------------------------------------------------------------------
# Combined team profile
# ---------------------------------------------------------------------------

def get_team_profile(team_abbr: str, team_id: int = None, year: int = None) -> dict:
    year = year or date.today().year
    team_id = team_id or TEAM_NAME_TO_ID.get(team_abbr.upper())

    record = get_team_record(team_id, year) if team_id else {"error": "No team ID"}
    batting = get_team_batting(team_abbr, year)
    pitching = get_team_pitching(team_abbr, year)
    bullpen = get_bullpen_stats(team_id, year) if team_id else {"error": "No team ID"}

    return {
        "team": team_abbr,
        "team_id": team_id,
        "year": year,
        "record": record,
        "batting": batting,
        "pitching": pitching,
        "bullpen": bullpen,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    args = sys.argv[1:]
    if not args:
        print(json.dumps({"usage": "python tools/fetch_team_stats.py ABBR [team_id] [year]"}))
        return

    abbr = args[0].upper()
    team_id = int(args[1]) if len(args) > 1 and args[1].isdigit() else TEAM_NAME_TO_ID.get(abbr)
    year = int(args[2]) if len(args) > 2 and args[2].isdigit() else date.today().year

    profile = get_team_profile(abbr, team_id, year)
    print(json.dumps(profile, indent=2, default=str))


if __name__ == "__main__":
    main()
