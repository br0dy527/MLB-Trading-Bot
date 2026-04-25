// Shared helpers used by both the legacy mlb-analyze task and the new
// green-analyst / aggregator path. Keeping these in one place so both
// implementations stay aligned (output schema, performance context, report
// markdown, odds math).

import type { PickDetail } from "./notion.js";

// ─── Types for Claude's structured output ────────────────────────────────────

export interface PillarResult {
  direction: "HOME" | "AWAY" | "NEUTRAL" | "INSUFFICIENT_DATA";
  notes: string;
}

export interface GamePickResult {
  gameId: number;
  matchup: string;
  homeTeam: string;
  awayTeam: string;
  venue: string;
  pickTeam: string;
  betType: "ML" | "RL_MINUS_1_5" | "RL_PLUS_1_5" | "OVER" | "UNDER";
  pickDescription: string;
  odds: number;
  eligible: boolean;
  noEligibleBet: boolean;
  noEligibleBetReason: string | null;
  pillars: {
    p1_sp_matchup: PillarResult;
    p2_lineup_splits: PillarResult;
    p3_bullpen: PillarResult;
    p4_home_away: PillarResult;
    p5_form: PillarResult;
    p6_weather: PillarResult;
    p7_travel: PillarResult;
    p8_line_movement: PillarResult;
    p9_motivation: PillarResult;
    p10_h2h: PillarResult;
  };
  rawScore: number;
  baseConfidence: number;
  adjustments: Array<{ reason: string; delta: number }>;
  finalConfidence: number;
  caseFor: string;
  caseAgainst: string;
  verdict: string;
  lineupPending: boolean;
  spMatchupRating: "Strong" | "Neutral" | "Weak";
  notes: string;
}

// ─── Implied probability from American odds ─────────────────────────────────

export function impliedProb(odds: number): number {
  if (odds < 0) return Math.abs(odds) / (Math.abs(odds) + 100) * 100;
  return 100 / (odds + 100) * 100;
}

// ─── Performance analysis context for self-learning loop ────────────────────

export function buildPerformanceContext(picks: PickDetail[]): string {
  if (picks.length < 3) {
    return "Insufficient historical data for calibration (fewer than 3 resolved picks). Apply default rubric weights.";
  }

  const resolved = picks.filter(p => p.result !== "Push");
  const wins = resolved.filter(p => p.result === "Win");
  const losses = resolved.filter(p => p.result === "Loss");
  const pushes = picks.filter(p => p.result === "Push");

  const winRate = resolved.length > 0 ? wins.length / resolved.length : 0;
  const avgImplied = resolved.length > 0
    ? resolved.reduce((s, p) => s + p.impliedProbPct, 0) / resolved.length / 100
    : 0;
  const edge = Math.round((winRate - avgImplied) * 1000) / 10;

  const stat = (bucket: PickDetail[]) => {
    if (bucket.length === 0) return "no data";
    const w = bucket.filter(p => p.result === "Win").length;
    const l = bucket.filter(p => p.result === "Loss").length;
    const pct = (w + l) > 0 ? Math.round(w / (w + l) * 100) : 0;
    return `${w}W-${l}L (${pct}%)`;
  };

  const highConf  = resolved.filter(p => p.confidence >= 75);
  const medConf   = resolved.filter(p => p.confidence >= 60 && p.confidence < 75);
  const lowConf   = resolved.filter(p => p.confidence < 60);
  const avgPredicted = (bucket: PickDetail[]) =>
    bucket.length > 0 ? Math.round(bucket.reduce((s, p) => s + p.confidence, 0) / bucket.length) : 0;

  const spStrong  = resolved.filter(p => p.spMatchupRating === "Strong");
  const spNeutral = resolved.filter(p => p.spMatchupRating === "Neutral");
  const spWeak    = resolved.filter(p => p.spMatchupRating === "Weak");

  const byBetType = (type: string) => resolved.filter(p => p.betTypes.includes(type));

  const heavyFav  = resolved.filter(p => p.odds <= -115);
  const lightFav  = resolved.filter(p => p.odds > -115 && p.odds < 0);
  const pickEm    = resolved.filter(p => p.odds >= 0 && p.odds <= 110);
  const dogs      = resolved.filter(p => p.odds > 110);

  const homePicks = resolved.filter(p => {
    const homeAbbr = (p.matchup.split(" @ ")[1] ?? "").trim().toLowerCase();
    return homeAbbr && p.pick.toLowerCase().includes(homeAbbr);
  });
  const awayPicks = resolved.filter(p => {
    const awayAbbr = (p.matchup.split(" @ ")[0] ?? "").trim().toLowerCase();
    return awayAbbr && p.pick.toLowerCase().includes(awayAbbr);
  });

  const last10  = [...resolved].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
  const l10W    = last10.filter(p => p.result === "Win").length;
  const streakDir = l10W >= 6 ? "HOT" : l10W <= 4 ? "COLD" : "NEUTRAL";

  const recentLosses = [...losses]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5)
    .map(p => `  • ${p.date} ${p.matchup} | ${p.pick} | SP:${p.spMatchupRating} | Conf:${p.confidence}% | ${p.notes.slice(0, 200)}`);

  const avgOddsROI = resolved.length > 0
    ? resolved.reduce((sum, p) => {
        const payout = p.odds >= 0 ? p.odds / 100 : 100 / Math.abs(p.odds);
        return sum + (p.result === "Win" ? payout : -1);
      }, 0)
    : 0;
  const roiPct = resolved.length > 0 ? Math.round(avgOddsROI / resolved.length * 100) : 0;

  const mlBets    = resolved.filter(p => /\bml\b/i.test(p.pick) && !/\bover\b|\bunder\b/i.test(p.pick));
  const rlMinus   = resolved.filter(p => /-1\.5/.test(p.pick));
  const rlPlus    = resolved.filter(p => /\+1\.5/.test(p.pick));
  const overBets  = resolved.filter(p => /\bover\b/i.test(p.pick));
  const underBets = resolved.filter(p => /\bunder\b/i.test(p.pick));

  const lines = [
    `**Period:** Last ${picks.length} resolved picks (${wins.length}W-${losses.length}L-${pushes.length}P)`,
    `**Win rate:** ${Math.round(winRate * 100)}% | **Avg implied prob:** ${Math.round(avgImplied * 100)}% | **Edge vs market:** ${edge > 0 ? "+" : ""}${edge}%`,
    `**Estimated ROI per pick:** ${roiPct > 0 ? "+" : ""}${roiPct}%`,
    ``,
    `**Confidence Calibration (predicted → actual):**`,
    `- High ≥75% (avg ${avgPredicted(highConf)}% predicted): ${stat(highConf)}`,
    `- Medium 60-74% (avg ${avgPredicted(medConf)}% predicted): ${stat(medConf)}`,
    `- Low <60% (avg ${avgPredicted(lowConf)}% predicted): ${stat(lowConf)}`,
    ``,
    `**Starting Pitcher Edge (P1) Accuracy:**`,
    `- Strong SP advantage: ${stat(spStrong)}`,
    `- Neutral SP matchup: ${stat(spNeutral)}`,
    `- Weak SP matchup: ${stat(spWeak)}`,
    ``,
    `**Bet Type Performance:**`,
    `- Bet of Day: ${stat(byBetType("Bet of Day"))}`,
    `- Underdog of Day: ${stat(byBetType("Underdog"))}`,
    `- Top 3: ${stat(byBetType("Top 3"))}`,
    `- Game Pick: ${stat(byBetType("Game Pick"))}`,
    ``,
    `**Odds Range Performance:**`,
    `- Heavy favorite (≤-115): ${stat(heavyFav)}`,
    `- Light favorite (-114 to -100): ${stat(lightFav)}`,
    `- Pick'em (±110): ${stat(pickEm)}`,
    `- Underdog (>+110): ${stat(dogs)}`,
    ``,
    `**Home vs Away Lean:**`,
    `- Picking home team: ${stat(homePicks)}`,
    `- Picking away team: ${stat(awayPicks)}`,
    ``,
    `**Recent Streak:** Last 10 resolved: ${l10W}W-${10 - l10W}L → ${streakDir}`,
    ``,
    `**Bet Subtype Performance (ML vs RL vs Totals):**`,
    `- Moneyline bets: ${stat(mlBets)}`,
    `- Run Line -1.5: ${stat(rlMinus)}`,
    `- Run Line +1.5: ${stat(rlPlus)}`,
    `- Over bets: ${stat(overBets)}`,
    `- Under bets: ${stat(underBets)}`,
    ``,
    `**Last 5 Losses (pattern analysis):**`,
    recentLosses.length > 0 ? recentLosses.join("\n") : "  (none yet)",
  ];

  return lines.join("\n");
}

// ─── Calibration & rules block (shared by mega-prompt and per-game prompt) ──

export function calibrationRulesBlock(performanceContext: string): string {
  return `## SELF-LEARNING CALIBRATION

The following is a statistical breakdown of recent pick performance. Before scoring, you MUST derive concrete calibration lessons from this data and apply them as explicit entries in the pick's \`adjustments\` array.

${performanceContext}

**Required calibration steps:**

1. **Confidence accuracy:** If high-confidence picks (≥75%) are hitting below their predicted rate, apply a \`{"reason": "Calibration: high-conf overfit — reducing base", "delta": -N}\` adjustment (N = 3–8) to picks rated ≥75% today. If outperforming, +2–3 uplift acceptable.
2. **SP Matchup (P1) reliability:** If "Strong" SP picks are losing >50% of the time, apply \`{"reason": "Calibration: Strong SP edge not converting", "delta": -5}\` to any game otherwise rated Strong SP advantage.
3. **Odds range edge:** If a range (e.g. heavy favorites ≤-115) underperforms vs implied probability, apply \`{"reason": "Calibration: heavy fav underperformance", "delta": -4}\` to any pick in that range.
4. **Home/away bias check:** If one lean is systematically underperforming, apply \`-3\` to picks in that category.
5. **Bet type calibration:** If "Bet of Day" picks lose at a higher rate than "Game Pick" level picks, treat as overconfidence in featuring — reduce BOTD threshold from 80% to 75%.
6. **Recent streak:** If last 10 are COLD (≤4W), reduce all confidence by 3 and raise BOTD threshold +5. If HOT (≥7W), no change.
7. **Loss pattern recognition:** If today's game matches a recurring theme from the last 5 losses, apply \`{"reason": "Calibration: matches recent loss pattern — [describe]", "delta": -5}\`.
8. **ROI signal:** If estimated ROI is negative, raise minimum confidence for Top 3 to 65% and BOTD to 83%.
9. **Totals calibration (Over/Under):** Apply a \`{"reason": "Calibration: over/under subtype adj", "delta": N}\` proportional to deviation from 52% break-even (delta per point of deviation × 0.4, capped at ±10). If over win rate < 45% with 5+ sample, gate OVERs to P6 expected_total delta ≥ +1.5. If under win rate > 60%, +3 to UNDERs. If combined < 45% across 5+ samples, require 68% min final confidence for any totals bet.

Label each calibration adjustment with "Calibration:" prefix.`;
}

export const ABSOLUTE_RULES_BLOCK = `## ABSOLUTE RULES
1. NEVER recommend a bet at odds worse than -120. Odds of -121 or longer are INELIGIBLE. If the best available bet exceeds -120, set noEligibleBet: true.
2. Run the full 10-pillar analysis. No shortcuts.
3. Case AGAINST MUST cite at least 2 specific data points (actual stats/numbers). Generic statements REJECTED.
4. Case FOR must also cite at least 2 specific data points.
5. Never assign confidence above 95.`;

export const TEN_PILLAR_PROTOCOL = `## 10-PILLAR PROTOCOL
For each game, assign direction HOME / AWAY / NEUTRAL / INSUFFICIENT_DATA per pillar.

P1 Starting Pitcher Matchup (weight 3): ERA, WHIP, K/9, last 5 starts ERA, handedness splits. INSUFFICIENT_DATA if SP unannounced.
P2 Lineup Handedness Splits (weight 3): SP's vs-LHB / vs-RHB ERA/OPS splits applied to opposing lineup composition.
P3 Bullpen Quality (weight 2): Bullpen ERAs, series game number, closer reliability.
P4 Home/Away Record & Park (weight 1): Home win%, away win%, park factor (>102 hitter-friendly, <97 pitcher-friendly).
P5 Recent Form (weight 2): Last 10 record, streak, run differential.
P6 Environmental + Totals (weight 1): Temp, wind, altitude. Dome = NEUTRAL. Coors always note altitude.
**For EVERY game, use the pre-computed \`totalsContext\` field to evaluate Over/Under:**
- \`expectedTotal\` = projected runs (already accounts for R/G, SP, park, weather)
- \`homeRpg\` / \`awayRpg\` = each team's runs/game this season
- \`notes\` = adjustment breakdown
- Compare expectedTotal vs posted O/U line. Delta = expectedTotal - posted_line.
  - Delta ≥ +1.5 → strong OVER; +0.75 to +1.49 → moderate OVER
  - Delta ≤ -1.5 → strong UNDER; -0.75 to -1.49 → moderate UNDER
  - |Delta| < 0.75 → no totals edge
- Secondary signals via \`offenseContext\`: \`homeOps\`/\`awayOps\` >.800 strong offense; <.680 weak. \`homeKPct\`/\`awayKPct\` >25 high-K under pressure. \`homeObp\`/\`awayObp\` >.340 over pressure. \`homeBullpenEra\`/\`awayBullpenEra\` >4.50 leaky → over.
- Always state expectedTotal and delta in \`notes\` for any over/under pick.
**If the totals delta is stronger than the ML edge, pick the Over/Under instead.**
P7 Travel & Fatigue (weight 1): Day-after-night, series game 3+, cross-country.
P8 Line Movement / Sharp Money (weight 2): From line movement search data. No data → NEUTRAL.
P9 Game Importance (weight 1): Playoff race (within 2 games of first), rubber game, rivalry.
P10 H2H History (weight 1): From search data. Meaningful with 5+ recent meetings.

## SCORING FORMULA
rawScore = sum of (direction_value × weight) where HOME=+weight, NEUTRAL=0, AWAY=-weight (from perspective of the pick's team).
baseConfidence = 50 + (rawScore / 51) * 40

## QUALITATIVE ADJUSTMENTS
+8: Reverse line movement confirms pick (sharp_for)
-8: Reverse line movement opposes pick
+5: Strong weather/park supports pick
+3: Moderate park supports pick
-10: Lineup not confirmed
-8: Key player injured (SP, cleanup hitter, closer)
-7: SP on short rest (≤4 days)
-5: Heavy public on same side
-5: Day game after night (road team)
-3: Series game 3+
+5: Strong H2H (>60% win rate, ≥10 meetings)
-5: Weak H2H (<40% win rate, ≥10 meetings)
+4: SP career ERA notably better vs this team
-4: SP career ERA notably worse vs this team
-8: Meaningless late-season game (eliminated team)
+3: Playoff race rubber game

finalConfidence = clamp(baseConfidence + sum(adjustments), 10, 95)

## CAPS (after finalConfidence)
- Case AGAINST cites <2 specific data points → cap 65
- SP unannounced for either team → cap 60
- Lineup unconfirmed AND game within 4 hours → cap 65`;

export const SINGLE_PICK_OUTPUT_SCHEMA = `## OUTPUT JSON SCHEMA
Return ONE JSON object (NOT an array, NOT wrapped) shaped exactly:
{
  "gameId": number,
  "matchup": "AWAY_ABBR @ HOME_ABBR",
  "homeTeam": "Full Home Team Name",
  "awayTeam": "Full Away Team Name",
  "venue": "Venue Name",
  "pickTeam": "Team picked (for OVER/UNDER use 'OVER' or 'UNDER')",
  "betType": "ML" | "RL_MINUS_1_5" | "RL_PLUS_1_5" | "OVER" | "UNDER",
  "pickDescription": "Examples: 'NYY ML (-108)' | 'BOS RL +1.5 (+130)' | 'NYY/BOS Over 11 (-110)' | 'NYY/BOS Under 8.5 (-115)'",
  "odds": -108,
  "eligible": true,
  "noEligibleBet": false,
  "noEligibleBetReason": null,
  "pillars": {
    "p1_sp_matchup": { "direction": "HOME", "notes": "specific stats" },
    "p2_lineup_splits": { "direction": "NEUTRAL", "notes": "..." },
    "p3_bullpen": { "direction": "HOME", "notes": "..." },
    "p4_home_away": { "direction": "NEUTRAL", "notes": "..." },
    "p5_form": { "direction": "HOME", "notes": "..." },
    "p6_weather": { "direction": "NEUTRAL", "notes": "..." },
    "p7_travel": { "direction": "NEUTRAL", "notes": "..." },
    "p8_line_movement": { "direction": "NEUTRAL", "notes": "..." },
    "p9_motivation": { "direction": "NEUTRAL", "notes": "..." },
    "p10_h2h": { "direction": "NEUTRAL", "notes": "..." }
  },
  "rawScore": 12,
  "baseConfidence": 59.4,
  "adjustments": [{ "reason": "Lineup not confirmed", "delta": -10 }],
  "finalConfidence": 49,
  "caseFor": "3-5 sentences with 2+ specific stats",
  "caseAgainst": "3-5 sentences with 2+ specific stats including 1 would-cause-bettor-to-pass concern",
  "verdict": "One sentence: FOR outweighs AGAINST because X. OR: AGAINST too compelling — pass.",
  "lineupPending": false,
  "spMatchupRating": "Strong" | "Neutral" | "Weak",
  "notes": "1-2 sentence summary"
}`;

// ─── Parse a single JSON object out of Claude's response ────────────────────

export function parseSinglePickJSON(raw: string): GamePickResult {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    console.error("No JSON object in response. First 500 chars:", raw.slice(0, 500));
    throw new Error("Single-pick JSON parse failed: no object braces found");
  }
  const extracted = raw.slice(start, end + 1);
  try {
    return JSON.parse(extracted) as GamePickResult;
  } catch (err) {
    console.error("Failed to parse single-pick JSON. First 500 chars:", extracted.slice(0, 500));
    throw new Error(`Single-pick JSON parse failed: ${(err as Error).message}`);
  }
}

// ─── Build the markdown body for the Daily Report ───────────────────────────

export function buildReportMarkdown(
  picks: GamePickResult[],
  betOfDay: GamePickResult | null,
  underdog: GamePickResult | null,
  top3: GamePickResult[],
  yesterdayScorecard: string,
): string {
  const lines: string[] = [];

  lines.push("## Yesterday's Scorecard");
  lines.push(yesterdayScorecard);
  lines.push("");
  lines.push("---");

  if (betOfDay) {
    lines.push("## Bet of the Day");
    lines.push(`**${betOfDay.pickDescription}** | Confidence: **${betOfDay.finalConfidence}%**`);
    lines.push("");
    lines.push(`**Case FOR:** ${betOfDay.caseFor}`);
    lines.push("");
    lines.push(`**Case AGAINST:** ${betOfDay.caseAgainst}`);
    lines.push("");
    lines.push(`**Verdict:** ${betOfDay.verdict}`);
    lines.push("");
    lines.push("---");
  } else {
    lines.push("## Bet of the Day");
    lines.push("No pick reached 80% confidence threshold today.");
    lines.push("---");
  }

  if (underdog) {
    lines.push("## Underdog of the Day");
    lines.push(`**${underdog.pickDescription}** | Confidence: **${underdog.finalConfidence}%**`);
    lines.push("");
    lines.push(`**Case FOR:** ${underdog.caseFor}`);
    lines.push("");
    lines.push(`**Case AGAINST:** ${underdog.caseAgainst}`);
    lines.push("");
    lines.push(`**Verdict:** ${underdog.verdict}`);
    lines.push("");
    lines.push("---");
  }

  if (top3.length > 0) {
    lines.push("## Top 3 Bets");
    top3.forEach((p, i) => {
      lines.push(`### Pick ${i + 1}: ${p.pickDescription} | Confidence: ${p.finalConfidence}%`);
      lines.push(`**For:** ${p.caseFor}`);
      lines.push(`**Against:** ${p.caseAgainst}`);
      lines.push(`**Verdict:** ${p.verdict}`);
      lines.push("---");
    });
  }

  lines.push("## All Games");
  for (const p of picks) {
    lines.push(`### ${p.matchup}`);
    if (p.noEligibleBet) {
      lines.push(`**No eligible bet** — ${p.noEligibleBetReason ?? "all lines exceed -120 threshold."}`);
    } else {
      lines.push(`**Pick:** ${p.pickDescription} | Confidence: ${p.finalConfidence}%`);
      lines.push(`**For:** ${p.notes}`);
      lines.push(`**Against:** ${p.caseAgainst.split(".")[0]}.`);
    }
    if (p.lineupPending) lines.push("⚠️ LINEUP PENDING");
    lines.push("");
  }

  return lines.join("\n");
}
