# MLB Season Baseline Research — Workflow SOP

**Purpose:** Retroactive analysis of the season's opening week to establish early patterns, calibrate the model, and snapshot all 30 teams' early-season state.

**Trigger:** Run `/mlb-baseline` (or invoke this workflow directly)
**Output:** Standalone Notion page under MLB Bot Dashboard
**Frequency:** Once at season start, then after 3 weeks (April 14), then after 1 month (May 1)

---

## Prerequisites

- `.env` loaded (NOTION_TOKEN required for Notion MCP)
- `tools/` Python scripts functional
- pybaseball installed (`pip install pybaseball`)
- Notion MCP connected

---

## Execution Steps

### 1. Determine Date Range
- Default start: `2026-03-27` (or first date with MLB games)
- End: yesterday (the run date minus 1 day)
- Check if `.tmp/baseline_page_id.json` exists — if yes, this is an update run (append new dates only)

### 2. Compile Game Data (per date)
```bash
python3 tools/compile_game_data.py [DATE]
```
Run for each date in range. Skip if `.tmp/game_data_[DATE].json` already exists.

If compile fails for a date:
- Retry once
- If still fails: mark date as "Data unavailable", continue

### 3. Fetch Final Scores (per date)
Use MLB Stats API schedule endpoint with linescore hydration, or WebSearch for final scores as fallback.

Build per-game lookup: `{ game_id → { home_score, away_score, winner } }`

### 4. Retroactive 10-Pillar Analysis
For every game across all dates:
- Follow full analysis-framework.md protocol
- **Exceptions:** No odds gate. Pillar 8 = INSUFFICIENT_DATA. No lineup-unconfirmed penalty. Abbreviated devil's advocate (2 sentences each side).
- Record pick, confidence, outcome per game

### 5. Compile Stats
- Overall W-L-P and win%
- Record by confidence bucket (80+, 70-79, 60-69, 50-59)
- SP edge correlation (Pillar 1 advantage ≥+6)
- Home win rate, favorite win rate, totals over%, avg margin, % of games with -115 or better

### 6. Build Team Signals
- Identify teams outperforming / underperforming the model (≥2 games of evidence)
- Map SP rotations from who-pitched-which-dates for all 30 teams
- Flag SPs not yet seen (may be IL or rotation not yet cycled through)
- Identify taxed bullpens (3+ appearances for key relievers)

### 7. Publish Notion Page
- Template: `.claude/skills/mlb-baseline/baseline-notion-template.md`
- Parent: MLB Bot Dashboard page `33810928-6062-81d9-ba16-ec3354f73493`
- After creation: save `{ page_id, url, created_at }` to `.tmp/baseline_page_id.json`

### 8. Terminal Summary
Output system test confirmation (see SKILL.md Step 8 for format).

---

## Update Run (after April 14 or May 1)

When re-running to add more data:
1. Read `.tmp/baseline_page_id.json` for existing page ID
2. Process only new dates since last run
3. Recalculate all stats including new data
4. Use `notion-update-page` to update the existing page (do not create a new one)
5. Update `created_at` → `updated_at` in the JSON

---

## Error Handling

| Error | Action |
|---|---|
| compile_game_data.py fails for a date | Retry once, then skip and note in Data Quality |
| Final scores unavailable | Mark game as "Unable to score", exclude from W/L stats |
| MLB Stats API timeout | WebSearch fallback for schedule/scores |
| pybaseball rate limit | Wait 30s, retry once |
| Notion MCP create fails | Print full page content to terminal; do not retry in a loop |

---

## Calibration Decision Rules

After computing bucket win rates:
- **N < 10 in a bucket:** Note it, but do NOT adjust confidence-rubric.md yet
- **N ≥ 10 AND deviation > 10%:** Flag it in the Executive Summary and propose a specific rubric adjustment for user review
- **User approves adjustment:** Edit `.claude/skills/mlb-picks/confidence-rubric.md` directly

---

## Integration with Daily Picks

After baseline runs, the daily `/mlb-picks` skill can reference:
- `.tmp/baseline_page_id.json` → link to full research page
- SP rotation mapping → infer upcoming starters before official announcements
- Team signal flags → inform devil's advocate sections for flagged teams

*The daily SKILL.md does not auto-read the baseline yet — that integration requires user approval before modifying mlb-picks/SKILL.md.*
