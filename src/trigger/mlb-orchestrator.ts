// Scheduled parent task — runs daily at 12:15 PM ET
// 1. Scores yesterday's picks (Notion + MLB final scores)
// 2. Fetches today's game data (child task)
// 3. Runs analysis and publishes to Notion (child task)

import { schedules } from "@trigger.dev/sdk/v3";
import { mlbFetchDataTask } from "./mlb-fetch-data.js";
import { mlbAnalyzeTask } from "./mlb-analyze.js";
import {
  getAllPendingPicks, updatePickResult, getRunningRecord, getAllTimeRecord,
  getRecentPicksDetail, updateDailyReportResults, getResolvedPicksByDate,
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

    // ── STEP 1: Resolve ALL pending picks (any date) + build scoreboard ─────
    console.log("\n[Step 1] Resolving all pending picks...");
    let yesterdayScorecardText = "No picks yesterday — off day.";

    // Resolved pick shape for scoreboard building
    interface ResolvedPick { date: string; pick: string; betType: string; result: "Win" | "Loss" | "Push" }
    const allResolved: ResolvedPick[] = [];

    try {
      const pendingPicks = await getAllPendingPicks();
      console.log(`  Found ${pendingPicks.length} pending picks across all dates`);

      if (pendingPicks.length > 0) {
        // Group by date so we only fetch each day's scores once
        const dateSet = new Set(pendingPicks.map(p => p.date).filter(Boolean));
        const scoresByDate = new Map<string, Map<number, { homeScore: number; awayScore: number }>>();

        for (const d of dateSet) {
          if (!d) continue;
          const scores = await fetchFinalScores(d);
          scoresByDate.set(d, new Map(scores.map(s => [s.gameId, s])));
        }

        for (const pick of pendingPicks) {
          const scoreMap = scoresByDate.get(pick.date);
          const score = scoreMap?.get(pick.gameId);
          if (!score) {
            console.warn(`  No final score for game ${pick.gameId} (${pick.matchup} on ${pick.date})`);
            continue;
          }

          const result = resolvePick(pick.pick, pick.odds, score.homeScore, score.awayScore, pick.matchup);
          await updatePickResult(pick.pageId, result);
          allResolved.push({ date: pick.date, pick: pick.pick, betType: pick.betType, result });
          console.log(`  [${pick.date}] ${pick.matchup} — ${pick.pick} → ${result}`);
        }
      }

      // Scoreboard uses yesterday's resolved picks — from this run or already resolved
      let ydResolved = allResolved.filter(r => r.date === yesterdayDate);
      if (ydResolved.length === 0) {
        console.log(`  No pending picks resolved for ${yesterdayDate} — checking already-resolved...`);
        const prior = await getResolvedPicksByDate(yesterdayDate);
        ydResolved = prior.map(p => ({ date: yesterdayDate, pick: p.pick, betType: p.betType, result: p.result }));
        console.log(`  Found ${ydResolved.length} already-resolved picks for ${yesterdayDate}`);
        if (ydResolved.length > 0) {
          console.log(`  BetTypes found: ${ydResolved.map(r => `"${r.betType}"`).join(", ")}`);
        }
      }

      if (ydResolved.length > 0) {
        // Normalize betType to handle minor variations (e.g. "Bet of the Day" vs "Bet of Day")
        const normalizeBetType = (bt: string): string => {
          const t = bt.trim().toLowerCase();
          if (t === "bet of day" || t === "bet of the day" || t === "botd" || t === "best bet") return "Bet of Day";
          if (t === "underdog" || t === "underdog of day" || t === "uotd") return "Underdog";
          if (t === "top 3" || t === "top3" || t === "top pick") return "Top 3";
          return bt;
        };
        const normalized = ydResolved.map(r => ({ ...r, betType: normalizeBetType(r.betType) }));

        const botd = normalized.find(r => r.betType === "Bet of Day");
        const uotd = normalized.find(r => r.betType === "Underdog");
        const top3 = normalized.filter(r => r.betType === "Top 3");
        console.log(`  BOTD: ${botd?.pick ?? "none"} | UOTD: ${uotd?.pick ?? "none"} | Top3: ${top3.length} picks`);
        const top3W = top3.filter(r => r.result === "Win").length;
        const top3L = top3.filter(r => r.result === "Loss").length;
        const top3P = top3.filter(r => r.result === "Push").length;
        const top3WinPct = (top3W + top3L) > 0
          ? Math.round(top3W / (top3W + top3L) * 1000) / 10 : 0;

        const ydW = normalized.filter(r => r.result === "Win").length;
        const ydL = normalized.filter(r => r.result === "Loss").length;
        const ydP = normalized.filter(r => r.result === "Push").length;
        try {
          await updateDailyReportResults(
            yesterdayDate,
            botd?.result ?? "N/A",
            uotd?.result ?? "N/A",
            `${top3W}-${top3L}-${top3P}`
          );
        } catch (err) {
          console.warn(`  Could not update yesterday's report page: ${err}`);
        }

        // Fetch running records AFTER resolution so counts are current
        const [runningRecord30, allTime] = await Promise.all([
          getRunningRecord(30),
          getAllTimeRecord(),
        ]);
        const rrWinPct = (runningRecord30.wins + runningRecord30.losses) > 0
          ? Math.round(runningRecord30.wins / (runningRecord30.wins + runningRecord30.losses) * 1000) / 10 : 0;
        const atWinPct = (allTime.wins + allTime.losses) > 0
          ? Math.round(allTime.wins / (allTime.wins + allTime.losses) * 1000) / 10 : 0;
        const sign = (n: number) => n >= 0 ? `+${n}` : `${n}`;

        yesterdayScorecardText = [
          `| Category | Pick | Result |`,
          `|---|---|---|`,
          `| Bet of the Day | ${botd?.pick ?? "—"} | ${botd?.result ?? "No pick"} |`,
          `| Underdog of Day | ${uotd?.pick ?? "—"} | ${uotd?.result ?? "No pick"} |`,
          `| Top 3 | — | ${top3W}-${top3L}-${top3P} (${top3WinPct}%) |`,
          `| 30-Day Running | — | ${runningRecord30.wins}-${runningRecord30.losses} (${rrWinPct}%) · ROI: ${sign(runningRecord30.roiUnits)} units |`,
          `| **Overall (Season)** | — | **${allTime.wins}-${allTime.losses}-${allTime.pushes} (${atWinPct}%) · ${sign(allTime.roiUnits)} units** |`,
        ].join("\n");

        console.log(`  Yesterday: ${ydW}W-${ydL}L-${ydP}P | 30-day: ${runningRecord30.wins}-${runningRecord30.losses} | All-time: ${allTime.wins}-${allTime.losses}`);
      }
    } catch (err) {
      console.error(`  Scoring step failed: ${err}`);
      yesterdayScorecardText = `Scoring unavailable: ${String(err)}`;
    }

    // ── STEP 2: Load running record + recent pick detail for self-learning ──────
    console.log("\n[Step 2] Loading performance data...");
    let runningRecord = { wins: 0, losses: 0, pushes: 0, roiUnits: 0 };
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

// ─── Team name fragments for robust pick matching ────────────────────────────
// Maps 3-letter abbreviation to all substrings that may appear in a pick description.

const TEAM_FRAGMENTS: Record<string, string[]> = {
  laa: ["laa", "angels"],
  ari: ["ari", "diamondbacks", "d-backs", "arizona"],
  bal: ["bal", "orioles", "baltimore"],
  bos: ["bos", "red sox", "boston"],
  chc: ["chc", "cubs"],
  cin: ["cin", "reds", "cincinnati"],
  cle: ["cle", "guardians", "cleveland"],
  col: ["col", "rockies", "colorado"],
  det: ["det", "tigers", "detroit"],
  hou: ["hou", "astros", "houston"],
  kc:  ["kc", "royals", "kansas city"],
  lad: ["lad", "dodgers"],
  wsh: ["wsh", "nationals", "washington"],
  nym: ["nym", "mets"],
  oak: ["oak", "athletics", "oakland"],
  pit: ["pit", "pirates", "pittsburgh"],
  sd:  ["sd", "padres", "san diego"],
  sea: ["sea", "mariners", "seattle"],
  sf:  ["sf", "giants", "san francisco"],
  stl: ["stl", "cardinals", "st. louis", "st louis"],
  tb:  ["tb", "rays", "tampa bay"],
  tex: ["tex", "rangers", "texas"],
  tor: ["tor", "blue jays", "toronto"],
  min: ["min", "twins", "minnesota"],
  phi: ["phi", "phillies", "philadelphia"],
  atl: ["atl", "braves", "atlanta"],
  cws: ["cws", "white sox"],
  mia: ["mia", "marlins", "miami"],
  nyy: ["nyy", "yankees"],
  mil: ["mil", "brewers", "milwaukee"],
};

function teamInPick(abbr: string, desc: string): boolean {
  const frags = TEAM_FRAGMENTS[abbr.toLowerCase()] ?? [abbr.toLowerCase()];
  return frags.some(f => desc.includes(f));
}

// ─── Resolve a pick to Win/Loss/Push based on final score ────────────────────

function resolvePick(
  pickDescription: string,
  odds: number,
  homeScore: number,
  awayScore: number,
  matchup: string  // "AWAY @ HOME"
): "Win" | "Loss" | "Push" {
  const desc = pickDescription.toLowerCase();
  const parts = matchup.split(" @ ");
  const awayAbbr = (parts[0] ?? "").trim();
  const homeAbbr = (parts[1] ?? "").trim();

  const pickingHome = teamInPick(homeAbbr, desc);
  const pickingAway = teamInPick(awayAbbr, desc);

  // Default to home if neither matches (shouldn't happen with well-formed picks)
  const useHome = pickingHome || !pickingAway;

  const ourScore = useHome ? homeScore : awayScore;
  const theirScore = useHome ? awayScore : homeScore;
  const totalScore = homeScore + awayScore;

  // Over/Under — use regex to find the number regardless of surrounding formatting
  const overMatch = desc.match(/\bover\b[\s(]*(\d+\.?\d*)/);
  const underMatch = desc.match(/\bunder\b[\s(]*(\d+\.?\d*)/);

  if (overMatch) {
    const line = parseFloat(overMatch[1] ?? "0");
    if (!isNaN(line)) {
      if (totalScore > line) return "Win";
      if (totalScore < line) return "Loss";
      return "Push";
    }
    // "over" found but line couldn't parse — don't fall through to moneyline
    return "Loss";
  }
  if (underMatch) {
    const line = parseFloat(underMatch[1] ?? "0");
    if (!isNaN(line)) {
      if (totalScore < line) return "Win";
      if (totalScore > line) return "Loss";
      return "Push";
    }
    return "Loss";
  }

  // Run line -1.5
  if (desc.includes("-1.5")) {
    return ourScore - theirScore >= 2 ? "Win" : "Loss";
  }

  // Run line +1.5
  if (desc.includes("+1.5")) {
    return ourScore - theirScore >= -1 ? "Win" : "Loss";
  }

  // Moneyline
  if (ourScore > theirScore) return "Win";
  if (ourScore < theirScore) return "Loss";
  return "Push";
}
