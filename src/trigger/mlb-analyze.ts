// Child task: Sends compiled game data to Claude for 10-pillar analysis,
// parses structured JSON picks, writes Daily Report + Picks Tracker to Notion.

import { task } from "@trigger.dev/sdk/v3";
import Anthropic from "@anthropic-ai/sdk";
import {
  createDailyReport, logPick,
  type DailyReportData, type PickToLog, type PickDetail,
} from "../lib/notion.js";
import type { FetchDataResult } from "./mlb-fetch-data.js";

// ─── Types for Claude's structured output ────────────────────────────────────

interface PillarResult {
  direction: "HOME" | "AWAY" | "NEUTRAL" | "INSUFFICIENT_DATA";
  notes: string;
}

interface GamePickResult {
  gameId: number;
  matchup: string;
  homeTeam: string;
  awayTeam: string;
  venue: string;
  pickTeam: string;
  betType: "ML" | "RL_MINUS_1_5" | "RL_PLUS_1_5" | "OVER" | "UNDER";
  pickDescription: string; // e.g. "NYY ML (-108)"
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

export interface AnalyzePayload {
  fetchResult: FetchDataResult;
  runningRecord: { wins: number; losses: number; pushes: number };
  yesterdayScorecard: string; // pre-formatted markdown summary
  recentPicks: PickDetail[];   // last 21 days of resolved picks for self-learning
}

export interface AnalyzeResult {
  notionPageUrl: string;
  betOfDay: string;
  underdogOfDay: string;
  top3: string[];
  picksLogged: number;
}

// ─── Performance analysis context for self-learning loop ─────────────────────

function buildPerformanceContext(picks: PickDetail[]): string {
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

  // Bucket helper: returns "NW-NL (X%)" or "no data"
  const stat = (bucket: PickDetail[]) => {
    if (bucket.length === 0) return "no data";
    const w = bucket.filter(p => p.result === "Win").length;
    const l = bucket.filter(p => p.result === "Loss").length;
    const pct = (w + l) > 0 ? Math.round(w / (w + l) * 100) : 0;
    return `${w}W-${l}L (${pct}%)`;
  };

  // 1. Confidence calibration
  const highConf  = resolved.filter(p => p.confidence >= 75);
  const medConf   = resolved.filter(p => p.confidence >= 60 && p.confidence < 75);
  const lowConf   = resolved.filter(p => p.confidence < 60);
  const avgPredicted = (bucket: PickDetail[]) =>
    bucket.length > 0 ? Math.round(bucket.reduce((s, p) => s + p.confidence, 0) / bucket.length) : 0;

  // 2. SP Matchup Rating accuracy
  const spStrong  = resolved.filter(p => p.spMatchupRating === "Strong");
  const spNeutral = resolved.filter(p => p.spMatchupRating === "Neutral");
  const spWeak    = resolved.filter(p => p.spMatchupRating === "Weak");

  // 3. Bet type performance
  const byBetType = (type: string) => resolved.filter(p => p.betType === type);

  // 4. Odds range performance
  const heavyFav  = resolved.filter(p => p.odds <= -115);
  const lightFav  = resolved.filter(p => p.odds > -115 && p.odds < 0);
  const pickEm    = resolved.filter(p => p.odds >= 0 && p.odds <= 110);
  const dogs      = resolved.filter(p => p.odds > 110);

  // 5. Home vs Away lean — infer from matchup string and pick team
  const homePicks = resolved.filter(p => {
    const homeAbbr = (p.matchup.split(" @ ")[1] ?? "").trim().toLowerCase();
    return homeAbbr && p.pick.toLowerCase().includes(homeAbbr);
  });
  const awayPicks = resolved.filter(p => {
    const awayAbbr = (p.matchup.split(" @ ")[0] ?? "").trim().toLowerCase();
    return awayAbbr && p.pick.toLowerCase().includes(awayAbbr);
  });

  // 6. Recent streak — last 10 resolved
  const last10  = [...resolved].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
  const l10W    = last10.filter(p => p.result === "Win").length;
  const streakDir = l10W >= 6 ? "HOT" : l10W <= 4 ? "COLD" : "NEUTRAL";

  // 7. Recent losses with notes (last 5) for semantic pattern analysis
  const recentLosses = [...losses]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5)
    .map(p => `  • ${p.date} ${p.matchup} | ${p.pick} | SP:${p.spMatchupRating} | Conf:${p.confidence}% | ${p.notes.slice(0, 200)}`);

  // 8. Expected value estimate — are we beating the market?
  const avgOddsROI = resolved.length > 0
    ? resolved.reduce((sum, p) => {
        const payout = p.odds >= 0 ? p.odds / 100 : 100 / Math.abs(p.odds);
        return sum + (p.result === "Win" ? payout : -1);
      }, 0)
    : 0;
  const roiPct = resolved.length > 0 ? Math.round(avgOddsROI / resolved.length * 100) : 0;

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
    `**Last 5 Losses (pattern analysis):**`,
    recentLosses.length > 0 ? recentLosses.join("\n") : "  (none yet)",
  ];

  return lines.join("\n");
}

// ─── Analysis prompt ─────────────────────────────────────────────────────────

function buildPrompt(data: FetchDataResult, yesterdayScorecard: string, runningRecord: { wins: number; losses: number; pushes: number }, recentPicks: PickDetail[]): string {
  const winPct = (runningRecord.wins + runningRecord.losses) > 0
    ? Math.round((runningRecord.wins / (runningRecord.wins + runningRecord.losses)) * 1000) / 10
    : 0;

  const performanceContext = buildPerformanceContext(recentPicks);

  return `You are an MLB betting analyst. Analyze each game below using the full 10-Pillar Protocol and return ONLY a valid JSON array of pick objects — no markdown, no commentary, no code fences.

## ABSOLUTE RULES
1. NEVER recommend a bet at odds worse than -120. Odds of -121 or longer are INELIGIBLE. If the best available bet for a game exceeds -120, set noEligibleBet: true.
2. Run the full 10-pillar analysis for EVERY game. No shortcuts.
3. Case AGAINST MUST cite at least 2 specific data points (actual stats/numbers). Generic statements like "the other team could play well" are REJECTED — be specific.
4. Case FOR must also cite at least 2 specific data points.
5. Never assign confidence above 95.

## 10-PILLAR PROTOCOL
For each game, assign direction HOME / AWAY / NEUTRAL / INSUFFICIENT_DATA for each pillar.

P1 Starting Pitcher Matchup (weight 3): Compare ERA, WHIP, K/9, recent form (last 5 starts ERA), handedness splits. INSUFFICIENT_DATA if SP unannounced.
P2 Lineup Handedness Splits (weight 3): Apply SP's vs-LHB and vs-RHB ERA/OPS splits to opposing lineup composition.
P3 Bullpen Quality (weight 2): Compare bullpen ERAs, series game number, closer reliability.
P4 Home/Away Record & Park Context (weight 1): Home win%, away win%, park factor (>102 = hitter-friendly, <97 = pitcher-friendly).
P5 Recent Form (weight 2): Last 10 record, streak, run differential.
P6 Environmental Factors (weight 1): Temp, wind effect, altitude. Dome = NEUTRAL. Coors Field always note altitude (+1.5-2 runs). **For every game, note the total line and evaluate whether Over or Under is a meaningful bet** — especially for Coors, high wind, or two elite SPs in a dome.
P7 Travel & Fatigue (weight 1): Day game after night game, series game 3+, cross-country travel.
P8 Line Movement / Sharp Money (weight 2): Extract from line movement search data. If no data: NEUTRAL.
P9 Game Importance (weight 1): Playoff race (within 2 games of first = high motivation), rubber game, rivalry.
P10 H2H History (weight 1): Extract from search data. Meaningful only with 5+ recent meetings.

## SCORING FORMULA
rawScore = sum of (direction_value × weight) where HOME=+weight, NEUTRAL=0, AWAY=-weight (from perspective of the pick's team)
baseConfidence = 50 + (rawScore / 51) * 40

## QUALITATIVE ADJUSTMENTS
Apply these to baseConfidence:
+8: Reverse line movement confirms pick (sharp_for)
-8: Reverse line movement opposes pick
+5: Strong weather/park factor supports pick
+3: Moderate park factor supports pick
-10: Lineup not confirmed
-8: Key player injured (SP, cleanup hitter, closer)
-7: SP on short rest (≤4 days)
-5: Heavy public on same side (possible trap)
-5: Day game after night game (road team)
-3: Series game 3+
+5: Strong H2H (>60% win rate, ≥10 meetings)
-5: Weak H2H (<40% win rate, ≥10 meetings)
+4: SP career ERA notably better vs this team
-4: SP career ERA notably worse vs this team
-8: Meaningless late-season game (eliminated team)
+3: Playoff race rubber game

finalConfidence = clamp(baseConfidence + sum(adjustments), 10, 95)

## CAPS (apply after finalConfidence)
- Case AGAINST cites <2 specific data points → cap at 65
- SP unannounced for either team → cap at 60
- Lineup unconfirmed AND game within 4 hours → cap at 65

## OUTPUT JSON SCHEMA
Return an array where each element is:
{
  "gameId": number,
  "matchup": "AWAY_ABBR @ HOME_ABBR",
  "homeTeam": "Full Home Team Name",
  "awayTeam": "Full Away Team Name",
  "venue": "Venue Name",
  "pickTeam": "Team Name that is picked",
  "betType": "ML" | "RL_MINUS_1_5" | "RL_PLUS_1_5" | "OVER" | "UNDER",
  "pickDescription": "e.g. NYY ML (-108) or BOS RL +1.5 (+130)",
  "odds": -108,
  "eligible": true,
  "noEligibleBet": false,
  "noEligibleBetReason": null,
  "pillars": {
    "p1_sp_matchup": { "direction": "HOME", "notes": "specific stats here" },
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
  "notes": "1-2 sentence summary of key reasoning"
}

---

## SELF-LEARNING CALIBRATION

The following is a statistical breakdown of your recent pick performance. Before scoring today's games, you MUST derive concrete calibration lessons from this data and apply them as explicit entries in each pick's \`adjustments\` array.

${performanceContext}

**Required calibration steps — complete all 8 before scoring any game:**

1. **Confidence accuracy:** Compare predicted vs actual win rate per bucket. If high-confidence picks (≥75%) are hitting below their predicted rate, apply a \`{"reason": "Calibration: high-conf overfit — reducing base", "delta": -N}\` adjustment (N = 3–8) to picks you rate ≥75% today. If they're outperforming, a +2–3 uplift is acceptable.

2. **SP Matchup (P1) reliability:** If "Strong" SP picks are losing more than 50% of the time, reduce their effective P1 weight — apply a \`{"reason": "Calibration: Strong SP edge not converting", "delta": -5}\` to any game you'd otherwise rate as Strong SP advantage. If "Weak" SP picks are surprisingly winning, be skeptical of over-weighting P1 today.

3. **Odds range edge:** If a specific range (e.g. heavy favorites ≤-115) has a negative win rate vs implied probability, apply \`{"reason": "Calibration: heavy fav underperformance", "delta": -4}\` to any pick in that range today. If underdogs have been outperforming, consider giving them a +3 boost.

4. **Home/away bias check:** If one lean (home or away) is systematically underperforming, apply a \`-3\` adjustment to any pick that falls in that category today.

5. **Bet type calibration:** If "Bet of Day" picks are losing at a higher rate than "Game Pick" level picks, this signals overconfidence in featuring — reduce BOTD confidence threshold from 80% to 75% for today.

6. **Recent streak adjustment:** If the last 10 picks are COLD (≤4W), apply a universal caution flag — reduce all confidence scores by 3 points and raise the BOTD threshold by 5 points. If HOT (≥7W), no change needed.

7. **Loss pattern recognition:** Review the last 5 losses above. Identify any recurring themes (e.g., "road teams in cold weather," "pitchers with small IP samples," "line moved against us"). For any game today that matches a loss pattern, apply \`{"reason": "Calibration: matches recent loss pattern — [describe it]", "delta": -5}\`.

8. **ROI signal:** If estimated ROI is negative, you are systematically losing value — tighten eligibility criteria for today. Raise the minimum confidence for Top 3 from 60% to 65%, and for BOTD from 80% to 83%.

Apply calibration adjustments inside each pick's \`adjustments\` array. Label each one clearly with "Calibration:" prefix so the audit trail is legible.

---

## CONTEXT

30-day running record: ${runningRecord.wins}-${runningRecord.losses}-${runningRecord.pushes} (${winPct}% win rate)

Yesterday's scorecard:
${yesterdayScorecard}

---

## GAME DATA (JSON)
${JSON.stringify({ date: data.date, games: data.games }, null, 1)}

---

## WEB SEARCH RESULTS

### ODDS (use to find lines for each game — only -120 or better are eligible; always extract total line + over/under odds for every game)
${data.tavilyResults.odds || "No odds data available"}

### LINEUPS (check if each game's lineups are confirmed or TBD)
${data.tavilyResults.lineups || "No lineup data available"}

### INJURIES (flag key absences that affect picks)
${data.tavilyResults.injuries || "No injury data available"}

### LINE MOVEMENT & SHARP MONEY (Pillar 8 signal)
${data.tavilyResults.lineMovement || "No line movement data available"}

---

Return ONLY the JSON array. No markdown, no explanation.`;
}

// ─── Parse Claude's JSON response ────────────────────────────────────────────

function parsePicksJSON(raw: string): GamePickResult[] {
  // Extract just the JSON array — handles leading prose, code fences, and trailing text
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");

  if (start === -1 || end === -1 || end < start) {
    console.error("No JSON array found in Claude response. First 500 chars:", raw.slice(0, 500));
    throw new Error("Analysis JSON parse failed: no array brackets found in response");
  }

  const extracted = raw.slice(start, end + 1);

  try {
    const parsed = JSON.parse(extracted) as GamePickResult[];
    if (!Array.isArray(parsed)) throw new Error("Response is not an array");
    return parsed;
  } catch (err) {
    console.error("Failed to parse Claude JSON. First 500 chars:", extracted.slice(0, 500));
    throw new Error(`Analysis JSON parse failed: ${(err as Error).message}`);
  }
}

// ─── Build report markdown ────────────────────────────────────────────────────

function buildReportMarkdown(
  picks: GamePickResult[],
  betOfDay: GamePickResult | null,
  underdog: GamePickResult | null,
  top3: GamePickResult[],
  yesterdayScorecard: string,
  runningRecord: { wins: number; losses: number; pushes: number }
): string {
  const winPct = (runningRecord.wins + runningRecord.losses) > 0
    ? Math.round((runningRecord.wins / (runningRecord.wins + runningRecord.losses)) * 1000) / 10
    : 0;

  const lines: string[] = [];

  // Yesterday's scorecard
  lines.push("## Yesterday's Scorecard");
  lines.push(yesterdayScorecard);
  lines.push("");
  lines.push(`**30-day running:** ${runningRecord.wins}-${runningRecord.losses}-${runningRecord.pushes} (${winPct}% win rate)`);
  lines.push("");
  lines.push("---");

  // Bet of Day
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

  // Underdog of Day
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

  // Top 3
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

  // All Games
  lines.push("## All Games");
  for (const p of picks) {
    const gameTime = new Date(p.venue).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
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

// ─── Implied probability from American odds ───────────────────────────────────

function impliedProb(odds: number): number {
  if (odds < 0) return Math.abs(odds) / (Math.abs(odds) + 100) * 100;
  return 100 / (odds + 100) * 100;
}

// ─── Main task ────────────────────────────────────────────────────────────────

export const mlbAnalyzeTask = task({
  id: "mlb-analyze",
  maxDuration: 1800, // 30 minutes
  retry: { maxAttempts: 2, minTimeoutInMs: 10000, maxTimeoutInMs: 60000, factor: 2 },

  run: async (payload: AnalyzePayload): Promise<AnalyzeResult> => {
    const { fetchResult, runningRecord, yesterdayScorecard, recentPicks } = payload;

    if (fetchResult.games.length === 0) {
      throw new Error("No games to analyze — fetch returned empty schedule");
    }

    console.log(`[mlb-analyze] Analyzing ${fetchResult.games.length} games for ${fetchResult.date}`);
    console.log(`[mlb-analyze] ${recentPicks.length} recent picks loaded for calibration`);

    // Call Claude
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = buildPrompt(fetchResult, yesterdayScorecard, runningRecord, recentPicks);

    console.log(`[mlb-analyze] Sending ${prompt.length} chars to Claude...`);

    // Use streaming to avoid the 10-minute non-streaming API timeout
    console.log(`[mlb-analyze] Streaming response from Claude...`);
    let responseText = "";
    const stream = client.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 32000,
      messages: [{ role: "user", content: prompt }],
    });

    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
        responseText += chunk.delta.text;
      }
    }

    console.log(`[mlb-analyze] Claude responded with ${responseText.length} chars`);

    const picks = parsePicksJSON(responseText);
    console.log(`[mlb-analyze] Parsed ${picks.length} game picks`);

    // Select featured picks
    const eligible = picks.filter(p => p.eligible && !p.noEligibleBet);
    const sorted = [...eligible].sort((a, b) => b.finalConfidence - a.finalConfidence);

    const betOfDay = sorted[0] ?? null;
    const underdog = eligible
      .filter(p => p.odds > 0)
      .sort((a, b) => b.finalConfidence - a.finalConfidence)[0] ?? null;
    const top3 = sorted.slice(0, 3);

    // Build report
    const bodyMarkdown = buildReportMarkdown(picks, betOfDay, underdog, top3, yesterdayScorecard, runningRecord);

    const reportData: DailyReportData = {
      date: fetchResult.date,
      betOfDay: betOfDay?.pickDescription ?? "No eligible bet",
      botdConfidence: betOfDay?.finalConfidence ?? 0,
      underdogOfDay: underdog?.pickDescription ?? "No eligible underdog",
      top3Record: "0-0 (Pending)",
      totalPicks: eligible.length,
      lineupsConfirmed: !picks.some(p => p.lineupPending),
      gamesAnalyzed: picks.length,
      bodyMarkdown,
    };

    console.log(`[mlb-analyze] Creating Notion report...`);
    const notionPageUrl = await createDailyReport(reportData);
    console.log(`[mlb-analyze] Report created: ${notionPageUrl}`);

    // Log all picks to Picks Tracker
    let picksLogged = 0;
    for (const p of picks) {
      if (p.noEligibleBet) continue;

      const betType: PickToLog["betType"] =
        p === betOfDay ? "Bet of Day" :
        p === underdog ? "Underdog" :
        top3.includes(p) ? "Top 3" : "Game Pick";

      try {
        await logPick({
          matchup: p.matchup,
          date: fetchResult.date,
          pick: p.pickDescription,
          betType,
          odds: p.odds,
          impliedProbPct: impliedProb(p.odds),
          confidence: p.finalConfidence,
          spMatchupRating: p.spMatchupRating,
          homeTeam: p.homeTeam,
          awayTeam: p.awayTeam,
          gameId: p.gameId,
          notes: p.notes,
          reportUrl: notionPageUrl,
        });
        picksLogged++;
      } catch (err) {
        console.error(`[mlb-analyze] Failed to log pick ${p.matchup}: ${err}`);
      }
    }

    console.log(`[mlb-analyze] Logged ${picksLogged} picks to Picks Tracker`);

    return {
      notionPageUrl,
      betOfDay: betOfDay?.pickDescription ?? "None",
      underdogOfDay: underdog?.pickDescription ?? "None",
      top3: top3.map(p => p.pickDescription),
      picksLogged,
    };
  },
});
