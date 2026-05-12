#!/usr/bin/env node
// Comprehensive cleanup after the dual-pipeline era:
//   1. Dedup duplicate (date, gameId) Picks Tracker rows — keep newest, archive rest.
//   2. After dedup, enforce featured-tag uniqueness per date:
//      - exactly one "Bet of Day" (highest Confidence among any tagged)
//      - exactly one "Underdog" (highest Confidence with positive odds among any tagged)
//      - at most three "Top 3" (top 3 by Confidence among any tagged)
//      Picks demoted off a featured tag keep their other tags; if they end up
//      with no tag, "Game Pick" is added.
//   3. Refresh every Daily Report's BOTD Result / UOTD Result / Top 3 Record
//      from the resolved Picks Tracker state.
//
// Usage:
//   npx tsx tools/cleanup_picks_and_reports.ts          # dry run
//   npx tsx tools/cleanup_picks_and_reports.ts --apply

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

const APPLY = process.argv.includes("--apply");
const TOKEN = process.env.NOTION_TOKEN!;
const PICKS_DS = process.env.NOTION_PICKS_DS_ID!;
const REPORTS_DS = process.env.NOTION_REPORTS_DS_ID!;

async function notionPost(path: string, body: any): Promise<any> {
  const res = await fetch(`https://api.notion.com${path}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${TOKEN}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Notion ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function notionPatch(pageId: string, body: any): Promise<void> {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: { "Authorization": `Bearer ${TOKEN}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Notion patch ${pageId} → ${res.status}: ${await res.text()}`);
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

function getProps(p: any) {
  return {
    pageId: p.id as string,
    createdTime: p.created_time as string,
    date: (p.properties?.Date?.date?.start ?? "") as string,
    matchup: (p.properties?.Matchup?.title?.[0]?.plain_text ?? "") as string,
    pick: (p.properties?.Pick?.rich_text?.[0]?.plain_text ?? "") as string,
    betTypes: (p.properties?.["Bet Type"]?.multi_select ?? []).map((o: any) => o.name) as string[],
    odds: (p.properties?.Odds?.number ?? 0) as number,
    confidence: (p.properties?.Confidence?.number ?? 0) as number,
    gameId: (p.properties?.GameID?.number ?? null) as number | null,
    result: (p.properties?.Result?.select?.name ?? "Pending") as string,
  };
}

console.log(`\nCleanup — ${APPLY ? "APPLY" : "DRY RUN"}`);
console.log("=".repeat(60));

const picks = await queryAll(PICKS_DS);
console.log(`Loaded ${picks.length} picks.`);

// ── 1. Dedup (date, gameId) — keep newest ────────────────────────────────────
const byKey = new Map<string, any[]>();
for (const p of picks) {
  const d = p.properties?.Date?.date?.start;
  const gid = p.properties?.GameID?.number;
  if (!d || !gid) continue;
  const key = `${d}|${gid}`;
  if (!byKey.has(key)) byKey.set(key, []);
  byKey.get(key)!.push(p);
}

const toArchive: any[] = [];
const survivors = new Set<string>(picks.map(p => p.id));
for (const [, group] of byKey) {
  if (group.length <= 1) continue;
  group.sort((a, b) => b.created_time.localeCompare(a.created_time));
  for (const dupe of group.slice(1)) {
    toArchive.push(dupe);
    survivors.delete(dupe.id);
  }
}

console.log(`\n[Phase 1] Duplicate (date, gameId) rows to archive: ${toArchive.length}`);
for (const p of toArchive.slice(0, 10)) {
  const v = getProps(p);
  console.log(`  archive  ${v.date} ${v.matchup} gid=${v.gameId} created=${v.createdTime} [${v.betTypes.join(",")}] ${v.pick}`);
}
if (toArchive.length > 10) console.log(`  ... and ${toArchive.length - 10} more`);

if (APPLY) {
  let archived = 0, errors = 0;
  for (const p of toArchive) {
    try { await notionPatch(p.id, { archived: true }); archived++; }
    catch (err) { console.warn(`    ✗ ${p.id}: ${err}`); errors++; }
  }
  console.log(`  Archived ${archived}/${toArchive.length} (${errors} errors)`);
}

// ── 2. Enforce featured-tag uniqueness per date ──────────────────────────────
const survivingPicks = picks.filter(p => survivors.has(p.id)).map(getProps);

const byDate = new Map<string, ReturnType<typeof getProps>[]>();
for (const p of survivingPicks) {
  if (!p.date) continue;
  if (!byDate.has(p.date)) byDate.set(p.date, []);
  byDate.get(p.date)!.push(p);
}

interface TagUpdate { pageId: string; oldTags: string[]; newTags: string[] }
const tagUpdates: TagUpdate[] = [];

for (const [date, dayPicks] of byDate) {
  // Determine canonical featured picks from confidence
  const eligible = dayPicks.filter(p => p.confidence > 0);
  const sorted = [...eligible].sort((a, b) => b.confidence - a.confidence);
  const eligibleForFeature = sorted.filter(p => p.confidence >= 50);

  const canonicalBOTD = eligibleForFeature[0]?.pageId ?? null;
  const canonicalTop3 = new Set(eligibleForFeature.slice(0, 3).map(p => p.pageId));
  const canonicalUOTD = eligible
    .filter(p => p.odds > 0)
    .sort((a, b) => b.confidence - a.confidence)[0]?.pageId ?? null;

  for (const p of dayPicks) {
    const expected = new Set<string>();
    if (p.pageId === canonicalBOTD) expected.add("Bet of Day");
    if (p.pageId === canonicalUOTD) expected.add("Underdog");
    if (canonicalTop3.has(p.pageId)) expected.add("Top 3");
    if (expected.size === 0) expected.add("Game Pick");

    const current = new Set(p.betTypes);
    if (current.size === expected.size && [...expected].every(t => current.has(t))) continue;

    tagUpdates.push({ pageId: p.pageId, oldTags: p.betTypes, newTags: [...expected] });
  }
}

console.log(`\n[Phase 2] Pick rows needing Bet Type tag refresh: ${tagUpdates.length}`);
for (const u of tagUpdates.slice(0, 10)) {
  console.log(`  ${u.pageId.slice(-8)}: [${u.oldTags.join(",")}] → [${u.newTags.join(",")}]`);
}
if (tagUpdates.length > 10) console.log(`  ... and ${tagUpdates.length - 10} more`);

if (APPLY) {
  let updated = 0, errors = 0;
  for (const u of tagUpdates) {
    try {
      await notionPatch(u.pageId, {
        properties: { "Bet Type": { multi_select: u.newTags.map(name => ({ name })) } },
      });
      updated++;
    } catch (err) { console.warn(`    ✗ ${u.pageId}: ${err}`); errors++; }
  }
  console.log(`  Updated ${updated}/${tagUpdates.length} (${errors} errors)`);
}

// ── 3. Refresh Daily Report Result fields ────────────────────────────────────
const reports = await queryAll(REPORTS_DS);
function parseReportDate(title: string): string | null {
  const stripped = title.replace(/^[A-Za-z]+,\s*/, "");
  const t = Date.parse(stripped);
  return isNaN(t) ? null : new Date(t).toISOString().split("T")[0] ?? null;
}

// Re-load picks fresh (so we see post-archive state when running in apply mode
// of phase 1, though in dry-run we use the survivor set above)
const livePicks = APPLY ? (await queryAll(PICKS_DS)).map(getProps) : survivingPicks;
const livePicksByDate = new Map<string, typeof livePicks>();
for (const p of livePicks) {
  if (!p.date) continue;
  if (!livePicksByDate.has(p.date)) livePicksByDate.set(p.date, []);
  livePicksByDate.get(p.date)!.push(p);
}

interface ReportUpdate { pageId: string; date: string; botd: string; uotd: string; top3: string }
const reportUpdates: ReportUpdate[] = [];

for (const r of reports) {
  const title = r.properties?.Date?.title?.[0]?.plain_text ?? "";
  const date = parseReportDate(title);
  if (!date) continue;

  const dayPicks = livePicksByDate.get(date) ?? [];
  if (dayPicks.length === 0) continue;

  const botd = dayPicks.find(p => p.betTypes.includes("Bet of Day"));
  const uotd = dayPicks.find(p => p.betTypes.includes("Underdog"));
  const top3 = dayPicks.filter(p => p.betTypes.includes("Top 3"));
  const top3W = top3.filter(p => p.result === "Win").length;
  const top3L = top3.filter(p => p.result === "Loss").length;
  const top3P = top3.filter(p => p.result === "Push").length;

  const botdResult = botd?.result ?? "N/A";
  const uotdResult = uotd?.result ?? "N/A";
  const top3Record = `${top3W}-${top3L}-${top3P}`;

  const currentBotd = r.properties?.["BOTD Result"]?.select?.name ?? "";
  const currentUotd = r.properties?.["UOTD Result"]?.select?.name ?? "";
  const currentTop3 = r.properties?.["Top 3 Record"]?.rich_text?.[0]?.plain_text ?? "";

  if (currentBotd === botdResult && currentUotd === uotdResult && currentTop3 === top3Record) continue;

  reportUpdates.push({ pageId: r.id, date, botd: botdResult, uotd: uotdResult, top3: top3Record });
}

console.log(`\n[Phase 3] Daily Reports needing Result refresh: ${reportUpdates.length}`);
for (const u of reportUpdates) {
  console.log(`  ${u.date}: BOTD=${u.botd}  UOTD=${u.uotd}  Top3=${u.top3}`);
}

if (APPLY) {
  let updated = 0, errors = 0;
  for (const u of reportUpdates) {
    try {
      await notionPatch(u.pageId, {
        properties: {
          "BOTD Result": { select: { name: u.botd } },
          "UOTD Result": { select: { name: u.uotd } },
          "Top 3 Record": { rich_text: [{ text: { content: u.top3 } }] },
        },
      });
      updated++;
    } catch (err) { console.warn(`    ✗ ${u.pageId}: ${err}`); errors++; }
  }
  console.log(`  Updated ${updated}/${reportUpdates.length} (${errors} errors)`);
}

console.log("\n" + "=".repeat(60));
console.log(`Summary:`);
console.log(`  Phase 1 archives:    ${toArchive.length}`);
console.log(`  Phase 2 tag updates: ${tagUpdates.length}`);
console.log(`  Phase 3 report fix:  ${reportUpdates.length}`);
if (!APPLY) console.log("\n(dry run — re-run with --apply)");
