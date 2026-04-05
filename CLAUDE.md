# MLB Betting Research Bot

You're operating inside the **WAT framework** (Workflows, Agents, Tools). Read `PreReqs copy/CLAUDE.md` for the full architecture reference.

## Active Skills

- `/mlb-picks` — Run daily MLB betting research and publish to Notion
  - Trigger phrases: "run today's picks", "generate MLB picks", "daily research", "what are today's bets"
  - Optional argument: date in YYYY-MM-DD format (defaults to today)
  - Output: Notion Daily Reports page + rows in Picks Tracker DB

## Hard Rules

- **Never recommend a bet at worse than -115 odds.** Odds of -116 or longer are ineligible. Only -115, -114, ..., -100, +100, +110, etc. qualify.
- Always run the full 10-pillar analysis — no shortcuts, no gut picks.
- Devil's advocate sections must cite at least 2 specific data points each. Token counterpoints are rejected.
- If lineups are unconfirmed, flag every affected pick with ⚠️ LINEUP PENDING.
- Confidence scores are calculated using the rubric in `.claude/skills/mlb-picks/confidence-rubric.md`, not estimated intuitively.
- Never create or overwrite workflow files without asking first.

## Architecture

```
Workflows:  workflows/daily-mlb-research.md   (master SOP)
Tools:      tools/                             (Python scripts for data fetching)
Temp data:  .tmp/game_data_YYYY-MM-DD.json    (regenerable, disposable)
Notion:     Daily Reports DB + Picks Tracker DB
```

## Data Sources

| Tool | Source | Auth |
|---|---|---|
| fetch_schedule.py | MLB Stats API (statsapi.mlb.com) | None |
| fetch_lineups.py | MLB Stats API | None |
| fetch_pitcher_stats.py | pybaseball (Baseball Savant / FanGraphs) | None |
| fetch_team_stats.py | pybaseball + MLB Stats API | None |
| fetch_odds.py | WebSearch (upgrade to Odds API later) | None / ODDS_API_KEY |
| fetch_weather.py | Open-Meteo API | None |
| fetch_park_factors.py | pybaseball (FanGraphs) | None |
| fetch_historical_results.py | Notion Picks Tracker DB | NOTION_TOKEN |
| compile_game_data.py | Orchestrates all above | — |

## API Keys (.env)

- `NOTION_TOKEN` — Notion integration token
- `NOTION_PICKS_DB_ID` — Picks Tracker database ID
- `NOTION_REPORTS_DB_ID` — Daily Reports database ID
- `ODDS_API_KEY` — The Odds API key (add when upgrading from WebSearch)

## Self-Learning Loop

Every morning run automatically:
1. Fetches yesterday's final scores from MLB Stats API
2. Updates prior day's "Pending" picks in Notion to Win/Loss/Push
3. Reads 30-60 day historical patterns from Picks Tracker
4. Uses those patterns to adjust confidence scores for today's picks
5. Publishes calibration notes in the Performance Context section

## Notion DB IDs

Once databases are created, update NOTION_PICKS_DB_ID and NOTION_REPORTS_DB_ID in `.env`.
