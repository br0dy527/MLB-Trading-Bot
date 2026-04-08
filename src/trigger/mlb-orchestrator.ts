// Scheduled parent task — runs daily at 12:30 PM ET
// 1. Scores yesterday's picks (Notion + MLB final scores)
// 2. Fetches today's game data (child task)
// 3. Runs analysis and publishes to Notion (child task)

import { schedules } from "@trigger.dev/sdk/v3";
import { mlbFetchDataTask } from "./mlb-fetch-data.js";
import { mlbAnalyzeTask } from "./mlb-analyze.js";
import {
  getYesterdayPendingPicks, updatePickResult, getRunningRecord,
  getRecentPicksDetail, updateDailyReportResults,
  type PickDetail,
} from "../lib/notion.js";
import { fetchFinalScores } from "../lib/mlb-api.js";

export const mlbOrchestratorTask = schedules.task({
  id: "mlb-orchestrator",
  cron: {
    pattern: "15 12 * * *", // 12:15 PM ET — timezone field handles DST automatically
    timezone: "America/New_York",
    environments: ["PRODUCTION"],
  },
  maxDuration: 3600, // 1 hour max

  run: async () => {
    const today = new Date().toISOString().split("T")[0] as string;
    const yesterdayDate = new Date(Date.now() - 86400000).toISOString().split("T")[0] as string;

    console.log(`\nMLB Daily Picks — ${today}`);
    console.log("=".repeat(40));

    // ── STEP 1: Score yesterday's picks ─────────────────────────────────────
    console.log("\n[Step 1] Scoring yesterday's picks...");
    let yesterdayScorecardText = "No pending picks from yesterday.";

    try {
      const pendingPicks = await getYesterdayPendingPicks(yesterdayDate);
      console.log(`  Found ${pendingPicks.length} pending picks for ${yesterdayDate}`);

      if (pendingPicks.length > 0) {
        const finalScores = await fetchFinalScores(yesterdayDate);
        const scoreMap = new Map(finalScores.map(s => [s.gameId, s]));

        let wins = 0, losses = 0, pushes = 0;
        const resultLines: string[] = [];

        for (const pick of pendingPicks) {
          const score = scoreMap.get(pick.gameId);
          if (!score) {
            console.warn(`  No final score found for game ${pick.gameId} (${pick.matchup})`);
            resultLines.push(`| ${pick.matchup} | ${pick.pick} | No Score Found |`);
            continue;
          }

          const result = resolvePick(pick.pick, pick.odds, score.homeScore, score.awayScore, pick.matchup);
          await updatePickResult(pick.pageId, result);

          if (result === "Win") wins++;
          else if (result === "Loss") losses++;
          else pushes++;

          resultLines.push(`| ${pick.matchup} | ${pick.pick} | ${result} |`);
        }

        // Update yesterday's Daily Report
        const botdPick = pendingPicks.find(p => p.betType === "Bet of Day");
        const uotdPick = pendingPicks.find(p => p.betType === "Underdog");
        const top3Picks = pendingPicks.filter(p => p.betType === "Top 3");
        const top3W = top3Picks.filter(p => p.betType === "Top 3").length; // re-query would be needed for accuracy; approximate here

        try {
          await updateDailyReportResults(
            yesterdayDate,
            botdPick ? "Pending" : "N/A", // will be updated after full resolution
            uotdPick ? "Pending" : "N/A",
            `${wins}-${losses}-${pushes}`
          );
        } catch (err) {
          console.warn(`  Could not update yesterday's report page: ${err}`);
        }

        const winPct = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 1000) / 10 : 0;
        yesterdayScorecardText = [
          `| Category | Record |`,
          `|---|---|`,
          ...resultLines,
          `| **Overall** | **${wins}-${losses}-${pushes} (${winPct}%)** |`,
        ].join("\n");

        console.log(`  Yesterday: ${wins}W-${losses}L-${pushes}P (${winPct}%)`);
      }
    } catch (err) {
      console.error(`  Scoring step failed: ${err}`);
      yesterdayScorecardText = `Scoring unavailable: ${String(err)}`;
    }

    // ── STEP 2: Load running record + recent pick detail for self-learning ──────
    console.log("\n[Step 2] Loading performance data...");
    let runningRecord = { wins: 0, losses: 0, pushes: 0 };
    let recentPicks: PickDetail[] = [];
    try {
      [runningRecord, recentPicks] = await Promise.all([
        getRunningRecord(30),
        getRecentPicksDetail(21),
      ]);
      const wr = (runningRecord.wins + runningRecord.losses) > 0
        ? Math.round(runningRecord.wins / (runningRecord.wins + runningRecord.losses) * 1000) / 10
        : 0;
      console.log(`  30-day record: ${runningRecord.wins}-${runningRecord.losses}-${runningRecord.pushes} (${wr}%)`);
      console.log(`  ${recentPicks.length} resolved picks loaded for calibration`);
    } catch (err) {
      console.warn(`  Could not load performance data: ${err}`);
    }

    // ── STEP 3: Fetch today's game data ──────────────────────────────────────
    console.log("\n[Step 3] Fetching today's game data...");

    const fetchResult = await mlbFetchDataTask.triggerAndWait(
      { date: today },
      { idempotencyKey: `mlb-fetch-${today}` }
    );

    if (!fetchResult.ok) {
      throw new Error(`Data fetch failed: ${String(fetchResult.error)}`);
    }

    const { games, dataNotes } = fetchResult.output;

    if (games.length === 0) {
      console.log("  No games scheduled today.");
      return { status: "no_games", date: today };
    }

    console.log(`  ${games.length} games fetched. ${dataNotes.length} data notes.`);

    // ── STEP 4: Analyze and publish ──────────────────────────────────────────
    console.log("\n[Step 4] Running 10-pillar analysis and publishing to Notion...");

    const analyzeResult = await mlbAnalyzeTask.triggerAndWait(
      {
        fetchResult: fetchResult.output,
        runningRecord,
        yesterdayScorecard: yesterdayScorecardText,
        recentPicks,
      },
      { idempotencyKey: `mlb-analyze-${today}` }
    );

    if (!analyzeResult.ok) {
      throw new Error(`Analysis failed: ${String(analyzeResult.error)}`);
    }

    const { notionPageUrl, betOfDay, underdogOfDay, top3, picksLogged } = analyzeResult.output;

    // ── SUMMARY ──────────────────────────────────────────────────────────────
    const summary = [
      `\nMLB Daily Picks — ${today}`,
      "=".repeat(40),
      `Yesterday: ${yesterdayScorecardText.split("\n").find(l => l.includes("Overall")) ?? "N/A"}`,
      `Games analyzed: ${games.length} | Picks logged: ${picksLogged}`,
      `Bet of Day:  ${betOfDay}`,
      `Underdog:    ${underdogOfDay}`,
      `Top 3:       ${top3.join(", ") || "None"}`,
      `Notion report: ${notionPageUrl}`,
      dataNotes.length > 0 ? `Data notes: ${dataNotes.join(" | ")}` : "",
    ].filter(Boolean).join("\n");

    console.log(summary);

    return {
      status: "success",
      date: today,
      notionPageUrl,
      betOfDay,
      underdogOfDay,
      top3,
      gamesAnalyzed: games.length,
      picksLogged,
    };
  },
});

// ─── Resolve a pick to Win/Loss/Push based on final score ────────────────────

function resolvePick(
  pickDescription: string,
  odds: number,
  homeScore: number,
  awayScore: number,
  matchup: string  // "AWAY @ HOME"
): "Win" | "Loss" | "Push" {
  const desc = pickDescription.toLowerCase();
  const [awayAbbr, homeAbbr] = matchup.split(" @ ").map(s => s.trim().toLowerCase());

  // Determine if we're picking home or away
  const pickingHome =
    homeAbbr ? desc.includes(homeAbbr) : false ||
    (!awayAbbr || !desc.includes(awayAbbr));

  const ourScore = pickingHome ? homeScore : awayScore;
  const theirScore = pickingHome ? awayScore : homeScore;
  const totalScore = homeScore + awayScore;

  // Over/Under
  if (desc.includes("over ")) {
    const line = parseFloat(desc.split("over ")[1] ?? "0");
    if (totalScore > line) return "Win";
    if (totalScore < line) return "Loss";
    return "Push";
  }
  if (desc.includes("under ")) {
    const line = parseFloat(desc.split("under ")[1] ?? "0");
    if (totalScore < line) return "Win";
    if (totalScore > line) return "Loss";
    return "Push";
  }

  // Run line -1.5
  if (desc.includes("-1.5")) {
    if (ourScore - theirScore > 1) return "Win";
    return "Loss";
  }

  // Run line +1.5
  if (desc.includes("+1.5")) {
    if (ourScore - theirScore >= -1) return "Win";
    return "Loss";
  }

  // Moneyline
  if (ourScore > theirScore) return "Win";
  if (ourScore < theirScore) return "Loss";
  return "Push";
}
