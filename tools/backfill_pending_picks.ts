#!/usr/bin/env node
// One-shot: backfills GameID for Pending picks that were logged without one,
// then resolves every Pending pick to Win/Loss/Push using final scores.
// Handles postponed games (officialDate ≠ scheduled date) via direct gameId lookup.
//
// Usage:
//   npx tsx tools/backfill_pending_picks.ts          # dry run — prints what would change
//   npx tsx tools/backfill_pending_picks.ts --apply  # patch Notion + resolve

import { readFileSync } from "fs";

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

const APPLY = process.argv.includes("--apply");
const TOKEN = process.env.NOTION_TOKEN!;
const PICKS_DS = process.env.NOTION_PICKS_DS_ID!;
if (!TOKEN || !PICKS_DS) { console.error("Missing NOTION_TOKEN or NOTION_PICKS_DS_ID"); process.exit(1); }

// ── Team abbreviation normalization ──────────────────────────────────────────
// MLB API uses ATH for Athletics, AZ for Diamondbacks, WSH for Nationals, etc.
// Notion data sometimes uses OAK, ARI, WAS — normalize both directions.
const ABBR_ALIASES: Record<string, string> = {
  OAK: "ATH", ATH: "ATH",
  ARI: "AZ",  AZ:  "AZ",
  WAS: "WSH", WSH: "WSH",
  CHW: "CWS", CWS: "CWS",
  KCR: "KC",  KC:  "KC",
  SDP: "SD",  SD:  "SD",
  SFG: "SF",  SF:  "SF",
  TBR: "TB",  TB:  "TB",
};
const norm = (a: string) => ABBR_ALIASES[a.toUpperCase()] ?? a.toUpperCase();

interface Pick {
  pageId: string;
  date: string;
  matchup: string;
  pick: string;
  odds: number;
  gameId: number | null;
}

async function notionPost(path: string, body: any): Promise<any> {
  const res = await fetch(`https://api.notion.com${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Notion-Version": "2025-09-03",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Notion ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function notionPatch(pageId: string, properties: any): Promise<void> {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Notion-Version": "2025-09-03",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) throw new Error(`Notion patch ${pageId} → ${res.status}: ${await res.text()}`);
}

async function getAllPending(): Promise<Pick[]> {
  const out: Pick[] = [];
  let cursor: string | undefined;
  do {
    const r = await notionPost(`/v1/data_sources/${PICKS_DS}/query`, {
      page_size: 100,
      start_cursor: cursor,
      filter: { property: "Result", select: { equals: "Pending" } },
    });
    for (const p of r.results as any[]) {
      out.push({
        pageId: p.id,
        date: p.properties?.Date?.date?.start ?? "",
        matchup: p.properties?.Matchup?.title?.[0]?.plain_text ?? "",
        pick: p.properties?.Pick?.rich_text?.[0]?.plain_text ?? "",
        odds: p.properties?.Odds?.number ?? 0,
        gameId: p.properties?.GameID?.number ?? null,
      });
    }
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

interface ScheduledGame { gameId: number; awayAbbr: string; homeAbbr: string }

const scheduleCache = new Map<string, ScheduledGame[]>();
async function getSchedule(date: string): Promise<ScheduledGame[]> {
  if (scheduleCache.has(date)) return scheduleCache.get(date)!;
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=team&gameType=R`;
  const res = await fetch(url);
  if (!res.ok) { scheduleCache.set(date, []); return []; }
  const data = await res.json() as any;
  const games: ScheduledGame[] = [];
  for (const de of data.dates ?? []) {
    for (const g of de.games ?? []) {
      games.push({
        gameId: g.gamePk,
        awayAbbr: norm(g.teams?.away?.team?.abbreviation ?? ""),
        homeAbbr: norm(g.teams?.home?.team?.abbreviation ?? ""),
      });
    }
  }
  scheduleCache.set(date, games);
  return games;
}

function findGameId(matchup: string, schedule: ScheduledGame[]): number | null {
  // "AWAY @ HOME"
  const parts = matchup.split("@").map(s => norm(s.trim()));
  const [awayAbbr = "", homeAbbr = ""] = parts;
  const match = schedule.find(g => g.awayAbbr === awayAbbr && g.homeAbbr === homeAbbr);
  return match?.gameId ?? null;
}

interface FinalScore { gameId: number; homeScore: number; awayScore: number; officialDate: string }

async function fetchGameFinal(gameId: number): Promise<FinalScore | null> {
  const res = await fetch(`https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`);
  if (!res.ok) return null;
  const d = await res.json() as any;
  if (d.gameData?.status?.abstractGameState !== "Final") return null;
  const home = d.liveData?.linescore?.teams?.home?.runs;
  const away = d.liveData?.linescore?.teams?.away?.runs;
  if (home == null || away == null) return null;
  return {
    gameId,
    homeScore: Number(home),
    awayScore: Number(away),
    officialDate: d.gameData?.datetime?.officialDate ?? "",
  };
}

function resolvePick(pick: string, homeScore: number, awayScore: number, matchup: string): "Win" | "Loss" | "Push" {
  const desc = pick.toLowerCase();
  const [awayAbbr = "", homeAbbr = ""] = matchup.split("@").map(s => norm(s.trim()).toLowerCase());

  // Totals
  const overMatch = desc.match(/\bover\b[\s(]*(\d+\.?\d*)/);
  const underMatch = desc.match(/\bunder\b[\s(]*(\d+\.?\d*)/);
  const totalScore = homeScore + awayScore;
  if (overMatch) {
    const line = parseFloat(overMatch[1] ?? "0");
    if (totalScore > line) return "Win";
    if (totalScore < line) return "Loss";
    return "Push";
  }
  if (underMatch) {
    const line = parseFloat(underMatch[1] ?? "0");
    if (totalScore < line) return "Win";
    if (totalScore > line) return "Loss";
    return "Push";
  }

  // Determine which team is picked
  const aliases: Record<string, string[]> = {
    laa: ["laa","angels"], az: ["az","ari","diamondbacks","arizona","d-backs"],
    bal: ["bal","orioles","baltimore"], bos: ["bos","red sox","boston"],
    chc: ["chc","cubs"], cin: ["cin","reds","cincinnati"],
    cle: ["cle","guardians","cleveland"], col: ["col","rockies","colorado"],
    det: ["det","tigers","detroit"], hou: ["hou","astros","houston"],
    kc: ["kc","royals","kansas city"], lad: ["lad","dodgers","los angeles"],
    wsh: ["wsh","nationals","washington","was"], nym: ["nym","mets"],
    ath: ["ath","oak","athletics","oakland"], pit: ["pit","pirates","pittsburgh"],
    sd: ["sd","padres","san diego"], sea: ["sea","mariners","seattle"],
    sf: ["sf","giants","san francisco"], stl: ["stl","cardinals","st. louis","st louis"],
    tb: ["tb","rays","tampa bay"], tex: ["tex","rangers","texas"],
    tor: ["tor","blue jays","toronto"], min: ["min","twins","minnesota"],
    phi: ["phi","phillies","philadelphia"], atl: ["atl","braves","atlanta"],
    cws: ["cws","white sox","chicago white sox"], mia: ["mia","marlins","miami"],
    nyy: ["nyy","yankees"], mil: ["mil","brewers","milwaukee"],
  };
  const inPick = (abbr: string) => (aliases[abbr.toLowerCase()] ?? [abbr.toLowerCase()]).some(f => desc.includes(f));

  const pickingHome = inPick(homeAbbr);
  const pickingAway = inPick(awayAbbr);
  const useHome = pickingHome || !pickingAway;
  const ours = useHome ? homeScore : awayScore;
  const theirs = useHome ? awayScore : homeScore;

  if (desc.includes("-1.5")) return ours - theirs >= 2 ? "Win" : "Loss";
  if (desc.includes("+1.5")) return ours - theirs >= -1 ? "Win" : "Loss";

  if (ours > theirs) return "Win";
  if (ours < theirs) return "Loss";
  return "Push";
}

// ── Main ─────────────────────────────────────────────────────────────────────
const pending = await getAllPending();
console.log(`\nBackfill — ${APPLY ? "APPLY" : "DRY RUN"}`);
console.log(`Pending picks: ${pending.length}`);
console.log("=".repeat(60));

let backfilledIds = 0, resolved = 0, stillStuck = 0, errors = 0;

for (const pick of pending) {
  let gameId = pick.gameId;

  // Backfill GameID by matching matchup to MLB schedule
  if (!gameId && pick.date && pick.matchup) {
    const schedule = await getSchedule(pick.date);
    const found = findGameId(pick.matchup, schedule);
    if (found) {
      gameId = found;
      console.log(`  [${pick.date}] ${pick.matchup} — backfill GameID=${found}`);
      if (APPLY) {
        try {
          await notionPatch(pick.pageId, { GameID: { number: found } });
          backfilledIds++;
        } catch (err) {
          console.warn(`    ✗ patch failed: ${err}`); errors++;
        }
      } else {
        backfilledIds++;
      }
    } else {
      console.warn(`  [${pick.date}] ${pick.matchup} — could not match to schedule`);
      stillStuck++;
      continue;
    }
  }

  if (!gameId) { stillStuck++; continue; }

  // Resolve via direct game lookup (handles postponed games)
  const final = await fetchGameFinal(gameId);
  if (!final) {
    console.log(`  [${pick.date}] ${pick.matchup} (gid=${gameId}) — not yet Final, skipping`);
    stillStuck++;
    continue;
  }

  const result = resolvePick(pick.pick, final.homeScore, final.awayScore, pick.matchup);
  const note = final.officialDate && final.officialDate !== pick.date
    ? ` (played ${final.officialDate}, originally ${pick.date})` : "";
  const icon = result === "Win" ? "✓" : result === "Loss" ? "✗" : "=";
  console.log(`  ${icon} [${pick.date}] ${pick.matchup} | ${pick.pick} | ${final.awayScore}-${final.homeScore} → ${result}${note}`);

  if (APPLY) {
    try {
      await notionPatch(pick.pageId, { Result: { select: { name: result } } });
      resolved++;
    } catch (err) {
      console.warn(`    ✗ patch failed: ${err}`); errors++;
    }
  } else {
    resolved++;
  }
}

console.log("\n" + "=".repeat(60));
console.log(`GameIDs backfilled: ${backfilledIds}`);
console.log(`Picks resolved:     ${resolved}`);
console.log(`Still pending:      ${stillStuck}`);
console.log(`Errors:             ${errors}`);
if (!APPLY) console.log("\n(dry run — re-run with --apply to write to Notion)");
