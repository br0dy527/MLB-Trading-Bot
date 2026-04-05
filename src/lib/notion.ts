// Notion REST API — reads/writes for Picks Tracker and Daily Reports DBs

import { Client } from "@notionhq/client";

function getClient(): Client {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN is not set");
  return new Client({ auth: token });
}

// IDs from .env — use data source IDs for v5 SDK queries and page creation
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

// ─── Types ───────────────────────────────────────────────────────────────────

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
}

// ─── Yesterday scoring ───────────────────────────────────────────────────────

export async function getYesterdayPendingPicks(yesterday: string): Promise<PendingPick[]> {
  const notion = getClient();
  const picks: PendingPick[] = [];

  let cursor: string | undefined;
  do {
    const res = await notion.dataSources.query({
      data_source_id: picksDsId(),
      start_cursor: cursor,
      filter: {
        and: [
          { property: "Date", date: { equals: yesterday } },
          { property: "Result", select: { equals: "Pending" } },
        ],
      },
    } as any);

    for (const page of res.results) {
      if (page.object !== "page") continue;
      const props = (page as any).properties;

      picks.push({
        pageId: page.id,
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

export async function updatePickResult(pageId: string, result: "Win" | "Loss" | "Push"): Promise<void> {
  const notion = getClient();
  await notion.pages.update({
    page_id: pageId,
    properties: {
      Result: { select: { name: result } },
    },
  });
}

export async function getRunningRecord(days = 30): Promise<RunningRecord> {
  const notion = getClient();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split("T")[0];

  let wins = 0, losses = 0, pushes = 0;
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
    } as any);

    for (const page of res.results) {
      const result = (page as any).properties?.["Result"]?.select?.name;
      if (result === "Win") wins++;
      else if (result === "Loss") losses++;
      else if (result === "Push") pushes++;
    }

    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return { wins, losses, pushes };
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
    parent: { data_source_id: reportsDsId(), type: "data_source_id" } as any,
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
    parent: { data_source_id: picksDsId(), type: "data_source_id" } as any,
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
