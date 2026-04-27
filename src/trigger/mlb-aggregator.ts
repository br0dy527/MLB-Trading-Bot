// Aggregator: orchestrates the green-team fleet. Phase 2 fans every game out
// in parallel via batchTriggerAndWait. Free-tier concurrency cap (10) is
// handled automatically by Trigger.dev — runs queue and dequeue as slots open.

import { task } from "@trigger.dev/sdk/v3";
import {
  createDailyReport, logPick, archivePicksForDate,
  findReportByDate, updateDailyReport, findPicksByDate, updatePickRow,
  type DailyReportData, type PickToLog, type PickDetail, type Lesson,
  type BetTypeTag,
} from "../lib/notion.js";
import {
  buildPerformanceContext, buildReportMarkdown, impliedProb,
  type GamePickResult,
} from "../lib/analysis-shared.js";
import type { FetchDataResult } from "./mlb-fetch-data.js";
import { mlbGreenAnalystTask } from "./mlb-green-analyst.js";
import { mlbRedAnalystTask } from "./mlb-red-analyst.js";

export type RunMode = "morning" | "afternoon";

export interface AggregatorPayload {
  fetchResult: FetchDataResult;
  runningRecord: { wins: number; losses: number; pushes: number; roiUnits: number };
  yesterdayScorecard: string;
  recentPicks: PickDetail[];
  lessons?: Lesson[];
  /** Run mode. "afternoon" updates the existing Daily Report + Picks Tracker
   *  rows in place instead of creating duplicates. Defaults to "morning". */
  mode?: RunMode;
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
    const mode: RunMode = payload.mode ?? "morning";
    console.log(`[aggregator] mode=${mode}`);

    if (fetchResult.games.length === 0) {
      throw new Error("No games to analyze — fetch returned empty schedule");
    }

    console.log(`[aggregator] ${fetchResult.games.length} games for ${fetchResult.date}`);
    console.log(`[aggregator] ${recentPicks.length} recent picks loaded for calibration`);

    const performanceContext = buildPerformanceContext(recentPicks);

    // ── Lineup-confirmed-skip optimization (afternoon only) ─────────────────
    // For games where morning's analysis was already made with a confirmed
    // lineup AND the afternoon fetch still shows the same lineup-confirmed
    // state, carry over the morning pick verbatim. Skip the green/red analyst
    // calls — the analysis is already done. This saves Anthropic API tokens
    // on later afternoon runs once early-game lineups have posted.
    const carriedOverPicks: GamePickResult[] = [];
    const skippedGameIds = new Set<number>();

    if (mode === "afternoon") {
      try {
        const morningPicks = await findPicksByDate(fetchResult.date);
        const morningByGameId = new Map(morningPicks.map(p => [p.gameId, p]));
        for (const game of fetchResult.games) {
          const m = morningByGameId.get(game.gameId);
          if (!m) continue;
          // Notes contains "⚠️ LINEUP PENDING" iff morning analyzed without a
          // confirmed lineup. Confirmed lineups don't un-confirm later, so if
          // morning had it locked in, afternoon's analysis would be redundant.
          const morningWasPending = /lineup\s*pending/i.test(m.notes);
          if (!morningWasPending) {
            skippedGameIds.add(game.gameId);
            carriedOverPicks.push(reconstructPickFromMorningRow(m, game));
          }
        }
        if (skippedGameIds.size > 0) {
          console.log(`[aggregator] Skipping green/red for ${skippedGameIds.size} games — morning lineups already confirmed: ${Array.from(skippedGameIds).join(", ")}`);
        } else {
          console.log("[aggregator] No games eligible for skip — morning had all lineups pending");
        }
      } catch (err) {
        console.warn(`[aggregator] Skip-optimization read failed; re-grading all games: ${err}`);
      }
    }

    const gamesToAnalyze = fetchResult.games.filter(g => !skippedGameIds.has(g.gameId));

    // ── Phase 1: dispatch green-team analysts in parallel ───────────────────
    // batchTriggerAndWait preserves input order in the result array, so we can
    // correlate each result back to gamesToAnalyze[i].
    const items = gamesToAnalyze.map(game => ({
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
        const matchup = gamesToAnalyze[globalIdx + localIdx]?.matchup ?? `idx=${globalIdx + localIdx}`;
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

    // Merge carried-over morning picks into the pool used for ranking + report
    if (carriedOverPicks.length > 0) {
      picks.push(...carriedOverPicks);
      console.log(`[aggregator] Merged ${carriedOverPicks.length} carried-over morning picks into the pool`);
    }

    if (picks.length === 0) {
      throw new Error(`All ${fetchResult.games.length} green-analyst calls failed and no carry-overs — aborting`);
    }

    console.log(`[aggregator] Collected ${picks.length}/${fetchResult.games.length} picks in ${elapsed}s (${failures} green failures, ${carriedOverPicks.length} carried over)`);

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

    // ── Publish: morning creates fresh; afternoon updates morning's report in place ─
    let notionPageUrl: string;
    let existingReportPageId: string | null = null;
    if (mode === "afternoon") {
      existingReportPageId = await findReportByDate(fetchResult.date);
      if (!existingReportPageId) {
        console.log(`[aggregator] mode=afternoon but no morning report found for ${fetchResult.date} — falling back to create`);
      }
    }

    if (existingReportPageId) {
      await updateDailyReport(existingReportPageId, reportData);
      notionPageUrl = `https://notion.so/${existingReportPageId.replace(/-/g, "")}`;
      console.log(`[aggregator] Report updated in place: ${notionPageUrl}`);
    } else {
      notionPageUrl = await createDailyReport(reportData);
      console.log(`[aggregator] Report created: ${notionPageUrl}`);
    }

    // Picks Tracker: morning archives + re-logs; afternoon updates rows by GameID.
    let picksLogged = 0;
    const eligiblePicks = picks.filter(p => !p.noEligibleBet);

    // Stamp the lineup-pending marker into notes so the next afternoon run's
    // skip optimization can detect morning's lineup-confirmed state from the
    // Picks Tracker row alone (no extra Notion property needed).
    const stampNotes = (p: GamePickResult): string => {
      const base = p.notes ?? "";
      if (p.lineupPending && !/lineup\s*pending/i.test(base)) {
        return `⚠️ LINEUP PENDING — ${base}`;
      }
      return base;
    };

    if (mode === "afternoon" && existingReportPageId) {
      // Update existing rows by GameID; create new for unmatched (defensive)
      const existingPicks = await findPicksByDate(fetchResult.date);
      const existingByGameId = new Map(existingPicks.map(p => [p.gameId, p]));

      for (const p of eligiblePicks) {
        const betTypes: BetTypeTag[] = [];
        if (p === betOfDay) betTypes.push("Bet of Day");
        if (p === underdog) betTypes.push("Underdog");
        if (top3.includes(p)) betTypes.push("Top 3");
        if (betTypes.length === 0) betTypes.push("Game Pick");

        const existing = existingByGameId.get(p.gameId);
        try {
          if (existing) {
            await updatePickRow(existing.pageId, {
              pick: p.pickDescription,
              betTypes,
              odds: p.odds,
              impliedProbPct: impliedProb(p.odds),
              confidence: p.finalConfidence,
              notes: stampNotes(p),
            });
          } else {
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
              notes: stampNotes(p),
              reportUrl: notionPageUrl,
            });
          }
          picksLogged++;
        } catch (err) {
          console.error(`[aggregator] Failed to update/log pick ${p.matchup}: ${err}`);
        }
      }
      console.log(`[aggregator] Updated ${picksLogged} picks (afternoon mode, in place)`);
    } else {
      // Morning (or afternoon fallback when no morning report exists): wipe + re-log
      const archivedCount = await archivePicksForDate(fetchResult.date);
      if (archivedCount > 0) {
        console.log(`[aggregator] Archived ${archivedCount} stale picks for ${fetchResult.date}`);
      }

      for (const p of eligiblePicks) {
        const betTypes: BetTypeTag[] = [];
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
            notes: stampNotes(p),
            reportUrl: notionPageUrl,
          });
          picksLogged++;
        } catch (err) {
          console.error(`[aggregator] Failed to log pick ${p.matchup}: ${err}`);
        }
      }
      console.log(`[aggregator] Logged ${picksLogged} picks (morning mode, fresh)`);
    }

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

// ─── Reconstruct a GamePickResult from a morning Picks Tracker row ───────────
// Used in afternoon mode when we skip the green/red analyst for a game whose
// lineup was already confirmed in the morning. The reconstructed pick has
// limited per-game body content (the full morning analysis lives on the
// existing Daily Report page); the pickDescription / odds / confidence fields
// are accurate. The All-Games section will note the carry-over explicitly.
function reconstructPickFromMorningRow(
  m: import("../lib/notion.js").ExistingPick,
  game: FetchDataResult["games"][number],
): GamePickResult {
  // Parse the team and bet type heuristically from the pick text.
  const pickLower = m.pick.toLowerCase();
  let betType: GamePickResult["betType"] = "ML";
  if (pickLower.includes("over")) betType = "OVER";
  else if (pickLower.includes("under")) betType = "UNDER";
  else if (pickLower.includes("+1.5")) betType = "RL_PLUS_1_5";
  else if (pickLower.includes("-1.5")) betType = "RL_MINUS_1_5";

  // Pick team: best effort by matching full name or matchup abbreviation.
  // CompiledGame.matchup looks like "TB @ CLE"; the away abbr precedes "@".
  const matchupParts = (game.matchup ?? "").split("@").map(s => s.trim().toUpperCase());
  const awayAbbr = matchupParts[0] ?? "";
  const homeAbbr = matchupParts[1] ?? "";
  let pickTeam = m.homeTeam;
  if (m.awayTeam && pickLower.includes(m.awayTeam.toLowerCase())) pickTeam = m.awayTeam;
  else if (homeAbbr && m.pick.toUpperCase().startsWith(homeAbbr)) pickTeam = m.homeTeam;
  else if (awayAbbr && m.pick.toUpperCase().startsWith(awayAbbr)) pickTeam = m.awayTeam;

  const spRating = (["Strong", "Neutral", "Weak"].includes(m.spMatchupRating)
    ? m.spMatchupRating
    : "Neutral") as "Strong" | "Neutral" | "Weak";

  const placeholder: import("../lib/analysis-shared.js").PillarResult = {
    direction: "NEUTRAL",
    notes: "Carried over from morning analysis (lineup confirmed in both runs).",
  };

  return {
    gameId: m.gameId,
    matchup: m.matchup,
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    venue: game.venue ?? "",
    pickTeam,
    betType,
    pickDescription: m.pick,
    odds: m.odds,
    eligible: true,
    noEligibleBet: false,
    noEligibleBetReason: null,
    pillars: {
      p1_sp_matchup: placeholder,
      p2_lineup_splits: placeholder,
      p3_bullpen: placeholder,
      p4_home_away: placeholder,
      p5_form: placeholder,
      p6_weather: placeholder,
      p7_travel: placeholder,
      p8_line_movement: placeholder,
      p9_motivation: placeholder,
      p10_h2h: placeholder,
    },
    rawScore: 0,
    baseConfidence: m.confidence,
    adjustments: [],
    finalConfidence: m.confidence,
    caseFor: "Carried over from morning analysis — lineup was already confirmed at 12:15 PM ET and remains confirmed. See the morning Bet of Day / Top 3 sections (preserved on this page) for the full pillar breakdown.",
    caseAgainst: "See morning analysis. Afternoon re-run did not re-grade this game because no lineup data changed.",
    verdict: m.notes.length > 0 ? m.notes : "Carry-over verdict — see morning section above.",
    lineupPending: false,
    spMatchupRating: spRating,
    notes: m.notes,
  };
}
