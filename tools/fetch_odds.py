"""
fetch_odds.py
Fetches current MLB moneylines, run lines, and totals.

Phase 1: Returns structured search queries for the agent to execute via WebSearch.
         The agent calls this script, runs the searches, then passes results back
         to compile_game_data.py via a parsed odds dict.

Phase 2 (future): Swap to The Odds API by setting ODDS_API_KEY in .env.
         Only this file changes — compile_game_data.py and the skill are unaffected.

Usage:
    python tools/fetch_odds.py "NYY" "BOS" 2026-04-03
    python tools/fetch_odds.py --queries-only  (prints search queries for all games)

The -115 eligibility gate lives in american_to_implied_prob() and is_eligible().
"""

import sys
import json
import os
import urllib.request
import urllib.error
from datetime import date


# ---------------------------------------------------------------------------
# Core math helpers
# ---------------------------------------------------------------------------

def american_to_implied_prob(odds: int) -> float:
    """Convert American odds to implied probability (0-1)."""
    if odds > 0:
        return 100 / (odds + 100)
    else:
        return abs(odds) / (abs(odds) + 100)


def implied_prob_to_american(prob: float) -> int:
    """Convert implied probability to American odds (rounded)."""
    if prob >= 0.5:
        return round(-prob / (1 - prob) * 100)
    else:
        return round((1 - prob) / prob * 100)


def is_eligible(american_odds: int) -> bool:
    """
    Returns True if the bet qualifies under the -115 rule.
    Eligible: -115, -114, ..., -100, +100, +110, +150, etc.
    Ineligible: -116, -120, -150, -200, etc.
    """
    if american_odds >= -115:
        return True
    return False


def line_movement_signal(opening: int, current: int, public_pct_on_current: float = None) -> str:
    """
    Detects reverse line movement (sharp money signal).
    public_pct_on_current: % of public tickets on the team whose line is 'current'.
    Returns: 'sharp_for', 'sharp_against', 'no_movement', 'insufficient_data'
    """
    if opening is None or current is None:
        return "insufficient_data"

    move = current - opening  # positive = line got more expensive (shorter)

    if public_pct_on_current is None:
        # No public % data — report raw movement direction only
        if abs(move) >= 5:
            return "line_moved_shorter" if move > 0 else "line_moved_longer"
        return "no_movement"

    # Reverse line movement: public heavy on one side but line moves other way
    if public_pct_on_current > 60 and move < -5:
        return "sharp_for"  # Public likes this team but line got longer → sharps fading
    if public_pct_on_current < 40 and move > 5:
        return "sharp_against"  # Public fading this team but line got shorter → sharps backing
    return "no_movement"


# ---------------------------------------------------------------------------
# Phase 1: WebSearch query generator
# ---------------------------------------------------------------------------

def build_search_queries(away_team: str, home_team: str, game_date: str) -> dict:
    """
    Returns search query strings the agent should execute via WebSearch.
    The agent searches, extracts odds, then calls parse_web_odds_response().
    """
    return {
        "moneyline_query": f"{away_team} vs {home_team} odds moneyline {game_date} site:covers.com OR site:vegasinsider.com OR site:espn.com",
        "runline_query": f"{away_team} vs {home_team} run line odds {game_date}",
        "total_query": f"{away_team} vs {home_team} over under total {game_date}",
        "opening_query": f"{away_team} vs {home_team} opening line {game_date}",
        "instructions": (
            "Search these queries and extract: home ML, away ML, run line odds, "
            "total (O/U line), over odds, under odds. Then call parse_web_odds_response() "
            "with the extracted values, or pass them directly to compile_game_data.py."
        ),
    }


def parse_web_odds_response(
    away_team: str,
    home_team: str,
    home_ml: int = None,
    away_ml: int = None,
    home_rl_odds: int = None,   # odds on home team -1.5
    away_rl_odds: int = None,   # odds on away team +1.5
    total_line: float = None,
    over_odds: int = None,
    under_odds: int = None,
    opening_home_ml: int = None,
    opening_away_ml: int = None,
) -> dict:
    """
    Structures raw odds values into the standard format consumed by compile_game_data.py.
    Applies the -115 eligibility gate to each bet type.
    """
    eligible_bets = []

    if home_ml is not None and is_eligible(home_ml):
        eligible_bets.append({
            "bet": f"{home_team} ML",
            "odds": home_ml,
            "implied_prob": round(american_to_implied_prob(home_ml) * 100, 1),
        })
    if away_ml is not None and is_eligible(away_ml):
        eligible_bets.append({
            "bet": f"{away_team} ML",
            "odds": away_ml,
            "implied_prob": round(american_to_implied_prob(away_ml) * 100, 1),
        })
    if home_rl_odds is not None and is_eligible(home_rl_odds):
        eligible_bets.append({
            "bet": f"{home_team} -1.5",
            "odds": home_rl_odds,
            "implied_prob": round(american_to_implied_prob(home_rl_odds) * 100, 1),
        })
    if away_rl_odds is not None and is_eligible(away_rl_odds):
        eligible_bets.append({
            "bet": f"{away_team} +1.5",
            "odds": away_rl_odds,
            "implied_prob": round(american_to_implied_prob(away_rl_odds) * 100, 1),
        })
    if over_odds is not None and total_line is not None and is_eligible(over_odds):
        eligible_bets.append({
            "bet": f"Over {total_line}",
            "odds": over_odds,
            "implied_prob": round(american_to_implied_prob(over_odds) * 100, 1),
        })
    if under_odds is not None and total_line is not None and is_eligible(under_odds):
        eligible_bets.append({
            "bet": f"Under {total_line}",
            "odds": under_odds,
            "implied_prob": round(american_to_implied_prob(under_odds) * 100, 1),
        })

    # Line movement
    home_movement = line_movement_signal(opening_home_ml, home_ml)

    return {
        "home_team": home_team,
        "away_team": away_team,
        "home_ml": home_ml,
        "away_ml": away_ml,
        "home_ml_implied_prob": round(american_to_implied_prob(home_ml) * 100, 1) if home_ml else None,
        "away_ml_implied_prob": round(american_to_implied_prob(away_ml) * 100, 1) if away_ml else None,
        "home_rl_odds": home_rl_odds,
        "away_rl_odds": away_rl_odds,
        "total_line": total_line,
        "over_odds": over_odds,
        "under_odds": under_odds,
        "opening_home_ml": opening_home_ml,
        "opening_away_ml": opening_away_ml,
        "home_line_movement": home_movement,
        "eligible_bets": eligible_bets,
        "has_eligible_bets": len(eligible_bets) > 0,
        "data_source": "websearch",
    }


# ---------------------------------------------------------------------------
# Phase 2: The Odds API (activate by setting ODDS_API_KEY in .env)
# ---------------------------------------------------------------------------

def fetch_via_odds_api(game_date: str) -> list:
    """
    Fetches all MLB game odds from The Odds API in one request.
    Returns list of parsed odds dicts in parse_web_odds_response() format.
    Only called if ODDS_API_KEY is set in environment.
    """
    api_key = os.environ.get("ODDS_API_KEY")
    if not api_key:
        return [{"error": "ODDS_API_KEY not set — using WebSearch fallback"}]

    url = (
        f"https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/"
        f"?apiKey={api_key}&regions=us&markets=h2h,spreads,totals&oddsFormat=american"
        f"&dateFormat=iso&commenceTimeFrom={game_date}T00:00:00Z"
        f"&commenceTimeTo={game_date}T23:59:59Z"
    )

    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            games = json.loads(resp.read().decode())
    except urllib.error.URLError as e:
        return [{"error": f"Odds API unreachable: {e}"}]

    results = []
    for g in games:
        home = g.get("home_team", "")
        away = g.get("away_team", "")
        home_ml = away_ml = home_rl = away_rl = None
        total = over_o = under_o = None

        for bm in g.get("bookmakers", []):
            for market in bm.get("markets", []):
                key = market.get("key")
                outcomes = {o["name"]: o["price"] for o in market.get("outcomes", [])}
                if key == "h2h":
                    home_ml = home_ml or outcomes.get(home)
                    away_ml = away_ml or outcomes.get(away)
                elif key == "spreads":
                    for o in market.get("outcomes", []):
                        if o["name"] == home and o.get("point", 0) < 0:
                            home_rl = home_rl or o["price"]
                        elif o["name"] == away and o.get("point", 0) > 0:
                            away_rl = away_rl or o["price"]
                elif key == "totals":
                    total = total or next((o.get("point") for o in market["outcomes"]), None)
                    over_o = over_o or outcomes.get("Over")
                    under_o = under_o or outcomes.get("Under")

        results.append(parse_web_odds_response(
            away_team=away, home_team=home,
            home_ml=home_ml, away_ml=away_ml,
            home_rl_odds=home_rl, away_rl_odds=away_rl,
            total_line=total, over_odds=over_o, under_odds=under_o,
        ))

    return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    args = sys.argv[1:]
    api_key = os.environ.get("ODDS_API_KEY")

    if "--queries-only" in args:
        # Print example search queries (agent reads these and runs them)
        print(json.dumps(build_search_queries("AWAY_TEAM", "HOME_TEAM", str(date.today())), indent=2))
        return

    if len(args) >= 2:
        away, home = args[0], args[1]
        game_date = args[2] if len(args) > 2 else str(date.today())

        if api_key:
            # Try Odds API first
            all_odds = fetch_via_odds_api(game_date)
            # Find matching game
            match = next((o for o in all_odds if away in o.get("away_team", "") or home in o.get("home_team", "")), None)
            if match:
                print(json.dumps(match, indent=2))
                return

        # Fallback: print search queries for agent
        queries = build_search_queries(away, home, game_date)
        print(json.dumps(queries, indent=2))
        return

    # No args: print eligibility test examples
    print(json.dumps({
        "eligibility_examples": [
            {"odds": -115, "eligible": is_eligible(-115)},
            {"odds": -116, "eligible": is_eligible(-116)},
            {"odds": -120, "eligible": is_eligible(-120)},
            {"odds": +110, "eligible": is_eligible(110)},
            {"odds": -100, "eligible": is_eligible(-100)},
        ],
        "implied_prob_examples": [
            {"odds": -115, "implied_pct": round(american_to_implied_prob(-115) * 100, 1)},
            {"odds": +150, "implied_pct": round(american_to_implied_prob(150) * 100, 1)},
        ],
    }, indent=2))


if __name__ == "__main__":
    main()
