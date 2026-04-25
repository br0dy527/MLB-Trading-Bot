// Aggregator: orchestrates the green-team fleet. Phase 2 fans every game out
// in parallel via batchTriggerAndWait. Free-tier concurrency cap (10) is
// handled automatically by Trigger.dev — runs queue and dequeue as slots open.

import { task } from "@trigger.dev/sdk/v3";
import {
  createDailyReport, logPick, archivePicksForDate,
  type DailyReportData, type PickToLog, type PickDetail,
} from "../lib/notion.js";
import {
  buildPerformanceContext, buildReportMarkdown, impliedProb,
  type GamePickResult,
} from "../lib/analysis-shared.js";
import type { FetchDataResult } from "./mlb-fetch-data.js";
import { mlbGreenAnalystTask } from "./mlb-green-analyst.js";

export interface AggregatorPayload {
  fetchResult: FetchDataResult;
  runningRecord: { wins: number; losses: number; pushes: number; roiUnits: number };
  yesterdayScorecard: string;
  recentPicks: PickDetail[];
}

export interface AggregatorResult {
  notionPageUrl: string;
  betOfDay: string;
  underdogOfDay: string;
  top3: string[];
  picksLogged: number;
  greenTeamFailures: number;
}

export const mlbAggregatorTask = task({
  id: "mlb-aggregator",
  maxDuration: 1800, // 30 minutes (per-game retries can stack)
  retry: { maxAttempts: 1 }, // child tasks have their own retries

  run: async (payload: AggregatorPayload): Promise<AggregatorResult> => {
    const { fetchResult, runningRecord, yesterdayScorecard, recentPicks } = payload;

    if (fetchResult.games.length === 0) {
      throw new Error("No games to analyze — fetch returned empty schedule");
    }

    console.log(`[aggregator] ${fetchResult.games.length} games for ${fetchResult.date}`);
    console.log(`[aggregator] ${recentPicks.length} recent picks loaded for calibration`);

    const performanceContext = buildPerformanceContext(recentPicks);

    // ── Phase 1: dispatch green-team analysts in parallel ───────────────────
    // batchTriggerAndWait preserves input order in the result array, so we can
    // correlate each result back to fetchResult.games[i].
    const items = fetchResult.games.map(game => ({
      payload: {
        date: fetchResult.date,
        game,
        tavilyResults: fetchResult.tavilyResults,
        performanceContext,
        yesterdayScorecard,
        runningRecord,
      },
      options: { idempotencyKey: `green-${fetchResult.date}-${game.gameId}` },
    }));

    console.log(`[aggregator] Dispatching ${items.length} green-analyst calls in parallel...`);
    const startTime = Date.now();
    const batchResult = await mlbGreenAnalystTask.batchTriggerAndWait(items);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    const picks: GamePickResult[] = [];
    let failures = 0;

    batchResult.runs.forEach((run, idx) => {
      const matchup = fetchResult.games[idx]?.matchup ?? `idx=${idx}`;
      if (run.ok) {
        picks.push(run.output.pick);
      } else {
        failures++;
        console.warn(`[aggregator] green-analyst failed for ${matchup}: ${String(run.error)}`);
      }
    });

    if (picks.length === 0) {
      throw new Error(`All ${fetchResult.games.length} green-analyst calls failed — aborting`);
    }

    console.log(`[aggregator] Collected ${picks.length}/${fetchResult.games.length} picks in ${elapsed}s (${failures} failures)`);

    // ── Phase 2: rank and select featured ───────────────────────────────────
    const eligible = picks.filter(p => p.eligible && !p.noEligibleBet);
    const sorted = [...eligible].sort((a, b) => b.finalConfidence - a.finalConfidence);
    const betOfDay = sorted[0] ?? null;
    const underdog = eligible
      .filter(p => p.odds > 0)
      .sort((a, b) => b.finalConfidence - a.finalConfidence)[0] ?? null;
    const top3 = sorted.slice(0, 3);

    console.log(`[aggregator] BOTD: ${betOfDay?.pickDescription ?? "none"} | UOTD: ${underdog?.pickDescription ?? "none"} | Top 3: ${top3.length}`);

    // ── Phase 3: publish ────────────────────────────────────────────────────
    const bodyMarkdown = buildReportMarkdown(picks, betOfDay, underdog, top3, yesterdayScorecard);

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

    const notionPageUrl = await createDailyReport(reportData);
    console.log(`[aggregator] Report created: ${notionPageUrl}`);

    // Wipe any prior picks for this date before re-logging
    const archivedCount = await archivePicksForDate(fetchResult.date);
    if (archivedCount > 0) {
      console.log(`[aggregator] Archived ${archivedCount} stale picks for ${fetchResult.date}`);
    }

    // Log all picks to Picks Tracker with multi-tag betTypes
    let picksLogged = 0;
    for (const p of picks) {
      if (p.noEligibleBet) continue;

      const betTypes: PickToLog["betTypes"] = [];
      if (p === betOfDay) betTypes.push("Bet of Day");
      if (p === underdog) betTypes.push("Underdog");
      if (top3.includes(p)) betTypes.push("Top 3");
      if (betTypes.length === 0) betTypes.push("Game Pick");

      try {
        await logPick({
          matchup: p.matchup,
          date: fetchResult.date,
          pick: p.pickDescription,
          betTypes,
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
        console.error(`[aggregator] Failed to log pick ${p.matchup}: ${err}`);
      }
    }

    console.log(`[aggregator] Logged ${picksLogged} picks`);

    return {
      notionPageUrl,
      betOfDay: betOfDay?.pickDescription ?? "No eligible bet",
      underdogOfDay: underdog?.pickDescription ?? "No eligible underdog",
      top3: top3.map(p => p.pickDescription),
      picksLogged,
      greenTeamFailures: failures,
    };
  },
});
