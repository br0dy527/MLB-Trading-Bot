---
name: mlb-baseline
description: Use when someone asks to run season baseline research, generate early-season calibration data, retroactively analyze opening week games, or build the season baseline Notion page. Triggers on "mlb baseline", "season baseline", "early season research", "retroactive picks", "initial research", "season kickoff analysis".
disable-model-invocation: true
argument-hint: "YYYY-MM-DD (optional start date, defaults to 2026-03-27)"
---

# MLB Season Baseline Research Workflow

You are an MLB betting research agent running a retroactive analysis of the season's first week. Your job is to collect data for every game already played, run the full 10-pillar analysis in retroactive mode, identify early-season patterns, and publish a standalone research page in Notion that the daily `/mlb-picks` skill can reference all season.

This is also a **system test** — every tool should be verified as working. Document the status of each tool explicitly at the end.

**Date range:** Use `$ARGUMENTS` as the start date if provided. Otherwise default start: `2026-03-27`. Run through yesterday (`2026-04-04`).

---

## Step 1: Determine Date Range

Calculate the list of dates to process: from start date through yesterday.

For each date, check if `.tmp/game_data_[DATE].json` already exists and is valid. If so, skip re-running compile for that date (reuse cached data).

---

## Step 2: Collect Game Data for Each Date

For each date in the range:

```
python3 tools/compile_game_data.py [DATE]
```

This writes `.tmp/game_data_[DATE].json`. Read each file after creation and note:
- Number of games on that date
- Any data gaps or tool errors flagged in `data_quality`
- SP names confirmed for each game

Track per-date status: OK / Partial / Error. This feeds the Data Quality Assessment at the end.

---

## Step 3: Fetch Final Scores for Each Date

For each date, the actual game outcomes are needed for retroactive W/L/P assessment.

Use the MLB Stats API schedule endpoint for each date to get final scores:
- Search for the date's schedule: `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=[DATE]&hydrate=linescore`
- Extract: game_id, home team, away team, home score, away score

If `fetch_historical_results.py --update` can accept a specific date flag, use that. Otherwise make a direct WebSearch for "[DATE] MLB final scores" as a fallback and cross-reference with game_data JSON.

Build a lookup: `{ game_id: { home_score: N, away_score: N, winner: "home"|"away" } }`

---

## Step 4: Retroactive 10-Pillar Analysis

Read: `.claude/skills/mlb-picks/analysis-framework.md`
Read: `.claude/skills/mlb-picks/confidence-rubric.md`

For **every game played** across all dates, run the 10-pillar analysis in retroactive mode.

**Retroactive Mode Modifications:**
| Standard Mode | Retroactive Mode |
|---|---|
| -115 odds gate (skip ineligible) | No odds gate — analyze every game |
| Pillar 8 = line movement (live) | Pillar 8 = INSUFFICIENT_DATA (0 pts, NEUTRAL) |
| Full devil's advocate (3-5 sentences each) | Abbreviated: 2 sentences FOR, 2 sentences AGAINST, 1-sentence verdict |
| ⚠️ LINEUP PENDING penalty (-10) | No penalty — lineups are now confirmed |
| Odds fetched via WebSearch | No odds fetch needed |

**For each game, record:**
```
{
  date: "YYYY-MM-DD",
  game_id: N,
  matchup: "Away @ Home",
  retro_pick: "Home ML" | "Away ML" | "Over N" | "Under N",
  pillar_raw_score: N,
  confidence: N,
  actual_winner: "home" | "away",
  outcome: "Win" | "Loss" | "Push",
  key_pillar: "P1" | "P3" | etc (which pillar drove the pick),
  notes: "one-sentence summary of dominant factor"
}
```

Work through games date by date. Aim for speed — abbreviated analysis is correct here.

---

## Step 5: Compile Statistics

After all games are analyzed, calculate:

**Retroactive Record:**
- Total games analyzed
- Total picks (W-L-P and win%)
- Record by confidence bucket: 80+, 70-79, 60-69, 50-59
- Record by pick direction: Home ML, Away ML, Totals (Over/Under)
- SP edge correlation: games where Pillar 1 had strong edge (+6 or more) — did the favored SP's team win?

**Early Market Observations:**
- Home team win rate (N games)
- Favorite win rate (team with lower ML odds)
- Totals: games going over vs. under
- Average margin of victory
- Blowouts (5+ run margin): N out of total

**Data Quality:**
- For each tool: status OK / N errors
- Any specific failure modes encountered

---

## Step 6: Build Team Signals

From the retroactive data, identify:

**Teams Outperforming the Model** (model picked against them but they won anyway):
- Note the structural pattern the model missed (e.g., bullpen strength, lineup depth)

**Teams Underperforming the Model** (model was confident in them but they lost):
- Note any concerning trends (e.g., SP early struggles, lineup injuries not yet captured)

**SP Rotation Mapping (all 30 teams):**
- Based on who pitched which dates, infer rotation order for each team
- Note any SP who has not appeared yet (may be IL, skipped, or opening series delayed)
- Flag: any SP showing early ERA concern (≥5.00 ERA, ≥2 starts)

**Bullpen Workload:**
- Which teams' bullpens have already logged heavy early-season use
- Flag teams with 3+ key reliever appearances in the first 8 days

---

## Step 7: Publish Notion Baseline Page

Read: `.claude/skills/mlb-baseline/baseline-notion-template.md`

Create the baseline page as a **child page of the MLB Bot Dashboard**:
- Parent: `33810928-6062-81d9-ba16-ec3354f73493` (MLB Bot Dashboard)
- Use `notion-create-pages` with parent page_id (not data_source_id)

After creation:
- Save the returned page ID and URL to `.tmp/baseline_page_id.json`
- Format: `{ "page_id": "...", "url": "...", "created_at": "YYYY-MM-DD" }`

---

## Step 8: Confirm and Report

After publishing, output this summary to terminal:

```
MLB Season Baseline complete — [start_date] through [end_date]

Dates processed:       N
Games analyzed:        N
Retroactive record:    W-L-P (XX% win rate)
Calibration status:    [On track / Overconfident / Underconfident / Sample too small]

Tools verified:
  compile_game_data.py:           [OK / N errors]
  MLB Stats API (schedule):       [OK]
  MLB Stats API (final scores):   [OK]
  pybaseball (SP stats):          [OK / N gaps]
  Open-Meteo (weather):           [OK]
  Notion MCP (page creation):     [OK]

Baseline page: [Notion URL]
Saved to: .tmp/baseline_page_id.json
```

---

## Hard Rules

1. **Analyze every game — no odds gate in retroactive mode.** This is research, not betting.
2. **Pillar 8 is always INSUFFICIENT_DATA for retroactive analysis.** Do not guess historical line movement.
3. **Flag all calibration deviations >10% when N≥10.** These may require rubric adjustments.
4. **Document every tool error explicitly.** This run is also a system test.
5. **Never create a second baseline page if `.tmp/baseline_page_id.json` already exists and the page is valid.** Update instead.

---

## Edge Cases

- **Game data JSON missing for a date:** Attempt re-run of compile_game_data.py once. If still fails, note date as "Data unavailable" and skip — do not halt the entire run.
- **Final scores unavailable for a game:** Mark outcome as "Unable to score" and exclude from W/L stats. Note in Data Quality section.
- **Notion MCP create fails:** Output all content to terminal in template format. Do not loop on retries.
- **Season start date unclear:** If start date argument not provided and 2026-03-27 returns no games, step back one day at a time until the first date with games is found. Use that as start.
