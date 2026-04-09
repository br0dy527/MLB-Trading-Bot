"""
compile_game_data.py
Orchestrates all data fetching tools into a single JSON file per game date.
Output written to .tmp/game_data_YYYY-MM-DD.json

Usage:
    python tools/compile_game_data.py
    python tools/compile_game_data.py 2026-04-03

This is the main entry point the agent runs before starting analysis.
All tool failures produce structured errors — the agent continues with partial data.
"""

import sys
import json
import os
from datetime import date, datetime, timezone, timedelta

# Add tools/ to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fetch_schedule import fetch_schedule
from fetch_lineups import get_lineup_or_probables
from fetch_pitcher_stats import get_pitcher_profile
from fetch_team_stats import get_team_profile
from fetch_weather import fetch_weather
from fetch_park_factors import get_park_factors
from fetch_odds import build_search_queries


# ---------------------------------------------------------------------------
# Utility: Convert UTC game time to ET display string
# ---------------------------------------------------------------------------

def utc_to_et(utc_str: str) -> str:
    """Converts UTC ISO string to Eastern Time display string."""
    if not utc_str:
        return "TBD"
    try:
        dt = datetime.fromisoformat(utc_str.replace("Z", "+00:00"))
        # ET = UTC-4 (EDT) or UTC-5 (EST) — use UTC-4 for baseball season (April-October)
        et = dt - timedelta(hours=4)
        return et.strftime("%-I:%M %p ET")
    except Exception:
        return utc_str


# ---------------------------------------------------------------------------
# Totals context: pre-compute expected run total for each game
# ---------------------------------------------------------------------------

def _compute_totals_context(game_data: dict) -> dict:
    """
    Computes a pre-baked expected run total using:
      - Team offensive R/G baseline (season runs ÷ games played)
      - SP ERA and K/9 suppression adjustments
      - Park run factor adjustment
      - Weather wind adjustment
      - Temperature adjustment

    Returns a dict Claude can use directly rather than deriving from scratch.
    """
    notes = []

    def safe_float(val, default=None):
        try:
            f = float(val)
            return f if not (f != f) else default  # NaN check
        except (TypeError, ValueError):
            return default

    # --- Offensive baseline: runs per game ---
    home_stats = game_data.get("home_team_stats", {})
    away_stats = game_data.get("away_team_stats", {})

    home_batting = home_stats.get("batting", {})
    away_batting = away_stats.get("batting", {})
    home_record = home_stats.get("record", {})
    away_record = away_stats.get("record", {})

    home_runs = safe_float(home_batting.get("runs"))
    away_runs = safe_float(away_batting.get("runs"))
    home_gp = (safe_float(home_record.get("wins"), 0) or 0) + (safe_float(home_record.get("losses"), 0) or 0)
    away_gp = (safe_float(away_record.get("wins"), 0) or 0) + (safe_float(away_record.get("losses"), 0) or 0)

    home_rpg = round(home_runs / home_gp, 2) if home_runs and home_gp > 0 else None
    away_rpg = round(away_runs / away_gp, 2) if away_runs and away_gp > 0 else None

    if home_rpg is None or away_rpg is None:
        return {
            "home_rpg": home_rpg,
            "away_rpg": away_rpg,
            "raw_expected_total": None,
            "sp_adjustment": None,
            "park_adjustment": None,
            "weather_adjustment": None,
            "expected_total": None,
            "lean": "insufficient_data",
            "notes": ["Insufficient team stats to compute expected total."],
        }

    raw_total = home_rpg + away_rpg
    notes.append(f"Offensive baseline: {game_data.get('home_abbr')} {home_rpg} R/G + {game_data.get('away_abbr')} {away_rpg} R/G = {round(raw_total, 2)} raw")

    # --- SP adjustment ---
    sp_adj = 0.0
    for side, sp_key in [("home", "home_sp"), ("away", "away_sp")]:
        sp = game_data.get(sp_key, {})
        era = safe_float(sp.get("era")) or safe_float(sp.get("season_era"))
        k9 = safe_float(sp.get("k9")) or safe_float(sp.get("season_k9"))
        sp_name = sp.get("pitcher_name") or sp.get("name") or side.upper() + " SP"
        sp_notes = []
        if era is not None and era < 3.50:
            sp_adj -= 0.4
            sp_notes.append(f"ERA {era} (<3.50, -0.4)")
        if k9 is not None and k9 > 9.5:
            sp_adj -= 0.3
            sp_notes.append(f"K/9 {k9} (>9.5, -0.3)")
        if sp_notes:
            notes.append(f"{sp_name}: {', '.join(sp_notes)}")

    sp_adj = round(sp_adj, 2)

    # --- Park adjustment ---
    park_adj = 0.0
    park_data = game_data.get("park_factors", {})
    run_factor = safe_float(park_data.get("run_factor"))
    if run_factor is not None:
        if run_factor >= 115:
            park_adj = 1.75
            notes.append(f"Park factor {run_factor} (extreme hitter, +1.75)")
        elif run_factor >= 105:
            park_adj = 0.5
            notes.append(f"Park factor {run_factor} (hitter-friendly, +0.5)")
        elif run_factor <= 94:
            park_adj = -0.75
            notes.append(f"Park factor {run_factor} (strong pitcher-friendly, -0.75)")
        elif run_factor <= 97:
            park_adj = -0.5
            notes.append(f"Park factor {run_factor} (pitcher-friendly, -0.5)")
    park_adj = round(park_adj, 2)

    # --- Weather adjustment ---
    weather_adj = 0.0
    weather = game_data.get("weather", {})
    wind_effect = weather.get("wind_effect") or weather.get("windEffect")
    temp_f = safe_float(weather.get("temp_f") or weather.get("tempF"))
    is_dome = park_data.get("is_dome") or game_data.get("is_dome", False)

    if is_dome:
        notes.append("Dome — weather neutral (0)")
    else:
        if wind_effect == "strong_wind_blowing_out":
            weather_adj += 0.75
            notes.append("Wind blowing out strongly (+0.75)")
        elif wind_effect == "strong_wind_blowing_in":
            weather_adj -= 0.75
            notes.append("Wind blowing in strongly (-0.75)")
        if temp_f is not None and temp_f < 50:
            weather_adj -= 0.5
            notes.append(f"Cold game ({temp_f}°F, -0.5)")
        elif temp_f is not None and temp_f > 80:
            weather_adj += 0.25
            notes.append(f"Hot game ({temp_f}°F, +0.25)")
    weather_adj = round(weather_adj, 2)

    # --- Combined expected total ---
    expected_total = round(raw_total + sp_adj + park_adj + weather_adj, 2)

    # --- Additional context: bullpen, offense quality ---
    home_bullpen = home_stats.get("bullpen", {})
    away_bullpen = away_stats.get("bullpen", {})
    home_bp_era = safe_float(home_bullpen.get("team_era"))
    away_bp_era = safe_float(away_bullpen.get("team_era"))
    home_kpct = safe_float(home_batting.get("k_pct"))
    away_kpct = safe_float(away_batting.get("k_pct"))
    home_obp = safe_float(home_batting.get("obp"))
    away_obp = safe_float(away_batting.get("obp"))
    home_wrc = safe_float(home_batting.get("wrc_plus"))
    away_wrc = safe_float(away_batting.get("wrc_plus"))

    return {
        "home_rpg": home_rpg,
        "away_rpg": away_rpg,
        "raw_expected_total": round(raw_total, 2),
        "sp_adjustment": sp_adj,
        "park_adjustment": park_adj,
        "weather_adjustment": weather_adj,
        "expected_total": expected_total,
        "lean": "compare_to_posted_line",  # subtract posted line from expected_total to determine direction
        "offense_context": {
            "home_wrc_plus": home_wrc,
            "away_wrc_plus": away_wrc,
            "home_obp": home_obp,
            "away_obp": away_obp,
            "home_k_pct": home_kpct,
            "away_k_pct": away_kpct,
            "home_bullpen_era": home_bp_era,
            "away_bullpen_era": away_bp_era,
        },
        "notes": notes,
    }


# ---------------------------------------------------------------------------
# Main compiler
# ---------------------------------------------------------------------------

def compile_game_data(game_date: str = None, historical: bool = False) -> str:
    """
    Runs all data fetching tools for every game on game_date.
    Returns path to the written JSON file.
    Set historical=True to include already-completed (Final) games.
    """
    game_date = game_date or str(date.today())
    # Auto-detect historical mode: any date before today
    if not historical and game_date < str(date.today()):
        historical = True
    print(f"[compile] Fetching schedule for {game_date} (historical={historical})...")

    games_raw = fetch_schedule(game_date, include_final=historical)

    if not games_raw or (len(games_raw) == 1 and "error" in games_raw[0]):
        error_path = f".tmp/game_data_{game_date}.json"
        error_msg = games_raw[0].get("error", "No games found") if games_raw else "No games found"
        result = {"date": game_date, "error": error_msg, "games": []}
        os.makedirs(".tmp", exist_ok=True)
        with open(error_path, "w") as f:
            json.dump(result, f, indent=2)
        print(f"[compile] ERROR: {result['error']}")
        return error_path

    print(f"[compile] Found {len(games_raw)} games. Fetching data for each...")

    compiled_games = []
    for g in games_raw:
        game_id = g.get("game_id")
        matchup = f"{g.get('away_abbr')} @ {g.get('home_abbr')}"
        print(f"  [game] {matchup} (ID: {game_id})")

        game_data = {
            "game_id": game_id,
            "game_date": game_date,
            "matchup": matchup,
            "matchup_full": f"{g.get('away_team')} @ {g.get('home_team')}",
            "game_time_et": utc_to_et(g.get("game_time_utc")),
            "game_time_utc": g.get("game_time_utc"),
            "venue": g.get("venue"),
            "series_game_num": g.get("series_game_num"),
            "games_in_series": g.get("games_in_series"),
            "home_team": g.get("home_team"),
            "home_abbr": g.get("home_abbr"),
            "home_team_id": g.get("home_team_id"),
            "away_team": g.get("away_team"),
            "away_abbr": g.get("away_abbr"),
            "away_team_id": g.get("away_team_id"),
            "data_quality": {},
        }

        # --- Lineup (with probables fallback) ---
        try:
            lineup = get_lineup_or_probables(game_id)
            game_data["lineup"] = lineup
            game_data["lineup_confirmed"] = lineup.get("lineup_confirmed", False)
            game_data["data_quality"]["lineup"] = "ok"
        except Exception as e:
            game_data["lineup"] = {"error": str(e)}
            game_data["lineup_confirmed"] = False
            game_data["data_quality"]["lineup"] = f"error: {e}"

        # Determine SP names/IDs (from lineup or schedule probables)
        lineup_data = game_data.get("lineup") or {}
        home_lineup = lineup_data.get("home") or {}
        away_lineup = lineup_data.get("away") or {}
        home_sp_info = home_lineup.get("sp") or {}
        away_sp_info = away_lineup.get("sp") or {}

        home_sp_id = home_sp_info.get("player_id") or g.get("home_sp_id")
        home_sp_name = home_sp_info.get("name") or g.get("home_sp_name")
        away_sp_id = away_sp_info.get("player_id") or g.get("away_sp_id")
        away_sp_name = away_sp_info.get("name") or g.get("away_sp_name")

        # --- Home SP stats ---
        if home_sp_name:
            try:
                home_sp_stats = get_pitcher_profile(home_sp_name, home_sp_id)
                game_data["home_sp"] = home_sp_stats
                game_data["data_quality"]["home_sp"] = "ok"
            except Exception as e:
                game_data["home_sp"] = {"name": home_sp_name, "player_id": home_sp_id, "error": str(e)}
                game_data["data_quality"]["home_sp"] = f"error: {e}"
        else:
            game_data["home_sp"] = {"error": "No starting pitcher announced"}
            game_data["data_quality"]["home_sp"] = "no_sp_announced"

        # --- Away SP stats ---
        if away_sp_name:
            try:
                away_sp_stats = get_pitcher_profile(away_sp_name, away_sp_id)
                game_data["away_sp"] = away_sp_stats
                game_data["data_quality"]["away_sp"] = "ok"
            except Exception as e:
                game_data["away_sp"] = {"name": away_sp_name, "player_id": away_sp_id, "error": str(e)}
                game_data["data_quality"]["away_sp"] = f"error: {e}"
        else:
            game_data["away_sp"] = {"error": "No starting pitcher announced"}
            game_data["data_quality"]["away_sp"] = "no_sp_announced"

        # --- Home team stats ---
        try:
            home_profile = get_team_profile(g.get("home_abbr"), g.get("home_team_id"))
            game_data["home_team_stats"] = home_profile
            game_data["data_quality"]["home_team"] = "ok"
        except Exception as e:
            game_data["home_team_stats"] = {"error": str(e)}
            game_data["data_quality"]["home_team"] = f"error: {e}"

        # --- Away team stats ---
        try:
            away_profile = get_team_profile(g.get("away_abbr"), g.get("away_team_id"))
            game_data["away_team_stats"] = away_profile
            game_data["data_quality"]["away_team"] = "ok"
        except Exception as e:
            game_data["away_team_stats"] = {"error": str(e)}
            game_data["data_quality"]["away_team"] = f"error: {e}"

        # --- Weather ---
        try:
            weather = fetch_weather(g.get("venue", ""), g.get("game_time_utc", ""))
            game_data["weather"] = weather
            game_data["data_quality"]["weather"] = "ok"
        except Exception as e:
            game_data["weather"] = {"error": str(e)}
            game_data["data_quality"]["weather"] = f"error: {e}"

        # --- Park factors ---
        try:
            park_factors = get_park_factors(g.get("venue", ""))
            game_data["park_factors"] = park_factors
            game_data["data_quality"]["park_factors"] = "ok"
        except Exception as e:
            game_data["park_factors"] = {"error": str(e)}
            game_data["data_quality"]["park_factors"] = f"error: {e}"

        # --- Odds: generate search queries for agent ---
        # Agent runs these queries via WebSearch, then calls parse_web_odds_response()
        odds_queries = build_search_queries(
            g.get("away_team", g.get("away_abbr")),
            g.get("home_team", g.get("home_abbr")),
            game_date,
        )
        game_data["odds_search_queries"] = odds_queries
        game_data["odds"] = None  # Populated by agent after WebSearch
        game_data["eligible_bets"] = []  # Populated after odds are fetched
        game_data["data_quality"]["odds"] = "pending_websearch"

        # --- Pre-computed totals context ---
        game_data["totals_context"] = _compute_totals_context(game_data)

        compiled_games.append(game_data)

    # --- Write output ---
    os.makedirs(".tmp", exist_ok=True)
    output_path = f".tmp/game_data_{game_date}.json"

    output = {
        "date": game_date,
        "compiled_at": datetime.now(timezone.utc).isoformat(),
        "total_games": len(compiled_games),
        "lineups_confirmed": sum(1 for g in compiled_games if g.get("lineup_confirmed")),
        "games": compiled_games,
    }

    with open(output_path, "w") as f:
        json.dump(output, f, indent=2, default=str)

    print(f"[compile] Done. Written to {output_path}")
    print(f"[compile] {len(compiled_games)} games | "
          f"{output['lineups_confirmed']} lineups confirmed | "
          f"Odds: agent must run WebSearch queries per game")

    return output_path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    game_date = sys.argv[1] if len(sys.argv) > 1 else str(date.today())
    historical = "--historical" in sys.argv or game_date < str(date.today())
    path = compile_game_data(game_date, historical=historical)

    # Print summary
    with open(path) as f:
        data = json.load(f)

    print("\n--- SUMMARY ---")
    for g in data.get("games", []):
        home_sp = g.get("home_sp", {}).get("pitcher_name") or g.get("home_sp", {}).get("error", "TBD")
        away_sp = g.get("away_sp", {}).get("pitcher_name") or g.get("away_sp", {}).get("error", "TBD")
        confirmed = "✓" if g.get("lineup_confirmed") else "⚠️"
        print(f"  {confirmed} {g['matchup']} @ {g['game_time_et']} | {away_sp} vs {home_sp}")


if __name__ == "__main__":
    main()
