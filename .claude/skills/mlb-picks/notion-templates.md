# Notion Report Templates

## Notion Database IDs

```
MLB Betting Bot page:  33810928-6062-81d9-ba16-ec3354f73493
Picks Tracker DB:      8b68224c3b8b4021b8c0efb77ecf0d16
Picks Tracker DS:      collection://427c1e0d-e97f-4e3f-9421-59fbe0831072
Daily Reports DB:      ca0b9c53813a47c48ecae6ec95330cab
Daily Reports DS:      collection://052dd723-1747-47c8-ada7-a0647ed241a2
```

---

## Step 1: Create the Daily Report Page

Create a page in the Daily Reports database using `notion-create-pages` with parent `data_source_id: 052dd723-1747-47c8-ada7-a0647ed241a2`.

### Properties to set:

```json
{
  "Date": "[Day of Week, Month DD, YYYY]",
  "Bet of Day": "[Team] [Bet Type] ([Odds])",
  "BOTD Confidence": [number 0-100],
  "BOTD Result": "Pending",
  "Underdog of Day": "[Team] ML ([+Odds])",
  "UOTD Result": "Pending",
  "Top 3 Record": "0-0 (Pending)",
  "Total Picks": [number of featured picks],
  "Lineups Confirmed": true,
  "Games Analyzed": [number of games]
}
```

### Page Content (Notion Markdown):

```markdown
## Bet of the Day
**[Team] [Bet Type] ([Odds])** | Confidence: **[XX%]**

**Case FOR:**
[3-5 sentences with specific stats. Cite at least 2 numbers.]

**Case AGAINST:**
[3-5 sentences with specific stats. Cite at least 2 numbers.]

**Verdict:** [One sentence — why FOR outweighs AGAINST, or why AGAINST wins.]

**Key Stats:**
- [Away SP]: ERA [X.XX] | FIP [X.XX] | WHIP [X.XX] | Last 5 starts: [ERA] — [trend]
- [Home SP]: ERA [X.XX] | FIP [X.XX] | WHIP [X.XX] | Last 5 starts: [ERA] — [trend]
- Opposing lineup vs. [hand]HP: [OPS or splits note]
- Line movement: Opened [X] → Current [X] ([signal])
- Weather: [wind effect or dome note]

---

## Underdog of the Day
**[Team] ML ([+Odds])** — Implied probability: [XX%] | Confidence: **[XX%]**

**Why this underdog has value:**
[2-3 sentences on what the market may be overlooking.]

**Case FOR:**
[3-4 sentences with specific stats.]

**Case AGAINST:**
[3-4 sentences with specific stats.]

**Verdict:** [One sentence.]

---

## Top 3 Bets

### Pick 1: [Team] [Bet Type] ([Odds]) | Confidence: [XX%]

**For:** [2-3 sentences with stats]

**Against:** [2-3 sentences with stats]

**Verdict:** [One sentence]

---

### Pick 2: [Team] [Bet Type] ([Odds]) | Confidence: [XX%]

**For:** [2-3 sentences with stats]

**Against:** [2-3 sentences with stats]

**Verdict:** [One sentence]

---

### Pick 3: [Team] [Bet Type] ([Odds]) | Confidence: [XX%]

**For:** [2-3 sentences with stats]

**Against:** [2-3 sentences with stats]

**Verdict:** [One sentence]

---

## All Games

(One entry per game. Use a simple list — no toggle blocks needed.)

### [Away] @ [Home] — [Time ET]
**Pick:** [Team] [Bet Type] ([Odds]) | Confidence: [XX%]
**For:** [One sentence with 1-2 stats]
**Against:** [One sentence with 1-2 stats]
[If no eligible bet: "**No eligible bet** — all lines exceed -115 threshold."]

(Repeat for each game)

---

## Yesterday's Scorecard

| Category | Pick | Result |
|---|---|---|
| Bet of the Day | [pick] | [Win/Loss/Push] |
| Underdog of Day | [pick] | [Win/Loss/Push] |
| Top 3 | — | [W]-[L]-[P] ([Win%]) |
| 30-Day Running | — | [W]-[L] ([Win%]) · ROI: [+/-X units] |
| **Overall (Season)** | — | **[W]-[L] ([Win%]) · [+/-X units]** |

---

## Performance Context

[Paste `narrative` field from calibration_adjustments.json here verbatim.]

**Last 30 days:** [W]-[L] overall | ROI: [+/-X.X] units
**Bet of Day record:** [W]-[L] [adj: X] | **Underdog record:** [W]-[L] [adj: X] | **Top 3 record:** [W]-[L] [adj: X]

**Calibration applied today:**
- 80-95% bucket: [actual win%] vs [predicted win%] → adjustment [+/-X pts]
- 70-79% bucket: [actual win%] vs [predicted win%] → adjustment [+/-X pts]
- 60-69% bucket: [actual win%] vs [predicted win%] → adjustment [+/-X pts]
- Global fallback: [+/-X pts] (used when bucket has <5 picks)

**Patterns flagged:** [From `patterns` field in calibration JSON, or "None detected yet."]

---

## Data Notes

- **Lineup status:** [Confirmed / Pending for [N] games]
- **Injury flags:** [List key absences or "None flagged"]
- **Weather alerts:** [Any significant conditions, or "No weather concerns"]
- **Data gaps:** [Any tools that failed or returned partial data, or "All data sources returned successfully"]
- **Odds source:** [WebSearch / Odds API]
```

---

## Step 2: Save Report Page ID

After creating the report page, save its Notion page ID to `.tmp/report_ids_YYYY-MM-DD.json`:

```json
{
  "date": "2026-04-03",
  "report_page_id": "[returned page ID]",
  "report_url": "[returned URL]",
  "created_at": "[ISO timestamp]",
  "lineups_confirmed": false
}
```

---

## Step 3: Log Each Pick to Picks Tracker

For every pick (Bet of Day, Underdog, Top 3, and all game picks), create a row in the Picks Tracker using `notion-create-pages` with parent `data_source_id: 427c1e0d-e97f-4e3f-9421-59fbe0831072`.

### Properties per pick:

```json
{
  "Matchup": "[Away Abbr] @ [Home Abbr]",
  "date:Date:start": "YYYY-MM-DD",
  "Pick": "[Team] [Bet Type] ([Odds])",
  "Bet Type": ["Bet of Day", "Top 3"],   // multi-select — every applicable tag. A pick can be both BOTD and Top 3, or both Underdog and Top 3. Use ["Game Pick"] only if no featured category applies.
  "Odds": [integer American odds, e.g. -108 or 145],
  "Implied Prob %": [float, e.g. 51.9],
  "Confidence": [integer 0-100],
  "Result": "Pending",
  "SP Matchup Rating": "[Strong | Neutral | Weak]",
  "Home Team": "[full team name]",
  "Away Team": "[full team name]",
  "GameID": [integer game_id from schedule],
  "Notes": "[1-2 sentence summary of key reasoning]",
  "Report Link": "[URL of the daily report page]"
}
```

**SP Matchup Rating guidelines:**
- Strong: One SP has FIP advantage ≥0.75 and favorable handedness splits
- Weak: SP is on short rest, declining form, or has poor splits vs. opposing lineup
- Neutral: All other cases

## Step 4: Update Yesterday's Results

At the start of each daily run, before doing anything else:

1. Run `python3 tools/fetch_historical_results.py --update --date [yesterday]`
2. The script queries Notion for Pending picks and resolves them using final scores from MLB Stats API
3. Update yesterday's Daily Reports DB entry: set BOTD Result, UOTD Result, Top 3 Record based on resolved picks

This ensures yesterday's performance data is in Notion before today's picks are made.
