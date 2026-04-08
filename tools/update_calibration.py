"""
update_calibration.py
Computes calibration adjustments from historical performance data and writes:
  - .tmp/calibration_adjustments.json   (machine-readable, read by agent each morning)
  - Updates confidence-rubric.md calibration history tables

Run after fetch_historical_results.py --update, before making today's picks.

Usage:
    python tools/update_calibration.py           # Last 30 days
    python tools/update_calibration.py --days 60 # Extended lookback
"""

import sys
import json
import os
import re
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
from fetch_historical_results import get_performance_summary, query_picks_db, extract_prop

RUBRIC_PATH = Path(__file__).parent.parent / ".claude/skills/mlb-picks/confidence-rubric.md"
TMP_DIR = Path(__file__).parent.parent / ".tmp"

# Predicted win rates per confidence bucket (from rubric)
PREDICTED_WIN_RATES = {
    "80-95": 72.0,
    "70-79": 65.0,
    "60-69": 58.0,
    "50-59": 52.0,
}

# Minimum picks before a bucket/type adjustment is applied
MIN_SAMPLE_BUCKET = 5
MIN_SAMPLE_TYPE = 5


# ---------------------------------------------------------------------------
# Bucket lookup
# ---------------------------------------------------------------------------

def get_bucket(confidence) -> str | None:
    if confidence is None:
        return None
    c = int(confidence)
    if c >= 80:
        return "80-95"
    elif c >= 70:
        return "70-79"
    elif c >= 60:
        return "60-69"
    elif c >= 50:
        return "50-59"
    return None


# ---------------------------------------------------------------------------
# Per-type ROI (not in get_performance_summary, computed here)
# ---------------------------------------------------------------------------

def fetch_raw_picks(days: int) -> list:
    """Pull all resolved picks for the last N days from Notion."""
    since_date = str(date.today() - timedelta(days=days))
    filter_body = {
        "and": [
            {"property": "Date", "date": {"on_or_after": since_date}},
            {"property": "Result", "select": {"does_not_equal": "Pending"}},
        ]
    }
    pages = query_picks_db(filter_body)
    if not pages or "error" in pages[0]:
        return []

    picks = []
    for page in pages:
        picks.append({
            "result":     extract_prop(page, "Result"),
            "bet_type":   extract_prop(page, "Bet Type"),
            "confidence": extract_prop(page, "Confidence"),
            "odds":       extract_prop(page, "Odds"),
            "sp_rating":  extract_prop(page, "SP Matchup Rating"),
            "date":       extract_prop(page, "Date"),
        })
    return picks


def roi_for(picks: list) -> float:
    total = 0.0
    for p in picks:
        if p["result"] == "Win" and p.get("odds"):
            odds = p["odds"]
            total += (odds / 100) if odds > 0 else (100 / abs(odds))
        elif p["result"] == "Loss":
            total -= 1.0
    return round(total, 2)


def win_rate(picks: list) -> dict:
    w = sum(1 for p in picks if p["result"] == "Win")
    l = sum(1 for p in picks if p["result"] == "Loss")
    total = w + l
    return {
        "wins": w,
        "losses": l,
        "total": total,
        "win_pct": round(w / total * 100, 1) if total else 0.0,
    }


# ---------------------------------------------------------------------------
# Adjustment math
# ---------------------------------------------------------------------------

def bucket_adjustment(predicted: float, actual: float, sample: int) -> float:
    """
    Returns the numeric adjustment to apply to picks in this confidence bucket.
    Positive = boost confidence. Negative = reduce confidence.

    Formula:
      deviation = predicted - actual   (positive = overconfident)
      adj = clamp(-deviation * 0.6, -20, +10)

    Examples:
      predicted 72%, actual 30% → deviation +42 → adj = -20 (capped)
      predicted 65%, actual 70% → deviation -5  → adj = +3
    """
    if sample < MIN_SAMPLE_BUCKET:
        return 0.0
    deviation = predicted - actual
    raw = -deviation * 0.6
    return round(max(-20.0, min(10.0, raw)), 1)


def type_adjustment(win_pct: float, sample: int) -> float:
    """
    Compares a bet type's win% against the ~52% break-even baseline.
    Lighter touch (0.4 dampening) since type and bucket adjustments stack.

    Examples:
      win_pct 30% → deviation +22 → adj = -8.8, capped at -10
      win_pct 60% → deviation -8  → adj = +3.2, capped at +5
    """
    if sample < MIN_SAMPLE_TYPE:
        return 0.0
    deviation = 52.0 - win_pct   # positive = underperforming break-even
    raw = -deviation * 0.4
    return round(max(-10.0, min(5.0, raw)), 1)


def global_adjustment(overall_win_pct: float, total: int) -> float:
    """
    Safety net: applied when a pick's bucket has insufficient data.
    Compares against 55% baseline (our minimum acceptable edge target).
    """
    if total < 10:
        return 0.0
    deviation = 55.0 - overall_win_pct
    raw = -deviation * 0.35
    return round(max(-8.0, min(5.0, raw)), 1)


# ---------------------------------------------------------------------------
# Core: compute all adjustments
# ---------------------------------------------------------------------------

def compute_adjustments(days: int = 30) -> dict:
    perf = get_performance_summary(days)
    if "error" in perf:
        return {"error": perf["error"], "last_updated": str(date.today())}

    raw_picks = fetch_raw_picks(days)

    overall = perf["overall"]
    by_bucket_stats = perf.get("by_confidence_bucket", {})
    by_type_stats = perf.get("by_bet_type", {})

    # --- Per-bucket calibration ---
    bucket_data = {}
    for bucket, predicted in PREDICTED_WIN_RATES.items():
        stats = by_bucket_stats.get(bucket, {})
        actual = stats.get("win_pct", None)
        sample = stats.get("total", 0)
        adj = bucket_adjustment(predicted, actual or 0.0, sample)
        bucket_data[bucket] = {
            "predicted_win_pct": predicted,
            "actual_win_pct": actual,
            "sample": sample,
            "adjustment": adj if sample >= MIN_SAMPLE_BUCKET else 0.0,
            "note": (
                f"Insufficient data ({sample} picks, need {MIN_SAMPLE_BUCKET})"
                if sample < MIN_SAMPLE_BUCKET
                else (
                    f"Overconfident by {round(predicted - actual, 1)} pts"
                    if adj < 0
                    else f"Underconfident by {round(actual - predicted, 1)} pts"
                )
            ),
        }

    # --- Per-bet-type calibration ---
    type_data = {}
    for bet_type in ["Bet of Day", "Underdog", "Top 3", "Game Pick"]:
        type_picks = [p for p in raw_picks if p.get("bet_type") == bet_type]
        wr = win_rate(type_picks)
        roi = roi_for(type_picks)
        adj = type_adjustment(wr["win_pct"], wr["total"])
        type_data[bet_type] = {
            "record": f"{wr['wins']}-{wr['losses']}",
            "win_pct": wr["win_pct"],
            "sample": wr["total"],
            "roi_units": roi,
            "adjustment": adj,
            "note": (
                f"Insufficient data ({wr['total']} picks, need {MIN_SAMPLE_TYPE})"
                if wr["total"] < MIN_SAMPLE_TYPE
                else f"Win rate {wr['win_pct']}% vs 52% break-even"
            ),
        }

    # --- SP matchup rating performance ---
    sp_data = {}
    for rating in ["Strong", "Neutral", "Weak"]:
        sp_picks = [p for p in raw_picks if p.get("sp_rating") == rating]
        wr = win_rate(sp_picks)
        sp_data[rating] = {
            "record": f"{wr['wins']}-{wr['losses']}",
            "win_pct": wr["win_pct"],
            "sample": wr["total"],
        }

    # --- Global fallback ---
    g_adj = global_adjustment(overall["win_pct"], overall["total"])

    # --- Stacking note ---
    # The agent applies BOTH a bucket_adjustment AND a type_adjustment.
    # To prevent double-penalizing, cap the combined calibration at -25.

    return {
        "last_updated": str(date.today()),
        "lookback_days": days,
        "sample_size": overall["total"],
        "overall_record": f"{overall['wins']}-{overall['losses']}",
        "overall_win_pct": overall["win_pct"],
        "roi_units": perf.get("roi_units", 0),
        "by_bucket": bucket_data,
        "by_bet_type": type_data,
        "by_sp_rating": sp_data,
        "global_adjustment": g_adj,
        "max_combined_adjustment": -25.0,
        "patterns": perf.get("patterns_detected", []),
        "narrative": _build_narrative(overall, bucket_data, type_data, g_adj),
        "how_to_apply": (
            "After computing base_confidence + qualitative adjustments: "
            "(1) Look up by_bucket[confidence_bucket]['adjustment']. "
            "(2) Look up by_bet_type[bet_type]['adjustment']. "
            "(3) combined = bucket_adj + type_adj. "
            "(4) If abs(combined) > max_combined_adjustment, scale to cap. "
            "(5) If bucket has insufficient data, use global_adjustment instead of bucket_adj. "
            "Final score = clamp(base + qualitative + combined, 10, 95)."
        ),
    }


def _build_narrative(overall, buckets, types, g_adj) -> str:
    lines = [
        f"Overall last {overall['wins']+overall['losses']} resolved picks: "
        f"{overall['wins']}-{overall['losses']} ({overall['win_pct']}% win rate)."
    ]

    # Worst-performing bucket
    worst_bucket = None
    worst_dev = 0.0
    for bucket, data in buckets.items():
        if data["sample"] >= MIN_SAMPLE_BUCKET and data["actual_win_pct"] is not None:
            dev = data["predicted_win_pct"] - data["actual_win_pct"]
            if abs(dev) > worst_dev:
                worst_dev = abs(dev)
                worst_bucket = (bucket, data)

    if worst_bucket:
        b, d = worst_bucket
        direction = "overconfident" if d["adjustment"] < 0 else "underconfident"
        lines.append(
            f"Largest deviation: {b}% confidence bucket is {direction} by "
            f"{round(worst_dev, 1)} pts (actual {d['actual_win_pct']}% vs predicted {d['predicted_win_pct']}%)."
        )

    # Type outliers
    for bt, data in types.items():
        if data["sample"] >= MIN_SAMPLE_TYPE and data["adjustment"] <= -5:
            lines.append(
                f"{bt} picks are underperforming at {data['win_pct']}% win rate "
                f"(adjustment: {data['adjustment']:+.0f})."
            )

    if g_adj < -2:
        lines.append(f"Global fallback adjustment: {g_adj:+.1f} pts.")
    elif g_adj > 1:
        lines.append(f"System may be underconfident — global boost: {g_adj:+.1f} pts.")

    return " ".join(lines)


# ---------------------------------------------------------------------------
# Write calibration JSON
# ---------------------------------------------------------------------------

def write_calibration_json(adjustments: dict) -> Path:
    TMP_DIR.mkdir(exist_ok=True)
    path = TMP_DIR / "calibration_adjustments.json"
    with open(path, "w") as f:
        json.dump(adjustments, f, indent=2)
    return path


# ---------------------------------------------------------------------------
# Update confidence-rubric.md
# ---------------------------------------------------------------------------

def update_rubric_file(adjustments: dict) -> bool:
    """
    Rewrites the AUTO-MANAGED sections of confidence-rubric.md between
    <!-- AUTO:*_START --> and <!-- AUTO:*_END --> markers.
    """
    if not RUBRIC_PATH.exists():
        print(f"Warning: rubric not found at {RUBRIC_PATH}", file=sys.stderr)
        return False

    content = RUBRIC_PATH.read_text()

    # --- Bucket table ---
    bucket_rows = ["| Bucket | Predicted Win% | Actual Win% | Sample | Adjustment | Status |",
                   "|---|---|---|---|---|---|"]
    for bucket, predicted in PREDICTED_WIN_RATES.items():
        d = adjustments["by_bucket"].get(bucket, {})
        actual_str = f"{d['actual_win_pct']}%" if d.get("actual_win_pct") is not None else "—"
        adj = d.get("adjustment", 0)
        adj_str = f"{adj:+.0f}" if adj != 0 else "0"
        sample = d.get("sample", 0)
        note = d.get("note", "—")
        bucket_rows.append(f"| {bucket}% | ~{predicted}% | {actual_str} | {sample} | {adj_str} | {note} |")
    bucket_table = "\n".join(bucket_rows)

    content = _replace_section(content, "AUTO:BUCKET_TABLE", bucket_table)

    # --- Bet type table ---
    type_rows = ["| Bet Type | Record | Win% | ROI (units) | Adjustment |",
                 "|---|---|---|---|---|"]
    for bt in ["Bet of Day", "Underdog", "Top 3", "Game Pick"]:
        d = adjustments["by_bet_type"].get(bt, {})
        record = d.get("record", "—")
        win_pct = f"{d['win_pct']}%" if d.get("win_pct") is not None else "—"
        roi = d.get("roi_units", "—")
        adj = d.get("adjustment", 0)
        adj_str = f"{adj:+.0f}" if adj != 0 else "0"
        type_rows.append(f"| {bt} | {record} | {win_pct} | {roi} | {adj_str} |")
    type_table = "\n".join(type_rows)

    content = _replace_section(content, "AUTO:TYPE_TABLE", type_table)

    # --- Last updated block ---
    today = adjustments["last_updated"]
    narrative = adjustments.get("narrative", "")
    g_adj = adjustments.get("global_adjustment", 0)
    patterns = adjustments.get("patterns", [])
    pattern_str = "\n".join(f"- {p}" for p in patterns) if patterns else "- None detected yet"

    last_updated_block = (
        f"Date: {today} (auto-updated by update_calibration.py)\n\n"
        f"Summary: {narrative}\n\n"
        f"Global fallback adjustment: {g_adj:+.1f} pts\n\n"
        f"Patterns flagged:\n{pattern_str}"
    )
    content = _replace_section(content, "AUTO:LAST_UPDATED", last_updated_block)

    RUBRIC_PATH.write_text(content)
    return True


def _replace_section(content: str, marker: str, new_body: str) -> str:
    """Replace content between <!-- MARKER_START --> and <!-- MARKER_END --> markers."""
    start_tag = f"<!-- {marker}_START -->"
    end_tag = f"<!-- {marker}_END -->"
    pattern = re.compile(
        re.escape(start_tag) + r".*?" + re.escape(end_tag),
        re.DOTALL,
    )
    replacement = f"{start_tag}\n{new_body}\n{end_tag}"
    if pattern.search(content):
        return pattern.sub(replacement, content)
    else:
        print(f"Warning: marker {marker} not found in rubric — section not updated.", file=sys.stderr)
        return content


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    args = sys.argv[1:]
    days = 30
    for i, a in enumerate(args):
        if a == "--days" and i + 1 < len(args):
            days = int(args[i + 1])

    print(f"Computing calibration adjustments (last {days} days)...", file=sys.stderr)

    adjustments = compute_adjustments(days)

    if "error" in adjustments:
        print(json.dumps(adjustments, indent=2))
        sys.exit(1)

    json_path = write_calibration_json(adjustments)
    rubric_ok = update_rubric_file(adjustments)

    # Print structured output for the agent to read
    print(json.dumps(adjustments, indent=2))

    print(
        f"\n--- Calibration update complete ---\n"
        f"JSON written to: {json_path}\n"
        f"Rubric updated: {rubric_ok}\n"
        f"Sample size: {adjustments['sample_size']} picks\n"
        f"Overall: {adjustments['overall_record']} ({adjustments['overall_win_pct']}%)\n"
        f"Global adjustment: {adjustments['global_adjustment']:+.1f} pts",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
