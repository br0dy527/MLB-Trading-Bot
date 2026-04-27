// Aggregator: orchestrates the green-team fleet. Phase 2 fans every game out
// in parallel via batchTriggerAndWait. Free-tier concurrency cap (10) is
// handled automatically by Trigger.dev — runs queue and dequeue as slots open.

import { task } from "@trigger.dev/sdk/v3";
import {
  createDailyReport, logPick, archivePicksForDate,
  type DailyReportData, type PickToLog, type PickDetail, type Lesson,
} from "../lib/notion.js";
import {
  buildPerformanceContext, buildReportMarkdown, impliedProb,
  type GamePickResult,
} from "../lib/analysis-shared.js";
import type { FetchDataResult } from "./mlb-fetch-data.js";
import { mlbGreenAnalystTask } from "./mlb-green-analyst.js";
import { mlbRedAnalystTask } from "./mlb-red-analyst.js";

export interface AggregatorPayload {
  fetchResult: FetchDataResult;
  runningRecord: { wins: number; losses: number; pushes: number; roiUnits: number };
  yesterdayScorecard: string;
  recentPicks: PickDetail[];
  lessons?: Lesson[];
}

export interface AggregatorResult {
  notionPageUrl: string;
  betOfDay: string;
  underdogOfDay: string;
  top3: string[];
  picksLogged: number;
  greenTeamFailures: number;
  redTeamFailures: number;
  redTeamVetoes: number;
}

export const mlbAggregatorTask = task({
  id: "mlb-aggregator",
  maxDuration: 1800, // 30 minutes (per-game retries can stack)
  retry: { maxAttempts: 1 }, // child tasks have their own retries

  run: async (payload: AggregatorPayload): Promise<AggregatorResult> => {
    const { fetchResult, runningRecord, yesterdayScorecard, recentPicks, lessons = [] } = payload;

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
        lessons,
      },
      options: { idempotencyKey: `green-${fetchResult.date}-${game.gameId}` },
    }));

    // Chunk dispatches to stay under Anthropic org output-token rate limit.
    // Each green-analyst requests max_tokens=4000; chunks of 5 keep peak
    // requested output ≤20k/min, well under typical org caps.
    const CHUNK_SIZE = 5;
    console.log(`[aggregator] Dispatching ${items.length} green-analyst calls in chunks of ${CHUNK_SIZE}...`);
    const startTime = Date.now();

    const picks: GamePickResult[] = [];
    let failures = 0;
    let globalIdx = 0;

    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const chunk = items.slice(i, i + CHUNK_SIZE);
      const chunkResult = await mlbGreenAnalystTask.batchTriggerAndWait(chunk);
      chunkResult.runs.forEach((run, localIdx) => {
        const matchup = fetchResult.games[globalIdx + localIdx]?.matchup ?? `idx=${globalIdx + localIdx}`;
        if (run.ok) {
          picks.push(run.output.pick);
        } else {
          failures++;
          console.warn(`[aggregator] green-analyst failed for ${matchup}: ${String(run.error)}`);
        }
      });
      globalIdx += chunk.length;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (picks.length === 0) {
      throw new Error(`All ${fetchResult.games.length} green-analyst calls failed — aborting`);
    }

    console.log(`[aggregator] Collected ${picks.length}/${fetchResult.games.length} picks in ${elapsed}s (${failures} failures)`);

    // ── Phase 2: rank and select candidate pool for red-team review ─────────
    const eligible = picks.filter(p => p.eligible && !p.noEligibleBet);
    const sortedByGreen = [...eligible].sort((a, b) => b.finalConfidence - a.finalConfidence);

    // Red team reviews the picks that are candidates for BOTD / UOTD / Top 3:
    // top 6 by green-team confidence + best positive-odds candidate (if not already in).
    const top6 = sortedByGreen.slice(0, 6);
    const positiveOddsTop = eligible
      .filter(p => p.odds > 0)
      .sort((a, b) => b.finalConfidence - a.finalConfidence)[0] ?? null;
    const candidatePool = positiveOddsTop && !top6.includes(positiveOddsTop)
      ? [...top6, positiveOddsTop]
      : top6;

    console.log(`[aggregator] Pre-red-team — top green confidences: ${sortedByGreen.slice(0, 3).map(p => `${p.pickDescription}@${p.finalConfidence}%`).join(", ")}`);
    console.log(`[aggregator] Red-team will review ${candidatePool.length} candidates`);

    // ── Phase 2b: dispatch red team in chunks of 5 ──────────────────────────
    const RED_CHUNK_SIZE = 5;
    const gameById = new Map(fetchResult.games.map(g => [g.gameId, g]));
    const redItems = candidatePool
      .map(pick => {
        const game = gameById.get(pick.gameId);
        if (!game) return null;
        return {
          payload: {
            date: fetchResult.date,
            greenPick: pick,
            game,
            tavilyResults: fetchResult.tavilyResults,
            lessons,
          },
          options: { idempotencyKey: `red-${fetchResult.date}-${pick.gameId}-${pick.pickDescription.slice(0, 40)}` },
          pickRef: pick,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    let redFailures = 0;
    const redStart = Date.now();

    for (let i = 0; i < redItems.length; i += RED_CHUNK_SIZE) {
      const chunk = redItems.slice(i, i + RED_CHUNK_SIZE);
      const chunkResult = await mlbRedAnalystTask.batchTriggerAndWait(
        chunk.map(({ payload, options }) => ({ payload, options })),
      );
      chunkResult.runs.forEach((run, localIdx) => {
        const item = chunk[localIdx];
        if (!item) return;
        const pickRef = item.pickRef;
        if (run.ok) {
          const review = run.output.review;
          pickRef.redTeamReview = review;
          pickRef.preRedTeamConfidence = pickRef.finalConfidence;

          // Apply confidence adjustment only if evidence is sufficient.
          if (review.evidenceQuality === "sufficient") {
            const delta = Math.max(-15, Math.min(0, review.confidenceAdjustment));
            pickRef.finalConfidence = Math.max(10, Math.min(95, pickRef.finalConfidence + delta));
          }
        } else {
          redFailures++;
          console.warn(`[aggregator] red-analyst failed for ${pickRef.matchup} — ${pickRef.pickDescription}: ${String(run.error)}`);
        }
      });
    }

    const redElapsed = ((Date.now() - redStart) / 1000).toFixed(1);
    console.log(`[aggregator] Red-team complete in ${redElapsed}s (${redFailures} failures)`);

    // ── Phase 2c: re-rank after red-team adjustments and apply vetoes ───────
    const vetoedKeys = new Set(
      candidatePool
        .filter(p => p.redTeamReview?.vetoRecommended)
        .map(p => `${p.gameId}|${p.pickDescription}`),
    );
    const featuresEligible = eligible.filter(p => !vetoedKeys.has(`${p.gameId}|${p.pickDescription}`));

    const sorted = [...featuresEligible].sort((a, b) => b.finalConfidence - a.finalConfidence);
    // BOTD and Top 3 require ≥50% confidence floor. UOTD has no floor — picks
    // the best positive-odds bet regardless of confidence.
    const featured = sorted.filter(p => p.finalConfidence >= 50);
    const betOfDay = featured[0] ?? null;
    const underdog = featuresEligible
      .filter(p => p.odds > 0)
      .sort((a, b) => b.finalConfidence - a.finalConfidence)[0] ?? null;
    const top3 = featured.slice(0, 3);

    if (vetoedKeys.size > 0) {
      console.log(`[aggregator] Red-team vetoed ${vetoedKeys.size} pick(s); re-ranked from remaining ${featuresEligible.length} eligible`);
    }
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
      redTeamFailures: redFailures,
      redTeamVetoes: vetoedKeys.size,
    };
  },
});
