// Child task: Sends compiled game data to Claude for 10-pillar analysis,
// parses structured JSON picks, writes Daily Report + Picks Tracker to Notion.

import { task } from "@trigger.dev/sdk/v3";
import Anthropic from "@anthropic-ai/sdk";
import {
  createDailyReport, logPick,
  type DailyReportData, type PickToLog,
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
}

export interface AnalyzeResult {
  notionPageUrl: string;
  betOfDay: string;
  underdogOfDay: string;
  top3: string[];
  picksLogged: number;
}

// ─── Analysis prompt ─────────────────────────────────────────────────────────

function buildPrompt(data: FetchDataResult, yesterdayScorecard: string, runningRecord: { wins: number; losses: number; pushes: number }): string {
  const winPct = (runningRecord.wins + runningRecord.losses) > 0
    ? Math.round((runningRecord.wins / (runningRecord.wins + runningRecord.losses)) * 1000) / 10
    : 0;

  return `You are an MLB betting analyst. Analyze each game below using the full 10-Pillar Protocol and return ONLY a valid JSON array of pick objects — no markdown, no commentary, no code fences.

## ABSOLUTE RULES
1. NEVER recommend a bet at odds worse than -115. Odds of -116 or longer are INELIGIBLE. If the best available bet for a game exceeds -115, set noEligibleBet: true.
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
P6 Environmental Factors (weight 1): Temp, wind effect, altitude. Dome = NEUTRAL. Coors Field always note altitude (+1.5-2 runs).
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

## CONTEXT

30-day running record: ${runningRecord.wins}-${runningRecord.losses}-${runningRecord.pushes} (${winPct}% win rate)

Yesterday's scorecard:
${yesterdayScorecard}

---

## GAME DATA (JSON)
${JSON.stringify({ date: data.date, games: data.games }, null, 1)}

---

## WEB SEARCH RESULTS

### ODDS (use to find lines for each game — only -115 or better are eligible)
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
  const cleaned = raw
    .replace(/^```json\s*/m, "").replace(/^```\s*/m, "").replace(/```\s*$/m, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as GamePickResult[];
    if (!Array.isArray(parsed)) throw new Error("Response is not an array");
    return parsed;
  } catch (err) {
    console.error("Failed to parse Claude JSON. First 500 chars:", cleaned.slice(0, 500));
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
      lines.push(`**No eligible bet** — ${p.noEligibleBetReason ?? "all lines exceed -115 threshold."}`);
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
    const { fetchResult, runningRecord, yesterdayScorecard } = payload;

    if (fetchResult.games.length === 0) {
      throw new Error("No games to analyze — fetch returned empty schedule");
    }

    console.log(`[mlb-analyze] Analyzing ${fetchResult.games.length} games for ${fetchResult.date}`);

    // Call Claude
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = buildPrompt(fetchResult, yesterdayScorecard, runningRecord);

    console.log(`[mlb-analyze] Sending ${prompt.length} chars to Claude...`);

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
    });

    const responseText = (message.content[0] as { type: "text"; text: string }).text;
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
