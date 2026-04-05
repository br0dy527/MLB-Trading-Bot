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
| Calibration adjustment (see history below) | variable |

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
| >80% | Qualifies for **Bet of the Day** |
| 70-80% | Strong bet — **Top 3 candidate** |
| 60-70% | Marginal Top 3 — include with caveat |
| 50-60% | **Best available for this game** — note low confidence explicitly |
| <50% | Recommend avoiding — flag as LEAN ONLY |

**If no pick reaches 80%:** Label the highest-confidence pick "Best Available (below threshold)" in the Bet of the Day slot. Never fabricate confidence.

**If no pick reaches 60%:** Still pick the best available per game but note low conviction across the board.

---

## Calibration History

This section tracks actual vs. predicted win rates. Update after every 10+ picks accumulate in a bucket.

### By Confidence Bucket

| Bucket | Predicted Win% | Actual Win% | Sample Size | Status |
|---|---|---|---|---|
| 80-95% | ~72% | — | 0 | No data yet |
| 70-79% | ~65% | — | 0 | No data yet |
| 60-69% | ~58% | — | 0 | No data yet |
| 50-59% | ~52% | — | 0 | No data yet |

*When actual win% deviates from predicted by >10% across 10+ picks, apply a calibration adjustment:*
- Overconfident (actual << predicted): subtract 5-8 from scores in that bucket
- Underconfident (actual >> predicted): add 3-5 to scores in that bucket

### By Bet Type

| Bet Type | Record | Win% | ROI |
|---|---|---|---|
| Bet of Day | — | — | — |
| Underdog | — | — | — |
| Top 3 | — | — | — |
| Game Pick | — | — | — |

### Structural Edges Detected

*Patterns with 15+ picks and >10% deviation from expectation. Update as patterns emerge.*

| Pattern | Win% | Sample | Adjustment Applied |
|---|---|---|---|
| (none yet) | — | — | — |

### Last Updated

Date: (not yet updated — season just started)
Note: Calibration tracking begins once 10+ picks per bucket accumulate.

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
