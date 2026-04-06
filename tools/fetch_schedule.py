"""
fetch_schedule.py
Fetches today's (or a given date's) MLB schedule from the MLB Stats API.
Output: JSON array to stdout. Used by compile_game_data.py.

Usage:
    python tools/fetch_schedule.py
    python tools/fetch_schedule.py 2026-04-03
"""

import sys
import json
import urllib.request
import urllib.error
from datetime import date


TEAM_ABBR = {
    108: "LAA", 109: "ARI", 110: "BAL", 111: "BOS", 112: "CHC",
    113: "CIN", 114: "CLE", 115: "COL", 116: "DET", 117: "HOU",
    118: "KC",  119: "LAD", 120: "WSH", 121: "NYM", 133: "OAK",
    134: "PIT", 135: "SD",  136: "SEA", 137: "SF",  138: "STL",
    139: "TB",  140: "TEX", 141: "TOR", 142: "MIN", 143: "PHI",
    144: "ATL", 145: "CWS", 146: "MIA", 147: "NYY", 158: "MIL",
}

VENUE_TO_PARK = {
    "Angel Stadium": "Angel Stadium",
    "Chase Field": "Chase Field",
    "Oriole Park at Camden Yards": "Camden Yards",
    "Fenway Park": "Fenway Park",
    "Wrigley Field": "Wrigley Field",
    "Great American Ball Park": "GABP",
    "Progressive Field": "Progressive Field",
    "Coors Field": "Coors Field",
    "Comerica Park": "Comerica Park",
    "Minute Maid Park": "Minute Maid Park",
    "Kauffman Stadium": "Kauffman Stadium",
    "Dodger Stadium": "Dodger Stadium",
    "Nationals Park": "Nationals Park",
    "Citi Field": "Citi Field",
    "Oakland Coliseum": "Oakland Coliseum",
    "PNC Park": "PNC Park",
    "Petco Park": "Petco Park",
    "T-Mobile Park": "T-Mobile Park",
    "Oracle Park": "Oracle Park",
    "Busch Stadium": "Busch Stadium",
    "Tropicana Field": "Tropicana Field",
    "Globe Life Field": "Globe Life Field",
    "Rogers Centre": "Rogers Centre",
    "Target Field": "Target Field",
    "Citizens Bank Park": "Citizens Bank Park",
    "Truist Park": "Truist Park",
    "Guaranteed Rate Field": "Guaranteed Rate Field",
    "loanDepot park": "loanDepot park",
    "Yankee Stadium": "Yankee Stadium",
    "American Family Field": "American Family Field",
    "Sutter Health Park": "Sutter Health Park",
}


def fetch_schedule(date_str: str, include_final: bool = False) -> list:
    url = (
        f"https://statsapi.mlb.com/api/v1/schedule"
        f"?sportId=1&date={date_str}"
        f"&hydrate=team,venue,linescore,probablePitcher"
    )
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.URLError as e:
        return [{"error": f"MLB Stats API unreachable: {e}"}]

    games = []
    for day in data.get("dates", []):
        for g in day.get("games", []):
            # Skip non-regular-season or spring training
            game_type = g.get("gameType", "R")
            if game_type not in ("R", "F", "D", "L", "W"):
                continue

            status = g.get("status", {}).get("abstractGameState", "")
            if status == "Final" and not include_final:
                continue  # Already played — skip for daily picks (use include_final=True for historical)

            home = g.get("teams", {}).get("home", {})
            away = g.get("teams", {}).get("away", {})

            home_team_id = home.get("team", {}).get("id")
            away_team_id = away.get("team", {}).get("id")

            home_abbr = TEAM_ABBR.get(home_team_id, home.get("team", {}).get("abbreviation", "UNK"))
            away_abbr = TEAM_ABBR.get(away_team_id, away.get("team", {}).get("abbreviation", "UNK"))
            home_name = home.get("team", {}).get("name", "Unknown")
            away_name = away.get("team", {}).get("name", "Unknown")

            venue_raw = g.get("venue", {}).get("name", "")
            park_name = VENUE_TO_PARK.get(venue_raw, venue_raw)

            # Probable pitchers
            home_sp = home.get("probablePitcher", {})
            away_sp = away.get("probablePitcher", {})

            # Series info
            series_num = g.get("seriesGameNumber", 1)
            games_in_series = g.get("gamesInSeries", 3)

            # Game time (UTC → display raw, compile step converts to ET)
            game_time_utc = g.get("gameDate", "")

            games.append({
                "game_id": g.get("gamePk"),
                "game_date": date_str,
                "game_time_utc": game_time_utc,
                "status": status,
                "home_team": home_name,
                "home_abbr": home_abbr,
                "home_team_id": home_team_id,
                "away_team": away_name,
                "away_abbr": away_abbr,
                "away_team_id": away_team_id,
                "venue": park_name,
                "venue_raw": venue_raw,
                "series_game_num": series_num,
                "games_in_series": games_in_series,
                "home_sp_id": home_sp.get("id"),
                "home_sp_name": home_sp.get("fullName"),
                "away_sp_id": away_sp.get("id"),
                "away_sp_name": away_sp.get("fullName"),
            })

    return games


def main():
    date_str = sys.argv[1] if len(sys.argv) > 1 else str(date.today())
    games = fetch_schedule(date_str)
    print(json.dumps(games, indent=2))


if __name__ == "__main__":
    main()
