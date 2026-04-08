"""
fetch_lineups.py
Fetches confirmed starting lineups and pitchers for a given game.
Uses MLB Stats API boxscore endpoint.

Usage:
    python tools/fetch_lineups.py 823732          (game_id)
    python tools/fetch_lineups.py --game 823732

Output: JSON to stdout with home/away lineup, SP names, confirmation status.
"""

import sys
import json
import urllib.request
import urllib.error


def get_lineup(game_id: int) -> dict:
    """Fetch confirmed lineup from MLB Stats API boxscore endpoint."""
    url = f"https://statsapi.mlb.com/api/v1/game/{game_id}/boxscore"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.URLError as e:
        return {"error": f"Lineup fetch failed: {e}", "lineup_confirmed": False}

    teams = data.get("teams", {})
    result = {"game_id": game_id, "lineup_confirmed": False}

    for side in ("home", "away"):
        team_data = teams.get(side, {})
        team_info = team_data.get("team", {})
        players = team_data.get("players", {})

        # Starting lineup: players with battingOrder set
        batting_order = []
        for pid, pdata in players.items():
            order = pdata.get("battingOrder")
            if order and str(order).endswith("00"):  # e.g. 100, 200, ... 900
                pos = pdata.get("position", {}).get("abbreviation", "")
                name = pdata.get("person", {}).get("fullName", "")
                player_id = pdata.get("person", {}).get("id")
                handedness = pdata.get("person", {}).get("batSide", {}).get("code", "R")
                batting_order.append({
                    "batting_slot": int(str(order)) // 100,
                    "name": name,
                    "player_id": player_id,
                    "position": pos,
                    "bats": handedness,
                })

            # Find starting pitcher (SP)
            if pdata.get("position", {}).get("abbreviation") == "P" and pdata.get("gameStatus", {}).get("isCurrentPitcher") is not None:
                game_status = pdata.get("gameStatus", {})
                if game_status.get("isOnBench") is False and order is None:
                    sp_name = pdata.get("person", {}).get("fullName", "")
                    sp_id = pdata.get("person", {}).get("id")

        batting_order.sort(key=lambda x: x["batting_slot"])

        # Detect SP from pitchers who started the game
        sp = None
        for pid, pdata in players.items():
            stats = pdata.get("stats", {}).get("pitching", {})
            game_status = pdata.get("gameStatus", {})
            pos = pdata.get("position", {}).get("abbreviation", "")
            if pos == "P" and stats.get("gamesStarted", 0) > 0:
                sp = {
                    "name": pdata.get("person", {}).get("fullName", ""),
                    "player_id": pdata.get("person", {}).get("id"),
                    "throws": pdata.get("person", {}).get("pitchHand", {}).get("code", "R"),
                }
                break

        # Lineup handedness summary
        lefties = sum(1 for b in batting_order if b.get("bats") == "L")
        righties = sum(1 for b in batting_order if b.get("bats") == "R")
        switch = sum(1 for b in batting_order if b.get("bats") == "S")
        total = len(batting_order)

        result[side] = {
            "team": team_info.get("name", ""),
            "team_id": team_info.get("id"),
            "lineup": batting_order,
            "lineup_size": total,
            "sp": sp,
            "handedness_breakdown": {
                "lefties": lefties,
                "righties": righties,
                "switch": switch,
                "lhb_pct": round(lefties / max(total, 1) * 100, 1),
                "rhb_pct": round(righties / max(total, 1) * 100, 1),
            },
        }

    # Lineup is confirmed if we got meaningful data
    home_lineup_size = result.get("home", {}).get("lineup_size", 0)
    away_lineup_size = result.get("away", {}).get("lineup_size", 0)
    result["lineup_confirmed"] = home_lineup_size >= 8 and away_lineup_size >= 8

    return result


def get_probable_pitchers(game_id: int) -> dict:
    """Fetch probable pitchers (pre-game, before lineup confirmed).
    Uses gameData.probablePitchers which is where the MLB Stats API live feed
    stores pre-game probable pitcher assignments.
    """
    url = f"https://statsapi.mlb.com/api/v1/game/{game_id}/feed/live?fields=gameData,probablePitchers,home,away,id,fullName"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        return {"error": f"Probable pitchers fetch failed: {e}"}

    probables = data.get("gameData", {}).get("probablePitchers", {})
    result = {}
    for side in ("home", "away"):
        sp = probables.get(side, {})
        result[side] = {
            "sp_name": sp.get("fullName"),
            "sp_id": sp.get("id"),
        }
    return result


def get_lineup_or_probables(game_id: int) -> dict:
    """Returns confirmed lineup if available, falls back to probables."""
    lineup = get_lineup(game_id)

    if not lineup.get("lineup_confirmed"):
        # Try to enrich with probable pitchers if lineup not set yet
        probables = get_probable_pitchers(game_id)
        for side in ("home", "away"):
            if side in lineup and side in probables:
                if not lineup[side].get("sp") and probables[side].get("sp_name"):
                    lineup[side]["sp"] = {
                        "name": probables[side].get("sp_name"),
                        "player_id": probables[side].get("sp_id"),
                        "source": "probable_pitcher",
                    }

    return lineup


def main():
    args = sys.argv[1:]
    if not args:
        print(json.dumps({"usage": "python tools/fetch_lineups.py GAME_ID"}))
        return

    # Strip --game flag if present
    game_id_str = args[-1].lstrip("--game").strip() if "--game" in args[-1] else args[-1]
    if not game_id_str.isdigit():
        # handle "--game 823732" pattern
        game_id_str = args[1] if len(args) > 1 else ""

    if not game_id_str.isdigit():
        print(json.dumps({"error": f"Invalid game ID: {game_id_str}"}))
        return

    game_id = int(game_id_str)
    result = get_lineup_or_probables(game_id)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
