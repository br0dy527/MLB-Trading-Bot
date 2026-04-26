// Green-team analyst: builds the bull case for ONE game, returns one structured pick.
// Replaces the per-game work the legacy mlb-analyze mega-prompt does in a single call.
// Aggregator (mlb-aggregator.ts) fans this out across all games on the slate.

import { task } from "@trigger.dev/sdk/v3";
import Anthropic from "@anthropic-ai/sdk";
import {
  ABSOLUTE_RULES_BLOCK, TEN_PILLAR_PROTOCOL, SINGLE_PICK_OUTPUT_SCHEMA,
  calibrationRulesBlock, institutionalKnowledgeBlock, parseSinglePickJSON,
  type GamePickResult,
} from "../lib/analysis-shared.js";
import type { CompiledGame } from "./mlb-fetch-data.js";
import type { TavilyResults } from "../lib/tavily.js";
import type { Lesson } from "../lib/notion.js";

export interface GreenAnalystPayload {
  date: string;
  game: CompiledGame;
  tavilyResults: TavilyResults;
  performanceContext: string;
  yesterdayScorecard: string;
  runningRecord: { wins: number; losses: number; pushes: number; roiUnits: number };
  lessons?: Lesson[];
}

export interface GreenAnalystResult {
  pick: GamePickResult;
}

function buildPerGamePrompt(p: GreenAnalystPayload): string {
  const winPct = (p.runningRecord.wins + p.runningRecord.losses) > 0
    ? Math.round((p.runningRecord.wins / (p.runningRecord.wins + p.runningRecord.losses)) * 1000) / 10
    : 0;

  return `You are an MLB betting analyst. Analyze the SINGLE game below using the full 10-Pillar Protocol and return ONLY a valid JSON object — no markdown, no commentary, no code fences, no array wrapper.

${ABSOLUTE_RULES_BLOCK}

${TEN_PILLAR_PROTOCOL}

${SINGLE_PICK_OUTPUT_SCHEMA}

---

${institutionalKnowledgeBlock(p.lessons ?? [])}

---

${calibrationRulesBlock(p.performanceContext)}

---

## CONTEXT

30-day running record: ${p.runningRecord.wins}-${p.runningRecord.losses}-${p.runningRecord.pushes} (${winPct}% win rate)

Yesterday's scorecard:
${p.yesterdayScorecard}

---

## GAME DATA (JSON)
${JSON.stringify({ date: p.date, game: p.game }, null, 1)}

---

## WEB SEARCH RESULTS (extract only the lines relevant to this matchup)

### ODDS
${p.tavilyResults.odds || "No odds data available"}

### LINEUPS
${p.tavilyResults.lineups || "No lineup data available"}

### INJURIES
${p.tavilyResults.injuries || "No injury data available"}

### LINE MOVEMENT & SHARP MONEY (Pillar 8)
${p.tavilyResults.lineMovement || "No line movement data available"}

---

Return ONLY the JSON object for this single game. No markdown, no array, no explanation.`;
}

export const mlbGreenAnalystTask = task({
  id: "mlb-green-analyst",
  maxDuration: 180, // 3 minutes per game
  retry: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 30000, factor: 2 },

  run: async (payload: GreenAnalystPayload): Promise<GreenAnalystResult> => {
    const { date, game } = payload;
    console.log(`[green-analyst] ${date} ${game.matchup} (gameId=${game.gameId})`);

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = buildPerGamePrompt(payload);

    let responseText = "";
    const stream = client.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    });

    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
        responseText += chunk.delta.text;
      }
    }

    const pick = parseSinglePickJSON(responseText);
    console.log(`[green-analyst] ${game.matchup}: ${pick.pickDescription} @ ${pick.finalConfidence}%`);
    return { pick };
  },
});
