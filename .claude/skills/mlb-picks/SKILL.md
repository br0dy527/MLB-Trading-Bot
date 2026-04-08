---
name: mlb-picks
description: Use when someone asks to run today's MLB picks, generate daily MLB betting research, analyze today's baseball games, create the MLB betting report, or check what bets to make today. Also triggers on "mlb research", "baseball picks", "what should I bet today".
disable-model-invocation: true
argument-hint: "YYYY-MM-DD (optional, defaults to today)"
---

# MLB Daily Picks Workflow

You are an MLB betting research agent. Your job is to analyze every game today using hard statistical evidence, argue for and against each bet, and identify the highest-value bets within the -120 odds rule. This is serious research — treat every pick like your livelihood depends on it, because the system is designed to prove its edge over time.

**Date:** Use `$ARGUMENTS` if provided (format: YYYY-MM-DD). Otherwise use today's date.

---

## Step 1: Update Yesterday's Results + Morning Scorecard

Before making today's picks, resolve and display yesterday's outcomes.

1. Run: `python3 tools/fetch_historical_results.py --update`
   - This scans **all** Pending picks in the Picks Tracker (any date), fetches final scores from MLB Stats API, and flips each resolved pick to Win/Loss/Push in Notion
   - The `scoreboard` field in the output is scoped to yesterday's picks specifically
   - Log any unresolved picks (game_id missing or game not yet Final)
2. Parse the JSON output. Read the `scoreboard` key — it contains all values needed for the scorecard:
   - `scoreboard.bet_of_day.pick` and `scoreboard.bet_of_day.result`
   - `scoreboard.underdog_of_day.pick` and `scoreboard.underdog_of_day.result`
   - `scoreboard.top_3` → wins/losses/pushes/win_pct
   - `scoreboard.running_30_day` → wins/losses/win_pct/roi_units
   - `scoreboard.all_time` → wins/losses/pushes/win_pct/roi_units
3. **Output the Daily Scorecard** (include this at the top of the Notion report AND print to terminal):

```
YESTERDAY'S SCORECARD — [scoreboard.date]
==========================================
Bet of the Day:    [scoreboard.bet_of_day.pick] → [scoreboard.bet_of_day.result]
Underdog of Day:   [scoreboard.underdog_of_day.pick] → [scoreboard.underdog_of_day.result]
Top 3:             [top_3.wins]-[top_3.losses]-[top_3.pushes] ([top_3.win_pct]%)
30-Day Running:    [running_30_day.wins]-[running_30_day.losses] | [running_30_day.win_pct]% | [+/-X units]
OVERALL (Season):  [all_time.wins]-[all_time.losses]-[all_time.pushes] | [all_time.win_pct]% | [all_time.roi_units] units ROI
```

If `scoreboard` is missing or `updated == 0`, output: "No picks yesterday — off day."

---

## Step 2: Load Historical Performance + Update Calibration

Run: `python3 tools/update_calibration.py`

This runs the full calibration loop: queries Notion, computes adjustments, writes `.tmp/calibration_adjustments.json`, and updates `confidence-rubric.md`.

Read the JSON output. Extract and hold these values for use in Step 5:
- `by_bucket` — per-confidence-bucket adjustment (e.g. `{"80-95": {"adjustment": -15, ...}}`)
- `by_bet_type` — per-bet-type adjustment (e.g. `{"Bet of Day": {"adjustment": -8, ...}}`)
- `global_adjustment` — fallback when a bucket has insufficient data
- `max_combined_adjustment` — cap on total calibration applied to any one pick
- `narrative` — paste this into the Performance Context section of the Notion report

Also note:
- Overall W-L and ROI
- Win rate by bet type and confidence bucket
- Any structural patterns flagged (`patterns` field)

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

Extract from search results for **every game** — all of the following are required:
- Home ML and Away ML (American odds)
- Run line odds (Home -1.5, Away +1.5)
- **Total (O/U line) and over/under odds** — always note the total and both over/under prices

Then mentally apply `fetch_odds.py` logic: tag each bet as eligible (-120 or better) or ineligible. Any bet worse than -120 is ineligible, full stop.

Also search: "[Away Team] vs [Home Team] odds movement" to detect if line has moved since opening.

Also search for injury news: "[Home Team] injury report today" and "[Away Team] injury report today".

---

## Step 5: Analyze Each Game (Full Protocol)

Read: `.claude/skills/mlb-picks/analysis-framework.md`
Read: `.claude/skills/mlb-picks/confidence-rubric.md`

**Before scoring any game**, check `.tmp/baseline_page_id.json`. If it exists, apply the following as contextual notes in your devil's advocate sections (they do not override pillar scores):
- Any FIP/ERA divergence flagged for today's starting pitcher (positive or negative regression signal)
- Any team-level signal (overperforming/underperforming the model) for today's teams
- Any park factor anomaly noted for today's venue (e.g. Coors playing cold, Progressive Field suppressing runs)

For each game with at least one eligible bet:

1. **Work through all 10 pillars** — direction + weight per pillar. No shortcuts.
2. **Calculate raw score** — sum of weighted signals
3. **Compute base confidence** — normalize to 10-90
4. **Apply qualitative adjustments** — from rubric table
5. **Apply calibration adjustment** (hard numeric, not optional):
   - Determine this pick's confidence bucket (e.g. score is 78 → bucket "70-79")
   - Determine the bet type you plan to assign (Bet of Day / Underdog / Top 3 / Game Pick)
   - Look up `calibration_adjustments.json`:
     - `bucket_adj = by_bucket[bucket]["adjustment"]` — use 0 if sample < 5
     - `type_adj = by_bet_type[bet_type]["adjustment"]` — use 0 if sample < 5
     - If bucket has insufficient data, use `global_adjustment` instead of `bucket_adj`
   - `combined = bucket_adj + type_adj`
   - If `abs(combined) > max_combined_adjustment` (25), scale: `combined = combined / abs(combined) * 25`
   - `confidence = clamp(base + qualitative_adjustments + combined, 10, 95)`
   - **Show your work:** state the bucket_adj, type_adj, combined, and final score explicitly
6. **Execute devil's advocate** (mandatory):
   - Case FOR: 3-5 sentences, ≥2 specific data points
   - Case AGAINST: 3-5 sentences, ≥2 specific data points, ≥1 dealbreaker-level concern
   - Verdict: One sentence
7. **Apply auto-caps** if conditions met
8. **Select the best eligible bet type** for this game (ML, RL, total)

For games with NO eligible bets (all lines -121 or worse): Note "No eligible bet" and move on.

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

Then create and send a notification email using `gmail-create-draft` to `brody@br0dyllc.com`:

**Subject:** `MLB Picks Ready — [date]`

**Body:**
```
Bet of the Day: [Team] [Bet Type] ([Odds]) — [XX%] confidence
Underdog of the Day: [Team] ML ([+Odds]) — [XX%] confidence
Top 3: [Pick 1] | [Pick 2] | [Pick 3]

Games analyzed: [N] | Eligible bets: [N]
Yesterday: [W-L] | 30-day: [W-L] | ROI: [+/-X units]

Full report: [Notion URL]
```

Note: The Gmail MCP supports draft creation only — after creating the draft, note "Draft created in Gmail — send manually or check inbox." in the terminal output.

---

## Hard Rules (Never Violate)

1. **Never recommend a bet at worse than -120 odds.** -121 and beyond are ineligible, period.
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
- **All games have heavy favorites (no -120 or better options):** Report "No eligible bets — all games feature heavy favorites today. Consider waiting."
- **compile_game_data.py fails entirely:** Attempt to re-run once. If fails again, proceed with manual web research for schedule data, note data limitations prominently.
- **Notion MCP tools fail:** Note the failure in output. Do not loop infinitely on retries.
