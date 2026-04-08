#!/usr/bin/env node
// One-shot: dedup picks for a given date and score them against final MLB results.
// Usage:  npx tsx tools/score_yesterday.ts [YYYY-MM-DD]
// Default date: yesterday

import { readFileSync } from "fs";
import { Client } from "@notionhq/client";

// ── Load .env ──────────────────────────────────────────────────────────────────
const envPath = `${process.cwd()}/.env`;
const envLines = readFileSync(envPath, "utf8").split("\n");
for (const line of envLines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const val = trimmed.slice(eq + 1).trim();
  if (key && !(key in process.env)) process.env[key] = val;
}

// ── Config ─────────────────────────────────────────────────────────────────────
const DATE = process.argv[2] ?? (() => {
  const d = new Date(Date.now() - 86400000);
  return d.toISOString().split("T")[0];
})();

const NOTION_TOKEN   = process.env.NOTION_TOKEN!;
const PICKS_DS_ID    = process.env.NOTION_PICKS_DS_ID!; // collection/data source ID (not DB page ID)

if (!NOTION_TOKEN || !PICKS_DS_ID) {
  console.error("Missing NOTION_TOKEN or NOTION_PICKS_DS_ID in .env");
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });

// ── Types ──────────────────────────────────────────────────────────────────────
interface Pick {
  pageId: string;
  createdTime: string;
  matchup: string;
  pick: string;
  betType: string;
  odds: number;
  gameId: number;
  reportLink: string;
}

// ── Step 1: Fetch all picks for DATE ──────────────────────────────────────────
async function fetchAllPicksForDate(date: string): Promise<Pick[]> {
  const picks: Pick[] = [];
  let cursor: string | undefined;

  do {
    const res = await notion.dataSources.query({
      data_source_id: PICKS_DS_ID,
      start_cursor: cursor,
      filter: { property: "Date", date: { equals: date } },
    } as any);

    for (const page of res.results) {
      if (page.object !== "page") continue;
      const p = page as any;
      picks.push({
        pageId: p.id,
        createdTime: p.created_time,
        matchup: p.properties["Matchup"]?.title?.[0]?.plain_text ?? "",
        pick: p.properties["Pick"]?.rich_text?.[0]?.plain_text ?? "",
        betType: p.properties["Bet Type"]?.select?.name ?? "",
        odds: p.properties["Odds"]?.number ?? 0,
        gameId: p.properties["GameID"]?.number ?? 0,
        reportLink: p.properties["Report Link"]?.url ?? "",
      });
    }
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return picks;
}

// ── Step 2: Dedup — keep newest per GameID, archive the rest ──────────────────
async function dedup(picks: Pick[]): Promise<Pick[]> {
  const byGame = new Map<number, Pick[]>();
  const noGameId: Pick[] = [];

  for (const p of picks) {
    if (!p.gameId) { noGameId.push(p); continue; }
    if (!byGame.has(p.gameId)) byGame.set(p.gameId, []);
    byGame.get(p.gameId)!.push(p);
  }

  const keepers: Pick[] = [...noGameId];
  const toArchive: Pick[] = [];

  for (const [gameId, group] of byGame) {
    // Sort newest first
    group.sort((a, b) => b.createdTime.localeCompare(a.createdTime));
    keepers.push(group[0]!);
    if (group.length > 1) {
      console.log(`  GameID ${gameId} (${group[0]!.matchup}): ${group.length} duplicates — keeping newest, archiving ${group.length - 1}`);
      toArchive.push(...group.slice(1));
    }
  }

  if (toArchive.length === 0) {
    console.log("  No duplicates found.");
    return keepers;
  }

  console.log(`  Archiving ${toArchive.length} duplicate pages...`);
  await Promise.all(
    toArchive.map(p =>
      notion.pages.update({ page_id: p.pageId, archived: true } as any)
        .then(() => console.log(`    ✓ Archived ${p.matchup} (${p.createdTime})`))
        .catch(err => console.warn(`    ✗ Failed to archive ${p.pageId}: ${err}`))
    )
  );

  return keepers;
}

// ── Step 3: Fetch final scores from MLB Stats API ─────────────────────────────
interface FinalScore { gameId: number; homeScore: number; awayScore: number }

async function fetchFinalScores(date: string): Promise<Map<number, FinalScore>> {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore,team&gameType=R`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB API error: ${res.status}`);

  const data = await res.json() as any;
  const map = new Map<number, FinalScore>();

  for (const dateEntry of (data.dates ?? [])) {
    for (const game of (dateEntry.games ?? [])) {
      if (game.status?.abstractGameState !== "Final") continue;
      const homeScore = game.linescore?.teams?.home?.runs ?? game.teams?.home?.score;
      const awayScore = game.linescore?.teams?.away?.runs ?? game.teams?.away?.score;
      if (homeScore !== undefined && awayScore !== undefined) {
        map.set(game.gamePk, {
          gameId: game.gamePk,
          homeScore: Number(homeScore),
          awayScore: Number(awayScore),
        });
      }
    }
  }

  return map;
}

// ── Step 4: Resolve a pick against final score ────────────────────────────────
function resolvePick(
  pick: string,
  odds: number,
  homeScore: number,
  awayScore: number,
  matchup: string
): "Win" | "Loss" | "Push" {
  const desc = pick.toLowerCase();
  const [awayAbbr = "", homeAbbr = ""] = matchup.split(" @ ").map(s => s.trim().toLowerCase());

  const pickingHome = homeAbbr
    ? desc.includes(homeAbbr) && !desc.includes(awayAbbr)
    : !desc.includes(awayAbbr);

  const ourScore   = pickingHome ? homeScore : awayScore;
  const theirScore = pickingHome ? awayScore : homeScore;
  const totalScore = homeScore + awayScore;

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
  if (desc.includes("-1.5")) {
    return ourScore - theirScore > 1 ? "Win" : "Loss";
  }
  if (desc.includes("+1.5")) {
    return ourScore - theirScore >= -1 ? "Win" : "Loss";
  }

  // Moneyline
  if (ourScore > theirScore) return "Win";
  if (ourScore < theirScore) return "Loss";
  return "Push";
}

// ── Step 5: Score and update picks ────────────────────────────────────────────
async function scorePicks(picks: Pick[], scores: Map<number, FinalScore>) {
  let wins = 0, losses = 0, pushes = 0, noScore = 0;

  for (const pick of picks) {
    const score = scores.get(pick.gameId);
    if (!score) {
      console.log(`  ⚠ No final score for ${pick.matchup} (GameID ${pick.gameId}) — skipping`);
      noScore++;
      continue;
    }

    const result = resolvePick(pick.pick, pick.odds, score.homeScore, score.awayScore, pick.matchup);

    await notion.pages.update({
      page_id: pick.pageId,
      properties: { Result: { select: { name: result } } },
    });

    const icon = result === "Win" ? "✅" : result === "Loss" ? "❌" : "➖";
    console.log(`  ${icon} ${pick.matchup} | ${pick.pick} | ${score.awayScore}-${score.homeScore} → ${result}`);

    if (result === "Win") wins++;
    else if (result === "Loss") losses++;
    else pushes++;
  }

  return { wins, losses, pushes, noScore };
}

// ── Main ───────────────────────────────────────────────────────────────────────
console.log(`\nMLB Pick Scorer — ${DATE}`);
console.log("=".repeat(40));

console.log("\n[1] Fetching all picks for date...");
const allPicks = await fetchAllPicksForDate(DATE);
console.log(`  Found ${allPicks.length} total picks`);

console.log("\n[2] Deduplicating by GameID (keeping newest)...");
const picks = await dedup(allPicks);
console.log(`  ${picks.length} picks remain after dedup`);

console.log("\n[3] Fetching final scores from MLB Stats API...");
const scores = await fetchFinalScores(DATE);
console.log(`  ${scores.size} final scores found`);

if (scores.size === 0) {
  console.log("\n  No final scores available — games may not have finished yet.");
  process.exit(0);
}

console.log("\n[4] Scoring picks...");
const { wins, losses, pushes, noScore } = await scorePicks(picks, scores);

const total = wins + losses + pushes;
const winPct = total > 0 ? Math.round(wins / total * 1000) / 10 : 0;

console.log(`\n${"=".repeat(40)}`);
console.log(`Result: ${wins}W - ${losses}L - ${pushes}P  (${winPct}%)`);
if (noScore > 0) console.log(`  ⚠ ${noScore} picks had no matching final score`);
console.log("");
