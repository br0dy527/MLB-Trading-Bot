// Scheduled parent task — runs daily at 12:15 PM ET
// 1. Scores yesterday's picks (Notion + MLB final scores)
// 2. Fetches today's game data (child task)
// 3. Runs analysis and publishes to Notion (child task)

import { schedules } from "@trigger.dev/sdk/v3";
import { mlbFetchDataTask } from "./mlb-fetch-data.js";
import { mlbAnalyzeTask } from "./mlb-analyze.js";
import { mlbAggregatorTask } from "./mlb-aggregator.js";
import { mlbPostmortemTask } from "./mlb-postmortem.js";
import {
  getAllPendingPicks, updatePickResult, getRunningRecord, getAllTimeRecord,
  getRecentPicksDetail, updateDailyReportResults, getResolvedPicksByDate,
  getDailyReportSummary, getActiveLessons,
  type PickDetail, type Lesson,
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
    interface ResolvedPick { date: string; pick: string; betTypes: string[]; result: "Win" | "Loss" | "Push" }
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
          allResolved.push({ date: pick.date, pick: pick.pick, betTypes: pick.betTypes, result });
          console.log(`  [${pick.date}] ${pick.matchup} — ${pick.pick} → ${result}`);
        }
      }

      // Update Daily Report pages for every date that had resolutions this run,
      // plus yesterday (so the scorecard always reflects the latest state).
      const datesToUpdate = new Set<string>(allResolved.map(r => r.date).filter(Boolean));
      datesToUpdate.add(yesterdayDate);

      const summarizeDate = async (d: string) => {
        const all = await getResolvedPicksByDate(d);
        const normalized = all.map(p => ({ ...p, betTypes: p.betTypes.map(normalizeBetType) }));
        const botd = normalized.find(r => r.betTypes.includes("Bet of Day"));
        const uotd = normalized.find(r => r.betTypes.includes("Underdog"));
        const top3 = normalized.filter(r => r.betTypes.includes("Top 3"));
        const top3W = top3.filter(r => r.result === "Win").length;
        const top3L = top3.filter(r => r.result === "Loss").length;
        const top3P = top3.filter(r => r.result === "Push").length;
        return { all: normalized, botd, uotd, top3, top3W, top3L, top3P };
      };

      let ySummary: Awaited<ReturnType<typeof summarizeDate>> | null = null;
      for (const d of datesToUpdate) {
        try {
          const s = await summarizeDate(d);
          if (s.all.length === 0) {
            console.log(`  ${d}: no resolved picks — skipping report update`);
            if (d === yesterdayDate) ySummary = s;
            continue;
          }
          await updateDailyReportResults(
            d,
            s.botd?.result ?? "N/A",
            s.uotd?.result ?? "N/A",
            `${s.top3W}-${s.top3L}-${s.top3P}`,
          );
          console.log(`  ${d}: BOTD=${s.botd?.result ?? "N/A"} UOTD=${s.uotd?.result ?? "N/A"} Top3=${s.top3W}-${s.top3L}-${s.top3P}`);
          if (d === yesterdayDate) ySummary = s;
        } catch (err) {
          console.warn(`  Could not update report for ${d}: ${err}`);
        }
      }

      if (ySummary && ySummary.all.length > 0) {
        const { botd, uotd, top3W, top3L, top3P } = ySummary;
        const top3WinPct = (top3W + top3L) > 0
          ? Math.round(top3W / (top3W + top3L) * 1000) / 10 : 0;

        // Prefer the BOTD/UOTD text exactly as displayed on yesterday's report
        // page — keeps the scorecard visually aligned with the prior day's
        // report, even if the Picks Tracker text differs slightly.
        const yReport = await getDailyReportSummary(yesterdayDate).catch(() => null);
        const botdPickText = yReport?.botdText || botd?.pick || "—";
        const uotdPickText = yReport?.uotdText || uotd?.pick || "—";

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
          `| Bet of the Day | ${botdPickText} | ${botd?.result ?? "No pick"} |`,
          `| Underdog of Day | ${uotdPickText} | ${uotd?.result ?? "No pick"} |`,
          `| Top 3 | — | ${top3W}-${top3L}-${top3P} (${top3WinPct}%) |`,
          `| 30-Day Running | — | ${runningRecord30.wins}-${runningRecord30.losses} (${rrWinPct}%) · ROI: ${sign(runningRecord30.roiUnits)} units |`,
          `| **Overall (Season)** | — | **${allTime.wins}-${allTime.losses}-${allTime.pushes} (${atWinPct}%) · ${sign(allTime.roiUnits)} units** |`,
        ].join("\n");

        const ydW = ySummary.all.filter(r => r.result === "Win").length;
        const ydL = ySummary.all.filter(r => r.result === "Loss").length;
        const ydP = ySummary.all.filter(r => r.result === "Push").length;
        console.log(`  Yesterday: ${ydW}W-${ydL}L-${ydP}P | 30-day: ${runningRecord30.wins}-${runningRecord30.losses} | All-time: ${allTime.wins}-${allTime.losses}`);
      }
    } catch (err) {
      console.error(`  Scoring step failed: ${err}`);
      yesterdayScorecardText = `Scoring unavailable: ${String(err)}`;
    }

    // ── STEP 1b: Run post-mortem on yesterday's resolved picks ──────────────────
    // Writes durable lessons to the Lessons Learned DB. Runs BEFORE step 2 so the
    // green/red analysts see freshly-written lessons in the same session.
    if (process.env.ENABLE_POSTMORTEM === "1") {
      console.log("\n[Step 1b] Running post-mortem on recent picks...");
      try {
        const pmResult = await mlbPostmortemTask.triggerAndWait(
          { date: yesterdayDate },
          { idempotencyKey: `postmortem-${yesterdayDate}` },
        );
        if (pmResult.ok) {
          const { created, reinforced, retired, skipped, notes } = pmResult.output;
          console.log(`  Lessons: ${created} created, ${reinforced} reinforced, ${retired} retired, ${skipped} skipped`);
          if (notes) console.log(`  ${notes}`);
        } else {
          console.warn(`  Post-mortem failed (non-fatal): ${String(pmResult.error)}`);
        }
      } catch (err) {
        console.warn(`  Post-mortem error (non-fatal): ${err}`);
      }
    } else {
      console.log("\n[Step 1b] Post-mortem disabled (set ENABLE_POSTMORTEM=1 to enable)");
    }

    // ── STEP 2: Load running record + recent pick detail for self-learning ──────
    console.log("\n[Step 2] Loading performance data...");
    let runningRecord = { wins: 0, losses: 0, pushes: 0, roiUnits: 0 };
    let recentPicks: PickDetail[] = [];
    let lessons: Lesson[] = [];
    try {
      [runningRecord, recentPicks, lessons] = await Promise.all([
        getRunningRecord(30),
        getRecentPicksDetail(21),
        getActiveLessons(),
      ]);
      const wr = (runningRecord.wins + runningRecord.losses) > 0
        ? Math.round(runningRecord.wins / (runningRecord.wins + runningRecord.losses) * 1000) / 10
        : 0;
      console.log(`  30-day record: ${runningRecord.wins}-${runningRecord.losses}-${runningRecord.pushes} (${wr}%)`);
      console.log(`  ${recentPicks.length} resolved picks loaded for calibration`);
      console.log(`  ${lessons.length} active lessons loaded`);
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
    // Feature flag: USE_AGGREGATOR=1 routes through the green-team fleet
    // (mlb-aggregator → mlb-green-analyst per game). Default = legacy mega-prompt.
    const useAggregator = process.env.USE_AGGREGATOR === "1";
    console.log(`\n[Step 4] Running 10-pillar analysis (${useAggregator ? "AGGREGATOR/green-team" : "legacy mega-prompt"})...`);

    const analyzePayload = {
      fetchResult: fetchResult.output,
      runningRecord,
      yesterdayScorecard: yesterdayScorecardText,
      recentPicks,
      lessons,
    };

    const analyzeResult = useAggregator
      ? await mlbAggregatorTask.triggerAndWait(analyzePayload, {
          idempotencyKey: `mlb-aggregator-${today}`,
        })
      : await mlbAnalyzeTask.triggerAndWait(analyzePayload, {
          idempotencyKey: `mlb-analyze-${today}`,
        });

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

// ─── Normalize Bet Type strings for robust filtering ─────────────────────────
// Handles minor variations across runs (e.g. "Bet of the Day" vs "Bet of Day").
function normalizeBetType(bt: string): string {
  const t = bt.trim().toLowerCase();
  if (t === "bet of day" || t === "bet of the day" || t === "botd" || t === "best bet") return "Bet of Day";
  if (t === "underdog" || t === "underdog of day" || t === "uotd") return "Underdog";
  if (t === "top 3" || t === "top3" || t === "top pick") return "Top 3";
  return bt;
}

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
