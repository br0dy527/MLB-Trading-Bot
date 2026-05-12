#!/usr/bin/env node
// Read-only diagnostic scan of Notion state. Surfaces any data inconsistencies
// the daily pipeline should clean up, plus a few patterns worth eyeballing.
//
// Usage:  npx tsx tools/health_scan.ts

import { readFileSync } from "fs";

const envPath = `${process.cwd()}/.env`;
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  const v = t.slice(eq + 1).trim();
  if (k && !(k in process.env)) process.env[k] = v;
}

const TOKEN = process.env.NOTION_TOKEN!;
const PICKS_DS = process.env.NOTION_PICKS_DS_ID!;
const REPORTS_DS = process.env.NOTION_REPORTS_DS_ID!;

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

async function queryAll(dsId: string): Promise<any[]> {
  const all: any[] = [];
  let cursor: string | undefined;
  do {
    const r = await notionPost(`/v1/data_sources/${dsId}/query`, { page_size: 100, start_cursor: cursor });
    all.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return all;
}

const today = new Date().toISOString().split("T")[0]!;
const daysAgo = (d: string) => {
  const ms = Date.parse(today + "T00:00:00Z") - Date.parse(d + "T00:00:00Z");
  return Math.floor(ms / 86400000);
};

console.log(`\nMLB Bot — Health Scan (${today})`);
console.log("=".repeat(60));

const [picks, reports] = await Promise.all([queryAll(PICKS_DS), queryAll(REPORTS_DS)]);
console.log(`\nLoaded: ${picks.length} picks, ${reports.length} reports`);

// ── 1. Duplicate reports per date ──────────────────────────────────────────
const reportsByDate = new Map<string, any[]>();
for (const r of reports) {
  const title = r.properties?.Date?.title?.[0]?.plain_text ?? "";
  const stripped = title.replace(/^[A-Za-z]+,\s*/, "");
  const t = Date.parse(stripped);
  const date = isNaN(t) ? null : new Date(t).toISOString().split("T")[0]!;
  if (!date) continue;
  if (!reportsByDate.has(date)) reportsByDate.set(date, []);
  reportsByDate.get(date)!.push(r);
}
const dupeReportDates = [...reportsByDate.entries()].filter(([, v]) => v.length > 1);
console.log(`\n[1] Duplicate Daily Reports: ${dupeReportDates.length} dates with >1 report`);
for (const [d, list] of dupeReportDates) console.log(`     ${d}: ${list.length} reports`);

// ── 2. Picks with missing GameID ──────────────────────────────────────────
const noGid = picks.filter(p => p.properties?.GameID?.number == null);
console.log(`\n[2] Picks missing GameID: ${noGid.length}`);
for (const p of noGid.slice(0, 10)) {
  console.log(`     ${p.properties?.Date?.date?.start ?? "?"}  ${p.properties?.Matchup?.title?.[0]?.plain_text ?? "?"}`);
}

// ── 3. Duplicate picks for same (date, gameId) ────────────────────────────
const byDateGame = new Map<string, any[]>();
for (const p of picks) {
  const d = p.properties?.Date?.date?.start;
  const gid = p.properties?.GameID?.number;
  if (!d || !gid) continue;
  const key = `${d}|${gid}`;
  if (!byDateGame.has(key)) byDateGame.set(key, []);
  byDateGame.get(key)!.push(p);
}
const dupePickKeys = [...byDateGame.entries()].filter(([, v]) => v.length > 1);
console.log(`\n[3] Duplicate picks for same (date, gameId): ${dupePickKeys.length} keys`);
for (const [k, list] of dupePickKeys.slice(0, 15)) {
  const [d, gid] = k.split("|");
  console.log(`     ${d}  gid=${gid}  → ${list.length} picks`);
  for (const p of list) {
    const pick = p.properties?.Pick?.rich_text?.[0]?.plain_text ?? "?";
    const bt = (p.properties?.["Bet Type"]?.multi_select ?? []).map((o: any) => o.name).join(",");
    const res = p.properties?.Result?.select?.name ?? "?";
    const created = p.created_time;
    console.log(`        ${created}  [${bt}]  ${res}  ${pick}`);
  }
}

// ── 4. Stale Pending picks (>3 days old, not the known postponed ones) ─────
const stalePending = picks
  .filter(p => p.properties?.Result?.select?.name === "Pending")
  .filter(p => {
    const d = p.properties?.Date?.date?.start;
    return d && daysAgo(d) > 3;
  });
console.log(`\n[4] Pending picks older than 3 days: ${stalePending.length}`);
for (const p of stalePending) {
  const d = p.properties?.Date?.date?.start;
  const m = p.properties?.Matchup?.title?.[0]?.plain_text ?? "?";
  const gid = p.properties?.GameID?.number ?? "none";
  console.log(`     [${d}] ${m}  GameID=${gid}  (${daysAgo(d!)}d old)`);
}

// ── 5. Reports with BOTD Result still Pending where all picks resolved ─────
console.log(`\n[5] Reports where BOTD Result=Pending but all picks for that date resolved:`);
let staleReportCount = 0;
for (const [date, list] of reportsByDate) {
  const dayPicks = picks.filter(p => p.properties?.Date?.date?.start === date);
  if (dayPicks.length === 0) continue;
  const allResolved = dayPicks.every(p => {
    const r = p.properties?.Result?.select?.name;
    return r === "Win" || r === "Loss" || r === "Push";
  });
  if (!allResolved) continue;
  for (const r of list) {
    const botdResult = r.properties?.["BOTD Result"]?.select?.name;
    if (botdResult === "Pending") {
      console.log(`     [${date}] BOTD Result still Pending (${dayPicks.length} picks all resolved)`);
      staleReportCount++;
    }
  }
}
if (staleReportCount === 0) console.log(`     (none)`);

// ── 6. Picks with empty Bet Type ──────────────────────────────────────────
const emptyBetType = picks.filter(p => {
  const ms = p.properties?.["Bet Type"]?.multi_select ?? [];
  return ms.length === 0;
});
console.log(`\n[6] Picks with empty Bet Type: ${emptyBetType.length}`);
for (const p of emptyBetType.slice(0, 5)) {
  console.log(`     ${p.properties?.Date?.date?.start ?? "?"}  ${p.properties?.Matchup?.title?.[0]?.plain_text ?? "?"}`);
}

// ── 7. Confidence outliers (>95 or <0 or null) ────────────────────────────
const confOutliers = picks.filter(p => {
  const c = p.properties?.Confidence?.number;
  return c == null || c > 95 || c < 0;
});
console.log(`\n[7] Confidence outliers (>95 / <0 / null): ${confOutliers.length}`);
for (const p of confOutliers.slice(0, 5)) {
  console.log(`     ${p.properties?.Date?.date?.start ?? "?"}  ${p.properties?.Matchup?.title?.[0]?.plain_text ?? "?"}  conf=${p.properties?.Confidence?.number}`);
}

// ── 8. Bet of Day picks below 50% floor ───────────────────────────────────
const lowFloorBotd = picks.filter(p => {
  const bt = p.properties?.["Bet Type"]?.multi_select ?? [];
  const isBotd = bt.some((o: any) => o.name === "Bet of Day");
  const c = p.properties?.Confidence?.number ?? 0;
  return isBotd && c > 0 && c < 50;
});
console.log(`\n[8] Bet of Day picks below 50% floor: ${lowFloorBotd.length}`);
for (const p of lowFloorBotd.slice(0, 10)) {
  console.log(`     ${p.properties?.Date?.date?.start ?? "?"}  ${p.properties?.Matchup?.title?.[0]?.plain_text ?? "?"}  conf=${p.properties?.Confidence?.number}`);
}

// ── 9. Bet Type tag count audit per date (>1 BOTD, >3 Top 3) ──────────────
const tagAudit: string[] = [];
const picksByDate = new Map<string, any[]>();
for (const p of picks) {
  const d = p.properties?.Date?.date?.start;
  if (!d) continue;
  if (!picksByDate.has(d)) picksByDate.set(d, []);
  picksByDate.get(d)!.push(p);
}
for (const [d, list] of picksByDate) {
  const tagCount = (tag: string) => list.filter(p =>
    (p.properties?.["Bet Type"]?.multi_select ?? []).some((o: any) => o.name === tag)).length;
  const botd = tagCount("Bet of Day");
  const top3 = tagCount("Top 3");
  const uotd = tagCount("Underdog");
  if (botd > 1) tagAudit.push(`     [${d}] ${botd} picks tagged Bet of Day (expected 0-1)`);
  if (top3 > 3) tagAudit.push(`     [${d}] ${top3} picks tagged Top 3 (expected 0-3)`);
  if (uotd > 1) tagAudit.push(`     [${d}] ${uotd} picks tagged Underdog (expected 0-1)`);
}
console.log(`\n[9] Featured-tag count anomalies: ${tagAudit.length}`);
for (const line of tagAudit.slice(0, 20)) console.log(line);

// ── 10. Summary ────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(60)}`);
console.log(`Issues found:`);
console.log(`  Duplicate report dates:        ${dupeReportDates.length}`);
console.log(`  Picks missing GameID:          ${noGid.length}`);
console.log(`  Duplicate (date,gameId) picks: ${dupePickKeys.length}`);
console.log(`  Stale pending picks (>3d):     ${stalePending.length}`);
console.log(`  Reports stale BOTD Result:     ${staleReportCount}`);
console.log(`  Picks with empty Bet Type:     ${emptyBetType.length}`);
console.log(`  Confidence outliers:           ${confOutliers.length}`);
console.log(`  BOTD < 50% floor:              ${lowFloorBotd.length}`);
console.log(`  Featured-tag anomalies:        ${tagAudit.length}`);
