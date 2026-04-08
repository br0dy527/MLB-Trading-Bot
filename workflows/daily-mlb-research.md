# Daily MLB Research Workflow

## Objective

Produce the best MLB betting research possible for every game today, publish to Notion, and log all picks for self-improvement tracking. This workflow runs automatically via schedule and can also be triggered manually with `/mlb-picks`.

## When This Runs

- **12:30 PM ET daily** — Single daily run. Lineups confirmed, lines set, all news out. Runs via remote trigger `trig_012Q8Q6nwKNViKAm4T2kZPgf`.
- **Manual** — `/mlb-picks` or `/mlb-picks YYYY-MM-DD` at any time.

---

## Execution Sequence

### 1. Update yesterday's results
Run `python3 tools/fetch_historical_results.py --update`
This auto-resolves yesterday's Pending picks using MLB Stats API final scores and updates Notion.
Note the output — yesterday's record feeds into today's calibration context.

### 2. Load historical patterns
Run `python3 tools/fetch_historical_results.py --days 30`
Read the patterns, calibration data, and structural edges. These actively inform confidence scores.

### 3. Compile game data
Run `python3 tools/compile_game_data.py` (or with date argument)
Reads: MLB Stats API, pybaseball, Open-Meteo, park factor database.
Writes: `.tmp/game_data_[date].json`
Continue with partial data if any individual tool fails — never abort.

### 4. Fetch web data via 4 batched Tavily searches
Run exactly 4 searches — never per-game. This keeps daily usage to ~4 credits (~120/month on free plan).

| # | Query | What we extract |
|---|---|---|
| 1 | `"MLB moneyline run line over under odds all games today [DATE]"` | All lines, totals, open/current odds |
| 2 | `"MLB confirmed starting lineups all games today [DATE]"` | Lineup status, batting orders, confirmed starters |
| 3 | `"MLB injury report all teams today [DATE] scratches"` | Key absences, late scratches, IL moves |
| 4 | `"MLB line movement sharp money steam today [DATE]"` | Reverse line movement signals, sharp action |

Map each result back to the games in the JSON by team name. If a game cannot be matched (e.g. doubleheader confusion), note "Search data unavailable" for that game — do not run an extra search.

After mapping:
- Flag eligible bets (-120 or better) — all others ineligible, full stop
- Note reverse line movement (Pillar 8 signal)
- Apply -10 confidence if lineup is unconfirmed

### 5. Analyze every game
Apply the full 10-pillar analysis + devil's advocate protocol from:
`.claude/skills/mlb-picks/analysis-framework.md`
`.claude/skills/mlb-picks/confidence-rubric.md`

Do not skip games or abbreviate the protocol. Every game gets the same rigor.

### 6. Rank picks and select featured bets
- Bet of the Day: highest confidence eligible bet (>80%, or "Best Available" if none)
- Underdog of the Day: best underdog moneyline (+odds)
- Top 3: three highest confidence picks >60%
- All Games: one pick per game

### 7. Publish to Notion
Follow: `.claude/skills/mlb-picks/notion-templates.md`
- Create or update Daily Reports page
- Log all picks to Picks Tracker (with GameID for auto-resolution)
- Save page ID to `.tmp/report_ids_[date].json`

---

## Quality Standards

**Every pick must have:**
- A confidence score calculated from the rubric (not estimated)
- A Case FOR with ≥2 specific stat citations
- A Case AGAINST with ≥2 specific stat citations and ≥1 would-cause-a-bettor-to-pass concern
- A one-sentence verdict
- The GameID logged to Notion (enables automatic result tracking)

**No pick may:**
- Have odds worse than -115
- Be based on incomplete devil's advocate analysis
- Claim higher confidence than the rubric supports

---

## Self-Improvement Loop

The system learns automatically:

1. **Morning run updates yesterday's results** using MLB Stats API final scores
2. **Historical patterns feed into today's analysis** via fetch_historical_results output
3. **Confidence calibration is tracked** in `.claude/skills/mlb-picks/confidence-rubric.md`
4. **Structural edges** (15+ picks, >10% deviation) are flagged and recommended for rubric encoding
5. **Daily Reports pages** serve as an audit trail — the agent reads prior pages to diagnose missed calls

When the confidence-rubric.md calibration table shows consistent deviation (actual win% vs. predicted win% off by >10% for a given bucket), the user should instruct the agent to update the rubric adjustments.

---

## Error Handling

| Error | Response |
|---|---|
| MLB Stats API down | Use WebSearch for schedule. Note gap in report. |
| pybaseball fails | Use MLB Stats API season stats as fallback. Note missing advanced metrics. |
| Weather API fails | Note "Weather data unavailable." Skip weather pillar (NEUTRAL). |
| Odds search returns no results | Note "Odds data unavailable for this game." Cannot make pick without odds. |
| Notion MCP fails | Output report to terminal. Retry once. Do not loop. |
| Lineups not confirmed | Flag all picks ⚠️ LINEUP PENDING. Reduce confidence by -10. |
| No games today | Output "No games scheduled." Do not create Notion page. |

---

## Key File Locations

```
Game data:         .tmp/game_data_YYYY-MM-DD.json
Report IDs:        .tmp/report_ids_YYYY-MM-DD.json
Analysis rules:    .claude/skills/mlb-picks/analysis-framework.md
Confidence rubric: .claude/skills/mlb-picks/confidence-rubric.md
Notion templates:  .claude/skills/mlb-picks/notion-templates.md
Main skill:        .claude/skills/mlb-picks/SKILL.md
This workflow:     workflows/daily-mlb-research.md

Notion Picks Tracker DS:  collection://427c1e0d-e97f-4e3f-9421-59fbe0831072
Notion Daily Reports DS:  collection://052dd723-1747-47c8-ada7-a0647ed241a2
```

---

## Notes and Lessons Learned

*Update this section when you discover rate limits, data quirks, or process improvements.*

- **pybaseball cache:** Always runs `pybaseball.cache.enable()` — first run slow, subsequent fast.
- **Tavily search budget:** 4 searches per daily run = ~120/month. Free plan limit is 1,000/month. Never search per-game — always batch all games into one query per category.
- **Odds API:** Not yet active. Using Tavily batched search for odds. Upgrade path: swap Tavily odds query for Odds API when ready.
- **MLB Stats API lineups:** Confirmed lineups available ~3 hours before first pitch. Morning run (9:30 AM) will often have probables only.
- **Coors Field:** Always add context about altitude. Park factor 119 — every total should be adjusted +1.5-2 runs vs. neutral park baseline.
- **Season start:** Early April data (first 1-2 weeks) has very small samples. Weight recent trends heavily but flag small sample sizes explicitly.
