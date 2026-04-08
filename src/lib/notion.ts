// Notion REST API — reads/writes for Picks Tracker and Daily Reports DBs

import { Client } from "@notionhq/client";

function getClient(): Client {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN is not set");
  return new Client({ auth: token });
}

// v5 SDK: dataSources.query() requires the collection/data source ID, not the database page ID
function picksDsId(): string {
  const id = process.env.NOTION_PICKS_DS_ID;
  if (!id) throw new Error("NOTION_PICKS_DS_ID is not set");
  return id;
}

function reportsDsId(): string {
  const id = process.env.NOTION_REPORTS_DS_ID;
  if (!id) throw new Error("NOTION_REPORTS_DS_ID is not set");
  return id;
}

// Still needed for pages.create (parent database_id uses the DB page ID)
function picksDbId(): string {
  const id = process.env.NOTION_PICKS_DB_ID;
  if (!id) throw new Error("NOTION_PICKS_DB_ID is not set");
  return id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}

function reportsDbId(): string {
  const id = process.env.NOTION_REPORTS_DB_ID;
  if (!id) throw new Error("NOTION_REPORTS_DB_ID is not set");
  return id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PickDetail {
  date: string;
  matchup: string;
  pick: string;
  betType: string;
  odds: number;
  impliedProbPct: number;
  confidence: number;
  spMatchupRating: string;
  result: "Win" | "Loss" | "Push";
  homeTeam: string;
  awayTeam: string;
  notes: string;
}

export interface PendingPick {
  pageId: string;
  matchup: string;
  pick: string;
  betType: string;
  odds: number;
  gameId: number;
}

export interface PickToLog {
  matchup: string;           // "NYY @ BOS"
  date: string;              // "YYYY-MM-DD"
  pick: string;              // "NYY ML (-108)"
  betType: "Bet of Day" | "Underdog" | "Top 3" | "Game Pick";
  odds: number;
  impliedProbPct: number;
  confidence: number;
  spMatchupRating: "Strong" | "Neutral" | "Weak";
  homeTeam: string;
  awayTeam: string;
  gameId: number;
  notes: string;
  reportUrl: string;
}

export interface DailyReportData {
  date: string;              // "YYYY-MM-DD"
  betOfDay: string;          // "NYY ML (-108)"
  botdConfidence: number;
  underdogOfDay: string;     // "BOS ML (+135)"
  top3Record: string;        // "0-0 (Pending)"
  totalPicks: number;
  lineupsConfirmed: boolean;
  gamesAnalyzed: number;
  bodyMarkdown: string;      // full page content
}

export interface RunningRecord {
  wins: number;
  losses: number;
  pushes: number;
  roiUnits: number;
}

// ─── Pending pick resolution ──────────────────────────────────────────────────

export interface PendingPickWithDate extends PendingPick {
  date: string;
}

async function queryPendingPicks(extraFilter?: object): Promise<PendingPickWithDate[]> {
  const notion = getClient();
  const picks: PendingPickWithDate[] = [];
  const pendingFilter = { property: "Result", select: { equals: "Pending" } };
  const filter = extraFilter
    ? { and: [extraFilter, pendingFilter] }
    : pendingFilter;

  let cursor: string | undefined;
  do {
    const res = await notion.dataSources.query({
      data_source_id: picksDsId(),
      start_cursor: cursor,
      filter,
    } as any);

    for (const page of res.results) {
      if (page.object !== "page") continue;
      const props = (page as any).properties;
      picks.push({
        pageId: page.id,
        date: props["Date"]?.date?.start ?? "",
        matchup: props["Matchup"]?.title?.[0]?.plain_text ?? "",
        pick: props["Pick"]?.rich_text?.[0]?.plain_text ?? "",
        betType: props["Bet Type"]?.select?.name ?? "",
        odds: props["Odds"]?.number ?? 0,
        gameId: props["GameID"]?.number ?? 0,
      });
    }

    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return picks;
}

/** All pending picks regardless of date — sweeps the full backlog. */
export async function getAllPendingPicks(): Promise<PendingPickWithDate[]> {
  return queryPendingPicks();
}

/** @deprecated Use getAllPendingPicks() to sweep the full backlog. */
export async function getYesterdayPendingPicks(yesterday: string): Promise<PendingPickWithDate[]> {
  return queryPendingPicks({ property: "Date", date: { equals: yesterday } });
}

export async function updatePickResult(pageId: string, result: "Win" | "Loss" | "Push"): Promise<void> {
  const notion = getClient();
  await notion.pages.update({
    page_id: pageId,
    properties: {
      Result: { select: { name: result } },
    },
  });
}

function calcRoi(pages: any[]): number {
  let roi = 0;
  for (const page of pages) {
    const result = page.properties?.["Result"]?.select?.name;
    const odds: number = page.properties?.["Odds"]?.number ?? 0;
    if (result === "Win" && odds !== 0) {
      roi += odds > 0 ? odds / 100 : 100 / Math.abs(odds);
    } else if (result === "Loss") {
      roi -= 1;
    }
  }
  return Math.round(roi * 100) / 100;
}

async function queryResolvedRecord(sinceDate?: string): Promise<RunningRecord> {
  const notion = getClient();
  const resolvedFilter = {
    or: [
      { property: "Result", select: { equals: "Win" } },
      { property: "Result", select: { equals: "Loss" } },
      { property: "Result", select: { equals: "Push" } },
    ],
  };
  const filter = sinceDate
    ? { and: [{ property: "Date", date: { on_or_after: sinceDate } }, resolvedFilter] }
    : resolvedFilter;

  let wins = 0, losses = 0, pushes = 0;
  const allPages: any[] = [];
  let cursor: string | undefined;

  do {
    const res = await notion.dataSources.query({
      data_source_id: picksDsId(),
      start_cursor: cursor,
      filter,
    } as any);

    for (const page of res.results) {
      allPages.push(page);
      const result = (page as any).properties?.["Result"]?.select?.name;
      if (result === "Win") wins++;
      else if (result === "Loss") losses++;
      else if (result === "Push") pushes++;
    }

    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return { wins, losses, pushes, roiUnits: calcRoi(allPages) };
}

export async function getRunningRecord(days = 30): Promise<RunningRecord> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return queryResolvedRecord(cutoff.toISOString().split("T")[0]);
}

/** All-time season record with ROI — no date filter. */
export async function getAllTimeRecord(): Promise<RunningRecord> {
  return queryResolvedRecord();
}

// ─── Fetch recent resolved picks for self-learning loop ──────────────────────

export async function getRecentPicksDetail(days = 21): Promise<PickDetail[]> {
  const notion = getClient();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split("T")[0] as string;

  const picks: PickDetail[] = [];
  let cursor: string | undefined;

  do {
    const res = await notion.dataSources.query({
      data_source_id: picksDsId(),
      start_cursor: cursor,
      filter: {
        and: [
          { property: "Date", date: { on_or_after: cutoffStr } },
          {
            or: [
              { property: "Result", select: { equals: "Win" } },
              { property: "Result", select: { equals: "Loss" } },
              { property: "Result", select: { equals: "Push" } },
            ],
          },
        ],
      },
      sorts: [{ property: "Date", direction: "descending" }],
    } as any);

    for (const page of res.results) {
      if (page.object !== "page") continue;
      const props = (page as any).properties;
      const result = props["Result"]?.select?.name;
      if (!["Win", "Loss", "Push"].includes(result)) continue;

      picks.push({
        date: props["Date"]?.date?.start ?? "",
        matchup: props["Matchup"]?.title?.[0]?.plain_text ?? "",
        pick: props["Pick"]?.rich_text?.[0]?.plain_text ?? "",
        betType: props["Bet Type"]?.select?.name ?? "",
        odds: props["Odds"]?.number ?? 0,
        impliedProbPct: props["Implied Prob %"]?.number ?? 0,
        confidence: props["Confidence"]?.number ?? 0,
        spMatchupRating: props["SP Matchup Rating"]?.select?.name ?? "",
        result: result as "Win" | "Loss" | "Push",
        homeTeam: props["Home Team"]?.rich_text?.[0]?.plain_text ?? "",
        awayTeam: props["Away Team"]?.rich_text?.[0]?.plain_text ?? "",
        notes: props["Notes"]?.rich_text?.[0]?.plain_text ?? "",
      });
    }

    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return picks;
}

// ─── Update yesterday's Daily Report page with resolved results ──────────────

export async function updateDailyReportResults(
  date: string,
  botdResult: string,
  uotdResult: string,
  top3Record: string
): Promise<void> {
  const notion = getClient();

  const res = await notion.dataSources.query({
    data_source_id: reportsDsId(),
    filter: { property: "Date", title: { contains: date } },
    page_size: 1,
  } as any);

  if (res.results.length === 0) return;
  const pageId = res.results[0]?.id;
  if (!pageId) return;

  await notion.pages.update({
    page_id: pageId,
    properties: {
      "BOTD Result": { select: { name: botdResult } },
      "UOTD Result": { select: { name: uotdResult } },
      "Top 3 Record": { rich_text: [{ text: { content: top3Record } }] },
    },
  });
}

// ─── Create today's Daily Report page ────────────────────────────────────────

export async function createDailyReport(data: DailyReportData): Promise<string> {
  const notion = getClient();

  // Format date as "Sunday, April 06, 2026"
  const dateObj = new Date(data.date + "T12:00:00Z");
  const formattedDate = dateObj.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "2-digit", year: "numeric",
  });

  const page = await notion.pages.create({
    parent: { type: "database_id", database_id: reportsDbId() },
    properties: {
      "Date":               { title: [{ text: { content: formattedDate } }] },
      "Bet of Day":         { rich_text: [{ text: { content: data.betOfDay } }] },
      "BOTD Confidence":    { number: data.botdConfidence },
      "BOTD Result":        { select: { name: "Pending" } },
      "Underdog of Day":    { rich_text: [{ text: { content: data.underdogOfDay } }] },
      "UOTD Result":        { select: { name: "Pending" } },
      "Top 3 Record":       { rich_text: [{ text: { content: data.top3Record } }] },
      "Total Picks":        { number: data.totalPicks },
      "Lineups Confirmed":  { checkbox: data.lineupsConfirmed },
      "Games Analyzed":     { number: data.gamesAnalyzed },
    },
    children: markdownToBlocks(data.bodyMarkdown),
  });

  return (page as any).url ?? `https://notion.so/${page.id.replace(/-/g, "")}`;
}

// ─── Log a pick to the Picks Tracker ─────────────────────────────────────────

export async function logPick(pick: PickToLog): Promise<void> {
  const notion = getClient();

  await notion.pages.create({
    parent: { type: "database_id", database_id: picksDbId() },
    properties: {
      "Matchup":          { title: [{ text: { content: pick.matchup } }] },
      "Date":             { date: { start: pick.date } },
      "Pick":             { rich_text: [{ text: { content: pick.pick } }] },
      "Bet Type":         { select: { name: pick.betType } },
      "Odds":             { number: pick.odds },
      "Implied Prob %":   { number: Math.round(pick.impliedProbPct * 10) / 10 },
      "Confidence":       { number: pick.confidence },
      "Result":           { select: { name: "Pending" } },
      "SP Matchup Rating":{ select: { name: pick.spMatchupRating } },
      "Home Team":        { rich_text: [{ text: { content: pick.homeTeam } }] },
      "Away Team":        { rich_text: [{ text: { content: pick.awayTeam } }] },
      "GameID":           { number: pick.gameId },
      "Notes":            { rich_text: [{ text: { content: pick.notes.slice(0, 2000) } }] },
      "Report Link":      { url: pick.reportUrl },
    },
  });
}

// ─── Minimal markdown → Notion blocks converter ───────────────────────────────
// Handles: ## headings, **bold**, bullet lists, tables (as code), plain paragraphs

function markdownToBlocks(markdown: string): any[] {
  const blocks: any[] = [];
  const lines = markdown.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.startsWith("## ")) {
      blocks.push({
        object: "block", type: "heading_2",
        heading_2: { rich_text: [{ type: "text", text: { content: line.slice(3) } }] },
      });
    } else if (line.startsWith("### ")) {
      blocks.push({
        object: "block", type: "heading_3",
        heading_3: { rich_text: [{ type: "text", text: { content: line.slice(4) } }] },
      });
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      blocks.push({
        object: "block", type: "bulleted_list_item",
        bulleted_list_item: { rich_text: parseInline(line.slice(2)) },
      });
    } else if (line.startsWith("| ")) {
      // Collect table lines and render as a code block (Notion free tables are limited)
      const tableLines: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("| ")) {
        tableLines.push(lines[i] ?? "");
        i++;
      }
      blocks.push({
        object: "block", type: "code",
        code: { language: "plain text", rich_text: [{ type: "text", text: { content: tableLines.join("\n") } }] },
      });
      continue;
    } else if (line.startsWith("---")) {
      blocks.push({ object: "block", type: "divider", divider: {} });
    } else if (line.trim() !== "") {
      blocks.push({
        object: "block", type: "paragraph",
        paragraph: { rich_text: parseInline(line) },
      });
    }

    i++;
  }

  // Notion API limit: 100 blocks per request
  return blocks.slice(0, 100);
}

function parseInline(text: string): any[] {
  // Split on **bold** markers and return rich_text array
  const parts: any[] = [];
  const regex = /\*\*(.+?)\*\*/g;
  let lastIdx = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push({ type: "text", text: { content: text.slice(lastIdx, match.index) } });
    }
    parts.push({ type: "text", text: { content: match[1] }, annotations: { bold: true } });
    lastIdx = match.index + match[0].length;
  }

  if (lastIdx < text.length) {
    parts.push({ type: "text", text: { content: text.slice(lastIdx) } });
  }

  return parts.length > 0 ? parts : [{ type: "text", text: { content: text } }];
}
