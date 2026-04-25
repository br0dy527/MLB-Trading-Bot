#!/usr/bin/env node
// One-shot: archives duplicate Daily Report pages, keeping the most recently
// created one per date. Safe to re-run.
//
// Usage:
//   npx tsx tools/dedupe_daily_reports.ts          # dry run
//   npx tsx tools/dedupe_daily_reports.ts --apply  # archive duplicates

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

const { listDailyReports, archiveDailyReport } = await import("../src/lib/notion.js");

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`Dedupe Daily Reports — ${apply ? "APPLY" : "DRY RUN"}`);
  console.log("=".repeat(50));

  const reports = await listDailyReports();
  console.log(`Found ${reports.length} Daily Report pages.\n`);

  const byDate = new Map<string, typeof reports>();
  const unparseable: typeof reports = [];

  for (const r of reports) {
    if (!r.date) { unparseable.push(r); continue; }
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date)!.push(r);
  }

  let toArchive = 0;
  let archived = 0;
  let failures = 0;

  // Sort dates ascending so the log reads chronologically
  const sortedDates = [...byDate.keys()].sort();

  for (const date of sortedDates) {
    const group = byDate.get(date)!;
    if (group.length <= 1) continue;

    // Sort newest first (latest created_time wins)
    group.sort((a, b) => b.createdTime.localeCompare(a.createdTime));
    const keeper = group[0]!;
    const dupes = group.slice(1);

    console.log(`\n[${date}] ${group.length} pages — keeping newest (${keeper.createdTime})`);
    for (const d of dupes) {
      console.log(`  archive ${d.pageId}  created ${d.createdTime}`);
      toArchive++;
      if (apply) {
        try {
          await archiveDailyReport(d.pageId);
          archived++;
        } catch (err) {
          console.warn(`    FAILED: ${err}`);
          failures++;
        }
      }
    }
  }

  console.log("\n" + "=".repeat(50));
  console.log(`Reports scanned:    ${reports.length}`);
  console.log(`Unique dates:       ${byDate.size}`);
  console.log(`Unparseable titles: ${unparseable.length}`);
  console.log(`Duplicates found:   ${toArchive}`);
  if (apply) {
    console.log(`Archived:           ${archived}`);
    console.log(`Failures:           ${failures}`);
  } else if (toArchive > 0) {
    console.log(`\n(dry run — re-run with --apply to archive)`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
