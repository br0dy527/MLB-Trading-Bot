// Daily post-mortem: analyzes yesterday's losses (and outsized wins), identifies
// durable patterns, and writes/updates/retires lessons in the Lessons Learned DB.
// Runs in the orchestrator after the scoring step.

import { task } from "@trigger.dev/sdk/v3";
import Anthropic from "@anthropic-ai/sdk";
import {
  getActiveLessons, getRecentPicksDetail, createLesson, reinforceLesson, retireLesson,
  type Lesson, type PickDetail, type LessonCategory, type LessonDirection,
} from "../lib/notion.js";

export interface PostmortemPayload {
  date: string;        // the date being analyzed (yesterday from orchestrator's POV)
  lookbackDays?: number;
}

export interface PostmortemResult {
  created: number;
  reinforced: number;
  retired: number;
  skipped: number;
  notes: string;
}

interface LessonAction {
  action: "create" | "reinforce" | "retire" | "noop";
  // create:
  title?: string;
  pattern?: string;
  evidence?: string;
  category?: LessonCategory;
  direction?: LessonDirection;
  magnitude?: number;
  // reinforce / retire:
  lessonTitle?: string;          // match by title (case-insensitive)
  newEvidence?: string;
  // shared:
  rationale: string;
}

const POSTMORTEM_RULES = `## POST-MORTEM RULES

You analyze the recent betting record and identify DURABLE patterns that should be remembered as lessons. You can:
1. CREATE a new lesson when a pattern repeats across ≥3 picks OR is a single high-conviction insight backed by specific stats.
2. REINFORCE an existing lesson when today's results match it.
3. RETIRE an existing lesson when recent data clearly contradicts it (≥3 picks where the lesson would have been wrong).
4. NO-OP when no clear pattern emerges.

**Do NOT manufacture lessons.** Random variance in 1-2 picks is not a pattern. Cite specific stats from the picks.

**Lesson quality bar:**
- Title: short, actionable, ≤80 chars (e.g., "Coors Field UNDERs underperform model delta")
- Pattern: 1-3 sentences, must include specific conditions ("when X AND Y, then Z")
- Evidence: cite at least 2 specific picks/dates/stats
- Direction: BOOST (+conf for matching picks), REDUCE (-conf), VETO (don't bet), FLAG (just notify)
- Magnitude: integer 0-15. BOOST/REDUCE typically 3-10. VETO uses magnitude=0 (the veto flag does the work). FLAG uses magnitude=0.

**Categories:** Pitching | Park/Weather | Bullpen | Lineup | Sharp/Public | Calibration | Streak | Totals | Other`;

const POSTMORTEM_OUTPUT_SCHEMA = `## OUTPUT JSON SCHEMA
Return a JSON ARRAY of action objects. Each object has shape:

CREATE:
{ "action": "create", "title": "...", "pattern": "...", "evidence": "...",
  "category": "Pitching" | "Park/Weather" | ..., "direction": "BOOST"|"REDUCE"|"VETO"|"FLAG",
  "magnitude": 5, "rationale": "why this lesson now" }

REINFORCE:
{ "action": "reinforce", "lessonTitle": "<existing lesson title>", "newEvidence": "today's matching pick",
  "rationale": "..." }

RETIRE:
{ "action": "retire", "lessonTitle": "<existing lesson title>",
  "rationale": "specific evidence the pattern no longer holds" }

NO-OP (use sparingly — only if you genuinely found nothing today):
[]

Return at most 5 actions per run. Quality over quantity.`;

function buildPostmortemPrompt(date: string, picks: PickDetail[], lessons: Lesson[]): string {
  const losses = picks.filter(p => p.result === "Loss");
  const wins = picks.filter(p => p.result === "Win");

  const formatPick = (p: PickDetail) => [
    `- [${p.date}] ${p.matchup} | ${p.pick} | ${p.result}`,
    `  conf=${p.confidence}% | implied=${p.impliedProbPct}% | odds=${p.odds} | SP=${p.spMatchupRating} | betTypes=[${p.betTypes.join(", ")}]`,
    `  notes: ${p.notes.slice(0, 250)}`,
  ].join("\n");

  const lessonList = lessons.length === 0
    ? "(no active lessons yet)"
    : lessons.map(l => `- "${l.title}" [${l.direction} ${l.magnitude}] ${l.category} — Pattern: ${l.pattern} | Reinforced ${l.timesReinforced}× | ${l.winsWhenApplied}W-${l.lossesWhenApplied}L when applied`).join("\n");

  return `You are the POST-MORTEM agent for an MLB betting bot. Analyze recent results, identify durable patterns, and update the Lessons Learned knowledge base.

${POSTMORTEM_RULES}

${POSTMORTEM_OUTPUT_SCHEMA}

---

## TODAY'S SCORING DATE: ${date}

## ACTIVE LESSONS (existing knowledge)
${lessonList}

---

## RECENT RESOLVED PICKS (last ${picks.length}, ${wins.length}W-${losses.length}L-${picks.length - wins.length - losses.length}P)

### LOSSES (primary source of new lessons — what went wrong?)
${losses.length > 0 ? losses.map(formatPick).join("\n\n") : "(no losses)"}

### WINS (look for repeating success patterns)
${wins.length > 0 ? wins.slice(0, 10).map(formatPick).join("\n\n") : "(no wins)"}

---

Return ONLY the JSON array — no markdown, no commentary, no code fences.`;
}

function parsePostmortemActions(raw: string): LessonAction[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    console.warn("[postmortem] No JSON array in response. First 300:", raw.slice(0, 300));
    return [];
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(`[postmortem] JSON parse failed: ${(err as Error).message}`);
    return [];
  }
}

function findLessonByTitle(lessons: Lesson[], title: string): Lesson | undefined {
  const t = title.toLowerCase().trim();
  return lessons.find(l => l.title.toLowerCase().trim() === t);
}

export const mlbPostmortemTask = task({
  id: "mlb-postmortem",
  maxDuration: 300,
  retry: { maxAttempts: 1 },

  run: async (payload: PostmortemPayload): Promise<PostmortemResult> => {
    const { date, lookbackDays = 14 } = payload;
    console.log(`[postmortem] Running for ${date}, lookback=${lookbackDays} days`);

    const [lessons, recentPicks] = await Promise.all([
      getActiveLessons(),
      getRecentPicksDetail(lookbackDays),
    ]);

    if (recentPicks.length < 3) {
      console.log(`[postmortem] Only ${recentPicks.length} resolved picks — skipping (need 3+ for pattern detection)`);
      return { created: 0, reinforced: 0, retired: 0, skipped: 1, notes: "Insufficient data" };
    }

    console.log(`[postmortem] ${lessons.length} active lessons, ${recentPicks.length} recent picks`);

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = buildPostmortemPrompt(date, recentPicks, lessons);

    let responseText = "";
    const stream = client.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      messages: [{ role: "user", content: prompt }],
    });

    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
        responseText += chunk.delta.text;
      }
    }

    const actions = parsePostmortemActions(responseText);
    console.log(`[postmortem] ${actions.length} action(s) proposed`);

    let created = 0;
    let reinforced = 0;
    let retired = 0;
    let skipped = 0;
    const summaryNotes: string[] = [];

    for (const a of actions) {
      try {
        if (a.action === "create") {
          if (!a.title || !a.pattern || !a.category || !a.direction || a.magnitude === undefined) {
            console.warn(`[postmortem] Skipping malformed CREATE: ${JSON.stringify(a)}`);
            skipped++;
            continue;
          }
          // Dedupe: don't create if a lesson with the same (or near-same) title exists
          if (findLessonByTitle(lessons, a.title)) {
            console.log(`[postmortem] CREATE skipped — title already exists: "${a.title}"`);
            skipped++;
            continue;
          }
          await createLesson({
            title: a.title.slice(0, 80),
            pattern: a.pattern.slice(0, 1500),
            evidence: (a.evidence ?? "").slice(0, 1500),
            category: a.category,
            direction: a.direction,
            magnitude: Math.max(0, Math.min(15, Math.round(a.magnitude))),
            date,
          });
          created++;
          summaryNotes.push(`CREATE "${a.title}"`);
        } else if (a.action === "reinforce") {
          if (!a.lessonTitle) { skipped++; continue; }
          const target = findLessonByTitle(lessons, a.lessonTitle);
          if (!target) {
            console.warn(`[postmortem] REINFORCE: lesson not found "${a.lessonTitle}"`);
            skipped++;
            continue;
          }
          await reinforceLesson(target.pageId, date, a.newEvidence);
          reinforced++;
          summaryNotes.push(`REINFORCE "${target.title}"`);
        } else if (a.action === "retire") {
          if (!a.lessonTitle) { skipped++; continue; }
          const target = findLessonByTitle(lessons, a.lessonTitle);
          if (!target) {
            console.warn(`[postmortem] RETIRE: lesson not found "${a.lessonTitle}"`);
            skipped++;
            continue;
          }
          await retireLesson(target.pageId);
          retired++;
          summaryNotes.push(`RETIRE "${target.title}" — ${a.rationale.slice(0, 80)}`);
        } else {
          skipped++;
        }
      } catch (err) {
        console.error(`[postmortem] Action failed: ${err}`);
        skipped++;
      }
    }

    const notes = summaryNotes.length > 0 ? summaryNotes.join(" | ") : "No actions taken";
    console.log(`[postmortem] Done: ${created} created, ${reinforced} reinforced, ${retired} retired, ${skipped} skipped`);
    return { created, reinforced, retired, skipped, notes };
  },
});
