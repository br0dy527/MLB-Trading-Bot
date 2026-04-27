# Confidence Scoring Rubric

## Overview

Confidence is scored 0-100 using a two-step process: base score from 10-pillar analysis, then qualitative adjustments. Never assign 95+ — no bet in baseball is that certain.

**Calibration history** is tracked at the bottom of this file. Update it weekly as results come in.

---

## Step 1: Base Score from Pillars

See analysis-framework.md for pillar directions and weights.

```
raw_score = sum of all pillar signals (range: -51 to +51)
base_confidence = 50 + (raw_score / 51) * 40
```

This maps:
- Raw +51 (all pillars heavily favor pick) → base 90
- Raw 0 (perfectly balanced) → base 50
- Raw -51 (all pillars against) → base 10

---

## Step 2: Qualitative Adjustments

Apply each relevant adjustment to the base score:

| Condition | Adjustment |
|---|---|
| Reverse line movement supports pick (sharp_for signal) | +8 |
| Reverse line movement opposes pick (sharp_against signal) | -8 |
| Strong weather/park factor directly supports pick | +5 |
| Park factor moderately supports pick | +3 |
| Lineup not confirmed at time of analysis | -10 |
| Key player injured (starting pitcher, cleanup hitter, ace closer) | -8 |
| SP on short rest (≤4 days) | -7 |
| Heavy public on same side as pick (possible square trap) | -5 |
| Day game after night game (road team disadvantage) | -5 |
| Series game 3+ (bullpen depletion risk) | -3 |
| H2H historically strong (>60% win rate, ≥10 meetings) | +5 |
| H2H historically weak (<40% win rate, ≥10 meetings) | -5 |
| Pitcher career ERA vs. this team is notably better than season avg | +4 |
| Pitcher career ERA vs. this team is notably worse than season avg | -4 |
| Meaningless late-season game (eliminated team) | -8 |
| Playoff race rubber game (high motivation) | +3 |
| Calibration adjustment (from `.tmp/calibration_adjustments.json`) | bucket_adj + type_adj, capped at -25 combined |

**Final score:** `confidence = clamp(base + sum(adjustments), 10, 95)`

---

## Step 3: Apply Auto-Caps (from analysis-framework.md)

After computing final score, apply caps if conditions are met:
- Case AGAINST cites <2 specific data points → cap at 65
- SP unannounced for either team → cap at 60
- Lineup unconfirmed AND game <4 hours away → cap at 65

---

## Thresholds for Pick Classification

| Confidence | Classification |
|---|---|
| ≥80% | Strong **Bet of the Day** candidate — high conviction |
| 65-79% | Solid **Top 3 candidate** |
| 50-64% | **Eligible for BOTD / Top 3** — note conviction level explicitly |
| <50% | Ineligible for BOTD / Top 3 — flag as LEAN ONLY in All Games |

**Eligibility floor:** BOTD and Top 3 require ≥50% final confidence. UOTD has no confidence floor — it picks the best positive-odds bet regardless.

**If no pick reaches 50%:** Report no BOTD / Top 3 today. Continue with one pick per game in All Games. Never fabricate confidence to clear the floor.

---

## Calibration History

This section tracks actual vs. predicted win rates. Update after every 10+ picks accumulate in a bucket.

**These tables are auto-managed by `tools/update_calibration.py`. Do not edit manually.**
Numeric adjustments are the canonical source in `.tmp/calibration_adjustments.json`.

### By Confidence Bucket

<!-- AUTO:BUCKET_TABLE_START -->
| Bucket | Predicted Win% | Actual Win% | Sample | Adjustment | Status |
|---|---|---|---|---|---|
| 80-95% | ~72.0% | — | 0 | 0 | Insufficient data (0 picks, need 5) |
| 70-79% | ~65.0% | 40.0% | 5 | -15 | Overconfident by 25.0 pts |
| 60-69% | ~58.0% | 14.3% | 7 | -20 | Overconfident by 43.7 pts |
| 50-59% | ~52.0% | 16.7% | 6 | -20 | Overconfident by 35.3 pts |
<!-- AUTO:BUCKET_TABLE_END -->

### By Bet Type

<!-- AUTO:TYPE_TABLE_START -->
| Bet Type | Record | Win% | ROI (units) | Adjustment |
|---|---|---|---|---|
| Bet of Day | 1-1 | 50.0% | -0.15 | 0 |
| Underdog | 0-1 | 0.0% | -1.0 | 0 |
| Top 3 | 3-1 | 75.0% | 1.67 | 0 |
| Game Pick | 2-12 | 14.3% | -10.2 | -10 |
<!-- AUTO:TYPE_TABLE_END -->

### Bet Subtype Performance (ML vs RL vs Over vs Under)

<!-- AUTO:SUBTYPE_TABLE_START -->
| Subtype | Record | Win% | ROI (units) | Adjustment |
|---|---|---|---|---|
| ML | — | — | — | 0 |
| RL-1.5 | — | — | — | 0 |
| RL+1.5 | — | — | — | 0 |
| Over | — | — | — | 0 |
| Under | — | — | — | 0 |
<!-- AUTO:SUBTYPE_TABLE_END -->

### Structural Edges Detected

*Patterns with 15+ picks and >10% deviation from expectation. Populated automatically.*

### Last Updated

<!-- AUTO:LAST_UPDATED_START -->
Date: 2026-04-08 (auto-updated by update_calibration.py)

Summary: Overall last 21 resolved picks: 6-15 (28.6% win rate). Largest deviation: 60-69% confidence bucket is overconfident by 43.7 pts (actual 14.3% vs predicted 58.0%). Game Pick picks are underperforming at 14.3% win rate (adjustment: -10). Global fallback adjustment: -8.0 pts.

Global fallback adjustment: -8.0 pts

Patterns flagged:
- Game Pick: 14.3% win rate (14 picks) — WEAK AREA, reduce confidence
- Strong: 28.6% win rate (14 picks) — WEAK AREA, reduce confidence
<!-- AUTO:LAST_UPDATED_END -->

---

## Example Calculation

**Game:** Yankees (-108 ML) vs. Red Sox

**Pillar signals (from HOME = Yankees perspective):**
- P1 Starting Pitcher: Yankees SP (FIP 3.12) vs. Red Sox SP (FIP 4.87) → HOME +9
- P2 Lineup Splits: Yankees SP has 2.11 ERA vs. LHB; Red Sox lineup 65% LHB → HOME -9 (unfavorable)
- P3 Bullpen: Yankees bullpen 2.94 ERA vs. Red Sox 4.87 → HOME +6
- P4 Home/Away: Yankees 8-3 at home, Red Sox 5-7 on road → HOME +3
- P5 Recent Form: Yankees last 10: 7-3, Red Sox last 10: 4-6 → HOME +6
- P6 Weather: Wind blowing in from CF at 14 mph → NEUTRAL (suppresses both)
- P7 Travel: Red Sox no travel issues → NEUTRAL
- P8 Line Movement: Opened -105, now -108, 55% public on Yankees → `no_movement` → NEUTRAL
- P9 Game Importance: Both in playoff race, series game 2 → NEUTRAL
- P10 H2H: Yankees 6-4 vs. Red Sox last 2 seasons → HOME +3

**Raw score:** 9 - 9 + 6 + 3 + 6 + 0 + 0 + 0 + 0 + 3 = **+18**
**Base confidence:** 50 + (18/51)*40 = 50 + 14.1 = **64.1**

**Adjustments:**
- Yankees ML at -108 → odds eligible ✓
- Lineup confirmed → no penalty
- No sharp signal → no adjustment
- No weather edge → no adjustment

**Final confidence: 64** → Marginal Top 3 candidate (note: LHB matchup is the key risk)
