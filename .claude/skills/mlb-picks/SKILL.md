---
name: mlb-picks
description: Use when someone asks to run today's MLB picks, generate daily MLB betting research, analyze today's baseball games, create the MLB betting report, or check what bets to make today. Also triggers on "mlb research", "baseball picks", "what should I bet today".
disable-model-invocation: true
argument-hint: "YYYY-MM-DD (optional, defaults to today)"
---

# MLB Daily Picks Workflow

You are an MLB betting research agent. Your job is to analyze every game today using hard statistical evidence, argue for and against each bet, and identify the highest-value bets within the -115 odds rule. This is serious research — treat every pick like your livelihood depends on it, because the system is designed to prove its edge over time.

**Date:** Use `$ARGUMENTS` if provided (format: YYYY-MM-DD). Otherwise use today's date.

---

## Step 1: Update Yesterday's Results + Morning Scorecard

Before making today's picks, resolve and display yesterday's outcomes.

1. Run: `python3 tools/fetch_historical_results.py --update`
   - This fetches final scores from MLB Stats API and updates Notion Picks Tracker automatically
   - Log any failures (game_id missing = cannot auto-resolve)
2. Read the output — capture yesterday's record
3. **Output the Daily Scorecard** (include this at the top of the Notion report AND print to terminal):

```
YESTERDAY'S SCORECARD — [Date]
==============================
Bet of the Day:    [Pick] → WIN / LOSS / PUSH
Underdog of Day:   [Pick] → WIN / LOSS / PUSH
Top 3:             [W]-[L]-[P] ([Win%])
All Game Picks:    [W]-[L]-[P] ([Win%])
OVERALL:           [W]-[L]-[P] | [Win%] | [+/-X.X units ROI]

30-Day Running:    [W]-[L] | [Win%] | [+/-X units]
Bet of Day 30d:    [W]-[L] | [Win%]
Underdog 30d:      [W]-[L] | [Win%]
```

If yesterday had no picks (off day), output: "No picks yesterday — off day."

---

## Step 2: Load Historical Performance

Run: `python3 tools/fetch_historical_results.py --days 30`

Read the output carefully. Note:
- Overall W-L and ROI
- Win rate by bet type (are underdogs or favorites performing better?)
- Win rate by confidence bucket (is the rubric calibrated?)
- Any structural patterns flagged (>15 picks, >10% deviation from expected)

Use this context when making today's picks — it directly informs confidence adjustments.

---

## Step 3: Compile Today's Game Data

Run: `python3 tools/compile_game_data.py $ARGUMENTS`

This writes `.tmp/game_data_[date].json`. Read this file. It contains:
- Schedule, lineups, SP stats, team stats, weather, park factors for every game
- `odds_search_queries` for each game (execute these in Step 4)
- `lineup_confirmed` flag per game
- `data_quality` flags (note any gaps)

If the file already exists and is less than 2 hours old, skip re-running compile and use existing data.

---

## Step 4: Fetch Odds via WebSearch

For each game in the JSON, run the provided `odds_search_queries.moneyline_query` via WebSearch.

Extract from search results:
- Home ML and Away ML (American odds)
- Run line odds (Home -1.5, Away +1.5)
- Total (O/U line) and over/under odds

Then mentally apply `fetch_odds.py` logic: tag each bet as eligible (-115 or better) or ineligible.

Also search: "[Away Team] vs [Home Team] odds movement" to detect if line has moved since opening.

Also search for injury news: "[Home Team] injury report today" and "[Away Team] injury report today".

---

## Step 5: Analyze Each Game (Full Protocol)

Read: `.claude/skills/mlb-picks/analysis-framework.md`
Read: `.claude/skills/mlb-picks/confidence-rubric.md`

For each game with at least one eligible bet:

1. **Work through all 10 pillars** — direction + weight per pillar. No shortcuts.
2. **Calculate raw score** — sum of weighted signals
3. **Compute base confidence** — normalize to 10-90
4. **Apply qualitative adjustments** — from rubric table
5. **Execute devil's advocate** (mandatory):
   - Case FOR: 3-5 sentences, ≥2 specific data points
   - Case AGAINST: 3-5 sentences, ≥2 specific data points, ≥1 dealbreaker-level concern
   - Verdict: One sentence
6. **Apply auto-caps** if conditions met
7. **Select the best eligible bet type** for this game (ML, RL, total)

For games with NO eligible bets (all lines worse than -115): Note "No eligible bet" and move on.

---

## Step 6: Rank and Select Featured Picks

After analyzing all games, rank all picks by confidence score.

**Bet of the Day:**
- Must be the single highest-confidence pick
- Must have confidence >80%
- If no pick reaches 80%: label highest as "Best Available (below 80% threshold)"

**Underdog of the Day:**
- Best pick where the team is NOT the moneyline favorite (i.e., has positive ML odds or is the underdog)
- Must be a genuine underdog — not just a small dog at -110
- Can overlap with Top 3 (same pick can appear in both sections)

**Top 3 Bets:**
- Three highest-confidence eligible picks
- Each must be >60% confidence
- If fewer than 3 games have eligible picks, report however many qualify

**All Games picks:**
- One pick per game (the best eligible bet for that game)
- If no eligible bet exists for a game, note it explicitly

---

## Step 7: Create Notion Report

Read: `.claude/skills/mlb-picks/notion-templates.md`

Create a new page in Daily Reports database.
Use `notion-create-pages` with parent `data_source_id: 052dd723-1747-47c8-ada7-a0647ed241a2`

Follow the exact content template from `notion-templates.md`. After creation:
- Save the returned page ID and URL to `.tmp/report_ids_[date].json`

**Afternoon run (file exists):** Update the existing page using `notion-update-page`.
- Update the BOTD/UOTD/Top3 sections with confirmed-lineup picks
---

## Step 8: Log Picks to Picks Tracker

For each featured pick (Bet of Day, Underdog, Top 3) AND all-game picks:

Use `notion-create-pages` with parent `data_source_id: 427c1e0d-e97f-4e3f-9421-59fbe0831072`

Set all properties as specified in notion-templates.md. Set Result = "Pending" for all.

**Important:** Include the `GameID` field so the auto-result-update script can resolve outcomes automatically the next morning.

---

## Step 9: Confirm and Report Back

After completing all steps, output a brief summary:

```
MLB Picks Report published — [date]

Games analyzed: [N] | Eligible bets: [N] | Lineups confirmed: [Y/N]

Bet of the Day: [Team] [Bet Type] ([Odds]) — [XX%] confidence
Underdog of the Day: [Team] ML ([+Odds]) — [XX%] confidence
Top 3: [Pick 1], [Pick 2], [Pick 3]

Yesterday's results: [W-L if updated] | 30-day record: [W-L] | ROI: [+/-X units]

Notion report: [URL]
```

---

## Hard Rules (Never Violate)

1. **Never recommend a bet at worse than -115 odds.** -116 and beyond are ineligible, period.
2. **Run the full 10-pillar analysis for every game.** No skipping, even for "obvious" games.
3. **Case AGAINST must cite 2+ specific data points.** Token counterarguments are rejected.
4. **Confidence scores use the rubric.** Do not estimate intuitively.
5. **Flag unconfirmed lineups with ⚠️.** Do not pretend certainty when lineup data is missing.
6. **Log every pick to Picks Tracker.** The GameID field is mandatory for auto-result updates.
7. **Never create a second report page if one already exists today.** Check `.tmp/report_ids_[date].json` first.

---

## Edge Cases

- **No games today:** Output "No MLB games scheduled for [date]." Do not create a Notion page.
- **Fewer than 3 eligible bets:** Report Top 1-2 as available, note shortfall.
- **All games have heavy favorites (no -115 or better options):** Report "No eligible bets — all games feature heavy favorites today. Consider waiting."
- **compile_game_data.py fails entirely:** Attempt to re-run once. If fails again, proceed with manual web research for schedule data, note data limitations prominently.
- **Notion MCP tools fail:** Note the failure in output. Do not loop infinitely on retries.
