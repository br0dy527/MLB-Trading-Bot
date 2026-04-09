"""
fetch_historical_results.py
Queries the Notion Picks Tracker database for historical performance data.
Also handles automated result updates: resolves "Pending" picks from yesterday
by fetching final scores from MLB Stats API.

Usage:
    python tools/fetch_historical_results.py              # Performance summary (last 30 days)
    python tools/fetch_historical_results.py --update     # Update yesterday's pending results
    python tools/fetch_historical_results.py --days 60    # Extend lookback window

Requires:
    NOTION_TOKEN, NOTION_PICKS_DB_ID in .env
"""

import sys
import json
import os
import urllib.request
import urllib.error
import urllib.parse
from datetime import date, timedelta
from dotenv import load_dotenv

load_dotenv()

NOTION_TOKEN = os.environ.get("NOTION_TOKEN", "")
PICKS_DB_ID = os.environ.get("NOTION_PICKS_DB_ID", "")

# Maps 3-letter abbreviation (as stored in Matchup field) to possible
# substrings that may appear in the Pick description (uppercased for matching).
TEAM_NAME_FRAGMENTS = {
    "LAA": ["LAA", "ANGELS"],
    "ARI": ["ARI", "DIAMONDBACKS", "D-BACKS", "ARIZONA"],
    "BAL": ["BAL", "ORIOLES", "BALTIMORE"],
    "BOS": ["BOS", "RED SOX", "BOSTON"],
    "CHC": ["CHC", "CUBS"],
    "CIN": ["CIN", "REDS", "CINCINNATI"],
    "CLE": ["CLE", "GUARDIANS", "CLEVELAND"],
    "COL": ["COL", "ROCKIES", "COLORADO"],
    "DET": ["DET", "TIGERS", "DETROIT"],
    "HOU": ["HOU", "ASTROS", "HOUSTON"],
    "KC":  ["KC", "ROYALS", "KANSAS CITY"],
    "LAD": ["LAD", "DODGERS"],
    "WSH": ["WSH", "NATIONALS", "WASHINGTON"],
    "NYM": ["NYM", "METS"],
    "OAK": ["OAK", "ATHLETICS", "OAKLAND"],
    "PIT": ["PIT", "PIRATES", "PITTSBURGH"],
    "SD":  ["SD", "PADRES", "SAN DIEGO"],
    "SEA": ["SEA", "MARINERS", "SEATTLE"],
    "SF":  ["SF", "GIANTS", "SAN FRANCISCO"],
    "STL": ["STL", "CARDINALS", "ST. LOUIS", "ST LOUIS"],
    "TB":  ["TB", "RAYS", "TAMPA BAY"],
    "TEX": ["TEX", "RANGERS", "TEXAS"],
    "TOR": ["TOR", "BLUE JAYS", "TORONTO"],
    "MIN": ["MIN", "TWINS", "MINNESOTA"],
    "PHI": ["PHI", "PHILLIES", "PHILADELPHIA"],
    "ATL": ["ATL", "BRAVES", "ATLANTA"],
    "CWS": ["CWS", "WHITE SOX"],
    "MIA": ["MIA", "MARLINS", "MIAMI"],
    "NYY": ["NYY", "YANKEES"],
    "MIL": ["MIL", "BREWERS", "MILWAUKEE"],
}


# ---------------------------------------------------------------------------
# Notion API helpers
# ---------------------------------------------------------------------------

def notion_request(method: str, path: str, body: dict = None) -> dict:
    url = f"https://api.notion.com/v1{path}"
    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
    }
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return {"error": f"Notion API error {e.code}: {e.read().decode()}"}
    except Exception as e:
        return {"error": f"Notion request failed: {e}"}


def query_picks_db(filter_body: dict) -> list:
    """Query the Picks Tracker database with a filter."""
    if not NOTION_TOKEN or not PICKS_DB_ID:
        return [{"error": "NOTION_TOKEN or NOTION_PICKS_DB_ID not set in .env"}]

    results = []
    cursor = None
    while True:
        body = {"filter": filter_body, "page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        resp = notion_request("POST", f"/databases/{PICKS_DB_ID}/query", body)
        if "error" in resp:
            return [resp]
        results.extend(resp.get("results", []))
        if not resp.get("has_more"):
            break
        cursor = resp.get("next_cursor")
    return results


# ---------------------------------------------------------------------------
# MLB Stats API: Final scores
# ---------------------------------------------------------------------------

def get_final_score(game_id: int) -> dict:
    """Fetch final score for a game from MLB Stats API.
    Uses the schedule endpoint so we can check abstractGameState == 'Final'
    rather than guessing from currentInning (which is True mid-9th).
    """
    url = f"https://statsapi.mlb.com/api/v1/schedule?gamePk={game_id}&hydrate=linescore"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode())

        dates = data.get("dates", [])
        if not dates or not dates[0].get("games"):
            return {"error": f"Game {game_id} not found in schedule API"}

        game = dates[0]["games"][0]
        abstract_state = game.get("status", {}).get("abstractGameState", "")

        if abstract_state != "Final":
            return {
                "home_runs": None,
                "away_runs": None,
                "is_final": False,
                "status": abstract_state,
            }

        linescore = game.get("linescore", {})
        teams = linescore.get("teams", {})
        home = teams.get("home", {})
        away = teams.get("away", {})
        return {
            "home_runs": home.get("runs"),
            "away_runs": away.get("runs"),
            "is_final": True,
        }
    except Exception as e:
        return {"error": f"Score fetch failed: {e}"}


def _team_in_bet(team_abbr: str, bet_upper: str) -> bool:
    """Returns True if any known name fragment for team_abbr appears in the uppercased bet string."""
    fragments = TEAM_NAME_FRAGMENTS.get(team_abbr.upper(), [team_abbr.upper()])
    return any(f in bet_upper for f in fragments)


def resolve_pick_result(pick: dict, final_score: dict) -> str:
    """
    Given a pick dict and final score, returns "Win", "Loss", "Push", or "Pending".
    pick fields: bet_description (e.g. "MIN ML (-108)"), home_team, away_team
    home_team / away_team should be 2-3 letter abbreviations as stored in the Matchup field.
    """
    if "error" in final_score:
        return "Pending"

    home_runs = final_score.get("home_runs")
    away_runs = final_score.get("away_runs")

    if home_runs is None or away_runs is None:
        return "Pending"

    if not final_score.get("is_final"):
        return "Pending"

    bet = pick.get("bet_description", "").upper()
    home_team = pick.get("home_team", "").strip()
    away_team = pick.get("away_team", "").strip()

    home_wins = home_runs > away_runs
    away_wins = away_runs > home_runs
    tied = home_runs == away_runs

    # ML bet
    if "ML" in bet:
        if _team_in_bet(home_team, bet):
            return "Win" if home_wins else ("Push" if tied else "Loss")
        elif _team_in_bet(away_team, bet):
            return "Win" if away_wins else ("Push" if tied else "Loss")

    # Run line -1.5
    if "-1.5" in bet:
        if _team_in_bet(home_team, bet):
            if home_runs - away_runs >= 2:
                return "Win"
            else:
                return "Loss"
        elif _team_in_bet(away_team, bet):
            if away_runs - home_runs >= 2:
                return "Win"
            else:
                return "Loss"

    # Run line +1.5
    if "+1.5" in bet:
        if _team_in_bet(home_team, bet):
            return "Win" if home_runs + 1.5 > away_runs else "Loss"
        elif _team_in_bet(away_team, bet):
            return "Win" if away_runs + 1.5 > home_runs else "Loss"

    # Over/Under
    total = (home_runs or 0) + (away_runs or 0)
    if "OVER" in bet:
        try:
            line = float(bet.split("OVER")[-1].strip().split()[0])
            return "Win" if total > line else ("Push" if total == line else "Loss")
        except (ValueError, IndexError):
            return "Pending"
    if "UNDER" in bet:
        try:
            line = float(bet.split("UNDER")[-1].strip().split()[0])
            return "Win" if total < line else ("Push" if total == line else "Loss")
        except (ValueError, IndexError):
            return "Pending"

    return "Pending"  # Could not determine


# ---------------------------------------------------------------------------
# Update yesterday's pending results
# ---------------------------------------------------------------------------

def extract_prop(page: dict, prop_name: str):
    """Extract a property value from a Notion page."""
    props = page.get("properties", {})
    prop = props.get(prop_name, {})
    ptype = prop.get("type")
    if ptype == "title":
        items = prop.get("title", [])
        return items[0].get("plain_text", "") if items else ""
    elif ptype == "rich_text":
        items = prop.get("rich_text", [])
        return items[0].get("plain_text", "") if items else ""
    elif ptype == "select":
        s = prop.get("select")
        return s.get("name") if s else None
    elif ptype == "date":
        d = prop.get("date")
        return d.get("start") if d else None
    elif ptype == "number":
        return prop.get("number")
    elif ptype == "url":
        return prop.get("url")
    return None


def update_pick_result(page_id: str, result: str, score_summary: str = None) -> bool:
    body = {
        "properties": {
            "Result": {"select": {"name": result}},
        }
    }
    if score_summary:
        body["properties"]["Notes"] = {
            "rich_text": [{"text": {"content": score_summary}}]
        }
    resp = notion_request("PATCH", f"/pages/{page_id}", body)
    return "error" not in resp


def get_all_time_summary() -> dict:
    """Query all resolved picks with no date filter for season/all-time totals."""
    if not NOTION_TOKEN or not PICKS_DB_ID:
        return {"error": "NOTION_TOKEN or NOTION_PICKS_DB_ID not set in .env"}

    filter_body = {
        "or": [
            {"property": "Result", "select": {"equals": "Win"}},
            {"property": "Result", "select": {"equals": "Loss"}},
            {"property": "Result", "select": {"equals": "Push"}},
        ]
    }
    pages = query_picks_db(filter_body)
    if not pages:
        return {"wins": 0, "losses": 0, "pushes": 0, "win_pct": 0.0, "roi_units": 0.0}
    if "error" in pages[0]:
        return pages[0]

    wins = losses = pushes = 0
    total_return = 0.0
    for page in pages:
        result = extract_prop(page, "Result")
        odds = extract_prop(page, "Odds")
        if result == "Win":
            wins += 1
            if odds:
                total_return += (odds / 100) if odds > 0 else (100 / abs(odds))
        elif result == "Loss":
            losses += 1
            total_return -= 1
        elif result == "Push":
            pushes += 1

    total = wins + losses
    return {
        "wins": wins,
        "losses": losses,
        "pushes": pushes,
        "win_pct": round(wins / total * 100, 1) if total else 0.0,
        "roi_units": round(total_return, 2),
    }


def _resolve_pages(pages: list) -> tuple:
    """
    Shared resolution logic: fetch final scores, update Notion, return (updated, failed, details, resolved).
    resolved entries: {date, bet_type, bet, result}
    """
    updated = failed = 0
    details = []
    resolved = []

    for page in pages:
        page_id = page.get("id")
        matchup = extract_prop(page, "Matchup")
        bet_desc = extract_prop(page, "Pick")
        bet_type = extract_prop(page, "Bet Type") or "Game Pick"
        pick_date = extract_prop(page, "Date") or ""
        game_id = extract_prop(page, "GameID")

        result = "Pending"
        score = {}
        if game_id:
            score = get_final_score(int(game_id))
            parts = matchup.split("@") if "@" in matchup else ["", ""]
            away_team = parts[0].strip()
            home_team = parts[1].strip()
            result = resolve_pick_result(
                {"bet_description": bet_desc, "home_team": home_team, "away_team": away_team},
                score
            )

        if result != "Pending":
            score_note = None
            if score.get("home_runs") is not None:
                score_note = f"Final: {away_team} {score['away_runs']}, {home_team} {score['home_runs']}"
            success = update_pick_result(page_id, result, score_note)
            if success:
                updated += 1
            else:
                failed += 1
            resolved.append({"date": pick_date, "bet_type": bet_type, "bet": bet_desc, "result": result})
            details.append({"date": pick_date, "matchup": matchup, "bet_type": bet_type, "bet": bet_desc, "result": result, "updated": success})
        else:
            details.append({"date": pick_date, "matchup": matchup, "bet_type": bet_type, "bet": bet_desc, "result": "Pending", "note": "Could not resolve"})

    return updated, failed, details, resolved


def update_pending_results(target_date: str = None) -> dict:
    """
    Resolves ALL pending picks across all dates (not just yesterday), updates Notion,
    and returns a structured scoreboard scoped to yesterday's picks.
    target_date controls which date's picks populate the scoreboard (defaults to yesterday).
    """
    yesterday = str(date.today() - timedelta(days=1))
    scoreboard_date = target_date or yesterday

    # Query ALL pending picks regardless of date
    filter_body = {"property": "Result", "select": {"equals": "Pending"}}
    pages = query_picks_db(filter_body)

    updated = failed = 0
    details = []
    resolved = []

    # Only attempt resolution if there are pending picks (and no API error)
    if pages and "error" not in pages[0]:
        updated, failed, details, resolved = _resolve_pages(pages)
    elif pages and "error" in pages[0]:
        return {"error": pages[0].get("error", "Notion query failed")}

    # Scoreboard uses picks from scoreboard_date that were resolved in this run
    yesterday_resolved = [r for r in resolved if r.get("date", "").startswith(scoreboard_date)]

    # If no picks were resolved in this run for scoreboard_date, fetch already-resolved picks from Notion
    if not yesterday_resolved:
        already_resolved_filter = {
            "and": [
                {"property": "Date", "date": {"equals": scoreboard_date}},
                {
                    "or": [
                        {"property": "Result", "select": {"equals": "Win"}},
                        {"property": "Result", "select": {"equals": "Loss"}},
                        {"property": "Result", "select": {"equals": "Push"}},
                    ]
                },
            ]
        }
        prior_pages = query_picks_db(already_resolved_filter)
        if prior_pages and "error" not in prior_pages[0]:
            for page in prior_pages:
                yesterday_resolved.append({
                    "date": extract_prop(page, "Date") or scoreboard_date,
                    "bet_type": extract_prop(page, "Bet Type") or "Game Pick",
                    "bet": extract_prop(page, "Pick") or "",
                    "result": extract_prop(page, "Result") or "Pending",
                })

    def _find_by_type(bt):
        return next((r for r in yesterday_resolved if r["bet_type"] == bt), None)

    def _record_by_type(bt):
        subset = [r for r in yesterday_resolved if r["bet_type"] == bt]
        w = sum(1 for r in subset if r["result"] == "Win")
        l = sum(1 for r in subset if r["result"] == "Loss")
        p = sum(1 for r in subset if r["result"] == "Push")
        total = w + l
        return {"wins": w, "losses": l, "pushes": p,
                "win_pct": round(w / total * 100, 1) if total else 0.0}

    botd = _find_by_type("Bet of Day")
    uotd = _find_by_type("Underdog")
    top3 = _record_by_type("Top 3")

    yesterday_all = {
        "wins": sum(1 for r in yesterday_resolved if r["result"] == "Win"),
        "losses": sum(1 for r in yesterday_resolved if r["result"] == "Loss"),
        "pushes": sum(1 for r in yesterday_resolved if r["result"] == "Push"),
    }

    # 30-day and all-time stats (queried after resolution so counts are current)
    running_30 = get_performance_summary(days=30)
    all_time = get_all_time_summary()

    scoreboard = {
        "date": scoreboard_date,
        "bet_of_day": {
            "pick": botd["bet"] if botd else "—",
            "result": botd["result"] if botd else "No pick",
        },
        "underdog_of_day": {
            "pick": uotd["bet"] if uotd else "—",
            "result": uotd["result"] if uotd else "No pick",
        },
        "top_3": top3,
        "yesterday_overall": yesterday_all,
        "running_30_day": {
            "wins": running_30.get("overall", {}).get("wins", 0),
            "losses": running_30.get("overall", {}).get("losses", 0),
            "win_pct": running_30.get("overall", {}).get("win_pct", 0.0),
            "roi_units": running_30.get("roi_units", 0.0),
        },
        "all_time": all_time,
    }

    return {
        "scoreboard_date": scoreboard_date,
        "all_pending_found": len(pages),
        "updated": updated,
        "failed": failed,
        "still_pending": len(pages) - updated,
        "scoreboard": scoreboard,
        "details": details,
    }


# ---------------------------------------------------------------------------
# Performance analysis
# ---------------------------------------------------------------------------

def get_performance_summary(days: int = 30) -> dict:
    """
    Queries Picks Tracker for the last N days and returns performance analysis.
    Used by the agent each morning to inform today's picks.
    """
    since_date = str(date.today() - timedelta(days=days))

    filter_body = {
        "and": [
            {"property": "Date", "date": {"on_or_after": since_date}},
            {"property": "Result", "select": {"does_not_equal": "Pending"}},
        ]
    }
    pages = query_picks_db(filter_body)

    if not pages:
        return {"error": "No historical data found", "days": days}
    if "error" in pages[0]:
        return pages[0]

    picks = []
    for page in pages:
        result = extract_prop(page, "Result")
        bet_type = extract_prop(page, "Bet Type")
        confidence = extract_prop(page, "Confidence")
        odds = extract_prop(page, "Odds")
        sp_rating = extract_prop(page, "SP Matchup Rating")
        notes = extract_prop(page, "Notes")
        pick_desc = extract_prop(page, "Pick")

        picks.append({
            "result": result,
            "bet_type": bet_type,
            "confidence": confidence,
            "odds": odds,
            "sp_rating": sp_rating,
            "notes": notes or "",
            "pick": pick_desc or "",
        })

    def win_rate(subset):
        w = sum(1 for p in subset if p["result"] == "Win")
        l = sum(1 for p in subset if p["result"] == "Loss")
        total = w + l
        return {"wins": w, "losses": l, "total": total, "win_pct": round(w / total * 100, 1) if total else 0}

    # Overall
    overall = win_rate(picks)

    # By bet type
    by_type = {}
    for bt in ["Bet of Day", "Underdog", "Top 3", "Game Pick"]:
        subset = [p for p in picks if p.get("bet_type") == bt]
        if subset:
            by_type[bt] = win_rate(subset)

    # By confidence bucket
    by_confidence = {}
    buckets = [("80-95", 80, 95), ("70-79", 70, 79), ("60-69", 60, 69), ("50-59", 50, 59)]
    for label, lo, hi in buckets:
        subset = [p for p in picks if p.get("confidence") and lo <= p["confidence"] <= hi]
        if subset:
            by_confidence[label] = win_rate(subset)

    # By SP matchup rating
    by_sp = {}
    for rating in ["Strong", "Neutral", "Weak"]:
        subset = [p for p in picks if p.get("sp_rating") == rating]
        if subset:
            by_sp[rating] = win_rate(subset)

    # By bet subtype (ML vs RL vs Totals)
    by_subtype = {}
    for label, pattern in [("ML", "ML"), ("RL-1.5", "-1.5"), ("RL+1.5", "+1.5"), ("Over", "OVER"), ("Under", "UNDER")]:
        subset = [p for p in picks if pattern.upper() in (p.get("pick") or "").upper()]
        if subset:
            by_subtype[label] = win_rate(subset)

    # Pattern detection: flag any segment >10 picks with win% deviation
    patterns = []
    for label, stats in {**by_type, **by_confidence, **by_sp, **by_subtype}.items():
        if stats["total"] >= 10:
            pct = stats["win_pct"]
            if pct >= 65:
                patterns.append(f"{label}: {pct}% win rate ({stats['total']} picks) — STRONG EDGE")
            elif pct <= 40:
                patterns.append(f"{label}: {pct}% win rate ({stats['total']} picks) — WEAK AREA, reduce confidence")

    # ROI calculation (simple: +1 unit per win, -1 per loss, fractional for odds)
    total_return = 0
    for p in picks:
        if p["result"] == "Win" and p.get("odds"):
            odds = p["odds"]
            if odds > 0:
                total_return += odds / 100
            else:
                total_return += 100 / abs(odds)
        elif p["result"] == "Loss":
            total_return -= 1

    return {
        "lookback_days": days,
        "since_date": since_date,
        "total_picks": len(picks),
        "overall": overall,
        "by_bet_type": by_type,
        "by_confidence_bucket": by_confidence,
        "by_sp_matchup": by_sp,
        "by_bet_subtype": by_subtype,
        "roi_units": round(total_return, 2),
        "patterns_detected": patterns,
        "calibration_note": (
            f"Last {days} days: {overall['wins']}-{overall['losses']} "
            f"({overall['win_pct']}% win rate). "
            f"ROI: {'+' if total_return >= 0 else ''}{round(total_return, 2)} units."
        ),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    args = sys.argv[1:]

    if "--update" in args:
        target_date = None
        for i, a in enumerate(args):
            if a == "--date" and i + 1 < len(args):
                target_date = args[i + 1]
        result = update_pending_results(target_date)
        print(json.dumps(result, indent=2))
        return

    days = 30
    for i, a in enumerate(args):
        if a == "--days" and i + 1 < len(args):
            days = int(args[i + 1])

    result = get_performance_summary(days)
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
