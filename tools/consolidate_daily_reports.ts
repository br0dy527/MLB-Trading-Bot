#!/usr/bin/env node
// One-shot: for every date with multiple Daily Reports, keeps the EARLIEST
// (Trigger.dev path — the canonical one with GameID-linked picks) and
// archives the rest. Then repoints any Picks Tracker rows whose Report Link
// targets an archived report so they point at the surviving page.
//
// Usage:
//   npx tsx tools/consolidate_daily_reports.ts          # dry run
//   npx tsx tools/consolidate_daily_reports.ts --apply  # archive + repoint

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

const { listDailyReports, archiveDailyReport, parseReportTitleDate } = await import("../src/lib/notion.js");

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

const pageIdToUrl = (id: string) => `https://www.notion.so/${id.replace(/-/g, "")}`;
const normalizeUrl = (url: string) => url.replace(/-/g, "").replace(/^https?:\/\/[^/]+\//, "").toLowerCase();

// Find picks whose Report Link matches any of the archived page IDs.
async function findPicksLinkingTo(archivedIds: string[]): Promise<Array<{ pageId: string; date: string; currentUrl: string }>> {
  const archivedKeys = new Set(archivedIds.map(id => normalizeUrl(pageIdToUrl(id))));
  const out: Array<{ pageId: string; date: string; currentUrl: string }> = [];
  let cursor: string | undefined;
  do {
    const r = await notionPost(`/v1/data_sources/${PICKS_DS}/query`, {
      page_size: 100,
      start_cursor: cursor,
    });
    for (const p of r.results as any[]) {
      const url = p.properties?.["Report Link"]?.url ?? "";
      if (!url) continue;
      if (archivedKeys.has(normalizeUrl(url))) {
        out.push({
          pageId: p.id,
          date: p.properties?.Date?.date?.start ?? "",
          currentUrl: url,
        });
      }
    }
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const reports = await listDailyReports();
console.log(`\nConsolidate Daily Reports — ${APPLY ? "APPLY" : "DRY RUN"}`);
console.log(`Total reports: ${reports.length}`);
console.log("=".repeat(60));

const byDate = new Map<string, typeof reports>();
const unparseable: typeof reports = [];
for (const r of reports) {
  if (!r.date) { unparseable.push(r); continue; }
  if (!byDate.has(r.date)) byDate.set(r.date, []);
  byDate.get(r.date)!.push(r);
}

interface KeepArchive { date: string; keep: typeof reports[number]; archive: typeof reports }
const decisions: KeepArchive[] = [];

for (const [date, group] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (group.length <= 1) continue;
  // Earliest created_time wins — that's the Trigger.dev path's canonical report
  group.sort((a, b) => a.createdTime.localeCompare(b.createdTime));
  decisions.push({ date, keep: group[0]!, archive: group.slice(1) });
}

if (decisions.length === 0) {
  console.log("\nNo duplicate days found. Nothing to consolidate.");
  process.exit(0);
}

console.log(`\nDates with duplicates: ${decisions.length}`);
for (const d of decisions) {
  console.log(`\n[${d.date}] keeping ${d.keep.pageId} (created ${d.keep.createdTime})`);
  for (const a of d.archive) {
    console.log(`  archive  ${a.pageId} (created ${a.createdTime})`);
  }
}

// Repoint picks
const allArchiveIds = decisions.flatMap(d => d.archive.map(a => a.pageId));
console.log(`\nScanning Picks Tracker for rows linking to archived reports...`);
const orphans = await findPicksLinkingTo(allArchiveIds);
console.log(`Found ${orphans.length} pick rows pointing at to-be-archived reports.`);

// Build mapping: archived page ID → kept page ID, keyed by date
const keepByDate = new Map(decisions.map(d => [d.date, d.keep.pageId]));

let archivedCount = 0;
let repointedCount = 0;
let errors = 0;

if (APPLY) {
  console.log(`\nRepointing pick rows...`);
  for (const o of orphans) {
    const newKeepId = keepByDate.get(o.date);
    if (!newKeepId) {
      console.warn(`  ✗ no keep target for pick ${o.pageId} (date ${o.date})`);
      errors++;
      continue;
    }
    try {
      await notionPatch(o.pageId, { "Report Link": { url: pageIdToUrl(newKeepId) } });
      repointedCount++;
    } catch (err) {
      console.warn(`  ✗ failed to repoint ${o.pageId}: ${err}`);
      errors++;
    }
  }
  console.log(`  Repointed ${repointedCount}/${orphans.length} pick rows.`);

  console.log(`\nArchiving duplicate reports...`);
  for (const d of decisions) {
    for (const a of d.archive) {
      try {
        await archiveDailyReport(a.pageId);
        archivedCount++;
        console.log(`  ✓ archived ${d.date}/${a.pageId}`);
      } catch (err) {
        console.warn(`  ✗ failed to archive ${a.pageId}: ${err}`);
        errors++;
      }
    }
  }
}

console.log("\n" + "=".repeat(60));
console.log(`Duplicate dates:    ${decisions.length}`);
console.log(`Reports to archive: ${decisions.reduce((s, d) => s + d.archive.length, 0)}`);
console.log(`Picks to repoint:   ${orphans.length}`);
if (APPLY) {
  console.log(`Archived:           ${archivedCount}`);
  console.log(`Repointed:          ${repointedCount}`);
  console.log(`Errors:             ${errors}`);
} else {
  console.log("\n(dry run — re-run with --apply)");
}
