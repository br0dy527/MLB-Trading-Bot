#!/usr/bin/env node
// One-shot backfill: walks every Daily Report page, recomputes BOTD Result,
// UOTD Result, and Top 3 Record from the current Picks Tracker state, and
// patches the page. Safe to re-run.
//
// Usage:
//   npx tsx tools/backfill_daily_reports.ts          # dry run (logs only)
//   npx tsx tools/backfill_daily_reports.ts --apply  # apply updates

import { readFileSync } from "fs";

// ── Load .env (same pattern as tools/score_yesterday.ts) ────────────────────
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

const {
  listDailyReports,
  getResolvedPicksByDate,
  updateDailyReportResults,
} = await import("../src/lib/notion.js");

function normalizeBetType(bt: string): string {
  const t = bt.trim().toLowerCase();
  if (t === "bet of day" || t === "bet of the day" || t === "botd" || t === "best bet") return "Bet of Day";
  if (t === "underdog" || t === "underdog of day" || t === "uotd") return "Underdog";
  if (t === "top 3" || t === "top3" || t === "top pick") return "Top 3";
  return bt;
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`Backfill Daily Reports — ${apply ? "APPLY" : "DRY RUN"}`);
  console.log("=".repeat(50));

  const reports = await listDailyReports();
  console.log(`Found ${reports.length} Daily Report pages.\n`);

  let updated = 0, skipped = 0, unparseable = 0, empty = 0;

  for (const r of reports) {
    if (!r.date) {
      console.warn(`  [SKIP] Unparseable title: "${r.title}"`);
      unparseable++;
      continue;
    }

    const picks = await getResolvedPicksByDate(r.date);
    if (picks.length === 0) {
      console.log(`  [${r.date}] no resolved picks yet — leaving as Pending`);
      empty++;
      continue;
    }

    const normalized = picks.map(p => ({ ...p, betTypes: p.betTypes.map(normalizeBetType) }));
    const botd = normalized.find(p => p.betTypes.includes("Bet of Day"));
    const uotd = normalized.find(p => p.betTypes.includes("Underdog"));
    const top3 = normalized.filter(p => p.betTypes.includes("Top 3"));
    const top3W = top3.filter(p => p.result === "Win").length;
    const top3L = top3.filter(p => p.result === "Loss").length;
    const top3P = top3.filter(p => p.result === "Push").length;

    const botdResult = botd?.result ?? "N/A";
    const uotdResult = uotd?.result ?? "N/A";
    const top3Record = `${top3W}-${top3L}-${top3P}`;

    console.log(`  [${r.date}] BOTD=${botdResult} UOTD=${uotdResult} Top3=${top3Record}  (${normalized.length} resolved picks)`);

    if (apply) {
      try {
        await updateDailyReportResults(r.date, botdResult, uotdResult, top3Record);
        updated++;
      } catch (err) {
        console.warn(`    UPDATE FAILED: ${err}`);
        skipped++;
      }
    }
  }

  console.log("\n" + "=".repeat(50));
  console.log(`Reports scanned:    ${reports.length}`);
  console.log(`Unparseable titles: ${unparseable}`);
  console.log(`No picks yet:       ${empty}`);
  console.log(`Updated:            ${updated}`);
  console.log(`Update failures:    ${skipped}`);
  if (!apply) console.log(`\n(dry run — re-run with --apply to write changes)`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
