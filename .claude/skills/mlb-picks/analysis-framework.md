# MLB Betting Analysis Framework

## The 10-Pillar Protocol

Complete ALL 10 pillars before forming any pick direction. Do not let an early impression bias later pillars. After all pillars, tally weighted signals — let the math lead.

For each pillar, assign:
- Direction: **HOME** / **AWAY** / **NEUTRAL** / **INSUFFICIENT_DATA**
- Weight as shown below

---

### Pillar 1 — Starting Pitcher Matchup (Weight: 3)

Compare the two SPs head-to-head on:
- ERA, FIP, xFIP (FIP/xFIP preferred as ERA can be luck-driven)
- WHIP (threshold: ≤1.19 = elite, 1.20-1.49 = average, ≥1.50 = trouble)
- K/9 (strikeout ability to limit rally potential)
- Recent form: last 5 starts trend (improving / declining / volatile)
- Pitch velocity vs. prior season (drop of 1-2 mph = flag for injury/fatigue)

Signal: Which SP has a meaningful edge? Is one clearly superior? Or are they similar?

**Flag conditions:**
- SP not yet announced → INSUFFICIENT_DATA, confidence -10
- SP on short rest (≤4 days) → note in analysis, confidence -7 when factored in
- SP coming off poor start (5+ ER) → weight recent trend more heavily than season ERA

---

### Pillar 2 — Lineup Handedness Splits (Weight: 3)

- Count the away and home lineup's LHB% vs. RHB% (from lineup handedness breakdown in data)
- Apply each SP's vs-LHB and vs-RHB ERA/OPS splits to the opposing lineup composition
- Example: SP has 3.20 ERA vs. RHB and 1.85 ERA vs. LHB → if opposing lineup is 70% RHB, that's a weak spot
- Check if top 3 lineup spots (table setters) favor or disadvantage the SP

Signal: Does the lineup handedness create an exploitable mismatch?

**Key stat to cite:** SP's ERA/OPS vs. dominant batter handedness in opposing lineup.

---

### Pillar 3 — Bullpen Quality and Availability (Weight: 2)

- Compare team bullpen ERA (season and last 7 days if available)
- Check games back-to-back: if team played yesterday, key relievers may be unavailable
- Series game number: Game 3+ = bullpen more depleted
- Saves and blown saves: save% below 70% = unreliable closer, affects high-leverage situations
- Note if either team's closer has been overworked (3+ appearances in last 5 days)

Signal: Which team has the stronger and fresher bullpen?

**This matters most for:** Full-game ML bets where the starter is expected to go ≤5 innings.

---

### Pillar 4 — Home/Away Record and Park Context (Weight: 1)

- Home team's home W-L this season (and home win%)
- Away team's road W-L this season (and road win%)
- Park factor: run_factor >102 = hitter-friendly, <97 = pitcher-friendly
- Any park-specific quirks (Crawford Boxes, Green Monster, Coors altitude, etc.) that create asymmetric advantages

Signal: Does home field advantage or park factor meaningfully favor one side?

---

### Pillar 5 — Recent Form and Momentum (Weight: 2)

- Last 10 games record for both teams
- Run differential in last 10 (positive = scoring margin, negative = getting outscored)
- Active streak (win or loss) and its length
- Whether streak is driven by schedule strength or genuine momentum
  - Easy schedule streak = less meaningful
  - Streak built against .500+ teams = more meaningful

Signal: Is one team noticeably hot or cold, and is that momentum sustainable today?

---

### Pillar 6 — Environmental Factors (Weight: 1)

Use weather data from game JSON:
- Temperature: <45°F suppresses ball carry (pitcher-friendly), >80°F slight offense boost
- Wind: Use `wind_effect` field from fetch_weather output
  - `strong_wind_blowing_out_offense` → +1 to 1.5 runs on total
  - `strong_wind_blowing_in_pitching` → -1 to 1.5 runs on total
  - `dome_weather_irrelevant` → skip this pillar, mark NEUTRAL
- Humidity: high humidity (>75%) in warm weather slightly suppresses ball flight
- Coors Field: always note altitude factor, inflate any total by 1.5-2 runs vs. neutral park

Signal: Does weather/environment meaningfully tilt toward offense or pitching today?

---

### Pillar 7 — Travel and Fatigue (Weight: 1)

- Day game after night game (DGNG): road team at disadvantage — note explicitly
- Series game number: Game 3+ of an away series = accumulated fatigue
- Cross-country travel (3+ timezone shift): particularly affects West Coast teams playing East or vice versa
- Check if either team had a travel day yesterday (off day but cross-country flight)

Signal: Is one team clearly more fatigued or disadvantaged by travel today?

---

### Pillar 8 — Reverse Line Movement / Sharp Money (Weight: 2)

Use `home_line_movement` field and odds data:
- If line moved SHORTER (favorite more expensive) despite heavy public on other side → sharps backing favorite
- If line moved LONGER (underdog getting cheaper) despite public on favorite → sharps on underdog
- `sharp_for` = sharp signal supports the pick you're evaluating
- `sharp_against` = sharp signal opposes the pick
- `insufficient_data` = no opening line data, mark NEUTRAL

**The most reliable edge signal.** Reverse line movement on totals is especially clean.

Signal: Is smart money aligned with or against this pick?

---

### Pillar 9 — Game Importance and Motivation (Weight: 1)

- Division race: How many games back is each team? (teams within 2 games of first treat this like a playoff game)
- Series context: rubber game (deciding game of series) = higher intensity
- Rivalry games tend to be tighter and harder to predict
- Meaningless late-September games for teams out of contention = motivation risk (confidence -8 in that scenario)
- Teams playing "lookahead" game (marquee series starts tomorrow) = potential lack of focus

Signal: Does game importance create an edge for one side?

---

### Pillar 10 — Historical Head-to-Head (Weight: 1)

- SP's career stats vs. this specific team (ERA, K rate from pitcher profile if available)
- Head-to-head team records over last 2 seasons (from historical data or search)
- Recent series results: last 5 meetings between these teams

Signal: Is there a meaningful pattern in how these teams/pitchers match up historically?

---

## Pillar Scoring

After completing all 10 pillars:

```
For each pillar:
  HOME advantage + Weight 3 → +9 pts
  HOME advantage + Weight 2 → +6 pts
  HOME advantage + Weight 1 → +3 pts
  NEUTRAL or INSUFFICIENT_DATA → 0 pts
  AWAY advantage + Weight 1 → -3 pts (from home perspective)
  AWAY advantage + Weight 2 → -6 pts
  AWAY advantage + Weight 3 → -9 pts
```

If evaluating the AWAY team's bet, flip the sign convention.

Raw score range: -51 to +51
Normalize: `base_confidence = 50 + (raw_score / 51) * 40` → maps to 10-90 range

---

## Devil's Advocate Protocol (MANDATORY)

After scoring all pillars, execute this three-phase structured debate. Do not skip or abbreviate.

### Phase 1: Build the CASE FOR

Write 3-5 sentences identifying the 2-3 strongest pillars supporting this pick.

**Specificity requirement:** Cite at least 2 specific data points (actual numbers from the game data).

Example format:
> "The case FOR [Team] ML rests primarily on a dominant pitcher matchup. [SP Name] carries a 2.31 FIP over his last 5 starts and the opposing lineup is 74% right-handed — a favorable split as [SP Name] holds RHB to a .237 OPS this season. Additionally, reverse line movement supports this pick: the line moved from -108 to -115 despite 68% of public tickets on the opponent, signaling professional money on [Team]."

### Phase 2: Build the CASE AGAINST

Write 3-5 sentences identifying the 2-3 most credible reasons the pick fails.

**Specificity requirement:** Cite at least 2 specific data points. Include at least one point that, if true, would cause a reasonable bettor to pass entirely.

**Anti-rubber-stamp rule:** Statements like "the other team could hit well today" are insufficient. The counterargument must be specific and grounded in data.

Example format:
> "The case AGAINST centers on two credible threats. First, [Home Team]'s bullpen has a 6.12 ERA over the last 7 days, and [SP Name] has averaged only 4.2 IP in his last 3 starts — meaning the bullpen will likely be needed by the 5th inning at the latest. Second, Coors Field's run factor of 119 inflates all offensive numbers, and [SP Name]'s 1.89 HR/9 rate becomes particularly dangerous at altitude."

### Phase 3: Render the Verdict

One sentence. State which case wins and why.

Format: `"The case FOR outweighs the case AGAINST because [single reason]."` OR `"The case AGAINST is too compelling despite [the main supporting argument] — pass on this bet."`

---

## Auto-Cap Rules

These conditions automatically cap confidence regardless of pillar scores:

| Condition | Cap |
|---|---|
| Case AGAINST cites fewer than 2 specific data points | 65% |
| SP not announced for either team | 60% |
| Lineup unconfirmed AND game within 4 hours | 65% |
| Odds data unavailable (no WebSearch result found) | Cannot pick — flag as ineligible |

---

## Bet Type Selection

For each game, evaluate which eligible bet type has the strongest edge:

- **Moneyline (ML)**: Best when you have strong conviction on overall outcome. Eligible at -120 or better.
- **Run Line -1.5**: Better value than heavy ML favorites. Use when dominant team + weak bullpen on other side. Usually +110 to +140 for favorites.
- **Run Line +1.5**: For underdogs — covers even if they lose by 1. Strong value in pitcher's duels.
- **Over/Under**: Evaluate for EVERY game. Use when weather/park factor creates a clear edge. Wind blowing out + Coors = heavy over lean. Strong pitching matchup both sides + dome = under candidate. Always note the total line and over/under odds in your analysis.
- **First 5 Innings (F5)**: Isolates starting pitchers, removes bullpen variance. Not always available — check if odds provided.

**The -120 rule is absolute.** If the only viable bet for a game is -121 or worse, log "No eligible bet" for that game.
