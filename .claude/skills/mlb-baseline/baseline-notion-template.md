# Baseline Notion Page Template

Use this template when creating the Season Baseline page in Notion (child of MLB Bot Dashboard).

**Page title:** `2026 MLB Season Baseline — [start_date] through [end_date]`

---

## Page Content Structure

### Callout Block (top of page)
> Research reference — not a betting report. Do not log picks from this page to the Picks Tracker.
> Updated: [date] | Games analyzed: [N] | Retroactive record: [W]-[L]-[P] ([win%])

---

### Executive Summary

[3-4 sentences covering:]
- What the early data says about model calibration
- Any structural edge patterns identified (or lack thereof — be honest about sample size)
- Top 1-2 early-season storylines worth watching
- One bold key finding sentence

---

### Retroactive Model Performance

| Metric | Value |
|---|---|
| Dates analyzed | [start] → [end] |
| Games analyzed | N |
| Retroactive picks | N |
| Overall record | W-L-P |
| Win rate | XX% |
| Expected win rate (avg confidence) | ~XX% |
| Calibration delta | +/-X% |

---

### Calibration by Confidence Bucket

| Bucket | Predicted Win% | Actual Win% | Sample (N) | Status |
|---|---|---|---|---|
| 80–95% | ~72% | XX% | N | [On track / Overconfident / Underconfident / Too small] |
| 70–79% | ~65% | XX% | N | ... |
| 60–69% | ~58% | XX% | N | ... |
| 50–59% | ~52% | XX% | N | ... |

**Calibration note:** [1-2 sentences. If all buckets have N<10, write: "Sample too small for calibration decisions — revisit after April 14."]

---

### Early-Season Team Signals

#### Teams Outperforming the Model
[Teams the model picked against but who won anyway — potential live value going forward]
- **[TEAM]:** [Retroactive record vs. them] — [1-sentence structural note, e.g., "Elite bullpen masked below-average SP stats; Pillar 3 may be underweighted for this club early."]

#### Teams Underperforming the Model
[Teams the model was confident in but who lost — may be overvalued in market]
- **[TEAM]:** [Note on trend — injury, lineup issues, or regression candidate]

#### Notable SP Performances (⚠️ Small Sample — <3 starts = noise)
- **[SP Name] ([TEAM]):** [N] starts, [ERA] ERA — [Hot / Cold / Velocity concern / Normal]
- [Repeat for any SP with ERA ≥5.00 or ≤1.50 through first 2+ starts]

---

### Pitching Depth Snapshot

*As of [end_date]. One line per team. Format: SP1 (ERA/starts), SP2 (ERA/starts), IL notes.*

**AL East**
- NYY: [SP1 name] ([ERA]/[N]st), [SP2 name] ([ERA]/[N]st)[, IL: [name] - [injury]]
- BOS: ...
- TBR: ...
- TOR: ...
- BAL: ...

**AL Central**
- CHW: ...
- CLE: ...
- DET: ...
- HOU: ...
- KCR: ...
- MIN: ...

**AL West**
- LAA: ...
- OAK: ...
- SEA: ...
- TEX: ...

**NL East**
- ATL: ...
- MIA: ...
- NYM: ...
- PHI: ...
- WSN: ...

**NL Central**
- CHC: ...
- CIN: ...
- MIL: ...
- PIT: ...
- STL: ...

**NL West**
- ARI: ...
- COL: ...
- LAD: ...
- SDP: ...
- SFG: ...

---

### Bullpen Workload Heatmap

| Team | Key Relievers Used (8 days) | Status |
|---|---|---|
| [TEAM] | [N] appearances for [closer/setup man] | ⚠️ Taxed |
| [TEAM] | Normal usage | Fresh |
[Include only teams with notable usage patterns — skip teams with normal loads]

---

### Structural Edge Signals

*Only report patterns with 5+ games. Below that threshold, write: "Insufficient sample — revisit after April 14."*

| Factor | Direction | Sample (N) | Win% | Note |
|---|---|---|---|---|
| Strong SP edge (Pillar 1 raw ≥+6) | Favored SP team | N | XX% | [Confirms / Weak signal] |
| Home field + favorable park (factor ≥103) | Home | N | XX% | ... |
| [Any other pattern with 5+ games] | ... | N | XX% | ... |

---

### Park Factor Verification

*Does early run scoring match expected ranges?*

| Venue | Park Factor | Avg Runs/Game (Week 1) | Expected Range | Status |
|---|---|---|---|---|
| Coors Field | 119 | X.X | 9.5–11 | [Confirming / Anomalous] |
| Oracle Park | 93 | X.X | 7–8.5 | ... |
[Include venues with 2+ games played]

---

### Early Market Observations

| Metric | Value | Note |
|---|---|---|
| Home team win rate | XX% (N games) | Baseline: ~54% historical |
| Favorite win rate | XX% (N games) | Baseline: ~60% historical |
| Totals: Over% | XX% (N games) | |
| Avg margin of victory | X.X runs | |
| Blowouts (5+ run margin) | N of N games (XX%) | |
| Games with -115 or better on one side | XX% of games | Sets expected daily eligible bet volume |

---

### Data Quality Assessment

| Tool | Status | Notes |
|---|---|---|
| compile_game_data.py | OK / N errors | [Any date-specific failures] |
| MLB Stats API (schedule) | OK | |
| MLB Stats API (final scores) | OK | |
| pybaseball (SP stats) | OK / N gaps | [Any missing pitcher profiles] |
| Open-Meteo (weather) | OK | |
| Notion MCP (page creation) | OK — this page | |

[If any tool showed errors: describe the failure mode and whether it affects data quality]

---

### Methodology Notes

- Retroactive analysis uses full 10-pillar protocol with two changes: no -115 odds gate; Pillar 8 = INSUFFICIENT_DATA for all games
- Lineups used are actual confirmed lineups — no ⚠️ LINEUP PENDING penalty applied
- Devil's advocate is abbreviated (2 sentences FOR/AGAINST) — sufficient for retroactive calibration
- Win/Loss assessed against the retroactive ML pick direction only
- Calibration adjustments to confidence-rubric.md should not be made until N≥10 per bucket
- **Update schedule:** Re-run `/mlb-baseline` after April 14 (3 weeks) and May 1 (full month). After May 1, this page's calibration data merges into the 30-day window tracked by `fetch_historical_results.py --days 30`
